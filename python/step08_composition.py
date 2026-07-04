"""Step 8: Composition - テロップ生成 + composition.json構築 + セグメント分割。

Usage:
    python step08_composition.py \
        --proposal ../runs/{run}/step07_cut_proposal/cut_proposal.json \
        --stt ../runs/{run}/step02_stt/stt_result.json \
        --video /path/to/video.mp4 \
        --output ../runs/{run}/step08_composition \
        --project ../templates/vertical.yaml
"""

import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from shared.telop_builder import build_telop_pages, build_voice_data
from shared.ffmpeg_tools import get_video_metadata
from shared.project_config import load_project_config
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "tools"))


def run_step(
    proposal_path: str,
    stt_result_path: str,
    video_path: str,
    output_dir: str,
    config: dict = None,
    project_path: str = None,
    review_path: str = None,
) -> dict:
    """テロップ生成 + composition.json 構築 + セグメント分割。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"[Step 8] Composition")

    # プロジェクト設定読み込み
    project_cfg = load_project_config(project_path)
    if project_path:
        print(f"  project: {project_path}")
        proj_name = project_cfg.get("project", {}).get("name", "")
        if proj_name:
            print(f"  project name: {proj_name}")

    proposal = _load_json(proposal_path)
    stt_result = _load_json(stt_result_path)

    keep_segments = proposal.get("keep_segments", [])
    words = stt_result.get("words", [])

    # review.json の corrections をマージ (Step 6 の誤字脱字修正)
    if review_path and os.path.exists(review_path):
        review_data = _load_json(review_path)
        review_corrections = review_data.get("corrections", {})
        if review_corrections:
            existing_corrections = project_cfg.get("text_rules", {}).get("corrections", {})
            existing_corrections.update(review_corrections)
            project_cfg.setdefault("text_rules", {})["corrections"] = existing_corrections
            print(f"  review corrections merged: {len(review_corrections)} entries")

    # 設定の優先順位: CLI config > project.yaml > デフォルト
    cfg = config or {}
    telop_cfg = project_cfg.get("telop", {})
    render_cfg = project_cfg.get("render", {})
    text_rules = project_cfg.get("text_rules", {})

    max_chars_per_line = cfg.get("telop_max_chars_per_line", telop_cfg.get("max_chars_per_line", 12))
    max_lines_per_page = cfg.get("telop_max_lines_per_page", telop_cfg.get("max_lines_per_page", 1))
    fps = cfg.get("fps", render_cfg.get("fps", 30))
    framing = cfg.get("framing", render_cfg.get("framing", {"scale": 1.0, "offset_y": 0}))
    telop_y = cfg.get("telop_y", telop_cfg.get("y_position", 0.5))
    animation_in = cfg.get("animation_in", telop_cfg.get("animation_in", "none"))
    animation_out = cfg.get("animation_out", telop_cfg.get("animation_out", "none"))

    # 動画メタデータ取得 (rotation含む)
    metadata = get_video_metadata(video_path)
    video_info = metadata.get("video", {})
    display_w = video_info.get("width", 1920)
    display_h = video_info.get("height", 1080)
    rotation = video_info.get("rotation", 0)

    # 縦横判定 → 未指定時は orientation テンプレートから設定を補完
    is_landscape = display_w > display_h
    orientation = "horizontal" if is_landscape else "vertical"

    print(f"  source: {display_w}x{display_h} (rotation={rotation}, {orientation})")
    print(f"  telop_y: {telop_y}, animation: {animation_in}/{animation_out}")
    if text_rules.get("enumeration_style", "as_is") != "as_is":
        print(f"  text_rules: enumeration={text_rules['enumeration_style']}")
    if text_rules.get("corrections"):
        print(f"  text_rules: {len(text_rules['corrections'])} corrections")

    # DP ペナルティ (project.yaml の dp セクション or orientation デフォルト)
    dp_cfg = project_cfg.get("dp", {})
    telop_font_size = telop_cfg.get("font_size", 52 if not is_landscape else 44)

    # テロップ生成
    telop_pages_by_cut = {}
    cuts = []
    timeline_offset_ms = 0

    for i, seg in enumerate(keep_segments):
        cut_id = f"cut_{i + 1:03d}"
        duration_ms = seg["end_ms"] - seg["start_ms"]

        # テロップページ生成 (BudouX + 句読点除去 + text_rules正規化 + DP設定)
        pages = build_telop_pages(
            transcript=seg.get("text", ""),
            cut_id=cut_id,
            max_chars_per_line=max_chars_per_line,
            max_lines_per_page=max_lines_per_page,
            text_rules=text_rules if text_rules else None,
            dp_overrides=dp_cfg if dp_cfg else None,
        )
        telop_pages_by_cut[cut_id] = pages

        # タイムライン上のカット情報
        cut_data = {
            "cut_id": cut_id,
            "type": _determine_cut_type(i, len(keep_segments)),
            "video": {
                "file_path": os.path.abspath(video_path),
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
            },
            "timeline": {
                "start_ms": timeline_offset_ms,
                "end_ms": timeline_offset_ms + duration_ms,
            },
            "telop": {
                "pages": pages,
            },
            "layout": "talk",
            "scene_id": seg.get("scene_id"),
        }
        cuts.append(cut_data)
        timeline_offset_ms += duration_ms

    # voice_data 構築 (word timing は秒単位)
    voice_data = build_voice_data(
        keep_segments,
        words,
        telop_pages_by_cut,
        timing_rules=project_cfg.get("timing", {}),
    )

    # セグメント分割 (レンダリング高速化)
    _extract_segments(cuts, video_path, output_dir, rotation)

    # composition 構築
    composition = {
        "timeline": {
            "version": "1.0.0",
            "total_duration_ms": timeline_offset_ms,
            "video_fit": render_cfg.get("video_fit", "cover"),
            "fps": fps,
            "framing": framing,
            "telop_y": telop_y,
            "telop_font_size": telop_font_size,
            "animation_in": animation_in,
            "animation_out": animation_out,
            "cuts": cuts,
        },
        "voice_data": voice_data,
        "meta": {
            "source_video": os.path.abspath(video_path),
            "original_duration_ms": proposal.get("stats", {}).get("original_duration_ms", 0),
            "edited_duration_ms": timeline_offset_ms,
            "reduction_ratio": proposal.get("stats", {}).get("reduction_ratio", 0),
            "total_cuts": len(cuts),
            "display_width": display_w,
            "display_height": display_h,
            "orientation": orientation,
            "rotation": rotation,
            "project": project_cfg.get("project", {}),
        },
    }

    # telop.txt 抽出時点で利用可能な @style 一覧を出せるように、初期プリセットを同梱する。
    try:
        from _telop_presets import embed_presets_into_composition

        embed_presets_into_composition(composition)
    except Exception as e:
        print(f"  (telop preset embed skipped: {e})")

    print(f"  cuts: {len(cuts)}")
    print(f"  total duration: {timeline_offset_ms}ms ({timeline_offset_ms / 1000:.1f}s)")
    print(f"  output: {display_w}x{display_h}")

    output_path = os.path.join(output_dir, "composition.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(composition, f, ensure_ascii=False, indent=2)

    print(f"[Step 8] Done: {output_path}")
    return composition


def _extract_segments(cuts: list, source_video: str, output_dir: str, rotation: int):
    """カットごとのビデオセグメントをFFmpegで抽出。

    259MBの元動画に毎フレームseekするのがレンダリングの最大ボトルネック。
    カットごとに小さなMP4に分割して、seekコストを劇的に削減する。
    CRF 16 (visually lossless) で再エンコードし、フレーム精度の高いカットを実現。
    rotation はFFmpegのデフォルト自動回転に任せる（メタデータも自動除去される）。
    """
    segments_dir = os.path.join(output_dir, "segments")
    os.makedirs(segments_dir, exist_ok=True)

    print(f"  Extracting video segments...")
    t0 = time.time()

    for cut in cuts:
        video = cut["video"]
        start_s = video["start_ms"] / 1000
        end_s = video["end_ms"] / 1000
        duration_s = end_s - start_s

        segment_path = os.path.join(segments_dir, f"{cut['cut_id']}.mp4")

        cmd = [
            "ffmpeg", "-y",
            "-ss", str(start_s),
            "-i", video["file_path"],
            "-t", str(duration_s),
            "-c:v", "libx264",
            "-crf", "16",
            "-preset", "fast",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
        ]

        cmd.append(segment_path)

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"    WARNING: Failed to extract {cut['cut_id']}: {result.stderr[-200:]}")
            continue

        seg_size = os.path.getsize(segment_path) / 1024 / 1024
        print(f"    {cut['cut_id']}: {duration_s:.1f}s -> {seg_size:.1f}MB")

        # composition の video を更新: セグメントを参照、startFrom=0
        video["file_path"] = os.path.abspath(segment_path)
        video["start_ms"] = 0
        video["end_ms"] = int(duration_s * 1000)

    elapsed = time.time() - t0
    print(f"  Segments extracted in {elapsed:.1f}s")


def _determine_cut_type(index: int, total: int) -> str:
    """カットタイプを判定。"""
    if index == 0:
        return "hook"
    if index == total - 1:
        return "cta"
    return "body"


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description="Step 8: Composition")
    parser.add_argument("--proposal", required=True, help="Cut proposal JSON path")
    parser.add_argument("--stt", required=True, help="STT result JSON path")
    parser.add_argument("--video", required=True, help="Source video path")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--project", default=None, help="Project config YAML/JSON path")
    parser.add_argument("--review", default=None, help="Review JSON path (Step 6 output)")
    args = parser.parse_args()

    run_step(
        args.proposal,
        args.stt,
        args.video,
        args.output,
        project_path=args.project,
        review_path=args.review,
    )


if __name__ == "__main__":
    main()
