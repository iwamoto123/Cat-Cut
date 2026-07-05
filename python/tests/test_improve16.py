"""改善16: 単語内カット境界ガード・漢数字変換・ローマ字正規化のテスト。"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.text_cleaning import apply_deterministic_text_cleaning, normalize_romaji_stt_artifacts
from shared.telop_builder import _normalize_kanji_numbers
from step07_cut_proposal import (
    _apply_word_split_merge,
    _is_boundary_inside_budoux_chunk,
    run_step,
)


def _char_words(text: str, start_ms: int = 0, char_ms: int = 80, prefix: str = "w"):
    words = []
    t = start_ms
    for i, ch in enumerate(text):
        words.append({
            "id": f"{prefix}-{i:04d}",
            "text": ch,
            "start_ms": t,
            "end_ms": t + char_ms,
        })
        t += char_ms
    return words


class WordSplitBoundaryTests(unittest.TestCase):
    def test_budoux_detects_word_internal_boundary(self):
        self.assertTrue(_is_boundary_inside_budoux_chunk("将", "来について"))
        self.assertTrue(_is_boundary_inside_budoux_chunk("浪", "人してて"))

    def test_budoux_allows_sentence_boundary(self):
        self.assertFalse(_is_boundary_inside_budoux_chunk("。", "そう"))

    def test_merge_on_word_internal_boundary(self):
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "じっくり将"},
            {"start_ms": 500, "end_ms": 1200, "text": "来について話した"},
        ]
        words = _char_words("じっくり将来について話した")
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1200)
        self.assertEqual(count, 1)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["end_ms"], 1200)

    def test_no_merge_on_sentence_boundary(self):
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "そうです"},
            {"start_ms": 500, "end_ms": 900, "text": "。次の話"},
        ]
        words = _char_words("そうです。次の話", start_ms=0)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1200)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)

    def test_merge_on_hiragana_word_internal_boundary(self):
        """改善17-A: ひらがな境界でも BudouX 内部なら結合する。"""
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "取ろうと思っていま"},
            {"start_ms": 680, "end_ms": 1200, "text": "す。次の話"},
        ]
        words = _char_words("取ろうと思っています。次の話", start_ms=0, char_ms=80)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
        self.assertEqual(count, 1)
        self.assertEqual(len(merged), 1)

    def test_no_merge_on_unrelated_hiragana_segments(self):
        """無関係なひらがなセグメント同士は BudouX 判定で結合されない。"""
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "本当に"},
            {"start_ms": 500, "end_ms": 900, "text": "すごい"},
        ]
        words = _char_words("本当にすごい", start_ms=0, char_ms=100)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)

    def test_no_merge_when_gap_exceeds_threshold(self):
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "将"},
            {"start_ms": 2000, "end_ms": 2800, "text": "来について"},
        ]
        words = _char_words("将来について", char_ms=200)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1200)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)


class KanjiNumberFixTests(unittest.TestCase):
    def test_month_and_kilo_counters(self):
        self.assertEqual(_normalize_kanji_numbers("二キロぐらい"), "2キロぐらい")
        self.assertEqual(_normalize_kanji_numbers("まあ本当、三月"), "まあ本当、3月")
        self.assertEqual(_normalize_kanji_numbers("一浪目の九月に"), "一浪目の9月に")

    def test_ichijiki_idiom_preserved(self):
        self.assertEqual(_normalize_kanji_numbers("一時期電話で"), "一時期電話で")


class RomajiNormalizationTests(unittest.TestCase):
    def test_desu_masu_conservative(self):
        self.assertEqual(normalize_romaji_stt_artifacts("そうdesu"), "そうです")
        self.assertEqual(normalize_romaji_stt_artifacts("勉強masu。"), "勉強ます。")
        self.assertEqual(
            apply_deterministic_text_cleaning("そうdesu"),
            "そうです",
        )


class DougaWordSplitIntegrationTests(unittest.TestCase):
    """douga run コピーで step07 再実行し、将/来・浪/人 境界が結合されることを確認。"""

    RUN_SRC = Path(__file__).resolve().parents[2] / "runs" / "20260704_112903_douga"

    def setUp(self):
        if not self.RUN_SRC.exists():
            self.skipTest("douga run not available")
        self._tmp = tempfile.mkdtemp(prefix="improve16_douga_")
        self.tmp = Path(self._tmp)
        shutil.copytree(self.RUN_SRC, self.tmp / "run")

    def tearDown(self):
        if hasattr(self, "_tmp"):
            shutil.rmtree(self._tmp, ignore_errors=True)

    def test_douga_word_split_merges(self):
        run = self.tmp / "run"
        stt = run / "step02b_transcript_correct" / "stt_corrected.json"
        out = run / "step07_cut_proposal_retest"
        result = run_step(
            str(stt),
            str(run / "step04_filler_detect" / "fillers.json"),
            str(run / "step05_retake_detect" / "retakes.json"),
            str(run / "step06_scene_structure" / "scenes.json"),
            str(out),
            config={
                "min_segment_duration_ms": 1000,
                "min_segment_chars": 5,
                "word_split_merge_max_gap_ms": 1500,
            },
            vad_result_path=str(run / "step03_vad" / "vad_result.json"),
            audio_path=str(run / "step01_preprocess" / "audio.wav"),
        )
        segs = result["keep_segments"]
        merges = result["stats"].get("word_split_merges", 0)
        self.assertGreater(merges, 0, "word-split merges should occur on douga run")

        # 分割パターン (末尾/先頭) が残っていないこと
        self.assertFalse(any(s["text"].endswith("将") for s in segs))
        self.assertFalse(
            any("孔明先生も浪" in s["text"] and "浪人" not in s["text"] for s in segs)
        )

        # 結合後は同一セグメント内に連続して現れる
        self.assertTrue(any("じっくり将来" in s["text"] for s in segs))
        self.assertTrue(any("孔明先生も浪人" in s["text"] for s in segs))
        self.assertLess(len(segs), 344)


if __name__ == "__main__":
    unittest.main()
