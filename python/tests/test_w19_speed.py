"""W19-C1/C5(書き出し高速化): step08 セグメント抽出の並列化と進捗出力のテスト。

1. 並列抽出が直列と同一のセグメントファイル集合・composition更新を生成する
2. 並列度の環境変数 CATCUT_SEGMENT_JOBS のクランプ(1〜8、既定3)
3. 進捗出力 Progress: <n>% が単調増加で100%まで出る
4. 並列時も件数集計(encoded/cache hits)が正確
"""

import io
import os
import re
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import step08_composition


def make_cuts(source_path, boundaries):
    return [
        {
            "cut_id": f"cut_{i + 1:03d}",
            "video": {"file_path": source_path, "start_ms": start, "end_ms": end},
        }
        for i, (start, end) in enumerate(boundaries)
    ]


def fake_ffmpeg(calls, lock):
    """subprocess.run の代役(スレッド安全): コマンドを記録しダミーMP4を書いて成功。"""

    def _run(cmd, capture_output=True, text=True):
        with lock:
            calls.append(list(cmd))
        Path(cmd[-1]).write_bytes(b"fake mp4 data")
        return mock.Mock(returncode=0, stdout="", stderr="")

    return _run


BOUNDARIES = [(i * 1000, i * 1000 + 800) for i in range(12)]


