"""フェーズV4: 画像挿入トラック(shared/images.py)の正規化・読み込みテスト。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.images import (
    IMAGE_DEFAULT_OPACITY,
    IMAGE_DEFAULT_SCALE,
    IMAGE_DEFAULT_X,
    IMAGE_DEFAULT_Y,
    load_images_track,
    normalize_image_clips,
)


def _make_images_dir(tmp_path, files=("shot.png",)):
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    for name in files:
        (images_dir / name).write_bytes(b"\x00")
    return images_dir


# ---------------------------------------------------------------------------
# normalize_image_clips
# ---------------------------------------------------------------------------

def test_normalize_rejects_invalid_entries(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    clips = normalize_image_clips(
        [
            None,
            "garbage",
            {"file": "missing.png", "start_ms": 0, "end_ms": 4000},  # 実在しない画像
            {"file": "shot.png", "start_ms": 4000, "end_ms": 4000},  # 区間ゼロ
            {"file": "shot.png", "start_ms": "x", "end_ms": 4000},  # 数値でない
            {"file": "shot.png", "start_ms": 0, "end_ms": 4000, "x": 0.2, "y": 0.8, "scale": 0.4},
        ],
        str(images_dir),
    )
    assert len(clips) == 1
    assert clips[0]["x"] == 0.2
    assert clips[0]["y"] == 0.8
    assert clips[0]["scale"] == 0.4
    assert clips[0]["file"] == str(images_dir / "shot.png")  # 絶対パスへ解決


def test_normalize_defaults_and_clamps(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    clips = normalize_image_clips(
        [{"file": "shot.png", "start_ms": -100, "end_ms": 1000,
          "x": 5, "y": -1, "scale": 3, "opacity": 9}],
        str(images_dir),
    )
    clip = clips[0]
    assert clip["start_ms"] == 0  # 負のstartは0へ
    assert clip["x"] == 1.0  # 0〜1クランプ
    assert clip["y"] == 0.0
    assert clip["scale"] == 1.0  # 0.1〜1.0クランプ
    assert clip["opacity"] == 1.0
    assert clip["id"] == "image_1"  # id欠落は連番補完


def test_normalize_missing_placement_uses_defaults(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    clips = normalize_image_clips([{"file": "shot.png", "start_ms": 0, "end_ms": 3000}], str(images_dir))
    clip = clips[0]
    assert clip["x"] == IMAGE_DEFAULT_X
    assert clip["y"] == IMAGE_DEFAULT_Y
    assert clip["scale"] == IMAGE_DEFAULT_SCALE
    assert clip["opacity"] == IMAGE_DEFAULT_OPACITY


def test_normalize_scale_lower_clamp(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    clips = normalize_image_clips(
        [{"file": "shot.png", "start_ms": 0, "end_ms": 3000, "scale": 0.01}],
        str(images_dir),
    )
    assert clips[0]["scale"] == 0.1


def test_normalize_clamps_end_to_total_duration_and_keeps_order(tmp_path):
    # V6-5: 配列順=前後関係(レーン順)の正本のため、start_msでソートせず入力順を保つ
    images_dir = _make_images_dir(tmp_path, files=("a.png", "b.jpg"))
    clips = normalize_image_clips(
        [
            {"id": "late", "file": "b.jpg", "start_ms": 8000, "end_ms": 99999},
            {"id": "early", "file": "a.png", "start_ms": 0, "end_ms": 5000},
        ],
        str(images_dir),
        total_duration_ms=10000,
    )
    assert [c["id"] for c in clips] == ["late", "early"]  # 入力順を保持
    assert clips[0]["end_ms"] == 10000  # タイムライン総尺へクランプ


def test_normalize_accepts_absolute_file_path(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    abs_path = str(images_dir / "shot.png")
    clips = normalize_image_clips([{"file": abs_path, "start_ms": 0, "end_ms": 1000}], str(tmp_path / "other"))
    assert len(clips) == 1
    assert clips[0]["file"] == abs_path


# ---------------------------------------------------------------------------
# load_images_track (images.json → timeline.images)
# ---------------------------------------------------------------------------

def test_load_images_track_missing_file_returns_empty(tmp_path):
    # images.json なし = timeline.images を書かない従来動作(後方互換)
    assert load_images_track(str(tmp_path)) == []


def test_load_images_track_broken_json_returns_empty(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    (images_dir / "images.json").write_text("{{{", encoding="utf-8")
    assert load_images_track(str(tmp_path)) == []


def test_load_images_track_reads_and_normalizes(tmp_path):
    images_dir = _make_images_dir(tmp_path)
    (images_dir / "images.json").write_text(
        json.dumps([
            {"id": "img_a", "file": "shot.png", "start_ms": 2000, "end_ms": 60000,
             "x": 0.5, "y": 0.35, "scale": 0.55, "opacity": 1},
        ]),
        encoding="utf-8",
    )
    clips = load_images_track(str(tmp_path), total_duration_ms=30000)
    assert len(clips) == 1
    assert clips[0]["id"] == "img_a"
    assert clips[0]["end_ms"] == 30000  # 総尺クランプ
    assert clips[0]["scale"] == 0.55
    assert Path(clips[0]["file"]).is_absolute()
