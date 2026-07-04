import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from step07_cut_proposal import (
    run_step,
    _clamp_words_to_speech,
    _apply_vad_speech_trim,
)


def _write(path: Path, data: dict) -> str:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return str(path)


def _two_cluster_stt():
    """gap>max_gap_msで2クラスタに分かれるword列 (先頭クラスタは音声先頭付近)。"""
    words = [
        {"id": "w-0000", "text": "あ", "start_ms": 50, "end_ms": 150, "confidence": 0.0},
        {"id": "w-0001", "text": "い", "start_ms": 150, "end_ms": 350, "confidence": 0.0},
        {"id": "w-0002", "text": "う", "start_ms": 1050, "end_ms": 1150, "confidence": 0.0},
        {"id": "w-0003", "text": "え", "start_ms": 1150, "end_ms": 1350, "confidence": 0.0},
    ]
    sentences = [
        {"id": "sent_0", "text": "あい", "start_ms": 50, "end_ms": 350, "word_ids": ["w-0000", "w-0001"]},
        {"id": "sent_1", "text": "うえ", "start_ms": 1050, "end_ms": 1350, "word_ids": ["w-0002", "w-0003"]},
    ]
    return {"words": words, "sentences": sentences}


class CutProposalPaddingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, config: dict) -> dict:
        stt_path = _write(self.tmp_path / "stt.json", _two_cluster_stt())
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", {"scenes": []})
        output_dir = str(self.tmp_path / "out")
        cfg = {"min_segment_duration_ms": 0, "min_segment_chars": 0, **config}
        return run_step(stt_path, fillers_path, retakes_path, scenes_path, output_dir, config=cfg)

    def test_default_asymmetric_padding_widens_lead_more_than_tail(self):
        result = self._run({})
        segments = result["keep_segments"]
        self.assertEqual(len(segments), 2)

        # 話し始め側 (lead=200) は音声先頭でクランプされ0になる
        self.assertEqual(segments[0]["start_ms"], 0)
        # tail=120 が末尾に適用される
        self.assertEqual(segments[0]["end_ms"], 350 + 120)

        self.assertEqual(segments[1]["start_ms"], 1050 - 200)
        self.assertEqual(segments[1]["end_ms"], 1350 + 120)

        cfg = result["stats"]["config"]
        self.assertEqual(cfg["lead_padding_ms"], 200)
        self.assertEqual(cfg["tail_padding_ms"], 120)

    def test_legacy_segment_padding_ms_used_symmetrically_when_new_keys_absent(self):
        result = self._run({"segment_padding_ms": 80})
        segments = result["keep_segments"]
        self.assertEqual(segments[0]["start_ms"], 0)  # max(0, 50-80)
        self.assertEqual(segments[0]["end_ms"], 350 + 80)
        self.assertEqual(segments[1]["start_ms"], 1050 - 80)
        self.assertEqual(segments[1]["end_ms"], 1350 + 80)

        cfg = result["stats"]["config"]
        self.assertEqual(cfg["lead_padding_ms"], 80)
        self.assertEqual(cfg["tail_padding_ms"], 80)

    def test_new_padding_keys_take_priority_over_legacy_fallback(self):
        result = self._run({"segment_padding_ms": 80, "lead_padding_ms": 300, "tail_padding_ms": 10})
        segments = result["keep_segments"]
        self.assertEqual(segments[0]["start_ms"], 0)  # max(0, 50-300)
        self.assertEqual(segments[0]["end_ms"], 350 + 10)
        self.assertEqual(segments[1]["start_ms"], 1050 - 300)
        self.assertEqual(segments[1]["end_ms"], 1350 + 10)

    def test_default_max_gap_ms_is_600(self):
        # gap = 1050 - 350 = 700 > 600 なので2クラスタに分かれる (既定値の確認)
        result = self._run({})
        self.assertEqual(result["stats"]["config"]["max_gap_ms"], 600)
        self.assertEqual(len(result["keep_segments"]), 2)

    def test_overlapping_padded_segments_across_scene_boundary_are_clamped_at_midpoint(self):
        stt = {
            "words": [
                {"id": "w-0000", "text": "あ", "start_ms": 1000, "end_ms": 1100, "confidence": 0.0},
                {"id": "w-0001", "text": "い", "start_ms": 1100, "end_ms": 1200, "confidence": 0.0},
                {"id": "w-0002", "text": "う", "start_ms": 1200, "end_ms": 1300, "confidence": 0.0},
            ],
            "sentences": [
                {"id": "sent_0", "text": "あい", "start_ms": 1000, "end_ms": 1200, "word_ids": ["w-0000", "w-0001"]},
                {"id": "sent_1", "text": "う", "start_ms": 1200, "end_ms": 1300, "word_ids": ["w-0002"]},
            ],
        }
        scenes = {
            "scenes": [
                {"id": "scene_0", "sentence_ids": ["sent_0"], "start_ms": 1000, "end_ms": 1200},
                {"id": "scene_1", "sentence_ids": ["sent_1"], "start_ms": 1200, "end_ms": 1300},
            ]
        }
        stt_path = _write(self.tmp_path / "stt.json", stt)
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", scenes)
        output_dir = str(self.tmp_path / "out2")

        result = run_step(
            stt_path, fillers_path, retakes_path, scenes_path, output_dir,
            config={"min_segment_duration_ms": 0, "min_segment_chars": 0},
        )
        segments = result["keep_segments"]
        self.assertEqual(len(segments), 2)
        # lead=200/tail=120 のパディングでシーン境界を挟んで重なるが、
        # 中点でクランプされ重複しない (既存の_merge_adjacent_segments挙動を維持)
        self.assertEqual(segments[0]["end_ms"], segments[1]["start_ms"])
        self.assertLessEqual(segments[0]["end_ms"], segments[1]["start_ms"] + 1)
        self.assertLess(segments[0]["start_ms"], segments[0]["end_ms"])
        self.assertLess(segments[1]["start_ms"], segments[1]["end_ms"])


