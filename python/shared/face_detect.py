"""フェーズW24 Phase A-1: 顔検出(OpenCV FaceDetectorYN / YuNet)。

step08_composition.py が orientation=vertical のカットごとに代表顔boxを求め、
テロップの顔回避配置(shared/telop_placement.py)と zoom focus の顔追従に使う。

モデル: assets/models/face_detection_yunet_2023mar.onnx (約230KB)
  取得元: https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
  sha256: 8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
  ライセンス: MIT (opencv_zoo)
  取得日: 2026-08-20

設計方針(ベストエフォート厳守):
- opencv未導入・モデル欠落・動画が開けない・検出例外はすべて「警告ログ + None」で
  パイプラインを止めない(旧環境の後方互換)。cv2 のimportは関数内で遅延実行する。
- 各カット区間から3フレーム(区間の20%/50%/80%地点)をサンプリングし、フレームごとに
  面積最大の顔を採り、その座標の中央値を代表boxとする(一瞬の誤検出・顔の出入りに頑健)。
- 戻り値は正規化座標 {"x", "y", "w", "h"}(0〜1、左上基準)または None(顔なし)。
- face_regions.json キャッシュ: 動画の実体(パス+mtime+size)とカット区間をキーに
  検出結果を保存し、同じ区間の再適用では検出をスキップする(適用のたびに重くしない)。
  区間が変わったカットだけを差分検出する。
"""

from __future__ import annotations

import json
import os
import statistics
from typing import Any, Dict, List, Optional, Sequence, Tuple

# 各カット区間内のサンプリング位置(区間長に対する比率)
SAMPLE_POSITION_RATIOS = (0.2, 0.5, 0.8)
# YuNetのスコア閾値(既定0.9は横顔を落としやすいため少し緩める)
SCORE_THRESHOLD = 0.7
# 検出前に縮小する最大辺(px)。4K素材でも検出を軽く保つ(座標は比率なので影響しない)
MAX_DETECT_SIZE = 640

_MODEL_FILE_NAME = "face_detection_yunet_2023mar.onnx"


def default_model_path() -> str:
    """同梱モデルの既定パス(editor/assets/models/)。"""
    editor_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(editor_root, "assets", "models", _MODEL_FILE_NAME)


def _load_cv2():
    """cv2 の遅延import。未導入環境では None(呼び出し側が全カットNoneへフォールバック)。"""
    try:
        import cv2  # noqa: PLC0415

        return cv2
    except Exception:
        return None


def _largest_face_box(faces: Any) -> Optional[Tuple[float, float, float, float]]:
    """FaceDetectorYN.detect の結果から面積最大の顔box(px)を返す。顔なしは None。

    faces は shape (N, 15) のndarray(先頭4列が x, y, w, h)。
    """
    if faces is None or len(faces) == 0:
        return None
    best = None
    best_area = 0.0
    for face in faces:
        x, y, w, h = (float(face[0]), float(face[1]), float(face[2]), float(face[3]))
        area = max(0.0, w) * max(0.0, h)
        if area > best_area:
            best_area = area
            best = (x, y, w, h)
    return best if best_area > 0 else None


def _representative_box(
    boxes: Sequence[Tuple[float, float, float, float]],
    frame_width: float,
    frame_height: float,
) -> Optional[Dict[str, float]]:
    """フレームごとの顔box(px)の中央値を正規化座標 {x,y,w,h}(0〜1)へまとめる。

    サンプルフレームの過半で顔が見つからなくても、1枚でも検出があれば採用する
    (話者が画面に居るカットで手を顔に当てる等の瞬間的な取りこぼしに寛容にする)。
    """
    if not boxes or frame_width <= 0 or frame_height <= 0:
        return None
    x = statistics.median(box[0] for box in boxes)
    y = statistics.median(box[1] for box in boxes)
    w = statistics.median(box[2] for box in boxes)
    h = statistics.median(box[3] for box in boxes)
    if w <= 0 or h <= 0:
        return None

    def _clamp01(value: float) -> float:
        return max(0.0, min(1.0, value))

    nx = _clamp01(x / frame_width)
    ny = _clamp01(y / frame_height)
    return {
        "x": round(nx, 4),
        "y": round(ny, 4),
        "w": round(_clamp01(w / frame_width + nx) - nx, 4),
        "h": round(_clamp01(h / frame_height + ny) - ny, 4),
    }


