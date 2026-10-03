"""Export must repair invalid media without regenerating the edited composition."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.validate_export_media import validate_export_media, has_decodable_video


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class ExportMediaPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.segments = self.root / "step08_composition" / "segments"
        self.segments.mkdir(parents=True)
        self.source = self.root / "source.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=1", "-c:v", "libx264", str(self.source)], check=True)
        self.cached = self.segments / "seg_bad.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", str(self.cached)], check=True)
        (self.segments / "manifest.json").write_text(json.dumps({"bad": {"source": str(self.source), "start_ms": 200, "end_ms": 800}}))
        self.composition = self.segments.parent / "composition.json"
        self.composition.write_text(json.dumps({"timeline": {
            "cuts": [{"cut_id": "user_order_3", "video": {"file_path": str(self.cached), "start_ms": 0, "end_ms": 600}, "telop": {"text": "手直し済み", "color": "red"}}],
            "op": {"clips": [{"file_path": str(self.cached)}]}}}))

    def test_export_repairs_existing_composition_without_step08(self):
        original = self.composition.read_bytes()
        self.assertEqual(validate_export_media(self.root), 1)
        self.assertTrue(has_decodable_video(self.cached))
        self.assertEqual(self.composition.read_bytes(), original)
        duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(self.cached)], text=True))
        self.assertAlmostEqual(duration, .6, delta=.05)
        stat = self.cached.stat()
        self.assertEqual(validate_export_media(self.root), 0)
        self.assertEqual(self.cached.stat().st_mtime_ns, stat.st_mtime_ns)

    def test_missing_source_fails_before_render_and_preserves_edits(self):
        original = self.composition.read_bytes()
        self.source.unlink()
        with self.assertRaisesRegex(RuntimeError, "元素材"):
            validate_export_media(self.root)
        self.assertEqual(self.composition.read_bytes(), original)

    def test_unmanaged_invalid_media_is_never_overwritten(self):
        (self.segments / "manifest.json").unlink()
        original = self.cached.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "修復情報"):
            validate_export_media(self.root)
        self.assertEqual(self.cached.read_bytes(), original)

    def test_missing_segment_is_recreated(self):
        self.cached.unlink()
        self.assertEqual(validate_export_media(self.root), 1)
        self.assertTrue(has_decodable_video(self.cached))

    def test_op_only_media_is_checked(self):
        data = json.loads(self.composition.read_text())
        data["timeline"]["cuts"] = []
        self.composition.write_text(json.dumps(data))
        self.assertEqual(validate_export_media(self.root), 1)