class ClampWordsToSpeechTests(unittest.TestCase):
    """IMG_5952 実機テストで見つかった STT の異常長 word (無音区間を跨いで
    end_ms が数十秒に伸びる) を VAD 発話区間へクランプする挙動のテスト。
    """

    def test_abnormally_long_one_char_word_is_clamped_to_speech_end(self):
        # word50「た」相当: 17859〜33779ms (約16秒) の異常伸長
        words = [
            {"id": "w-0", "text": "た", "start_ms": 17859, "end_ms": 33779, "confidence": 0.0},
        ]
        speech_segs = [
            {"start_ms": 16283, "end_ms": 18212},
            {"start_ms": 36348, "end_ms": 39588},
        ]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 1)
        self.assertEqual(words[0]["start_ms"], 17859)  # start は変更しない
        self.assertEqual(words[0]["end_ms"], 18212)  # 発話区間の終端へクランプ

    def test_trailing_punctuation_dragged_into_silence_is_pulled_back(self):
        # word39「す」相当 + 直後の句読点 (start==end) が無音区間の奥に取り残されるケース
        words = [
            {"id": "w-0", "text": "す", "start_ms": 8460, "end_ms": 13920, "confidence": 0.0},
            {"id": "w-1", "text": "。", "start_ms": 13920, "end_ms": 13920, "confidence": 0.0},
        ]
        speech_segs = [
            {"start_ms": 6204, "end_ms": 8644},
            {"start_ms": 16283, "end_ms": 18212},
        ]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 2)
        self.assertEqual(words[0]["end_ms"], 8644)
        # 句読点は start==end==8644 まで引き戻される (start<=end は常に維持)
        self.assertEqual(words[1]["start_ms"], 8644)
        self.assertEqual(words[1]["end_ms"], 8644)

    def test_normal_words_within_speech_segment_are_not_changed(self):
        words = [
            {"id": "w-0", "text": "あ", "start_ms": 100, "end_ms": 200, "confidence": 0.0},
            {"id": "w-1", "text": "い", "start_ms": 200, "end_ms": 350, "confidence": 0.0},
            # 1文字だが1200ms以下の通常の長め単語 (伸ばし棒等) も変更しない
            {"id": "w-2", "text": "う", "start_ms": 350, "end_ms": 1000, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 1200}]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 0)
        self.assertEqual(words[0], {"id": "w-0", "text": "あ", "start_ms": 100, "end_ms": 200, "confidence": 0.0})
        self.assertEqual(words[1], {"id": "w-1", "text": "い", "start_ms": 200, "end_ms": 350, "confidence": 0.0})
        self.assertEqual(words[2], {"id": "w-2", "text": "う", "start_ms": 350, "end_ms": 1000, "confidence": 0.0})

    def test_short_gap_below_threshold_is_not_treated_as_abnormal(self):
        # speech終端をわずかに超えるだけ (800ms未満) は正常な揺らぎとして許容する
        words = [
            {"id": "w-0", "text": "ん", "start_ms": 900, "end_ms": 1300, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 1000}]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 0)
        self.assertEqual(words[0]["end_ms"], 1300)

    def test_multi_char_word_with_large_tail_overlap_is_also_clamped(self):
        # 1文字条件に該当しなくても、末尾のVAD無音食い込みが閾値を超えれば異常とみなす
        words = [
            {"id": "w-0", "text": "です", "start_ms": 500, "end_ms": 3000, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 1000}]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 1)
        self.assertEqual(words[0]["end_ms"], 1000)

    def test_event_token_word_fully_inside_silence_collapses_to_zero_duration(self):
        # 「(6秒停止)」のようなイベントトークンが無音区間全体をまたぐケース
        # (通常は step02 で除去されるが、万一残った場合の防御的な挙動を確認)
        words = [
            {"id": "w-0", "text": "(6秒停止)", "start_ms": 34340, "end_ms": 36379, "confidence": 0.0},
        ]
        speech_segs = [
            {"start_ms": 16283, "end_ms": 18212},
            {"start_ms": 36348, "end_ms": 39588},
        ]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 1)
        self.assertEqual(words[0]["start_ms"], 18212)
        self.assertEqual(words[0]["end_ms"], 18212)

    def test_img5952_like_silence_excluded_from_keep_segments_end_to_end(self):
        """改善6の受け入れ条件を模した縮小版: run_step 全体を通して
        約17.8〜33.7秒の異常無音帯と (6秒停止) 帯が keep_segments から
        除外されることを確認する。"""
        words = [
            {"id": "w-0043", "text": "志", "start_ms": 16979, "end_ms": 17100, "confidence": 0.0},
            {"id": "w-0044", "text": "望", "start_ms": 17100, "end_ms": 17299, "confidence": 0.0},
            {"id": "w-0049", "text": "け", "start_ms": 17719, "end_ms": 17859, "confidence": 0.0},
            {"id": "w-0050", "text": "た", "start_ms": 17859, "end_ms": 33779, "confidence": 0.0},
            {"id": "w-0051", "text": "。", "start_ms": 33779, "end_ms": 33779, "confidence": 0.0},
            {"id": "w-0053", "text": "お", "start_ms": 36380, "end_ms": 36540, "confidence": 0.0},
            {"id": "w-0054", "text": "子", "start_ms": 36540, "end_ms": 36719, "confidence": 0.0},
        ]
        sentences = [
            {
                "id": "sent_0",
                "text": "志望け た。",
                "start_ms": 16979,
                "end_ms": 33779,
                "word_ids": ["w-0043", "w-0044", "w-0049", "w-0050", "w-0051"],
            },
            {
                "id": "sent_1",
                "text": "お子",
                "start_ms": 36380,
                "end_ms": 36719,
                "word_ids": ["w-0053", "w-0054"],
            },
        ]
        stt_path = _write(self.tmp_path / "stt.json", {"words": words, "sentences": sentences})
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", {"scenes": []})
        vad_path = _write(
            self.tmp_path / "vad.json",
            {
                "speech_segments": [
                    {"start_ms": 16283, "end_ms": 18212},
                    {"start_ms": 36348, "end_ms": 39588},
                ]
            },
        )
        output_dir = str(self.tmp_path / "out")

        result = run_step(
            stt_path,
            fillers_path,
            retakes_path,
            scenes_path,
            output_dir,
            config={"min_segment_duration_ms": 0, "min_segment_chars": 0},
            vad_result_path=vad_path,
        )

        segments = result["keep_segments"]
        self.assertEqual(len(segments), 2)
        # 1つ目のセグメントはVAD発話終端(18212)+tail padding程度で終わり、
        # 33.7秒までの無音を含まない
        self.assertLess(segments[0]["end_ms"], 20000)
        # 2つ目のセグメントは次の発話 (36380〜) 付近から始まり、
        # 17.8〜33.7秒帯を跨がない
        self.assertGreater(segments[1]["start_ms"], 30000)

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


