"""空テロップスロット(テロップなしの明示)のフォールバック抑止テスト。

実機FB「一番最後のテキストの修正ができない・タイムラインにブロックが無い・削除しても残り続ける」対応。

根本原因: 相槌シーンの自動空欄(W10-7)やユーザーの文言削除で空テキストになったスロットが
UI適用時にdirectivesから丸ごと落とされ、step08が「スロットの無いカット」として
STTテキストからテロップを自動再生成していた(消したはずの文言が書き出しに復活する)。

対策:
1. UI(main/index.cjs)は空テキストスロットを text:"" / dropped:true のマーカーとして残す
2. step08はスロットが選ばれたカットでは pages=[](テロップなし)を尊重し、
   build_telop_pages によるフォールバック再生成を行わない
   (スロットが1つも無いカットのフォールバックは従来どおり=後方互換)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step08_composition
from shared.direction import assign_slots_to_segments, build_directed_cut_content


def make_words(specs):
    return [{"text": t, "start_ms": s, "end_ms": e} for t, s, e in specs]


class EmptySlotCutContentTests(unittest.TestCase):
    """build_directed_cut_content: 空テキストスロットのみのカットは ([], []) を返す。"""

    def test_all_empty_slots_yield_empty_pages(self):
        slots = [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 3000, "text": "",
             "style": "fact_yellow", "highlight_words": [], "dropped": True},
        ]
        pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertEqual(pages, [])
        self.assertEqual(telops, [])

    def test_mixed_slots_keep_only_nonempty(self):
        slots = [
            {"slot_id": "s0", "start_ms": 0, "end_ms": 1500, "text": "",
             "style": "fact_yellow", "highlight_words": [], "dropped": True},
            {"slot_id": "s1", "start_ms": 1500, "end_ms": 3000, "text": "本編テロップ",
             "style": "fact_yellow", "highlight_words": []},
        ]
        pages, telops = build_directed_cut_content("cut_001", slots, [], 3000, 16)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["lines"], ["本編テロップ"])
        self.assertEqual(len(telops), 1)


class Step08EmptySlotTests(unittest.TestCase):
    """step08: 空スロットのカットはテロップなし、スロット皆無のカットは従来フォールバック。"""

    def _run_step08(self, tmp: Path, slots, directives_extra=None):
        proposal = {
            "keep_segments": [
                {"start_ms": 0, "end_ms": 3500, "text": "絶対にやめてください"},
                {"start_ms": 5000, "end_ms": 8000, "text": "はい"},
                {"start_ms": 9000, "end_ms": 12000, "text": "スロットなしのカットです"},
            ],
            "stats": {"original_duration_ms": 13000, "reduction_ratio": 0.28},
        }
        stt = {
            "words": make_words([
                ("絶対に", 100, 800), ("やめて", 900, 2000), ("ください", 2100, 3400),
                ("はい", 5200, 7500),
                ("スロットなしの", 9200, 10500), ("カットです", 10600, 11900),
            ]),
        }
        run_dir = tmp / "run"
        output_dir = run_dir / "step08_composition"
        output_dir.mkdir(parents=True)
        proposal_path = run_dir / "cut_proposal.json"
        stt_path = run_dir / "stt_corrected.json"
        proposal_path.write_text(json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
        stt_path.write_text(json.dumps(stt, ensure_ascii=False), encoding="utf-8")
        directives = {
            "version": "1.0",
            "mode": "directed",
            "enabled": True,
            "chapters": [],
            "overlays": [],
            "slots": slots,
            **(directives_extra or {}),
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

    def _slots(self):
        return [
            {"slot_id": "cut_001_s00", "cut_id": "cut_001", "source_start_ms": 0, "source_end_ms": 3500,
             "source_text": "絶対にやめてください", "text": "絶対にやめてください",
             "type": "emphasis", "style": "emotion_red", "highlight_words": [], "fallback": False},
            # 相槌の自動空欄・ユーザー削除由来の「テロップなし」マーカー(UIが書き込む形)
            {"slot_id": "cut_002_s00", "cut_id": "cut_002", "source_start_ms": 5000, "source_end_ms": 8000,
             "source_text": "はい", "text": "",
             "style": "fact_yellow", "highlight_words": [], "fallback": False, "dropped": True},
            # cut_003(9000-12000)にはスロットを置かない=従来フォールバックの後方互換確認
        ]

    def test_empty_slot_cut_has_no_telop(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), self._slots())
            # 空スロットのカット: STTテキスト「はい」から再生成しない
            self.assertEqual(comp["timeline"]["cuts"][1]["telop"]["pages"], [])
            self.assertEqual(comp["voice_data"]["cuts"][1]["telops"], [])
            # 通常スロットのカットは従来どおり
            self.assertEqual(len(comp["timeline"]["cuts"][0]["telop"]["pages"]), 1)

    def test_cut_without_any_slot_still_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            comp = self._run_step08(Path(tmp_dir), self._slots())
            # スロットが1つも無いカットはSTTテキストからのフォールバック生成を維持(後方互換)
            fallback_pages = comp["timeline"]["cuts"][2]["telop"]["pages"]
            self.assertTrue(fallback_pages, "スロット皆無のカットは従来フォールバックでテロップを生成する")
            self.assertIn("スロットなしの", "".join(
                line for page in fallback_pages for line in page.get("lines", [])
            ))

    def test_edited_by_ui_blocks_stt_fallback(self):
        """実機FB 2026-09-03: UI適用済みrunではスロット皆無カットにSTT再生成しない。

        UIに存在しない(=編集も削除もできない)テキストが書き出しへ復活する経路の遮断。
        """
        with tempfile.TemporaryDirectory() as tmp_dir:
            # cut_003にはスロットが無い+edited_by_ui=UI適用済み → テロップなし
            slots = [s for s in self._slots() if s["cut_id"] != "cut_003"]
            comp = self._run_step08(Path(tmp_dir), slots, directives_extra={"edited_by_ui": True})
            self.assertEqual(comp["timeline"]["cuts"][2]["telop"]["pages"], [])
            self.assertEqual(comp["voice_data"]["cuts"][2]["telops"], [])
            # 通常スロットのカットは従来どおり
            self.assertEqual(len(comp["timeline"]["cuts"][0]["telop"]["pages"]), 1)

    def test_midpoint_outside_segment_slot_still_applies(self):
        """実機FB 2026-09-03: シーン末尾の大幅削除でスロット中点が縮んだ区間の外に落ちても、
        重なり最大のカットへ割り当てられ、UIの編集(ここでは空欄=削除)が書き出しへ反映される。
        """
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            # 最後のセグメントはシーン(9000-12000)の前半だけ残した状態(9000-10000)。
            # スロットはシーン全範囲アンカーのため中点10500が区間外になる。
            proposal = {
                "keep_segments": [
                    {"start_ms": 0, "end_ms": 3500, "text": "絶対にやめてください"},
                    {"start_ms": 9000, "end_ms": 10000, "text": "スロットなしの"},
                ],
                "stats": {"original_duration_ms": 13000, "reduction_ratio": 0.28},
            }
            stt = {
                "words": make_words([
                    ("絶対に", 100, 800), ("やめて", 900, 2000), ("ください", 2100, 3400),
                    ("スロットなしの", 9200, 10500), ("カットです", 10600, 11900),
                ]),
            }
            run_dir = tmp / "run"
            output_dir = run_dir / "step08_composition"
            output_dir.mkdir(parents=True)
            (run_dir / "cut_proposal.json").write_text(
                json.dumps(proposal, ensure_ascii=False), encoding="utf-8")
            (run_dir / "stt_corrected.json").write_text(
                json.dumps(stt, ensure_ascii=False), encoding="utf-8")
            directives = {
                "version": "1.0", "mode": "directed", "enabled": True,
                "chapters": [], "overlays": [], "edited_by_ui": True,
                "slots": [
                    {"slot_id": "s0", "cut_id": "cut_001", "source_start_ms": 0,
                     "source_end_ms": 3500, "source_text": "絶対にやめてください",
                     "text": "絶対にやめてください", "style": "emotion_red",
                     "highlight_words": [], "fallback": False},
                    # ユーザーが文言を消したシーン(中点10500はセグメント9000-10000の外)
                    {"slot_id": "s1", "cut_id": "cut_002", "source_start_ms": 9000,
                     "source_end_ms": 12000, "source_text": "スロットなしのカットです",
                     "text": "", "style": "fact_yellow", "highlight_words": [],
                     "fallback": False, "dropped": True},
                ],
            }
            (run_dir / "telop_directives.json").write_text(
                json.dumps(directives, ensure_ascii=False), encoding="utf-8")
            fake_metadata = {"video": {"width": 1920, "height": 1080, "rotation": 0}}
            with mock.patch.object(step08_composition, "get_video_metadata", return_value=fake_metadata), \
                    mock.patch.object(step08_composition, "_extract_segments"):
                comp = step08_composition.run_step(
                    str(run_dir / "cut_proposal.json"),
                    str(run_dir / "stt_corrected.json"),
                    str(tmp / "dummy.mp4"),
                    str(output_dir),
                )
            # 空欄スロットが重なりフォールバックでcut_002に選ばれ、STT再生成されない
            self.assertEqual(comp["timeline"]["cuts"][1]["telop"]["pages"], [])
            self.assertEqual(comp["voice_data"]["cuts"][1]["telops"], [])


class AssignSlotsToSegmentsTests(unittest.TestCase):
    """assign_slots_to_segments: 中点一致→重なり最大フォールバックの割り当て規則。"""

    SEGMENTS = [
        {"start_ms": 0, "end_ms": 3000},
        {"start_ms": 5000, "end_ms": 6000},
    ]

    def _slot(self, start, end, slot_id="s"):
        return {"slot_id": slot_id, "source_start_ms": start, "source_end_ms": end,
                "text": "t", "style": "fact_yellow", "highlight_words": []}

    def test_midpoint_rule_first(self):
        assigned = assign_slots_to_segments([self._slot(1000, 2000)], self.SEGMENTS)
        self.assertEqual(len(assigned[0]), 1)
        self.assertEqual(assigned[0][0]["start_ms"], 1000)
        self.assertEqual(assigned[0][0]["end_ms"], 2000)
        self.assertEqual(assigned[1], [])

    def test_midpoint_outside_uses_max_overlap(self):
        # シーン5000-9000の末尾がトリムされセグメントは5000-6000。中点7000は区間外だが
        # 重なり1000msのセグメント2へ割り当てられる(カット相対でクランプ)。
        assigned = assign_slots_to_segments([self._slot(5000, 9000)], self.SEGMENTS)
        self.assertEqual(assigned[0], [])
        self.assertEqual(len(assigned[1]), 1)
        self.assertEqual(assigned[1][0]["start_ms"], 0)
        self.assertEqual(assigned[1][0]["end_ms"], 1000)

    def test_no_overlap_slot_is_dropped(self):
        # シーン丸ごと削除(どのセグメントとも重ならない)スロットは不採用
        assigned = assign_slots_to_segments([self._slot(3500, 4500)], self.SEGMENTS)
        self.assertEqual(assigned, [[], []])

    def test_sorted_by_relative_start(self):
        assigned = assign_slots_to_segments(
            [self._slot(2000, 2500, "late"), self._slot(500, 1500, "early")],
            self.SEGMENTS,
        )
        self.assertEqual([s["slot_id"] for s in assigned[0]], ["early", "late"])


if __name__ == "__main__":
    unittest.main()
