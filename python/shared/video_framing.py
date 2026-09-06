"""フェーズW9: 映像フレーミング(変形・クロップ)。

UI(desktop)が runs/<run>/video_framing.json に全カット共通のグローバル設定を保存し、
step08 がそれを composition.json の timeline.video_framing へ転写する(shared/images.py と同型)。

video_framing.json の形式:
    {"version": 1,
     "transform": {"scale": 1.0, "x": 0.0, "y": 0.0},
     "crop": {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}}

- crop: ソース映像の各辺から切り落とす割合(各辺0〜0.45)。クロップ後の領域=「有効映像」。
- 基準配置は「有効映像をキャンバスへ cover フィットし中央配置」(全て既定値なら従来のcoverと同一)。
- transform.scale は cover フィット寸法への倍率(0.2〜4.0)、x/y は中心オフセット
  (キャンバス幅/高さ比、-1〜1)。
- ファイルなし・壊れたJSON・identity(全て既定値)の場合は timeline.video_framing を
  書かない=既存compositionと同形(完全後方互換)。

正規化規則は remotion/src/lib/videoFraming.ts(normalizeVideoFraming)と同一に保つこと。
"""

import json
import os

CROP_MAX = 0.45
SCALE_MIN = 0.2
SCALE_MAX = 4.0
OFFSET_MAX = 1.0

# 既定値との一致判定に使う許容誤差(ts側 FRAMING_IDENTITY_EPSILON と同値)
IDENTITY_EPSILON = 1e-6

IDENTITY_FRAMING = {
    "transform": {"scale": 1.0, "x": 0.0, "y": 0.0},
    "crop": {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0},
}


def _clamped_float(container, key, low, high, default):
    if not isinstance(container, dict):
        return default
    try:
        value = float(container.get(key))
    except (TypeError, ValueError):
        return default
    if value != value or value in (float("inf"), float("-inf")):  # NaN/inf ガード
        return default
    return max(low, min(high, value))


def normalize_video_framing(raw):
    """video_framing.json(未検証データ)を正規化する(ts normalizeVideoFraming と同一規則)。

    不正・欠損フィールドは既定値(identity)で補完し、数値は許容範囲へクランプする。
    """
    entry = raw if isinstance(raw, dict) else {}
    transform = entry.get("transform")
    crop = entry.get("crop")
    return {
        "transform": {
            "scale": _clamped_float(transform, "scale", SCALE_MIN, SCALE_MAX, 1.0),
            "x": _clamped_float(transform, "x", -OFFSET_MAX, OFFSET_MAX, 0.0),
            "y": _clamped_float(transform, "y", -OFFSET_MAX, OFFSET_MAX, 0.0),
        },
        "crop": {
            "left": _clamped_float(crop, "left", 0.0, CROP_MAX, 0.0),
            "top": _clamped_float(crop, "top", 0.0, CROP_MAX, 0.0),
            "right": _clamped_float(crop, "right", 0.0, CROP_MAX, 0.0),
            "bottom": _clamped_float(crop, "bottom", 0.0, CROP_MAX, 0.0),
        },
    }


def is_identity_framing(framing):
    """既定値(identity)かどうか。identityなら composition にキーを出さない=後方互換。"""
    transform = framing.get("transform", {})
    crop = framing.get("crop", {})
    checks = (
        (transform.get("scale", 1.0), 1.0),
        (transform.get("x", 0.0), 0.0),
        (transform.get("y", 0.0), 0.0),
        (crop.get("left", 0.0), 0.0),
        (crop.get("top", 0.0), 0.0),
        (crop.get("right", 0.0), 0.0),
        (crop.get("bottom", 0.0), 0.0),
    )
    return all(abs(value - target) < IDENTITY_EPSILON for value, target in checks)


def load_video_framing(run_dir):
    """runs/<run>/video_framing.json を読み、timeline.video_framing 形式の設定を返す。

    ファイルなし・壊れたJSON・identity は None(呼び出し側はキー自体を書かない)。
    """
    path = os.path.join(run_dir, "video_framing.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    framing = normalize_video_framing(raw)
    if is_identity_framing(framing):
        return None
    return framing
