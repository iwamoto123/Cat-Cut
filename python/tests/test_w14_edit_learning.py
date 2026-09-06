# W14-2: 修正履歴(correction_history.json)の読み込み・頻度上位抽出・
# step05/step06b プロンプトへの修正例注入のテスト。
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step05_ai_retake
import step06b_ai_refine
from shared.app_paths import default_correction_history_path, default_user_data_dir
from shared.transcript_correction import (
    load_correction_history,
    top_correction_examples,
)


class LoadCorrectionHistoryTests(unittest.TestCase):
    def _write(self, tmpdir: str, data) -> str:
        path = Path(tmpdir) / "correction_history.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return str(path)

    def test_missing_path_or_file_returns_empty(self):
        # 後方互換: パス未指定・ファイル無しは空リスト=完全従来動作
        self.assertEqual(load_correction_history(None), [])
        self.assertEqual(load_correction_history(""), [])
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertEqual(
                load_correction_history(str(Path(tmpdir) / "nai.json")), []
            )

    def test_broken_json_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "correction_history.json"
            path.write_text("{broken", encoding="utf-8")
            self.assertEqual(load_correction_history(str(path)), [])

    def test_valid_pairs_are_normalized(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write(
                tmpdir,
                {
                    "version": "1.0.0",
                    "pairs": [
                        {"before": "誤記A", "after": "正記A", "count": 3},
                        {"before": " 誤記B ", "after": "正記B"},
                    ],
                },
            )
            pairs = load_correction_history(path)
        self.assertEqual(
            pairs,
            [
                {"before": "誤記A", "after": "正記A", "count": 3},
                {"before": "誤記B", "after": "正記B", "count": 1},
            ],
        )

    def test_invalid_entries_are_dropped(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write(
                tmpdir,
                {
                    "pairs": [
                        {"before": "", "after": "正記"},
                        {"before": "同一", "after": "同一"},
                        {"before": "残る", "after": "残った", "count": "abc"},
                        "not-a-dict",
                    ]
                },
            )
            pairs = load_correction_history(path)
        # count が数値化できない場合は1へフォールバックし、他の無効エントリは捨てる
        self.assertEqual(pairs, [{"before": "残る", "after": "残った", "count": 1}])

    def test_non_dict_root_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write(tmpdir, ["not", "a", "dict"])
            self.assertEqual(load_correction_history(path), [])


class TopCorrectionExamplesTests(unittest.TestCase):
    def test_sorted_by_count_desc_and_limited(self):
        pairs = [
            {"before": "い", "after": "1", "count": 1},
            {"before": "さ", "after": "3", "count": 3},
            {"before": "に", "after": "2", "count": 2},
        ]
        top = top_correction_examples(pairs, limit=2)
        self.assertEqual([p["before"] for p in top], ["さ", "に"])

    def test_empty_and_zero_limit(self):
        self.assertEqual(top_correction_examples([], limit=30), [])
        self.assertEqual(
            top_correction_examples([{"before": "a", "after": "b", "count": 1}], limit=0),
            [],
        )


class DefaultCorrectionHistoryPathTests(unittest.TestCase):
    def test_path_is_under_user_data_dir(self):
        path = default_correction_history_path()
        self.assertEqual(path.name, "correction_history.json")
        self.assertEqual(path.parent, default_user_data_dir())


class Step05PromptInjectionTests(unittest.TestCase):
    def test_section_empty_without_examples(self):
        # 後方互換: 修正例が無ければ節は空文字=従来プロンプトのまま
        self.assertEqual(step05_ai_retake.build_correction_examples_section(None), "")
        self.assertEqual(step05_ai_retake.build_correction_examples_section([]), "")

    def test_prompt_contains_examples(self):
        sentences = [{"id": "sent_0000", "text": "テスト文です"}]
        examples = [{"before": "誤記A", "after": "正記A", "count": 4}]
        prompt = step05_ai_retake.build_prompt(sentences, correction_examples=examples)
        self.assertIn("ユーザーが過去に確定した修正例", prompt)
        self.assertIn("「誤記A」→「正記A」（4回修正）", prompt)

    def test_prompt_unchanged_without_examples(self):
        sentences = [{"id": "sent_0000", "text": "テスト文です"}]
        prompt = step05_ai_retake.build_prompt(sentences)
        self.assertNotIn("ユーザーが過去に確定した修正例", prompt)
        self.assertEqual(
            prompt, step05_ai_retake.build_prompt(sentences, correction_examples=None)
        )


class Step06bPromptInjectionTests(unittest.TestCase):
    def _build(self, examples):
        cuts = [{"cut_id": "cut_001", "pages": [{"page_id": "p1", "lines": ["テスト"]}]}]
        return step06b_ai_refine.build_prompt(
            "テスト全文", cuts, 15, 2, correction_examples=examples
        )

    def test_section_empty_without_examples(self):
        self.assertEqual(step06b_ai_refine.build_correction_examples_section(None), "")
        self.assertEqual(step06b_ai_refine.build_correction_examples_section([]), "")

    def test_prompt_contains_examples(self):
        prompt = self._build([{"before": "誤記B", "after": "正記B", "count": 2}])
        self.assertIn("ユーザーが過去に確定した修正例", prompt)
        self.assertIn("「誤記B」→「正記B」（2回修正）", prompt)
        # 決定的置換にしない旨の注意書きが入る
        self.assertIn("機械的に置換せず文脈で判断", prompt)

    def test_prompt_unchanged_without_examples(self):
        self.assertNotIn("ユーザーが過去に確定した修正例", self._build(None))
        self.assertEqual(self._build(None), self._build([]))

    def test_invalid_examples_are_skipped(self):
        section = step06b_ai_refine.build_correction_examples_section(
            [{"before": "", "after": "正記"}, {"before": "誤記", "after": ""}]
        )
        self.assertEqual(section, "")


if __name__ == "__main__":
    unittest.main()
