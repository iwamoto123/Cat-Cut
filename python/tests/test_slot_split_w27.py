"""フェーズW27: スロット強制分割の遡り(ぶつ切り対策)と文脈忠実性チェックのテスト。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import (
    _split_words_into_runs,
    sanitize_slot_directive,
)


def _word(text, start_ms, end_ms):
    return {"text": text, "start_ms": start_ms, "end_ms": end_ms}


class TestForceBreakLookback(unittest.TestCase):
    def test_force_break_prefers_particle_boundary(self):
        """4秒上限の強制分割は、語の途中でなく助詞語尾まで遡って切る。

        「過去の指導データに / 基づいて具体的に…」のように「に」の直後で切れること
        (従来は上限到達位置の単語でぶつ切りされていた)。
        """
        # 隙間なく連続する単語列(自然分割が発生しない)。計5.6秒でMAX 4秒を超える
        words = [
            _word("過去の", 0, 800),
            _word("指導データに", 800, 1800),
            _word("基づいて", 1800, 2600),
            _word("具体的に", 2600, 3400),
            _word("アドバイスを", 3400, 4200),
            _word("することが", 4200, 5000),
            _word("できます", 5000, 5600),
        ]
        runs = _split_words_into_runs(words, 0)
        self.assertGreaterEqual(len(runs), 2)
        first_texts = "".join(w["text"] for w in runs[0])
        # 遡り候補(「〜に」語尾)で切れている=前半が助詞で終わる
        self.assertTrue(first_texts.endswith("に"), f"前半が切れ目らしくない: {first_texts}")
        # 全単語がいずれかのrunに含まれる(持ち越しの取りこぼしなし)
        all_texts = "".join(w["text"] for run in runs for w in run)
        self.assertEqual(all_texts, "".join(w["text"] for w in words))

    def test_force_break_without_candidate_falls_back(self):
        """遡り候補が無い場合は従来どおり上限到達位置で切る(スロット肥大を防ぐ)。"""
        words = [
            _word("あいうえおかきくけこ", 0, 2000),
            _word("さしすせそたちつてと", 2000, 4000),
            _word("なにぬねのはひふへほ", 4000, 6000),
        ]
        runs = _split_words_into_runs(words, 0)
        self.assertEqual(len(runs), 2)

    def test_natural_break_unchanged(self):
        """ギャップ・文末記号による自然分割は従来のまま。"""
        words = [
            _word("こんにちは。", 0, 2200),
            _word("今日は", 3000, 3800),
            _word("いい天気です", 3800, 5000),
        ]
        runs = _split_words_into_runs(words, 0)
        self.assertEqual(len(runs), 2)
        self.assertEqual("".join(w["text"] for w in runs[0]), "こんにちは。")


class TestSemanticChunkSplit(unittest.TestCase):
    """フェーズW30: 意味の塊(文・文節)ベースの分割。"""

    def test_sentence_end_always_breaks_even_before_2s(self):
        """文末では時間に関係なく切る(前の文の終わりと次の文の頭を同居させない)。

        従来はMIN_SLOT_MS(2秒)未満では切れず「長くはありませんそして部活が…」の
        ような2文同居テロップが大量発生していた。
        """
        words = [
            _word("長くは", 0, 400),
            _word("ありません。", 400, 1000),
            _word("そして", 1100, 1500),
            _word("部活が終わったら", 1500, 2400),
            _word("頑張ろうと", 2400, 3000),
        ]
        runs = _split_words_into_runs(words, 0)
        self.assertGreaterEqual(len(runs), 2)
        self.assertEqual("".join(w["text"] for w in runs[0]), "長くはありません。")

    def test_clause_break_at_target_chars(self):
        """文節の切れ目では目標文字数(1行分)を超えたら切る。"""
        words = [
            _word("志望校の", 0, 600),
            _word("配点に合わせて", 600, 1500),  # ここまで11字(target=11到達)・「て」語尾
            _word("勝負する教科を", 1500, 2400),
            _word("決めていきます", 2400, 3200),
        ]
        runs = _split_words_into_runs(words, 0, target_chars=11, max_chars=22)
        self.assertEqual(len(runs), 2)
        self.assertEqual("".join(w["text"] for w in runs[0]), "志望校の配点に合わせて")

    def test_no_mid_word_break_when_stt_words_split_morphemes(self):
        """STT単語が語の途中で切れていても、BudouX文節境界以外では切らない。

        実出力の再発例: 「残された時間は決し / て長くはありません」(「決して」の語中切り)。
        「決し」が語尾「し」の助詞近似にマッチして切られていた。
        """
        words = [
            _word("部活と受験を", 0, 800),
            _word("両立してきた", 800, 1600),
            _word("現役生にとって", 1600, 2400),
            _word("残された時間は決し", 2400, 3200),
            _word("て長くはありません", 3200, 4000),
        ]
        runs = _split_words_into_runs(words, 0, target_chars=11, max_chars=22)
        for run in runs:
            text = "".join(w["text"] for w in run)
            self.assertFalse(text.endswith("決し"), f"語中切りが発生: {text}")

    def test_tail_fragment_merges_into_previous_run(self):
        """末尾に数文字の断片が残る場合は前のrunへ併合する(「模試の」単独テロップ対策)。"""
        words = [
            _word("結果を見て", 0, 800),
            _word("判断します。", 800, 1600),
            _word("模試の", 1700, 2100),
        ]
        runs = _split_words_into_runs(words, 0)
        self.assertEqual(len(runs), 1)
        self.assertEqual(
            "".join(w["text"] for w in runs[0]), "結果を見て判断します。模試の"
        )


class TestContextFaithfulness(unittest.TestCase):
    def test_neighbor_fragment_absorption_is_faithful(self):
        """隣接スロットから語の断片を取り込む修正は context_text 付きなら差し戻されない。"""
        slot = {
            "slot_id": "cut_001_s01",
            "cut_id": "cut_001",
            "source_start_ms": 4000,
            "source_end_ms": 8000,
            "text": "宮崎を拠点に創業",
        }
        raw = {"text": "宮崎を拠点に創業19年", "type": "default"}
        # context_text 無し: 「19」が元発話に無いが、内容語の過半ルールでは通る場合も
        # あるため、ここでは context 付きの動作だけを保証する
        result = sanitize_slot_directive(
            slot, raw, context_text="す私たち白谷塾は宮崎を拠点に創業19年2000人以上の",
        )
        self.assertFalse(result["fallback"])
        self.assertEqual(result["text"], "宮崎を拠点に創業19年")

    def test_wrong_number_falls_back(self):
        """数値の捏造(十七年→19年)は過半ルールを満たしても即差し戻す。"""
        slot = {
            "slot_id": "cut_001_s01",
            "cut_id": "cut_001",
            "source_start_ms": 4000,
            "source_end_ms": 8000,
            "text": "宮崎を拠点に創業から十七年、二千人以上の受験生を指導してきました",
        }
        raw = {"text": "宮崎を拠点に創業19年、2000人以上の受験生を指導", "type": "default"}
        result = sanitize_slot_directive(slot, raw)
        self.assertTrue(result["fallback"])
        # 正しい変換(十七年→17年)は通る
        raw_ok = {"text": "宮崎を拠点に創業17年、2000人以上の受験生を指導してきました", "type": "default"}
        result_ok = sanitize_slot_directive(slot, raw_ok)
        self.assertFalse(result_ok["fallback"])

    def test_unrelated_text_still_falls_back(self):
        """文脈に無い内容の創作は context_text 付きでも差し戻す。"""
        slot = {
            "slot_id": "cut_001_s01",
            "cut_id": "cut_001",
            "source_start_ms": 4000,
            "source_end_ms": 8000,
            "text": "宮崎を拠点に創業",
        }
        raw = {"text": "東京で株式上場を果たした企業です", "type": "default"}
        result = sanitize_slot_directive(
            slot, raw, context_text="す私たち白谷塾は宮崎を拠点に創業19年2000人以上の",
        )
        self.assertTrue(result["fallback"])
        self.assertEqual(result["text"], "宮崎を拠点に創業")


if __name__ == "__main__":
    unittest.main()
