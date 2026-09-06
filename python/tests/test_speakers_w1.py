"""フェーズW1: ElevenLabs話者分離 + 話者別テロップ色のテスト。

1. shared/speakers: dominant speaker / 発話シェアガード / チャンク境界リマップ
2. shared/stt_elevenlabs・stt_chunked: speaker_id → word.speaker の保存(無ければ省略)
3. step02: sentence への dominant speaker 付与
4. shared/direction: build_slots の speaker 付与 / sanitize_slot_directive の透過 /
   effective_slot_style の優先順位(上書き > 話者カラー > type > スナップショット) /
   build_directed_cut_content の pages/telops への透過
5. shared/telop_types: speaker_colors 設定の読み込み・正規化
6. 後方互換: speaker無しの既存run(words/sentences)が全経路でそのまま動くこと
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step02_stt
from shared.direction import (
    build_directed_cut_content,
    build_slots,
    effective_slot_style,
    sanitize_slot_directive,
)
from shared.speakers import (
    dominant_speaker,
    remap_chunk_speaker_ids,
    significant_speakers,
    speaker_colors_applicable,
)
from shared.stt_chunked import build_sentences_from_raw, raw_result_to_words
from shared.stt_elevenlabs import stt_result_to_words
from shared.telop_types import load_speaker_colors, sanitize_speaker_colors
from shared.transcript_correction import Correction, apply_transcript_corrections


def _word(start_ms, end_ms, speaker=None, text="あ", word_id="w-0000"):
    word = {"id": word_id, "text": text, "start_ms": start_ms, "end_ms": end_ms, "confidence": 0.9}
    if speaker:
        word["speaker"] = speaker
    return word


def _raw_word(start, end, speaker_id=None, text="あ", type_="word"):
    word = {"type": type_, "text": text, "start": start, "end": end, "confidence": 0.9}
    if speaker_id:
        word["speaker_id"] = speaker_id
    return word


class DominantSpeakerTests(unittest.TestCase):
    def test_dominant_by_duration(self):
        words = [
            _word(0, 3000, "speaker_0"),
            _word(3000, 4000, "speaker_1"),
            _word(4000, 4500, "speaker_1"),
        ]
        self.assertEqual(dominant_speaker(words), "speaker_0")

    def test_no_speaker_returns_none(self):
        self.assertIsNone(dominant_speaker([_word(0, 1000), _word(1000, 2000)]))
        self.assertIsNone(dominant_speaker([]))

    def test_tie_prefers_first_seen(self):
        words = [_word(0, 1000, "speaker_1"), _word(1000, 2000, "speaker_0")]
        self.assertEqual(dominant_speaker(words), "speaker_1")


class SpeakerGuardTests(unittest.TestCase):
    def test_two_speakers_with_share_activate(self):
        # speaker_0: 8秒 / speaker_1: 2秒 → シェア 80% / 20% で両方10%以上
        words = [_word(0, 8000, "speaker_0"), _word(8000, 10000, "speaker_1")]
        self.assertEqual(significant_speakers(words), ["speaker_0", "speaker_1"])
        self.assertTrue(speaker_colors_applicable(words))

    def test_minor_second_speaker_does_not_activate(self):
        # speaker_1 のシェアが 5% → 実質1人喋りとみなす
        words = [_word(0, 9500, "speaker_0"), _word(9500, 10000, "speaker_1")]
        self.assertEqual(significant_speakers(words), ["speaker_0"])
        self.assertFalse(speaker_colors_applicable(words))

    def test_no_speaker_words_do_not_activate(self):
        self.assertFalse(speaker_colors_applicable([_word(0, 5000), _word(5000, 9000)]))
        self.assertFalse(speaker_colors_applicable([]))


class ChunkRemapTests(unittest.TestCase):
    def test_single_chunk_normalizes_by_first_appearance(self):
        chunk = {"words": [
            _raw_word(0.0, 1.0, "speaker_1"),
            _raw_word(1.0, 2.0, "speaker_0"),
        ]}
        result = remap_chunk_speaker_ids([chunk], [0.0])
        ids = [w["speaker_id"] for w in result[0]["words"]]
        # 初出の speaker_1 がグローバル speaker_0 になる(発話時間同点は初出順)
        self.assertEqual(ids, ["speaker_0", "speaker_1"])
        # 入力は破壊しない
        self.assertEqual(chunk["words"][0]["speaker_id"], "speaker_1")

    def test_boundary_continuity_maps_head_to_tail(self):
        # チャンク1末尾は speaker_1(グローバルでは speaker_1)。発話の途中で切れて
        # チャンク2先頭(ローカル speaker_0)が 0.2秒後に続く → 同一話者と同定する
        chunk1 = {"words": [
            _raw_word(0.0, 8.0, "speaker_0"),
            _raw_word(8.0, 9.9, "speaker_1"),
        ]}
        chunk2 = {"words": [
            _raw_word(0.1, 2.0, "speaker_0"),   # 前チャンク末尾話者の続き
            _raw_word(2.0, 9.0, "speaker_1"),
        ]}
        result = remap_chunk_speaker_ids([chunk1, chunk2], [0.0, 10.0])
        chunk2_ids = [w["speaker_id"] for w in result[1]["words"]]
        self.assertEqual(chunk2_ids[0], "speaker_1")  # 境界連続性で前チャンク末尾と同一視
        self.assertEqual(chunk2_ids[1], "speaker_0")  # 残りは累積発話時間ランクで対応
        # グローバル話者は2人のまま(チャンクごとに増殖しない)
        all_ids = {w["speaker_id"] for c in result for w in c["words"]}
        self.assertEqual(all_ids, {"speaker_0", "speaker_1"})

    def test_large_gap_falls_back_to_duration_rank(self):
        # 境界ギャップが大きい(5秒)場合は連続性を使わず発話時間ランクで対応付ける
        chunk1 = {"words": [
            _raw_word(0.0, 7.0, "speaker_0"),   # 多く話す
            _raw_word(7.0, 9.0, "speaker_1"),
        ]}
        chunk2 = {"words": [
            _raw_word(5.0, 6.0, "speaker_1"),   # 少なく話す
            _raw_word(6.0, 13.0, "speaker_0"),  # 多く話す
        ]}
        result = remap_chunk_speaker_ids([chunk1, chunk2], [0.0, 10.0])
        chunk2_ids = [w["speaker_id"] for w in result[1]["words"]]
        # チャンク2で発話時間最大のローカル speaker_0 → 累積最大のグローバル speaker_0
        self.assertEqual(chunk2_ids, ["speaker_1", "speaker_0"])

    def test_new_speaker_gets_new_global_id(self):
        chunk1 = {"words": [_raw_word(0.0, 9.0, "speaker_0")]}
        chunk2 = {"words": [
            _raw_word(0.1, 5.0, "speaker_0"),
            _raw_word(5.5, 9.0, "speaker_1"),  # 新登場の話者
        ]}
        result = remap_chunk_speaker_ids([chunk1, chunk2], [0.0, 10.0])
        chunk2_ids = [w["speaker_id"] for w in result[1]["words"]]
        self.assertEqual(chunk2_ids[0], "speaker_0")
        self.assertEqual(chunk2_ids[1], "speaker_1")

    def test_chunks_without_speaker_pass_through(self):
        chunks = [
            {"words": [_raw_word(0.0, 1.0), _raw_word(1.0, 2.0)], "text": "a"},
            {"words": [_raw_word(0.0, 1.0)], "text": "b"},
        ]
        result = remap_chunk_speaker_ids(chunks, [0.0, 10.0])
        self.assertIs(result[0], chunks[0])
        self.assertIs(result[1], chunks[1])

    def test_spacing_entries_are_also_remapped(self):
        chunk = {"words": [
            _raw_word(0.0, 1.0, "speaker_1"),
            _raw_word(1.0, 1.1, "speaker_1", text=" ", type_="spacing"),
            _raw_word(1.1, 2.0, "speaker_1"),
        ]}
        result = remap_chunk_speaker_ids([chunk], [0.0])
        self.assertEqual([w["speaker_id"] for w in result[0]["words"]],
                         ["speaker_0", "speaker_0", "speaker_0"])


class SttSpeakerFieldTests(unittest.TestCase):
    def test_stt_result_to_words_saves_speaker(self):
        raw = {"words": [
            _raw_word(0.0, 0.5, "speaker_0", text="こん"),
            _raw_word(0.5, 1.0, "speaker_1", text="は"),
        ]}
        words = stt_result_to_words(raw)
        self.assertEqual(words[0]["speaker"], "speaker_0")
        self.assertEqual(words[1]["speaker"], "speaker_1")

    def test_stt_result_to_words_omits_field_without_speaker(self):
        raw = {"words": [_raw_word(0.0, 0.5, text="こん")]}
        words = stt_result_to_words(raw)
        self.assertNotIn("speaker", words[0])

    def test_raw_result_to_words_chunked_same_rule(self):
        raw = {"words": [_raw_word(0.0, 0.5, "speaker_2"), _raw_word(0.5, 1.0)]}
        words = raw_result_to_words(raw)
        self.assertEqual(words[0]["speaker"], "speaker_2")
        self.assertNotIn("speaker", words[1])


class SentenceSpeakerTests(unittest.TestCase):
    def test_step02_sentences_get_dominant_speaker(self):
        raw = {"utterances": [{"text": "こんにちは。", "start": 0.0, "end": 2.0}]}
        words = [
            _word(0, 1500, "speaker_0", word_id="w-0000"),
            _word(1500, 2000, "speaker_1", word_id="w-0001"),
        ]
        sentences = step02_stt._build_sentences(raw, words)
        self.assertEqual(sentences[0]["speaker"], "speaker_0")

    def test_step02_sentences_without_speaker_have_no_field(self):
        raw = {"utterances": [{"text": "こんにちは。", "start": 0.0, "end": 2.0}]}
        words = [_word(0, 2000, word_id="w-0000")]
        sentences = step02_stt._build_sentences(raw, words)
        self.assertNotIn("speaker", sentences[0])

    def test_punctuation_fallback_also_gets_speaker(self):
        words = [
            _word(0, 1000, "speaker_1", text="いく。", word_id="w-0000"),
        ]
        sentences = step02_stt._split_by_punctuation(words)
        # _split_by_punctuation 自体は speaker を扱わない(呼び出しは_build_sentences経由)
        # chunked経路の build_sentences_from_raw で同等を確認する
        chunked = build_sentences_from_raw({"utterances": []}, words)
        self.assertEqual(chunked[0]["speaker"], "speaker_1")
        self.assertEqual(len(sentences), 1)

    def test_step02b_correction_preserves_speaker(self):
        # step02b(deep copy方式)が未知フィールド speaker を保持することの確認
        stt_result = {
            "words": [_word(0, 1000, "speaker_0", text="平谷塾", word_id="w-0000")],
            "sentences": [{
                "id": "sent_0000", "text": "平谷塾", "start_ms": 0, "end_ms": 1000,
                "word_ids": ["w-0000"], "speaker": "speaker_0",
            }],
            "raw_text": "平谷塾",
        }
        corrected, _patch = apply_transcript_corrections(
            stt_result, [Correction(source="平谷塾", target="白谷塾", category="dictionary")],
        )
        self.assertEqual(corrected["words"][0]["text"], "白谷塾")
        self.assertEqual(corrected["words"][0]["speaker"], "speaker_0")
        self.assertEqual(corrected["sentences"][0]["speaker"], "speaker_0")


class BuildSlotsSpeakerTests(unittest.TestCase):
    def test_slots_get_dominant_speaker(self):
        keep_segments = [{"start_ms": 0, "end_ms": 3000, "text": "あいう"}]
        words = [
            _word(0, 2000, "speaker_0", text="あい", word_id="w-0000"),
            _word(2000, 3000, "speaker_1", text="う", word_id="w-0001"),
        ]
        slots = build_slots(keep_segments, words)
        self.assertEqual(len(slots), 1)
        self.assertEqual(slots[0]["speaker"], "speaker_0")

    def test_slots_without_speaker_have_no_field(self):
        keep_segments = [{"start_ms": 0, "end_ms": 3000, "text": "あいう"}]
        words = [_word(0, 3000, text="あいう", word_id="w-0000")]
        slots = build_slots(keep_segments, words)
        self.assertEqual(len(slots), 1)
        self.assertNotIn("speaker", slots[0])

    def test_sanitize_slot_directive_passes_speaker_through(self):
        slot = {
            "slot_id": "cut_001_s00", "cut_id": "cut_001",
            "source_start_ms": 0, "source_end_ms": 2000,
            "text": "こんにちは", "speaker": "speaker_1",
        }
        result = sanitize_slot_directive(slot, {"text": "こんにちは", "type": "default"})
        self.assertEqual(result["speaker"], "speaker_1")
        no_speaker = dict(slot)
        no_speaker.pop("speaker")
        result2 = sanitize_slot_directive(no_speaker, {"text": "こんにちは", "type": "default"})
        self.assertNotIn("speaker", result2)


SPEAKER_COLORS = {
    "apply_types": frozenset({"default", "reply"}),
    "styles": {"speaker_1": "fact_cyan", "speaker_2": "fact_green"},
}


class EffectiveSlotStyleSpeakerTests(unittest.TestCase):
    def test_speaker_color_applies_to_basic_types(self):
        slot = {"type": "default", "speaker": "speaker_1"}
        self.assertEqual(effective_slot_style(slot, None, speaker_colors=SPEAKER_COLORS), "fact_cyan")
        slot_reply = {"type": "reply", "speaker": "speaker_2"}
        self.assertEqual(effective_slot_style(slot_reply, None, speaker_colors=SPEAKER_COLORS), "fact_green")

    def test_semantic_types_keep_meaningful_colors(self):
        # apply_types 外(harsh等)は話者がいてもtype→マッピングの色を維持する
        slot = {"type": "harsh", "speaker": "speaker_1"}
        self.assertEqual(effective_slot_style(slot, None, speaker_colors=SPEAKER_COLORS), "serif_harsh")

    def test_style_override_beats_speaker_color(self):
        slot = {"type": "default", "speaker": "speaker_1", "style": "box_red", "style_overridden": True}
        self.assertEqual(effective_slot_style(slot, None, speaker_colors=SPEAKER_COLORS), "box_red")

    def test_unmapped_speaker_falls_back_to_type_mapping(self):
        # speaker_0(マッピング無し)は既定スタイルのまま
        slot = {"type": "default", "speaker": "speaker_0"}
        self.assertEqual(effective_slot_style(slot, None, speaker_colors=SPEAKER_COLORS), "fact_yellow")

    def test_none_speaker_colors_keeps_legacy_resolution(self):
        # 発動条件を満たさない(speaker_colors=None)場合は完全に従来の解決
        slot = {"type": "default", "speaker": "speaker_1"}
        self.assertEqual(effective_slot_style(slot, None), "fact_yellow")
        old_slot = {"style": "reply_cyan"}
        self.assertEqual(effective_slot_style(old_slot, None, speaker_colors=SPEAKER_COLORS), "reply_cyan")

    def test_invalid_speaker_style_sanitized_to_default(self):
        colors = {"apply_types": ("default",), "styles": {"speaker_1": "rainbow_mega"}}
        slot = {"type": "default", "speaker": "speaker_1"}
        self.assertEqual(effective_slot_style(slot, None, speaker_colors=colors), "fact_yellow")


class BuildDirectedCutContentSpeakerTests(unittest.TestCase):
    def _slot(self, **extra):
        return {
            "slot_id": "cut_001_s00", "cut_id": "cut_001",
            "start_ms": 0, "end_ms": 2000,
            "source_start_ms": 0, "source_end_ms": 2000,
            "text": "こんにちは", "type": "default",
            "style": "fact_yellow", "highlight_words": [],
            **extra,
        }

    def test_speaker_propagates_to_pages_and_telops(self):
        pages, telops = build_directed_cut_content(
            "cut_001", [self._slot(speaker="speaker_1")], [], 2000, 12,
            speaker_colors=SPEAKER_COLORS,
        )
        self.assertEqual(pages[0]["speaker"], "speaker_1")
        self.assertEqual(telops[0]["speaker"], "speaker_1")
        self.assertEqual(pages[0]["style"], "fact_cyan")
        self.assertEqual(telops[0]["style"], "fact_cyan")

    def test_without_speaker_no_field_and_legacy_style(self):
        pages, telops = build_directed_cut_content(
            "cut_001", [self._slot()], [], 2000, 12,
        )
        self.assertNotIn("speaker", pages[0])
        self.assertNotIn("speaker", telops[0])
        self.assertEqual(pages[0]["style"], "fact_yellow")


class SpeakerColorsConfigTests(unittest.TestCase):
    def test_default_yaml_provides_speaker_colors(self):
        cfg = load_speaker_colors()
        self.assertTrue(cfg["enabled"])
        self.assertEqual(cfg["apply_types"], ["default", "reply"])
        self.assertEqual(cfg["styles"], {"speaker_1": "fact_cyan", "speaker_2": "fact_green"})

    def test_user_file_overrides_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            user_path = Path(tmp) / "mapping.json"
            user_path.write_text(json.dumps({
                "type_styles": {},
                "speaker_colors": {
                    "enabled": False,
                    "styles": {"speaker_1": "question_blue"},
                },
            }), encoding="utf-8")
            cfg = load_speaker_colors(user_file=user_path)
        self.assertFalse(cfg["enabled"])
        self.assertEqual(cfg["styles"], {"speaker_1": "question_blue"})
        # 未指定フィールドは既定を維持する
        self.assertEqual(cfg["apply_types"], ["default", "reply"])

    def test_sanitize_rejects_invalid_values(self):
        self.assertEqual(sanitize_speaker_colors(None), {})
        self.assertEqual(sanitize_speaker_colors("x"), {})
        partial = sanitize_speaker_colors({
            "enabled": "yes",                      # bool以外は捨てる
            "apply_types": ["default", "unknown"],  # 未知typeは除去
            "styles": {"speaker_1": "", "": "fact_cyan", "speaker_2": "fact_green"},
        })
        self.assertNotIn("enabled", partial)
        self.assertEqual(partial["apply_types"], ["default"])
        self.assertEqual(partial["styles"], {"speaker_2": "fact_green"})


if __name__ == "__main__":
    unittest.main()
