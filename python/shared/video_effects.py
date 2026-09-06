"""フェーズW2: シーン映像ギミック(video_effects トラック)の決定的選定。

step08_composition.py が telop_directives のスロット(semantic type 10種)から
映像効果を決定的に選び、composition の timeline.video_effects へ注入する。
LLMは呼ばない(既存typeをそのまま流用し、このモジュールがキャッピング・間隔を管理する)。

効果(remotion/src/lib/videoEffects.ts の描画定義と同期):
- pinch: 画面が少し縮小(scale 0.9)+暗転(brightness 0.6)+周囲は黒+開始時に teen SFX。
  type=harsh(辛辣・毒舌)のスロットから最大3件(highlight_wordsあり優先→尺の長い順)。
  相互に最低30秒間隔。
- zoom: 注視点(focus)中心にゆっくりズームイン(1.0→1.25 をease-out 500ms、区間中維持)。
  type∈{emphasis, punchline, hype} から最大4件。pinchと重ならない・相互20秒間隔・
  OP採用シーン(highlight_cutsに使われた区間)は除外。SFXなし。

フェーズW24 Phase C(ビジネス広告向け・いずれも既定OFF=テーマ設定で明示ONのみ発動):
- dim: 映像を暗くして(黒50%オーバーレイ相当)テロップを際立たせる。
  強調系(emphasis / quote / punchline)のスロットから最大2件・相互45秒間隔(連発しない)。
  先に選ばれた効果と同一カットには入れない。
- face_zoom: 顔box中心に区間全長かけてゆっくり寄る(1.0→1.15)。
  訴求系(cta / hype)のスロットのうち、属するカットに face_box(Phase A の顔検出)が
  あるものだけ最大2件・相互20秒間隔。顔なしカットには自動選定しない
  (手動指定時のみ中央上寄りfocusへフォールバック)。
- slow_push: カット全長かけて画面全体をごくゆっくり寄せ続ける(1.0→1.06)。
  他の効果が入っていない・一定尺以上のカット全部に入れる(単調回避の常用モーション)。

出力スキーマ(start_ms/end_ms はタイムラインms基準=OPオフセット済み):
    {"id": "ve_001", "type": "pinch", "start_ms": int, "end_ms": int,
     "slot_id": str, "params": {"scale": 0.9, "brightness": 0.6}, "sfx": "teen"}
    {"id": "ve_002", "type": "zoom", "start_ms": int, "end_ms": int,
     "slot_id": str, "params": {"scale": 1.25, "focus": {"x": 0.5, "y": 0.35}}}
    {"id": "ve_003", "type": "dim", "start_ms": int, "end_ms": int,
     "slot_id": str, "params": {"opacity": 0.5}}
    {"id": "ve_004", "type": "face_zoom", "start_ms": int, "end_ms": int,
     "slot_id": str, "params": {"scale": 1.15, "focus": {"x": float, "y": float}}}
    {"id": "ve_005", "type": "slow_push", "start_ms": int, "end_ms": int,
     "slot_id": str, "params": {"scale": 1.06}}

focus は画面比率0〜1の注視点。顔検出・手動調整はこの値を書き換えるだけでよく、
描画側(videoEffectStyle)は不変で動く設計。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# pinch(辛辣シーンの引き締め)の選定パラメータ
PINCH_SLOT_TYPE = "harsh"
PINCH_MAX_COUNT = 3
PINCH_MIN_GAP_MS = 30000
PINCH_SCALE = 0.9
PINCH_BRIGHTNESS = 0.6
PINCH_SFX_ID = "teen"

# zoom(強調シーンのズーム)の選定パラメータ
ZOOM_SLOT_TYPES = ("emphasis", "punchline", "hype")
ZOOM_MAX_COUNT = 4
ZOOM_MIN_GAP_MS = 20000
ZOOM_SCALE = 1.25
# 顔が検出できなかったカットの固定注視点(画面中央やや上=人物の顔が来やすい位置)
ZOOM_FOCUS = {"x": 0.5, "y": 0.35}
# フェーズW24 Phase A-3: 顔追従focusのY補正(顔中心よりやや上=目線基準)
FACE_FOCUS_EYE_OFFSET_Y = 0.05

# フェーズW24 Phase C: dim(暗転強調)の選定パラメータ。強調系テロップのカットだけに入れ、
# pinch(30秒)より広い間隔で「連発しない」を保証する(ビジネス広告として上品に)
DIM_SLOT_TYPES = ("emphasis", "quote", "punchline")
DIM_MAX_COUNT = 2
DIM_MIN_GAP_MS = 45000
DIM_OPACITY = 0.5

# フェーズW24 Phase C: face_zoom(顔ズーム)の選定パラメータ。訴求系スロットのうち
# Phase A の face_box があるカットだけが自動選定の対象
FACE_ZOOM_SLOT_TYPES = ("cta", "hype")
FACE_ZOOM_MAX_COUNT = 2
FACE_ZOOM_MIN_GAP_MS = 20000
FACE_ZOOM_SCALE = 1.15
# 手動指定で顔が無いときのフォールバック注視点(中央上寄り)
FACE_ZOOM_FALLBACK_FOCUS = {"x": 0.5, "y": 0.35}

# フェーズW24 Phase C: slow_push(ゆっくり寄り)の選定パラメータ。
# カット全長で 1.0→1.06 の線形プッシュ。短すぎるカットは動きが速く見えるため除外
SLOW_PUSH_SCALE = 1.06
SLOW_PUSH_MIN_CUT_MS = 3000

# 効果として成立する最小尺(pinchの出入り150ms×2・zoomのease 500msが潰れない長さ)
MIN_EFFECT_DURATION_MS = 1000

# シーン検品の手動指定(slots[].video_effect)で受け付ける値
MANUAL_EFFECT_TYPES = ("none", "pinch", "zoom", "dim", "face_zoom", "slow_push")


def sanitize_video_effects_enabled(raw: Any, orientation: Optional[str] = None) -> Dict[str, bool]:
    """ON/OFF設定の正規化。

    - pinch / zoom: 欠落・不正はTrue(既定ON)。明示的な false のみOFF(W2からの互換)。
    - dim / face_zoom / slow_push: 欠落・不正はFalse(既定OFF)。明示的な true のみON
      (フェーズW24 Phase C: 既存run・既存テーマは新エフェクトOFF扱いで従来動作)。
    - フェーズW26: 縦型(orientation="vertical")のみ dim の既定をON。決めゼリフ(明朝)は
      暗転と併用するデザイン(Fable v5検証で「即採用」判断)。明示的な false は尊重する。
    """
    result = {
        "pinch": True,
        "zoom": True,
        "dim": orientation == "vertical",
        "face_zoom": False,
        "slow_push": False,
    }
    if not isinstance(raw, dict):
        return result
    if raw.get("pinch") is False:
        result["pinch"] = False
    if raw.get("zoom") is False:
        result["zoom"] = False
    if raw.get("dim") is False:
        result["dim"] = False
    for key in ("dim", "face_zoom", "slow_push"):
        if raw.get(key) is True:
            result[key] = True
    return result


def load_video_effects_config(
    user_file: Optional[Path | str] = None,
    orientation: Optional[str] = None,
) -> Dict[str, bool]:
    """ユーザーマッピングJSON(telop_type_mapping.effective.json等)の video_effects
    セクションを読む(overlay_title / speaker_colors と同じ --type-mapping 経路)。
    無い・壊れている場合は既定(pinch/zoomとも有効。縦型はdimも有効)。
    """
    if not user_file:
        return sanitize_video_effects_enabled(None, orientation=orientation)
    user_path = Path(user_file)
    if not user_path.exists():
        return sanitize_video_effects_enabled(None, orientation=orientation)
    try:
        data = json.loads(user_path.read_text(encoding="utf-8"))
    except Exception:
        return sanitize_video_effects_enabled(None, orientation=orientation)
    return sanitize_video_effects_enabled(
        data.get("video_effects") if isinstance(data, dict) else None,
        orientation=orientation,
    )


def _map_slot_to_timeline(
    slot: Dict[str, Any],
    segment_timelines: List[Dict[str, Any]],
) -> Optional[Tuple[int, int]]:
    """スロットの元動画絶対ms区間をタイムラインms区間へ写像する。

    区間の中点が属するセグメントを探し(step08のカット対応表と同じ規則)、
    セグメント内へクランプする。どのセグメントにも属さない(カット済み)スロットは None。
    """
    try:
        src_start = int(slot.get("source_start_ms", -1))
        src_end = int(slot.get("source_end_ms", -1))
    except (TypeError, ValueError):
        return None
    if src_end <= src_start:
        return None
    midpoint = (src_start + src_end) / 2
    for seg in segment_timelines:
        seg_start = int(seg["source_start_ms"])
        seg_end = int(seg["source_end_ms"])
        if seg_start <= midpoint < seg_end:
            timeline_start = int(seg["timeline_start_ms"])
            start_ms = timeline_start + max(0, src_start - seg_start)
            end_ms = timeline_start + (min(seg_end, src_end) - seg_start)
            if end_ms <= start_ms:
                return None
            return start_ms, end_ms
    return None


def _intervals_conflict(a: Tuple[int, int], b: Tuple[int, int], min_gap_ms: int) -> bool:
    """2区間が min_gap_ms 未満の間隔(重なり含む)にあるか。"""
    return a[0] < b[1] + min_gap_ms and b[0] < a[1] + min_gap_ms


def _overlaps_any(interval: Tuple[int, int], ranges: List[Tuple[int, int]]) -> bool:
    return any(interval[0] < end and start < interval[1] for start, end in ranges)


def _candidate_sort_key(order: int, slot: Dict[str, Any], interval: Tuple[int, int]) -> Tuple[int, int, int]:
    """優先順位: highlight_wordsあり → 尺が長い → 出現順(決定的)。"""
    highlights = slot.get("highlight_words")
    has_highlight = isinstance(highlights, list) and any(str(w or "").strip() for w in highlights)
    return (0 if has_highlight else 1, -(interval[1] - interval[0]), order)


def _pick_effects(
    candidates: List[Tuple[Tuple[int, int, int], Dict[str, Any], Tuple[int, int]]],
    max_count: int,
    min_gap_ms: int,
    blocked_ranges: List[Tuple[int, int]],
) -> List[Tuple[Dict[str, Any], Tuple[int, int]]]:
    """優先順の貪欲選定(相互間隔と禁止区間を守る)。"""
    candidates = sorted(candidates, key=lambda item: item[0])
    picked: List[Tuple[Dict[str, Any], Tuple[int, int]]] = []
    for _, slot, interval in candidates:
        if len(picked) >= max_count:
            break
        if _overlaps_any(interval, blocked_ranges):
            continue
        if any(_intervals_conflict(interval, existing, min_gap_ms) for _, existing in picked):
            continue
        picked.append((slot, interval))
    return picked


def _normalize_cut_ranges(cuts: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """カット対応表(timeline基準)を正規化する。不正エントリは捨てる。

    要素は {"start_ms": int, "end_ms": int, "face_box": dict|None, "cut_id": str}。
    """
    result: List[Dict[str, Any]] = []
    for cut in cuts or []:
        if not isinstance(cut, dict):
            continue
        try:
            start_ms = int(cut["start_ms"])
            end_ms = int(cut["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if end_ms <= start_ms:
            continue
        face_box = cut.get("face_box")
        result.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "face_box": face_box if isinstance(face_box, dict) else None,
            "cut_id": str(cut.get("id", "") or ""),
        })
    result.sort(key=lambda item: (item["start_ms"], item["end_ms"]))
    return result


def _cut_for_interval(
    interval: Tuple[int, int],
    cut_ranges: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """区間の中点が属するカットを返す(カット対応表が無い・見つからない場合は None)。"""
    midpoint = (interval[0] + interval[1]) / 2
    for cut in cut_ranges:
        if cut["start_ms"] <= midpoint < cut["end_ms"]:
            return cut
    return None


def _expand_to_cut(
    interval: Tuple[int, int],
    cut_ranges: List[Dict[str, Any]],
) -> Tuple[int, int]:
    """区間を属するカットの全長へ広げる(「同一カットに複数エフェクトを重ねない」の判定用)。

    カット対応表が無い・属するカットが見つからない場合は区間そのまま。
    """
    cut = _cut_for_interval(interval, cut_ranges)
    return (cut["start_ms"], cut["end_ms"]) if cut else interval


def select_video_effects(
    slots: List[Dict[str, Any]],
    segment_timelines: List[Dict[str, Any]],
    op_clip_source_ranges: Optional[List[Tuple[int, int]]] = None,
    enabled: Optional[Dict[str, bool]] = None,
    cuts: Optional[List[Dict[str, Any]]] = None,
    dim_priority: bool = False,
) -> List[Dict[str, Any]]:
    """slotsから映像効果を決定的に選定する(純関数)。

    Args:
        slots: telop_directives.json のスロット
            (slot_id / type / source_start_ms / source_end_ms / highlight_words を読む)
        segment_timelines: カット対応表
            [{"source_start_ms","source_end_ms","timeline_start_ms"}](時系列順)。
            timeline_start_ms はOPオフセット適用済みの値を渡す
        op_clip_source_ranges: OP(highlight_teaser)に採用されたクリップの
            元動画絶対ms区間 [(start, end), ...]。zoomはこの区間のスロットを除外する
            (OPで見せたシーンを本編でまたズームすると装飾過多になるため)
        enabled: sanitize_video_effects_enabled の形。OFFは自動選定だけに適用し、
            slots[].video_effect の明示手動指定は常に尊重する
        cuts: フェーズW24 Phase C: カット対応表(timeline基準)
            [{"start_ms","end_ms","face_box","id"}]。face_zoom(顔があるカット限定)と
            slow_push(カット全長)、および「同一カットに複数エフェクトを重ねない」判定に
            使う。省略時(旧呼び出し)は face_zoom / slow_push を自動選定しない
        dim_priority: フェーズW26: Trueならdimをzoomより先に選定する(縦型ショート用)。
            emphasis等はzoom候補でもあるため、既定順(zoom先行)だと決めゼリフのカットが
            zoomに占有されてdimが1本も入らない。縦型は「決めゼリフ=暗転+明朝」が
            デザインの核なのでdimを優先する。横型は従来順のまま(後方互換)

    Returns:
        timeline.video_effects に入るリスト(start_ms昇順・id=ve_001から連番)。
        候補ゼロなら空リスト(呼び出し側はキー自体を書かない=後方互換)。
    """
    effect_flags = sanitize_video_effects_enabled(enabled)
    op_ranges = [
        (int(start), int(end))
        for start, end in (op_clip_source_ranges or [])
        if int(end) > int(start)
    ]
    cut_ranges = _normalize_cut_ranges(cuts)

    Candidate = Tuple[Tuple[int, int, int], Dict[str, Any], Tuple[int, int]]
    manual_effects: List[Tuple[Dict[str, Any], Tuple[int, int], str]] = []
    pinch_candidates: List[Candidate] = []
    zoom_candidates: List[Candidate] = []
    dim_candidates: List[Candidate] = []
    face_zoom_candidates: List[Candidate] = []
    for order, slot in enumerate(slots or []):
        if not isinstance(slot, dict):
            continue
        override = slot.get("video_effect")
        if override in MANUAL_EFFECT_TYPES:
            # none は「自動候補からも確実に除外」の明示指定。
            if override == "none":
                continue
            interval = _map_slot_to_timeline(slot, segment_timelines)
            # 手動指定は自動の最小尺・件数上限・間隔・全体ON/OFF・OP除外より優先する。
            if interval is not None:
                # slow_push はカット全長の効果なので、属するカットの全長へ広げる
                if override == "slow_push":
                    interval = _expand_to_cut(interval, cut_ranges)
                manual_effects.append((slot, interval, override))
            continue
        slot_type = str(slot.get("type", ""))
        is_pinch = slot_type == PINCH_SLOT_TYPE
        is_zoom = slot_type in ZOOM_SLOT_TYPES
        is_dim = slot_type in DIM_SLOT_TYPES
        is_face_zoom = slot_type in FACE_ZOOM_SLOT_TYPES
        if not (is_pinch or is_zoom or is_dim or is_face_zoom):
            continue
        interval = _map_slot_to_timeline(slot, segment_timelines)
        if interval is None or interval[1] - interval[0] < MIN_EFFECT_DURATION_MS:
            continue
        entry = (_candidate_sort_key(order, slot, interval), slot, interval)
        if is_pinch and effect_flags["pinch"]:
            pinch_candidates.append(entry)
        if is_zoom and effect_flags["zoom"] and not is_pinch:
            # zoom: OP採用シーン(元動画絶対ms区間)と重なるスロットは除外する
            try:
                src_start = int(slot.get("source_start_ms", 0))
                src_end = int(slot.get("source_end_ms", 0))
            except (TypeError, ValueError):
                continue
            if not _overlaps_any((src_start, src_end), op_ranges):
                zoom_candidates.append(entry)
        if is_dim and effect_flags["dim"] and not is_pinch:
            dim_candidates.append(entry)
        if is_face_zoom and effect_flags["face_zoom"] and not is_pinch:
            # face_zoom: 属するカットに顔box(Phase A)があるスロットだけが候補
            cut = _cut_for_interval(interval, cut_ranges)
            if cut and face_zoom_focus(cut["face_box"]) is not None:
                face_zoom_candidates.append(entry)

    manual_intervals = [interval for _, interval, _ in manual_effects]
    # 自動候補は手動指定区間と重複させない。手動同士はユーザー指定を優先して変更しない。
    picked_pinch = _pick_effects(
        pinch_candidates, PINCH_MAX_COUNT, PINCH_MIN_GAP_MS, manual_intervals,
    )
    pinch_intervals = [interval for _, interval in picked_pinch]
    # フェーズW24 Phase C: 新エフェクトは「同一カットに複数エフェクトを重ねない」ため、
    # 既に選ばれた区間を属するカット全長へ広げて禁止区間にする(カット対応表が無い場合は
    # 区間そのままの重複判定=従来と同じ強度)。
    def _cut_blocked(intervals: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
        return [_expand_to_cut(interval, cut_ranges) for interval in intervals]

    if dim_priority:
        # W26(縦型): dim(決めゼリフ暗転)を先に確保し、zoomはdimのカットを避ける
        picked_dim = _pick_effects(
            dim_candidates,
            DIM_MAX_COUNT,
            DIM_MIN_GAP_MS,
            _cut_blocked(manual_intervals + pinch_intervals),
        )
        dim_intervals = [interval for _, interval in picked_dim]
        picked_zoom = _pick_effects(
            zoom_candidates,
            ZOOM_MAX_COUNT,
            ZOOM_MIN_GAP_MS,
            manual_intervals + pinch_intervals + _cut_blocked(dim_intervals),
        )
        zoom_intervals = [interval for _, interval in picked_zoom]
    else:
        # zoom は pinch と時間的に重ならない(間隔規則は zoom 同士のみ)
        picked_zoom = _pick_effects(
            zoom_candidates,
            ZOOM_MAX_COUNT,
            ZOOM_MIN_GAP_MS,
            manual_intervals + pinch_intervals,
        )
        zoom_intervals = [interval for _, interval in picked_zoom]
        picked_dim = _pick_effects(
            dim_candidates,
            DIM_MAX_COUNT,
            DIM_MIN_GAP_MS,
            _cut_blocked(manual_intervals + pinch_intervals + zoom_intervals),
        )
        dim_intervals = [interval for _, interval in picked_dim]
    picked_face_zoom = _pick_effects(
        face_zoom_candidates,
        FACE_ZOOM_MAX_COUNT,
        FACE_ZOOM_MIN_GAP_MS,
        _cut_blocked(manual_intervals + pinch_intervals + zoom_intervals + dim_intervals),
    )
    face_zoom_intervals = [interval for _, interval in picked_face_zoom]

    # slow_push: 他の効果が入っていない・一定尺以上のカット全長に入れる(常用モーション)
    slow_push_picks: List[Tuple[Dict[str, Any], Tuple[int, int]]] = []
    if effect_flags["slow_push"]:
        occupied = (
            manual_intervals + pinch_intervals + zoom_intervals
            + dim_intervals + face_zoom_intervals
        )
        for cut in cut_ranges:
            cut_interval = (cut["start_ms"], cut["end_ms"])
            if cut_interval[1] - cut_interval[0] < SLOW_PUSH_MIN_CUT_MS:
                continue
            if _overlaps_any(cut_interval, occupied):
                continue
            slow_push_picks.append(({"slot_id": cut["cut_id"]}, cut_interval))

    entries: List[Tuple[Tuple[int, int], str, Dict[str, Any]]] = []
    for slot, interval, effect_type in manual_effects:
        entries.append((interval, effect_type, slot))
    for slot, interval in picked_pinch:
        entries.append((interval, "pinch", slot))
    for slot, interval in picked_zoom:
        entries.append((interval, "zoom", slot))
    for slot, interval in picked_dim:
        entries.append((interval, "dim", slot))
    for slot, interval in picked_face_zoom:
        entries.append((interval, "face_zoom", slot))
    for slot, interval in slow_push_picks:
        entries.append((interval, "slow_push", slot))
    entries.sort(key=lambda item: item[0])

    effects: List[Dict[str, Any]] = []
    for index, (interval, effect_type, slot) in enumerate(entries):
        effect: Dict[str, Any] = {
            "id": f"ve_{index + 1:03d}",
            "type": effect_type,
            "start_ms": interval[0],
            "end_ms": interval[1],
            "slot_id": str(slot.get("slot_id", "") or ""),
        }
        if effect_type == "pinch":
            effect["params"] = {"scale": PINCH_SCALE, "brightness": PINCH_BRIGHTNESS}
            effect["sfx"] = PINCH_SFX_ID
        elif effect_type == "zoom":
            effect["params"] = {"scale": ZOOM_SCALE, "focus": dict(ZOOM_FOCUS)}
        elif effect_type == "dim":
            effect["params"] = {"opacity": DIM_OPACITY}
        elif effect_type == "face_zoom":
            # 属するカットの顔中心(目線基準)。顔なし(手動指定)は中央上寄りへフォールバック
            cut = _cut_for_interval(interval, cut_ranges)
            focus = face_zoom_focus(cut["face_box"]) if cut else None
            effect["params"] = {
                "scale": FACE_ZOOM_SCALE,
                "focus": focus if focus is not None else dict(FACE_ZOOM_FALLBACK_FOCUS),
            }
        else:  # slow_push
            effect["params"] = {"scale": SLOW_PUSH_SCALE}
        effects.append(effect)
    return effects


def face_zoom_focus(face_box: Dict[str, Any]) -> Optional[Dict[str, float]]:
    """フェーズW24 Phase A-3: 顔boxからzoomの注視点を求める(顔中心のやや上=目線基準)。

    face_box は正規化 {x,y,w,h}(face_detect.py の検出結果)。不正なら None。
    """
    if not isinstance(face_box, dict):
        return None
    try:
        cx = float(face_box["x"]) + float(face_box["w"]) / 2
        cy = float(face_box["y"]) + float(face_box["h"]) / 2 - FACE_FOCUS_EYE_OFFSET_Y
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "x": round(max(0.0, min(1.0, cx)), 4),
        "y": round(max(0.0, min(1.0, cy)), 4),
    }


def apply_face_focus(
    effects: List[Dict[str, Any]],
    cut_face_ranges: List[Dict[str, Any]],
) -> int:
    """フェーズW24 Phase A-3: zoom効果のfocusを顔中心へ差し替える(effectsを直接書き換える)。

    Args:
        effects: select_video_effects の戻り値(start_ms/end_ms はタイムラインms基準)
        cut_face_ranges: カット対応表 [{"start_ms","end_ms","face_box"}]
            (timeline基準。face_box は正規化boxまたはNone)

    Returns:
        差し替えた効果の件数。効果の中点が属するカットに顔boxが無ければ従来の固定focusのまま
        (描画側 videoEffectStyle はfocus値を読むだけなので互換)。
    """
    replaced = 0
    for effect in effects:
        if effect.get("type") != "zoom":
            continue
        try:
            midpoint = (int(effect["start_ms"]) + int(effect["end_ms"])) / 2
        except (KeyError, TypeError, ValueError):
            continue
        for cut_range in cut_face_ranges:
            try:
                start_ms = int(cut_range["start_ms"])
                end_ms = int(cut_range["end_ms"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (start_ms <= midpoint < end_ms):
                continue
            focus = face_zoom_focus(cut_range.get("face_box"))
            if focus is not None:
                effect.setdefault("params", {})["focus"] = focus
                replaced += 1
            break
    return replaced
