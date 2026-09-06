"""フェーズW4: OPタイトルのAI自動生成のテスト。

- sanitize_op_title: OPディレクター第2パスが返すタイトルの正規化
- build_op: タイトルの優先順位 = ユーザー入力 > AI生成(ai_title)。
  W11-5: 動画ファイル名へのフォールバックは廃止(両方空なら空文字=非表示)
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import sanitize_op_title
from shared.opening import build_op, load_op_patterns


class SanitizeOpTitleTests(unittest.TestCase):
    def test_normalizes_whitespace_and_quotes(self):
        self.assertEqual(sanitize_op_title("  定時8時は非人道的  "), "定時8時は非人道的")
        self.assertEqual(sanitize_op_title("「共通テスト国語の攻略」"), "共通テスト国語の攻略")
        self.assertEqual(sanitize_op_title("上段\n下段"), "上段 下段")
        self.assertEqual(sanitize_op_title("複数   空白"), "複数 空白")

    def test_rejects_empty_and_too_long(self):
        self.assertEqual(sanitize_op_title(""), "")
        self.assertEqual(sanitize_op_title(None), "")
        self.assertEqual(sanitize_op_title("   "), "")
        # 全角15文字超は切り詰めず不成立(空文字)= 従来フォールバックに任せる
        self.assertEqual(sanitize_op_title("あ" * 16), "")
        # 全角15文字ちょうどは有効
        self.assertEqual(sanitize_op_title("あ" * 15), "あ" * 15)

    def test_ascii_counts_as_half_width(self):
        # 半角30文字=全角15文字相当まで有効
        self.assertEqual(sanitize_op_title("a" * 30), "a" * 30)
        self.assertEqual(sanitize_op_title("a" * 31), "")


class BuildOpAiTitleTests(unittest.TestCase):
    _KEEP_SEGMENTS = [{"start_ms": 0, "end_ms": 20000}]
    _CUTS = [
        {"video": {"file_path": "/run/segments/seg_000.mp4", "start_ms": 0},
         "timeline": {"start_ms": 0, "end_ms": 20000}},
    ]

    def _build(self, user_title: str, ai_title: str):
        return build_op(
            {"pattern": "title_card", "title": user_title, "catch_copy": ""},
            load_op_patterns(), [], self._KEEP_SEGMENTS, self._CUTS,
            "/videos/元ファイル名.mp4", ai_title=ai_title,
        )

    def test_user_title_wins_over_ai(self):
        op = self._build("ユーザーのタイトル", "AIのタイトル")
        self.assertEqual(op["title"], "ユーザーのタイトル")

    def test_ai_title_used_when_user_empty(self):
        op = self._build("", "AIのタイトル")
        self.assertEqual(op["title"], "AIのタイトル")

    def test_empty_when_both_empty(self):
        # W11-5: ファイル名フォールバック廃止。両方空ならタイトルは空(=非表示)
        self.assertEqual(self._build("", "")["title"], "")
        # 空白のみのai_titleも空扱い
        self.assertEqual(self._build("", "   ")["title"], "")

    def test_ai_title_passes_through_teaser_fallback(self):
        # highlight_teaser で候補ゼロ→title_cardフォールバック時もAIタイトルを保持する
        op = build_op(
            {"pattern": "highlight_teaser", "decoration": "flash_pop",
             "text_animation": "slide_left", "title": "", "catch_copy": "", "clips": None},
            load_op_patterns(), [], self._KEEP_SEGMENTS, self._CUTS,
            "/videos/元ファイル名.mp4", ai_title="AIのタイトル",
        )
        self.assertEqual(op["pattern"], "title_card")
        self.assertEqual(op["title"], "AIのタイトル")


if __name__ == "__main__":
    unittest.main()
