"""フェーズW9(映像フレーミング): shared/video_framing.py と step08 の転写テスト。

1. normalize_video_framing: ts(videoFraming.ts)と同一の正規化規則(クランプ・既定値補完)
2. is_identity_framing / load_video_framing: identity・欠損・壊れたJSONはNone
3. step08: video_framing.json があれば timeline.video_framing へ転写、無ければキー自体を出さない
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
from shared.video_framing import (
    IDENTITY_FRAMING,
    is_identity_framing,
    load_video_framing,
    normalize_video_framing,
)


def make_words(entries):
    return [
        {"text": text, "start_ms": start, "end_ms": end}
        for text, start, end in entries
    ]


class NormalizeVideoFramingTests(unittest.TestCase):
    def test_missing_or_invalid_returns_identity(self):
        for raw in (None, "bad", 5, [], {}, {"transform": "x", "crop": 3}):
            self.assertEqual(normalize_video_framing(raw), IDENTITY_FRAMING)

    def test_clamps_to_allowed_ranges(self):
        framing = normalize_video_framing({
            "transform": {"scale": 99, "x": -5, "y": "0.25"},
            "crop": {"left": 0.9, "top": -1, "right": 0.1},
        })
        self.assertEqual(framing["transform"]["scale"], 4.0)
        self.assertEqual(framing["transform"]["x"], -1.0)
        self.assertEqual(framing["transform"]["y"], 0.25)
        self.assertEqual(framing["crop"]["left"], 0.45)
        self.assertEqual(framing["crop"]["top"], 0.0)
        self.assertEqual(framing["crop"]["right"], 0.1)
        self.assertEqual(framing["crop"]["bottom"], 0.0)

    def test_nan_and_non_numeric_fall_back_to_default(self):
        framing = normalize_video_framing({
            "transform": {"scale": float("nan"), "x": float("inf")},
            "crop": {"left": "abc"},
        })
        self.assertEqual(framing["transform"]["scale"], 1.0)
        self.assertEqual(framing["transform"]["x"], 0.0)
        self.assertEqual(framing["crop"]["left"], 0.0)

    def test_scale_lower_bound(self):
        framing = normalize_video_framing({"transform": {"scale": 0}})
        self.assertEqual(framing["transform"]["scale"], 0.2)


class IdentityAndLoadTests(unittest.TestCase):
    def test_is_identity_framing(self):
        self.assertTrue(is_identity_framing(IDENTITY_FRAMING))
        self.assertTrue(is_identity_framing(normalize_video_framing({
            "transform": {"scale": 1 + 1e-9, "x": 0, "y": 0},
        })))
        self.assertFalse(is_identity_framing(normalize_video_framing({
            "transform": {"scale": 1.2},
        })))
        self.assertFalse(is_identity_framing(normalize_video_framing({
            "crop": {"right": 0.3},
        })))

    def test_load_missing_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            self.assertIsNone(load_video_framing(tmp_dir))

    def test_load_broken_json_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            Path(tmp_dir, "video_framing.json").write_text("{broken", encoding="utf-8")
            self.assertIsNone(load_video_framing(tmp_dir))

    def test_load_identity_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            Path(tmp_dir, "video_framing.json").write_text(
                json.dumps({"version": 1, **IDENTITY_FRAMING}), encoding="utf-8"
            )
            self.assertIsNone(load_video_framing(tmp_dir))

    def test_load_non_identity_returns_normalized(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            Path(tmp_dir, "video_framing.json").write_text(
                json.dumps({
                    "version": 1,
                    "transform": {"scale": 1.2, "x": -0.1, "y": 0},
                    "crop": {"right": 0.3},
                }),
                encoding="utf-8",
            )
            framing = load_video_framing(tmp_dir)
            self.assertIsNotNone(framing)
            self.assertEqual(framing["transform"]["scale"], 1.2)
            self.assertEqual(framing["transform"]["x"], -0.1)
            self.assertEqual(framing["crop"]["right"], 0.3)
            # 欠損フィールドは既定値で補完される(完全形)
            self.assertEqual(framing["crop"]["left"], 0.0)


class Step08VideoFramingTransferTests(unittest.TestCase):
    def _run_step08(self, tmp: Path, framing_json=None, run_name="run"):
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
        run_dir = tmp / run_name
        output_dir = run_dir / "step08_composition"
        output_dir.mkdir(parents=True)
        (run_dir / "cut_proposal.json").write_text(
            json.dumps(proposal, ensure_ascii=False), encoding="utf-8"
        )
        (run_dir / "stt_corrected.json").write_text(
            json.dumps(stt, ensure_ascii=False), encoding="utf-8"
        )
        if framing_json is not None:
            (run_dir / "video_framing.json").write_text(
                json.dumps(framing_json, ensure_ascii=False), encoding="utf-8"
            )

        fake_metadata = {"video": {"width": 1920, "height": 1080, "rotation": 0}}
        with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                mock.patch.object(step08_composition, "_extract_segments"):
            return step08_composition.run_step(
                str(run_dir / "cut_proposal.json"),
                str(run_dir / "stt_corrected.json"),
                str(tmp / "dummy.mp4"),
                str(output_dir),
            )

    def test_no_framing_file_omits_key(self):
        """video_framing.json なし=timeline にキー自体を出さない(完全後方互換)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir))
            self.assertNotIn("video_framing", comp["timeline"])

    def test_identity_framing_omits_key(self):
        """identity(全て既定値)もキーを出さない。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), framing_json={"version": 1, **IDENTITY_FRAMING})
            self.assertNotIn("video_framing", comp["timeline"])

    def test_non_identity_framing_is_transferred(self):
        """identity でないフレーミングは正規化済みの完全形で転写される。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(
                Path(tmp_dir),
                framing_json={
                    "version": 1,
                    "transform": {"scale": 1.2, "x": -0.1, "y": 0},
                    "crop": {"right": 0.3},
                },
            )
            framing = comp["timeline"]["video_framing"]
            self.assertEqual(framing["transform"], {"scale": 1.2, "x": -0.1, "y": 0.0})
            self.assertEqual(
                framing["crop"], {"left": 0.0, "top": 0.0, "right": 0.3, "bottom": 0.0}
            )

    def test_framing_does_not_change_other_timeline_keys(self):
        """フレーミングの有無で timeline の他キーが変わらない(転写以外は同一)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            # 同一tmp(=同一dummy.mp4パス)で2つのrunを回し、file_pathの差分を出さない
            comp_without = self._run_step08(Path(tmp_dir), run_name="run_a")
            comp_with = self._run_step08(
                Path(tmp_dir), framing_json={"transform": {"scale": 1.2}}, run_name="run_b"
            )
        timeline_with = dict(comp_with["timeline"])
        timeline_with.pop("video_framing")
        self.assertEqual(comp_without["timeline"], timeline_with)


if __name__ == "__main__":
    unittest.main()
