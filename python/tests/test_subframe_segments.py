"""Real regression for the reported 468.234s + 30ms audio-only segment."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from step08_composition import _encode_segment, _segment_cache_available
from tools.validate_export_media import validate_export_media, has_decodable_video

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class SubFrameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def source(self, fps='30', audio=True):
        path = self.root / ('source-' + fps.replace('/', '-') + str(audio) + '.mp4')
        cmd = ['ffmpeg','-y','-v','error','-f','lavfi','-i',f'testsrc2=s=64x64:r={fps}:d=2']
        if audio: cmd += ['-f','lavfi','-i','sine=duration=2']
        subprocess.run(cmd + ['-c:v','libx264','-c:a','aac',str(path)],check=True)
        return path

    def test_reproduce_audio_only_then_repair_existing_composition(self):
        source = self.source()
        segments = self.root/'step08_composition'/'segments';segments.mkdir(parents=True)
        target = segments/'seg_bad.mp4'
        subprocess.run(['ffmpeg','-v','error','-ss','0.234','-i',str(source),'-t','0.030','-c:v','libx264','-c:a','aac',str(target)],check=True)
        self.assertFalse(_segment_cache_available(str(target)), 'old extraction must reproduce the failure')
        (segments/'manifest.json').write_text(json.dumps({'bad':{'source':str(source),'start_ms':234,'end_ms':264}}))
        composition = segments.parent/'composition.json'
        composition.write_text(json.dumps({'timeline':{'cuts':[{'video':{'file_path':str(target),'start_ms':0,'end_ms':30},'telop':{'text':'編集済み'}}]}}))
        before = composition.read_bytes()
        self.assertEqual(validate_export_media(self.root),1)
        self.assertEqual(composition.read_bytes(),before)
        streams=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(target)],text=True))['streams']
        video=next(s for s in streams if s['codec_type']=='video')
        audio=next(s for s in streams if s['codec_type']=='audio')
        self.assertEqual(video['nb_frames'],'1')
        self.assertAlmostEqual(float(audio['duration']),.030,places=3)
        # Verify the repaired image corresponds to frame 7 (covering .234), not frame 8.
        def pixels(path, filter):
            return subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-vf',filter,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'])
        expected=pixels(source,'select=eq(n\\,7)');actual=pixels(target,'null')
        self.assertEqual(len(expected),len(actual))
        self.assertLess(sum(abs(a-b) for a,b in zip(expected,actual))/len(actual),4)

    def test_frame_rates_and_source_end_without_audio(self):
        for fps,start,duration in [('24',.084,.03),('25',.081,.03),('30000/1001',.235,.03),('30',.234,.03),('30',.014,.03),('60',.234,.01),('30',1.999,.001)]:
            with self.subTest(fps=fps,start=start):
                source=self.source(fps,audio=False);target=self.root/'out.mp4'
                self.assertIsNone(_encode_segment(str(source),start,duration,['-c:v','libx264'],str(target)))
                self.assertTrue(has_decodable_video(target))

    def test_short_cut_crossing_frame_boundary_is_repaired(self):
        source=self.source();target=self.root/'out.mp4'
        subprocess.run(['ffmpeg','-v','error','-ss','0.014','-i',str(source),'-t','0.030','-c:v','libx264','-c:a','aac',str(target)],check=True)
        self.assertFalse(_segment_cache_available(str(target)))
        self.assertIsNone(_encode_segment(str(source),.014,.030,['-c:v','libx264'],str(target)))
        self.assertTrue(has_decodable_video(target))

    def test_does_not_invent_video_after_source_ends(self):
        source=self.source();target=self.root/'out.mp4'
        self.assertIsNotNone(_encode_segment(str(source),3,.03,['-c:v','libx264'],str(target)))
        self.assertFalse(target.exists())
