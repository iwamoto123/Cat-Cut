"""Step 8: Composition - テロップ生成 + composition.json構築 + セグメント分割。

Usage:
    python step08_composition.py \
        --proposal ../runs/{run}/step07_cut_proposal/cut_proposal.json \
        --stt ../runs/{run}/step02_stt/stt_result.json \
        --video /path/to/video.mp4 \
        --output ../runs/{run}/step08_composition \
        --project ../templates/vertical.yaml
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))
from shared.telop_builder import build_telop_pages, build_voice_data
from shared.ffmpeg_tools import get_video_metadata
from shared.project_config import load_project_config
from shared.direction import (
    assign_slots_to_segments,
    build_directed_cut_content,
    build_directed_overlays,
    assign_vertical_accent_styles,
    assign_vertical_animation_variety,
    VERTICAL_STANDARD_ANIMATION_POOL,
    moderate_vertical_band_styles,
)
from shared.bgm import load_bgm_track
from shared.images import load_images_track
from shared.opening import apply_op_offset, build_op, load_op_patterns, normalize_op_config
from shared.speakers import significant_speakers
from shared.telop_types import (
    load_custom_styles,
    load_overlay_title,
    load_speaker_colors,
    load_type_mapping_entries,
    sanitize_custom_styles,
)
from shared.face_detect import detect_faces_for_ranges_cached
from shared.punch_in import assign_punch_in
from shared.telop_placement import estimate_block_height_ratio, resolve_cut_telop_y
from shared.video_effects import apply_face_focus, load_video_effects_config, select_video_effects
from shared.video_framing import load_video_framing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "tools"))

ALLOWED_SCENE_SPEEDS = (1.0, 1.25, 1.5, 2.0)


def normalize_scene_speed(value) -> float:
    """素材速度を許可値へ正規化する。不正・欠落は等速。"""
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return 1.0
    return speed if speed in ALLOWED_SCENE_SPEEDS else 1.0


def _load_directives(output_dir: str, directives_path: str = None) -> dict:
    """telop_directives.json (フェーズT2/パス3の出力) を読む。無ければ None。

    既定の場所は runの直下 (output_dir = runs/<run>/step08_composition の親)。
    """
    path = directives_path or os.path.join(os.path.dirname(os.path.abspath(output_dir)), "telop_directives.json")
    if not os.path.exists(path):
        return None
    try:
        data = _load_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def run_step(
    proposal_path: str,
    stt_result_path: str,
    video_path: str,
    output_dir: str,
    config: dict = None,
    project_path: str = None,
    review_path: str = None,
    directives_path: str = None,
    type_mapping_path: str = None,
    op_config: dict = None,
    orientation: str = None,
) -> dict:
    """テロップ生成 + composition.json 構築 + セグメント分割。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"[Step 8] Composition")

    # プロジェクト設定読み込み
    project_cfg = load_project_config(project_path)
    if project_path:
        print(f"  project: {project_path}")
        proj_name = project_cfg.get("project", {}).get("name", "")
        if proj_name:
            print(f"  project name: {proj_name}")

    proposal = _load_json(proposal_path)
    stt_result = _load_json(stt_result_path)

    keep_segments = proposal.get("keep_segments", [])
    words = stt_result.get("words", [])

    # review.json の corrections をマージ (Step 6 の誤字脱字修正)
    if review_path and os.path.exists(review_path):
        review_data = _load_json(review_path)
        review_corrections = review_data.get("corrections", {})
        if review_corrections:
            existing_corrections = project_cfg.get("text_rules", {}).get("corrections", {})
            existing_corrections.update(review_corrections)
            project_cfg.setdefault("text_rules", {})["corrections"] = existing_corrections
            print(f"  review corrections merged: {len(review_corrections)} entries")

    # 設定の優先順位: CLI config > project.yaml > デフォルト
    cfg = config or {}
    telop_cfg = project_cfg.get("telop", {})
    render_cfg = project_cfg.get("render", {})
    text_rules = project_cfg.get("text_rules", {})

    max_chars_per_line = cfg.get("telop_max_chars_per_line", telop_cfg.get("max_chars_per_line", 12))
    max_lines_per_page = cfg.get("telop_max_lines_per_page", telop_cfg.get("max_lines_per_page", 1))
    fps = cfg.get("fps", render_cfg.get("fps", 30))
    framing = cfg.get("framing", render_cfg.get("framing", {"scale": 1.0, "offset_y": 0}))
    telop_y = cfg.get("telop_y", telop_cfg.get("y_position", 0.5))
    animation_in = cfg.get("animation_in", telop_cfg.get("animation_in", "none"))
    animation_out = cfg.get("animation_out", telop_cfg.get("animation_out", "none"))
    # フェーズT3: 効果音の音量(0〜1。既定0.25≒-12dB)。project.yaml の telop.sfx_volume で調整可
    try:
        sfx_volume = float(cfg.get("sfx_volume", telop_cfg.get("sfx_volume", 0.25)))
    except (TypeError, ValueError):
        sfx_volume = 0.25
    sfx_volume = max(0.0, min(1.0, sfx_volume))

    # 動画メタデータ取得 (rotation含む)
    metadata = get_video_metadata(video_path)
    video_info = metadata.get("video", {})
    source_w = video_info.get("width", 1920)
    source_h = video_info.get("height", 1080)
    rotation = video_info.get("rotation", 0)

    # 縦横判定 (step01と同じ規則: 幅>高さ なら horizontal)
    source_orientation = "horizontal" if source_w > source_h else "vertical"

    # フェーズW8: --orientation でユーザーの縦横選択をキャンバスへ反映する。
    # 未指定は完全従来動作(キャンバス=ソース表示解像度)。指定がソース判定と一致する場合も
    # 従来どおり。不一致(横素材+vertical等)の場合のみキャンバス寸法を入れ替え、映像は
    # 既存の video_fit: cover が中央クロップでキャンバスを埋める(Remotion側の変更は不要)。
    requested_orientation = orientation if orientation in ("horizontal", "vertical") else None
    effective_orientation = requested_orientation or source_orientation
    if requested_orientation and requested_orientation != source_orientation:
        display_w, display_h = source_h, source_w
    else:
        display_w, display_h = source_w, source_h
    orientation = effective_orientation
    is_landscape = display_w > display_h

    print(f"  source: {source_w}x{source_h} (rotation={rotation}, {source_orientation})")
    if requested_orientation and requested_orientation != source_orientation:
        print(f"  canvas: {display_w}x{display_h} (orientation override: {requested_orientation})")
    print(f"  telop_y: {telop_y}, animation: {animation_in}/{animation_out}")
    if text_rules.get("enumeration_style", "as_is") != "as_is":
        print(f"  text_rules: enumeration={text_rules['enumeration_style']}")
    if text_rules.get("corrections"):
        print(f"  text_rules: {len(text_rules['corrections'])} corrections")

    # DP ペナルティ (project.yaml の dp セクション or orientation デフォルト)
    dp_cfg = project_cfg.get("dp", {})
    telop_font_size = telop_cfg.get("font_size", 52 if not is_landscape else 44)

    # フェーズT2(directedモード): telop_directives.json があれば演出ディレクティブから
    # テロップ・オーバーレイを生成する。ファイルは telop.mode: directed のパイプライン
    # (step06c_direction.py)だけが生成するため、ファイルの存在=directedなrunとみなす
    # (UIからの再実行時に共有テンプレートのmode設定へ依存しないための設計判断)。
    # ファイルが無い場合(既存run・fullモード)は従来動作を完全維持する。
    directives = _load_directives(output_dir, directives_path)
    directed = directives is not None
    if telop_cfg.get("mode", "full") == "directed" and not directed:
        print("  WARNING: telop.mode=directed but telop_directives.json not found - falling back to full mode")
    # フェーズT2.5-4: semantic type → preset マッピング(既定YAML + ユーザーJSON)。
    # step08実行のたびに最新マッピングで再解決するため、ユーザーがマッピングを変えて
    # 再実行すれば全スロットのスタイルが追従する(個別上書き style_overridden は維持)。
    # フェーズT3: マッピングは {style, animation_in?, sfx?} のフルエントリで読み、
    # アニメ・SFXのtype既定もスタイルと同じ経路で再解決する。
    # フェーズW26: 縦型は vertical_type_styles(4スタイル集約の広告デザインシステム)を
    # 既定マッピングの上へ重ねる(ユーザー上書きはさらにその上=従来の優先順位を維持)。
    type_mapping = (
        load_type_mapping_entries(user_file=type_mapping_path, orientation=orientation)
        if directed
        else None
    )
    # フェーズU6(詳細エディタ): カスタムスタイル定義を2系統から集める。
    # 1. デザインテーマ由来: telop_type_mapping.effective.json の custom_styles
    # 2. シーン個別由来: telop_directives.json の custom_styles
    # 定義は composition の timeline.telop_styles へ注入され、IDは directed の
    # style sanitize で許可される(定義の無いIDは従来どおり fact_yellow へ落ちる)。
    custom_styles = {}
    if directed:
        custom_styles.update(load_custom_styles(type_mapping_path))
        custom_styles.update(sanitize_custom_styles(directives.get("custom_styles")))
    if directed:
        print(f"  telop mode: directed ({len(directives.get('slots') or [])} slots)")
        if type_mapping_path and os.path.exists(type_mapping_path):
            print(f"  type mapping: {type_mapping_path}")
        if custom_styles:
            print(f"  custom styles: {len(custom_styles)}")

    # フェーズW1: 話者カラー。設定(YAML既定+userData上書き)が有効で、かつ動画全体で
    # 発話シェア10%以上の話者が2人以上いる場合のみ発動する(1人喋りガード)。
    # speaker無しの既存run(words/slotsにspeakerが無い)は speakers が空になり発動しない。
    speaker_colors = None
    if directed:
        speaker_colors_cfg = load_speaker_colors(user_file=type_mapping_path)
        speakers = significant_speakers(words)
        if speaker_colors_cfg.get("enabled") and speaker_colors_cfg.get("styles") and len(speakers) >= 2:
            speaker_colors = {
                "apply_types": frozenset(speaker_colors_cfg.get("apply_types") or ()),
                "styles": dict(speaker_colors_cfg["styles"]),
            }
            print(f"  speaker colors: active ({len(speakers)} speakers: {', '.join(speakers)})")
        elif speakers:
            reason = "disabled" if not speaker_colors_cfg.get("enabled") else "single speaker"
            print(f"  speaker colors: inactive ({reason})")

    # テロップ生成
    telop_pages_by_cut = {}
    directed_telops_by_cut = {}
    cuts = []
    timeline_offset_ms = 0

    # スロットは元動画の絶対msアンカーで保存されているため、UIでカットがトリム・分割されて
    # いても現在のkeep_segmentへ選び直せる。中点がどのセグメントにも入らないスロット
    # (シーン端の単語を大きく削除した場合等)は重なり最大のセグメントへ割り当てる
    # (実機FB 2026-09-03「最後のテキストの修正ができない」対応。詳細は assign_slots_to_segments)。
    directed_slot_assignments = (
        assign_slots_to_segments(directives.get("slots") or [], keep_segments)
        if directed
        else None
    )
    # UI適用済みrun(edited_by_ui)ではスロットが全カット(全シーン)の正。スロットが1つも
    # 割り当たらないカットにSTTテキストからテロップを再生成しない(UIに存在しない=編集も
    # 削除もできないテキストが書き出しに出るのを構造的に禁止する)。
    # 初回生成(edited_by_ui無し)のフォールバックはAI演出の部分失敗時の安全弁として維持する。
    directives_edited_by_ui = bool(directed and directives.get("edited_by_ui"))

    for i, seg in enumerate(keep_segments):
        cut_id = f"cut_{i + 1:03d}"
        speed = normalize_scene_speed(seg.get("speed"))
        source_duration_ms = seg["end_ms"] - seg["start_ms"]
        duration_ms = source_duration_ms if speed == 1.0 else source_duration_ms / speed

        directed_pages = None
        if directed:
            cut_slots = directed_slot_assignments[i]
            if cut_slots:
                voice_words_rel = [
                    {
                        "text": w["text"],
                        "start": max(0, (w["start_ms"] - seg["start_ms"])) / 1000.0 / speed,
                        "end": max(0, (w["end_ms"] - seg["start_ms"])) / 1000.0 / speed,
                    }
                    for w in words
                    if w["end_ms"] > seg["start_ms"] and w["start_ms"] < seg["end_ms"]
                ]
                directed_pages, directed_telops = build_directed_cut_content(
                    cut_id,
                    cut_slots,
                    voice_words_rel,
                    duration_ms,
                    max_chars_per_line,
                    type_mapping=type_mapping,
                    allowed_custom_styles=frozenset(custom_styles),
                    # フェーズW1: 発動条件を満たした場合のみ非None(話者→基本テロップ色)
                    speaker_colors=speaker_colors,
                )
                directed_telops_by_cut[cut_id] = directed_telops

        if directed_pages is not None:
            # スロットが選ばれたカットはスロットが正。全スロットが空テロップ
            # (相槌の自動空欄・ユーザーの文言削除・step06cのdrop:true)なら
            # pages=[] = テロップなしをそのまま尊重する。空だからといって
            # STTテキストから再生成すると、消したはずの文言が書き出しに復活する。
            pages = directed_pages
        elif directives_edited_by_ui:
            # UI適用済みrunのスロット皆無カット: STT再生成しない=テロップなし
            # (UIで見えないテキストが書き出しに復活する経路を遮断する)。
            pages = []
            directed_telops_by_cut[cut_id] = []
        else:
            # テロップページ生成 (BudouX + 句読点除去 + text_rules正規化 + DP設定)
            # directedモードでも対応スロットが無いカット(初回生成のAI部分失敗)は
            # ここへフォールバックする(後方互換の安全弁)
            pages = build_telop_pages(
                transcript=seg.get("text", ""),
                cut_id=cut_id,
                max_chars_per_line=max_chars_per_line,
                max_lines_per_page=max_lines_per_page,
                text_rules=text_rules if text_rules else None,
                dp_overrides=dp_cfg if dp_cfg else None,
            )
        telop_pages_by_cut[cut_id] = pages

        # タイムライン上のカット情報
        cut_data = {
            "cut_id": cut_id,
            "type": _determine_cut_type(i, len(keep_segments)),
            "video": {
                "file_path": os.path.abspath(video_path),
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
            },
            "timeline": {
                "start_ms": timeline_offset_ms,
                "end_ms": timeline_offset_ms + duration_ms,
            },
            "telop": {
                "pages": pages,
            },
            "layout": "talk",
            "scene_id": seg.get("scene_id"),
        }
        if speed != 1.0:
            cut_data["video"]["speed"] = speed
        cuts.append(cut_data)
        timeline_offset_ms += duration_ms

    # フェーズW24 Phase A: 縦型のみ顔検出(YuNet)を実行し、カット単位のテロップ縦位置
    # (顔回避配置)を cuts[].telop_y / cuts[].face_box へ書き込む。
    # - 検出はベストエフォート(opencv未導入・モデル欠落・失敗は警告のみで全カット顔なし扱い)
    # - face_regions.json にキャッシュし、動画実体+カット区間が同じなら再適用で再検出しない
    # - 横型は何も書かない(既存compositionと同形=完全従来動作)
    if orientation == "vertical":
        ranges_ms = [(seg["start_ms"], seg["end_ms"]) for seg in keep_segments]
        try:
            face_boxes = detect_faces_for_ranges_cached(
                video_path, ranges_ms,
                cache_path=os.path.join(output_dir, "face_regions.json"),
            )
        except Exception as e:
            print(f"  WARNING: face detection failed, using default telop placement: {e}")
            face_boxes = [None] * len(cuts)
        for cut, face_box in zip(cuts, face_boxes):
            cut["face_box"] = face_box
            line_count = max(
                (len(page.get("lines") or []) for page in cut["telop"]["pages"]),
                default=1,
            )
            cut["telop_y"] = resolve_cut_telop_y(
                orientation="vertical",
                base_telop_y=telop_y,
                face_box=face_box,
                block_height_ratio=estimate_block_height_ratio(
                    line_count, telop_font_size, display_h,
                ),
            )
        detected_count = sum(1 for box in face_boxes if box)
        print(f"  face-aware telop placement: {detected_count}/{len(cuts)} cuts with face")

        # フェーズW26: パンチイン(交互ズーム)。同一カメラのジャンプカットを演出に見せる。
        # 注視点は顔box中心(顔なしカットは中央やや上)。横型は書かない=従来動作。
        punched = assign_punch_in(cuts)
        print(f"  punch-in alternation: {punched}/{len(cuts)} cuts zoomed")

    # voice_data 構築 (word timing は秒単位)。
    # directedモードのカットはスロット由来のtelops(明示start/end・style・highlight_words)を
    # そのまま使うため、word再マッピング(_map_pages_to_telops)の対象から外す。
    voice_pages_by_cut = {
        cut_id: pages
        for cut_id, pages in telop_pages_by_cut.items()
        if cut_id not in directed_telops_by_cut
    }
    voice_data = build_voice_data(
        keep_segments,
        words,
        voice_pages_by_cut,
        timing_rules=project_cfg.get("timing", {}),
    )
    # voice_dataは元素材秒で生成されるため、出力タイムライン秒へ速度変換する。
    for index, vcut in enumerate(voice_data.get("cuts", [])):
        speed = normalize_scene_speed(keep_segments[index].get("speed")) if index < len(keep_segments) else 1.0
        if speed == 1.0:
            continue
        voice = vcut.get("voice") or {}
        voice["duration_ms"] = float(voice.get("duration_ms", 0)) / speed
        for word in voice.get("words") or []:
            word["start"] = float(word.get("start", 0)) / speed
            word["end"] = float(word.get("end", 0)) / speed
        for telop in vcut.get("telops") or []:
            if "start" in telop:
                telop["start"] = float(telop["start"]) / speed
            if "end" in telop:
                telop["end"] = float(telop["end"]) / speed
    for vcut in voice_data.get("cuts", []):
        if vcut.get("id") in directed_telops_by_cut:
            vcut["telops"] = directed_telops_by_cut[vcut["id"]]

    # フェーズW26: 縦型のバンド系スタイル(黄帯CTA・赤帯)の連発抑制。
    # CTAスロットが連続すると画面が帯だらけになるため、15秒未満の間隔の帯は
    # 標準ゴシックへ落とす(ユーザーの個別上書きは尊重)。
    if orientation == "vertical" and directed:
        demoted = moderate_vertical_band_styles(cuts, voice_data.get("cuts", []))
        if demoted:
            print(f"  band moderation: {demoted} telop(s) -> ad_gothic_impact")
        # フェーズW27: 短い決め語へアクセント(特大・縦書き・斜め)を間隔を空けて散らす
        accented = assign_vertical_accent_styles(cuts, voice_data.get("cuts", []))
        if accented:
            print(f"  accent styles: {accented} telop(s) (mega/vertical/slant)")
        # フェーズW31: 地の文はシンプル系アニメのローテーション(目の疲れ対策+単調回避)
        varied = assign_vertical_animation_variety(cuts, voice_data.get("cuts", []))
        if varied:
            print(f"  animation variety: {varied} telop(s) rotated ({', '.join(VERTICAL_STANDARD_ANIMATION_POOL)})")

    # フェーズT2(directedモード): チャプター/オーバーレイをタイムライン基準msへ変換する
    # フェーズU7: シーンタイトル設定(--type-mapping ファイルの overlay_title セクション)。
    # enabled=False なら chapter_title を生成せず、style はパターンIDとして各項目へ付く
    overlay_title = load_overlay_title(type_mapping_path)
    # W25: 縦型(ショート/リール)は画面が狭く、左上の章タイトルがSNSのUI・話者の顔と
    # 干渉するため生成しない(2026-08-21 実機フィードバック)。
    if orientation == "vertical" and overlay_title.get("enabled", True):
        overlay_title = {**overlay_title, "enabled": False}
        print("  overlay title: disabled (vertical)")
    overlays = []
    if directed:
        segment_timelines = []
        offset = 0
        for seg in keep_segments:
            segment_timelines.append({
                "source_start_ms": seg["start_ms"],
                "source_end_ms": seg["end_ms"],
                "timeline_start_ms": offset,
                "speed": normalize_scene_speed(seg.get("speed")),
            })
            speed = normalize_scene_speed(seg.get("speed"))
            source_duration_ms = seg["end_ms"] - seg["start_ms"]
            offset += source_duration_ms if speed == 1.0 else source_duration_ms / speed
        overlays = build_directed_overlays(
            directives, segment_timelines, timeline_offset_ms, overlay_title=overlay_title,
        )
        # W25: AI演出の要約系オーバーレイ(list_stack / cta_banner / caption / profile_card)は
        # テロップとは別に画面を大きく占有し、顔やテロップに重なるため自動表示しない
        # (2026-08-21 実機フィードバック「勝手に要約みたいなのを表示するのをやめて」)。
        # 章タイトル(chapter_title)のみ従来どおり(縦型はoverlay_title無効化で既に出ない)。
        overlays = [o for o in overlays if o.get("type") == "chapter_title"]
        print(f"  overlays: {len(overlays)}")
        if not overlay_title.get("enabled", True):
            print("  overlay title: disabled")
        elif overlay_title.get("style") != "box_accent":
            print(f"  overlay title style: {overlay_title.get('style')}")

    # セグメント分割 (レンダリング高速化)
    _extract_segments(cuts, video_path, output_dir, rotation)

    # フェーズU8: OP(オープニング)。セグメント抽出後に組み立てる(highlight_teaserの
    # 抜粋クリップが抽出済みセグメントMP4を参照するため)。OP尺分だけ本編の
    # タイムライン(cuts/overlays)を後ろへずらす。op_config なし=従来通り(後方互換)
    op = None
    normalized_op = normalize_op_config(op_config)
    if normalized_op:
        op = build_op(
            normalized_op,
            load_op_patterns(),
            (directives.get("slots") if directed else None) or [],
            keep_segments,
            cuts,
            video_path,
            # フェーズV2: OPテロップのスタイルも最新のtype→presetマッピングで再解決する
            type_mapping=type_mapping,
            # フェーズV8-6: AIのOPシーン選定(op_picks)を最優先。無い旧runは従来動作
            op_picks=(directives.get("op_picks") if directed else None) or None,
            # フェーズW4: AI生成のOPタイトル(ユーザー未入力時のフォールバック。
            # 無い旧run・full モードは従来どおりファイル名既定)
            ai_title=str((directives.get("op_title") if directed else "") or ""),
        )
    if op:
        apply_op_offset(cuts, overlays, int(op["duration_ms"]))
        timeline_offset_ms += int(op["duration_ms"])
        clips_note = " (user clips)" if normalized_op.get("clips") else ""
        print(f"  op: {op['pattern']} ({op['duration_ms']}ms, title={op['title']!r}){clips_note}")

    # composition 構築
    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": timeline_offset_ms,
            "video_fit": render_cfg.get("video_fit", "cover"),
            "fps": fps,
            "framing": framing,
            "telop_y": telop_y,
            "telop_font_size": telop_font_size,
            # 改善20-B: プレビュー/Remotionの行バジェット折返し(wrapTelopLine)用
            "telop_max_chars_per_line": max_chars_per_line,
            "animation_in": animation_in,
            "animation_out": animation_out,
            # フェーズT3: テロップ効果音の音量(Remotionの<Audio>のvolume)
            "sfx_volume": sfx_volume,
            # フェーズT1-3/T2: 演出オーバーレイトラック(タイムライン基準ms)。
            # fullモードは空、directedモードは telop_directives.json から生成する。
            "overlays": overlays,
            "cuts": cuts,
        },
        "voice_data": voice_data,
        "meta": {
            "source_video": os.path.abspath(video_path),
            "original_duration_ms": proposal.get("stats", {}).get("original_duration_ms", 0),
            "edited_duration_ms": timeline_offset_ms,
            "reduction_ratio": proposal.get("stats", {}).get("reduction_ratio", 0),
            "total_cuts": len(cuts),
            "display_width": display_w,
            "display_height": display_h,
            "orientation": orientation,
            # フェーズW8: ソース動画の表示解像度(rotation適用後)。orientation override時の
            # キャンバス(display_*)との区別と、W9のフレーミング計算に使う。
            "source_width": source_w,
            "source_height": source_h,
            "rotation": rotation,
            "project": project_cfg.get("project", {}),
            # フェーズT2: UI(desktop)がdirectedモードを検出するためのフラグ
            "telop_mode": "directed" if directed else "full",
        },
    }

    # フェーズU8: OPなし時はキー自体を書かない(既存compositionと同形=後方互換)
    if op:
        composition["timeline"]["op"] = op

    # フェーズU9: BGMトラック。runs/<run>/bgm/bgm.json があれば timeline.bgm へ転写する
    # (OPがある場合もBGM開始はタイムライン全体基準のまま=OP含む先頭0起点で単純転写)。
    # bgm.json なし・有効クリップゼロはキー自体を書かない(後方互換)。
    run_dir = os.path.dirname(os.path.abspath(output_dir))
    bgm_track = load_bgm_track(run_dir, total_duration_ms=timeline_offset_ms)
    if bgm_track:
        composition["timeline"]["bgm"] = bgm_track
        print(f"  bgm: {len(bgm_track)} clips")

    # フェーズV4: 画像挿入トラック。runs/<run>/images/images.json があれば timeline.images へ
    # 転写する(BGMと同型: タイムライン全体基準のまま単純転写・総尺クランプ)。
    # images.json なし・有効クリップゼロはキー自体を書かない(後方互換)。
    images_track = load_images_track(run_dir, total_duration_ms=timeline_offset_ms)
    if images_track:
        composition["timeline"]["images"] = images_track
        print(f"  images: {len(images_track)} clips")

    # フェーズW9: 映像フレーミング(変形・クロップ)。runs/<run>/video_framing.json が存在し
    # identity でなければ timeline.video_framing へ転写する(全カット共通のグローバル1件)。
    # ファイルなし・identity はキー自体を書かない(既存compositionと同形=完全後方互換)。
    video_framing = load_video_framing(run_dir)
    if video_framing:
        composition["timeline"]["video_framing"] = video_framing
        print(
            "  video framing: "
            f"scale={video_framing['transform']['scale']}, "
            f"crop=({video_framing['crop']['left']},{video_framing['crop']['top']},"
            f"{video_framing['crop']['right']},{video_framing['crop']['bottom']})"
        )

    # フェーズW2: シーン映像ギミック(pinch=縮小+暗転+チーン / zoom=強調ズーム)。
    # directedのslotsから決定的に選定し、bgm/imagesと同型の独立トラック
    # timeline.video_effects へ注入する。fullモード・候補ゼロ・設定OFFで全滅の場合は
    # キー自体を書かない(既存compositionと同形=後方互換)。
    if directed:
        # フェーズW26: 縦型はdim(暗転)既定ON(決めゼリフ明朝と併用するデザイン)
        video_effects_enabled = load_video_effects_config(type_mapping_path, orientation=orientation)
        op_offset_ms = int(op["duration_ms"]) if op else 0
        ve_segment_timelines = []
        ve_offset = op_offset_ms
        for seg in keep_segments:
            ve_segment_timelines.append({
                "source_start_ms": seg["start_ms"],
                "source_end_ms": seg["end_ms"],
                "timeline_start_ms": ve_offset,
            })
            ve_offset += seg["end_ms"] - seg["start_ms"]
        # OP採用シーン(元動画絶対ms区間)はzoomの対象から除外する
        op_clip_ranges = [
            (int(clip.get("source_start_ms", 0)), int(clip.get("source_end_ms", 0)))
            for clip in (op or {}).get("highlight_cuts", [])
        ]
        # フェーズW24 Phase C: カット対応表(timeline基準・face_box込み)。face_zoom
        # (顔があるカット限定)・slow_push(カット全長)・同一カット重複禁止の判定に使う
        ve_cuts = [
            {
                "id": cut.get("cut_id"),
                "start_ms": cut["timeline"]["start_ms"],
                "end_ms": cut["timeline"]["end_ms"],
                "face_box": cut.get("face_box"),
            }
            for cut in cuts
        ]
        video_effects = select_video_effects(
            directives.get("slots") or [],
            ve_segment_timelines,
            op_clip_source_ranges=op_clip_ranges,
            enabled=video_effects_enabled,
            cuts=ve_cuts,
            # W26: 縦型は決めゼリフの暗転(dim)をzoomより優先する
            dim_priority=(orientation == "vertical"),
        )
        if video_effects:
            # フェーズW24 Phase A-3: 顔boxがあるカットのzoomは注視点を顔中心(やや上=目線基準)へ
            # 差し替える。顔なしカット・横型は従来の固定focusのまま(後方互換)。
            # cuts[].timeline はOPオフセット適用済みで、効果のタイムラインms基準と一致する。
            face_cut_ranges = [
                {
                    "start_ms": cut["timeline"]["start_ms"],
                    "end_ms": cut["timeline"]["end_ms"],
                    "face_box": cut.get("face_box"),
                }
                for cut in cuts
                if cut.get("face_box")
            ]
            if face_cut_ranges:
                face_focused = apply_face_focus(video_effects, face_cut_ranges)
                if face_focused:
                    print(f"  zoom focus: face-based for {face_focused} effect(s)")
            composition["timeline"]["video_effects"] = video_effects
            counts = {
                effect_type: sum(1 for e in video_effects if e["type"] == effect_type)
                for effect_type in ("pinch", "zoom", "dim", "face_zoom", "slow_push")
            }
            summary = ", ".join(f"{name}={count}" for name, count in counts.items() if count)
            print(f"  video effects: {len(video_effects)} ({summary})")

    # telop.txt 抽出時点で利用可能な @style 一覧を出せるように、初期プリセットを同梱する。
    try:
        from _telop_presets import embed_presets_into_composition

        embed_presets_into_composition(composition)
    except Exception as e:
        print(f"  (telop preset embed skipped: {e})")

    # フェーズU6: カスタムスタイル定義を telop_styles へ注入する(yamlプリセットと同名の
    # 衝突はカスタムを優先。custom_プレフィクスにより実運用では衝突しない)。
    if custom_styles:
        composition.setdefault("timeline", {}).setdefault("telop_styles", {}).update(custom_styles)

    print(f"  cuts: {len(cuts)}")
    print(f"  total duration: {timeline_offset_ms}ms ({timeline_offset_ms / 1000:.1f}s)")
    print(f"  output: {display_w}x{display_h}")

    output_path = os.path.join(output_dir, "composition.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(composition, f, ensure_ascii=False, indent=2)

    print(f"[Step 8] Done: {output_path}")
    return composition


# W11-1b: h264_videotoolbox(ハードウェアエンコード)の利用可否。プロセス内で1回だけ
# ffmpeg -encoders を叩いて判定する(None=未判定)。テストから直接上書きできる。
_videotoolbox_available = None

# W11-1a: 今回未使用のキャッシュセグメントを保持する期間(7日)。超過分は掃除する
SEGMENT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60


def _detect_videotoolbox() -> bool:
    """W11-1b: ffmpeg が h264_videotoolbox に対応しているかを1回だけ判定する。"""
    global _videotoolbox_available
    if _videotoolbox_available is None:
        try:
            result = subprocess.run(
                ["ffmpeg", "-hide_banner", "-encoders"],
                capture_output=True, text=True,
            )
            _videotoolbox_available = (
                result.returncode == 0 and "h264_videotoolbox" in (result.stdout or "")
            )
        except OSError:
            _videotoolbox_available = False
    return _videotoolbox_available


def _segment_encode_settings() -> tuple:
    """W11-1b: セグメント抽出のエンコード引数と、キャッシュキー用の設定文字列を返す。

    VideoToolbox(HW)が使える環境では q:v 65(中間素材として十分高画質)で大幅高速化し、
    使えない環境では従来どおり libx264 CRF16 preset fast にフォールバックする。
    設定文字列はキャッシュキーに含める(HW/SWで生成物を混同しないため)。
    """
    if _detect_videotoolbox():
        return (
            ["-c:v", "h264_videotoolbox", "-q:v", "65", "-allow_sw", "1"],
            "h264_videotoolbox_q65",
        )
    return (
        ["-c:v", "libx264", "-crf", "16", "-preset", "fast"],
        "libx264_crf16_fast",
    )


def _segment_cache_hash(
    source_path: str,
    source_mtime_ns: int,
    source_size: int,
    start_ms: int,
    end_ms: int,
    rotation: int,
    encode_desc: str,
) -> str:
    """W11-1a: セグメントキャッシュキー。ソース実体+カット境界+エンコード設定が同じなら同一。"""
    raw = "|".join([
        str(source_path), str(source_mtime_ns), str(source_size),
        str(start_ms), str(end_ms), str(rotation), str(encode_desc),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _segment_manifest_path(segments_dir: str) -> str:
    return os.path.join(segments_dir, "manifest.json")


def _load_segment_manifest(segments_dir: str) -> dict:
    """W11-1a: segments/manifest.json {hash: {source, start_ms, end_ms, last_used}} を読む。"""
    try:
        data = _load_json(_segment_manifest_path(segments_dir))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_segment_manifest(segments_dir: str, manifest: dict):
    with open(_segment_manifest_path(segments_dir), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def _cleanup_segment_cache(segments_dir: str, manifest: dict, used_hashes: set, now: float) -> int:
    """W11-1a: 今回未使用かつ last_used が7日超のキャッシュを削除する(無限肥大防止)。

    manifest 管理下の seg_<hash>.mp4 だけが対象。旧形式 cut_XXX.mp4 は manifest 外なので
    削除しない(旧 composition を参照する既存runの後方互換)。
    """
    removed = 0
    for seg_hash in list(manifest.keys()):
        if seg_hash in used_hashes:
            continue
        entry = manifest.get(seg_hash) or {}
        try:
            last_used = float(entry.get("last_used", 0))
        except (TypeError, ValueError):
            last_used = 0.0
        if now - last_used <= SEGMENT_CACHE_TTL_SECONDS:
            continue
        seg_path = os.path.join(segments_dir, f"seg_{seg_hash}.mp4")
        try:
            if os.path.exists(seg_path):
                os.remove(seg_path)
        except OSError:
            continue
        del manifest[seg_hash]
        removed += 1
    return removed


def _encode_segment(source_path: str, start_s: float, duration_s: float, encode_args: list, segment_path: str):
    """W11-1a/1b: セグメント1本を ffmpeg で抽出する。成功=None / 失敗=stderr文字列。

    失敗時は書きかけファイルを消す(壊れたファイルを次回キャッシュヒットさせないため)。
    """
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_s),
        "-i", source_path,
        "-t", str(duration_s),
        *encode_args,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        segment_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        return None
    try:
        if os.path.exists(segment_path):
            os.remove(segment_path)
    except OSError:
        pass
    return result.stderr or ""


def _segment_parallel_jobs() -> int:
    """W19-C1: セグメント抽出の並列度。既定3、環境変数 CATCUT_SEGMENT_JOBS で1〜8。

    VideoToolbox(HW)は同時エンコード数に上限があるため、HW時も既定は3のまま。
    """
    raw = os.environ.get("CATCUT_SEGMENT_JOBS", "").strip()
    if not raw:
        return 3
    try:
        value = int(raw)
    except ValueError:
        return 3
    return max(1, min(8, value))


def _extract_segments(cuts: list, source_video: str, output_dir: str, rotation: int):
    """カットごとのビデオセグメントをFFmpegで抽出。

    259MBの元動画に毎フレームseekするのがレンダリングの最大ボトルネック。
    カットごとに小さなMP4に分割して、seekコストを劇的に削減する。
    rotation はFFmpegのデフォルト自動回転に任せる（メタデータも自動除去される）。

    W11-1a(差分キャッシュ): 出力名を内容ハッシュの seg_<hash>.mp4 にし、既存ファイルが
    あれば ffmpeg をスキップする。連番 cut_XXX.mp4 だとシーン挿入で全ファイルがズレて
    再利用できないため、境界が動いたセグメントだけを再エンコードできるハッシュ名を使う。
    W11-1b: VideoToolbox が使える環境ではHWエンコードで抽出を高速化する。
    W19-C1: キャッシュヒット判定を直列で先に済ませ、キャッシュミス分のみ
    ThreadPoolExecutor で並列エンコードする(ffmpegはサブプロセスなのでスレッドで十分)。
    manifest 更新・掃除は並列区間の外で一括して行う。
    W19-C5: 完了セグメント数/総数ベースの `Progress: <n>%` を stdout へ出力する
    (mainのtranscript:apply経路がパースして適用中UIへ中継する)。
    """
    global _videotoolbox_available

    segments_dir = os.path.join(output_dir, "segments")
    os.makedirs(segments_dir, exist_ok=True)

    encode_args, encode_desc = _segment_encode_settings()
    manifest = _load_segment_manifest(segments_dir)
    jobs = _segment_parallel_jobs()
    now = time.time()
    used_hashes = set()
    stat_cache = {}
    encoded = 0
    reused = 0
    total = len(cuts)
    progress = {"done": 0, "last_percent": -1}

    print(f"  Extracting video segments... (encoder: {encode_desc}, jobs: {jobs})")
    t0 = time.time()

    def _advance_progress():
        """W19-C5: 1セグメント完了(ヒット・成功・失敗いずれも)ごとの進捗出力。"""
        progress["done"] += 1
        percent = int(progress["done"] * 100 / total) if total else 100
        if percent != progress["last_percent"]:
            progress["last_percent"] = percent
            print(f"    Progress: {percent}%", flush=True)

    def _plan_item(cut):
        """カット1件のエンコード計画(現在のエンコード設定でハッシュ・出力先を解決)。"""
        video = cut["video"]
        source_path = os.path.abspath(video["file_path"])
        start_s = video["start_ms"] / 1000
        end_s = video["end_ms"] / 1000

        # ソース実体(mtime/size)はキャッシュキーの一部。stat失敗(ソース欠落)は0扱いで
        # 続行し、従来どおり ffmpeg の失敗警告に任せる
        if source_path not in stat_cache:
            try:
                st = os.stat(source_path)
                stat_cache[source_path] = (st.st_mtime_ns, st.st_size)
            except OSError:
                stat_cache[source_path] = (0, 0)
        source_mtime_ns, source_size = stat_cache[source_path]

        seg_hash = _segment_cache_hash(
            source_path, source_mtime_ns, source_size,
            video["start_ms"], video["end_ms"], rotation, encode_desc,
        )
        return {
            "cut": cut,
            "source_path": source_path,
            "start_s": start_s,
            "duration_s": end_s - start_s,
            "start_ms": video["start_ms"],
            "end_ms": video["end_ms"],
            "seg_hash": seg_hash,
            "segment_path": os.path.join(segments_dir, f"seg_{seg_hash}.mp4"),
            "encode_args": list(encode_args),
        }

    def _finalize(item):
        """manifest記録と composition の video 更新(セグメント参照、startFrom=0)。"""
        used_hashes.add(item["seg_hash"])
        manifest[item["seg_hash"]] = {
            "source": item["source_path"],
            "start_ms": item["start_ms"],
            "end_ms": item["end_ms"],
            "last_used": int(now),
        }
        video = item["cut"]["video"]
        video["file_path"] = os.path.abspath(item["segment_path"])
        video["start_ms"] = 0
        video["end_ms"] = int(item["duration_s"] * 1000)

    def _log_encoded(item):
        nonlocal encoded
        encoded += 1
        seg_size = os.path.getsize(item["segment_path"]) / 1024 / 1024
        print(f"    {item['cut']['cut_id']}: {item['duration_s']:.1f}s -> {seg_size:.1f}MB (seg_{item['seg_hash']})")

    def _run_batch(items):
        """キャッシュミス分をエンコードし、失敗 [(item, stderr)] を返す。

        成功ログ・進捗は完了ごと(メインスレッド)に出力し、manifest更新(_finalize)は
        並列区間(with)の外で一括して行う(スレッド安全のため)。
        """
        failures = []
        successes = []
        if not items:
            return failures
        workers = min(jobs, len(items))
        if workers <= 1:
            for item in items:
                stderr = _encode_segment(
                    item["source_path"], item["start_s"], item["duration_s"],
                    item["encode_args"], item["segment_path"],
                )
                if stderr is None:
                    successes.append(item)
                    _log_encoded(item)
                    _advance_progress()
                else:
                    failures.append((item, stderr))
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                future_map = {
                    pool.submit(
                        _encode_segment,
                        item["source_path"], item["start_s"], item["duration_s"],
                        item["encode_args"], item["segment_path"],
                    ): item
                    for item in items
                }
                for future in as_completed(future_map):
                    item = future_map[future]
                    stderr = future.result()
                    if stderr is None:
                        successes.append(item)
                        _log_encoded(item)
                        _advance_progress()
                    else:
                        failures.append((item, stderr))
        for item in successes:
            _finalize(item)
        return failures

    def _downgrade_to_sw_and_replan(items):
        """W11-1b: HW実行時失敗の降格。SWで再計画し、SWキャッシュヒット分はその場で確定。"""
        global _videotoolbox_available
        nonlocal encode_args, encode_desc, reused
        _videotoolbox_available = False
        encode_args, encode_desc = _segment_encode_settings()
        replanned = []
        for item in items:
            item = _plan_item(item["cut"])
            if os.path.exists(item["segment_path"]):
                reused += 1
                _finalize(item)
                _advance_progress()
            else:
                replanned.append(item)
        return replanned

    # Phase 1(直列): キャッシュヒット判定。ヒットは即確定し、ミスだけを後段へ回す
    pending = []
    for cut in cuts:
        item = _plan_item(cut)
        if os.path.exists(item["segment_path"]):
            # W11-1a: キャッシュヒット。ffmpeg をスキップして再利用
            reused += 1
            _finalize(item)
            _advance_progress()
        else:
            pending.append(item)

    # Phase 2(HWプローブ): -encoders に載っていても実行時にHWエンコードが失敗する環境が
    # ある(エンコーダHWへアクセスできないサンドボックス・仮想環境等)。並列で一斉に失敗
    # させないため、最初の1本だけ直列で試し、失敗したらプロセス内でSWへ降格して全体を
    # SWで再計画する(キャッシュキーはエンコーダ種別を含むためファイル名も付け替わる)
    if pending and encode_desc == "h264_videotoolbox_q65":
        probe = pending[0]
        stderr = _encode_segment(
            probe["source_path"], probe["start_s"], probe["duration_s"],
            probe["encode_args"], probe["segment_path"],
        )
        if stderr is None:
            pending = pending[1:]
            _log_encoded(probe)
            _advance_progress()
            _finalize(probe)
        else:
            print(f"    WARNING: HW encode failed, falling back to libx264: {stderr[-200:]}")
            pending = _downgrade_to_sw_and_replan(pending)

    # Phase 3(並列): キャッシュミス分を並列エンコード
    failures = _run_batch(pending)

    # プローブ成功後にHWが途中失敗した場合も従来同様SWへ降格して撮り直す
    if failures and encode_desc == "h264_videotoolbox_q65":
        print(f"    WARNING: HW encode failed, falling back to libx264: {failures[0][1][-200:]}")
        retry = _downgrade_to_sw_and_replan([item for item, _stderr in failures])
        failures = _run_batch(retry)

    for item, stderr in failures:
        print(f"    WARNING: Failed to extract {item['cut']['cut_id']}: {stderr[-200:]}")
        _advance_progress()

    removed = _cleanup_segment_cache(segments_dir, manifest, used_hashes, now)
    _save_segment_manifest(segments_dir, manifest)

    elapsed = time.time() - t0
    print(
        f"  Segments extracted in {elapsed:.1f}s"
        f" (encoded: {encoded}, cache hits: {reused}, cleaned: {removed})"
    )


def _determine_cut_type(index: int, total: int) -> str:
    """カットタイプを判定。"""
    if index == 0:
        return "hook"
    if index == total - 1:
        return "cta"
    return "body"


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description="Step 8: Composition")
    parser.add_argument("--proposal", required=True, help="Cut proposal JSON path")
    parser.add_argument("--stt", required=True, help="STT result JSON path")
    parser.add_argument("--video", required=True, help="Source video path")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--project", default=None, help="Project config YAML/JSON path")
    parser.add_argument("--review", default=None, help="Review JSON path (Step 6 output)")
    parser.add_argument(
        "--directives",
        default=None,
        help="telop_directives.json path (省略時は output の親ディレクトリ直下を探す)",
    )
    parser.add_argument(
        "--type-mapping",
        default=None,
        help="ユーザー type→preset マッピングJSON (T2.5-4。省略時は templates/telop_type_mapping.yaml のみ)",
    )
    parser.add_argument(
        "--op-config",
        default=None,
        help='OP設定JSON {"pattern","title","catch_copy","clips"}。clips=null はAI自動選定(V2)。省略・pattern=none はOPなし',
    )
    parser.add_argument(
        "--orientation",
        default=None,
        choices=["horizontal", "vertical"],
        help="出力キャンバスの向き(W8: ユーザーの縦横選択)。省略時はソース動画から自動判定(完全従来動作)",
    )
    args = parser.parse_args()

    op_config = None
    if args.op_config:
        try:
            op_config = json.loads(args.op_config)
        except json.JSONDecodeError:
            print(f"  WARNING: --op-config のJSONが不正のためOPなしで続行: {args.op_config!r}")

    run_step(
        args.proposal,
        args.stt,
        args.video,
        args.output,
        project_path=args.project,
        review_path=args.review,
        directives_path=args.directives,
        type_mapping_path=args.type_mapping,
        op_config=op_config,
        orientation=args.orientation,
    )


if __name__ == "__main__":
    main()
