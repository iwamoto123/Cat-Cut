"""Interrupted writes and duplicate segments must not poison the export cache."""

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import step08_composition as composition


class SegmentAtomicTests(unittest.TestCase):
    def test_publishes_only_complete_segment(self):
        with tempfile.TemporaryDirectory() as tmp:
            final = Path(tmp) / "seg_complete.mp4"

            def encode(cmd, **_kwargs):
                staged = Path(cmd[-1])
                self.assertEqual(staged.parent, final.parent)
                self.assertNotEqual(staged, final)
                staged.write_bytes(b"complete mp4")
                self.assertFalse(final.exists(), "staged bytes are not a cache hit")
                return mock.Mock(returncode=0)

            with mock.patch.object(composition.subprocess, "run", side_effect=encode):
                result = composition._encode_segment("source", 0, 1, [], str(final))
            self.assertIsNone(result)
            self.assertEqual(final.read_bytes(), b"complete mp4")
            self.assertEqual(list(Path(tmp).iterdir()), [final])

    def test_failure_and_interrupt_preserve_previous_complete_file(self):
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as tmp:
                final = Path(tmp) / "seg_complete.mp4"
                final.write_bytes(b"previous complete mp4")

                def encode(cmd, **_kwargs):
                    Path(cmd[-1]).write_bytes(b"partial mp4")
                    if interrupted:
                        raise KeyboardInterrupt()
                    return mock.Mock(returncode=1, stderr="encode failed")

                with mock.patch.object(composition.subprocess, "run", side_effect=encode):
                    if interrupted:
                        with self.assertRaises(KeyboardInterrupt):
                            composition._encode_segment("source", 0, 1, [], str(final))
                    else:
                        self.assertEqual(
                            composition._encode_segment("source", 0, 1, [], str(final)),
                            "encode failed",
                        )
                self.assertEqual(final.read_bytes(), b"previous complete mp4")
                self.assertEqual(list(Path(tmp).iterdir()), [final])

    def test_zero_byte_cache_reencoded_and_duplicate_cuts_share_one_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            segments = root / "output" / "segments"
            segments.mkdir(parents=True)
            stat = source.stat()
            key = composition._segment_cache_hash(
                str(source), stat.st_mtime_ns, stat.st_size, 0, 1000, 0, "libx264_crf16_fast",
            )
            cached = segments / f"seg_{key}.mp4"
            cached.touch()
            cuts = [
                {"cut_id": f"cut_{i}", "video": {"file_path": str(source), "start_ms": 0, "end_ms": 1000}}
                for i in range(3)
            ]
            calls = []

            def encode(cmd, **_kwargs):
                calls.append(cmd)
                Path(cmd[-1]).write_bytes(b"complete")
                return mock.Mock(returncode=0)

            output = io.StringIO()
            with mock.patch.object(composition, "_videotoolbox_available", False):
                with mock.patch.object(composition.subprocess, "run", side_effect=encode):
                    with redirect_stdout(output):
                        composition._extract_segments(cuts, str(source), str(root / "output"), 0)
            self.assertEqual(len(calls), 1)
            self.assertEqual(cached.read_bytes(), b"complete")
            self.assertTrue(all(cut["video"]["file_path"] == str(cached) for cut in cuts))
            self.assertIn("Progress: 100%", output.getvalue())
            self.assertIn("encoded: 1, cache hits: 2", output.getvalue())

    def test_empty_success_does_not_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            final = Path(tmp) / "seg_empty.mp4"
            with mock.patch.object(composition.subprocess, "run", return_value=mock.Mock(returncode=0)):
                self.assertEqual(
                    composition._encode_segment("source", 0, 1, [], str(final)),
                    "FFmpeg produced an empty segment",
                )
            self.assertFalse(final.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_duplicate_cuts_remain_shared_after_hardware_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            cuts = [
                {"cut_id": f"cut_{i}", "video": {"file_path": str(source), "start_ms": 1000, "end_ms": 2000}}
                for i in range(2)
            ]
            encoders = []

            def encode(cmd, **_kwargs):
                encoder = cmd[cmd.index("-c:v") + 1]
                encoders.append(encoder)
                if encoder == "h264_videotoolbox":
                    return mock.Mock(returncode=1, stderr="hardware unavailable")
                Path(cmd[-1]).write_bytes(b"software complete")
                return mock.Mock(returncode=0)

            output = io.StringIO()
            with mock.patch.object(composition, "_videotoolbox_available", True):
                with mock.patch.object(composition.subprocess, "run", side_effect=encode):
                    with redirect_stdout(output):
                        composition._extract_segments(cuts, str(source), str(root / "output"), 0)
            self.assertEqual(encoders, ["h264_videotoolbox", "libx264"])
            self.assertEqual(cuts[0]["video"], cuts[1]["video"])
            self.assertEqual(cuts[0]["video"]["start_ms"], 0)
            self.assertIn("Progress: 100%", output.getvalue())
            self.assertIn("encoded: 1, cache hits: 1", output.getvalue())
