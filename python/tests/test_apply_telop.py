import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from apply_telop import apply_to_composition, parse_telop


class ApplyTelopTests(unittest.TestCase):
    def test_merged_page_remaps_word_indices(self):
        text = """# cut_001_p00 [00:00.00-00:02.00] @style=highlight
計画の実行までを手厚くサポート
1人ひとりの専属チューターは
全員難関大生や医学科生で
指導経験も豊富なので
"""
        page_map, style_map, timing_map = parse_telop(text)
        comp = {
            "timeline": {
                "cuts": [
                    {
                        "cut_id": "cut_001",
                        "telop": {
                            "pages": [
                                {"id": "cut_001_p00", "lines": ["計画の実行までを手厚くサポート"]},
                                {"id": "cut_001_p01", "lines": ["1人ひとりの専属チューターは", "全員難関大生や医学科生で", "指導経験も豊富なので"]},
                            ]
                        },
                    }
                ]
            },
            "voice_data": {
                "cuts": [
                    {
                        "id": "cut_001",
                        "voice": {
                            "words": [
                                {"text": "計画の実行までを手厚くサポート", "start": 0.0, "end": 1.0},
                                {"text": "1人ひとりの専属チューターは", "start": 1.0, "end": 2.0},
                                {"text": "全員難関大生や医学科生で", "start": 2.0, "end": 3.0},
                                {"text": "指導経験も豊富なので", "start": 3.0, "end": 4.0},
                            ]
                        },
                        "telops": [
                            {
                                "id": "cut_001_p00",
                                "text": "計画の実行までを手厚くサポート",
                                "word_indices": [0],
                                "segments": [{"text": "計画の実行までを手厚くサポート", "word_indices": [0]}],
                            },
                            {
                                "id": "cut_001_p01",
                                "text": "1人ひとりの専属チューターは全員難関大生や医学科生で指導経験も豊富なので",
                                "word_indices": [1, 2, 3],
                                "segments": [],
                            },
                        ],
                    }
                ]
            },
        }

        apply_to_composition(comp, page_map, style_map, timing_map)

        pages = comp["timeline"]["cuts"][0]["telop"]["pages"]
        telops = comp["voice_data"]["cuts"][0]["telops"]
        self.assertEqual(len(pages), 1)
        self.assertEqual(len(telops), 1)
        self.assertEqual(telops[0]["word_indices"], [0, 1, 2, 3])
        self.assertEqual(telops[0]["style"], "highlight")
        self.assertEqual(telops[0]["start"], 0.0)
        self.assertEqual(telops[0]["end"], 2.0)
        self.assertEqual([segment["word_indices"] for segment in telops[0]["segments"]], [[0], [1], [2], [3]])

    def test_new_pages_from_telop_txt_are_added_with_explicit_timing(self):
        text = """# cut_001_p00 [00:00.00-00:01.00]
この夏

# cut_001_p01 [00:01.00-00:02.50]
志望校に近づく
"""
        page_map, style_map, timing_map = parse_telop(text)
        comp = {
            "timeline": {
                "cuts": [
                    {
                        "cut_id": "cut_001",
                        "timeline": {"start_ms": 0, "end_ms": 2500},
                        "telop": {"pages": [{"id": "cut_001_p00", "lines": ["旧"]}]},
                    }
                ]
            },
            "voice_data": {
                "cuts": [
                    {
                        "id": "cut_001",
                        "voice": {"words": []},
                        "telops": [],
                    }
                ]
            },
        }

        apply_to_composition(comp, page_map, style_map, timing_map)

        pages = comp["timeline"]["cuts"][0]["telop"]["pages"]
        telops = comp["voice_data"]["cuts"][0]["telops"]
        self.assertEqual([page["id"] for page in pages], ["cut_001_p00", "cut_001_p01"])
        self.assertEqual(telops[0]["start"], 0.0)
        self.assertEqual(telops[0]["end"], 1.0)
        self.assertEqual(telops[1]["start"], 1.0)
        self.assertEqual(telops[1]["end"], 2.5)


if __name__ == "__main__":
    unittest.main()
