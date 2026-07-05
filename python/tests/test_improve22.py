"""改善22: ページ→wordマッピング頑健化・表記統一・並列漢数字のテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.telop_builder import (
    _find_page_position,
    _map_pages_to_telops,
    _normalize_kanji_numbers,
    _normalize_proper_nouns,
)
from step06b_ai_refine import build_prompt, extract_notation_variants


def _make_words(text: str) -> list:
    """1文字=1word の words_in_range を生成する (実データのSTT形式に合わせる)。"""
    words = []
    for i, ch in enumerate(text):
        words.append({"text": ch, "start_ms": i * 100, "end_ms": (i + 1) * 100})
    return words


def _make_voice_words(words: list) -> list:
    return [
        {"text": w["text"], "start": w["start_ms"] / 1000.0, "end": w["end_ms"] / 1000.0}
        for w in words
    ]


class PageMappingImprove22Tests(unittest.TestCase):
    """22-A: カット境界の先頭文字欠け・重複テキスト誤マッチ・完全一致不能の各ケース。"""

    def _map(self, words_text: str, pages: list) -> list:
        words = _make_words(words_text)
        return _map_pages_to_telops(pages, _make_voice_words(words), words)

    def test_leading_char_missing_with_duplicate_text_later(self):
        # videoplayback_6 cut_008 の再現: words は「クセンチュアの…」で始まり (先頭「ア」欠け)、
        # 同一テキスト「アクセンチュアの」が後方に再出現する
        words_text = (
            "クセンチュアのコンサルタントではあったんですけど色々やってました"
            "アクセンチュアの中でも珍しい部署があります"
        )
        pages = [
            {"id": "c_p00", "lines": ["アクセンチュアの"]},
            {"id": "c_p01", "lines": ["コンサルタントでは"]},
        ]
        telops = self._map(words_text, pages)
        # p00 は後方 (index 32〜) ではなく先頭の「クセンチュアの」(0〜6) にマッチする
        self.assertEqual(min(telops[0]["word_indices"]), 0)
        self.assertLessEqual(max(telops[0]["word_indices"]), 7)
        # p01 も連鎖ズレせず「コンサルタントでは」(7〜15) にマッチする
        self.assertEqual(min(telops[1]["word_indices"]), 7)
        self.assertEqual(max(telops[1]["word_indices"]), 15)

    def test_exact_match_still_works(self):
        words_text = "今日はいい天気ですね散歩に行きましょう"
        pages = [
            {"id": "c_p00", "lines": ["今日はいい天気ですね"]},
            {"id": "c_p01", "lines": ["散歩に行きましょう"]},
        ]
        telops = self._map(words_text, pages)
        self.assertEqual(telops[0]["word_indices"], list(range(0, 10)))
        self.assertEqual(telops[1]["word_indices"], list(range(10, 19)))

    def test_fuzzy_match_recovers_position(self):
        # ページ中央の1文字が words と異なる (STT誤認識をAI校正で直した場合など)。
        # 完全一致は失敗するが、difflib のファジーマッチで近傍位置に置かれる
        words_text = "これはとても大きな問題だと思いますので対応します"
        pages = [
            {"id": "c_p00", "lines": ["これはとっても大きな問題"]},
            {"id": "c_p01", "lines": ["だと思いますので"]},
        ]
        telops = self._map(words_text, pages)
        self.assertEqual(min(telops[0]["word_indices"]), 0)
        # p01 が p00 の推定位置から連鎖的に大きくズレない
        self.assertLessEqual(min(telops[1]["word_indices"]), 12)

    def test_unmatchable_page_falls_back_to_offset(self):
        # どの方法でも位置が確定しない場合は従来どおり期待位置 (offset) に置く
        words_text = "あいうえおかきくけこさしすせそ"
        pages = [
            {"id": "c_p00", "lines": ["あいうえお"]},
            {"id": "c_p01", "lines": ["ほげほげ"]},
            {"id": "c_p02", "lines": ["さしすせそ"]},
        ]
        telops = self._map(words_text, pages)
        self.assertEqual(telops[0]["word_indices"], [0, 1, 2, 3, 4])
        # p01 はマッチ不能 → offset=5 に置かれる
        self.assertEqual(min(telops[1]["word_indices"]), 5)
        # p02 は後続の完全一致で復帰する
        self.assertEqual(telops[2]["word_indices"], [10, 11, 12, 13, 14])

    def test_monotonic_no_backtrack(self):
        # マッチ位置は必ず offset 以上 (後戻り禁止)
        full_text = "あああいいいあああ"
        pos, length = _find_page_position(full_text, "あああ", 4)
        self.assertGreaterEqual(pos, 4)
        self.assertEqual(length, 3)

    def test_far_jump_is_rejected(self):
        # 完全一致が期待位置から大きく飛んでいる場合は採用しない
        full_text = "x" * 50 + "アクセンチュアの"
        pos, _length = _find_page_position(full_text, "アクセンチュアの", 0)
        # 飛び幅50 > max(8*2, 20) なので誤マッチせず offset に置かれる
        self.assertEqual(pos, 0)


class ProperNounImprove22Tests(unittest.TestCase):
    """22-B (決定的レイヤー): カナ表記→正式表記の変換。"""

    def test_katakana_youtube(self):
        self.assertEqual(_normalize_proper_nouns("ユーチューブで発信"), "YouTubeで発信")

    def test_katakana_linkedin_both_variants(self):
        self.assertEqual(_normalize_proper_nouns("リンクトインとリンクドイン"), "LinkedInとLinkedIn")

    def test_katakana_others(self):
        self.assertEqual(_normalize_proper_nouns("インスタグラム"), "Instagram")
        self.assertEqual(_normalize_proper_nouns("ツイッター"), "X")
        self.assertEqual(_normalize_proper_nouns("フェイスブック"), "Facebook")
        self.assertEqual(_normalize_proper_nouns("ティックトック"), "TikTok")


class NotationVariantsTests(unittest.TestCase):
    """22-B (AIレイヤー): 表記揺れ候補の抽出とプロンプト注入。"""

    def test_katakana_vs_latin_variants_detected(self):
        text = "ユーチューブを見る。YouTubeを開く。ユーチューブが好き。YouTubeは楽しい。YouTube最高。"
        groups = extract_notation_variants(text)
        target = [g for g in groups if g["canonical"] == "YouTube"]
        self.assertEqual(len(target), 1)
        variants = dict(target[0]["variants"])
        self.assertEqual(variants["YouTube"], 3)
        self.assertEqual(variants["ユーチューブ"], 2)

    def test_alnum_case_variants_grouped_by_key(self):
        text = "BtoBの営業。B2Bではなくbtobと書く人もいるがBtoBが多い。BtoB向けだ。b2bも。"
        groups = extract_notation_variants(text)
        target = [g for g in groups if g["canonical"] == "BtoB"]
        self.assertEqual(len(target), 1)
        self.assertGreaterEqual(len(target[0]["variants"]), 2)

    def test_near_katakana_pair_detected(self):
        # 編集距離2以内・両方2回以上の近似カタカナ語ペア (フォーメイ業/フォーム営業 相当)
        text = "フォーメイ業をやる。フォーム営業が本業。フォーメイ業とは。フォーム営業です。"
        groups = extract_notation_variants(text)
        pair = [
            g for g in groups
            if {v for v, _ in g["variants"]} == {"フォーメイ", "フォーム"}
        ]
        self.assertEqual(len(pair), 1)

    def test_near_pair_requires_min_count(self):
        # 出現1回同士の近似ペアは候補にしない (過剰検出防止)
        text = "トレンドの話。マインドの話。"
        groups = extract_notation_variants(text)
        self.assertEqual(groups, [])

    def test_dissimilar_words_not_paired(self):
        # 先頭2文字が異なる短い類似語 (ツール/ハードル等) は誤爆しない
        text = "ツールを使う。ツールが便利。ハードルが高い。ハードルを下げる。"
        groups = extract_notation_variants(text)
        self.assertEqual(groups, [])

    def test_prompt_injection_with_variants(self):
        variants = [
            {"canonical": "YouTube", "variants": [("YouTube", 25), ("ユーチューブ", 18)]},
        ]
        prompt = build_prompt("テスト全文", [], 12, 1, notation_variants=variants)
        self.assertIn("表記が揺れている語", prompt)
        self.assertIn("YouTube / ユーチューブ → YouTube", prompt)
        self.assertIn("25回 vs 18回", prompt)

    def test_prompt_omits_section_when_no_variants(self):
        prompt = build_prompt("テスト全文", [], 12, 1, notation_variants=None)
        self.assertNotIn("表記が揺れている語", prompt)

    def test_prompt_includes_name_unification_instruction(self):
        prompt = build_prompt("テスト全文", [], 12, 1)
        self.assertIn("最頻の表記に統一", prompt)


class ParallelKanjiNumberTests(unittest.TestCase):
    """22-C: 並列漢数字 (「二、3件」等) の前半算用化と誤爆防止。"""

    def test_parallel_with_comma(self):
        self.assertEqual(_normalize_kanji_numbers("二、3件"), "2、3件")

    def test_parallel_with_space(self):
        self.assertEqual(_normalize_kanji_numbers("二 3件"), "2、3件")

    def test_parallel_with_larger_number(self):
        self.assertEqual(_normalize_kanji_numbers("二、30社"), "2、30社")
        self.assertEqual(_normalize_kanji_numbers("二 3000円"), "2、3000円")

    def test_parallel_both_kanji(self):
        # 後半が助数詞付き変換で算用化された後、前半も並列として算用化される
        self.assertEqual(_normalize_kanji_numbers("二、三件"), "2、3件")
        self.assertEqual(_normalize_kanji_numbers("五、六回"), "5、6回")

    def test_enumeration_comma_not_converted(self):
        # 列挙の読点 (直後が算用数字＋助数詞でない) は変換しない
        self.assertEqual(_normalize_kanji_numbers("一、しかし考えると"), "一、しかし考えると")

    def test_idiom_protection_kept(self):
        self.assertEqual(_normalize_kanji_numbers("万一、3件あっても"), "万一、3件あっても")
        self.assertEqual(_normalize_kanji_numbers("万全です"), "万全です")

    def test_multi_digit_kanji_prefix_not_converted(self):
        # 1〜9 の単純な並列のみ対象 (「十二、3件」は対象外)
        self.assertEqual(_normalize_kanji_numbers("十二、3件"), "十二、3件")

    def test_existing_conversion_not_broken(self):
        self.assertEqual(_normalize_kanji_numbers("三十八度"), "38度")
        self.assertEqual(_normalize_kanji_numbers("五十六点"), "56点")


if __name__ == "__main__":
    unittest.main()
