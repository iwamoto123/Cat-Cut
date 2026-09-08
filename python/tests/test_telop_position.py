import math
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from shared.direction import build_directed_cut_content, select_slots_for_cut
from apply_telop import remap_telops_to_words
import step08_composition


class TelopPositionTests(unittest.TestCase):
    def build(self, position=None):
        slot = {"source_start_ms": 500, "source_end_ms": 2500, "text": "テロップの配置を確認", "style": "fact_yellow"}
        if position is not None:
            slot["telop_position"] = position
        selected = select_slots_for_cut([slot], 0, 3000)
        return build_directed_cut_content("cut_001", selected, [], 3000, 16)

    def test_position_survives_directed_output_and_text_export_remapping(self):
        pages, telops = self.build({"x": 0.3, "y": 0.75})
        self.assertEqual(pages[0]["telop_position"], {"x": 0.3, "y": 0.75})
        self.assertEqual(telops[0]["telop_position"], pages[0]["telop_position"])
        remapped = remap_telops_to_words(pages, [], telops)
        self.assertEqual(remapped[0]["telop_position"], telops[0]["telop_position"])
        self.assertEqual((remapped[0]["start"], remapped[0]["end"]), (0.5, 2.5))

    def test_invalid_position_is_ignored_and_legacy_has_no_override(self):
        for position in [None, {"x": "0.5", "y": 0.5}, {"x": math.nan, "y": 0.5}, {"x": True, "y": 0.5}]:
            pages, telops = self.build(position)
            self.assertNotIn("telop_position", pages[0])
            self.assertNotIn("telop_position", telops[0])

    def test_position_is_clamped_without_changing_source_timing_or_text(self):
        original = self.build()
        pages, telops = self.build({"x": -1, "y": 2})
        self.assertEqual(telops[0].pop("telop_position"), {"x": 0, "y": 1})
        pages[0].pop("telop_position")
        self.assertEqual((pages, telops), original)

    def test_two_directed_captions_follow_speed_without_rewriting_source_anchors(self):
        for speed in (1, 2):
            with self.subTest(speed=speed), tempfile.TemporaryDirectory() as tmp:
                run_dir = Path(tmp)
                output_dir = run_dir / "step08_composition"
                output_dir.mkdir()
                slots = [
                    {"slot_id": "s1", "source_start_ms": 1000, "source_end_ms": 3000, "text": "前半の説明です", "style": "fact_yellow", "telop_position": {"x": 0.25, "y": 0.25}},
                    {"slot_id": "s2", "source_start_ms": 3000, "source_end_ms": 5000, "text": "後半の説明です", "style": "fact_yellow", "telop_position": {"x": 0.75, "y": 0.75}},
                ]
                directives_path = run_dir / "telop_directives.json"
                directives_path.write_text(json.dumps({"mode": "directed", "enabled": True, "edited_by_ui": True, "slots": slots}))
                proposal_path = run_dir / "cut_proposal.json"
                proposal_path.write_text(json.dumps({"keep_segments": [{"start_ms": 1000, "end_ms": 5000, "speed": speed}], "stats": {"original_duration_ms": 6000}}))
                stt_path = run_dir / "stt.json"
                stt_path.write_text(json.dumps({"words": [{"text": s["text"], "start_ms": s["source_start_ms"], "end_ms": s["source_end_ms"]} for s in slots]}))
                with mock.patch.object(step08_composition, "get_video_metadata", return_value={"video": {"width": 1920, "height": 1080, "rotation": 0}}), \
                        mock.patch.object(step08_composition, "_extract_segments"), \
                        mock.patch.object(step08_composition, "build_directed_cut_content", wraps=build_directed_cut_content) as build:
                    comp = step08_composition.run_step(str(proposal_path), str(stt_path), str(run_dir / "synthetic.mp4"), str(output_dir))
                telops = comp["voice_data"]["cuts"][0]["telops"]
                self.assertEqual(len(telops), 2)
                self.assertEqual([(t["start"], t["end"]) for t in telops], [(0, 2 / speed), (2 / speed, 4 / speed)])
                self.assertEqual([t["text"] for t in telops], [s["text"] for s in slots])
                self.assertEqual([t["telop_position"] for t in telops], [s["telop_position"] for s in slots])
                self.assertEqual([(p["start_ms"], p["end_ms"]) for p in comp["timeline"]["cuts"][0]["telop"]["pages"]], [(0, 2000 / speed), (2000 / speed, 4000 / speed)])
                self.assertEqual(comp["voice_data"]["cuts"][0]["voice"]["words"][-1]["end"], 4 / speed)
                passed_slots = build.call_args.args[1]
                self.assertEqual([(s["source_start_ms"], s["source_end_ms"]) for s in passed_slots], [(1000, 3000), (3000, 5000)])
                self.assertEqual(json.loads(directives_path.read_text())["slots"], slots)


if __name__ == "__main__":
    unittest.main()
