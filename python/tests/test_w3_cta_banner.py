"""フェーズW3: cta_banner とCTAテロップの二重表示回避のテスト。

実データ 20260707_194708_国語の最後 で確認したバグ:
AIが cta_banner を「話者がCTAを言った瞬間」(source_anchor_ms=25100) にアンカーし、
同じ瞬間に type=cta のスロット(25100-29150ms「小テストで確認したい方は/公式LINEを追加」)の
テロップが表示されるため、ほぼ同文言の黄色ボックスが同時刻・同領域に2枚重なった。

対策(build_directed_overlays):
1. cta_banner はCTAテロップ区間(type=ctaスロット)と重ならない位置まで後ろ送り
2. 既に置いたバナー同士も重ねない
3. 総尺内に最小尺(1500ms)を確保できなければバナー自体を出さない
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared.direction import (
    CTA_BANNER_AVOID_MARGIN_MS,
    OVERLAY_DEFAULT_DURATION_MS,
    build_directed_overlays,
    cta_slot_timeline_intervals,
    resolve_cta_banner_window,
)


_SEGMENTS = [{"source_start_ms": 0, "source_end_ms": 300000, "timeline_start_ms": 0}]
_BANNER_MS = OVERLAY_DEFAULT_DURATION_MS["cta_banner"]


class CtaSlotIntervalTests(unittest.TestCase):
    def test_collects_only_cta_slots_in_timeline_order(self):
        directives = {
            "slots": [
                {"slot_id": "s1", "type": "cta", "source_start_ms": 25100, "source_end_ms": 29150},
                {"slot_id": "s2", "type": "default", "source_start_ms": 30000, "source_end_ms": 33000},
                {"slot_id": "s3", "type": "cta", "source_start_ms": 10000, "source_end_ms": 12000},
            ],
        }
        intervals = cta_slot_timeline_intervals(directives, _SEGMENTS, 300000)
        self.assertEqual(intervals, [(10000, 12000), (25100, 29150)])

    def test_skips_trimmed_and_invalid_slots(self):
        segments = [{"source_start_ms": 20000, "source_end_ms": 40000, "timeline_start_ms": 0}]
        directives = {
            "slots": [
                # トリムで消えた区間(セグメント外)は除外
                {"slot_id": "s1", "type": "cta", "source_start_ms": 5000, "source_end_ms": 8000},
                # 区間ゼロは除外
                {"slot_id": "s2", "type": "cta", "source_start_ms": 25000, "source_end_ms": 25000},
                {"slot_id": "s3", "type": "cta", "source_start_ms": 30000, "source_end_ms": 34000},
            ],
        }
        intervals = cta_slot_timeline_intervals(directives, segments, 20000)
        self.assertEqual(intervals, [(10000, 14000)])


class ResolveCtaBannerWindowTests(unittest.TestCase):
    def test_no_conflict_keeps_anchor(self):
        window = resolve_cta_banner_window(5000, [], 300000)
        self.assertEqual(window, (5000, 5000 + _BANNER_MS))

    def test_shifts_after_overlapping_cta_slot(self):
        # 実データの形: アンカー=CTAスロット開始と同時刻
        window = resolve_cta_banner_window(25100, [(25100, 29150)], 300000)
        expected_start = 29150 + CTA_BANNER_AVOID_MARGIN_MS
        self.assertEqual(window, (expected_start, expected_start + _BANNER_MS))

    def test_shifts_across_consecutive_conflicts(self):
        # 後ろ送り先にも別の回避区間がある場合は更に送る
        first = (10000, 14000)
        second_start = 14000 + CTA_BANNER_AVOID_MARGIN_MS + 1000
        second = (second_start, second_start + 5000)
        window = resolve_cta_banner_window(10000, [first, second], 300000)
        self.assertEqual(window[0], second[1] + CTA_BANNER_AVOID_MARGIN_MS)

    def test_drops_when_no_room_before_video_end(self):
        # 動画末尾のCTA: ずらすと最小尺を確保できない → 表示しない
        window = resolve_cta_banner_window(58000, [(58000, 61000)], 62000)
        self.assertIsNone(window)

    def test_clamps_to_total_duration_but_keeps_min(self):
        # 総尺でクランプされても最小尺(1500ms)があれば表示する
        window = resolve_cta_banner_window(58000, [], 60000)
        self.assertEqual(window, (58000, 60000))


class BuildOverlaysCtaBannerTests(unittest.TestCase):
    def test_real_run_shape_banner_shifts_after_cta_telop(self):
        # 20260707_194708 の再現: バナーがCTAテロップと同時刻に出ない
        directives = {
            "slots": [
                {"slot_id": "cut_005_s00", "type": "cta",
                 "source_start_ms": 25100, "source_end_ms": 29150},
            ],
            "overlays": [
                {"id": "ov_cta_banner_00", "type": "cta_banner", "source_anchor_ms": 25100,
                 "position": "bottom", "lines": ["公式LINEを追加", "古文文法と送る"]},
            ],
        }
        overlays = build_directed_overlays(directives, _SEGMENTS, 300000)
        banners = [o for o in overlays if o["type"] == "cta_banner"]
        self.assertEqual(len(banners), 1)
        self.assertGreaterEqual(banners[0]["start_ms"], 29150)

    def test_banners_do_not_overlap_each_other(self):
        directives = {
            "slots": [],
            "overlays": [
                {"type": "cta_banner", "source_anchor_ms": 10000, "lines": ["A"]},
                {"type": "cta_banner", "source_anchor_ms": 11000, "lines": ["B"]},
            ],
        }
        overlays = build_directed_overlays(directives, _SEGMENTS, 300000)
        banners = [o for o in overlays if o["type"] == "cta_banner"]
        self.assertEqual(len(banners), 2)
        first, second = banners
        self.assertGreaterEqual(second["start_ms"], first["end_ms"])

    def test_banner_dropped_when_video_ends_inside_cta(self):
        # 動画がCTAで終わる(ずらし先が無い)場合はバナーを出さない
        directives = {
            "slots": [
                {"slot_id": "s1", "type": "cta",
                 "source_start_ms": 58000, "source_end_ms": 61500},
            ],
            "overlays": [
                {"type": "cta_banner", "source_anchor_ms": 58000, "lines": ["公式LINEを追加"]},
            ],
        }
        segments = [{"source_start_ms": 0, "source_end_ms": 62000, "timeline_start_ms": 0}]
        overlays = build_directed_overlays(directives, segments, 62000)
        self.assertEqual([o for o in overlays if o["type"] == "cta_banner"], [])

    def test_non_cta_overlays_unaffected(self):
        # profile_card / list_stack は従来どおりアンカー位置のまま(後方互換)
        directives = {
            "slots": [
                {"slot_id": "s1", "type": "cta", "source_start_ms": 1000, "source_end_ms": 4000},
            ],
            "overlays": [
                {"type": "profile_card", "source_anchor_ms": 1000, "text": "山田太郎"},
                {"type": "list_stack", "source_anchor_ms": 2000, "lines": ["a", "b"]},
            ],
        }
        overlays = build_directed_overlays(directives, _SEGMENTS, 300000)
        card = next(o for o in overlays if o["type"] == "profile_card")
        stack = next(o for o in overlays if o["type"] == "list_stack")
        self.assertEqual(card["start_ms"], 1000)
        self.assertEqual(stack["start_ms"], 2000)


if __name__ == "__main__":
    unittest.main()
