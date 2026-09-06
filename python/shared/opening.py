"""フェーズU8/V2: OP(オープニング)生成の決定的ロジック。

step08_composition.py が --op-config JSON を受け取り、このモジュールで
timeline.op の構築とタイムラインのオフセット適用を行う。
LLMは呼ばない(ハイライト選定も telop_directives のスロットから決定的に選ぶ)。

フェーズV2: op-config は run 単位(runs/<run>/op_config.json)へ移行し、
{pattern, title, catch_copy, clips} の形になった。clips=None はAI自動選定
(従来どおり select_highlight_clips)、clips=リスト はユーザーがOP編集UIで
差し替え・並び替えたクリップ指定(元動画の絶対msアンカー。カット編集後も
中点でカットへ再解決するため壊れない)。各ハイライトクリップには該当スロットの
整形済みテロップ文言(text)とスタイルID(style)を持たせ、Remotion側が
横スライド(slide_left)テロップとして描画する。

設計指針(仕様書U8のネット調査): OPは3〜7秒・タイトル+キャッチ+キメ音・
型は title_card / highlight_teaser / question_hook / none(既定=OPなし・完全後方互換)。
パターンごとの尺・効果音IDは templates/op_patterns.yaml が正。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# templates/op_patterns.yaml と同期するパターンID(noneはOPなしの明示)
OP_PATTERN_IDS = ("none", "title_card", "highlight_teaser", "question_hook")

# フェーズV5: UIは「なし/ハイライト予告」の2択に一本化。旧パターン値の入った
# op_config を読んだら highlight_teaser へ無警告マイグレーションする(既存run互換)
LEGACY_OP_PATTERN_MIGRATION = {"title_card": "highlight_teaser", "question_hook": "highlight_teaser"}

# フェーズV5: highlight_teaser の装飾・テロップ登場アニメID
# (remotion/src/lib/opTimeline.ts の OP_DECORATIONS / OP_TEXT_ANIMATIONS と同期)
OP_DECORATION_IDS = ("flash_pop", "cinema_bars", "color_wipe", "neon_frame")
OP_TEXT_ANIMATION_IDS = ("slide_left", "slide_up", "stamp")
DEFAULT_OP_DECORATION = "flash_pop"
DEFAULT_OP_TEXT_ANIMATION = "slide_left"

# フェーズV2: ユーザー指定クリップ(op_config.clips)の尺クランプ。
# 自動選定より緩いが、OP全体が間延びしない上限に抑える
USER_CLIP_MIN_MS = 400
USER_CLIP_MAX_MS = 4000

DEFAULT_OP_PATTERNS_FILE = Path(__file__).resolve().parents[2] / "templates" / "op_patterns.yaml"

# YAMLが読めない場合の保険(op_patterns.yaml と同値)
# フェーズW(OP 0ベース再設計): OPは3〜5クリップ・合計10〜15秒で統一する
FALLBACK_OP_PATTERNS: Dict[str, Dict[str, Any]] = {
    "title_card": {"duration_ms": 4000, "sfx_hit": "don", "sfx_transition": "hyu"},
    "highlight_teaser": {
        "clip_min_ms": 1500, "clip_max_ms": 3500, "max_clips": 5,
        "target_total_ms": 15000, "sfx_hit": "don",
    },
    "question_hook": {"duration_ms": 5000, "sfx_hit": "don", "sfx_transition": "hyu"},
}

# highlight_teaser の抜粋対象スロット種別と優先順位(小さいほど優先)
HIGHLIGHT_SLOT_PRIORITY = {"hype": 0, "punchline": 1, "surprise": 2}

# フェーズW: OPの最少クリップ数(AI選定がこれ未満のときtype優先候補で補完する)
MIN_OP_CLIPS = 3
# フェーズW: v2ピック(dict)からクリップへ引き継ぐフックワード系メタのキー
OP_PICK_META_KEYS = ("role", "display", "hook_text", "keyword", "keyword_color")


def _normalize_op_pick_metas(op_picks: Optional[List[Any]]) -> List[Dict[str, Any]]:
    """op_picks(旧=slot_id文字列 / 新=dict)をメタ辞書のリストへ正規化する。

    v2(dict)のみメタキーを持つ。文字列(旧run・sanitize前のJSON直読み)は
    slot_id だけのメタ=完全に従来動作(verbatimテロップ・時系列並べ直し)になる。
    """
    metas: List[Dict[str, Any]] = []
    for entry in op_picks or []:
        if isinstance(entry, dict):
            slot_id = str(entry.get("slot_id", "") or "").strip()
            if not slot_id:
                continue
            meta = {"slot_id": slot_id, "v2": True}
            for key in OP_PICK_META_KEYS:
                value = str(entry.get(key, "") or "")
                if value:
                    meta[key] = value
            metas.append(meta)
        else:
            slot_id = str(entry or "").strip()
            if slot_id:
                metas.append({"slot_id": slot_id, "v2": False})
    return metas


def load_op_patterns(path: Optional[Path | str] = None) -> Dict[str, Dict[str, Any]]:
    """templates/op_patterns.yaml をID引きの辞書へ読み込む(読めなければフォールバック)。"""
    patterns_path = Path(path) if path else DEFAULT_OP_PATTERNS_FILE
    if not patterns_path.exists():
        return dict(FALLBACK_OP_PATTERNS)
    try:
        import yaml

        parsed = yaml.safe_load(patterns_path.read_text(encoding="utf-8"))
        entries = parsed.get("patterns") if isinstance(parsed, dict) else None
        result: Dict[str, Dict[str, Any]] = {}
        for entry in entries or []:
            if isinstance(entry, dict) and str(entry.get("id", "")) in OP_PATTERN_IDS:
                result[str(entry["id"])] = entry
        return result or dict(FALLBACK_OP_PATTERNS)
    except Exception:
        return dict(FALLBACK_OP_PATTERNS)


def _normalize_op_clips(raw: Any) -> Optional[List[Dict[str, Any]]]:
    """フェーズV2: op_config.clips(ユーザー指定クリップ)を正規化する。

    start_ms/end_ms は元動画の絶対ms(カット編集後も中点でカットへ再解決できるアンカー)。
    不正エントリは捨て、有効なクリップが1つも無ければ None(=AI自動選定へフォールバック)。
    """
    if not isinstance(raw, list):
        return None
    clips: List[Dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            start_ms = int(entry.get("start_ms"))
            end_ms = int(entry.get("end_ms"))
        except (TypeError, ValueError):
            continue
        if end_ms <= start_ms:
            continue
        clip = {
            "cut_id": str(entry.get("cut_id", "") or ""),
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": str(entry.get("text", "") or "").strip(),
            "style": str(entry.get("style", "") or "").strip(),
        }
        # フェーズW: フックワード系メタ(UIで編集済みの値)を保持する
        for key in OP_PICK_META_KEYS:
            value = str(entry.get(key, "") or "")
            if value:
                clip[key] = value
        clips.append(clip)
    return clips or None


# W13-3: OPタイトル/キャッチコピーに実データとして混入しがちなプレースホルダ的文言。
# テーマ設定への試し入力が op_config.json に保存され動画に表示される事故があったため、
# 読み込み時に空文字(=非表示)へ正規化する。
# desktop/main/index.cjs / desktop/src/lib/designExtras.ts と同一リストを保つこと
OP_PLACEHOLDER_TEXTS = ("タイトルテキスト", "タイトルテスト", "キャッチコピー", "サンプルテキスト")


def _normalize_op_user_text(value: Any) -> str:
    """W13-3: プレースホルダ的文言は空文字へ正規化する(trim込み)。"""
    text = str(value or "").strip()
    return "" if text in OP_PLACEHOLDER_TEXTS else text


def normalize_op_config(raw: Any) -> Optional[Dict[str, Any]]:
    """--op-config のJSON(未検証)を正規化する。

    Returns:
        {"pattern","decoration","text_animation","title","catch_copy","clips"} /
        None(=OPなし。pattern欠落・none・未知を含む)
        clips は None(AI自動選定) or ユーザー指定クリップのリスト(フェーズV2)。

    フェーズV5: 旧パターン(title_card / question_hook)は highlight_teaser へ移行し、
    decoration / text_animation の未知値は既定(flash_pop / slide_left)へ落とす。
    W11-5: title_enabled(タイトルを表示するか)を追加。フィールド省略=True(後方互換)で、
    明示的に False のときだけ build_op がタイトルを空にする。
    """
    if not isinstance(raw, dict):
        return None
    pattern = str(raw.get("pattern", "") or "")
    pattern = LEGACY_OP_PATTERN_MIGRATION.get(pattern, pattern)
    if pattern not in OP_PATTERN_IDS or pattern == "none":
        return None
    decoration = str(raw.get("decoration", "") or "")
    if decoration not in OP_DECORATION_IDS:
        decoration = DEFAULT_OP_DECORATION
    text_animation = str(raw.get("text_animation", "") or "")
    if text_animation not in OP_TEXT_ANIMATION_IDS:
        text_animation = DEFAULT_OP_TEXT_ANIMATION
    return {
        "pattern": pattern,
        "decoration": decoration,
        "text_animation": text_animation,
        # W13-3: プレースホルダ的文言(「タイトルテキスト」等)は空扱いに正規化する
        "title": _normalize_op_user_text(raw.get("title", "")),
        # W11-5: 明示Falseのみ「表示しない」。省略・その他の値はTrue(後方互換)
        "title_enabled": raw.get("title_enabled") is not False,
        "catch_copy": _normalize_op_user_text(raw.get("catch_copy", "")),
        "clips": _normalize_op_clips(raw.get("clips")),
    }


def select_highlight_clips(
    slots: List[Dict[str, Any]],
    keep_segments: List[Dict[str, Any]],
    max_clips: int = 3,
    clip_min_ms: int = 1200,
    clip_max_ms: int = 2000,
    type_mapping: Optional[Dict[str, Any]] = None,
    op_picks: Optional[List[Any]] = None,
    target_total_ms: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """highlight_teaser の抜粋クリップを telop_directives のスロットから決定的に選ぶ。

    - フェーズW: op_picks がv2(dict配列: role/display/hook_text/keyword/keyword_color付き)の
      場合はAIの最終選定を正とする:
        * 並び順はAIの提案順(=OPの演出順: 開幕フック→畳みかけ→引き)を保持する
        * 各クリップの尺は「合計がtarget_total_ms(既定15秒)に収まる1クリップ上限」まで
          セグメント内で確保する(スロットが短くても発話は連続しているため延長してよい)
        * フックワード系メタをクリップへ引き継ぐ(Remotionが画面いっぱいの一言として描画)
        * v2ピックが MIN_OP_CLIPS 件未満なら従来のtype優先候補で補完する
          (最後のピックが引き(cliffhanger)ならその直前に差し込む=引きで締める構成を守る)
    - 旧形式(slot_id文字列)・op_picksなしは完全に従来動作(後方互換):
      type優先度 → スロット尺の長い順 → 出現順で選び、採用後は時系列順に並べ直す
    - 各クリップは属するkeep_segment内にクランプする
    - フェーズV2: 各クリップに該当スロットの整形済みテロップ文言(text)と、
      最新のtype→presetマッピングで解決したスタイルID(style)を持たせる

    Returns:
        [{"cut_index", "start_ms", "end_ms", "text", "style",
          "source_start_ms", "source_end_ms", (v2のみ role/display/hook_text/...)}]
        start/end は該当カットのセグメント内相対ms、source_*_ms は元動画の絶対ms。
    """
    # 循環importを避けるため関数内import(direction は opening を参照しない)
    from shared.direction import effective_slot_style

    pick_metas = _normalize_op_pick_metas(op_picks)
    meta_by_slot_id = {meta["slot_id"]: meta for meta in pick_metas}
    pick_rank = {meta["slot_id"]: rank for rank, meta in enumerate(pick_metas)}
    is_v2 = any(meta.get("v2") for meta in pick_metas)

    # v2の1クリップ上限: 合計をtarget_total_msへ収める(3クリップ→各3.5秒上限=約10.5秒、
    # 5クリップ→各3秒上限=15秒。少数精鋭でも畳みかけでも10〜15秒に落ち着く)
    pick_count = min(len(pick_metas), max(1, int(max_clips)))
    v2_cap_ms = clip_max_ms
    if is_v2 and pick_count > 0 and target_total_ms:
        v2_cap_ms = max(clip_min_ms, min(clip_max_ms, int(target_total_ms) // pick_count))

    def build_clip(slot: Dict[str, Any], cap_ms: int, extend: bool) -> Optional[Tuple[Dict[str, Any], int]]:
        """スロット→クリップ(セグメント内クランプ+尺確保)。(clip, src_start) か None。"""
        src_start = int(slot.get("source_start_ms", -1))
        src_end = int(slot.get("source_end_ms", -1))
        if src_end <= src_start:
            return None
        midpoint = (src_start + src_end) / 2
        cut_index = next(
            (
                i for i, seg in enumerate(keep_segments)
                if int(seg["start_ms"]) <= midpoint < int(seg["end_ms"])
            ),
            None,
        )
        if cut_index is None:
            return None
        seg = keep_segments[cut_index]
        seg_start = int(seg["start_ms"])
        seg_len = int(seg["end_ms"]) - seg_start
        rel_start = max(0, src_start - seg_start)
        if extend:
            # v2: スロット終端に縛られず、セグメント内でcapまで尺を確保する
            rel_end = min(seg_len, rel_start + cap_ms)
        else:
            rel_end = min(int(seg["end_ms"]), src_end) - seg_start
            rel_end = min(rel_end, rel_start + cap_ms)
        if rel_end - rel_start < clip_min_ms:
            return None
        clip = {
            "cut_index": cut_index,
            "start_ms": rel_start,
            "end_ms": rel_end,
            # OPテロップは横スライドの1行表示のため、本編用の手動改行は空白に潰す
            "text": " ".join(str(slot.get("text", "") or "").split()),
            "style": effective_slot_style(slot, type_mapping),
            "source_start_ms": seg_start + rel_start,
            "source_end_ms": seg_start + rel_end,
        }
        return clip, src_start

    slots_by_id = {
        str(slot.get("slot_id", "")): slot for slot in slots or [] if isinstance(slot, dict)
    }

    if is_v2:
        # --- フェーズW: AIの最終選定を正とする経路 ---
        picked_clips: List[Dict[str, Any]] = []
        picked_slot_ids: set = set()
        for meta in pick_metas[: max(1, int(max_clips))]:
            slot = slots_by_id.get(meta["slot_id"])
            if slot is None:
                continue
            built = build_clip(slot, v2_cap_ms, extend=True)
            if built is None:
                continue
            clip, _ = built
            for key in OP_PICK_META_KEYS:
                if meta.get(key):
                    clip[key] = meta[key]
            picked_clips.append(clip)
            picked_slot_ids.add(meta["slot_id"])

        # 補完: v2ピックが少なすぎる場合のみ、従来のtype優先候補から埋める(時系列順)
        if len(picked_clips) < MIN_OP_CLIPS:
            fills: List[Tuple[Tuple[int, int, int], Dict[str, Any], int]] = []
            for order, slot in enumerate(slots or []):
                if not isinstance(slot, dict):
                    continue
                slot_id = str(slot.get("slot_id", ""))
                if slot_id in picked_slot_ids:
                    continue
                slot_type = str(slot.get("type", ""))
                if slot_type not in HIGHLIGHT_SLOT_PRIORITY:
                    continue
                built = build_clip(slot, v2_cap_ms, extend=False)
                if built is None:
                    continue
                clip, src_start = built
                fills.append((
                    (HIGHLIGHT_SLOT_PRIORITY[slot_type], -(clip["end_ms"] - clip["start_ms"]), order),
                    clip,
                    src_start,
                ))
            fills.sort(key=lambda item: item[0])
            need = min(MIN_OP_CLIPS - len(picked_clips), max(0, int(max_clips) - len(picked_clips)))
            chosen = fills[:need]
            chosen.sort(key=lambda item: item[2])  # 補完分は時系列順
            fill_clips = [item[1] for item in chosen]
            if picked_clips and picked_clips[-1].get("role") == "cliffhanger":
                # 「引きで締める」構成を守る(補完はcliffhangerの手前へ)
                picked_clips = picked_clips[:-1] + fill_clips + picked_clips[-1:]
            else:
                picked_clips.extend(fill_clips)
        return picked_clips

    # --- 従来経路(op_picksなし・旧形式slot_id文字列): 完全後方互換 ---
    candidates: List[Tuple[Tuple[int, int, int, int, int], Dict[str, Any], int]] = []
    for order, slot in enumerate(slots or []):
        if not isinstance(slot, dict):
            continue
        slot_type = str(slot.get("type", ""))
        picked_rank = pick_rank.get(str(slot.get("slot_id", "")))
        # op_picks 対象外かつ盛り上がり系typeでもないスロットは候補にしない
        if picked_rank is None and slot_type not in HIGHLIGHT_SLOT_PRIORITY:
            continue
        built = build_clip(slot, clip_max_ms, extend=False)
        if built is None:
            continue
        clip, src_start = built
        # V8-6: op_picks 採用スロット(先頭ほど優先)を、従来のtype優先候補より常に前に置く
        sort_key = (
            0 if picked_rank is not None else 1,
            picked_rank if picked_rank is not None else 0,
            HIGHLIGHT_SLOT_PRIORITY.get(slot_type, len(HIGHLIGHT_SLOT_PRIORITY)),
            -(clip["end_ms"] - clip["start_ms"]),
            order,
        )
        candidates.append((sort_key, clip, src_start))

    candidates.sort(key=lambda item: item[0])
    picked = candidates[: max(1, int(max_clips))]
    picked.sort(key=lambda item: item[2])
    return [item[1] for item in picked]


def resolve_user_clips(
    user_clips: List[Dict[str, Any]],
    keep_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """フェーズV2: op_config.clips(ユーザー指定・元動画絶対ms)をカットへ再解決する。

    - 各クリップは区間の中点が属する keep_segment を探し、セグメント内へクランプする
      (カットのトリム・分割後も「そのシーンのクリップ」の意図が保たれる)
    - 尺は USER_CLIP_MIN_MS〜USER_CLIP_MAX_MS へクランプ、どのカットにも属さない・
      短すぎるクリップは捨てる(全滅時は呼び出し側がAI自動選定へフォールバックする)
    - 並び順はユーザーの指定順を維持する(自動選定と違い時系列に並べ直さない)
    """
    resolved: List[Dict[str, Any]] = []
    for clip in user_clips or []:
        src_start = int(clip.get("start_ms", -1))
        src_end = int(clip.get("end_ms", -1))
        if src_end <= src_start:
            continue
        midpoint = (src_start + src_end) / 2
        cut_index = next(
            (
                i for i, seg in enumerate(keep_segments)
                if int(seg["start_ms"]) <= midpoint < int(seg["end_ms"])
            ),
            None,
        )
        if cut_index is None:
            continue
        seg = keep_segments[cut_index]
        seg_start = int(seg["start_ms"])
        rel_start = max(0, src_start - seg_start)
        rel_end = min(int(seg["end_ms"]), src_end) - seg_start
        if rel_end - rel_start < USER_CLIP_MIN_MS:
            continue
        rel_end = min(rel_end, rel_start + USER_CLIP_MAX_MS)
        entry = {
            "cut_index": cut_index,
            "start_ms": rel_start,
            "end_ms": rel_end,
            "text": str(clip.get("text", "") or "").strip(),
            "style": str(clip.get("style", "") or "").strip(),
            "source_start_ms": seg_start + rel_start,
            "source_end_ms": seg_start + rel_end,
        }
        # フェーズW: フックワード系メタ(UI編集値)をそのまま引き継ぐ
        for key in OP_PICK_META_KEYS:
            value = str(clip.get(key, "") or "")
            if value:
                entry[key] = value
        resolved.append(entry)
    return resolved


def build_op(
    op_config: Dict[str, Any],
    patterns: Dict[str, Dict[str, Any]],
    directive_slots: Optional[List[Dict[str, Any]]],
    keep_segments: List[Dict[str, Any]],
    cuts: List[Dict[str, Any]],
    video_path: str,
    type_mapping: Optional[Dict[str, Any]] = None,
    op_picks: Optional[List[str]] = None,
    ai_title: str = "",
) -> Optional[Dict[str, Any]]:
    """timeline.op を構築する(cuts はセグメント抽出後=video.file_pathがセグメント参照)。

    - title の優先順位(W11-5): ユーザー入力(op_config.title) > AI生成
      (telop_directives の op_title = ai_title)。どちらも無ければ空文字=タイトル非表示
      (動画ファイル名へのフォールバックはW11-5で廃止)。
      op_config.title_enabled が False(「表示しない」チェック)なら常に空文字
    - question_hook の catch_copy 未指定はタイトルからの決定的な問い文にする(UIで編集可)
    - highlight_teaser のクリップ:
      1. op_config.clips(フェーズV2のユーザー指定)があればそれを優先(resolve_user_clips)
      2. 無ければAI自動選定(select_highlight_clips。V8-6: op_picks があれば最優先)
      3. 候補ゼロ(fullモード・該当スロットなし等)は title_card へフォールバックする
         (OPを黙って消さない)
    - 各ハイライトカットに text/style(横スライドテロップ用)と source_*_ms/cut_id
      (OP編集UIがサムネ・シーン対応の表示に使う。Remotionは参照しない)を出力する
    """
    pattern = op_config["pattern"]
    spec = patterns.get(pattern) or FALLBACK_OP_PATTERNS.get(pattern) or {}
    # W11-5: ファイル名フォールバックを廃止(ユーザー入力 > AI生成のみ。無ければ非表示)。
    # title_enabled=False(「表示しない」チェック)なら常に空文字にする
    title_enabled = op_config.get("title_enabled") is not False
    title = (op_config["title"] or str(ai_title or "").strip()) if title_enabled else ""
    catch_copy = op_config["catch_copy"]

    op: Dict[str, Any] = {
        "pattern": pattern,
        "title": title,
        "catch_copy": catch_copy,
        "sfx_hit": spec.get("sfx_hit"),
        "sfx_transition": spec.get("sfx_transition"),
    }

    if pattern == "highlight_teaser":
        # フェーズV5: 装飾・テロップ登場アニメをtimeline.opへ出力(Remotionが描画分岐する)
        op["decoration"] = (
            op_config.get("decoration")
            if op_config.get("decoration") in OP_DECORATION_IDS
            else DEFAULT_OP_DECORATION
        )
        op["text_animation"] = (
            op_config.get("text_animation")
            if op_config.get("text_animation") in OP_TEXT_ANIMATION_IDS
            else DEFAULT_OP_TEXT_ANIMATION
        )
        user_clips = op_config.get("clips")
        clips = resolve_user_clips(user_clips, keep_segments) if user_clips else []
        if not clips:
            clips = select_highlight_clips(
                directive_slots or [],
                keep_segments,
                max_clips=int(spec.get("max_clips", 5)),
                clip_min_ms=int(spec.get("clip_min_ms", 1500)),
                clip_max_ms=int(spec.get("clip_max_ms", 3500)),
                type_mapping=type_mapping,
                op_picks=op_picks,
                target_total_ms=int(spec.get("target_total_ms", 15000)),
            )
        if not clips:
            fallback = dict(op_config)
            fallback["pattern"] = "title_card"
            return build_op(
                fallback, patterns, directive_slots, keep_segments, cuts, video_path,
                type_mapping=type_mapping, op_picks=op_picks, ai_title=ai_title,
            )
        highlight_cuts = []
        for clip in clips:
            cut = cuts[clip["cut_index"]]
            video = cut.get("video", {})
            # セグメント抽出後は file_path=セグメントMP4・start_ms=0 のため、クリップの
            # 相対msがそのままセグメント内位置になる(抽出失敗時は元動画+絶対msで補正)
            base_ms = int(video.get("start_ms", 0))
            entry: Dict[str, Any] = {
                "file_path": str(video.get("file_path", "")),
                "start_ms": base_ms + int(clip["start_ms"]),
                "end_ms": base_ms + int(clip["end_ms"]),
                # フェーズV2: OP編集UI用のメタ(元動画の絶対msアンカーとカットID)
                "cut_id": str(cut.get("cut_id", "") or ""),
                "source_start_ms": int(clip.get("source_start_ms", 0)),
                "source_end_ms": int(clip.get("source_end_ms", 0)),
            }
            # 空文言はテロップなしクリップ(Remotion側も描画しない)。styleは文言がある時のみ意味を持つ
            if clip.get("text"):
                entry["text"] = str(clip["text"])
                style = str(clip.get("style") or "").strip()
                if not style:
                    # ユーザークリップで文言だけ入力された場合はテーマのhype系(盛り上げ)へ
                    from shared.direction import effective_slot_style
                    style = effective_slot_style({"type": "hype"}, type_mapping)
                entry["style"] = style
            # フェーズW: フックワード系メタ(role/display/hook_text/keyword/keyword_color)を
            # timeline.op へ出力する(Remotionが「画面いっぱいの一言」描画に使う)
            for key in OP_PICK_META_KEYS:
                value = str(clip.get(key, "") or "")
                if value:
                    entry[key] = value
            highlight_cuts.append(entry)
        op["highlight_cuts"] = highlight_cuts
        op["duration_ms"] = sum(c["end_ms"] - c["start_ms"] for c in highlight_cuts)
        return op

    # W11-5: タイトルが空(非表示)のときは問い文も作れないため従来の補完をしない
    if pattern == "question_hook" and not catch_copy and title:
        op["catch_copy"] = f"{title}、知っていますか？"

    op["duration_ms"] = int(spec.get("duration_ms", 4000))
    return op


def apply_op_offset(
    cuts: List[Dict[str, Any]],
    overlays: List[Dict[str, Any]],
    offset_ms: int,
) -> None:
    """OP尺分だけ本編のタイムラインを後ろへずらす(cuts.timeline / overlays を破壊的に更新)。

    voice_data のテロップはカット相対タイミングのためオフセット不要。
    SFXイベントは cuts.timeline.start_ms 起点で計算されるため自動で追従する。
    """
    if offset_ms <= 0:
        return
    for cut in cuts:
        timeline = cut.get("timeline", {})
        timeline["start_ms"] = int(timeline.get("start_ms", 0)) + offset_ms
        timeline["end_ms"] = int(timeline.get("end_ms", 0)) + offset_ms
    for overlay in overlays:
        overlay["start_ms"] = int(overlay.get("start_ms", 0)) + offset_ms
        overlay["end_ms"] = int(overlay.get("end_ms", 0)) + offset_ms