def detect_faces_for_ranges(
    video_path: str,
    ranges_ms: Sequence[Tuple[int, int]],
    model_path: Optional[str] = None,
) -> List[Optional[Dict[str, float]]]:
    """各カット区間の代表顔boxを検出する(ベストエフォート)。

    Args:
        video_path: 元動画のパス
        ranges_ms: 元動画絶対msのカット区間 [(start_ms, end_ms), ...]
        model_path: YuNetモデルのonnxパス(省略時は同梱既定)

    Returns:
        ranges_ms と同順のリスト。各要素は正規化 {"x","y","w","h"} または None。
        opencv未導入・モデル欠落・動画不読は警告を出して全要素 None。
    """
    results: List[Optional[Dict[str, float]]] = [None] * len(ranges_ms)
    if not ranges_ms:
        return results

    cv2 = _load_cv2()
    if cv2 is None:
        print("  WARNING: face detection skipped (opencv-python not installed)")
        return results

    resolved_model = model_path or default_model_path()
    if not os.path.exists(resolved_model):
        print(f"  WARNING: face detection skipped (model not found: {resolved_model})")
        return results

    capture = None
    try:
        detector = cv2.FaceDetectorYN.create(resolved_model, "", (320, 320), SCORE_THRESHOLD)
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            print(f"  WARNING: face detection skipped (cannot open video: {video_path})")
            return results

        for index, (start_ms, end_ms) in enumerate(ranges_ms):
            try:
                results[index] = _detect_range(cv2, detector, capture, int(start_ms), int(end_ms))
            except Exception as exc:  # ベストエフォート: 区間単位で握りつぶして続行
                print(f"  WARNING: face detection failed for range {start_ms}-{end_ms}ms: {exc}")
                results[index] = None
    except Exception as exc:
        print(f"  WARNING: face detection skipped ({exc})")
        return [None] * len(ranges_ms)
    finally:
        if capture is not None:
            try:
                capture.release()
            except Exception:
                pass
    return results


def _detect_range(cv2, detector, capture, start_ms: int, end_ms: int) -> Optional[Dict[str, float]]:
    """1カット区間の代表顔box。SAMPLE_POSITION_RATIOS 地点のフレームで検出し中央値を取る。"""
    if end_ms <= start_ms:
        return None
    boxes: List[Tuple[float, float, float, float]] = []
    frame_size: Optional[Tuple[int, int]] = None
    for ratio in SAMPLE_POSITION_RATIOS:
        sample_ms = start_ms + (end_ms - start_ms) * ratio
        capture.set(cv2.CAP_PROP_POS_MSEC, float(sample_ms))
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        height, width = frame.shape[:2]
        if width <= 0 or height <= 0:
            continue
        # 検出負荷を抑えるため長辺 MAX_DETECT_SIZE へ縮小(boxは縮小後px→比率化で吸収)
        scale = min(1.0, MAX_DETECT_SIZE / max(width, height))
        if scale < 1.0:
            frame = cv2.resize(frame, (max(1, int(width * scale)), max(1, int(height * scale))))
            height, width = frame.shape[:2]
        frame_size = (width, height)
        detector.setInputSize((width, height))
        _, faces = detector.detect(frame)
        box = _largest_face_box(faces)
        if box is not None:
            boxes.append(box)
    if not boxes or frame_size is None:
        return None
    return _representative_box(boxes, frame_size[0], frame_size[1])


# =============================================================================
# face_regions.json キャッシュ
# =============================================================================

CACHE_VERSION = 1


def _range_key(start_ms: int, end_ms: int) -> str:
    return f"{int(start_ms)}-{int(end_ms)}"


def _video_identity(video_path: str) -> Dict[str, Any]:
    """キャッシュキーになる動画の実体情報。stat失敗(欠落等)は0扱いで続行する。"""
    try:
        stat = os.stat(video_path)
        mtime_ns, size = stat.st_mtime_ns, stat.st_size
    except OSError:
        mtime_ns, size = 0, 0
    return {"path": os.path.abspath(video_path), "mtime_ns": mtime_ns, "size": size}


def _load_cache(cache_path: str, identity: Dict[str, Any]) -> Dict[str, Any]:
    """既存キャッシュを読む。壊れている・動画の実体が変わっている場合は空扱い。"""
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
        return {}
    if data.get("video") != identity:
        return {}
    regions = data.get("regions")
    return regions if isinstance(regions, dict) else {}


def detect_faces_for_ranges_cached(
    video_path: str,
    ranges_ms: Sequence[Tuple[int, int]],
    cache_path: str,
    model_path: Optional[str] = None,
) -> List[Optional[Dict[str, float]]]:
    """face_regions.json キャッシュ付きの detect_faces_for_ranges。

    - 動画の実体(パス+mtime+size)が一致すれば、既知の区間キーは再検出しない
      (「顔なし=None」の結果もキー存在で区別してキャッシュヒットさせる)
    - 区間が変わったカットだけを差分検出し、既存エントリへマージして保存する
      (カットのトリムで動いた区間のみ再検出され、他カットのヒットは維持される)
    - キャッシュの読み書き失敗は検出結果へ影響させない(ベストエフォート)
    """
    identity = _video_identity(video_path)
    regions = _load_cache(cache_path, identity)

    missing = [
        (index, (int(start_ms), int(end_ms)))
        for index, (start_ms, end_ms) in enumerate(ranges_ms)
        if _range_key(start_ms, end_ms) not in regions
    ]
    if missing:
        detected = detect_faces_for_ranges(video_path, [r for _, r in missing], model_path=model_path)
        for (_, (start_ms, end_ms)), box in zip(missing, detected):
            regions[_range_key(start_ms, end_ms)] = box
        try:
            os.makedirs(os.path.dirname(os.path.abspath(cache_path)), exist_ok=True)
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(
                    {"version": CACHE_VERSION, "video": identity, "regions": regions},
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
        except OSError as exc:
            print(f"  WARNING: failed to write face cache {cache_path}: {exc}")
    else:
        print(f"  face detection: cache hit ({len(ranges_ms)} ranges)")

    return [regions.get(_range_key(start_ms, end_ms)) for start_ms, end_ms in ranges_ms]
