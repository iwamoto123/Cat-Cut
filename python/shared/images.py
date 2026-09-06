"""フェーズV4: 画像挿入トラック。

UI(desktop)が runs/<run>/images/images.json に画像クリップ設定を保存し、
step08 がそれを composition.json の timeline.images へ転写する(shared/bgm.py と同型)。

images.json の形式(配列。start/endはタイムラインms基準):
    [{"id", "file", "start_ms", "end_ms", "x", "y", "scale", "opacity"}]

- file は runs/<run>/images/ 内のファイル名(相対)。転写時に絶対パスへ解決する
  (render-cli が bgm/segments と同じ経路でHTTP配信できるようにするため)。
- x/y は画像中心の画面比率(0〜1)、scale は表示幅の画面幅比(0.1〜1.0)、opacity は0〜1。
- images.json が無い・空・全滅の場合は timeline.images を書かない=既存compositionと同形(後方互換)。
- OPがある場合も画像の開始はタイムライン全体基準のまま(OP含む先頭=0起点)なので
  オフセット調整はしない(単純に転写する)。
"""

import json
import os

# 追加時の既定値(desktop/remotion側の既定と同値)。中央上寄り・画面幅55%・不透明。
IMAGE_DEFAULT_X = 0.5
IMAGE_DEFAULT_Y = 0.35
IMAGE_DEFAULT_SCALE = 0.55
IMAGE_DEFAULT_OPACITY = 1.0


def _clamp(value, low, high):
    return max(low, min(high, value))


def _clamped_float(entry, key, low, high, default):
    try:
        return _clamp(float(entry.get(key)), low, high)
    except (TypeError, ValueError):
        return default


def normalize_image_clips(raw, images_dir, total_duration_ms=None):
    """images.json の未検証データを timeline.images 形式のクリップ一覧へ正規化する。

    - file は images_dir からの相対名として絶対パスへ解決し、実在しないファイルは除外
      (画像が消えたクリップで書き出しを失敗させないための防御)
    - 区間ゼロ・数値でない start/end は除外
    - x/y は 0〜1、scale は 0.1〜1.0、opacity は 0〜1 へ丸める
    - total_duration_ms 指定時は end をタイムライン総尺へクランプ
    - V6-5: 配列順=前後関係(UIのレーン順・RemotionのzIndex順)の正本のため、
      start_ms でのソートはせず入力順を保つ
    """
    if not isinstance(raw, list):
        return []
    clips = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        file_name = entry.get("file")
        if not isinstance(file_name, str) or not file_name:
            continue
        # 絶対パスが直接書かれていても受け付ける(手書きimages.json向け)
        file_path = file_name if os.path.isabs(file_name) else os.path.join(images_dir, file_name)
        file_path = os.path.abspath(file_path)
        if not os.path.exists(file_path):
            continue
        try:
            start_ms = int(round(float(entry.get("start_ms"))))
            end_ms = int(round(float(entry.get("end_ms"))))
        except (TypeError, ValueError):
            continue
        start_ms = max(0, start_ms)
        if total_duration_ms is not None:
            end_ms = min(end_ms, int(total_duration_ms))
        if end_ms <= start_ms:
            continue
        clip_id = entry.get("id")
        clips.append({
            "id": clip_id if isinstance(clip_id, str) and clip_id else f"image_{index + 1}",
            "file": file_path,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "x": _clamped_float(entry, "x", 0.0, 1.0, IMAGE_DEFAULT_X),
            "y": _clamped_float(entry, "y", 0.0, 1.0, IMAGE_DEFAULT_Y),
            "scale": _clamped_float(entry, "scale", 0.1, 1.0, IMAGE_DEFAULT_SCALE),
            "opacity": _clamped_float(entry, "opacity", 0.0, 1.0, IMAGE_DEFAULT_OPACITY),
        })
    return clips


def load_images_track(run_dir, total_duration_ms=None):
    """runs/<run>/images/images.json を読み、timeline.images 形式のクリップ一覧を返す。

    ファイルなし・壊れたJSON・有効クリップゼロは [] (呼び出し側はキー自体を書かない)。
    """
    images_dir = os.path.join(run_dir, "images")
    path = os.path.join(images_dir, "images.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return normalize_image_clips(raw, images_dir, total_duration_ms=total_duration_ms)
