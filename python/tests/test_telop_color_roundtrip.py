import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from apply_telop import apply_to_composition, parse_telop


class TelopColorRoundtripTest(unittest.TestCase):
    def test_explicit_line_break_keeps_both_new_and_legacy_highlights(self):
        for highlights in [['確認', '事項'], ['確認事項'], ['確認\n事項']]:
            comp = {
                'timeline': {'cuts': [{'cut_id': 'cut_001', 'telop': {'pages': [{'id': 'cut_001_p00', 'lines': ['確認事項です']}]}}]},
                'voice_data': {'cuts': [{'id': 'cut_001', 'voice': {'words': [{'text': '確認事項です', 'start': 0.0, 'end': 2.0}]},
                    'telops': [{'id': 'cut_001_p00', 'text': '確認事項です', 'word_indices': [0], 'segments': [], 'highlight_words': highlights,
                                'style': 'fact_yellow'}]}]},
            }
            page_map, style_map, timing_map = parse_telop('# cut_001_p00 [00:00.00-00:02.00] @style=fact_yellow\n確認\n事項です\n')
            apply_to_composition(comp, page_map, style_map, timing_map)
            telop = comp['voice_data']['cuts'][0]['telops'][0]
            self.assertEqual(telop['highlight_words'], highlights)
            self.assertEqual(telop['style'], 'fact_yellow')

    def test_directed_render_preserves_newline_and_all_human_highlights(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from shared.direction import build_directed_cut_content, sanitize_highlight_words
        text = '確認\n手順と操作、編集、保存'
        highlights = ['確認手順', '操作', '編集', '保存']
        self.assertEqual(sanitize_highlight_words(highlights, text), highlights[:3])
        pages, telops = build_directed_cut_content('cut_001', [{
            'id': 'slot_1', 'text': text, 'start_ms': 0, 'end_ms': 3000,
            'highlight_words': highlights, 'style': 'fact_yellow',
        }], [{'text': text.replace('\n', ''), 'start': 0, 'end': 3}], 3000, 20)
        self.assertEqual(telops[0]['highlight_words'], highlights)
        self.assertEqual(pages[0]['highlight_words'], highlights)
        self.assertIn('\n', telops[0]['text'])
