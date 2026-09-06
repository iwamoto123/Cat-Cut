"""フェーズW24 Phase A-2: 縦型広告セーフゾーンのテロップ自動配置(顔回避)。

step08_composition.py が orientation=vertical のとき、カットごとの顔box
(shared/face_detect.py の検出結果)からテロップ縦位置 cuts[].telop_y を決める。

このモジュールは remotion/src/lib/adSafeZone.ts のPythonミラー実装。
定数・判定順序・丸めはTS側と完全に同一に保つこと(両言語の同期は
remotion/tests/adSafeZoneCases.json の同一ケース表で pytest / node --test の
双方から検証される。片方を変えたら必ずもう片方とケース表も更新する)。

配置の考え方(Instagram Reels / TikTok のUIセーフゾーン):
- 縦型のテロップ許容帯は 0.30〜0.72(上部ステータス・下部キャプション/CTAを回避)
- 顔なしは「中央少し下」0.64
- 顔ありは顔の下に置けるなら下帯(0.58〜0.72)、顔が下寄りなら上帯(0.30〜0.42)
- テロップブロックの概算高さ(行数×行高)と顔box+マージンが重ならない位置を選ぶ
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional

# --- adSafeZone.ts と同期する定数(単位はすべて画面高さに対する比率0〜1) ---

# 縦型のテロップ許容帯(Instagram/TikTokの上部UI・下部キャプション/CTA/右端アイコン列を避ける)
TELOP_BAND_TOP = 0.30
TELOP_BAND_BOTTOM = 0.72
# 顔なし・既定の「中央少し下」
VERTICAL_DEFAULT_TELOP_Y = 0.64
# 顔回避時の下帯(中央少し下)と上帯(中央少し上)
LOWER_BAND_TOP = 0.58
LOWER_BAND_BOTTOM = 0.72
UPPER_BAND_TOP = 0.30
UPPER_BAND_BOTTOM = 0.42
# 上帯に置くときの既定(中央少し上)
VERTICAL_UPPER_DEFAULT_TELOP_Y = 0.36
# 顔boxとテロップブロックの間に確保するマージン
FACE_TELOP_MARGIN = 0.03
# テロップブロック高さ(比率)の既定値(1080x1920でおよそ2行分)
DEFAULT_BLOCK_HEIGHT_RATIO = 0.08


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _valid_face_box(face_box: Any) -> Optional[Dict[str, float]]:
    """正規化顔box {x,y,w,h} の検証。不正・退化boxは None(顔なし扱い)。"""
    if not isinstance(face_box, dict):
        return None
    try:
        x = float(face_box["x"])
        y = float(face_box["y"])
        w = float(face_box["w"])
        h = float(face_box["h"])
    except (KeyError, TypeError, ValueError):
        return None
    if not all(v == v and abs(v) != float("inf") for v in (x, y, w, h)):  # NaN/inf除外
        return None
    if w <= 0 or h <= 0:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def estimate_block_height_ratio(
    line_count: int,
    font_size: float,
    video_height: float,
    line_height: float = 1.4,
    line_gap_px: float = 8.0,
) -> float:
    """テロップブロックの概算高さ比率(telopLayout.ts clampTelopYPercent と同じ概算式)。"""
    lines = max(1, int(line_count))
    if video_height <= 0:
        return DEFAULT_BLOCK_HEIGHT_RATIO
    block_px = lines * line_height * font_size + max(0, lines - 1) * line_gap_px
    return block_px / video_height


def resolve_cut_telop_y(
    orientation: str,
    base_telop_y: float,
    face_box: Any = None,
    block_height_ratio: float = DEFAULT_BLOCK_HEIGHT_RATIO,
    style_offset: float = 0.0,
) -> float:
    """カット単位のテロップ縦位置(中心基準0〜1)を決める。adSafeZone.ts resolveCutTelopY と同一。

    - vertical以外: 従来どおり base_telop_y を素通しする(横型は完全従来動作)
    - vertical・顔なし: 既定「中央少し下」0.64
    - vertical・顔あり: 顔の下に置けるなら下帯(0.58〜0.72)、置けなければ上帯(0.30〜0.42)。
      どちらにも収まらない(顔が画面をほぼ覆う)場合は顔中心から遠い側の帯の既定値
    - style_offset: 描画側で加算される y_position_offset の打ち消し分(最終位置が帯に入るよう
      先に差し引く)。step08 の自動配置では 0 を渡す
    """
    if orientation != "vertical":
        return base_telop_y

    half = block_height_ratio / 2
    face = _valid_face_box(face_box)
    if face is None:
        target = VERTICAL_DEFAULT_TELOP_Y
    else:
        face_top = _clamp(face["y"], 0.0, 1.0)
        face_bottom = _clamp(face["y"] + face["h"], 0.0, 1.0)
        lower_min = face_bottom + FACE_TELOP_MARGIN + half
        upper_max = face_top - FACE_TELOP_MARGIN - half
        if lower_min <= LOWER_BAND_BOTTOM:
            # 顔の下端+マージンの直下、ただし既定0.64より上へは寄せない
            target = _clamp(max(VERTICAL_DEFAULT_TELOP_Y, lower_min), LOWER_BAND_TOP, LOWER_BAND_BOTTOM)
        elif upper_max >= UPPER_BAND_TOP:
            # 顔が下寄り: 上帯へ。既定0.36が顔に当たるなら顔の上端側へ寄せる
            target = _clamp(min(VERTICAL_UPPER_DEFAULT_TELOP_Y, upper_max), UPPER_BAND_TOP, UPPER_BAND_BOTTOM)
        else:
            # 顔が画面をほぼ覆う: 顔中心から遠い側の帯の既定値へフォールバック
            face_center = (face_top + face_bottom) / 2
            target = VERTICAL_UPPER_DEFAULT_TELOP_Y if face_center >= 0.5 else VERTICAL_DEFAULT_TELOP_Y

    result = _clamp(target - style_offset, TELOP_BAND_TOP, TELOP_BAND_BOTTOM)
    # JSONへ書く値を安定させ、TS/Python間のケース表比較を厳密一致にするため4桁へ丸める
    # (JSの Math.round と同じ half-up。Python組み込みroundは偶数丸めのため使わない)
    return math.floor(result * 10000 + 0.5) / 10000
