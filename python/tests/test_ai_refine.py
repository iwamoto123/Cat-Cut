"""改善8-A-5: LLM refineステップ (step06b_ai_refine.py) のテスト。

実際のネットワーク呼び出しは行わず、call_claude_fn の差し替え/APIキー未設定時の
スキップ挙動・応答の適用ロジックを中心に検証する。
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import step06b_ai_refine as ai_refine
from review_telop import TelopPage, parse_telop


SAMPLE_TELOP_TXT = """# Cat-Cut テロップ確認ファイル
#

# cut_001_p00 [00:00.00-00:02.00]
はい今日わね
テーマですです

# cut_002_p00 [00:02.00-00:04.00] @style=highlight
急遽お願いしました
"""


def _write_stt(path: Path, sentences_text: list[str]) -> None:
    data = {
        "sentences": [{"id": f"s{i}", "text": t} for i, t in enumerate(sentences_text)],
        "words": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class FindApiKeyTests(unittest.TestCase):
    def setUp(self):
        self._orig_env = dict(__import__("os").environ)

    def tearDown(self):
        import os
        os.environ.clear()
        os.environ.update(self._orig_env)

    def test_env_var_takes_priority(self):
        import os
        os.environ["ANTHROPIC_API_KEY"] = "env-key"
        self.assertEqual(ai_refine.find_api_key(Path("/nonexistent")), "env-key")

    def test_falls_back_to_env_file(self, ):
        import os, tempfile
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=file-key\nOTHER=1\n", encoding="utf-8")
            self.assertEqual(ai_refine.find_api_key(tmp_path), "file-key")

    def test_returns_empty_when_not_found(self):
        import os, tempfile
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(ai_refine.find_api_key(Path(tmp)), "")


class ExtractJsonTests(unittest.TestCase):
    def test_raw_json(self):
        result = ai_refine._extract_json('{"corrections": {}, "cuts": []}')
        self.assertEqual(result, {"corrections": {}, "cuts": []})

    def test_fenced_json(self):
        text = '```json\n{"corrections": {"a": "b"}}\n```'
        result = ai_refine._extract_json(text)
        self.assertEqual(result, {"corrections": {"a": "b"}})

    def test_json_surrounded_by_prose(self):
        text = 'ここに結果があります:\n{"corrections": {}}\nよろしくお願いします。'
        result = ai_refine._extract_json(text)
        self.assertEqual(result, {"corrections": {}})


class GroupPagesByCutTests(unittest.TestCase):
    def test_groups_consecutive_pages_by_cut_id(self):
        _, pages = parse_telop(SAMPLE_TELOP_TXT)
        groups = ai_refine._group_pages_by_cut(pages)
        self.assertEqual([cut_id for cut_id, _ in groups], ["cut_001", "cut_002"])
        self.assertEqual(len(groups[0][1]), 1)
        self.assertEqual(len(groups[1][1]), 1)

    def test_build_cuts_payload_joins_page_text(self):
        _, pages = parse_telop(SAMPLE_TELOP_TXT)
        payload = ai_refine.build_cuts_payload(pages)
        self.assertEqual(payload[0]["cut_id"], "cut_001")
        self.assertEqual(payload[0]["pages"], ["はい今日わねテーマですです"])
        self.assertEqual(payload[1]["pages"], ["急遽お願いしました"])


class ApplyRefineResponseTests(unittest.TestCase):
    def test_dictionary_corrections_applied_to_untouched_cuts(self):
        _, pages = parse_telop(SAMPLE_TELOP_TXT)
        response = {"corrections": {"今日わ": "今日は"}, "cuts": []}
        new_pages, stats = ai_refine.apply_refine_response(pages, response, 12, 1)
        self.assertEqual(len(new_pages), len(pages))
        self.assertIn("今日は", new_pages[0].body[0])
        self.assertEqual(stats["cuts_refined"], 0)
        self.assertGreaterEqual(stats["corrections_applied"], 1)

    def test_refined_cut_is_rewrapped_and_renumbered(self):
        _, pages = parse_telop(SAMPLE_TELOP_TXT)
        response = {
            "corrections": {},
            "cuts": [
                {"cut_id": "cut_001", "pages": ["はい今日は", "テーマです"]},
            ],
        }
        new_pages, stats = ai_refine.apply_refine_response(pages, response, 12, 1)
        self.assertEqual(stats["cuts_refined"], 1)
        cut_001_pages = [p for p in new_pages if p.page_id.startswith("cut_001_p")]
        self.assertEqual(len(cut_001_pages), 2)
        self.assertEqual(cut_001_pages[0].page_id, "cut_001_p00")
        self.assertEqual(cut_001_pages[1].page_id, "cut_001_p01")
        self.assertEqual(cut_001_pages[0].body, ["はい今日は"])
        self.assertEqual(cut_001_pages[1].body, ["テーマです"])
        # 時間範囲/styleを引き継がない (テキストマッチによる自動再計算に委ねる)
        self.assertNotIn("[", cut_001_pages[0].header)
        # 対象外のcut_002は変更されない
        cut_002_pages = [p for p in new_pages if p.page_id.startswith("cut_002_p")]
        self.assertEqual(len(cut_002_pages), 1)
        self.assertIn("@style=highlight", cut_002_pages[0].header)

    def test_refined_cut_page_texts_get_punctuation_stripped_and_rewrapped(self):
        _, pages = parse_telop(SAMPLE_TELOP_TXT)
        response = {
            "cuts": [
                {"cut_id": "cut_002", "pages": ["これは長い文章のテストで句点も含みます。改行位置を調整します。"]},
            ],
        }
        new_pages, stats = ai_refine.apply_refine_response(pages, response, 12, 1)
        cut_002_pages = [p for p in new_pages if p.page_id.startswith("cut_002_p")]
        self.assertGreater(len(cut_002_pages), 1)
        for page in cut_002_pages:
            self.assertEqual(len(page.body), 1)
            self.assertNotIn("。", page.body[0])


class RunStepTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.run_dir = self.tmp_path / "run"
        self.run_dir.mkdir()
        self.telop_path = self.run_dir / "telop.txt"
        self.telop_path.write_text(SAMPLE_TELOP_TXT, encoding="utf-8")
        self.stt_path = self.tmp_path / "stt.json"
        _write_stt(self.stt_path, ["はい今日は。", "テーマです。", "急遽お願いしました。"])
        self.output_path = self.run_dir / "step06b_ai_refine" / "refine.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_skips_when_telop_missing(self):
        self.telop_path.unlink()
        result = ai_refine.run_step(
            str(self.run_dir), str(self.stt_path), str(self.output_path), api_key="dummy",
        )
        self.assertFalse(result["enabled"])
        self.assertIn("not found", result["reason"])

    def test_skips_when_api_key_missing(self):
        original = self.telop_path.read_text(encoding="utf-8")
        result = ai_refine.run_step(
            str(self.run_dir), str(self.stt_path), str(self.output_path), api_key="",
        )
        self.assertFalse(result["enabled"])
        self.assertEqual(result["reason"], "no AI provider key set")
        # telop.txtはBudouX出力のまま変更されない
        self.assertEqual(self.telop_path.read_text(encoding="utf-8"), original)
        self.assertTrue(self.output_path.exists())

    def test_applies_response_and_updates_telop_file_when_key_present(self):
        def fake_caller(api_key, model, prompt):
            self.assertEqual(api_key, "dummy-key")
            return {
                "corrections": {"今日わ": "今日は"},
                "cuts": [{"cut_id": "cut_002", "pages": ["急遽お願いします"]}],
            }

        result = ai_refine.run_step(
            str(self.run_dir), str(self.stt_path), str(self.output_path),
            api_key="dummy-key", call_claude_fn=fake_caller,
        )
        self.assertTrue(result["enabled"])
        self.assertEqual(result["cuts_refined"], 1)
        updated = self.telop_path.read_text(encoding="utf-8")
        self.assertIn("今日は", updated)
        self.assertIn("急遽お願いします", updated)
        self.assertTrue(self.output_path.exists())
        saved = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertTrue(saved["enabled"])

    def test_api_error_is_caught_and_pipeline_continues(self):
        def failing_caller(api_key, model, prompt):
            raise RuntimeError("network down")

        original = self.telop_path.read_text(encoding="utf-8")
        result = ai_refine.run_step(
            str(self.run_dir), str(self.stt_path), str(self.output_path),
            api_key="dummy-key", call_claude_fn=failing_caller,
        )
        self.assertFalse(result["enabled"])
        self.assertIn("api_error", result["reason"])
        self.assertEqual(self.telop_path.read_text(encoding="utf-8"), original)

    def test_malformed_response_is_caught_and_pipeline_continues(self):
        def bad_caller(api_key, model, prompt):
            return {"cuts": "not-a-list-of-dicts-but-still-handled"}

        result = ai_refine.run_step(
            str(self.run_dir), str(self.stt_path), str(self.output_path),
            api_key="dummy-key", call_claude_fn=bad_caller,
        )
        # "cuts"が文字列でも apply_refine_response 側で安全に無視され、
        # correctionsなしの状態としてページ構造維持のまま完走する
        self.assertTrue(result["enabled"])


if __name__ == "__main__":
    unittest.main()
