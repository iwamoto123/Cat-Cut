"""W11-1a/1b(書き出し高速化): step08 セグメント差分キャッシュのテスト。

1. キャッシュヒット時に ffmpeg が呼ばれない(2回目の実行で全スキップ)
2. 境界が動いたセグメントだけ再エンコードされる
3. manifest 掃除(未使用+7日超のみ削除、旧 cut_XXX.mp4 は対象外)
4. キャッシュキーの安定性(同入力=同ハッシュ、境界・mtime・エンコーダ変更で変わる)
5. VideoToolbox 判定のフォールバックとプロセス内キャッシュ
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import step08_composition


def make_cuts(source_path, boundaries):
    """(start_ms, end_ms) のリストから _extract_segments 入力のcutsを作る。"""
    return [
        {
            "cut_id": f"cut_{i + 1:03d}",
            "video": {"file_path": source_path, "start_ms": start, "end_ms": end},
        }
        for i, (start, end) in enumerate(boundaries)
    ]


def fake_ffmpeg(calls):
    """subprocess.run の代役: コマンドを記録し、出力先にダミーMP4を書いて成功を返す。"""

    def _run(cmd, capture_output=True, text=True):
        calls.append(list(cmd))
        Path(cmd[-1]).write_bytes(b"fake mp4 data")
        return mock.Mock(returncode=0, stdout="", stderr="")

    return _run


class SegmentCacheTests(unittest.TestCase):
    def setUp(self):
        # VideoToolbox 判定を固定(SW)してテストを環境非依存・決定的にする
        self._saved_vt = step08_composition._videotoolbox_available
        step08_composition._videotoolbox_available = False

    def tearDown(self):
        step08_composition._videotoolbox_available = self._saved_vt

    def _make_source(self, tmp: Path) -> str:
        source = tmp / "source.mp4"
        source.write_bytes(b"dummy source video")
        return str(source)

    def test_cache_hit_skips_ffmpeg(self):
        """2回目の実行では既存 seg_<hash>.mp4 を再利用し ffmpeg を呼ばない。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = self._make_source(tmp)
            output_dir = str(tmp / "step08")

            calls = []
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls)):
                cuts1 = make_cuts(source, [(0, 3000), (5000, 8000)])
                step08_composition._extract_segments(cuts1, source, output_dir, 0)
            self.assertEqual(len(calls), 2)

            # cuts は毎回 keep_segments から作り直される(実運用と同じ)
            calls2 = []
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls2)):
                cuts2 = make_cuts(source, [(0, 3000), (5000, 8000)])
                step08_composition._extract_segments(cuts2, source, output_dir, 0)
            self.assertEqual(len(calls2), 0, "キャッシュヒット時は ffmpeg が呼ばれない")

            # composition 側の参照は seg_<hash>.mp4 + start_ms=0 に更新される
            for cut in cuts2:
                video = cut["video"]
                self.assertRegex(os.path.basename(video["file_path"]), r"^seg_[0-9a-f]{16}\.mp4$")
                self.assertEqual(video["start_ms"], 0)
                self.assertTrue(os.path.exists(video["file_path"]))

            # 1回目と2回目で同じセグメントファイルを参照する
            self.assertEqual(
                [c["video"]["file_path"] for c in cuts1],
                [c["video"]["file_path"] for c in cuts2],
            )

    def test_only_changed_boundary_reencodes(self):
        """境界が動いたセグメントだけ再エンコードされる(差分キャッシュの本命)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = self._make_source(tmp)
            output_dir = str(tmp / "step08")

            calls = []
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls)):
                step08_composition._extract_segments(
                    make_cuts(source, [(0, 3000), (5000, 8000), (9000, 12000)]),
                    source, output_dir, 0,
                )
            self.assertEqual(len(calls), 3)

            # 2番目のカットだけ終端を+500ms(トリム)
            calls2 = []
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls2)):
                step08_composition._extract_segments(
                    make_cuts(source, [(0, 3000), (5000, 8500), (9000, 12000)]),
                    source, output_dir, 0,
                )
            self.assertEqual(len(calls2), 1, "境界が動いた1本だけ再エンコード")

    def test_manifest_cleanup_removes_stale_unused_only(self):
        """未使用+7日超のキャッシュだけ削除し、最近使用分と旧 cut_XXX.mp4 は残す。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = self._make_source(tmp)
            output_dir = str(tmp / "step08")
            segments_dir = tmp / "step08" / "segments"
            segments_dir.mkdir(parents=True)

            now = time.time()
            stale_hash = "a" * 16
            fresh_hash = "b" * 16
            (segments_dir / f"seg_{stale_hash}.mp4").write_bytes(b"stale")
            (segments_dir / f"seg_{fresh_hash}.mp4").write_bytes(b"fresh")
            # 旧形式(連番)は manifest 管理外=掃除対象外(後方互換)
            (segments_dir / "cut_001.mp4").write_bytes(b"legacy")
            (segments_dir / "manifest.json").write_text(
                json.dumps({
                    stale_hash: {"source": source, "start_ms": 0, "end_ms": 1000,
                                 "last_used": int(now - 8 * 24 * 60 * 60)},
                    fresh_hash: {"source": source, "start_ms": 0, "end_ms": 2000,
                                 "last_used": int(now - 60)},
                }),
                encoding="utf-8",
            )

            calls = []
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=fake_ffmpeg(calls)):
                step08_composition._extract_segments(
                    make_cuts(source, [(100, 900)]), source, output_dir, 0,
                )

            self.assertFalse((segments_dir / f"seg_{stale_hash}.mp4").exists(), "7日超+未使用は削除")
            self.assertTrue((segments_dir / f"seg_{fresh_hash}.mp4").exists(), "最近使用分は残す")
            self.assertTrue((segments_dir / "cut_001.mp4").exists(), "旧形式は掃除対象外")

            manifest = json.loads((segments_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertNotIn(stale_hash, manifest)
            self.assertIn(fresh_hash, manifest)
            # 今回使ったセグメントが manifest に記録されている
            used = [h for h, e in manifest.items() if e["start_ms"] == 100 and e["end_ms"] == 900]
            self.assertEqual(len(used), 1)

    def test_ffmpeg_failure_removes_partial_file(self):
        """ffmpeg 失敗時は書きかけファイルを消す(次回に壊れたキャッシュヒットをさせない)。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = self._make_source(tmp)
            output_dir = str(tmp / "step08")

            def failing_run(cmd, capture_output=True, text=True):
                Path(cmd[-1]).write_bytes(b"partial")
                return mock.Mock(returncode=1, stdout="", stderr="boom")

            cuts = make_cuts(source, [(0, 1000)])
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=failing_run):
                step08_composition._extract_segments(cuts, source, output_dir, 0)

            segments_dir = tmp / "step08" / "segments"
            self.assertEqual(list(segments_dir.glob("seg_*.mp4")), [])
            # 失敗カットは従来どおり元動画参照のまま(composition を壊さない)
            self.assertEqual(cuts[0]["video"]["file_path"], source)

    def test_hw_runtime_failure_falls_back_to_sw(self):
        """-encoders にHWが載っていても実行時に失敗する環境ではSWへ降格して撮り直す。"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            source = self._make_source(tmp)
            output_dir = str(tmp / "step08")
            step08_composition._videotoolbox_available = True

            calls = []

            def hw_fails_sw_succeeds(cmd, capture_output=True, text=True):
                calls.append(list(cmd))
                if "h264_videotoolbox" in cmd:
                    return mock.Mock(returncode=1, stdout="", stderr="no hw access")
                Path(cmd[-1]).write_bytes(b"sw mp4")
                return mock.Mock(returncode=0, stdout="", stderr="")

            cuts = make_cuts(source, [(0, 1000), (2000, 3000)])
            with mock.patch.object(step08_composition.subprocess, "run", side_effect=hw_fails_sw_succeeds):
                step08_composition._extract_segments(cuts, source, output_dir, 0)

            # HW失敗は1回だけ(以降のカットは最初からSW)、全カットがSWで抽出される
            hw_calls = [c for c in calls if "h264_videotoolbox" in c]
            self.assertEqual(len(hw_calls), 1)
            self.assertFalse(step08_composition._videotoolbox_available, "プロセス内でSWへ降格")
            for cut in cuts:
                self.assertTrue(os.path.exists(cut["video"]["file_path"]))

    def test_hash_stability_and_sensitivity(self):
        """同入力=同ハッシュ。境界・mtime・rotation・エンコーダ変更でハッシュが変わる。"""
        base = ("/v/source.mp4", 1234567890, 1000, 0, 3000, 0, "libx264_crf16_fast")
        h = step08_composition._segment_cache_hash(*base)
        self.assertEqual(h, step08_composition._segment_cache_hash(*base), "安定性")
        self.assertRegex(h, r"^[0-9a-f]{16}$")

        variants = [
            ("/v/other.mp4", 1234567890, 1000, 0, 3000, 0, "libx264_crf16_fast"),
            ("/v/source.mp4", 9999999999, 1000, 0, 3000, 0, "libx264_crf16_fast"),
            ("/v/source.mp4", 1234567890, 2000, 0, 3000, 0, "libx264_crf16_fast"),
            ("/v/source.mp4", 1234567890, 1000, 100, 3000, 0, "libx264_crf16_fast"),
            ("/v/source.mp4", 1234567890, 1000, 0, 3500, 0, "libx264_crf16_fast"),
            ("/v/source.mp4", 1234567890, 1000, 0, 3000, 90, "libx264_crf16_fast"),
            ("/v/source.mp4", 1234567890, 1000, 0, 3000, 0, "h264_videotoolbox_q65"),
        ]
        for variant in variants:
            self.assertNotEqual(h, step08_composition._segment_cache_hash(*variant), str(variant))


class VideoToolboxDetectionTests(unittest.TestCase):
    def setUp(self):
        self._saved_vt = step08_composition._videotoolbox_available
        step08_composition._videotoolbox_available = None

    def tearDown(self):
        step08_composition._videotoolbox_available = self._saved_vt

    def test_fallback_to_libx264_when_unavailable(self):
        """h264_videotoolbox が無い環境では従来の libx264 CRF16 に落ちる。"""
        fake = mock.Mock(returncode=0, stdout="V..... libx264 H.264", stderr="")
        with mock.patch.object(step08_composition.subprocess, "run", return_value=fake) as run_mock:
            args, desc = step08_composition._segment_encode_settings()
            # 判定はプロセス内1回キャッシュ: 2回目の呼び出しで ffmpeg -encoders を叩かない
            step08_composition._segment_encode_settings()
        self.assertEqual(run_mock.call_count, 1)
        self.assertIn("libx264", args)
        self.assertEqual(desc, "libx264_crf16_fast")

    def test_videotoolbox_selected_when_available(self):
        """h264_videotoolbox がある環境ではHWエンコード引数になる。"""
        fake = mock.Mock(returncode=0, stdout="V....D h264_videotoolbox VideoToolbox", stderr="")
        with mock.patch.object(step08_composition.subprocess, "run", return_value=fake):
            args, desc = step08_composition._segment_encode_settings()
        self.assertIn("h264_videotoolbox", args)
        self.assertIn("-allow_sw", args)
        self.assertEqual(desc, "h264_videotoolbox_q65")


if __name__ == "__main__":
    unittest.main()
