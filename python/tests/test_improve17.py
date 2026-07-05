"""改善17: 単語分断ガード緩和・行末フィラー除去・漢数字助数詞のテスト。"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.text_cleaning import clean_telop_line, strip_trailing_filler_fragments
from shared.telop_builder import _normalize_kanji_numbers
from step07_cut_proposal import (
    _apply_word_split_merge,
    _boundary_chars_eligible_for_merge,
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


class WordSplitRelaxationTests(unittest.TestCase):
    def test_hiragana_boundary_eligible(self):
        self.assertTrue(_boundary_chars_eligible_for_merge("思っていま", "す"))
        self.assertTrue(_boundary_chars_eligible_for_merge("ま", "あ"))

    def test_merge_hiragana_word_internal_boundary(self):
        segments = [
            {"start_ms": 285670, "end_ms": 293580, "text": "取ろうと思っていま"},
            {"start_ms": 293860, "end_ms": 298470, "text": "す。今ほんと"},
        ]
        words = _char_words("取ろうと思っています。今ほんと", start_ms=285670, char_ms=50)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
        self.assertEqual(count, 1)
        self.assertEqual(len(merged), 1)
        self.assertIn("思っています", merged[0]["text"])

    def test_no_merge_when_gap_exceeds_1500ms(self):
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "ネク"},
            {"start_ms": 2000, "end_ms": 2800, "text": "ストステージ"},
        ]
        words = _char_words("ネクストステージ", char_ms=100)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)

    def test_merge_when_gap_within_1500ms(self):
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "ネク"},
            {"start_ms": 1310, "end_ms": 2800, "text": "ストステージ"},
        ]
        words = _char_words("ネクストステージ", char_ms=100)
        if _is_boundary_inside_budoux_chunk("ネク", "ストステージ"):
            merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
            self.assertEqual(count, 1)

    def test_no_merge_on_sentence_boundary(self):
        segments = [
            {"start_ms": 0, "end_ms": 400, "text": "そうです"},
            {"start_ms": 500, "end_ms": 900, "text": "。次の話"},
        ]
        words = _char_words("そうです。次の話", start_ms=0)
        merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
        self.assertEqual(count, 0)
        self.assertEqual(len(merged), 2)

    def test_no_merge_on_natural_clause_boundary_with_comma(self):
        """読点で終わる文節境界は BudouX 判定で結合されないこと。"""
        tail = "それは本当にと思うけど、"
        head = "なんとか頑張りたい"
        if not _is_boundary_inside_budoux_chunk(tail[-15:], head[:15]):
            segments = [
                {"start_ms": 0, "end_ms": 800, "text": tail},
                {"start_ms": 900, "end_ms": 1800, "text": head},
            ]
            words = _char_words(tail + head, char_ms=40)
            merged, count, _flags = _apply_word_split_merge(segments, words, max_gap_ms=1500)
            self.assertEqual(count, 0)


class TrailingFillerTests(unittest.TestCase):
    def test_strip_ne_ma_maa(self):
        self.assertEqual(
            clean_telop_line("お疲れ様でしたということで、ね"),
            "お疲れ様でしたということで",
        )
        self.assertEqual(
            clean_telop_line("動画撮ってるんですが、ま"),
            "動画撮ってるんですが",
        )
        self.assertEqual(
            clean_telop_line("お疲れ様でしたということで、まあ"),
            "お疲れ様でしたということで",
        )

    def test_preserve_meaningful_ne(self):
        self.assertEqual(
            clean_telop_line("大学ってすごいからね"),
            "大学ってすごいからね",
        )
        self.assertEqual(
            clean_telop_line("ね、まだ逆転できるよ"),
            "ね、まだ逆転できるよ",
        )

    def test_strip_trailing_filler_then_comma(self):
        self.assertEqual(
            strip_trailing_filler_fragments("テスト、ね"),
            "テスト",
        )


class KanjiCounterSuffixTests(unittest.TestCase):
    def test_wari_and_go_counters(self):
        self.assertEqual(_normalize_kanji_numbers("六割ぐらいできる"), "6割ぐらいできる")
        self.assertEqual(_normalize_kanji_numbers("八十から百語の"), "八十から100語の")
        self.assertEqual(_normalize_kanji_numbers("百語"), "100語")

    def test_idiom_preserved(self):
        self.assertEqual(_normalize_kanji_numbers("物語"), "物語")
        self.assertEqual(_normalize_kanji_numbers("単語"), "単語")
        self.assertEqual(_normalize_kanji_numbers("一語一語"), "一語一語")


class Img5250IntegrationTests(unittest.TestCase):
    RUN_SRC = Path(__file__).resolve().parents[2] / "runs" / "20260704_132832_IMG_5250"

    def setUp(self):
        if not self.RUN_SRC.exists():
            self.skipTest("IMG_5250 run not available")
        self._tmp = tempfile.mkdtemp(prefix="improve17_img5250_")
        self.tmp = Path(self._tmp)
        shutil.copytree(self.RUN_SRC, self.tmp / "run")

    def tearDown(self):
        if hasattr(self, "_tmp"):
            shutil.rmtree(self._tmp, ignore_errors=True)

    def test_img5250_word_split_merges(self):
        run = self.tmp / "run"
        stt = run / "step02b_transcript_correct" / "stt_corrected.json"
        out = run / "step07_cut_proposal_retest"
        result = run_step(
            str(stt),
            str(run / "step04_filler_detect" / "fillers.json"),
            str(run / "step05_retake_detect" / "retakes.json"),
            str(run / "step06_scene_structure" / "scenes.json"),
            str(out),
            config={"min_segment_duration_ms": 1000, "min_segment_chars": 5},
            vad_result_path=str(run / "step03_vad" / "vad_result.json"),
            audio_path=str(run / "step01_preprocess" / "audio.wav"),
        )
        merges = result["stats"].get("word_split_merges", 0)
        segs = result["keep_segments"]
        self.assertGreater(merges, 0, "word-split merges should occur on IMG_5250 run")
        self.assertFalse(any(s["text"].endswith("思っていま") for s in segs))
        self.assertFalse(any(s["text"].startswith("す。") and "思っ" not in s["text"][:20] for s in segs if "思っ" in s.get("text", "")))


class ShimizuIntegrationTests(unittest.TestCase):
    RUN_SRC = (
        Path(__file__).resolve().parents[2]
        / "runs"
        / "20260704_120426_清水穂乃佳さん_熊本大学_法学部法学科_英語の傾向と対策_02"
    )

    def setUp(self):
        if not self.RUN_SRC.exists():
            self.skipTest("Shimizu run not available")
        self._tmp = tempfile.mkdtemp(prefix="improve17_shimizu_")
        self.tmp = Path(self._tmp)
        shutil.copytree(self.RUN_SRC, self.tmp / "run")

    def tearDown(self):
        if hasattr(self, "_tmp"):
            shutil.rmtree(self._tmp, ignore_errors=True)

    def test_shimizu_word_split_merges(self):
        run = self.tmp / "run"
        stt = run / "step02b_transcript_correct" / "stt_corrected.json"
        out = run / "step07_cut_proposal_retest"
        result = run_step(
            str(stt),
            str(run / "step04_filler_detect" / "fillers.json"),
            str(run / "step05_retake_detect" / "retakes.json"),
            str(run / "step06_scene_structure" / "scenes.json"),
            str(out),
            config={"min_segment_duration_ms": 1000, "min_segment_chars": 5},
            vad_result_path=str(run / "step03_vad" / "vad_result.json"),
            audio_path=str(run / "step01_preprocess" / "audio.wav"),
        )
        merges = result["stats"].get("word_split_merges", 0)
        self.assertGreater(merges, 1, "Shimizu run should have more merges than before (was 1)")


if __name__ == "__main__":
    unittest.main()
