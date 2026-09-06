"""フェーズV8(検品UXの磨き込み)のPython側テスト。

1. V8-3: profile_card の重複対策(敬称・包含関係の同一人物判定)
2. V8-4: 漢数字→算用数字の正規化を directed 経路へ適用(実データrunの実例)
3. V8-6: op_picks の sanitize と select_highlight_clips / build_op の最優先採用

実データ: runs/20260707_004339_笠井俊哉くん_山口県立大学_夏期講習の感想インタビュー
- profile_card 重複の実例: 「笠井俊哉くん」(敬称あり) と「笠井俊哉」(敬称なし)
- 漢数字の実例: 五割・六割・四周・一万回で百万回再生・四百何十点
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import (
    build_directed_cut_content,
    build_directed_overlays,
    profile_dedup_key,
    sanitize_op_picks,
)
from shared.opening import build_op, load_op_patterns, select_highlight_clips
from shared.telop_builder import normalize_directed_display_text


# ---------------------------------------------------------------------------
# V8-3: profile_card の重複対策
# ---------------------------------------------------------------------------

class ProfileDedupKeyTests(unittest.TestCase):
    def test_strips_whitespace_and_honorifics(self):
        self.assertEqual(profile_dedup_key("笠井 俊哉くん"), "笠井俊哉")
        self.assertEqual(profile_dedup_key("笠井俊哉"), "笠井俊哉")
        self.assertEqual(profile_dedup_key("山田太郎さん"), "山田太郎")
        self.assertEqual(profile_dedup_key("田中先生"), "田中")
        self.assertEqual(profile_dedup_key("佐藤様"), "佐藤")
        self.assertEqual(profile_dedup_key(None), "")

    def test_honorific_only_stripped_at_tail(self):
        # 名前の途中の文字は消さない(「くん」を含む固有名詞など)
        self.assertEqual(profile_dedup_key("くんぺい"), "くんぺい")


class ProfileCardDedupTests(unittest.TestCase):
    _SEGMENTS = [{"source_start_ms": 0, "source_end_ms": 300000, "timeline_start_ms": 0}]

    def test_dedupes_honorific_variants_from_real_run(self):
        # 実データrunで確認した重複: 敬称違いの同一人物が2回提案されていた
        directives = {
            "overlays": [
                {"type": "profile_card", "source_anchor_ms": 18980,
                 "text": "笠井俊哉くん", "subtitle": "山口県立大学 合格"},
                {"type": "profile_card", "source_anchor_ms": 187080,
                 "text": "笠井俊哉", "subtitle": "山口県立大学 夏期講習"},
            ],
        }
        overlays = build_directed_overlays(directives, self._SEGMENTS, 300000)
        profiles = [o for o in overlays if o["type"] == "profile_card"]
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]["text"], "笠井俊哉くん")  # 最初の1回のみ

    def test_dedupes_containment_variants(self):
        # 既出キーとの包含関係(姓名 vs 名のみ等)も同一人物とみなす
        directives = {
            "overlays": [
                {"type": "profile_card", "source_anchor_ms": 1000, "text": "山田太郎"},
                {"type": "profile_card", "source_anchor_ms": 5000, "text": "山田"},
                {"type": "profile_card", "source_anchor_ms": 9000, "text": "佐藤花子"},
            ],
        }
        overlays = build_directed_overlays(directives, self._SEGMENTS, 300000)
        profiles = [o for o in overlays if o["type"] == "profile_card"]
        self.assertEqual([p["text"] for p in profiles], ["山田太郎", "佐藤花子"])


# ---------------------------------------------------------------------------
# V8-4: 漢数字→算用数字の directed 経路への適用
# ---------------------------------------------------------------------------

class DirectedKanjiNormalizeTests(unittest.TestCase):
    def test_real_run_examples(self):
        # 実データrunのスロット文言(漢数字のままだったもの)
        cases = [
            ("本当五割いかないぐらい", "本当5割いかないぐらい"),
            ("半分取れないところから\n六割ぐらいまでは", "半分取れないところから\n6割ぐらいまでは"),
            ("確か四周ぐらい", "確か4周ぐらい"),
            ("一万回で百万回再生になる", "1万回で100万回再生になる"),
            ("合計点も四百何十点", "合計点も400何十点"),
        ]
        for source, expected in cases:
            self.assertEqual(normalize_directed_display_text(source), expected)

    def test_idioms_not_converted(self):
        # 「一人一人」「一緒」「一番」等の慣用語は変換しない(既存ルール踏襲)
        for text in ("一人一人", "計画を一緒に立ててくれる", "一番ありがたい点です"):
            self.assertEqual(normalize_directed_display_text(text), text)

    def test_manual_breaks_preserved(self):
        # V7の手動改行("\n")は行ごと正規化で壊さない
        self.assertEqual(
            normalize_directed_display_text("五割から\n六割へ"),
            "5割から\n6割へ",
        )

    def test_build_directed_cut_content_normalizes_slot_text(self):
        # directed 経路(build_directed_cut_content)で漢数字が算用化される
        slots = [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 3000,
             "text": "本当五割いかないぐらい", "style": "fact_yellow",
             "highlight_words": ["五割"]},
        ]
        pages, telops = build_directed_cut_content("cut_027", slots, [], 3000, 16)
        self.assertIn("5割", telops[0]["text"])
        self.assertNotIn("五割", telops[0]["text"])
        # highlight_words も正規化され、正規化後の本文と一致する
        self.assertEqual(pages[0]["highlight_words"], ["5割"])

    def test_build_directed_cut_content_normalize_keeps_manual_breaks(self):
        slots = [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 3000,
             "text": "半分取れないところから\n六割ぐらいまでは", "style": "fact_yellow",
             "highlight_words": []},
        ]
        pages, telops = build_directed_cut_content("cut_063", slots, [], 3000, 16)
        self.assertEqual(telops[0]["text"], "半分取れないところから\n6割ぐらいまでは")
        self.assertEqual(pages[0]["lines"], ["半分取れないところから", "6割ぐらいまでは"])


# ---------------------------------------------------------------------------
# V8-6: op_picks(OPシーン選定のAI化)
# ---------------------------------------------------------------------------

_SLOTS_FOR_PICKS = [
    {"slot_id": "cut_001_s00", "type": "default", "source_start_ms": 1000, "source_end_ms": 3000,
     "text": "結論から言うと"},
    {"slot_id": "cut_002_s00", "type": "hype", "source_start_ms": 4000, "source_end_ms": 6000,
     "text": "盛り上がり"},
    {"slot_id": "cut_003_s00", "type": "default", "source_start_ms": 7000, "source_end_ms": 9000,
     "text": "意外な事実"},
    {"slot_id": "cut_004_s00", "type": "punchline", "source_start_ms": 21000, "source_end_ms": 23000,
     "text": "オチ"},
]

_KEEP_SEGMENTS = [
    {"start_ms": 0, "end_ms": 10000},
    {"start_ms": 20000, "end_ms": 30000},
]


class SanitizeOpPicksTests(unittest.TestCase):
    def test_keeps_only_existing_slot_ids_in_order(self):
        picks = sanitize_op_picks(
            ["cut_003_s00", "cut_999_s00", "cut_001_s00", "cut_003_s00", None, 5],
            _SLOTS_FOR_PICKS,
        )
        # 実在IDのみ・提案順維持・重複除去。文字列(旧形式)はverbatimの既定メタで揃う
        self.assertEqual([p["slot_id"] for p in picks], ["cut_003_s00", "cut_001_s00"])
        self.assertTrue(all(p["display"] == "verbatim" for p in picks))
        self.assertTrue(all(p["role"] == "punch" for p in picks))

    def test_caps_at_five(self):
        slots = [
            {"slot_id": f"s{i}", "source_start_ms": i * 1000, "source_end_ms": i * 1000 + 500}
            for i in range(10)
        ]
        picks = sanitize_op_picks([f"s{i}" for i in range(10)], slots)
        self.assertEqual(len(picks), 5)

    def test_non_list_returns_empty(self):
        self.assertEqual(sanitize_op_picks(None, _SLOTS_FOR_PICKS), [])
        self.assertEqual(sanitize_op_picks("cut_001_s00", _SLOTS_FOR_PICKS), [])

    # --- フェーズW: v2(dict)形式 ---

    def test_v2_dict_pick_normalized(self):
        picks = sanitize_op_picks(
            [{
                "slot_id": "cut_001_s00", "role": "hook_open", "display": "hook",
                "hook_text": " 定時8時 \n 非人道的 ", "keyword": "非人道的", "keyword_color": "red",
            }],
            _SLOTS_FOR_PICKS,
        )
        self.assertEqual(picks, [{
            "slot_id": "cut_001_s00", "role": "hook_open", "display": "hook",
            "hook_text": "定時8時\n非人道的", "keyword": "非人道的", "keyword_color": "red",
        }])

    def test_v2_invalid_enum_values_fall_back(self):
        picks = sanitize_op_picks(
            [{"slot_id": "cut_001_s00", "role": "opener", "display": "big",
              "hook_text": "一言", "keyword": "一言", "keyword_color": "rainbow"}],
            _SLOTS_FOR_PICKS,
        )
        self.assertEqual(picks[0]["role"], "punch")
        self.assertEqual(picks[0]["display"], "hook")  # hook_textありの既定
        self.assertEqual(picks[0]["keyword_color"], "yellow")

    def test_v2_hook_text_too_long_falls_back_to_verbatim(self):
        # 1行が全角10文字超のフックは不成立→verbatimへ(中途半端な切り詰めをしない)
        picks = sanitize_op_picks(
            [{"slot_id": "cut_001_s00", "display": "hook",
              "hook_text": "これは全角十文字を超える長い行です", "keyword": ""}],
            _SLOTS_FOR_PICKS,
        )
        self.assertEqual(picks[0]["display"], "verbatim")
        self.assertEqual(picks[0]["hook_text"], "")

    def test_v2_hook_text_capped_at_two_lines(self):
        picks = sanitize_op_picks(
            [{"slot_id": "cut_001_s00", "hook_text": "一行目\n二行目\n三行目"}],
            _SLOTS_FOR_PICKS,
        )
        self.assertEqual(picks[0]["hook_text"], "一行目\n二行目")

    def test_v2_keyword_must_appear_in_hook_line(self):
        picks = sanitize_op_picks(
            [{"slot_id": "cut_001_s00", "hook_text": "定時8時", "keyword": "非人道的"}],
            _SLOTS_FOR_PICKS,
        )
        self.assertEqual(picks[0]["keyword"], "")


class SelectHighlightClipsOpPicksTests(unittest.TestCase):
    def test_op_picks_take_priority_over_type(self):
        # op_picks のスロット(type=default含む)が type優先の hype/punchline より先に採用される
        clips = select_highlight_clips(
            _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, max_clips=2,
            op_picks=["cut_003_s00", "cut_001_s00"],
        )
        # 採用後は時系列順に並ぶ
        self.assertEqual([c["text"] for c in clips], ["結論から言うと", "意外な事実"])

    def test_op_picks_shortfall_filled_by_type_priority(self):
        # op_picks が不足する分は従来の type優先(hype > punchline)で補完する
        clips = select_highlight_clips(
            _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, max_clips=3,
            op_picks=["cut_003_s00"],
        )
        self.assertEqual(
            [c["text"] for c in clips],
            ["盛り上がり", "意外な事実", "オチ"],  # 時系列順(source_start順)
        )

    def test_without_op_picks_behaves_as_before(self):
        # op_picks なし(旧run・AI失敗)は完全従来動作(後方互換)
        legacy = select_highlight_clips(_SLOTS_FOR_PICKS, _KEEP_SEGMENTS, max_clips=3)
        explicit_none = select_highlight_clips(
            _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, max_clips=3, op_picks=None,
        )
        self.assertEqual(legacy, explicit_none)
        # 従来対象(hype/punchline)のみが候補になる
        self.assertEqual([c["text"] for c in legacy], ["盛り上がり", "オチ"])

    def test_op_picks_respect_clip_duration_constraints(self):
        # op_picks 指定でも尺条件(clip_min未満はスキップ)は従来どおり守る
        slots = [
            {"slot_id": "short", "type": "default", "source_start_ms": 1000,
             "source_end_ms": 1500, "text": "短すぎ"},
        ]
        clips = select_highlight_clips(
            slots, _KEEP_SEGMENTS, max_clips=3, clip_min_ms=1200, op_picks=["short"],
        )
        self.assertEqual(clips, [])


class BuildOpOpPicksTests(unittest.TestCase):
    _CUTS = [
        {"video": {"file_path": "/run/segments/seg_000.mp4", "start_ms": 0},
         "timeline": {"start_ms": 0, "end_ms": 10000}},
        {"video": {"file_path": "/run/segments/seg_001.mp4", "start_ms": 0},
         "timeline": {"start_ms": 10000, "end_ms": 20000}},
    ]

    def test_build_op_passes_op_picks(self):
        op = build_op(
            {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
            load_op_patterns(), _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, self._CUTS, "/videos/x.mp4",
            op_picks=["cut_003_s00", "cut_001_s00"],
        )
        # 旧形式(文字列)は従来経路: op_picksの2件が最優先で入り、残り枠
        # (フェーズWでmax_clips既定=5)はtype優先(hype/punchline)で補完され時系列順に並ぶ
        self.assertEqual(
            [c["text"] for c in op["highlight_cuts"]],
            ["結論から言うと", "盛り上がり", "意外な事実", "オチ"],
        )

    def test_build_op_v2_picks_keep_ai_order_and_emit_hook_meta(self):
        # フェーズW: v2ピックはAIの提案順(=OPの演出順)を保ち、フックワード系メタを出力する
        op = build_op(
            {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
            load_op_patterns(), _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, self._CUTS, "/videos/x.mp4",
            op_picks=[
                {"slot_id": "cut_004_s00", "role": "hook_open", "display": "hook",
                 "hook_text": "衝撃のオチ", "keyword": "衝撃", "keyword_color": "red"},
                {"slot_id": "cut_002_s00", "role": "punch", "display": "verbatim",
                 "hook_text": "", "keyword": "", "keyword_color": "yellow"},
                {"slot_id": "cut_001_s00", "role": "cliffhanger", "display": "hook",
                 "hook_text": "結論は…", "keyword": "", "keyword_color": "yellow"},
            ],
        )
        cuts = op["highlight_cuts"]
        # 時系列に並べ直さず、AIの順序(オチ→盛り上がり→結論)のまま
        self.assertEqual([c["text"] for c in cuts], ["オチ", "盛り上がり", "結論から言うと"])
        self.assertEqual(cuts[0]["role"], "hook_open")
        self.assertEqual(cuts[0]["display"], "hook")
        self.assertEqual(cuts[0]["hook_text"], "衝撃のオチ")
        self.assertEqual(cuts[0]["keyword"], "衝撃")
        self.assertEqual(cuts[0]["keyword_color"], "red")
        self.assertEqual(cuts[1]["display"], "verbatim")
        self.assertNotIn("hook_text", cuts[1])
        self.assertEqual(cuts[2]["role"], "cliffhanger")

    def test_build_op_v2_duration_fits_target_total(self):
        # フェーズW: 1クリップ上限=target_total/クリップ数でOP合計が10〜15秒に収まる。
        # スロットが短くてもセグメント内で尺を確保する(発話は連続しているため延長してよい)
        slots = [
            {"slot_id": f"p{i}", "type": "default",
             "source_start_ms": i * 2000, "source_end_ms": i * 2000 + 800,
             "text": f"見どころ{i}"}
            for i in range(4)
        ]
        segments = [{"start_ms": 0, "end_ms": 60000}]
        cuts = [{"video": {"file_path": "/run/segments/seg_000.mp4", "start_ms": 0},
                 "timeline": {"start_ms": 0, "end_ms": 60000}}]
        op = build_op(
            {"pattern": "highlight_teaser", "title": "T", "catch_copy": "", "clips": None},
            load_op_patterns(), slots, segments, cuts, "/videos/x.mp4",
            op_picks=[
                {"slot_id": f"p{i}", "role": "punch", "display": "verbatim",
                 "hook_text": "", "keyword": "", "keyword_color": "yellow"}
                for i in range(4)
            ],
        )
        # 4クリップ→1クリップ上限=15000/4=3750→clip_max(3500)でクランプ
        durations = [c["end_ms"] - c["start_ms"] for c in op["highlight_cuts"]]
        self.assertEqual(durations, [3500, 3500, 3500, 3500])
        self.assertLessEqual(op["duration_ms"], 15000)

    def test_build_op_v2_fills_before_cliffhanger_when_short(self):
        # v2ピックが3件未満なら type優先候補で補完し、引き(cliffhanger)は最後を守る
        clips = select_highlight_clips(
            _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, max_clips=5,
            clip_min_ms=1500, clip_max_ms=3500, target_total_ms=15000,
            op_picks=[
                {"slot_id": "cut_003_s00", "role": "hook_open", "display": "hook",
                 "hook_text": "意外な事実", "keyword": "", "keyword_color": "yellow"},
                {"slot_id": "cut_001_s00", "role": "cliffhanger", "display": "hook",
                 "hook_text": "結論は…", "keyword": "", "keyword_color": "yellow"},
            ],
        )
        # 最少3クリップまで補完(type優先=hypeの「盛り上がり」)し、cliffhangerの手前に入る
        self.assertEqual(
            [c["text"] for c in clips],
            ["意外な事実", "盛り上がり", "結論から言うと"],
        )
        self.assertEqual(clips[-1]["role"], "cliffhanger")

    def test_build_op_user_clips_beat_op_picks(self):
        # ユーザーがOP編集UIで明示したクリップは op_picks より常に優先する
        op = build_op(
            {
                "pattern": "highlight_teaser", "title": "T", "catch_copy": "",
                "clips": [
                    {"cut_id": "cut_002", "start_ms": 22000, "end_ms": 24000,
                     "text": "ユーザー編集済み", "style": "emotion_red"},
                ],
            },
            load_op_patterns(), _SLOTS_FOR_PICKS, _KEEP_SEGMENTS, self._CUTS, "/videos/x.mp4",
            op_picks=["cut_003_s00"],
        )
        self.assertEqual([c["text"] for c in op["highlight_cuts"]], ["ユーザー編集済み"])


if __name__ == "__main__":
    unittest.main()
