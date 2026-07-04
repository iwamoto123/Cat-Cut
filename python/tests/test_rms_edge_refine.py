"""改善9-A: RMSエッジリファインと句読点ルールのテスト。"""
import json
import shutil
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from step07_cut_proposal import (
    _apply_rms_edge_refine,
    _clamp_words_to_segment_bounds,
    _compute_frame_rms,
    _find_voiced_frame_range,
    _load_mono_audio_samples,
    _rms_threshold_for_segment,
    run_step,
)
from shared.project_config import load_project_config
from shared.telop_builder import build_telop_pages


def _write(path: Path, data: dict) -> str:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return str(path)


def _write_sine_wav(path: Path, *, start_ms: int, voiced_ms: int, tail_silence_ms: int, freq: float = 440.0):
    """先頭/末尾無音付きのテスト用 WAV (16kHz mono) を生成する。"""
    sample_rate = 16000
    head_samples = int(start_ms * sample_rate / 1000)
    voiced_samples = int(voiced_ms * sample_rate / 1000)
    tail_samples = int(tail_silence_ms * sample_rate / 1000)
    total = head_samples + voiced_samples + tail_samples
    t = np.arange(total, dtype=np.float32) / sample_rate
    samples = np.zeros(total, dtype=np.float32)
    voiced = slice(head_samples, head_samples + voiced_samples)
    samples[voiced] = 0.35 * np.sin(2 * np.pi * freq * t[voiced])
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())


class RmsThresholdTests(unittest.TestCase):
    def test_threshold_is_relative_to_noise_floor(self):
        quiet = np.array([0.01, 0.012, 0.011, 0.013], dtype=np.float32)
        loud = np.array([0.01, 0.012, 0.5, 0.48, 0.01], dtype=np.float32)
        self.assertLess(_rms_threshold_for_segment(quiet), _rms_threshold_for_segment(loud))

    def test_find_voiced_requires_consecutive_frames(self):
        rms = np.array([0.01, 0.5, 0.01, 0.6, 0.62], dtype=np.float32)
        first, last = _find_voiced_frame_range(rms, threshold=0.2, min_consecutive=2)
        self.assertEqual(first, 3)
        self.assertEqual(last, 4)


class RmsEdgeRefineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_tightens_head_and_tail_silence_only(self):
        wav_path = self.tmp_path / "audio.wav"
        # segment 0-3000ms, voiced 200-1000ms, head 200ms tail 2000ms silence
        _write_sine_wav(wav_path, start_ms=200, voiced_ms=800, tail_silence_ms=2000)
        keep_segments = [{"start_ms": 0, "end_ms": 3000, "text": "test", "scene_id": None}]
        result, refined = _apply_rms_edge_refine(
            keep_segments, str(wav_path), head_pad_ms=80, tail_pad_ms=150,
        )
        self.assertEqual(refined, 1)
        self.assertGreater(result[0]["start_ms"], 0)
        self.assertLess(result[0]["end_ms"], 3000)
        self.assertGreaterEqual(result[0]["start_ms"], 120)  # ~200-80
        self.assertLessEqual(result[0]["end_ms"], 1150)      # ~1000+150

    def test_does_not_expand_segment(self):
        wav_path = self.tmp_path / "audio.wav"
        _write_sine_wav(wav_path, start_ms=0, voiced_ms=500, tail_silence_ms=0)
        keep_segments = [{"start_ms": 100, "end_ms": 400, "text": "x", "scene_id": None}]
        result, refined = _apply_rms_edge_refine(
            keep_segments, str(wav_path), head_pad_ms=80, tail_pad_ms=150,
        )
        self.assertEqual(refined, 0)
        self.assertEqual(result[0]["start_ms"], 100)
        self.assertEqual(result[0]["end_ms"], 400)


class ClampWordsToSegmentBoundsTests(unittest.TestCase):
    def test_clamps_start_and_end_to_segment(self):
        words = [
            {"id": "w0", "text": "あ", "start_ms": 90, "end_ms": 200},
            {"id": "w1", "text": "い", "start_ms": 200, "end_ms": 520},
        ]
        keep_segments = [{"start_ms": 100, "end_ms": 500, "text": "あい"}]
        adjusted = _clamp_words_to_segment_bounds(words, keep_segments)
        self.assertEqual(adjusted, 2)
        self.assertEqual(words[0]["start_ms"], 100)
        self.assertEqual(words[1]["end_ms"], 500)


class TelopPunctuationRulesTests(unittest.TestCase):
    def test_removes_period_from_all_pages(self):
        pages = build_telop_pages("締め切りですが。先着20名です。", cut_id="cut_001")
        for page in pages:
            for line in page["lines"]:
                self.assertNotIn("。", line)

    def test_keeps_comma_in_line_body(self):
        # 行中の読点は保持し、行末の読点のみ除去する(改善15-C)
        pages = build_telop_pages(
            "東京、大阪、名古屋",
            cut_id="cut_001",
            max_chars_per_line=20,
            max_lines_per_page=1,
        )
        joined = "".join("".join(p["lines"]) for p in pages)
        self.assertIn("、", joined)

    def test_moves_leading_comma_to_previous_page(self):
        # 人工的に2ページ相当: 長めの文 + 読点始まりの次文
        text = "ただし一人一人手厚く指導するので" + "、" + "枠には限りがあります"
        pages = build_telop_pages(
            text,
            cut_id="cut_001",
            max_chars_per_line=12,
            max_lines_per_page=1,
        )
        self.assertGreaterEqual(len(pages), 2)
        for page in pages:
            if page["lines"]:
                self.assertNotIn(page["lines"][0][0], "、。！？!?…")

    def test_no_page_starts_with_punctuation(self):
        text = "、枠には限りがあります。今回の夏期講習は締め切りですが。"
        pages = build_telop_pages(text, cut_id="cut_001", max_chars_per_line=12, max_lines_per_page=1)
        for page in pages:
            if page["lines"] and page["lines"][0]:
                self.assertNotIn(page["lines"][0][0], "、。！？!?…")


