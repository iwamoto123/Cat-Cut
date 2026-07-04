"""改善8-A-6: キャプチャハーネス (capture_telop_frames.py) のタイムライン変換テスト。

ffmpeg/Pillow を使う実際のフレーム抽出・画像合成はここでは対象外とし、
「カット内相対時刻 -> 書き出し後タイムライン絶対時刻」への変換ロジック
(collect_pages) を純粋関数として検証する。

composition.json の実際の構造 (voice_data.cuts[].telops[]) は start/end
(時刻)を直接持たず、word_indices (voice.words への添字) だけを持つため、
対象wordのstart/endから区間を逆算する必要がある。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from capture_telop_frames import collect_pages


def _composition(cuts_timeline: list[dict], voice_cuts: list[dict]) -> dict:
    return {
        "timeline": {"cuts": cuts_timeline},
        "voice_data": {"cuts": voice_cuts},
    }


class CollectPagesTests(unittest.TestCase):
    def test_center_ms_uses_cut_timeline_offset_not_source_video_time(self):
        # cut_001は書き出し後タイムラインで2000msから開始 (元動画上の位置とは無関係)
        comp = _composition(
            cuts_timeline=[
                {"cut_id": "cut_001", "timeline": {"start_ms": 2000, "end_ms": 5000}},
            ],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": [{"text": "テ", "start": 0.5, "end": 1.0}, {"text": "スト", "start": 1.0, "end": 1.5}]},
                    "telops": [
                        {"id": "cut_001_p00", "text": "テスト", "word_indices": [0, 1]},
                    ],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(len(pages), 1)
        # rel_start=0.5*1000=500, rel_end=1.5*1000=1500 -> abs start=2500, end=3500, center=3000
        self.assertEqual(pages[0]["start_ms"], 2500)
        self.assertEqual(pages[0]["end_ms"], 3500)
        self.assertEqual(pages[0]["center_ms"], 3000)
        self.assertEqual(pages[0]["text"], "テスト")

    def test_multiple_cuts_are_offset_independently_and_sorted(self):
        comp = _composition(
            cuts_timeline=[
                {"cut_id": "cut_001", "timeline": {"start_ms": 0, "end_ms": 2000}},
                {"cut_id": "cut_002", "timeline": {"start_ms": 2000, "end_ms": 4000}},
            ],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": [{"text": "A", "start": 0.0, "end": 1.0}]},
                    "telops": [{"id": "cut_001_p00", "text": "A", "word_indices": [0]}],
                },
                {
                    "id": "cut_002",
                    "voice": {"words": [{"text": "B", "start": 0.0, "end": 1.0}]},
                    "telops": [{"id": "cut_002_p00", "text": "B", "word_indices": [0]}],
                },
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual([p["page_id"] for p in pages], ["cut_001_p00", "cut_002_p00"])
        self.assertEqual(pages[0]["center_ms"], 500)
        self.assertEqual(pages[1]["center_ms"], 2500)

    def test_pages_with_out_of_range_word_indices_are_skipped(self):
        comp = _composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 0, "end_ms": 2000}}],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": []},
                    "telops": [{"id": "cut_001_p00", "text": "no timing", "word_indices": [0, 1]}],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(pages, [])

    def test_text_falls_back_to_segments_when_text_field_missing(self):
        comp = _composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 0, "end_ms": 2000}}],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": [{"text": "分", "start": 0.0, "end": 0.5}, {"text": "割", "start": 0.5, "end": 1.0}]},
                    "telops": [
                        {
                            "id": "cut_001_p00",
                            "word_indices": [0, 1],
                            "segments": [{"text": "分割"}, {"text": "テキスト"}],
                        }
                    ],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(pages[0]["text"], "分割テキスト")

    def test_timing_is_clamped_within_cut_bounds(self):
        # テロップのword区間がカット境界をわずかに超えているケースの保険
        comp = _composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 1000, "end_ms": 2000}}],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": [{"text": "x", "start": -0.5, "end": 2.0}]},
                    "telops": [{"id": "cut_001_p00", "text": "x", "word_indices": [0]}],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertGreaterEqual(pages[0]["start_ms"], 1000)
        self.assertLessEqual(pages[0]["end_ms"], 2000)

    def test_cut_with_missing_timeline_entry_is_skipped(self):
        comp = _composition(
            cuts_timeline=[],
            voice_cuts=[
                {
                    "id": "cut_999",
                    "voice": {"words": [{"text": "x", "start": 0, "end": 1}]},
                    "telops": [{"id": "cut_999_p00", "text": "x", "word_indices": [0]}],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(pages, [])


if __name__ == "__main__":
    unittest.main()
