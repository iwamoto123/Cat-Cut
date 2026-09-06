import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import step08_composition


class Step08SceneSpeedTests(unittest.TestCase):
    def _run(self, speed=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        run_dir = root / "run"
        output_dir = run_dir / "step08_composition"
        output_dir.mkdir(parents=True)
        segment = {"start_ms": 1000, "end_ms": 5000, "text": "テストです"}
        if speed is not None:
            segment["speed"] = speed
        proposal = {
            "keep_segments": [segment],
            "stats": {"original_duration_ms": 6000, "reduction_ratio": 0},
        }
        stt = {
            "words": [
                {"text": "テスト", "start_ms": 1000, "end_ms": 3000},
                {"text": "です", "start_ms": 3000, "end_ms": 5000},
            ]
        }
        proposal_path = run_dir / "cut_proposal.json"
        stt_path = run_dir / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")
        metadata = {"video": {"width": 1920, "height": 1080, "rotation": 0}}
        with mock.patch.object(step08_composition, "get_video_metadata", return_value=metadata), mock.patch.object(
            step08_composition, "_extract_segments"
        ):
            return step08_composition.run_step(
                str(proposal_path),
                str(stt_path),
                str(root / "dummy.mp4"),
                str(output_dir),
            )

    def test_speed_two_halves_timeline_and_relative_timings(self):
        composition = self._run(speed=2)
        cut = composition["timeline"]["cuts"][0]
        self.assertEqual(cut["timeline"], {"start_ms": 0, "end_ms": 2000})
        self.assertEqual(cut["video"]["speed"], 2.0)
        self.assertEqual(composition["timeline"]["total_duration_ms"], 2000)
        voice = composition["voice_data"]["cuts"][0]["voice"]
        self.assertEqual(voice["duration_ms"], 2000)
        self.assertEqual(voice["words"][-1]["end"], 2.0)

    def test_missing_speed_keeps_legacy_shape_and_duration(self):
        composition = self._run()
        cut = composition["timeline"]["cuts"][0]
        self.assertEqual(cut["timeline"], {"start_ms": 0, "end_ms": 4000})
        self.assertNotIn("speed", cut["video"])


if __name__ == "__main__":
    unittest.main()
