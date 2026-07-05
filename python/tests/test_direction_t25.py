"""フェーズT2.5(テロップ描画品質・デザイン刷新)のPython側テスト。

1. semantic type 体系 (shared/telop_types): 正規化・マッピング解決・ユーザー上書き
2. effective_slot_style の優先順位 (個別上書き > type×マッピング > 旧styleスナップショット)
3. sanitize_slot_directive の type 出力・文字数上限フォールバック・旧style後方互換
4. build_directed_cut_content のtype伝搬・マッピング再解決
5. step06c_direction.run_step の typeベースAI応答(モック)・プロンプト
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step06c_direction
from shared.direction import (
    DEFAULT_DIRECTIVE_STYLE,
    build_directed_cut_content,
    effective_slot_style,
    sanitize_slot_directive,
)
from shared.telop_types import (
    DEFAULT_SEMANTIC_TYPE,
    FALLBACK_TYPE_STYLE_MAPPING,
    SEMANTIC_TYPES,
    load_type_mapping,
    resolve_style_for_type,
    sanitize_semantic_type,
)


def make_words(specs):
    return [{"text": t, "start_ms": s, "end_ms": e} for t, s, e in specs]


class SemanticTypeTests(unittest.TestCase):
    """shared/telop_types の type 体系。"""

    def test_semantic_types_are_ten(self):
        self.assertEqual(len(SEMANTIC_TYPES), 10)
        self.assertIn("harsh", SEMANTIC_TYPES)
        self.assertIn("quote", SEMANTIC_TYPES)

    def test_sanitize_semantic_type_normalizes_unknown(self):
        self.assertEqual(sanitize_semantic_type("harsh"), "harsh")
        self.assertEqual(sanitize_semantic_type("mystery"), DEFAULT_SEMANTIC_TYPE)
        self.assertEqual(sanitize_semantic_type(None), DEFAULT_SEMANTIC_TYPE)
        self.assertEqual(sanitize_semantic_type(123), DEFAULT_SEMANTIC_TYPE)

    def test_fallback_mapping_covers_all_types(self):
        self.assertEqual(set(FALLBACK_TYPE_STYLE_MAPPING.keys()), set(SEMANTIC_TYPES))

    def test_default_yaml_mapping_loads_and_covers_all_types(self):
        mapping = load_type_mapping()
        self.assertEqual(set(mapping.keys()), set(SEMANTIC_TYPES))
        self.assertEqual(mapping["harsh"], "serif_harsh")
        self.assertEqual(mapping["quote"], "serif_quote")
        self.assertEqual(mapping["default"], "fact_yellow")

    def test_user_mapping_overrides_default(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            user_file = Path(tmp_dir) / "telop_type_mapping.json"
            user_file.write_text(
                json.dumps({"type_styles": {"harsh": "emotion_red", "unknown_type": "x", "quote": ""}}),
                encoding="utf-8",
            )
            mapping = load_type_mapping(user_file=user_file)
            self.assertEqual(mapping["harsh"], "emotion_red")  # ユーザー上書き
            self.assertEqual(mapping["quote"], "serif_quote")  # 空文字は無効→既定のまま
            self.assertNotIn("unknown_type", mapping)  # 不明typeは捨てる

    def test_broken_user_mapping_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            user_file = Path(tmp_dir) / "broken.json"
            user_file.write_text("{{{not json", encoding="utf-8")
            mapping = load_type_mapping(user_file=user_file)
            self.assertEqual(mapping["default"], "fact_yellow")

    def test_resolve_style_for_type(self):
        self.assertEqual(resolve_style_for_type("cta"), "cta_yellow")
        self.assertEqual(resolve_style_for_type("cta", {"cta": "box_red"}), "box_red")
        # 不明typeはdefault扱い
        self.assertEqual(resolve_style_for_type("???", {"default": "neutral_white"}), "neutral_white")


class EffectiveSlotStyleTests(unittest.TestCase):
    """スタイル解決の優先順位。"""

    def test_overridden_style_wins_over_type(self):
        slot = {"type": "harsh", "style": "box_red", "style_overridden": True}
        self.assertEqual(effective_slot_style(slot, {"harsh": "serif_harsh"}), "box_red")

    def test_type_mapping_wins_over_style_snapshot(self):
        # 上書きフラグ無し: styleスナップショットより最新マッピングを優先(マッピング変更が追従する)
        slot = {"type": "harsh", "style": "fact_yellow"}
        self.assertEqual(effective_slot_style(slot, {"harsh": "serif_harsh"}), "serif_harsh")

    def test_legacy_slot_without_type_uses_style_snapshot(self):
        # T2の旧ディレクティブ(type無し)は保存済みstyleをそのまま使う(後方互換)
        slot = {"style": "reply_cyan"}
        self.assertEqual(effective_slot_style(slot), "reply_cyan")

    def test_slot_without_type_and_style_uses_default(self):
        self.assertEqual(effective_slot_style({}), DEFAULT_DIRECTIVE_STYLE)

    def test_invalid_mapped_style_is_normalized(self):
        # マッピングが不正なプリセットIDを指しても許可リストへ正規化される
        slot = {"type": "harsh"}
        self.assertEqual(effective_slot_style(slot, {"harsh": "rainbow_mega"}), DEFAULT_DIRECTIVE_STYLE)


class SanitizeSlotDirectiveT25Tests(unittest.TestCase):
    """sanitize_slot_directive の type 出力・文字数上限・後方互換。"""

    SLOT = {
        "slot_id": "cut_001_s00",
        "cut_id": "cut_001",
        "cut_index": 0,
        "start_ms": 0,
        "end_ms": 3000,
        "source_start_ms": 800,
        "source_end_ms": 3800,
        "text": "毎月30万円の売上が出てるんですけれども",
    }

    def test_type_response_resolves_style_via_mapping(self):
        raw = {"text": "毎月30万円の売上が出てます", "type": "emphasis", "highlight_words": ["30万円"]}
        directive = sanitize_slot_directive(self.SLOT, raw, type_mapping={"emphasis": "emotion_red"})
        self.assertEqual(directive["type"], "emphasis")
        self.assertEqual(directive["style"], "emotion_red")
        self.assertFalse(directive["fallback"])

    def test_unknown_type_becomes_default(self):
        raw = {"text": "毎月30万円の売上が出てます", "type": "banana"}
        directive = sanitize_slot_directive(self.SLOT, raw, type_mapping={"default": "fact_yellow"})
        self.assertEqual(directive["type"], "default")
        self.assertEqual(directive["style"], "fact_yellow")

    def test_legacy_style_response_is_still_accepted(self):
        # 旧形式(styleのみ)のAI応答も引き続き通る(後方互換)
        raw = {"text": "毎月30万円の売上が出てます", "style": "reply_cyan"}
        directive = sanitize_slot_directive(self.SLOT, raw)
        self.assertEqual(directive["style"], "reply_cyan")
        self.assertEqual(directive["type"], "default")

    def test_overlong_text_falls_back_to_source(self):
        # 2行×行バジェットを超える文言は末尾切りせず元発話へフォールバック
        long_text = "毎月30万円の売上が出てるんですけれども" * 3
        raw = {"text": long_text, "type": "default"}
        directive = sanitize_slot_directive(self.SLOT, raw, max_text_chars=32)
        self.assertEqual(directive["text"], self.SLOT["text"])
        self.assertTrue(directive["fallback"])

    def test_text_within_limit_is_kept(self):
        raw = {"text": "毎月30万円の売上が出てます", "type": "default"}
        directive = sanitize_slot_directive(self.SLOT, raw, max_text_chars=32)
        self.assertEqual(directive["text"], "毎月30万円の売上が出てます")
        self.assertFalse(directive["fallback"])

    def test_missing_response_gets_default_type(self):
        directive = sanitize_slot_directive(self.SLOT, None, type_mapping={"default": "neutral_white"})
        self.assertEqual(directive["type"], "default")
        self.assertEqual(directive["style"], "neutral_white")
        self.assertTrue(directive["fallback"])


class BuildDirectedCutContentT25Tests(unittest.TestCase):
    """build_directed_cut_content の type 伝搬・マッピング再解決。"""

    def _slots(self):
        return [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "厳しいことを言います",
             "type": "harsh", "style": "fact_yellow", "highlight_words": []},
            {"slot_id": "s1", "start_ms": 3000, "end_ms": 6000, "text": "個別上書き済み",
             "type": "harsh", "style": "box_red", "style_overridden": True, "highlight_words": []},
        ]

    def test_type_mapping_is_reresolved_at_step08(self):
        pages, telops = build_directed_cut_content(
            "cut_001", self._slots(), [], 6000, 16,
            type_mapping={"harsh": "serif_harsh"},
        )
        # スナップショットの fact_yellow ではなく最新マッピングの serif_harsh
        self.assertEqual(pages[0]["style"], "serif_harsh")
        self.assertEqual(telops[0]["style"], "serif_harsh")
        self.assertEqual(pages[0]["type"], "harsh")
        self.assertEqual(telops[0]["type"], "harsh")
        # 個別上書きはマッピングより優先され、フラグが伝搬する
        self.assertEqual(telops[1]["style"], "box_red")
        self.assertTrue(telops[1]["style_overridden"])
        self.assertNotIn("style_overridden", telops[0])

    def test_legacy_slots_without_type_keep_style(self):
        slots = [{"slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "旧形式",
                  "style": "reply_cyan", "highlight_words": []}]
        pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertEqual(pages[0]["style"], "reply_cyan")
        self.assertNotIn("type", pages[0])
        self.assertNotIn("type", telops[0])


class Step06cTypeBasedTests(unittest.TestCase):
    """step06c_direction の typeベースAI応答(モック)。"""

    def _write_inputs(self, tmp: Path):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3500, "text": "正直この勉強法はダメです"},
                {"start_ms": 5000, "end_ms": 8000, "text": "そうなんですね"},
            ],
        }
        stt = {
            "words": make_words([
                ("正直", 100, 800), ("この勉強法は", 900, 2000), ("ダメです", 2100, 3400),
                ("そうなんですね", 5200, 7500),
            ]),
        }
        proposal_path = tmp / "cut_proposal.json"
        stt_path = tmp / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")
        return proposal_path, stt_path

    def test_prompt_asks_for_semantic_type(self):
        prompt = step06c_direction.build_slot_prompt(
            [{"slot_id": "cut_001_s00", "text": "テスト"}], max_text_chars=32,
        )
        self.assertIn('"type"', prompt)
        self.assertIn("harsh", prompt)
        self.assertIn("quote", prompt)
        self.assertIn("32文字", prompt)
        # 旧形式の「style ID一覧から選択」はプロンプトから消えている
        self.assertNotIn("fact_yellow", prompt)

    def test_run_step_with_type_based_llm_response(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            proposal_path, stt_path = self._write_inputs(tmp)

            def fake_caller(provider, api_key, model, prompt):
                if "構成作家" in prompt:
                    return {"chapters": []}
                return {
                    "slots": [
                        {"slot_id": "cut_001_s00", "text": "正直この勉強法はダメ",
                         "type": "harsh", "highlight_words": ["ダメ"]},
                        {"slot_id": "cut_002_s00", "text": "そうなんですね",
                         "type": "reply", "highlight_words": []},
                    ],
                    "overlays": [],
                }

            result = step06c_direction.run_step(
                str(tmp),
                str(proposal_path),
                str(stt_path),
                provider="anthropic",
                api_key="dummy-key",
                call_direction_fn=fake_caller,
            )
            self.assertTrue(result["enabled"])
            directives = json.loads((tmp / "telop_directives.json").read_text(encoding="utf-8"))
            slot1 = directives["slots"][0]
            self.assertEqual(slot1["type"], "harsh")
            self.assertEqual(slot1["style"], "serif_harsh")  # マッピング解決済みの結果も出力(後方互換)
            slot2 = directives["slots"][1]
            self.assertEqual(slot2["type"], "reply")
            self.assertEqual(slot2["style"], "reply_cyan")

    def test_run_step_user_mapping_changes_resolved_style(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            proposal_path, stt_path = self._write_inputs(tmp)
            user_mapping = tmp / "telop_type_mapping.json"
            user_mapping.write_text(json.dumps({"type_styles": {"harsh": "box_red"}}), encoding="utf-8")

            def fake_caller(provider, api_key, model, prompt):
                if "構成作家" in prompt:
                    return {"chapters": []}
                return {
                    "slots": [
                        {"slot_id": "cut_001_s00", "text": "正直この勉強法はダメ", "type": "harsh"},
                        {"slot_id": "cut_002_s00", "text": "そうなんですね", "type": "reply"},
                    ],
                    "overlays": [],
                }

            step06c_direction.run_step(
                str(tmp),
                str(proposal_path),
                str(stt_path),
                provider="anthropic",
                api_key="dummy-key",
                type_mapping_path=str(user_mapping),
                call_direction_fn=fake_caller,
            )
            directives = json.loads((tmp / "telop_directives.json").read_text(encoding="utf-8"))
            self.assertEqual(directives["slots"][0]["style"], "box_red")

    def test_run_step_overlong_ai_text_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            proposal_path, stt_path = self._write_inputs(tmp)
            project_yaml = tmp / "project.yaml"
            project_yaml.write_text("telop:\n  max_chars_per_line: 8\n", encoding="utf-8")

            def fake_caller(provider, api_key, model, prompt):
                if "構成作家" in prompt:
                    return {"chapters": []}
                return {
                    "slots": [
                        # 忠実だが 2行×8文字 を超える文言 → 元発話へフォールバック
                        {"slot_id": "cut_001_s00",
                         "text": "正直この勉強法はダメですダメですダメです", "type": "harsh"},
                        {"slot_id": "cut_002_s00", "text": "そうなんですね", "type": "reply"},
                    ],
                    "overlays": [],
                }

            result = step06c_direction.run_step(
                str(tmp),
                str(proposal_path),
                str(stt_path),
                provider="anthropic",
                api_key="dummy-key",
                project_path=str(project_yaml),
                call_direction_fn=fake_caller,
            )
            directives = json.loads((tmp / "telop_directives.json").read_text(encoding="utf-8"))
            slot1 = directives["slots"][0]
            self.assertEqual(slot1["text"], "正直この勉強法はダメです")
            self.assertTrue(slot1["fallback"])
            self.assertEqual(result["stats"]["fallback_slots"], 1)


if __name__ == "__main__":
    unittest.main()
