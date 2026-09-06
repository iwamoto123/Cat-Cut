"""フェーズW8(素材選択時の縦横選択): step08_composition の --orientation 反映テスト。

1. 未指定: 完全従来動作(キャンバス=ソース表示解像度、source_* が meta に追加される)
2. ソース判定と一致する指定: キャンバスは従来どおり(寸法入替なし)
3. 不一致の指定: キャンバス寸法を入替(横1920x1080素材+vertical → 1080x1920)
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import step08_composition


def make_words(entries):
    return [
        {"text": text, "start_ms": start, "end_ms": end}
        for text, start, end in entries
    ]


class Step08OrientationOverrideTests(unittest.TestCase):
    def _run_step08(self, tmp: Path, source_size=(1920, 1080), orientation=None):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3000, "text": "こんにちは今日は良い天気です"},
            ],
            "stats": {"original_duration_ms": 4000, "reduction_ratio": 0.25},
        }
        stt = {
            "words": make_words([
                ("こんにちは", 100, 900),
                ("今日は", 1000, 1600),
                ("良い天気です", 1700, 2800),
            ]),
        }
        run_dir = tmp / "run"
        output_dir = run_dir / "step08_composition"
        output_dir.mkdir(parents=True)
        proposal_path = run_dir / "cut_proposal.json"
        stt_path = run_dir / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")

        width, height = source_size
        fake_metadata = {"video": {"width": width, "height": height, "rotation": 0}}
        with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                mock.patch.object(step08_composition, "_extract_segments"):
            return step08_composition.run_step(
                str(proposal_path),
                str(stt_path),
                str(tmp / "dummy.mp4"),
                str(output_dir),
                orientation=orientation,
            )

    def test_no_orientation_keeps_source_canvas(self):
        """未指定は完全従来動作: キャンバス=ソース表示解像度・orientationは自動判定。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), source_size=(1920, 1080))
            meta = comp["meta"]
            self.assertEqual((meta["display_width"], meta["display_height"]), (1920, 1080))
            self.assertEqual(meta["orientation"], "horizontal")
            # W9のフレーミング計算用に source_* は常に入る
            self.assertEqual((meta["source_width"], meta["source_height"]), (1920, 1080))

    def test_matching_orientation_keeps_source_canvas(self):
        """指定がソース判定と一致する場合はキャンバス寸法を入れ替えない。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), source_size=(1920, 1080), orientation="horizontal")
            meta = comp["meta"]
            self.assertEqual((meta["display_width"], meta["display_height"]), (1920, 1080))
            self.assertEqual(meta["orientation"], "horizontal")
            self.assertEqual((meta["source_width"], meta["source_height"]), (1920, 1080))

    def test_mismatched_orientation_swaps_canvas(self):
        """不一致(横素材+vertical)はキャンバス寸法を入替し、source_* に元寸法を残す。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), source_size=(1920, 1080), orientation="vertical")
            meta = comp["meta"]
            self.assertEqual((meta["display_width"], meta["display_height"]), (1080, 1920))
            self.assertEqual(meta["orientation"], "vertical")
            self.assertEqual((meta["source_width"], meta["source_height"]), (1920, 1080))

    def test_mismatched_orientation_swaps_canvas_vertical_source(self):
        """縦素材+horizontal も同様に入替される(対称ケース)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), source_size=(1080, 1920), orientation="horizontal")
            meta = comp["meta"]
            self.assertEqual((meta["display_width"], meta["display_height"]), (1920, 1080))
            self.assertEqual(meta["orientation"], "horizontal")
            self.assertEqual((meta["source_width"], meta["source_height"]), (1080, 1920))


if __name__ == "__main__":
    unittest.main()
