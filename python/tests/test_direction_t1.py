"""フェーズT1(テロップパターン基盤)のテスト。

1. telop_presets.yaml の新プリセット10種のパース(必須フィールド・背景ボックス定義)
2. capture_telop_frames.collect_pages の拡張:
   - telops[].start/end (カット内相対秒) の明示タイミング対応
   - timeline.overlays をページとして含める
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from _telop_presets import load_presets
from capture_telop_frames import collect_pages

# 仕様書「フェーズT1-1」の新プリセット10種
T1_PRESET_NAMES = [
    "fact_yellow",
    "neutral_white",
    "emotion_red",
    "question_blue",
    "reply_cyan",
    "special_purple",
    "box_yellow",
    "box_red",
    "cta_yellow",
    "op_brush",
]


class T1PresetParseTests(unittest.TestCase):
    def setUp(self):
        self.presets = load_presets()

    def test_all_t1_presets_exist(self):
        for name in T1_PRESET_NAMES:
            self.assertIn(name, self.presets, f"preset {name} が telop_presets.yaml に無い")

    def test_t1_presets_have_required_fields(self):
        for name in T1_PRESET_NAMES:
            preset = self.presets[name]
            self.assertIn("fill", preset, f"{name}: fill が無い")
            self.assertIn(preset["fill"]["type"], ("solid", "gradient"), f"{name}: fill.type 不正")
            self.assertIsInstance(preset.get("font_size"), int, f"{name}: font_size が無い")

    def test_box_presets_have_block_background(self):
        # 背景ボックス系は padding_x/padding_y 付きの background を持つ
        # (Telop.tsx はこの指定で「行ごとの帯」ではなくブロック背景を描画する)
        for name in ("box_yellow", "box_red", "cta_yellow"):
            background = self.presets[name].get("background")
            self.assertIsInstance(background, dict, f"{name}: background が無い")
            self.assertIn("color", background, f"{name}: background.color が無い")
            self.assertIn("padding_x", background, f"{name}: background.padding_x が無い")
            self.assertIn("padding_y", background, f"{name}: background.padding_y が無い")

    def test_neutral_white_uses_thin_stroke_and_hard_shadow(self):
        # フェーズT2.5-2で「白+黒inner+青outerの三重フチ」を廃止し、
        # 「白fill + 黒細縁 + 黒ハードオフセット影」へ刷新した
        preset = self.presets["neutral_white"]
        self.assertEqual(preset["fill"]["type"], "solid")
        self.assertIsNone(preset.get("inner_stroke"))
        self.assertIsNotNone(preset.get("outer_stroke"))
        self.assertLessEqual(preset["outer_stroke"]["width"], 12)
        shadow_offset = preset.get("shadow_offset")
        self.assertIsInstance(shadow_offset, dict)
        for key in ("x", "y", "color"):
            self.assertIn(key, shadow_offset)

    def test_op_brush_uses_brush_font_with_serif_fallback(self):
        # フェーズT2.5-3: 毛筆フォント Yuji Syuku を第一候補にし、
        # オフライン時はシステム明朝へフォールバックする
        font_family = self.presets["op_brush"]["font_family"]
        self.assertIn("Yuji Syuku", font_family)
        self.assertIn("Mincho", font_family)

    def test_existing_presets_are_untouched(self):
        # 後方互換: 既存プリセット(default等)の形が変わっていない
        default = self.presets["default"]
        self.assertEqual(default["fill"]["type"], "gradient")
        self.assertEqual(default["font_size"], 72)
        self.assertNotIn("background", default)


class CollectPagesExplicitTimingTests(unittest.TestCase):
    """capture_telop_frames の明示 start/end とオーバーレイ対応(フェーズT1)。"""

    def _composition(self, cuts_timeline, voice_cuts, overlays=None):
        timeline = {"cuts": cuts_timeline}
        if overlays is not None:
            timeline["overlays"] = overlays
        return {"timeline": timeline, "voice_data": {"cuts": voice_cuts}}

    def test_explicit_start_end_takes_priority_over_word_indices(self):
        # Telop.tsx と同じ優先順位: 明示 start/end (カット内相対秒) を優先
        comp = self._composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 1000, "end_ms": 5000}}],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": []},
                    "telops": [
                        {"id": "cut_001_p00", "text": "演出テロップ", "word_indices": [], "start": 0.5, "end": 2.5},
                    ],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(len(pages), 1)
        # abs start = 1000 + 500 = 1500, end = 1000 + 2500 = 3500, center = 2500
        self.assertEqual(pages[0]["start_ms"], 1500)
        self.assertEqual(pages[0]["end_ms"], 3500)
        self.assertEqual(pages[0]["center_ms"], 2500)

    def test_word_indices_path_is_unchanged_when_no_explicit_timing(self):
        # 後方互換: 明示 start/end が無ければ従来の word_indices 逆算のまま
        comp = self._composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 2000, "end_ms": 5000}}],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": [{"text": "テ", "start": 0.5, "end": 1.0}, {"text": "スト", "start": 1.0, "end": 1.5}]},
                    "telops": [{"id": "cut_001_p00", "text": "テスト", "word_indices": [0, 1]}],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(pages[0]["center_ms"], 3000)

    def test_overlays_are_included_as_pages(self):
        comp = self._composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 0, "end_ms": 30000}}],
            voice_cuts=[],
            overlays=[
                {"id": "ov_chapter", "type": "chapter_title", "start_ms": 0, "end_ms": 15000, "text": "章見出し"},
                {"id": "ov_list", "type": "list_stack", "start_ms": 20000, "end_ms": 23000, "lines": ["社長", "役員"]},
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(len(pages), 2)
        by_id = {p["page_id"]: p for p in pages}
        self.assertEqual(by_id["ov_chapter"]["center_ms"], 7500)
        self.assertIn("[chapter_title]", by_id["ov_chapter"]["text"])
        self.assertIn("社長 / 役員", by_id["ov_list"]["text"])

    def test_invalid_overlays_are_skipped(self):
        comp = self._composition(
            cuts_timeline=[],
            voice_cuts=[],
            overlays=[
                {"id": "bad_span", "type": "caption", "start_ms": 2000, "end_ms": 1000},
                {"id": "no_ms", "type": "caption"},
                "not_a_dict",
            ],
        )
        self.assertEqual(collect_pages(comp), [])

    def test_composition_without_overlays_field_is_unchanged(self):
        # 後方互換: overlays フィールドの無い既存 composition はそのまま動く
        comp = self._composition(
            cuts_timeline=[{"cut_id": "cut_001", "timeline": {"start_ms": 0, "end_ms": 2000}}],
            voice_cuts=[
                {
                    "id": "cut_001",
                    "voice": {"words": [{"text": "A", "start": 0.0, "end": 1.0}]},
                    "telops": [{"id": "cut_001_p00", "text": "A", "word_indices": [0]}],
                }
            ],
        )
        pages = collect_pages(comp)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["page_id"], "cut_001_p00")


if __name__ == "__main__":
    unittest.main()