class Img5953AcceptanceTests(unittest.TestCase):
    """IMG_5953 コピーでの受け入れ条件 (step07 再処理)。"""

    @classmethod
    def setUpClass(cls):
        editor_root = Path(__file__).resolve().parents[2]
        cls.source_run = editor_root / "runs" / "20260703_230243_IMG_5953"
        if not cls.source_run.exists():
            raise unittest.SkipTest("IMG_5953 run data not found")

        cls._tmp = tempfile.TemporaryDirectory()
        cls.test_run = Path(cls._tmp.name) / "img5953_9a_test"
        shutil.copytree(cls.source_run, cls.test_run)

        project = editor_root / "templates" / "horizontal.yaml"
        stt = cls.test_run / "step02b_transcript_correct" / "stt_corrected.json"
        cfg = dict(load_project_config(str(project)).get("edit", {}))
        cfg["_timing"] = load_project_config(str(project)).get("timing", {})
        run_step(
            str(stt),
            str(cls.test_run / "step04_filler_detect" / "fillers.json"),
            str(cls.test_run / "step05_retake_detect" / "retakes.json"),
            str(cls.test_run / "step06_scene_structure" / "scenes.json"),
            str(cls.test_run / "step07_cut_proposal"),
            config=cfg,
            vad_result_path=str(cls.test_run / "step03_vad" / "vad_result.json"),
            audio_path=str(cls.test_run / "step01_preprocess" / "audio.wav"),
        )
        cls._load_results()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    @classmethod
    def _load_results(cls):
        with open(cls.test_run / "step07_cut_proposal" / "cut_proposal.json", encoding="utf-8") as f:
            cls.cut_proposal = json.load(f)
        with open(cls.test_run / "step02b_transcript_correct" / "stt_corrected.json", encoding="utf-8") as f:
            cls.stt = json.load(f)
        cls.audio_samples, cls.sample_rate = _load_mono_audio_samples(
            str(cls.test_run / "step01_preprocess" / "audio.wav")
        )

    def _measure_segment_silence(self, start_ms: int, end_ms: int) -> tuple[int, int]:
        frame_ms = 20
        frame_size = int(self.sample_rate * frame_ms / 1000)
        start_sample = int(start_ms * self.sample_rate / 1000)
        end_sample = int(end_ms * self.sample_rate / 1000)
        frame_rms = _compute_frame_rms(self.audio_samples[start_sample:end_sample], frame_size)
        threshold = 0.02  # 参考測定 (絶対値)
        voiced = frame_rms >= threshold
        first_voiced = None
        last_voiced = None
        for idx, v in enumerate(voiced):
            if v:
                if first_voiced is None:
                    first_voiced = idx
                last_voiced = idx
        if first_voiced is None:
            return end_ms - start_ms, end_ms - start_ms
        head_silence = first_voiced * frame_ms
        tail_silence = (len(frame_rms) - last_voiced - 1) * frame_ms
        return head_silence, tail_silence

    def test_rms_head_silence_within_120ms(self):
        for i, seg in enumerate(self.cut_proposal["keep_segments"]):
            head, _ = self._measure_segment_silence(seg["start_ms"], seg["end_ms"])
            with self.subTest(segment=i, head=head):
                self.assertLessEqual(head, 120)

    def test_rms_tail_silence_within_200ms(self):
        for i, seg in enumerate(self.cut_proposal["keep_segments"]):
            _, tail = self._measure_segment_silence(seg["start_ms"], seg["end_ms"])
            with self.subTest(segment=i, tail=tail):
                self.assertLessEqual(tail, 200)

    def test_words_fit_inside_segments(self):
        words = self.stt["words"]
        for i, seg in enumerate(self.cut_proposal["keep_segments"]):
            s0, s1 = seg["start_ms"], seg["end_ms"]
            for w in words:
                if w["end_ms"] <= s0 or w["start_ms"] >= s1:
                    continue
                with self.subTest(segment=i, word=w.get("id")):
                    self.assertGreaterEqual(w["start_ms"], s0)
                    self.assertLessEqual(w["end_ms"], s1)

    def test_telop_pages_have_no_periods_or_leading_punctuation(self):
        pages = []
        for i, seg in enumerate(self.cut_proposal["keep_segments"]):
            pages.extend(
                build_telop_pages(
                    seg.get("text", ""),
                    cut_id=f"cut_{i+1:03d}",
                    max_chars_per_line=16,
                    max_lines_per_page=1,
                )
            )
        for page in pages:
            for line in page["lines"]:
                self.assertNotIn("。", line)
                if line:
                    self.assertNotIn(line[0], "、。！？!?…")


if __name__ == "__main__":
    unittest.main()
