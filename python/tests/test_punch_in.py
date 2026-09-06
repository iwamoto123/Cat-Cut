"""フェーズW26: パンチイン(交互ズーム)割当のテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.punch_in import (
    PUNCH_SCALE,
    assign_punch_in,
    punch_origin,
    punch_scale_for_index,
)


class TestPunchScaleForIndex(unittest.TestCase):
    def test_alternates_starting_with_identity(self):
        """先頭カットは等倍、以降は交互にパンチイン。"""
        scales = [punch_scale_for_index(i) for i in range(4)]
        self.assertEqual(scales, [1.0, PUNCH_SCALE, 1.0, PUNCH_SCALE])


class TestPunchOrigin(unittest.TestCase):
    def test_face_box_center(self):
        ox, oy = punch_origin({"x": 0.3, "y": 0.2, "w": 0.2, "h": 0.1})
        self.assertAlmostEqual(ox, 0.4)
        self.assertAlmostEqual(oy, 0.25)

    def test_fallback_without_face(self):
        self.assertEqual(punch_origin(None), (0.5, 0.42))
        self.assertEqual(punch_origin({"x": "bad"}), (0.5, 0.42))
        self.assertEqual(punch_origin({"x": 0.1, "y": 0.1, "w": 0, "h": 0}), (0.5, 0.42))

    def test_clamps_to_unit_range(self):
        ox, oy = punch_origin({"x": 0.9, "y": 0.95, "w": 0.4, "h": 0.4})
        self.assertEqual(ox, 1.0)
        self.assertEqual(oy, 1.0)


class TestAssignPunchIn(unittest.TestCase):
    def test_writes_alternating_cuts_only(self):
        cuts = [
            {"cut_id": "cut_001", "face_box": None},
            {"cut_id": "cut_002", "face_box": {"x": 0.3, "y": 0.2, "w": 0.2, "h": 0.1}},
            {"cut_id": "cut_003", "face_box": None},
            {"cut_id": "cut_004", "face_box": None},
        ]
        applied = assign_punch_in(cuts)
        self.assertEqual(applied, 2)
        # 偶数index(先頭含む)はキー自体を書かない=Remotion側で変形なし
        self.assertNotIn("punch_scale", cuts[0])
        self.assertNotIn("punch_scale", cuts[2])
        # 奇数indexはパンチイン+注視点(顔box中心 or 既定)
        self.assertEqual(cuts[1]["punch_scale"], PUNCH_SCALE)
        self.assertEqual(cuts[1]["punch_origin"], {"x": 0.4, "y": 0.25})
        self.assertEqual(cuts[3]["punch_scale"], PUNCH_SCALE)
        self.assertEqual(cuts[3]["punch_origin"], {"x": 0.5, "y": 0.42})

    def test_single_cut_not_punched(self):
        """カット1つだけならジャンプカットが存在しないため何も書かない。"""
        cuts = [{"cut_id": "cut_001", "face_box": None}]
        self.assertEqual(assign_punch_in(cuts), 0)
        self.assertNotIn("punch_scale", cuts[0])


if __name__ == "__main__":
    unittest.main()
