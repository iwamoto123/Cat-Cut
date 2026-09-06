"""フェーズW26(ショート動画のシーン切替改善): パンチイン(交互ズーム)の割当。

縦型ショートは同一カメラのジャンプカット連結になりやすく、フレーミングが同じままだと
カット切替が「編集ミス」に見える。カットごとにズーム率を交互に変える(パンチイン)ことで
ジャンプカットを意図した演出に見せる(2026-08-21 Fable手動編集で検証した手法)。

step08_composition.py が縦型のとき cuts[].punch_scale / punch_origin を書き込み、
Remotion / プレビューが remotion/src/lib/punchIn.ts の同一規則でtransformを適用する。
横型・既存runはキー自体を書かない=完全後方互換。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# パンチインの拡大率(Fable手動編集の1.08と同水準。punchIn.ts の MAX_PUNCH_SCALE 以下)
PUNCH_SCALE = 1.07
# 顔が無いカットの既定注視点(中央やや上=バストアップの顔想定)
DEFAULT_ORIGIN = (0.5, 0.42)
# これより短いカットはパンチインの交互パターンから外さない(見た目の一貫性優先で全カット対象)


def punch_scale_for_index(index: int) -> float:
    """カット順序から交互のパンチイン倍率を返す(偶数=等倍、奇数=パンチイン)。

    先頭カットは等倍(フックの映像をそのまま見せる)。以降は交互。
    """
    return PUNCH_SCALE if index % 2 == 1 else 1.0


def punch_origin(face_box: Optional[Dict[str, Any]]) -> Tuple[float, float]:
    """パンチインの注視点(正規化0〜1)。顔boxがあれば顔中心、無ければ中央やや上。"""
    if isinstance(face_box, dict):
        try:
            x = float(face_box["x"])
            y = float(face_box["y"])
            w = float(face_box["w"])
            h = float(face_box["h"])
        except (KeyError, TypeError, ValueError):
            return DEFAULT_ORIGIN
        if w > 0 and h > 0:
            cx = min(1.0, max(0.0, x + w / 2))
            cy = min(1.0, max(0.0, y + h / 2))
            return (cx, cy)
    return DEFAULT_ORIGIN


def assign_punch_in(cuts: List[Dict[str, Any]]) -> int:
    """縦型のcutsへパンチイン(交互ズーム)を書き込む。

    cuts[].face_box(W24 Phase Aで書き込み済み)を注視点に使う。
    等倍カットにはキーを書かない(Remotion側の normalizePunchIn が省略=変形なしと解釈)。

    Returns:
        パンチインを適用したカット数。
    """
    if len(cuts) < 2:
        return 0
    applied = 0
    for index, cut in enumerate(cuts):
        scale = punch_scale_for_index(index)
        if scale <= 1.0:
            continue
        ox, oy = punch_origin(cut.get("face_box"))
        cut["punch_scale"] = scale
        cut["punch_origin"] = {"x": round(ox, 4), "y": round(oy, 4)}
        applied += 1
    return applied
