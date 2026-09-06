"""フェーズT3(テロップアニメーション+効果音)のPython側テスト。

1. shared/telop_types: マッピングのフルエントリ({style, animation_in?, sfx?})読込・新旧形式互換
2. resolve_animation_for_type / resolve_sfx_for_type のマッピング解決
3. effective_slot_animation / effective_slot_sfx の優先順位
4. build_directed_cut_content の telop への animation_in / animation_overridden / sfx 出力
5. step08_composition の directed 分岐で composition に animation_in / sfx / sfx_volume が入ること
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step08_composition
from shared.direction import (
    build_directed_cut_content,
    effective_slot_animation,
    effective_slot_sfx,
)
from shared.telop_types import (
    ANIMATION_IN_TYPES,
    SFX_IDS,
    load_type_mapping,
    load_type_mapping_entries,
    resolve_animation_for_type,
    resolve_sfx_for_type,
)


def make_words(specs):
    return [{"text": t, "start_ms": s, "end_ms": e} for t, s, e in specs]


class TypeMappingEntriesTests(unittest.TestCase):
    """load_type_mapping_entries のフルエントリ読込(新旧形式互換)。"""

    def test_animation_and_sfx_ids_are_defined(self):
        self.assertIn("pop_big", ANIMATION_IN_TYPES)
        self.assertIn("slide_left", ANIMATION_IN_TYPES)
        # フェーズW24 Phase B-1: 広告向け4種(TS側 telopAnimation.ts と同期)
        self.assertIn("blur_in", ANIMATION_IN_TYPES)
        self.assertIn("typewriter", ANIMATION_IN_TYPES)
        self.assertIn("wipe_up", ANIMATION_IN_TYPES)
        self.assertIn("drop_settle", ANIMATION_IN_TYPES)
        # フェーズW2: teen(映像ギミックpinchの既定SFX)を追加
        self.assertEqual(set(SFX_IDS), {"don", "shakin", "pon", "jan", "hyu", "teen"})

    def test_new_format_user_mapping_keeps_animation_and_sfx(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            user_file = Path(tmp_dir) / "telop_type_mapping.json"
            user_file.write_text(
                json.dumps({
                    "type_styles": {
                        "emphasis": {"style": "box_red", "animation_in": "stamp", "sfx": "hyu"},
                        "quote": {"animation_in": "fade"},
                        "reply": {"sfx": "none"},
                    },
                }),
                encoding="utf-8",
            )
            entries = load_type_mapping_entries(user_file=user_file)
            self.assertEqual(entries["emphasis"]["style"], "box_red")
            self.assertEqual(entries["emphasis"]["animation_in"], "stamp")
            self.assertEqual(entries["emphasis"]["sfx"], "hyu")
            # styleを指定しないエントリは既定YAMLのstyleを維持したままアニメ/SFXだけ上書き
            self.assertEqual(entries["quote"]["style"], "serif_quote")
            self.assertEqual(entries["quote"]["animation_in"], "fade")
            self.assertEqual(entries["reply"]["sfx"], "none")

    def test_old_format_string_entries_still_load(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            user_file = Path(tmp_dir) / "telop_type_mapping.json"
            user_file.write_text(
                json.dumps({"type_styles": {"harsh": "emotion_red"}}), encoding="utf-8",
            )
            entries = load_type_mapping_entries(user_file=user_file)
            self.assertEqual(entries["harsh"], {"style": "emotion_red"})
            # styleのみビュー(load_type_mapping)も従来どおり
            mapping = load_type_mapping(user_file=user_file)
            self.assertEqual(mapping["harsh"], "emotion_red")

    def test_invalid_animation_and_sfx_are_dropped(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            user_file = Path(tmp_dir) / "telop_type_mapping.json"
            user_file.write_text(
                json.dumps({
                    "type_styles": {
                        "default": {"style": "fact_yellow", "animation_in": "explode", "sfx": "boom"},
                    },
                }),
                encoding="utf-8",
            )
            entries = load_type_mapping_entries(user_file=user_file)
            self.assertNotIn("animation_in", entries["default"])
            self.assertNotIn("sfx", entries["default"])


class ResolveForTypeTests(unittest.TestCase):
    """resolve_animation_for_type / resolve_sfx_for_type。"""

    def test_resolve_animation_for_type(self):
        mapping = {"emphasis": {"style": "emotion_red", "animation_in": "stamp"}}
        self.assertEqual(resolve_animation_for_type("emphasis", mapping), "stamp")
        self.assertIsNone(resolve_animation_for_type("emphasis", {}), "マッピング未指定はNone")
        self.assertIsNone(resolve_animation_for_type("emphasis", None))
        # 不明typeはdefault扱いでマッピングを引く
        self.assertEqual(
            resolve_animation_for_type("???", {"default": {"animation_in": "fade"}}), "fade",
        )

    def test_resolve_sfx_for_type(self):
        mapping = {"punchline": {"sfx": "jan"}, "reply": {"sfx": "none"}}
        self.assertEqual(resolve_sfx_for_type("punchline", mapping), "jan")
        self.assertEqual(resolve_sfx_for_type("reply", mapping), "none")
        self.assertIsNone(resolve_sfx_for_type("quote", mapping), "マッピング未指定はNone")
        # 旧形式(文字列=styleのみ)のマッピングはsfx指定なし
        self.assertIsNone(resolve_sfx_for_type("punchline", {"punchline": "box_yellow"}))


class EffectiveSlotAnimationTests(unittest.TestCase):
    """effective_slot_animation の優先順位: スロット個別 > typeマッピング > None。"""

    def test_slot_override_wins_over_mapping(self):
        slot = {"type": "emphasis", "animation_in": "slide_up"}
        mapping = {"emphasis": {"style": "emotion_red", "animation_in": "stamp"}}
        self.assertEqual(effective_slot_animation(slot, mapping), "slide_up")

    def test_mapping_animation_used_when_slot_has_none(self):
        slot = {"type": "emphasis"}
        mapping = {"emphasis": {"style": "emotion_red", "animation_in": "stamp"}}
        self.assertEqual(effective_slot_animation(slot, mapping), "stamp")

    def test_no_override_and_no_mapping_returns_none(self):
        # None = compositionに書かず、描画側がプリセット既定→timeline既定で解決する
        self.assertIsNone(effective_slot_animation({"type": "emphasis"}, {}))
        self.assertIsNone(effective_slot_animation({"type": "emphasis"}, None))

    def test_invalid_slot_animation_falls_back_to_mapping(self):
        slot = {"type": "emphasis", "animation_in": "explode"}
        mapping = {"emphasis": {"animation_in": "zoom"}}
        self.assertEqual(effective_slot_animation(slot, mapping), "zoom")

    def test_legacy_slot_without_type(self):
        # type無しの旧スロットは個別指定のみ有効
        self.assertEqual(effective_slot_animation({"animation_in": "fade"}, None), "fade")
        self.assertIsNone(effective_slot_animation({}, None))


class EffectiveSlotSfxTests(unittest.TestCase):
    """effective_slot_sfx の優先順位と (write, value) の意味。"""

    def test_default_is_not_written(self):
        # 指定なし → compositionに書かない(プリセット既定に任せる)
        self.assertEqual(effective_slot_sfx({"type": "emphasis"}, {}), (False, None))

    def test_slot_false_writes_explicit_off(self):
        # sfx: false → "sfx": null を書く(明示的に鳴らさない)
        self.assertEqual(effective_slot_sfx({"type": "emphasis", "sfx": False}, {}), (True, None))

    def test_mapping_id_is_written(self):
        mapping = {"punchline": {"sfx": "jan"}}
        self.assertEqual(effective_slot_sfx({"type": "punchline"}, mapping), (True, "jan"))

    def test_mapping_none_writes_explicit_off(self):
        mapping = {"reply": {"sfx": "none"}}
        self.assertEqual(effective_slot_sfx({"type": "reply"}, mapping), (True, None))

    def test_slot_true_overrides_mapping_none(self):
        # AI directives の sfx: true はマッピングの「鳴らさない」より意図を優先し、
        # プリセット既定のIDで鳴らす(フィールドは書かない)
        mapping = {"reply": {"sfx": "none"}}
        self.assertEqual(effective_slot_sfx({"type": "reply", "sfx": True}, mapping), (False, None))


class BuildDirectedCutContentT3Tests(unittest.TestCase):
    """build_directed_cut_content の telop への animation_in / sfx 出力。"""

    def test_slot_animation_override_writes_flag(self):
        slots = [{
            "slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "絶対にやめてください",
            "type": "emphasis", "style": "emotion_red", "animation_in": "slide_left",
            "highlight_words": [],
        }]
        _pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertEqual(telops[0]["animation_in"], "slide_left")
        self.assertTrue(telops[0]["animation_overridden"], "UIピッカー上書き由来のフラグが付く")

    def test_manual_video_effect_writes_value_and_override_flag(self):
        for video_effect in ("none", "pinch", "zoom"):
            slots = [{
                "slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "映像演出です",
                "type": "default", "style": "fact_yellow",
                "video_effect": video_effect, "highlight_words": [],
            }]
            _pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
            self.assertEqual(telops[0]["video_effect"], video_effect)
            self.assertTrue(telops[0]["video_effect_overridden"])

    def test_automatic_video_effect_does_not_write_override_metadata(self):
        slots = [{
            "slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "自動演出です",
            "type": "harsh", "style": "emotion_red", "highlight_words": [],
        }]
        _pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertNotIn("video_effect", telops[0])
        self.assertNotIn("video_effect_overridden", telops[0])

    def test_mapping_animation_written_without_override_flag(self):
        slots = [{
            "slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "絶対にやめてください",
            "type": "emphasis", "style": "emotion_red", "highlight_words": [],
        }]
        mapping = {"emphasis": {"style": "emotion_red", "animation_in": "stamp", "sfx": "hyu"}}
        _pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16, type_mapping=mapping)
        self.assertEqual(telops[0]["animation_in"], "stamp")
        self.assertNotIn("animation_overridden", telops[0], "マッピング由来は上書きフラグを付けない")
        self.assertEqual(telops[0]["sfx"], "hyu")

    def test_no_animation_or_sfx_fields_when_preset_default(self):
        slots = [{
            "slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "こんにちは",
            "type": "default", "style": "fact_yellow", "highlight_words": [],
        }]
        _pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertNotIn("animation_in", telops[0])
        self.assertNotIn("sfx", telops[0])

    def test_slot_sfx_false_writes_null(self):
        slots = [{
            "slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "こんにちは",
            "type": "default", "style": "fact_yellow", "sfx": False, "highlight_words": [],
        }]
        _pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertIn("sfx", telops[0])
        self.assertIsNone(telops[0]["sfx"])


class Step08DirectedT3Tests(unittest.TestCase):
    """step08_composition の directed 分岐: composition に animation_in / sfx / sfx_volume。"""

    def _run_step08(self, tmp: Path, user_mapping: dict = None, telop_cfg_yaml: str = ""):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3500, "text": "絶対にやめてください"},
                {"start_ms": 5000, "end_ms": 8000, "text": "そうなんですね"},
            ],
            "stats": {"original_duration_ms": 9000, "reduction_ratio": 0.28},
        }
        stt = {
            "words": make_words([
                ("絶対に", 100, 800), ("やめて", 900, 2000), ("ください", 2100, 3400),
                ("そうなんですね", 5200, 7500),
            ]),
        }
        run_dir = tmp / "run"
        output_dir = run_dir / "step08_composition"
        output_dir.mkdir(parents=True)
        proposal_path = run_dir / "cut_proposal.json"
        stt_path = run_dir / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")

        directives = {
            "version": "1.0",
            "mode": "directed",
            "enabled": True,
            "chapters": [],
            "overlays": [],
            "slots": [
                # UIピッカーの個別上書き(animation_in)付きスロット
                {"slot_id": "cut_001_s00", "cut_id": "cut_001", "source_start_ms": 0, "source_end_ms": 3500,
                 "source_text": "絶対にやめてください", "text": "絶対にやめてください",
                 "type": "emphasis", "style": "emotion_red", "animation_in": "slide_up",
                 "highlight_words": [], "fallback": False},
                # 上書きなし(マッピング解決に任せる)スロット
                {"slot_id": "cut_002_s00", "cut_id": "cut_002", "source_start_ms": 5000, "source_end_ms": 8000,
                 "source_text": "そうなんですね", "text": "そうなんですね",
                 "type": "reply", "style": "reply_cyan", "highlight_words": [], "fallback": False},
            ],
        }
        (run_dir / "telop_directives.json").write_text(
            json.dumps(directives, ensure_ascii=False), encoding="utf-8",
        )

        mapping_path = None
        if user_mapping is not None:
            mapping_file = tmp / "telop_type_mapping.json"
            mapping_file.write_text(json.dumps({"type_styles": user_mapping}), encoding="utf-8")
            mapping_path = str(mapping_file)

        project_path = None
        if telop_cfg_yaml:
            project_file = tmp / "project.yaml"
            project_file.write_text(telop_cfg_yaml, encoding="utf-8")
            project_path = str(project_file)

        fake_metadata = {"video": {"width": 1920, "height": 1080, "rotation": 0}}
        with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                mock.patch.object(step08_composition, "_extract_segments"):
            return step08_composition.run_step(
                str(proposal_path),
                str(stt_path),
                str(tmp / "dummy.mp4"),
                str(output_dir),
                project_path=project_path,
                type_mapping_path=mapping_path,
            )

    def test_composition_telops_have_animation_and_sfx(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(
                Path(tmp_dir),
                user_mapping={"reply": {"style": "reply_cyan", "animation_in": "fade", "sfx": "pon"}},
            )
            # スロット個別上書き(UIピッカー)は animation_overridden 付きで出力される
            telop1 = comp["voice_data"]["cuts"][0]["telops"][0]
            self.assertEqual(telop1["animation_in"], "slide_up")
            self.assertTrue(telop1["animation_overridden"])
            # マッピング由来はフラグ無しで animation_in / sfx が入る
            telop2 = comp["voice_data"]["cuts"][1]["telops"][0]
            self.assertEqual(telop2["animation_in"], "fade")
            self.assertNotIn("animation_overridden", telop2)
            self.assertEqual(telop2["sfx"], "pon")
            # timeline に sfx_volume(既定0.25)が出力される
            self.assertEqual(comp["timeline"]["sfx_volume"], 0.25)

    def test_sfx_volume_from_project_yaml(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(
                Path(tmp_dir), telop_cfg_yaml="telop:\n  sfx_volume: 0.5\n",
            )
            self.assertEqual(comp["timeline"]["sfx_volume"], 0.5)


if __name__ == "__main__":
    unittest.main()
