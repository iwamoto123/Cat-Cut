"""フェーズW24 Phase A-1: face_detect(YuNet顔検出+face_regions.jsonキャッシュ)のテスト。

実動画・実モデルは使わず、フォールバック(opencv未導入・モデル欠落)と
正規化・キャッシュの差分検出をモック中心で検証する(仕様A-4)。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shared import face_detect


RANGES = [(0, 3000), (3000, 6000)]


class FaceDetectFallbackTests(unittest.TestCase):
    def test_opencv_not_installed_returns_all_none(self):
        """opencv未導入は警告のみで全カットNone(パイプラインを止めない)。"""
        with mock.patch.object(face_detect, "_load_cv2", return_value=None):
            result = face_detect.detect_faces_for_ranges("/tmp/nonexistent.mp4", RANGES)
        self.assertEqual(result, [None, None])

    def test_model_missing_returns_all_none(self):
        """モデル欠落は警告のみで全カットNone(cv2は偽物で存在扱いにする)。"""
        with mock.patch.object(face_detect, "_load_cv2", return_value=mock.MagicMock()):
            result = face_detect.detect_faces_for_ranges(
                "/tmp/nonexistent.mp4", RANGES, model_path="/tmp/no_such_model.onnx",
            )
        self.assertEqual(result, [None, None])

    def test_detector_exception_returns_all_none(self):
        """検出器生成の例外も握りつぶして全カットNone。"""
        fake_cv2 = mock.MagicMock()
        fake_cv2.FaceDetectorYN.create.side_effect = RuntimeError("boom")
        with tempfile.TemporaryDirectory() as tmp_dir:
            model = Path(tmp_dir) / "model.onnx"
            model.write_bytes(b"dummy")
            with mock.patch.object(face_detect, "_load_cv2", return_value=fake_cv2):
                result = face_detect.detect_faces_for_ranges(
                    "/tmp/nonexistent.mp4", RANGES, model_path=str(model),
                )
        self.assertEqual(result, [None, None])

    def test_empty_ranges(self):
        self.assertEqual(face_detect.detect_faces_for_ranges("/tmp/x.mp4", []), [])

    def test_default_model_path_points_to_bundled_onnx(self):
        """同梱モデルの既定パスが editor/assets/models を指す(リポジトリに実在する)。"""
        path = face_detect.default_model_path()
        self.assertTrue(path.endswith(os.path.join("assets", "models", "face_detection_yunet_2023mar.onnx")))
        self.assertTrue(os.path.exists(path))


class RepresentativeBoxTests(unittest.TestCase):
    def test_median_and_normalization(self):
        """複数フレームの顔box(px)の中央値を取り、0〜1へ正規化する。"""
        boxes = [
            (100.0, 200.0, 300.0, 400.0),
            (120.0, 220.0, 280.0, 380.0),
            (80.0, 180.0, 320.0, 420.0),
        ]
        box = face_detect._representative_box(boxes, 640, 1136)
        self.assertEqual(box, {
            "x": round(100 / 640, 4),
            "y": round(200 / 1136, 4),
            "w": round(300 / 640, 4),
            "h": round(400 / 1136, 4),
        })

    def test_clamped_to_unit_range(self):
        """フレーム外へはみ出すboxは0〜1にクランプされる(w/hは右下端まで)。"""
        box = face_detect._representative_box([(-50.0, -20.0, 800.0, 1200.0)], 640, 1136)
        self.assertEqual(box["x"], 0.0)
        self.assertEqual(box["y"], 0.0)
        self.assertEqual(box["w"], 1.0)
        self.assertEqual(box["h"], 1.0)

    def test_empty_or_degenerate(self):
        self.assertIsNone(face_detect._representative_box([], 640, 1136))
        self.assertIsNone(face_detect._representative_box([(0.0, 0.0, 0.0, 0.0)], 640, 1136))
        self.assertIsNone(face_detect._representative_box([(1.0, 1.0, 2.0, 2.0)], 0, 0))

    def test_largest_face_box(self):
        faces = [
            [10.0, 10.0, 50.0, 50.0, 0.0],
            [100.0, 100.0, 200.0, 150.0, 0.0],  # 面積最大
            [5.0, 5.0, 30.0, 30.0, 0.0],
        ]
        self.assertEqual(face_detect._largest_face_box(faces), (100.0, 100.0, 200.0, 150.0))
        self.assertIsNone(face_detect._largest_face_box(None))
        self.assertIsNone(face_detect._largest_face_box([]))


class FaceCacheTests(unittest.TestCase):
    """face_regions.json キャッシュ: 同一動画+同一区間は再検出しない/差分だけ検出する。"""

    def _make_video(self, tmp: Path, content: bytes = b"videodata") -> str:
        video = tmp / "source.mp4"
        video.write_bytes(content)
        return str(video)

    def test_cache_hit_skips_detection(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            video = self._make_video(tmp)
            cache = str(tmp / "face_regions.json")
            fake_box = {"x": 0.3, "y": 0.2, "w": 0.3, "h": 0.4}

            with mock.patch.object(
                face_detect, "detect_faces_for_ranges", return_value=[fake_box, None],
            ) as detect:
                first = face_detect.detect_faces_for_ranges_cached(video, RANGES, cache)
            self.assertEqual(first, [fake_box, None])
            self.assertEqual(detect.call_count, 1)

            # 2回目(再適用): 検出は呼ばれずキャッシュから返る(顔なしNoneもヒットする)
            with mock.patch.object(face_detect, "detect_faces_for_ranges") as detect2:
                second = face_detect.detect_faces_for_ranges_cached(video, RANGES, cache)
            self.assertEqual(second, [fake_box, None])
            detect2.assert_not_called()

    def test_changed_ranges_detect_only_missing(self):
        """カット区間が一部変わったら、変わった区間だけを再検出する(差分検出)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            video = self._make_video(tmp)
            cache = str(tmp / "face_regions.json")
            box_a = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
            box_c = {"x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2}

            with mock.patch.object(
                face_detect, "detect_faces_for_ranges", return_value=[box_a, None],
            ):
                face_detect.detect_faces_for_ranges_cached(video, RANGES, cache)

            # 2番目のカットだけトリムで区間が変わった
            new_ranges = [(0, 3000), (3500, 6000)]
            with mock.patch.object(
                face_detect, "detect_faces_for_ranges", return_value=[box_c],
            ) as detect:
                result = face_detect.detect_faces_for_ranges_cached(video, new_ranges, cache)
            self.assertEqual(result, [box_a, box_c])
            detect.assert_called_once()
            self.assertEqual(detect.call_args.args[1], [(3500, 6000)])

    def test_video_change_invalidates_cache(self):
        """動画の実体(サイズ・mtime)が変わったらキャッシュを破棄して全再検出する。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            video = self._make_video(tmp)
            cache = str(tmp / "face_regions.json")
            with mock.patch.object(
                face_detect, "detect_faces_for_ranges", return_value=[None, None],
            ):
                face_detect.detect_faces_for_ranges_cached(video, RANGES, cache)

            # 実体を書き換える(サイズ変更)
            self._make_video(tmp, content=b"videodata-changed")
            with mock.patch.object(
                face_detect, "detect_faces_for_ranges", return_value=[None, None],
            ) as detect:
                face_detect.detect_faces_for_ranges_cached(video, RANGES, cache)
            detect.assert_called_once()
            self.assertEqual(detect.call_args.args[1], [(0, 3000), (3000, 6000)])

    def test_broken_cache_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            video = self._make_video(tmp)
            cache = tmp / "face_regions.json"
            cache.write_text("{broken json", encoding="utf-8")
            with mock.patch.object(
                face_detect, "detect_faces_for_ranges", return_value=[None, None],
            ) as detect:
                result = face_detect.detect_faces_for_ranges_cached(video, RANGES, str(cache))
            self.assertEqual(result, [None, None])
            detect.assert_called_once()
            # 破損ファイルは正しい形で書き直される
            data = json.loads(cache.read_text(encoding="utf-8"))
            self.assertEqual(data["version"], face_detect.CACHE_VERSION)


if __name__ == "__main__":
    unittest.main()
