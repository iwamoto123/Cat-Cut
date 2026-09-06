"""フェーズU9: BGMトラック(shared/bgm.py)の正規化・読み込みテスト。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.bgm import BGM_DEFAULT_VOLUME, load_bgm_track, normalize_bgm_clips


def _make_bgm_dir(tmp_path, files=("music.mp3",)):
    bgm_dir = tmp_path / "bgm"
    bgm_dir.mkdir()
    for name in files:
        (bgm_dir / name).write_bytes(b"\x00")
    return bgm_dir


# ---------------------------------------------------------------------------
# normalize_bgm_clips
# ---------------------------------------------------------------------------

def test_normalize_rejects_invalid_entries(tmp_path):
    bgm_dir = _make_bgm_dir(tmp_path)
    clips = normalize_bgm_clips(
        [
            None,
            "garbage",
            {"file": "missing.mp3", "start_ms": 0, "end_ms": 5000},  # 実在しない音源
            {"file": "music.mp3", "start_ms": 5000, "end_ms": 5000},  # 区間ゼロ
            {"file": "music.mp3", "start_ms": "x", "end_ms": 5000},  # 数値でない
            {"file": "music.mp3", "start_ms": 0, "end_ms": 5000, "volume": 0.3},
        ],
        str(bgm_dir),
    )
    assert len(clips) == 1
    assert clips[0]["volume"] == 0.3
    assert clips[0]["file"] == str(bgm_dir / "music.mp3")  # 絶対パスへ解決


def test_normalize_defaults_and_clamps(tmp_path):
    bgm_dir = _make_bgm_dir(tmp_path)
    clips = normalize_bgm_clips(
        [{"file": "music.mp3", "start_ms": -100, "end_ms": 1000, "volume": 5,
          "fade_in_ms": 99999, "fade_out_ms": -50}],
        str(bgm_dir),
    )
    clip = clips[0]
    assert clip["start_ms"] == 0  # 負のstartは0へ
    assert clip["volume"] == 1.0  # 0〜1クランプ
    assert clip["fade_in_ms"] == 1000  # クリップ長へ丸め
    assert clip["fade_out_ms"] == 0
    assert clip["id"] == "bgm_1"  # id欠落は連番補完


def test_normalize_volume_missing_uses_default(tmp_path):
    bgm_dir = _make_bgm_dir(tmp_path)
    clips = normalize_bgm_clips([{"file": "music.mp3", "start_ms": 0, "end_ms": 3000}], str(bgm_dir))
    assert clips[0]["volume"] == BGM_DEFAULT_VOLUME
    assert clips[0]["fade_in_ms"] == 0
    assert clips[0]["fade_out_ms"] == 0


def test_normalize_clamps_end_to_total_duration_and_keeps_order(tmp_path):
    # V6-5: 配列順=UIのレーン順の正本のため、start_msでソートせず入力順を保つ
    bgm_dir = _make_bgm_dir(tmp_path, files=("a.mp3", "b.mp3"))
    clips = normalize_bgm_clips(
        [
            {"id": "late", "file": "b.mp3", "start_ms": 8000, "end_ms": 99999},
            {"id": "early", "file": "a.mp3", "start_ms": 0, "end_ms": 5000},
        ],
        str(bgm_dir),
        total_duration_ms=10000,
    )
    assert [c["id"] for c in clips] == ["late", "early"]  # 入力順を保持
    assert clips[0]["end_ms"] == 10000  # タイムライン総尺へクランプ


def test_normalize_accepts_absolute_file_path(tmp_path):
    bgm_dir = _make_bgm_dir(tmp_path)
    abs_path = str(bgm_dir / "music.mp3")
    clips = normalize_bgm_clips([{"file": abs_path, "start_ms": 0, "end_ms": 1000}], str(tmp_path / "other"))
    assert len(clips) == 1
    assert clips[0]["file"] == abs_path


# ---------------------------------------------------------------------------
# load_bgm_track (bgm.json → timeline.bgm)
# ---------------------------------------------------------------------------

def test_load_bgm_track_missing_file_returns_empty(tmp_path):
    # bgm.json なし = timeline.bgm を書かない従来動作(後方互換)
    assert load_bgm_track(str(tmp_path)) == []


def test_load_bgm_track_broken_json_returns_empty(tmp_path):
    bgm_dir = _make_bgm_dir(tmp_path)
    (bgm_dir / "bgm.json").write_text("{{{", encoding="utf-8")
    assert load_bgm_track(str(tmp_path)) == []


def test_load_bgm_track_reads_and_normalizes(tmp_path):
    bgm_dir = _make_bgm_dir(tmp_path)
    (bgm_dir / "bgm.json").write_text(
        json.dumps([
            {"id": "bgm_a", "file": "music.mp3", "start_ms": 0, "end_ms": 60000,
             "volume": 0.15, "fade_in_ms": 1500, "fade_out_ms": 1500},
        ]),
        encoding="utf-8",
    )
    clips = load_bgm_track(str(tmp_path), total_duration_ms=30000)
    assert len(clips) == 1
    assert clips[0]["id"] == "bgm_a"
    assert clips[0]["end_ms"] == 30000  # 総尺クランプ
    assert clips[0]["fade_in_ms"] == 1500
    assert Path(clips[0]["file"]).is_absolute()
