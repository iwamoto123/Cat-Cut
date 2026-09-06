"""Step 7: Cut Proposal - word timestampベースの無音圧縮 + フィラー/リテイク除去。

STTのword-level timestampを使い、単語間のgapが閾値を超える箇所でセグメント分割。
VADの arbitrary threshold (2000ms) は使わず、実際の発話タイミングだけで判断する。

Usage:
    python step07_cut_proposal.py \
        --stt ../runs/{run}/step02_stt/stt_result.json \
        --fillers ../runs/{run}/step04_filler_detect/fillers.json \
        --retakes ../runs/{run}/step05_retake_detect/retakes.json \
        --scenes ../runs/{run}/step06_scene_structure/scenes.json \
        --output ../runs/{run}/step07_cut_proposal
"""

import argparse
import json
import os
import re
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared.project_config import load_project_config

# 改善9-A: RMSエッジリファイン用の分析フレーム長
_RMS_FRAME_MS = 20

# 改善10-A: フィラー除去 action
_FILLER_ACTION_REMOVE = "remove"


def run_step(
    stt_result_path: str,
    fillers_path: str,
    retakes_path: str,
    scenes_path: str,
    output_dir: str,
    config: dict = None,
    vad_result_path: str = None,
    audio_path: str | None = None,
) -> dict:
    """STTのword timestampベースで無音圧縮 + フィラー/リテイク除去。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"[Step 7] Cut Proposal (word-timestamp based)")

    stt_result = _load_json(stt_result_path)
    fillers = _load_json(fillers_path)
    retakes = _load_json(retakes_path)
    scenes = _load_json(scenes_path)

    words = stt_result.get("words", [])
    sentences = stt_result.get("sentences", [])
    sentence_map = {s["id"]: s for s in sentences}
    word_map = {w["id"]: w for w in words}

    cfg = config or {}

    # VAD speech_segments で word boundaries をクランプ (ElevenLabs の timestamp padding を補正)
    speech_segs: list = []
    if vad_result_path and os.path.exists(vad_result_path):
        vad = _load_json(vad_result_path)
        speech_segs = vad.get("speech_segments", [])
        if speech_segs:
            adjusted = _clamp_words_to_speech(words, speech_segs, cfg.get("_timing", {}))
            timing_cfg = cfg.get("_timing", {})
            print(
                "  vad-clamp: adjusted "
                f"{adjusted} word boundaries to speech regions "
                f"(strength={timing_cfg.get('word_vad_clamp_strength', 1.0)}, "
                f"start_bias={timing_cfg.get('vad_start_bias_ms', 0)}ms, "
                f"end_bias={timing_cfg.get('vad_end_bias_ms', 0)}ms)"
            )
            # 改善8-A-1: クランプ結果をメモリ内だけでなく、UIが読む成果物
            # (stt_corrected.json 相当。--stt に渡されたファイルそのもの) へ書き戻す。
            # word は参照渡しで既にミューテート済みなので、ここでは sentences の
            # start_ms/end_ms を再計算してファイル保存するだけでよい。
            if adjusted:
                _persist_clamped_words(stt_result, stt_result_path, adjusted)

    max_gap_ms = cfg.get("max_gap_ms", 600)
    # 旧 segment_padding_ms は「設定に存在する場合のみ」両側フォールバックとして
    # 後方互換で使う。新設定 (lead_padding_ms/tail_padding_ms) が優先される。
    legacy_segment_padding_ms = cfg.get("segment_padding_ms")
    default_lead_padding_ms = legacy_segment_padding_ms if legacy_segment_padding_ms is not None else 200
    default_tail_padding_ms = legacy_segment_padding_ms if legacy_segment_padding_ms is not None else 120
    lead_padding_ms = cfg.get("lead_padding_ms", default_lead_padding_ms)
    tail_padding_ms = cfg.get("tail_padding_ms", default_tail_padding_ms)
    filler_confidence_threshold = cfg.get("filler_confidence_threshold", 0.6)

    # --- Phase 1: 除去するword_idを特定 ---
    remove_word_ids = set()
    remove_reasons = {}

    # 1a. フィラー (action=remove は confidence 無視。未指定は従来どおり閾値)
    filler_removed = 0
    for filler in fillers.get("fillers", []):
        if not _should_remove_filler(filler, filler_confidence_threshold):
            continue
        ids = list(filler.get("word_ids") or [])
        if filler.get("word_id"):
            ids.append(filler["word_id"])
        for wid in dict.fromkeys(ids):
            if not wid:
                continue
            remove_word_ids.add(wid)
            remove_reasons[wid] = f"filler:{filler.get('type', 'unknown')}"
            filler_removed += 1

    # 1b. リテイク (step05で検出済み)
    retake_removed_words = 0
    for retake in retakes.get("retakes", []):
        keep = retake.get("keep", "retry")
        if keep == "retry":
            ids_to_remove = retake.get("original_sentence_ids", [])
        else:
            ids_to_remove = retake.get("retry_sentence_ids", [])
        for sid in ids_to_remove:
            if sid in sentence_map:
                for wid in sentence_map[sid]["word_ids"]:
                    remove_word_ids.add(wid)
                    remove_reasons[wid] = "retake:step05"
                    retake_removed_words += 1
            elif sid in word_map:
                # フェーズW29: step05_ai_retake は original_sentence_ids に word ID を書く
                # (文単位リテイク・部分リテイク・AI判定フィラーすべて)。従来は文IDとしか
                # 照合しておらず、AI検出リテイクが一度も適用されない致命的バグだった
                remove_word_ids.add(sid)
                remove_reasons[sid] = "retake:step05"
                retake_removed_words += 1

    # 1c. インラインリテイク ("--" パターン検出)
    inline_retake_count = 0
    for sent in sentences:
        text = sent.get("text", "")
        if "--" not in text:
            continue
        # "--" の前の部分が false start (言い直し前)
        dash_pos = text.index("--")
        chars_before = dash_pos
        word_ids = sent["word_ids"]
        # wordのテキストを積算して、dash_posまでのword群を特定
        char_count = 0
        split_idx = 0
        for i, wid in enumerate(word_ids):
            w = word_map.get(wid)
            if w:
                char_count += len(w["text"])
            if char_count >= chars_before:
                split_idx = i + 1
                break
        # split_idx までのwordが false start
        if split_idx > 0:
            for j in range(split_idx):
                wid = word_ids[j]
                if wid not in remove_word_ids:
                    remove_word_ids.add(wid)
                    remove_reasons[wid] = "retake:inline"
            inline_retake_count += 1
            print(f"  inline retake: {sent['id']} \"{text[:dash_pos]}\" (removed {split_idx} words)")

    # 1d. "--" マーカーword除去 (STTが "--" を独立wordとして出力する場合)
    dash_removed = 0
    for w in words:
        if w["text"].strip() in ("--", "-") and w["id"] not in remove_word_ids:
            remove_word_ids.add(w["id"])
            remove_reasons[w["id"]] = "marker:dash"
            dash_removed += 1

    print(f"  fillers removed: {filler_removed}")
    print(f"  retake words removed (step05): {retake_removed_words}")
    print(f"  inline retakes detected: {inline_retake_count}")
    print(f"  total words removed: {len(remove_word_ids)}")

    # --- Phase 2: 残りのword list ---
    remaining_words = [w for w in words if w["id"] not in remove_word_ids]
    print(f"  remaining words: {len(remaining_words)} / {len(words)}")

    # --- Phase 3: gapでクラスタリング + scene境界分割 ---
    # word_id → sentence_id → scene_id のマッピングを構築
    word_to_scene = _build_word_to_scene_map(words, sentences, sentence_map, scenes)
    clusters = _build_clusters(remaining_words, max_gap_ms, word_to_scene)
    print(f"  clusters: {len(clusters)}")

    # --- Phase 4: keep_segments構築 ---
    audio_duration_ms = _estimate_audio_duration(words, sentences)
    scene_list = scenes.get("scenes", [])

    keep_segments = []
    for i, cluster in enumerate(clusters):
        start_ms = max(0, cluster[0]["start_ms"] - lead_padding_ms)
        end_ms = min(audio_duration_ms, cluster[-1]["end_ms"] + tail_padding_ms)
        text = _clean_segment_text("".join(w["text"] for w in cluster))
        # クラスタの代表scene_idを先に付与
        cluster_scene = word_to_scene.get(cluster[0]["id"])
        keep_segments.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": text,
            "scene_id": cluster_scene,
        })

    # 隣接するsegmentが重なっていたらマージ（同一scene内のみ）
    keep_segments = _merge_adjacent_segments(keep_segments)

    # 短すぎるセグメントを隣接セグメントに統合
    # 動画編集の品質制約: 1秒未満 or 5文字以下のカットは視聴体験が悪い
    min_duration_ms = cfg.get("min_segment_duration_ms", 1000)
    min_chars = cfg.get("min_segment_chars", 5)
    keep_segments = _merge_short_segments(keep_segments, min_duration_ms, min_chars)

    # 改善8-A-3: keep_segments確定後、各segmentをVAD発話区間と交差させ
    # (a) 末尾無音をtail_padding_msまで切り詰め (b) 内部の連続無音(500ms超)で分割する。
    # 分割後は再度、既存の短セグメント統合ロジックを通す。
    if speech_segs:
        min_internal_silence_ms = cfg.get("min_internal_silence_ms", 500)
        before_trim_count = len(keep_segments)
        keep_segments = _apply_vad_speech_trim(
            keep_segments,
            remaining_words,
            speech_segs,
            lead_padding_ms,
            tail_padding_ms,
            min_internal_silence_ms,
        )
        # max_bridge_gap_ms: 直前の分割で作られた内部無音を再びブリッジして
        # 無音を復活させないよう、統合可能なgapをmin_internal_silence_ms以内に制限する。
        keep_segments = _merge_short_segments(
            keep_segments, min_duration_ms, min_chars, max_bridge_gap_ms=min_internal_silence_ms
        )
        print(
            "  vad-segment-trim: "
            f"{before_trim_count} -> {len(keep_segments)} segments "
            f"(tail_padding={tail_padding_ms}ms, internal_silence_threshold={min_internal_silence_ms}ms)"
        )

    # 改善9-A-1: VADトリム後、振幅エンベロープでセグメント端を詰める (詰め専用)
    resolved_audio_path = audio_path or _infer_audio_path(stt_result_path)
    edge_head_pad_ms = int(cfg.get("edge_head_pad_ms", 80) or 80)
    edge_tail_pad_ms = int(cfg.get("edge_tail_pad_ms", 150) or 150)
    if resolved_audio_path and os.path.exists(resolved_audio_path):
        before_rms = [(s["start_ms"], s["end_ms"]) for s in keep_segments]
        keep_segments, rms_refined = _apply_rms_edge_refine(
            keep_segments,
            resolved_audio_path,
            head_pad_ms=edge_head_pad_ms,
            tail_pad_ms=edge_tail_pad_ms,
        )
        if rms_refined:
            print(
                "  rms-edge-refine: "
                f"tightened {rms_refined}/{len(before_rms)} segments "
                f"(head_pad={edge_head_pad_ms}ms, tail_pad={edge_tail_pad_ms}ms)"
            )
        # 改善9-A-2: エッジリファイン後、単語境界をセグメント内にクランプして永続化
        bounds_adjusted = _clamp_words_to_segment_bounds(words, keep_segments)
        if bounds_adjusted:
            _persist_clamped_words(stt_result, stt_result_path, bounds_adjusted)
    elif resolved_audio_path:
        print(f"  rms-edge-refine: skipped (audio not found: {resolved_audio_path})")

    # 末尾segmentのトリム（STT末尾word duration肥大化対策）
    keep_segments = _trim_trailing_silence(keep_segments, remaining_words)

    # 改善16-A: 単語内カット境界ガード（BudouXチャンク内部の境界を結合）
    if "word_split_merge_max_gap_ms" in cfg:
        word_split_max_gap_ms = int(cfg["word_split_merge_max_gap_ms"])
    else:
        word_split_max_gap_ms = 1500
    # V8-6: フラグ生成のギャップ上限(超は「意図的な間」としてフラグ化しない)
    word_split_flag_max_gap_ms = int(cfg.get("word_split_flag_max_gap_ms", 1200))
    keep_segments, word_split_merges, word_split_flags = _apply_word_split_merge(
        keep_segments,
        remaining_words,
        max_gap_ms=word_split_max_gap_ms,
        flag_max_gap_ms=word_split_flag_max_gap_ms,
    )
    if word_split_merges:
        print(f"  word-split merges: {word_split_merges}")
    if word_split_flags:
        print(f"  word-split flags: {len(word_split_flags)}")

    # scene_id 再計算（マージ後の中点ベース）
    for seg in keep_segments:
        seg["scene_id"] = _find_scene(seg, scene_list)

    # --- Stats ---
    kept_ms = sum(s["end_ms"] - s["start_ms"] for s in keep_segments)
    removed_ms = audio_duration_ms - kept_ms

    # remove_ranges (デバッグ用)
    remove_ranges = _build_remove_ranges(keep_segments, audio_duration_ms)

    result = {
        "keep_segments": keep_segments,
        "remove_ranges": remove_ranges,
        "removed_word_ids": sorted(remove_word_ids),
        "word_split_flags": word_split_flags,
        "stats": {
            "total_keep_segments": len(keep_segments),
            "total_remove_ranges": len(remove_ranges),
            "kept_duration_ms": kept_ms,
            "removed_duration_ms": removed_ms,
            "original_duration_ms": audio_duration_ms,
            "reduction_ratio": round(removed_ms / max(audio_duration_ms, 1), 3),
            "words_total": len(words),
            "words_removed": len(remove_word_ids),
            "words_kept": len(remaining_words),
            "removed_word_ids": sorted(remove_word_ids),
            "word_split_merges": word_split_merges,
            "word_split_flags": len(word_split_flags),
            "config": {
                "max_gap_ms": max_gap_ms,
                "lead_padding_ms": lead_padding_ms,
                "tail_padding_ms": tail_padding_ms,
                # 後方互換: 旧UI/学習ルールが参照する可能性があるため残す
                # (非対称パディング導入後は tail 側の値をベースに近似表示)
                "segment_padding_ms": legacy_segment_padding_ms if legacy_segment_padding_ms is not None else tail_padding_ms,
                "filler_confidence_threshold": filler_confidence_threshold,
                "edge_head_pad_ms": edge_head_pad_ms,
                "edge_tail_pad_ms": edge_tail_pad_ms,
                "word_split_merge_max_gap_ms": word_split_max_gap_ms,
                "word_split_flag_max_gap_ms": word_split_flag_max_gap_ms,
            },
        },
    }

    print(f"  keep segments: {len(keep_segments)}")
    print(f"  remove ranges: {len(remove_ranges)}")
    print(f"  kept: {kept_ms}ms / {audio_duration_ms}ms (removed {result['stats']['reduction_ratio']:.1%})")

    output_path = os.path.join(output_dir, "cut_proposal.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[Step 7] Done: {output_path}")
    return result


def _build_word_to_scene_map(
    words: list, sentences: list, sentence_map: dict, scenes: dict,
) -> dict:
    """word_id → scene_id のマッピングを構築。"""
    # sentence_id → scene_id
    sent_to_scene = {}
    for scene in scenes.get("scenes", []):
        for sid in scene.get("sentence_ids", []):
            sent_to_scene[sid] = scene["id"]

    # word_id → sentence_id → scene_id
    word_to_scene = {}
    for sent in sentences:
        scene_id = sent_to_scene.get(sent["id"])
        for wid in sent.get("word_ids", []):
            word_to_scene[wid] = scene_id

    return word_to_scene


def _build_clusters(words: list, max_gap_ms: int, word_to_scene: dict = None) -> list:
    """wordをgap閾値 + scene境界でクラスタリング。

    分割条件:
    1. 連続するword間のgapがmax_gap_ms超
    2. scene_idが変わった（話題の切れ目）
    """
    if not words:
        return []

    clusters = []
    current = [words[0]]

    for w in words[1:]:
        prev_end = current[-1]["end_ms"]
        gap = w["start_ms"] - prev_end

        # scene境界チェック
        scene_changed = False
        if word_to_scene:
            prev_scene = word_to_scene.get(current[-1]["id"])
            curr_scene = word_to_scene.get(w["id"])
            if prev_scene and curr_scene and prev_scene != curr_scene:
                scene_changed = True

        if gap > max_gap_ms or scene_changed:
            clusters.append(current)
            current = [w]
        else:
            current.append(w)

    if current:
        clusters.append(current)

    return clusters


def _merge_adjacent_segments(segments: list) -> list:
    """重なりのあるsegmentをマージ（同一scene内のみ）。

    scene境界で分割されたセグメントは、paddingで時間的に重なっていても
    マージしない。異なる話題を1カットにまとめないため。
    """
    if len(segments) <= 1:
        return segments

    merged = [segments[0].copy()]
    for seg in segments[1:]:
        last = merged[-1]
        same_scene = (
            last.get("scene_id") is not None
            and seg.get("scene_id") is not None
            and last["scene_id"] == seg["scene_id"]
        )
        overlapping = seg["start_ms"] <= last["end_ms"]

        if overlapping and same_scene:
            # 同一scene内の重複 → マージ
            last["end_ms"] = max(last["end_ms"], seg["end_ms"])
            last["text"] = last["text"] + seg["text"]
        else:
            # 異なるsceneまたは離れている → 分離
            new_seg = seg.copy()
            if overlapping:
                # padding重複を解消: 中点で分割
                mid = (last["end_ms"] + new_seg["start_ms"]) // 2
                last["end_ms"] = mid
                new_seg["start_ms"] = mid
            merged.append(new_seg)

    return merged


def _merge_short_segments(
    segments: list,
    min_duration_ms: int = 1000,
    min_chars: int = 5,
    max_bridge_gap_ms: int | None = None,
) -> list:
    """短すぎるセグメントを隣接セグメントに統合する。

    動画編集の品質制約:
    - 1秒未満のカットは視聴体験が悪い (映像として不自然)
    - 5文字以下のテロップは情報量が少なく孤立して見える

    短いセグメントは前のセグメントに統合する。先頭セグメントが短い場合は
    後ろのセグメントに統合する。統合時はgapを埋めて連続させる。

    改善8-A-3: max_bridge_gap_ms を指定すると、隣接セグメントとの間の無音(gap)が
    それを超える場合は統合をスキップする。VADトリムで内部無音により分割された
    セグメントを、直後の短セグメント統合パスが再びブリッジして無音を復活させて
    しまう問題を防ぐためのガード。
    """
    if len(segments) <= 1:
        return segments

    # 複数パスで処理 (1回のマージで新たに短くなることはないが、安全のため)
    changed = True
    while changed:
        changed = False
        result = []
        i = 0
        while i < len(segments):
            seg = segments[i]
            duration_ms = seg["end_ms"] - seg["start_ms"]
            text_len = len(seg.get("text", ""))
            is_short = duration_ms < min_duration_ms or text_len < min_chars

            gap_to_prev = seg["start_ms"] - result[-1]["end_ms"] if result else None
            gap_to_next = (
                segments[i + 1]["start_ms"] - seg["end_ms"] if i + 1 < len(segments) else None
            )
            can_bridge_prev = gap_to_prev is not None and (
                max_bridge_gap_ms is None or gap_to_prev <= max_bridge_gap_ms
            )
            can_bridge_next = gap_to_next is not None and (
                max_bridge_gap_ms is None or gap_to_next <= max_bridge_gap_ms
            )

            if is_short and can_bridge_prev:
                # 前のセグメントに統合
                prev = result[-1]
                prev["end_ms"] = seg["end_ms"]
                prev["text"] = prev["text"] + seg["text"]
                changed = True
                print(f"  short merge: \"{seg['text']}\" ({duration_ms}ms/{text_len}字) -> merged into prev")
            elif is_short and not result and can_bridge_next:
                # 先頭セグメントが短い場合、後ろに統合
                next_seg = segments[i + 1]
                next_seg["start_ms"] = seg["start_ms"]
                next_seg["text"] = seg["text"] + next_seg["text"]
                changed = True
                print(f"  short merge: \"{seg['text']}\" ({duration_ms}ms/{text_len}字) -> merged into next")
            else:
                result.append(seg.copy())
            i += 1
        segments = result

    return segments


def _trim_trailing_silence(keep_segments: list, remaining_words: list) -> list:
    """最後のsegmentの末尾トリム（STT末尾word duration肥大化対策）。

    ElevenLabsのSTTは録音末尾の無音を最後のwordに含めることがある。
    wordデータは触らず、segmentレベルで末尾をカットする。
    """
    if not keep_segments or not remaining_words:
        return keep_segments

    last_seg = keep_segments[-1]
    # このsegment内の最後のwordを探す
    words_in_seg = [
        w for w in remaining_words
        if w["start_ms"] < last_seg["end_ms"] and w["end_ms"] > last_seg["start_ms"]
    ]
    if len(words_in_seg) < 2:
        return keep_segments

    last_word = words_in_seg[-1]
    second_last = words_in_seg[-2]

    # 最後のwordのdurationが前のwordの3倍以上なら異常とみなす
    last_dur = last_word["end_ms"] - last_word["start_ms"]
    prev_dur = second_last["end_ms"] - second_last["start_ms"]
    if prev_dur > 0 and last_dur > prev_dur * 3 and last_dur > 500:
        # 最後のwordのstart_ms + 妥当なduration でカット
        trimmed_end = last_word["start_ms"] + min(prev_dur * 2, 400) + 50
        if trimmed_end < last_seg["end_ms"]:
            trimmed_ms = last_seg["end_ms"] - trimmed_end
            last_seg["end_ms"] = trimmed_end
            print(f"  trailing trim: -{trimmed_ms}ms (last word dur {last_dur}ms -> capped)")

    return keep_segments


def _build_remove_ranges(keep_segments: list, audio_duration_ms: int) -> list:
    """keep_segmentsの間をremove_rangesとして構築（デバッグ・ログ用）。"""
    ranges = []
    prev_end = 0
    for seg in keep_segments:
        if seg["start_ms"] > prev_end:
            ranges.append({
                "start_ms": prev_end,
                "end_ms": seg["start_ms"],
                "duration_ms": seg["start_ms"] - prev_end,
                "reason": "gap",
            })
        prev_end = seg["end_ms"]

    if prev_end < audio_duration_ms:
        ranges.append({
            "start_ms": prev_end,
            "end_ms": audio_duration_ms,
            "duration_ms": audio_duration_ms - prev_end,
            "reason": "trailing_silence",
        })

    return ranges


def _estimate_audio_duration(words: list, sentences: list) -> int:
    """音声の総尺をword/sentenceから推定。"""
    candidates = []
    if words:
        candidates.append(words[-1]["end_ms"])
    if sentences:
        candidates.append(sentences[-1]["end_ms"])
    if candidates:
        return max(candidates) + 500  # 末尾に余白
    return 0


def _find_scene(segment: dict, scenes: list) -> str | None:
    """segmentが属するscene_idを特定。"""
    mid_ms = (segment["start_ms"] + segment["end_ms"]) // 2
    for scene in scenes:
        s_start = scene.get("start_ms", 0)
        s_end = scene.get("end_ms", 0)
        if s_start <= mid_ms <= s_end:
            return scene["id"]
    return None


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _find_host_speech_segment(segs: list, start_ms: int, start_bias_ms: int = 0) -> dict | None:
    """word の start_ms に対応する VAD speech segment を探す。

    優先順位:
    1. start_ms を含む (= 発話中に単語が始まっている) segment
    2. 見つからない場合、start_ms 以前に終了した直近の segment
       (句読点や異常伸長した単語の start 自体が無音区間に食い込んでいる場合の救済)

    将来の speech segment へ先送りすることはしない
    (無音を挟んだ先の発話まで単語を伸ばしてしまう誤クランプを避けるため)。
    """
    preceding = None
    for s in segs:
        if s["start_ms"] + start_bias_ms <= start_ms <= s["end_ms"]:
            return s
        if s["end_ms"] <= start_ms:
            preceding = s
    return preceding


def _clamp_words_to_speech(
    words: list,
    speech_segs: list,
    timing_cfg: dict | None = None,
    tail_silence_threshold_ms: int = 800,
    per_char_max_ms: int = 400,
    fixed_margin_ms: int = 800,
) -> int:
    """異常に長い word の end_ms を VAD speech_segments の終端にクランプする。

    ElevenLabs STT は無音区間を跨いで word の end timestamp を引き延ばすことが
    あり (例: 1文字の word が十数秒に及ぶ)、word 間 gap ベースの無音クラスタリング
    (`_build_clusters`) が機能しなくなる。VAD (Step 3) が検出した実際の発話区間と
    交差させ、以下のいずれかに該当する word だけを「異常」とみなして end_ms を
    その word が属する speech segment の終端まで縮める。正常な word (発話区間に
    収まっている word) は変更しない:

    - word 末尾が speech 終端より tail_silence_threshold_ms (既定800ms) 以上
      無音側へ食い込んでいる (句読点などゼロ長 word が異常伸長した前の word に
      引きずられて無音区間の奥に居座るケースも含む)
    - duration が「文字数 × per_char_max_ms (既定400ms) + fixed_margin_ms (既定800ms)」
      を超える (改善8-A-2: 旧「1文字1200ms超」を文字数に応じた閾値へ一般化。
      1文字なら 400+800=1200ms で従来と同じ、2文字以上の語 (例:「ます」) が
      無音を跨いで異常に長くなるケースも捕捉できる)

    start_ms は基本的に変更しないが、word 自体が (句読点等で) 既に speech
    segment の終端より後ろから始まっている場合のみ、start_ms も end_ms と
    同じ位置まで引き戻して start<=end の不変条件を保つ。
    """
    if not speech_segs or not words:
        return 0
    timing_cfg = timing_cfg or {}
    strength = max(0.0, min(1.0, float(timing_cfg.get("word_vad_clamp_strength", 1.0))))
    if strength <= 0:
        return 0
    start_bias_ms = int(timing_cfg.get("vad_start_bias_ms", 0) or 0)
    end_bias_ms = int(timing_cfg.get("vad_end_bias_ms", 0) or 0)
    tail_silence_threshold_ms = int(
        timing_cfg.get("vad_clamp_tail_silence_threshold_ms", tail_silence_threshold_ms)
        or tail_silence_threshold_ms
    )
    per_char_max_ms = int(timing_cfg.get("vad_clamp_per_char_ms", per_char_max_ms) or per_char_max_ms)
    fixed_margin_ms = int(timing_cfg.get("vad_clamp_fixed_margin_ms", fixed_margin_ms) or fixed_margin_ms)
    segs = sorted(speech_segs, key=lambda s: s["start_ms"])

    adjusted = 0
    for w in words:
        start = w["start_ms"]
        end = w["end_ms"]
        host = _find_host_speech_segment(segs, start, start_bias_ms)
        if host is None:
            continue
        host_end = max(0, host["end_ms"] + end_bias_ms)
        overlap_ms = end - host_end
        if overlap_ms <= 0:
            continue  # speech区間内に収まっている = 正常

        text_len = len(str(w.get("text", "")).strip())
        duration_ms = end - start
        max_normal_duration_ms = text_len * per_char_max_ms + fixed_margin_ms
        is_abnormal = overlap_ms >= tail_silence_threshold_ms or duration_ms > max_normal_duration_ms
        if not is_abnormal:
            continue

        new_end = round(end - overlap_ms * strength)
        new_start = min(start, new_end)
        if new_end != end or new_start != start:
            w["start_ms"] = new_start
            w["end_ms"] = new_end
            adjusted += 1
    return adjusted


def _persist_clamped_words(stt_result: dict, stt_result_path: str, adjusted_count: int) -> None:
    """改善8-A-1: VADクランプ済みのword timingを、UIが読むSTT成果物ファイルへ書き戻す。

    `words` は `_clamp_words_to_speech` が参照渡しで直接ミューテートしているため、
    `stt_result["words"]` には既に補正後の値が入っている。ここでは sentences の
    start_ms/end_ms を word から再計算した上でファイルへ保存するだけでよい。
    これにより、デスクトップUI (`stt_corrected.json` を直接読む) ・カット計算・
    境界はみ出し警告・波形がすべて同一の補正済みタイミングを参照するようになる。
    """
    words_by_id = {w.get("id"): w for w in stt_result.get("words", []) if w.get("id")}
    for sent in stt_result.get("sentences", []):
        word_ids = sent.get("word_ids") or []
        sent_words = [words_by_id[wid] for wid in word_ids if wid in words_by_id]
        if not sent_words:
            continue
        sent["start_ms"] = min(w["start_ms"] for w in sent_words)
        sent["end_ms"] = max(w["end_ms"] for w in sent_words)

    with open(stt_result_path, "w", encoding="utf-8") as f:
        json.dump(stt_result, f, ensure_ascii=False, indent=2)
    print(f"  vad-clamp: persisted {adjusted_count} adjusted word timings -> {stt_result_path}")


def _clip_speech_to_range(speech_segs: list, range_start_ms: int, range_end_ms: int) -> list:
    """speech_segs を [range_start_ms, range_end_ms] にクリップした区間のリストを返す (昇順)。"""
    clipped = []
    for s in speech_segs:
        start = max(s["start_ms"], range_start_ms)
        end = min(s["end_ms"], range_end_ms)
        if end > start:
            clipped.append((start, end))
    clipped.sort()
    return clipped


def _split_range_by_internal_silence(
    range_start_ms: int,
    range_end_ms: int,
    speech_intervals: list,
    lead_padding_ms: int,
    tail_padding_ms: int,
    min_internal_silence_ms: int,
) -> list:
    """range内で連続する発話区間の間に min_internal_silence_ms 超の無音があれば分割点を作る。

    分割点は無音区間の中点を超えない範囲で lead/tail padding を適用し、
    2つの新しい区間が重ならないようにする。
    """
    if len(speech_intervals) <= 1:
        return [(range_start_ms, range_end_ms)]

    boundaries = [range_start_ms]
    for (_, prev_end), (next_start, _) in zip(speech_intervals, speech_intervals[1:]):
        gap = next_start - prev_end
        if gap > min_internal_silence_ms:
            mid = (prev_end + next_start) // 2
            split_end = min(prev_end + tail_padding_ms, mid)
            split_start = max(next_start - lead_padding_ms, mid)
            if split_end > boundaries[-1]:
                boundaries.append(split_end)
                boundaries.append(split_start)
    boundaries.append(range_end_ms)

    ranges = []
    for i in range(0, len(boundaries) - 1, 2):
        s, e = boundaries[i], boundaries[i + 1]
        if e > s:
            ranges.append((s, e))
    return ranges or [(range_start_ms, range_end_ms)]


def _apply_vad_speech_trim(
    keep_segments: list,
    remaining_words: list,
    speech_segs: list,
    lead_padding_ms: int,
    tail_padding_ms: int,
    min_internal_silence_ms: int = 500,
) -> list:
    """改善8-A-3: keep_segments確定後、各segmentをVAD発話区間と交差させる。

    (a) segment末尾の無音を tail_padding_ms まで切り詰める
    (b) segment内部に連続 min_internal_silence_ms 超のVAD無音があればそこで分割する

    VADと重ならないsegment (発話が検出されなかった区間) は変更しない。
    """
    if not speech_segs or not keep_segments:
        return keep_segments

    segs_sorted = sorted(speech_segs, key=lambda s: s["start_ms"])
    result = []

    for seg in keep_segments:
        speech_intervals = _clip_speech_to_range(segs_sorted, seg["start_ms"], seg["end_ms"])
        if not speech_intervals:
            result.append(seg)
            continue

        trimmed_end = seg["end_ms"]
        last_speech_end = speech_intervals[-1][1]
        if last_speech_end < trimmed_end:
            trimmed_end = min(trimmed_end, last_speech_end + tail_padding_ms)

        ranges = _split_range_by_internal_silence(
            seg["start_ms"], trimmed_end, speech_intervals,
            lead_padding_ms, tail_padding_ms, min_internal_silence_ms,
        )

        if len(ranges) == 1 and ranges[0] == (seg["start_ms"], seg["end_ms"]):
            result.append(seg)
            continue

        for start_ms, end_ms in ranges:
            words_in_range = [
                w for w in remaining_words
                if w["start_ms"] < end_ms and w["end_ms"] > start_ms
            ]
            text = "".join(w["text"] for w in words_in_range)
            result.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": text,
                "scene_id": seg.get("scene_id"),
            })

    return result


def _infer_audio_path(stt_result_path: str) -> str | None:
    """STT成果物パスから step01 の audio.wav を推定する。"""
    run_dir = os.path.dirname(os.path.dirname(os.path.abspath(stt_result_path)))
    audio_path = os.path.join(run_dir, "step01_preprocess", "audio.wav")
    return audio_path if os.path.exists(audio_path) else None


def _load_mono_audio_samples(audio_path: str) -> tuple[np.ndarray, int]:
    """16kHz mono WAV を float32 [-1, 1] として読み込む。"""
    with wave.open(audio_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sample_width == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        samples = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples, sample_rate


def _compute_frame_rms(samples: np.ndarray, frame_size: int) -> np.ndarray:
    """固定長フレームごとの RMS を返す。"""
    if frame_size <= 0 or len(samples) < frame_size:
        return np.array([], dtype=np.float32)
    n_frames = len(samples) // frame_size
    trimmed = samples[: n_frames * frame_size].reshape(n_frames, frame_size)
    return np.sqrt(np.mean(trimmed * trimmed, axis=1)).astype(np.float32)


def _rms_threshold_for_segment(frame_rms: np.ndarray) -> float:
    """セグメント内 RMS から相対的な有音閾値を決める (録音環境差に頑健)。"""
    if frame_rms.size == 0:
        return 1.0
    noise_floor = float(np.percentile(frame_rms, 10))
    peak = float(np.max(frame_rms))
    span = max(peak - noise_floor, 0.0)
    # ノイズフロアからスパンの12%以上を有音とみなす (保守的)
    threshold = noise_floor + span * 0.12
    # ノイズフロアの微小ゆらぎを無視
    threshold = max(threshold, noise_floor * 1.3 + 1e-6)
    # 閾値が高すぎて語尾の弱い発話を切らないよう上限を設ける
    threshold = min(threshold, noise_floor + span * 0.35)
    return threshold


def _find_voiced_frame_range(
    frame_rms: np.ndarray,
    threshold: float,
    min_consecutive: int = 2,
) -> tuple[int | None, int | None]:
    """連続 min_consecutive フレーム以上が閾値超の最初/最後のフレーム index。"""
    if frame_rms.size == 0:
        return None, None

    voiced = frame_rms >= threshold
    first_voiced: int | None = None
    last_voiced: int | None = None
    run = 0
    for idx, is_voiced in enumerate(voiced):
        if is_voiced:
            run += 1
            if run >= min_consecutive:
                if first_voiced is None:
                    first_voiced = idx - min_consecutive + 1
                last_voiced = idx
        else:
            run = 0
    return first_voiced, last_voiced


def _apply_rms_edge_refine(
    keep_segments: list,
    audio_path: str,
    head_pad_ms: int = 80,
    tail_pad_ms: int = 150,
    frame_ms: int = _RMS_FRAME_MS,
) -> tuple[list, int]:
    """改善9-A-1: 振幅エンベロープで keep_segment の先頭/末尾無音を詰める (広げない)。"""
    if not keep_segments or not os.path.exists(audio_path):
        return keep_segments, 0

    samples, sample_rate = _load_mono_audio_samples(audio_path)
    frame_size = max(1, int(sample_rate * frame_ms / 1000))
    refined = 0
    result = []

    for seg in keep_segments:
        seg_start = int(seg["start_ms"])
        seg_end = int(seg["end_ms"])
        if seg_end <= seg_start:
            result.append(seg)
            continue

        start_sample = int(seg_start * sample_rate / 1000)
        end_sample = min(int(seg_end * sample_rate / 1000), len(samples))
        if end_sample <= start_sample:
            result.append(seg)
            continue

        frame_rms = _compute_frame_rms(samples[start_sample:end_sample], frame_size)
        if frame_rms.size == 0:
            result.append(seg)
            continue

        threshold = _rms_threshold_for_segment(frame_rms)
        first_f, last_f = _find_voiced_frame_range(frame_rms, threshold, min_consecutive=2)
        if first_f is None or last_f is None:
            result.append(seg)
            continue

        first_voiced_ms = seg_start + first_f * frame_ms
        last_voiced_ms = seg_start + (last_f + 1) * frame_ms
        new_start = max(seg_start, first_voiced_ms - head_pad_ms)
        new_end = min(seg_end, last_voiced_ms + tail_pad_ms)

        if new_start >= new_end:
            result.append(seg)
            continue

        new_start_i = int(round(new_start))
        new_end_i = int(round(new_end))
        if new_start_i > seg_start or new_end_i < seg_end:
            refined += 1
            updated = seg.copy()
            updated["start_ms"] = new_start_i
            updated["end_ms"] = new_end_i
            result.append(updated)
        else:
            result.append(seg)

    return result, refined


def _clamp_words_to_segment_bounds(words: list, keep_segments: list) -> int:
    """改善9-A-2: セグメント境界を超える word start/end をセグメント内にクランプする。"""
    if not words or not keep_segments:
        return 0

    adjusted = 0
    for seg in keep_segments:
        seg_start = seg["start_ms"]
        seg_end = seg["end_ms"]
        for w in words:
            if w["end_ms"] <= seg_start or w["start_ms"] >= seg_end:
                continue
            changed = False
            if w["start_ms"] < seg_start:
                w["start_ms"] = seg_start
                changed = True
            if w["end_ms"] > seg_end:
                w["end_ms"] = seg_end
                changed = True
            if w["start_ms"] >= w["end_ms"]:
                w["end_ms"] = w["start_ms"] + 1
                changed = True
            if changed:
                adjusted += 1
    return adjusted


def _should_remove_filler(filler: dict, confidence_threshold: float) -> bool:
    """フィラーを除去対象とするか。action=remove は閾値無視、warn_only は除去しない。"""
    action = filler.get("action")
    if action == "warn_only":
        return False
    if action == _FILLER_ACTION_REMOVE:
        return True
    # 後方互換: action 未指定は confidence 閾値
    return filler.get("confidence", 0) >= confidence_threshold


def _is_japanese_char(ch: str) -> bool:
    """日本語文字 (ひらがな・カタカナ・漢字) かどうか。"""
    if not ch:
        return False
    code = ord(ch)
    if 0x3040 <= code <= 0x309F:
        return True
    if 0x30A0 <= code <= 0x30FF or ch in "ー":
        return True
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
        return True
    return False


def _boundary_chars_eligible_for_merge(tail_text: str, head_text: str) -> bool:
    """境界直後/直前が句読点・文末記号でなく、日本語文字を跨ぐ疑いがあるか。"""
    if not tail_text or not head_text:
        return False
    last_ch = tail_text[-1]
    first_ch = head_text[0]
    if first_ch in "、。！？!?…":
        return False
    if last_ch in "。！？!?…":
        return False
    return _is_japanese_char(last_ch) or _is_japanese_char(first_ch)


def _is_boundary_inside_budoux_chunk(text_before: str, text_after: str) -> bool:
    """連結テキストの境界位置が BudouX 意味チャンクの内部にあるか判定する。"""
    if not text_before or not text_after:
        return False
    try:
        from budoux import load_default_japanese_parser
    except ImportError:
        return False

    concat = text_before + text_after
    boundary_pos = len(text_before)
    if boundary_pos <= 0 or boundary_pos >= len(concat):
        return False

    parser = load_default_japanese_parser()
    offset = 0
    for chunk in parser.parse(concat):
        chunk_start = offset
        chunk_end = offset + len(chunk)
        if chunk_start < boundary_pos < chunk_end:
            return True
        offset = chunk_end
    return False


def _make_word_split_flag(seg_a: dict, seg_b: dict, gap_ms: int, context_chars: int = 10) -> dict:
    """隣接セグメント境界の word_split フラグ dict を生成する。"""
    tail_text = str(seg_a.get("text", ""))[-context_chars:]
    head_text = str(seg_b.get("text", ""))[:context_chars]
    return {
        "prev_end_ms": seg_a["end_ms"],
        "next_start_ms": seg_b["start_ms"],
        "tail_text": tail_text,
        "head_text": head_text,
        "gap_ms": gap_ms,
    }


_PARTICLE_COMMA_HEAD_RE = re.compile(r"^[はがをにでとも]、")


def _apply_word_split_merge(
    keep_segments: list,
    remaining_words: list,
    max_gap_ms: int = 1500,
    context_chars: int = 15,
    flag_max_gap_ms: int = 1200,
) -> tuple[list, int, list]:
    """隣接セグメントで BudouX チャンク内部に境界がある場合、ギャップ閾値以内なら結合する。

    結合不可の単語分断は word_split_flags として収集する (改善19-B)。

    フェーズV8-6: フラグ生成にギャップ上限(flag_max_gap_ms)を導入。ギャップが大きいほど
    話者の「意図的な間」の可能性が高く、実データで 1610ms / 2210ms の境界が誤検知だった
    (単語分断ではなく普通の間)。上限超のギャップはフラグを出さない。
    """
    del remaining_words  # 互換のため引数は残す。判定は segment text を使う。
    if len(keep_segments) <= 1:
        return keep_segments, 0, []

    merges = 0
    flags: list = []
    result = [keep_segments[0].copy()]
    for seg_b in keep_segments[1:]:
        seg_a = result[-1]
        gap_ms = seg_b["start_ms"] - seg_a["end_ms"]

        # RMSトリム後は境界文字が segment 時間範囲外の word に紐づくことがあるため、
        # 判定は segment text の末尾/先頭を使う (ElevenLabs 1文字 word と等価)。
        tail_text = str(seg_a.get("text", ""))[-context_chars:]
        head_text = str(seg_b.get("text", ""))[:context_chars]
        head_full = str(seg_b.get("text", ""))

        should_merge = (
            max_gap_ms > 0
            and 0 <= gap_ms <= max_gap_ms
            and tail_text
            and head_text
            and _boundary_chars_eligible_for_merge(tail_text, head_text)
            and _is_boundary_inside_budoux_chunk(tail_text, head_text)
        )
        if should_merge:
            seg_a["end_ms"] = seg_b["end_ms"]
            seg_a["text"] = seg_a.get("text", "") + seg_b.get("text", "")
            merges += 1
        else:
            # 改善19-B: 結合不可の単語分断を flag 化
            # V8-6: flag_max_gap_ms 超のギャップは「意図的な間」とみなしフラグを出さない
            # (下限 gap > max_gap_ms は撤廃: 結合されなかった境界は文字条件だけで判定する)
            if 0 <= gap_ms <= flag_max_gap_ms and tail_text and head_text:
                inside_budoux = (
                    _boundary_chars_eligible_for_merge(tail_text, head_text)
                    and _is_boundary_inside_budoux_chunk(tail_text, head_text)
                )
                particle_comma_head = bool(_PARTICLE_COMMA_HEAD_RE.match(head_full))
                if inside_budoux or particle_comma_head:
                    flags.append(_make_word_split_flag(seg_a, seg_b, gap_ms, context_chars=10))
            result.append(seg_b.copy())

    return result, merges, flags


def _clean_segment_text(text: str) -> str:
    """フィラー除去後のシーン境界泣き別れ (、え|ー 等) を正規化。"""
    if not text:
        return text
    # 句読点直後の孤立長音
    text = re.sub(r"([、，,])[ー—－]+", r"\1", text)
    # 先頭の孤立長音 (読点は保持)
    text = re.sub(r"^[ー—－]+", "", text)
    # 末尾の孤立「え/あ/う」+ 長音
    text = re.sub(r"[、，,]?[えぇエ][ー—－]*$", "", text)
    text = re.sub(r"[、，,]?[あぁア][ー—－]*$", "", text)
    # 連続読点
    text = re.sub(r"、+", "、", text)
    return text.strip()


def main():
    parser = argparse.ArgumentParser(description="Step 7: Cut Proposal")
    parser.add_argument("--stt", required=True, help="STT result JSON path")
    parser.add_argument("--fillers", required=True, help="Fillers JSON path")
    parser.add_argument("--retakes", required=True, help="Retakes JSON path")
    parser.add_argument("--scenes", required=True, help="Scenes JSON path")
    parser.add_argument("--output", required=True, help="Output directory")
    # VADは不要だが互換性のため受け付ける
    parser.add_argument("--vad", help="(unused) VAD result JSON path")
    parser.add_argument("--project", help="Project YAML config (edit.max_gap_ms 等)")
    parser.add_argument(
        "--audio",
        help="Step01 audio.wav path for RMS edge refine (省略時は --stt から推定)",
    )
    args = parser.parse_args()

    cfg = None
    if args.project:
        full = load_project_config(args.project)
        cfg = dict(full.get("edit", {}))
        cfg["_timing"] = full.get("timing", {})
        print(
            "  config: "
            f"max_gap_ms={cfg.get('max_gap_ms')}, "
            f"lead_padding_ms={cfg.get('lead_padding_ms')}, "
            f"tail_padding_ms={cfg.get('tail_padding_ms')}, "
            f"segment_padding_ms(legacy)={cfg.get('segment_padding_ms')}, "
            f"vad_strength={cfg.get('_timing', {}).get('word_vad_clamp_strength', 1.0)}"
        )

    audio_path = args.audio or _infer_audio_path(args.stt)
    run_step(
        args.stt,
        args.fillers,
        args.retakes,
        args.scenes,
        args.output,
        config=cfg,
        vad_result_path=args.vad,
        audio_path=audio_path,
    )


if __name__ == "__main__":
    main()