class ClampWordsGeneralizedThresholdTests(unittest.TestCase):
    """改善8-A-2: 「1文字1200ms超」を「文字数×per-char閾値+固定余裕」へ一般化した挙動のテスト。"""

    def test_multi_char_word_spanning_silence_over_generalized_threshold_is_clamped(self):
        # 「ます」(2文字): 閾値 = 2*400+800 = 1600ms。durationがこれを超えるケース。
        words = [
            {"id": "w-0", "text": "ます", "start_ms": 0, "end_ms": 1601, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 1000}]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 1)
        self.assertEqual(words[0]["end_ms"], 1000)

    def test_multi_char_word_within_generalized_threshold_is_not_clamped(self):
        # 同じ「ます」でも duration がちょうど閾値(1600ms)以下なら正常とみなす。
        words = [
            {"id": "w-0", "text": "ます", "start_ms": 0, "end_ms": 1600, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 1000}]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 0)
        self.assertEqual(words[0]["end_ms"], 1600)

    def test_one_char_word_threshold_matches_legacy_1200ms_behavior(self):
        # 1文字語の場合は 1*400+800=1200ms で従来の固定閾値と同じ結果になる (後方互換)。
        words = [
            {"id": "w-0", "text": "た", "start_ms": 0, "end_ms": 1201, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 1000}]
        adjusted = _clamp_words_to_speech(words, speech_segs)
        self.assertEqual(adjusted, 1)
        self.assertEqual(words[0]["end_ms"], 1000)

    def test_thresholds_configurable_via_timing_cfg(self):
        # per_char/fixed_marginをtiming_cfg経由で変更できる。
        words = [
            {"id": "w-0", "text": "ます", "start_ms": 0, "end_ms": 700, "confidence": 0.0},
        ]
        speech_segs = [{"start_ms": 0, "end_ms": 500}]
        # 既定 (2*400+800=1600) では非異常 (duration=700 <= 1600)
        adjusted_default = _clamp_words_to_speech(list(words), speech_segs)
        self.assertEqual(adjusted_default, 0)
        # per_char=50, margin=100 -> 閾値=2*50+100=200 -> duration(700)超過で異常
        adjusted_tight = _clamp_words_to_speech(
            words, speech_segs,
            {"vad_clamp_per_char_ms": 50, "vad_clamp_fixed_margin_ms": 100},
        )
        self.assertEqual(adjusted_tight, 1)
        self.assertEqual(words[0]["end_ms"], 500)


