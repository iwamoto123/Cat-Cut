"""フェーズT2(シーン演出決定エンジン・AIパス3)のテスト。

1. スロット分割ロジック (shared/direction.build_slots)
2. AI出力のパース・バリデーション (sanitize_* / apply_slot_responses)
3. フォールバック安全弁 (is_text_faithful / sanitize_slot_directive)
4. step06c_direction.run_step (LLMモック / キー無しフォールバック)
5. step08_composition の directed 分岐 (composition.json の構造)

LLM呼び出しはすべてモックし、APIキー無しで実行できる。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import step06c_direction
import step08_composition
from shared.direction import (
    DEFAULT_DIRECTIVE_STYLE,
    MAX_SLOT_MS,
    build_directed_cut_content,
    build_directed_overlays,
    build_slots,
    is_text_faithful,
    map_source_ms_to_timeline,
    sanitize_chapters,
    sanitize_highlight_words,
    sanitize_overlay_suggestion,
    sanitize_slot_directive,
    sanitize_style,
    select_slots_for_cut,
    wrap_directive_lines,
)
from shared.textwidth import glyph_length


def make_words(specs):
    """[(text, start_ms, end_ms)] から STT words を組み立てる。"""
    return [{"text": t, "start_ms": s, "end_ms": e} for t, s, e in specs]


class BuildSlotsTests(unittest.TestCase):
    """スロット分割ロジック(決定的前処理)。"""

    def test_short_cut_becomes_single_slot(self):
        # 3秒のカット → 1スロット(カット全体をカバー)
        words = make_words([("今日は", 1000, 1500), ("テスト", 1600, 2200), ("です", 2300, 3500)])
        segs = [{"start_ms": 800, "end_ms": 3800, "text": "今日はテストです"}]
        slots = build_slots(segs, words)
        self.assertEqual(len(slots), 1)
        slot = slots[0]
        self.assertEqual(slot["slot_id"], "cut_001_s00")
        self.assertEqual(slot["cut_id"], "cut_001")
        self.assertEqual((slot["start_ms"], slot["end_ms"]), (0, 3000))
        self.assertEqual((slot["source_start_ms"], slot["source_end_ms"]), (800, 3800))
        self.assertEqual(slot["text"], "今日はテストです")

    def test_long_cut_is_split_at_gap_after_min_duration(self):
        # 2.5秒発話 + 600msギャップ + 2.5秒発話 → ギャップで2スロットに分割
        words = make_words([
            ("前半の", 0, 1200), ("発話です", 1300, 2500),
            ("後半の", 3100, 4300), ("発話です", 4400, 5600),
        ])
        segs = [{"start_ms": 0, "end_ms": 5600, "text": ""}]
        slots = build_slots(segs, words)
        self.assertEqual(len(slots), 2)
        # 境界は前run終端(2500)と次run先頭(3100)の中点=2800
        self.assertEqual(slots[0]["end_ms"], 2800)
        self.assertEqual(slots[1]["start_ms"], 2800)
        self.assertEqual(slots[0]["text"], "前半の発話です")
        self.assertEqual(slots[1]["text"], "後半の発話です")

    def test_slots_cover_cut_without_gaps(self):
        # 分割してもスロット列はカット全体([0, duration])を隙間なくカバーする
        # (W30: 意味の塊分割は文字数基準のため、文末で切れる長さの単語列を使う)
        words = make_words([
            ("今日は", 0, 2200), ("いい天気です。", 2250, 2500),
            ("明日は", 2600, 4800), ("雨のようです。", 4850, 5100),
            ("傘を持って出かけましょう", 5200, 7000),
        ])
        segs = [{"start_ms": 0, "end_ms": 7500, "text": ""}]
        slots = build_slots(segs, words)
        self.assertGreater(len(slots), 1)
        self.assertEqual(slots[0]["start_ms"], 0)
        self.assertEqual(slots[-1]["end_ms"], 7500)
        for prev, nxt in zip(slots, slots[1:]):
            self.assertEqual(prev["end_ms"], nxt["start_ms"])

    def test_continuous_speech_is_force_split_before_max(self):
        # ギャップ・文末が無い連続発話でも MAX_SLOT_MS を大きく超えるスロットを作らない
        words = make_words([(f"語{i}", i * 500, i * 500 + 480) for i in range(24)])  # 12秒連続
        segs = [{"start_ms": 0, "end_ms": 12000, "text": ""}]
        slots = build_slots(segs, words)
        self.assertGreater(len(slots), 2)
        for slot in slots:
            # 境界が中点に置かれるため、多少の余裕(+500ms)を許容して上限を検査する
            self.assertLessEqual(slot["end_ms"] - slot["start_ms"], MAX_SLOT_MS + 500)

    def test_cut_without_words_falls_back_to_segment_text(self):
        segs = [{"start_ms": 1000, "end_ms": 3000, "text": "セグメント本文。"}]
        slots = build_slots(segs, [])
        self.assertEqual(len(slots), 1)
        self.assertEqual(slots[0]["text"], "セグメント本文")  # 「。」は除去
        self.assertEqual(slots[0]["end_ms"], 2000)

    def test_multiple_cuts_are_numbered_independently(self):
        words = make_words([("カット1", 0, 2000), ("カット2", 10000, 12000)])
        segs = [
            {"start_ms": 0, "end_ms": 2500, "text": ""},
            {"start_ms": 9500, "end_ms": 12500, "text": ""},
        ]
        slots = build_slots(segs, words)
        self.assertEqual([s["slot_id"] for s in slots], ["cut_001_s00", "cut_002_s00"])
        self.assertEqual(slots[1]["source_start_ms"], 9500)


class FaithfulnessTests(unittest.TestCase):
    """フォールバック安全弁(元発話との照合)。"""

    def test_light_rewrite_is_faithful(self):
        source = "毎月30万円の売上がえー出てるんですけれどもやっぱりすごいなと"
        candidate = "毎月30万円の売上が出てるのはすごい"
        self.assertTrue(is_text_faithful(source, candidate))

    def test_fabricated_content_is_unfaithful(self):
        source = "今日は天気がいいですね"
        candidate = "年商1億円を達成した秘密の方法"
        self.assertFalse(is_text_faithful(source, candidate))

    def test_kanji_number_normalization_is_tolerated(self):
        # 元発話「三十万円」をAIが「30万円」に整形しても忠実と判定する
        self.assertTrue(is_text_faithful("月に三十万円ぐらいの利益", "月30万円の利益"))

    def test_empty_candidate_is_faithful(self):
        # 内容語が無い候補(ひらがなのみ等)は判定不能なので通す(創作リスクが低い)
        self.assertTrue(is_text_faithful("そうですね", "そうですね"))


class SanitizeTests(unittest.TestCase):
    """AI出力のパース・バリデーション。"""

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

    def test_valid_response_is_accepted(self):
        raw = {"text": "毎月30万円の売上が出てます", "style": "emotion_red", "highlight_words": ["30万円"]}
        directive = sanitize_slot_directive(self.SLOT, raw)
        self.assertEqual(directive["text"], "毎月30万円の売上が出てます")
        self.assertEqual(directive["style"], "emotion_red")
        self.assertEqual(directive["highlight_words"], ["30万円"])
        self.assertFalse(directive["fallback"])
        self.assertEqual(directive["source_start_ms"], 800)

    def test_natural_line_break_is_preserved(self):
        # AIの自然改行("\n")は保持し、忠実性チェックは改行を除いた文字列で行う
        raw = {"text": "毎月30万円の売上が\n出てます", "style": "emotion_red"}
        directive = sanitize_slot_directive(self.SLOT, raw)
        self.assertEqual(directive["text"], "毎月30万円の売上が\n出てます")
        self.assertFalse(directive["fallback"])

    def test_line_break_normalization(self):
        # CRLF・連続改行・行頭行末の空白は正規化する
        raw = {"text": "毎月30万円の売上が \r\n\n 出てます", "style": "emotion_red"}
        directive = sanitize_slot_directive(self.SLOT, raw)
        self.assertEqual(directive["text"], "毎月30万円の売上が\n出てます")

    def test_max_text_chars_ignores_line_breaks(self):
        # 文字数上限の判定は改行を除いた実文字数で行う(改行が上限超過の引き金にならない)
        raw = {"text": "毎月30万円の売上が\n出てます", "style": "emotion_red"}
        flat_len = glyph_length("毎月30万円の売上が出てます", "weighted_cpl")
        directive = sanitize_slot_directive(self.SLOT, raw, max_text_chars=flat_len)
        self.assertEqual(directive["text"], "毎月30万円の売上が\n出てます")
        self.assertFalse(directive["fallback"])

    def test_unfaithful_text_falls_back_to_source(self):
        raw = {"text": "秘密の裏技で年収を10倍にする方法", "style": "fact_yellow"}
        directive = sanitize_slot_directive(self.SLOT, raw)
        self.assertEqual(directive["text"], self.SLOT["text"])
        self.assertTrue(directive["fallback"])

    def test_missing_response_falls_back_with_default_style(self):
        directive = sanitize_slot_directive(self.SLOT, None)
        self.assertEqual(directive["text"], self.SLOT["text"])
        self.assertEqual(directive["style"], DEFAULT_DIRECTIVE_STYLE)
        self.assertTrue(directive["fallback"])

    def test_unknown_style_is_normalized(self):
        self.assertEqual(sanitize_style("rainbow_mega"), DEFAULT_DIRECTIVE_STYLE)
        self.assertEqual(sanitize_style("op_brush"), DEFAULT_DIRECTIVE_STYLE)  # OP専用は選択不可
        self.assertEqual(sanitize_style("question_blue"), "question_blue")

    def test_highlight_words_must_exist_in_text(self):
        result = sanitize_highlight_words(["30万円", "存在しない語", "30万円"], "毎月30万円の売上")
        self.assertEqual(result, ["30万円"])

    def test_overlay_with_unknown_slot_is_dropped(self):
        slots_by_id = {"cut_001_s00": self.SLOT}
        self.assertIsNone(
            sanitize_overlay_suggestion({"type": "profile_card", "slot_id": "cut_099_s00", "text": "山田"}, slots_by_id, 0)
        )
        self.assertIsNone(
            sanitize_overlay_suggestion({"type": "confetti", "slot_id": "cut_001_s00"}, slots_by_id, 0)
        )

    def test_overlay_anchor_uses_slot_source_ms(self):
        slots_by_id = {"cut_001_s00": self.SLOT}
        overlay = sanitize_overlay_suggestion(
            {"type": "profile_card", "slot_id": "cut_001_s00", "text": "山田太郎", "subtitle": "社長"},
            slots_by_id,
            0,
        )
        self.assertEqual(overlay["type"], "profile_card")
        self.assertEqual(overlay["source_anchor_ms"], 800)
        self.assertEqual(overlay["text"], "山田太郎")
        self.assertEqual(overlay["subtitle"], "社長")

    def test_chapters_are_ordered_and_cover_from_first_cut(self):
        segs = [
            {"start_ms": 0, "end_ms": 5000},
            {"start_ms": 6000, "end_ms": 12000},
            {"start_ms": 13000, "end_ms": 20000},
        ]
        raw = [
            {"start_cut_id": "cut_003", "title": "まとめ"},
            {"start_cut_id": "cut_002", "title": "本題"},
            {"start_cut_id": "cut_999", "title": "実在しないカット"},
        ]
        chapters = sanitize_chapters(raw, segs)
        self.assertEqual(len(chapters), 2)
        # 先頭チャプターは先頭カット(source 0ms)へ強制される
        self.assertEqual(chapters[0]["source_start_ms"], 0)
        self.assertEqual(chapters[0]["title"], "本題")
        self.assertEqual(chapters[1]["source_start_ms"], 13000)


class DirectedCompositionHelpersTests(unittest.TestCase):
    """directed モードの composition 素材生成。"""

    def test_select_slots_survives_keep_segment_trim(self):
        # 生成後にカット先頭が500msトリムされても、絶対msアンカーからスロットを選び直せる
        slots = [
            {"slot_id": "s0", "source_start_ms": 1000, "source_end_ms": 4000, "text": "A"},
            {"slot_id": "s1", "source_start_ms": 4000, "source_end_ms": 7000, "text": "B"},
        ]
        selected = select_slots_for_cut(slots, 1500, 7000)
        self.assertEqual([s["slot_id"] for s in selected], ["s0", "s1"])
        self.assertEqual((selected[0]["start_ms"], selected[0]["end_ms"]), (0, 2500))
        self.assertEqual((selected[1]["start_ms"], selected[1]["end_ms"]), (2500, 5500))

    def test_select_slots_drops_removed_speech(self):
        slots = [{"slot_id": "s0", "source_start_ms": 1000, "source_end_ms": 4000, "text": "A"}]
        self.assertEqual(select_slots_for_cut(slots, 10000, 15000), [])

    def test_wrap_directive_lines_stays_within_two_lines(self):
        lines = wrap_directive_lines("これはかなり長いテロップ文言でどうしても折り返しが必要になります", 12)
        self.assertLessEqual(len(lines), 2)
        self.assertEqual("".join(lines), "これはかなり長いテロップ文言でどうしても折り返しが必要になります")

    def test_wrap_directive_lines_honors_manual_breaks(self):
        # 手動改行(UI編集・AIの自然改行)はBudouX折返しを通さずそのまま行にする
        lines = wrap_directive_lines("山口県立大学を\n受験します", 12)
        self.assertEqual(lines, ["山口県立大学を", "受験します"])
        # バジェット超過でも手動改行の行構成を崩さない(幅は描画側の縮小に任せる)
        lines = wrap_directive_lines("これはとても長い一行目のテロップ文言です\n二行目", 8)
        self.assertEqual(lines, ["これはとても長い一行目のテロップ文言です", "二行目"])

    def test_wrap_directive_lines_manual_breaks_capped_at_three_lines(self):
        lines = wrap_directive_lines("一行目\n二行目\n三行目\n四行目", 12)
        self.assertEqual(lines, ["一行目", "二行目", "三行目四行目"])

    def test_wrap_directive_lines_manual_breaks_drop_empty_lines(self):
        lines = wrap_directive_lines("一行目\n\n  \n二行目", 12)
        self.assertEqual(lines, ["一行目", "二行目"])

    def test_build_directed_cut_content_structure(self):
        slots = [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "毎月30万円の売上",
             "style": "emotion_red", "highlight_words": ["30万円"]},
            {"slot_id": "s1", "start_ms": 3000, "end_ms": 6000, "text": "そうなんですね",
             "style": "reply_cyan", "highlight_words": []},
        ]
        voice_words = [
            {"text": "毎月", "start": 0.1, "end": 0.8},
            {"text": "30万円の", "start": 0.9, "end": 2.0},
            {"text": "売上", "start": 2.1, "end": 2.9},
            {"text": "そうなんですね", "start": 3.2, "end": 5.5},
        ]
        pages, telops = build_directed_cut_content("cut_001", slots, voice_words, 6000, 16)
        self.assertEqual(len(pages), 2)
        self.assertEqual(len(telops), 2)
        # ページ: id/lines/style/明示タイミング(telop.txt往復用)
        self.assertEqual(pages[0]["id"], "cut_001_p00")
        self.assertEqual(pages[0]["style"], "emotion_red")
        self.assertEqual((pages[0]["start_ms"], pages[0]["end_ms"]), (0, 3000))
        self.assertEqual(pages[0]["highlight_words"], ["30万円"])
        # telop: スロット区間の固定表示(明示start/end秒)。wordカラオケ同期はしない
        self.assertEqual((telops[0]["start"], telops[0]["end"]), (0.0, 3.0))
        self.assertEqual(telops[0]["style"], "emotion_red")
        self.assertEqual(telops[0]["highlight_words"], ["30万円"])
        self.assertEqual(telops[0]["word_indices"], [0, 1, 2])
        self.assertEqual((telops[1]["start"], telops[1]["end"]), (3.0, 6.0))
        self.assertEqual(telops[1]["word_indices"], [3])

    def test_build_directed_cut_content_manual_break_roundtrip(self):
        # 手動改行入りスロット: page.lines は改行どおり、telop.text は"\n"を保持して
        # UIのシーン再初期化(textarea復元)で改行位置が失われない
        slots = [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "山口県立大学を\n受験します",
             "style": "fact_yellow", "highlight_words": []},
        ]
        pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertEqual(pages[0]["lines"], ["山口県立大学を", "受験します"])
        self.assertEqual(telops[0]["text"], "山口県立大学を\n受験します")
        self.assertEqual(
            [seg["text"] for seg in telops[0]["segments"]],
            ["山口県立大学を", "受験します"],
        )

    def test_map_source_ms_to_timeline_snaps_gaps(self):
        segments = [
            {"source_start_ms": 1000, "source_end_ms": 4000, "timeline_start_ms": 0},
            {"source_start_ms": 6000, "source_end_ms": 9000, "timeline_start_ms": 3000},
        ]
        self.assertEqual(map_source_ms_to_timeline(2000, segments), 1000)
        self.assertEqual(map_source_ms_to_timeline(5000, segments), 3000)  # 隙間→次セグメント頭
        self.assertEqual(map_source_ms_to_timeline(500, segments), 0)
        self.assertIsNone(map_source_ms_to_timeline(9500, segments))

    def test_build_directed_overlays_chapters_cover_timeline(self):
        directives = {
            "chapters": [
                {"id": "chapter_01", "source_start_ms": 0, "title": "オープニング"},
                {"id": "chapter_02", "source_start_ms": 6000, "title": "本題"},
            ],
            "overlays": [
                {"id": "ov_profile_card_00", "type": "profile_card", "source_anchor_ms": 1500,
                 "text": "山田太郎", "subtitle": "社長", "position": "bottom_left"},
            ],
        }
        segments = [
            {"source_start_ms": 0, "source_end_ms": 4000, "timeline_start_ms": 0},
            {"source_start_ms": 6000, "source_end_ms": 10000, "timeline_start_ms": 4000},
        ]
        overlays = build_directed_overlays(directives, segments, 8000)
        chapter_overlays = [o for o in overlays if o["type"] == "chapter_title"]
        self.assertEqual(len(chapter_overlays), 2)
        self.assertEqual((chapter_overlays[0]["start_ms"], chapter_overlays[0]["end_ms"]), (0, 4000))
        self.assertEqual((chapter_overlays[1]["start_ms"], chapter_overlays[1]["end_ms"]), (4000, 8000))
        profile = next(o for o in overlays if o["type"] == "profile_card")
        self.assertEqual(profile["start_ms"], 1500)
        self.assertEqual(profile["end_ms"], 6500)
        self.assertEqual(profile["text"], "山田太郎")

    def test_build_directed_overlays_dedupes_profile_cards_per_person(self):
        # 同一人物のprofile_cardは最初の1回だけ表示する(空白差は同一人物と見なす)。
        # 別人のカードは残る。ユーザーFB 2026-07-06「プロフィールが何度も表示される」
        directives = {
            "overlays": [
                {"type": "profile_card", "source_anchor_ms": 500, "text": "山田 太郎", "subtitle": "社長"},
                {"type": "profile_card", "source_anchor_ms": 3000, "text": "山田太郎", "subtitle": "社長"},
                {"type": "profile_card", "source_anchor_ms": 5000, "text": "佐藤花子", "subtitle": "編集者"},
                {"type": "profile_card", "source_anchor_ms": 7000, "text": "山田太郎"},
            ],
        }
        segments = [{"source_start_ms": 0, "source_end_ms": 10000, "timeline_start_ms": 0}]
        overlays = build_directed_overlays(directives, segments, 10000)
        profiles = [o for o in overlays if o["type"] == "profile_card"]
        self.assertEqual([p["text"] for p in profiles], ["山田 太郎", "佐藤花子"])
        self.assertEqual(profiles[0]["start_ms"], 500)


class Step06cRunStepTests(unittest.TestCase):
    """step06c_direction.run_step (LLMモック)。"""

    def _write_inputs(self, tmp: Path):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3500, "text": "毎月30万円の売上が出てるんですけれども"},
                {"start_ms": 5000, "end_ms": 8000, "text": "そうなんですね"},
            ],
        }
        stt = {
            "words": make_words([
                ("毎月", 100, 800), ("30万円の", 900, 2000), ("売上が", 2100, 2900),
                ("出てるんですけれども", 2950, 3400),
                ("そうなんですね", 5200, 7500),
            ]),
        }
        proposal_path = tmp / "cut_proposal.json"
        stt_path = tmp / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")
        return proposal_path, stt_path

    def test_run_step_with_mocked_llm(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            proposal_path, stt_path = self._write_inputs(tmp)

            def fake_caller(provider, api_key, model, prompt):
                # call_llm と同じ契約: 解析済みJSON(dict)を返す
                if "構成作家" in prompt:  # チャプタープロンプト
                    return {"chapters": [{"start_cut_id": "cut_001", "title": "売上の話"}]}
                if "予告ダイジェスト)専門" in prompt:  # フェーズW: OPディレクター第2パス
                    return {
                        "op_picks": [
                            {"slot_id": "cut_001_s00", "role": "hook_open", "display": "hook",
                             "hook_text": "毎月30万円", "keyword": "30万円", "keyword_color": "yellow"},
                            {"slot_id": "cut_999_s00", "role": "punch", "display": "verbatim"},  # 実在しない→落ちる
                        ],
                    }
                return {
                    "slots": [
                        {"slot_id": "cut_001_s00", "text": "毎月30万円の売上が出ています",
                         "style": "emotion_red", "highlight_words": ["30万円"]},
                        {"slot_id": "cut_002_s00", "text": "宇宙一の裏技を大公開",  # 不忠実→フォールバック
                         "style": "reply_cyan", "highlight_words": []},
                    ],
                    "overlays": [
                        {"type": "profile_card", "slot_id": "cut_001_s00", "text": "山田太郎", "subtitle": "社長"},
                    ],
                    # V8-6: チャンク推薦(実在しないIDはsanitizeで落ちる)
                    "op_picks": ["cut_001_s00", "cut_999_s00"],
                }

            result = step06c_direction.run_step(
                str(tmp),
                str(proposal_path),
                str(stt_path),
                title="テスト動画",
                provider="anthropic",
                api_key="dummy-key",
                call_direction_fn=fake_caller,
            )

            self.assertTrue(result["enabled"])
            self.assertEqual(result["stats"]["total_slots"], 2)
            self.assertEqual(result["stats"]["fallback_slots"], 1)

            directives = json.loads((tmp / "telop_directives.json").read_text(encoding="utf-8"))
            slot1 = directives["slots"][0]
            self.assertEqual(slot1["text"], "毎月30万円の売上が出ています")
            self.assertEqual(slot1["style"], "emotion_red")
            self.assertEqual(slot1["highlight_words"], ["30万円"])
            self.assertFalse(slot1["fallback"])
            self.assertEqual(slot1["source_start_ms"], 0)

            slot2 = directives["slots"][1]
            self.assertEqual(slot2["text"], "そうなんですね")  # 安全弁で元テキストに戻る
            self.assertTrue(slot2["fallback"])

            self.assertEqual(len(directives["chapters"]), 1)
            self.assertEqual(directives["chapters"][0]["source_start_ms"], 0)
            self.assertEqual(len(directives["overlays"]), 1)
            self.assertEqual(directives["overlays"][0]["source_anchor_ms"], 0)
            # フェーズW: OPディレクター第2パスの最終選定(v2形式)が実在slot_idのみで保存される
            self.assertEqual(directives["op_picks"], [{
                "slot_id": "cut_001_s00", "role": "hook_open", "display": "hook",
                "hook_text": "毎月30万円", "keyword": "30万円", "keyword_color": "yellow",
            }])

    def test_run_step_without_api_key_writes_fallback(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            proposal_path, stt_path = self._write_inputs(tmp)
            with mock.patch.object(
                step06c_direction, "resolve_provider_and_key", return_value=(None, "", ""),
            ):
                result = step06c_direction.run_step(str(tmp), str(proposal_path), str(stt_path))
            self.assertFalse(result["enabled"])
            self.assertEqual(result["reason"], "no AI provider key set")
            directives = json.loads((tmp / "telop_directives.json").read_text(encoding="utf-8"))
            # AI無しでも全スロットが元テキスト+既定スタイルで揃う(パイプラインは壊れない)
            self.assertEqual(len(directives["slots"]), 2)
            self.assertTrue(all(s["fallback"] for s in directives["slots"]))
            self.assertTrue(all(s["style"] == DEFAULT_DIRECTIVE_STYLE for s in directives["slots"]))

    def test_run_step_fatal_error_aborts_remaining_chunks(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            proposal_path, stt_path = self._write_inputs(tmp)
            calls = {"count": 0}

            def billing_error_caller(provider, api_key, model, prompt):
                calls["count"] += 1
                raise RuntimeError("Your credit balance is too low")

            with mock.patch.object(step06c_direction, "SLOTS_PER_CHUNK", 1), \
                    mock.patch.object(step06c_direction, "chunk_slots", lambda slots, chunk_size=1: [[s] for s in slots]):
                result = step06c_direction.run_step(
                    str(tmp),
                    str(proposal_path),
                    str(stt_path),
                    provider="anthropic",
                    api_key="dummy-key",
                    call_direction_fn=billing_error_caller,
                )
            # billing は即時中断: 2チャンクあっても1回で止まり、チャプター呼び出しも行わない
            self.assertEqual(calls["count"], 1)
            self.assertFalse(result["enabled"])
            self.assertEqual(result["error_kind"], "billing")
            self.assertEqual(result["stats"]["chunks_failed"], 2)
            # 全スロットがフォールバックとして書き出される
            directives = json.loads((tmp / "telop_directives.json").read_text(encoding="utf-8"))
            self.assertTrue(all(s["fallback"] for s in directives["slots"]))


class Step08DirectedBranchTests(unittest.TestCase):
    """step08_composition の directed 分岐 (出力JSONの構造)。"""

    def _run_step08(self, tmp: Path, with_directives: bool):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3500, "text": "毎月30万円の売上が出てるんですけれども"},
                {"start_ms": 5000, "end_ms": 8000, "text": "そうなんですね"},
            ],
            "stats": {"original_duration_ms": 9000, "reduction_ratio": 0.28},
        }
        stt = {
            "words": make_words([
                ("毎月", 100, 800), ("30万円の", 900, 2000), ("売上が", 2100, 2900),
                ("出てるんですけれども", 2950, 3400),
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

        if with_directives:
            directives = {
                "version": "1.0",
                "mode": "directed",
                "enabled": True,
                "chapters": [
                    {"id": "chapter_01", "source_start_ms": 0, "title": "売上の話"},
                    {"id": "chapter_02", "source_start_ms": 5000, "title": "リアクション"},
                ],
                "overlays": [
                    {"id": "ov_profile_card_00", "type": "profile_card", "source_anchor_ms": 0,
                     "text": "山田太郎", "subtitle": "社長", "position": "bottom_left"},
                ],
                "slots": [
                    {"slot_id": "cut_001_s00", "cut_id": "cut_001", "source_start_ms": 0, "source_end_ms": 3500,
                     "source_text": "毎月30万円の売上が出てるんですけれども",
                     "text": "毎月30万円の売上が出ています", "style": "emotion_red",
                     "highlight_words": ["30万円"], "fallback": False},
                    {"slot_id": "cut_002_s00", "cut_id": "cut_002", "source_start_ms": 5000, "source_end_ms": 8000,
                     "source_text": "そうなんですね", "text": "そうなんですね", "style": "reply_cyan",
                     "highlight_words": [], "fallback": False},
                ],
            }
            (run_dir / "telop_directives.json").write_text(
                json.dumps(directives, ensure_ascii=False), encoding="utf-8",
            )

        fake_metadata = {"video": {"width": 1920, "height": 1080, "rotation": 0}}
        with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                mock.patch.object(step08_composition, "_extract_segments"):
            return step08_composition.run_step(
                str(proposal_path),
                str(stt_path),
                str(tmp / "dummy.mp4"),
                str(output_dir),
            )

    def test_directed_composition_structure(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), with_directives=True)

            self.assertEqual(comp["meta"]["telop_mode"], "directed")

            # timeline.overlays: チャプター2つ(タイムライン全体をカバー)。
            # W25: 要約系オーバーレイ(profile_card / list_stack / cta_banner等)は
            # step08で自動表示しない(chapter_titleのみ残る)。
            overlays = comp["timeline"]["overlays"]
            chapters = [o for o in overlays if o["type"] == "chapter_title"]
            self.assertEqual(len(chapters), 2)
            self.assertEqual(chapters[0]["start_ms"], 0)
            self.assertEqual(chapters[0]["end_ms"], 3500)  # 第2章開始 = cut_002 のタイムライン頭
            self.assertEqual(chapters[1]["end_ms"], 6500)  # 総尺 3500+3000
            self.assertEqual([o["type"] for o in overlays], ["chapter_title", "chapter_title"])

            # voice_data.cuts[].telops[]: スロット単位の明示タイミング + style + highlight_words
            vcut1 = comp["voice_data"]["cuts"][0]
            self.assertEqual(len(vcut1["telops"]), 1)
            telop = vcut1["telops"][0]
            self.assertEqual(telop["id"], "cut_001_p00")
            self.assertEqual(telop["text"], "毎月30万円の売上が出ています")
            self.assertEqual((telop["start"], telop["end"]), (0.0, 3.5))
            self.assertEqual(telop["style"], "emotion_red")
            self.assertEqual(telop["highlight_words"], ["30万円"])

            vcut2 = comp["voice_data"]["cuts"][1]
            self.assertEqual(vcut2["telops"][0]["style"], "reply_cyan")

            # timeline.cuts[].telop.pages: 1スロット=1ページ、style/明示タイミング付き
            page = comp["timeline"]["cuts"][0]["telop"]["pages"][0]
            self.assertEqual(page["style"], "emotion_red")
            self.assertEqual((page["start_ms"], page["end_ms"]), (0, 3500))
            self.assertEqual("".join(page["lines"]), "毎月30万円の売上が出ています")

    def test_full_mode_is_unchanged_without_directives(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), with_directives=False)
            self.assertEqual(comp["meta"]["telop_mode"], "full")
            self.assertEqual(comp["timeline"]["overlays"], [])
            # fullモードのtelopは従来のword_indicesベース(明示start/end無し・style無し)
            telop = comp["voice_data"]["cuts"][0]["telops"][0]
            self.assertNotIn("style", telop)
            self.assertNotIn("highlight_words", telop)
            self.assertTrue(telop["word_indices"])


if __name__ == "__main__":
    unittest.main()