class ParallelExtractionTests(unittest.TestCase):
    def setUp(self):
        self._saved_vt = step08_composition._videotoolbox_available
        step08_composition._videotoolbox_available = False

    def tearDown(self):
        step08_composition._videotoolbox_available = self._saved_vt

    def _extract(self, tmp: Path, jobs: str, subdir: str, source: Path):
        """指定並列度で _extract_segments を実行し (cuts, セグメントファイル名set, calls) を返す。"""
        (tmp / subdir).mkdir(parents=True, exist_ok=True)
        output_dir = str(tmp / subdir / "step08")
        cuts = make_cuts(str(source), BOUNDARIES)
        calls = []
        lock = threading.Lock()
        with mock.patch.dict(os.environ, {"CATCUT_SEGMENT_JOBS": jobs}):
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls, lock)):
                with redirect_stdout(io.StringIO()):
                    step08_composition._extract_segments(cuts, str(source), output_dir, 0)
        segments = {p.name for p in (tmp / subdir / "step08" / "segments").glob("seg_*.mp4")}
        return cuts, segments, calls

    def test_parallel_matches_serial_segment_set(self):
        """W19-C1: 並列抽出が直列と同一のセグメントファイル集合を生成する。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            # セグメント名はソース実体(パス+mtime+size)を含む内容ハッシュのため、
            # 直列/並列で同一ソースを使う(出力ディレクトリだけ分ける)
            source = tmp / "source.mp4"
            source.write_bytes(b"dummy source video")
            serial_cuts, serial_segments, serial_calls = self._extract(tmp, "1", "serial", source)
            parallel_cuts, parallel_segments, parallel_calls = self._extract(tmp, "4", "parallel", source)

            self.assertEqual(len(serial_calls), len(BOUNDARIES))
            self.assertEqual(len(parallel_calls), len(BOUNDARIES))
            self.assertEqual(len(serial_segments), len(BOUNDARIES))
            self.assertEqual(len(parallel_segments), len(BOUNDARIES))

            # composition 側の更新: 全カットがセグメント参照+start_ms=0 になり、
            # カット順のセグメント割り当て(境界→ファイル)が直列と並列で一致する
            for serial_cut, parallel_cut in zip(serial_cuts, parallel_cuts):
                self.assertEqual(
                    os.path.basename(serial_cut["video"]["file_path"]),
                    os.path.basename(parallel_cut["video"]["file_path"]),
                )
                self.assertEqual(parallel_cut["video"]["start_ms"], 0)
                self.assertRegex(
                    os.path.basename(parallel_cut["video"]["file_path"]), r"^seg_[0-9a-f]{16}\.mp4$"
                )
            self.assertEqual(
                {os.path.basename(c["video"]["file_path"]) for c in serial_cuts},
                serial_segments,
            )
            self.assertEqual(
                {os.path.basename(c["video"]["file_path"]) for c in parallel_cuts},
                parallel_segments,
            )

    def test_parallel_second_run_all_cache_hits(self):
        """並列でも2回目はキャッシュ全ヒット(ffmpeg呼び出しゼロ)で同一参照になる。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source_file = tmp / "source.mp4"
            source_file.write_bytes(b"dummy source video")
            first_cuts, _segments, first_calls = self._extract(tmp, "4", "run", source_file)
            self.assertEqual(len(first_calls), len(BOUNDARIES))

            source = str(source_file)
            output_dir = str(tmp / "run" / "step08")
            second_cuts = make_cuts(source, BOUNDARIES)
            calls = []
            lock = threading.Lock()
            with mock.patch.dict(os.environ, {"CATCUT_SEGMENT_JOBS": "4"}):
                with mock.patch.object(
                    step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls, lock)
                ):
                    with redirect_stdout(io.StringIO()):
                        step08_composition._extract_segments(second_cuts, source, output_dir, 0)
            self.assertEqual(calls, [], "2回目は全キャッシュヒット")
            self.assertEqual(
                [c["video"]["file_path"] for c in first_cuts],
                [c["video"]["file_path"] for c in second_cuts],
            )

    def test_progress_output_monotonic_to_100(self):
        """W19-C5: Progress: <n>% が単調増加で出力され、最後は100%に到達する。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = tmp / "source.mp4"
            source.write_bytes(b"dummy source video")
            output_dir = str(tmp / "step08")
            cuts = make_cuts(str(source), BOUNDARIES)
            calls = []
            lock = threading.Lock()
            buffer = io.StringIO()
            with mock.patch.dict(os.environ, {"CATCUT_SEGMENT_JOBS": "4"}):
                with mock.patch.object(
                    step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls, lock)
                ):
                    with redirect_stdout(buffer):
                        step08_composition._extract_segments(cuts, str(source), output_dir, 0)
            percents = [int(m) for m in re.findall(r"Progress: (\d+)%", buffer.getvalue())]
            self.assertTrue(percents, "進捗が出力される")
            self.assertEqual(percents, sorted(percents), "単調増加")
            self.assertEqual(percents[-1], 100)

    def test_encoded_and_cache_hit_counts_accurate(self):
        """並列時もサマリ行の encoded / cache hits 件数が正確。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = tmp / "source.mp4"
            source.write_bytes(b"dummy source video")
            output_dir = str(tmp / "step08")
            calls = []
            lock = threading.Lock()

            with mock.patch.dict(os.environ, {"CATCUT_SEGMENT_JOBS": "4"}):
                with mock.patch.object(
                    step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls, lock)
                ):
                    with redirect_stdout(io.StringIO()):
                        step08_composition._extract_segments(
                            make_cuts(str(source), BOUNDARIES[:6]), str(source), output_dir, 0
                        )
                    # 2回目: 既存6本ヒット + 新規6本エンコード
                    buffer = io.StringIO()
                    with redirect_stdout(buffer):
                        step08_composition._extract_segments(
                            make_cuts(str(source), BOUNDARIES), str(source), output_dir, 0
                        )
            summary = re.search(r"encoded: (\d+), cache hits: (\d+)", buffer.getvalue())
            self.assertIsNotNone(summary)
            self.assertEqual(int(summary.group(1)), 6)
            self.assertEqual(int(summary.group(2)), 6)


class SegmentJobsEnvTests(unittest.TestCase):
    def test_default_and_clamp(self):
        cases = {
            "": 3,
            "abc": 3,
            "3": 3,
            "1": 1,
            "0": 1,
            "-5": 1,
            "8": 8,
            "99": 8,
        }
        for raw, expected in cases.items():
            with mock.patch.dict(os.environ, {"CATCUT_SEGMENT_JOBS": raw}):
                self.assertEqual(step08_composition._segment_parallel_jobs(), expected, f"raw={raw!r}")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CATCUT_SEGMENT_JOBS", None)
            self.assertEqual(step08_composition._segment_parallel_jobs(), 3)


if __name__ == "__main__":
    unittest.main()
