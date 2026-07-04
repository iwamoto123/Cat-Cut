"""改善10-A: テロップ漢数字正規化・フィラー除去のテスト。"""
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.telop_builder import build_telop_pages, _normalize_kanji_numbers
from step04_filler_detect import _detect_fillers, ACTION_REMOVE, ACTION_WARN_ONLY
from step07_cut_proposal import run_step, _should_remove_filler, _clean_segment_text
from shared.project_config import load_project_config


def _char_words(text: str, start_id: int = 0, start_ms: int = 0, char_ms: int = 100):
    words = []
    t = start_ms
    for i, ch in enumerate(text):
        words.append({
            "id": f"w-{start_id + i:04d}",
            "text": ch,
            "start_ms": t,
            "end_ms": t + char_ms,
        })
        t += char_ms
    return words


class KanjiNumberNormalizationTests(unittest.TestCase):
    def test_quantity_with_counters(self):
        self.assertEqual(_normalize_kanji_numbers("平均点五十六点"), "平均点56点")
        self.assertEqual(_normalize_kanji_numbers("正答率三十パー"), "正答率30パー")
        self.assertEqual(_normalize_kanji_numbers("百点満点"), "100点満点")

    def test_idioms_are_preserved(self):
        preserved = [
            "一人一人手厚く指導",
            "一番大事なポイント",
            "一緒に頑張りましょう",
            "一体何が",
            "一部の生徒",
            "第一に確認",
            "一応見ておく",
            "一旦停止",
        ]
        for text in preserved:
            self.assertEqual(_normalize_kanji_numbers(text), text, msg=text)

    def test_telop_pages_apply_kanji_normalization(self):
        pages = build_telop_pages(
            "平均点五十六点になりました。",
            cut_id="cut_001",
            text_rules={"normalize_numbers": True},
        )
        joined = "".join("".join(p["lines"]) for p in pages)
        self.assertIn("56点", joined)
        self.assertNotIn("五十六点", joined)


class FillerActionClassificationTests(unittest.TestCase):
    def test_e_long_vowel_is_remove(self):
        words = _char_words("えー")
        words.append({"id": "w-0002", "text": "、", "start_ms": 200, "end_ms": 250})
        words += _char_words("最", 3, 250)
        sentences = [{"id": "s0", "text": "えー、最", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        ee = [f for f in fillers if f["word_id"] in ("w-0000", "w-0001")]
        self.assertEqual(len(ee), 2)
        for f in ee:
            self.assertEqual(f["action"], ACTION_REMOVE)

    def test_ne_is_warn_only_not_remove(self):
        words = _char_words("ただね")
        sentences = [{"id": "s0", "text": "ただね", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        ne = [f for f in fillers if f["text"] == "ね"]
        self.assertEqual(len(ne), 1)
        self.assertEqual(ne[0]["action"], ACTION_WARN_ONLY)

    def test_reeba_e_is_not_detected(self):
        words = _char_words("例えば")
        sentences = [{"id": "s0", "text": "例えば", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        self.assertEqual(fillers, [])

    def test_split_e_dash_with_gap_merged_and_remove(self):
        words = _char_words("え", 0, 0, 50)
        words.append({"id": "w-0001", "text": "ー", "start_ms": 450, "end_ms": 550})
        words += _char_words("概", 2, 550, 50)
        sentences = [{"id": "s0", "text": "えー概", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        ids = {f["word_id"] for f in fillers if f["action"] == ACTION_REMOVE}
        self.assertIn("w-0000", ids)
        self.assertIn("w-0001", ids)

    def test_yappa_partial_chars_suppressed(self):
        words = _char_words("やっぱり")
        sentences = [{"id": "s0", "text": "やっぱり", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        self.assertEqual(fillers, [])

    def test_single_char_a_inside_word_is_not_removed(self):
        # 「情報あるけど」の「あ」: 前後の語と時間が密着 → 語の一部なので除去しない
        words = _char_words("情報あるけど")
        sentences = [{"id": "s0", "text": "情報あるけど", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        removed = [f for f in fillers if f["action"] == ACTION_REMOVE]
        self.assertEqual(removed, [])

    def test_single_char_a_at_word_head_dense_is_not_removed(self):
        # 「あっなんだ」の「あ」: 直後と密着 → 除去しない
        words = _char_words("あっなんだ")
        sentences = [{"id": "s0", "text": "あっなんだ", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        removed = [f for f in fillers if f["action"] == ACTION_REMOVE and f["word_id"] == "w-0000"]
        self.assertEqual(removed, [])

    def test_single_char_ma_inside_word_is_not_removed(self):
        # 「作成しました」の「ま」: 語中 → 除去しない(実機IMG_5862で「作成しした」破壊が発生した回帰テスト)
        words = _char_words("作成しました")
        sentences = [{"id": "s0", "text": "作成しました", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        removed = [f for f in fillers if f["action"] == ACTION_REMOVE]
        self.assertEqual(removed, [])

    def test_single_char_ma_between_pauses_is_removed(self):
        # 「で、ま、これ」の「ま」: 句読点に挟まれた孤立 → 除去
        words = _char_words("で、ま、これ")
        sentences = [{"id": "s0", "text": "で、ま、これ", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        removed = [f for f in fillers if f["action"] == ACTION_REMOVE and f["match_text"] == "ま"]
        self.assertEqual(len(removed), 1)

    def test_single_char_e_isolated_by_pause_is_removed(self):
        # ポーズに挟まれた単独「え」は除去
        words = _char_words("え", 0, 1000, 100)
        words.append({"id": "w-0001", "text": "概", "start_ms": 1500, "end_ms": 1600})
        sentences = [{"id": "s0", "text": "え概", "word_ids": [w["id"] for w in words]}]
        fillers = _detect_fillers(words, sentences)
        removed = [f for f in fillers if f["action"] == ACTION_REMOVE and f["word_id"] == "w-0000"]
        self.assertEqual(len(removed), 1)


class FillerRemovalStep07Tests(unittest.TestCase):
    def test_action_remove_ignores_confidence_threshold(self):
        filler = {"action": "remove", "confidence": 0.3, "word_id": "w-0000"}
        self.assertTrue(_should_remove_filler(filler, 0.6))

    def test_action_warn_only_never_removed(self):
        filler = {"action": "warn_only", "confidence": 0.9, "word_id": "w-0000"}
        self.assertFalse(_should_remove_filler(filler, 0.6))

    def test_clean_segment_text_removes_orphan_dash(self):
        self.assertEqual(_clean_segment_text("解説プリントっていうのを、"), "解説プリントっていうのを、")
        self.assertEqual(_clean_segment_text("、ー概要欄"), "、概要欄")
        self.assertEqual(_clean_segment_text("、え"), "")


class NanukaDictionaryTests(unittest.TestCase):
    def test_nanuka_in_domain_dictionary(self):
        import yaml
        dict_path = Path(__file__).resolve().parents[2] / "templates" / "domain_dictionary.yaml"
        data = yaml.safe_load(dict_path.read_text(encoding="utf-8"))
        self.assertEqual(data["common_misrecognitions"].get("難下"), "難化")


if __name__ == "__main__":
    unittest.main()