class PersistClampedWordsTests(unittest.TestCase):
    """改善8-A-1: VADクランプ結果がSTT成果物ファイルへ書き戻されることのテスト。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_run_step_persists_clamped_word_timings_to_stt_file(self):
        stt_data = {
            "words": [
                {"id": "w-0000", "text": "あ", "start_ms": 50, "end_ms": 150, "confidence": 0.0},
                {"id": "w-0001", "text": "い", "start_ms": 150, "end_ms": 350, "confidence": 0.0},
                # word40「た」相当: 無音を跨いで異常伸長 (1000 -> 5000ms)
                {"id": "w-0002", "text": "た", "start_ms": 1000, "end_ms": 5000, "confidence": 0.0},
            ],
            "sentences": [
                {"id": "sent_0", "text": "あい", "start_ms": 50, "end_ms": 350, "word_ids": ["w-0000", "w-0001"]},
                {"id": "sent_1", "text": "た", "start_ms": 1000, "end_ms": 5000, "word_ids": ["w-0002"]},
            ],
        }
        stt_path = self.tmp_path / "stt.json"
        stt_path.write_text(json.dumps(stt_data, ensure_ascii=False), encoding="utf-8")
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", {"scenes": []})
        vad_path = _write(
            self.tmp_path / "vad.json",
            {"speech_segments": [{"start_ms": 0, "end_ms": 350}, {"start_ms": 950, "end_ms": 1300}]},
        )
        output_dir = str(self.tmp_path / "out")

        run_step(
            str(stt_path), fillers_path, retakes_path, scenes_path, output_dir,
            config={"min_segment_duration_ms": 0, "min_segment_chars": 0},
            vad_result_path=vad_path,
        )

        # メモリ内の戻り値だけでなく、--stt に渡したファイル自体が書き換わっていること
        persisted = json.loads(stt_path.read_text(encoding="utf-8"))
        persisted_word = next(w for w in persisted["words"] if w["id"] == "w-0002")
        self.assertEqual(persisted_word["end_ms"], 1300)
        persisted_sentence = next(s for s in persisted["sentences"] if s["id"] == "sent_1")
        self.assertEqual(persisted_sentence["end_ms"], 1300)
        # 変化していない単語・文はそのまま
        untouched_word = next(w for w in persisted["words"] if w["id"] == "w-0000")
        self.assertEqual(untouched_word["end_ms"], 150)

    def test_run_step_does_not_rewrite_stt_file_when_no_adjustment_needed(self):
        stt_data = {
            "words": [
                {"id": "w-0000", "text": "あ", "start_ms": 50, "end_ms": 150, "confidence": 0.0},
            ],
            "sentences": [
                {"id": "sent_0", "text": "あ", "start_ms": 50, "end_ms": 150, "word_ids": ["w-0000"]},
            ],
        }
        stt_path = self.tmp_path / "stt.json"
        original_text = json.dumps(stt_data, ensure_ascii=False)
        stt_path.write_text(original_text, encoding="utf-8")
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", {"scenes": []})
        vad_path = _write(self.tmp_path / "vad.json", {"speech_segments": [{"start_ms": 0, "end_ms": 200}]})
        output_dir = str(self.tmp_path / "out")

        run_step(
            str(stt_path), fillers_path, retakes_path, scenes_path, output_dir,
            config={"min_segment_duration_ms": 0, "min_segment_chars": 0},
            vad_result_path=vad_path,
        )

        # 補正不要なら元ファイルのバイト列を書き換えない (無駄な書き込みを避ける)
        self.assertEqual(stt_path.read_text(encoding="utf-8"), original_text)


class KeepSegmentVadTrimTests(unittest.TestCase):
    """改善8-A-3: keep_segmentsをVAD発話区間と交差させる末尾トリム・内部分割のテスト。"""

    def test_internal_silence_over_threshold_splits_segment(self):
        keep_segments = [{"start_ms": 1000, "end_ms": 5000, "text": "test", "scene_id": "s1"}]
        remaining_words = [
            {"id": "w0", "text": "あ", "start_ms": 1200, "end_ms": 1400},
            {"id": "w1", "text": "い", "start_ms": 3200, "end_ms": 3400},
        ]
        speech_segs = [
            {"start_ms": 1100, "end_ms": 1500},
            {"start_ms": 3100, "end_ms": 3500},
        ]
        result = _apply_vad_speech_trim(
            keep_segments, remaining_words, speech_segs,
            lead_padding_ms=200, tail_padding_ms=120, min_internal_silence_ms=500,
        )
        self.assertEqual(len(result), 2)
        self.assertEqual((result[0]["start_ms"], result[0]["end_ms"]), (1000, 1620))
        self.assertEqual((result[1]["start_ms"], result[1]["end_ms"]), (2900, 3620))
        self.assertEqual(result[0]["text"], "あ")
        self.assertEqual(result[1]["text"], "い")
        # 分割後もscene_idは引き継がれる (最終的にはrun_step側で再計算される)
        self.assertEqual(result[0]["scene_id"], "s1")
        self.assertEqual(result[1]["scene_id"], "s1")
        # 受け入れ条件相当: 各サブセグメント内部に500ms超の無音が残っていないこと
        for seg in result:
            self.assertLessEqual(seg["end_ms"] - seg["start_ms"], 1000)

    def test_no_internal_gap_below_threshold_is_not_split(self):
        keep_segments = [{"start_ms": 0, "end_ms": 2000, "text": "test", "scene_id": None}]
        remaining_words = [
            {"id": "w0", "text": "あ", "start_ms": 100, "end_ms": 300},
            {"id": "w1", "text": "い", "start_ms": 600, "end_ms": 800},
        ]
        speech_segs = [
            {"start_ms": 50, "end_ms": 350},
            {"start_ms": 550, "end_ms": 850},
        ]
        result = _apply_vad_speech_trim(
            keep_segments, remaining_words, speech_segs,
            lead_padding_ms=200, tail_padding_ms=120, min_internal_silence_ms=500,
        )
        # gap = 550-350 = 200ms < 500ms -> 分割しない。ただし末尾トリムは効く
        self.assertEqual(len(result), 1)

    def test_tail_silence_trimmed_to_tail_padding(self):
        keep_segments = [{"start_ms": 0, "end_ms": 2000, "text": "x", "scene_id": "s1"}]
        remaining_words = [{"id": "w0", "text": "あ", "start_ms": 100, "end_ms": 900}]
        speech_segs = [{"start_ms": 50, "end_ms": 950}]
        result = _apply_vad_speech_trim(
            keep_segments, remaining_words, speech_segs,
            lead_padding_ms=200, tail_padding_ms=120, min_internal_silence_ms=500,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["start_ms"], 0)
        self.assertEqual(result[0]["end_ms"], 950 + 120)

    def test_segment_without_any_vad_overlap_is_unchanged(self):
        keep_segments = [{"start_ms": 100, "end_ms": 200, "text": "z", "scene_id": None}]
        remaining_words = []
        speech_segs = [{"start_ms": 5000, "end_ms": 6000}]
        result = _apply_vad_speech_trim(
            keep_segments, remaining_words, speech_segs,
            lead_padding_ms=200, tail_padding_ms=120, min_internal_silence_ms=500,
        )
        self.assertEqual(result, keep_segments)

    def test_no_speech_segs_returns_segments_unchanged(self):
        keep_segments = [{"start_ms": 100, "end_ms": 200, "text": "z", "scene_id": None}]
        result = _apply_vad_speech_trim(
            keep_segments, [], [], lead_padding_ms=200, tail_padding_ms=120,
        )
        self.assertEqual(result, keep_segments)


class Img5952AcceptanceCriteriaTests(unittest.TestCase):
    """改善8-Aの受け入れ条件を模した回帰テスト:
    word-gapクラスタリングでは検出できない(gapがmax_gap_ms未満の)VAD無音を、
    segmentのVADトリムが検出して分割できること。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_vad_detected_internal_silence_not_caught_by_word_gap_is_split(self):
        # word間ギャップは550ms (max_gap_ms=600未満なので同一クラスタのまま) だが、
        # VADはその間を無音(500ms超)と判定しているケース。
        words = [
            {"id": "w-0", "text": "あ", "start_ms": 0, "end_ms": 200, "confidence": 0.0},
            {"id": "w-1", "text": "い", "start_ms": 750, "end_ms": 950, "confidence": 0.0},
        ]
        sentences = [
            {"id": "sent_0", "text": "あい", "start_ms": 0, "end_ms": 950, "word_ids": ["w-0", "w-1"]},
        ]
        stt_path = _write(self.tmp_path / "stt.json", {"words": words, "sentences": sentences})
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", {"scenes": []})
        vad_path = _write(
            self.tmp_path / "vad.json",
            {"speech_segments": [{"start_ms": 0, "end_ms": 200}, {"start_ms": 750, "end_ms": 950}]},
        )
        output_dir = str(self.tmp_path / "out")

        result = run_step(
            stt_path, fillers_path, retakes_path, scenes_path, output_dir,
            config={"min_segment_duration_ms": 0, "min_segment_chars": 0, "max_gap_ms": 600},
            vad_result_path=vad_path,
        )
        segments = result["keep_segments"]
        # word-gapベースのクラスタリングだけなら1segmentのままだが、
        # VADトリムにより内部の無音(550ms > 500ms閾値)で分割される
        self.assertEqual(len(segments), 2)
        for seg in segments:
            self.assertLessEqual(seg["end_ms"] - seg["start_ms"], 1000)

    def test_post_split_short_segment_merge_does_not_rebridge_internal_silence(self):
        """回帰テスト: VADトリムでの分割後に走る短セグメント統合パスが、
        分割元の大きな無音を再びブリッジして復活させてしまわないこと。

        cluster1 (5文字, min_chars以上) と、遠く離れた短いcluster2 (2文字,
        min_chars未満) がある場合、最初の短セグメント統合でcluster2はcluster1に
        統合され、内部に2000msの無音を含む1つの大きなsegmentができる。
        VADトリムはこれを検出して2つに分割するはずだが、その直後の短セグメント
        統合パスがmax_bridge_gap_msガードなしだと再度ブリッジしてしまう。
        """
        words = [
            {"id": "w-0", "text": "あ", "start_ms": 0, "end_ms": 200, "confidence": 0.0},
            {"id": "w-1", "text": "い", "start_ms": 200, "end_ms": 400, "confidence": 0.0},
            {"id": "w-2", "text": "う", "start_ms": 400, "end_ms": 600, "confidence": 0.0},
            {"id": "w-3", "text": "え", "start_ms": 600, "end_ms": 800, "confidence": 0.0},
            {"id": "w-4", "text": "お", "start_ms": 800, "end_ms": 1000, "confidence": 0.0},
            # cluster1との間に2800msギャップ (max_gap_ms=250を大きく超え、別クラスタになる)
            {"id": "w-5", "text": "三", "start_ms": 3800, "end_ms": 3900, "confidence": 0.0},
            {"id": "w-6", "text": "、", "start_ms": 3900, "end_ms": 4000, "confidence": 0.0},
        ]
        sentences = [
            {"id": "sent_0", "text": "あいうえお", "start_ms": 0, "end_ms": 1000,
             "word_ids": ["w-0", "w-1", "w-2", "w-3", "w-4"]},
            {"id": "sent_1", "text": "三、", "start_ms": 3800, "end_ms": 4000, "word_ids": ["w-5", "w-6"]},
        ]
        stt_path = _write(self.tmp_path / "stt.json", {"words": words, "sentences": sentences})
        fillers_path = _write(self.tmp_path / "fillers.json", {"fillers": []})
        retakes_path = _write(self.tmp_path / "retakes.json", {"retakes": []})
        scenes_path = _write(self.tmp_path / "scenes.json", {"scenes": []})
        vad_path = _write(
            self.tmp_path / "vad.json",
            {"speech_segments": [{"start_ms": 0, "end_ms": 1000}, {"start_ms": 3800, "end_ms": 4000}]},
        )
        output_dir = str(self.tmp_path / "out")

        result = run_step(
            stt_path, fillers_path, retakes_path, scenes_path, output_dir,
            config={
                "min_segment_duration_ms": 1000,
                "min_segment_chars": 5,
                "max_gap_ms": 250,
                "lead_padding_ms": 50,
                "tail_padding_ms": 50,
            },
            vad_result_path=vad_path,
        )
        segments = result["keep_segments"]
        # 修正前は短いcluster2("三、")がcluster1に再統合され、内部に2000ms超の
        # 無音を含む1segmentになってしまっていた。修正後は2segmentのまま維持される。
        self.assertEqual(len(segments), 2)

        vad = json.loads(Path(vad_path).read_text(encoding="utf-8"))
        speech_segs = vad["speech_segments"]
        for seg in segments:
            overlapping = sorted(
                (s for s in speech_segs if s["end_ms"] > seg["start_ms"] and s["start_ms"] < seg["end_ms"]),
                key=lambda s: s["start_ms"],
            )
            prev_end = None
            for s in overlapping:
                s_start = max(s["start_ms"], seg["start_ms"])
                s_end = min(s["end_ms"], seg["end_ms"])
                if prev_end is not None:
                    self.assertLessEqual(s_start - prev_end, 500)
                prev_end = s_end


if __name__ == "__main__":
    unittest.main()
