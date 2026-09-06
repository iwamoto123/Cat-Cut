"""フェーズW24 Phase A: step08の顔回避テロップ配置とzoom focus顔追従の統合テスト。

- orientation=vertical: cuts[].face_box / cuts[].telop_y が書かれる(顔検出はモック)
- 顔検出失敗(例外・全None): 既定0.64で続行しパイプラインは止まらない
- 横型: face_box / telop_y キー自体を書かない(既存compositionと同形=完全後方互換)
- video_effects.face_zoom_focus / apply_face_focus の単体
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
from shared import video_effects
from shared.telop_placement import VERTICAL_DEFAULT_TELOP_Y


def make_words(entries):
    return [
        {"text": text, "start_ms": start, "end_ms": end}
        for text, start, end in entries
    ]


class Step08FacePlacementTests(unittest.TestCase):
    def _run_step08(self, tmp: Path, orientation=None, face_boxes=None, face_side_effect=None):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3000, "text": "こんにちは今日は良い天気です"},
                {"start_ms": 4000, "end_ms": 7000, "text": "続きの話をします"},
            ],
            "stats": {"original_duration_ms": 8000, "reduction_ratio": 0.25},
        }
        stt = {
            "words": make_words([
                ("こんにちは", 100, 900),
                ("今日は", 1000, 1600),
                ("良い天気です", 1700, 2800),
                ("続きの", 4100, 4900),
                ("話をします", 5000, 6500),
            ]),
        }
        run_dir = tmp / "run"
        output_dir = run_dir / "step08_composition"
        output_dir.mkdir(parents=True)
        proposal_path = run_dir / "cut_proposal.json"
        stt_path = run_dir / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")

        fake_metadata = {"video": {"width": 1080, "height": 1920, "rotation": 0}}
        detect_mock = mock.MagicMock()
        if face_side_effect is not None:
            detect_mock.side_effect = face_side_effect
        else:
            detect_mock.return_value = face_boxes if face_boxes is not None else [None, None]
        with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                mock.patch.object(step08_composition, "_extract_segments"), \
                mock.patch.object(step08_composition, "detect_faces_for_ranges_cached", detect_mock):
            comp = step08_composition.run_step(
                str(proposal_path),
                str(stt_path),
                str(tmp / "dummy.mp4"),
                str(output_dir),
                orientation=orientation,
            )
        return comp, detect_mock

    def test_vertical_writes_face_box_and_telop_y(self):
        """縦型: 顔ありカットは顔回避のtelop_y、顔なしカットは既定0.64が書かれる。"""
        face = {"x": 0.3, "y": 0.5, "w": 0.35, "h": 0.3}  # 下寄りの顔 → 上帯0.36
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp, detect = self._run_step08(
                Path(tmp_dir), orientation="vertical", face_boxes=[face, None],
            )
        cuts = comp["timeline"]["cuts"]
        self.assertEqual(cuts[0]["face_box"], face)
        self.assertIsNone(cuts[1]["face_box"])
        self.assertEqual(cuts[0]["telop_y"], 0.36)
        self.assertEqual(cuts[1]["telop_y"], VERTICAL_DEFAULT_TELOP_Y)
        # 検出はkeep_segmentsの元動画絶対ms区間で呼ばれ、キャッシュはstep08出力ディレクトリ直下
        args, kwargs = detect.call_args
        self.assertEqual(args[1], [(0, 3000), (4000, 7000)])
        self.assertTrue(kwargs["cache_path"].endswith(os.path.join("step08_composition", "face_regions.json")))

    def test_vertical_detection_failure_falls_back_to_default(self):
        """顔検出が例外を投げてもrunは完走し、全カット既定0.64になる。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp, _ = self._run_step08(
                Path(tmp_dir), orientation="vertical",
                face_side_effect=RuntimeError("detector crashed"),
            )
        cuts = comp["timeline"]["cuts"]
        for cut in cuts:
            self.assertIsNone(cut["face_box"])
            self.assertEqual(cut["telop_y"], VERTICAL_DEFAULT_TELOP_Y)

    def test_horizontal_writes_no_face_keys(self):
        """横型: 顔検出は呼ばれず、face_box / telop_y キー自体が無い(完全従来動作)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            fake_metadata = {"video": {"width": 1920, "height": 1080, "rotation": 0}}
            proposal = {
                "keep_segments": [{"start_ms": 0, "end_ms": 3000, "text": "こんにちは"}],
                "stats": {},
            }
            stt = {"words": make_words([("こんにちは", 100, 900)])}
            run_dir = tmp / "run"
            output_dir = run_dir / "step08_composition"
            output_dir.mkdir(parents=True)
            (run_dir / "cut_proposal.json").write_text(json.dumps(proposal), encoding="utf-8")
            (run_dir / "stt_corrected.json").write_text(json.dumps(stt), encoding="utf-8")
            with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                    mock.patch.object(step08_composition, "_extract_segments"), \
                    mock.patch.object(step08_composition, "detect_faces_for_ranges_cached") as detect:
                comp = step08_composition.run_step(
                    str(run_dir / "cut_proposal.json"),
                    str(run_dir / "stt_corrected.json"),
                    str(tmp / "dummy.mp4"),
                    str(output_dir),
                )
            detect.assert_not_called()
            for cut in comp["timeline"]["cuts"]:
                self.assertNotIn("face_box", cut)
                self.assertNotIn("telop_y", cut)


class FaceZoomFocusTests(unittest.TestCase):
    def test_face_zoom_focus_targets_eyes(self):
        """focusは顔中心のやや上(目線基準: 中心y-0.05)。"""
        focus = video_effects.face_zoom_focus({"x": 0.3, "y": 0.2, "w": 0.4, "h": 0.3})
        self.assertEqual(focus, {"x": 0.5, "y": 0.3})

    def test_face_zoom_focus_clamped_and_invalid(self):
        focus = video_effects.face_zoom_focus({"x": 0.9, "y": 0.0, "w": 0.4, "h": 0.05})
        self.assertEqual(focus["x"], 1.0)  # はみ出しは0〜1へクランプ
        self.assertIsNone(video_effects.face_zoom_focus(None))
        self.assertIsNone(video_effects.face_zoom_focus({"x": "a"}))

    def test_apply_face_focus_only_zoom_in_face_cuts(self):
        """顔boxのあるカット内のzoomだけfocusが差し替わる。pinch・顔なしカットは不変。"""
        effects = [
            {"id": "ve_001", "type": "pinch", "start_ms": 0, "end_ms": 2000,
             "params": {"scale": 0.9, "brightness": 0.6}},
            {"id": "ve_002", "type": "zoom", "start_ms": 3000, "end_ms": 5000,
             "params": {"scale": 1.25, "focus": {"x": 0.5, "y": 0.35}}},
            {"id": "ve_003", "type": "zoom", "start_ms": 8000, "end_ms": 9000,
             "params": {"scale": 1.25, "focus": {"x": 0.5, "y": 0.35}}},
        ]
        cut_ranges = [
            {"start_ms": 0, "end_ms": 6000, "face_box": {"x": 0.2, "y": 0.1, "w": 0.4, "h": 0.4}},
            {"start_ms": 6000, "end_ms": 10000, "face_box": None},
        ]
        replaced = video_effects.apply_face_focus(effects, cut_ranges)
        self.assertEqual(replaced, 1)
        self.assertEqual(effects[1]["params"]["focus"], {"x": 0.4, "y": 0.25})
        # pinchと顔なしカットのzoomは従来の固定focusのまま
        self.assertNotIn("focus", effects[0]["params"])
        self.assertEqual(effects[2]["params"]["focus"], {"x": 0.5, "y": 0.35})


if __name__ == "__main__":
    unittest.main()
