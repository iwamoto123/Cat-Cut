import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared.video_effects import select_video_effects

class ExplicitNoneTest(unittest.TestCase):
    def test_none_blocks_cut_wide_effect_without_disabling_neighbors(self):
        slots = [{'slot_id':'off','source_start_ms':2000,'source_end_ms':4000,'video_effect':'none'}]
        segments = [{'source_start_ms':0,'source_end_ms':10000,'timeline_start_ms':0}]
        effects = select_video_effects(slots, segments, enabled={'slow_push':True}, cuts=[{'id':'cut','start_ms':0,'end_ms':10000}])
        self.assertTrue(effects)
        self.assertTrue(all(e['end_ms'] <= 2000 or e['start_ms'] >= 4000 for e in effects))
