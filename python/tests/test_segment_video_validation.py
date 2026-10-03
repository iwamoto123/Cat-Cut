"""Real MP4 regression: nonempty audio-only caches must not enter video export."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import step08_composition as composition

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class SegmentVideoValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source.mp4'
        self.audio = self.root / 'audio.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(self.source)], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', str(self.audio)], check=True)

    def test_rejects_nonempty_audio_only_and_corrupt_mp4(self):
        bad = self.root / 'bad.mp4'; bad.write_bytes(b'not a video')
        self.assertGreater(self.audio.stat().st_size, 0)
        self.assertFalse(composition._segment_cache_available(str(self.audio)))
        self.assertFalse(composition._segment_cache_available(str(bad)))
        self.assertTrue(composition._segment_cache_available(str(self.source)))

    def test_old_audio_only_cache_is_rebuilt_without_changing_cut(self):
        output = self.root / 'out'; segments = output / 'segments'; segments.mkdir(parents=True)
        stat = self.source.stat()
        key = composition._segment_cache_hash(str(self.source), stat.st_mtime_ns, stat.st_size, 200, 800, 0, 'libx264_crf16_fast')
        cached = segments / f'seg_{key}.mp4'; shutil.copy(self.audio, cached)
        cuts = [{'cut_id':'cut_1','video':{'file_path':str(self.source),'start_ms':200,'end_ms':800}}]
        with mock.patch.object(composition, '_videotoolbox_available', False):
            composition._extract_segments(cuts, str(self.source), str(output), 0)
        self.assertTrue(composition._segment_cache_available(str(cached)))
        self.assertEqual(cuts[0]['video']['file_path'], str(cached))
        self.assertEqual(cuts[0]['video']['end_ms'], 600)
        duration = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(cached)], text=True))
        self.assertAlmostEqual(duration, .6, delta=.05)

    def test_hw_success_with_no_video_falls_back_to_software(self):
        original_run = subprocess.run
        def run(cmd, **kwargs):
            if cmd[0] == 'ffmpeg' and 'h264_videotoolbox' in cmd:
                shutil.copy(self.audio, cmd[-1])
                return subprocess.CompletedProcess(cmd, 0, '', '')
            return original_run(cmd, **kwargs)
        cuts = [{'cut_id':'cut_1','video':{'file_path':str(self.source),'start_ms':0,'end_ms':1000}}]
        with mock.patch.object(composition, '_videotoolbox_available', True), mock.patch.object(composition.subprocess, 'run', side_effect=run):
            composition._extract_segments(cuts, str(self.source), str(self.root/'out'), 0)
        self.assertTrue(composition._segment_cache_available(cuts[0]['video']['file_path']))
        self.assertNotEqual(cuts[0]['video']['file_path'], str(self.source))
