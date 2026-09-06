#!/usr/bin/env python3
"""Headless Cat-Cut pipeline for video-podcast SaaS batch jobs.

Mirrors the Electron app's automated steps without UI. Use Cat-Cut desktop for
human telop review after `--stop-at review`.

Usage:
    .venv/bin/python python/run_headless_pipeline.py --video /path/to/input.mp4
    .venv/bin/python python/run_headless_pipeline.py --video input.mp4 --auto-export
    .venv/bin/python python/run_headless_pipeline.py --run-dir runs/20260702_demo --resume --auto-export
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / "bin" / "python"
sys.path.insert(0, str(ROOT / "python"))
from shared.app_paths import default_correction_history_path, default_user_dictionary_path
from shared.project_config import load_project_config


def repo_path(*parts: str) -> Path:
    return ROOT.joinpath(*parts)


def run_cmd(args: list[str], *, cwd: Path | None = None, env: dict | None = None) -> None:
    if args[0] in {"npm"}:
        command = args
    else:
        command = [str(PYTHON), *args]
    print(f"\n>>> {' '.join(command)}")
    subprocess.run(command, cwd=cwd or ROOT, env=env, check=True)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def create_run_name(video_path: Path) -> str:
    stem = video_path.stem[:40].replace(" ", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{timestamp}_{stem}"


def ensure_placeholder_steps(run_dir: Path) -> None:
    write_json(run_dir / "step05_retake_detect" / "retakes.json", {"retakes": []})
    write_json(run_dir / "step06_scene_structure" / "scenes.json", {"scenes": []})
    write_json(
        run_dir / "step06_review" / "review.json",
        {"corrections": {}, "quality_notes": ["headless pipeline"]},
    )


def default_font_directives() -> str:
    template = repo_path("templates", "font_directives_template.md")
    if template.exists():
        return template.read_text(encoding="utf-8")
    return "# フォント指示\n\n- 通常: 読みやすいゴシック\n- 強調: 目立つ色\n"


def run_pipeline(
    *,
    video_path: Path,
    run_dir: Path,
    stt_provider: str,
    whisper_model: str,
    stop_at: str,
    auto_export: bool,
    title: str,
    customer_id: str,
) -> Path:
    if not PYTHON.exists():
        raise FileNotFoundError(f"Python venv not found: {PYTHON}")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    rel_run = run_dir.relative_to(ROOT)

    run_cmd(
        [
            "python/step01_preprocess.py",
            "--video",
            str(video_path.resolve()),
            "--output",
            str(rel_run / "step01_preprocess"),
        ],
        env=env,
    )

    preprocess = json.loads((run_dir / "step01_preprocess" / "preprocess.json").read_text(encoding="utf-8"))
    orientation = preprocess.get("orientation", "horizontal")
    project = repo_path("templates", f"{orientation}.yaml")

    stt_args = [
        "python/step02_stt.py",
        "--provider",
        stt_provider,
        "--language",
        "ja",
        "--audio",
        str(rel_run / "step01_preprocess" / "audio.wav"),
        "--output",
        str(rel_run / "step02_stt"),
    ]
    if stt_provider == "local-whisper":
        stt_args.extend(["--whisper-model", whisper_model])
    run_cmd(stt_args, env=env)

    run_cmd(
        [
            "python/step02b_transcript_correct.py",
            "--stt",
            str(rel_run / "step02_stt" / "stt_result.json"),
            "--dictionary",
            "templates/domain_dictionary.yaml",
            "--project",
            str(project.relative_to(ROOT)),
            "--user-dictionary",
            str(default_user_dictionary_path()),
            "--output",
            str(rel_run / "step02b_transcript_correct"),
        ],
        env=env,
    )

    corrected_stt = rel_run / "step02b_transcript_correct" / "stt_corrected.json"

    run_cmd(
        [
            "python/step03_vad.py",
            "--audio",
            str(rel_run / "step01_preprocess" / "audio.wav"),
            "--stt",
            str(corrected_stt),
            "--output",
            str(rel_run / "step03_vad"),
        ],
        env=env,
    )

    run_cmd(
        [
            "python/step04_filler_detect.py",
            "--stt",
            str(corrected_stt),
            "--vad",
            str(rel_run / "step03_vad" / "vad_result.json"),
            "--output",
            str(rel_run / "step04_filler_detect"),
        ],
        env=env,
    )

    ensure_placeholder_steps(run_dir)

    run_cmd(
        [
            "python/step07_cut_proposal.py",
            "--stt",
            str(corrected_stt),
            "--fillers",
            str(rel_run / "step04_filler_detect" / "fillers.json"),
            "--retakes",
            str(rel_run / "step05_retake_detect" / "retakes.json"),
            "--scenes",
            str(rel_run / "step06_scene_structure" / "scenes.json"),
            "--vad",
            str(rel_run / "step03_vad" / "vad_result.json"),
            "--audio",
            str(rel_run / "step01_preprocess" / "audio.wav"),
            "--project",
            str(project.relative_to(ROOT)),
            "--output",
            str(rel_run / "step07_cut_proposal"),
        ],
        env=env,
    )

    # フェーズT2: telop.mode が directed のときのみパス3(演出決定エンジン)を実行する。
    # step06c は run直下に telop_directives.json を書き、step08 がそれを読んで
    # directedテロップ+オーバーレイを生成する(既定 full では従来動作のまま)。
    # CATCUT_TELOP_MODE 環境変数で project.yaml の telop.mode を上書きできる
    # (共有テンプレートを書き換えずに directed を試すための開発用フック)
    telop_mode = os.environ.get("CATCUT_TELOP_MODE", "").strip() or str(
        load_project_config(str(project)).get("telop", {}).get("mode", "full")
    )
    directed_mode = telop_mode == "directed"
    if directed_mode:
        run_cmd(
            [
                "python/step06c_direction.py",
                str(rel_run),
                "--proposal",
                str(rel_run / "step07_cut_proposal" / "cut_proposal.json"),
                "--stt",
                str(corrected_stt),
                "--title",
                title,
                "--project",
                str(project.relative_to(ROOT)),
            ],
            env=env,
        )

    run_cmd(
        [
            "python/step08_composition.py",
            "--proposal",
            str(rel_run / "step07_cut_proposal" / "cut_proposal.json"),
            "--stt",
            str(corrected_stt),
            "--video",
            str(video_path.resolve()),
            "--output",
            str(rel_run / "step08_composition"),
            "--project",
            str(project.relative_to(ROOT)),
            "--review",
            str(rel_run / "step06_review" / "review.json"),
        ],
        env=env,
    )

    run_cmd(["python/tools/extract_telop.py", str(rel_run)], env=env)
    run_cmd(
        [
            "python/tools/review_telop.py",
            str(rel_run),
            "--dictionary",
            "templates/domain_dictionary.yaml",
        ],
        env=env,
    )
    # 改善8-A-5: LLM refine (Claude API)。ANTHROPIC_API_KEYが無ければ内部で
    # 自動スキップしてBudouXのみの出力を維持するため、常に呼んで問題ない。
    # フェーズT2: directedモードではスキップする(step06bのページ再分割はスロット単位の
    # 明示タイミング・スタイルを破壊するため。文言整形の責務はstep06cが担う)。
    if not directed_mode:
        run_cmd(
            [
                "python/step06b_ai_refine.py",
                str(rel_run),
                "--stt",
                str(corrected_stt),
                "--project",
                str(project.relative_to(ROOT)),
                "--output",
                str(rel_run / "step06b_ai_refine" / "refine.json"),
                # W14-2: ユーザーが過去に確定した修正例(誤→正)をプロンプトへ注入(無ければ従来動作)
                "--correction-history",
                str(default_correction_history_path()),
            ],
            env=env,
        )
    else:
        print("\n[headless] telop.mode=directed - skip step06b (refinement handled by step06c)")

    if stop_at == "review":
        print(f"\n[headless] Review ready: {run_dir}")
        print("Open Cat-Cut desktop, load this run, review telops, then export.")
        return run_dir

    font_directives_path = run_dir / "font_directives.md"
    if not font_directives_path.exists():
        font_directives_path.write_text(default_font_directives(), encoding="utf-8")

    run_cmd(
        ["python/tools/apply_font_directives.py", str(rel_run), "--apply-composition"],
        env=env,
    )
    run_cmd(["python/tools/apply_telop.py", str(rel_run)], env=env)

    if not auto_export:
        print(f"\n[headless] Composition ready (no render): {run_dir}")
        return run_dir

    output_path = run_dir / "output" / "final.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    display_w = preprocess.get("display_width", 1920)
    display_h = preprocess.get("display_height", 1080)

    render_cmd = [
        "npm",
        "run",
        "render:cli",
        "--",
        "--composition",
        str(Path("..") / rel_run / "step08_composition" / "composition.json"),
        "--output",
        str(output_path.resolve()),
        "--width",
        str(display_w),
        "--height",
        str(display_h),
        "--concurrency",
        "4",
    ]
    print(f"\n>>> {' '.join(render_cmd)}")
    subprocess.run(render_cmd, cwd=repo_path("remotion"), env=env, check=True)

    write_json(
        run_dir / "output" / "render_output.json",
        {"finalVideo": str(output_path.resolve()), "updated_at": datetime.now().isoformat()},
    )

    manifest_args = [
        "python/tools/build_delivery_manifest.py",
        str(rel_run),
        "--title",
        title or video_path.stem,
    ]
    if customer_id:
        manifest_args.extend(["--customer-id", customer_id])
    run_cmd(manifest_args, env=env)

    print(f"\n[headless] Done: {output_path}")
    return run_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Cat-Cut pipeline headlessly")
    parser.add_argument("--video", help="Input video path")
    parser.add_argument("--run-dir", help="Existing run directory under runs/")
    parser.add_argument("--resume", action="store_true", help="Reuse --run-dir instead of creating a new run")
    parser.add_argument("--stt-provider", choices=["elevenlabs", "local-whisper"], default="elevenlabs")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument(
        "--stop-at",
        choices=["review", "composition", "export"],
        default="review",
        help="review=stop before human review, composition=skip render, export=full auto",
    )
    parser.add_argument("--auto-export", action="store_true", help="Render MP4 and build delivery manifest")
    parser.add_argument("--title", default="", help="Episode title for delivery manifest")
    parser.add_argument("--customer-id", default="", help="Customer identifier for delivery manifest")
    args = parser.parse_args()

    if args.auto_export:
        stop_at = "export"
    elif args.stop_at == "export":
        stop_at = "export"
    else:
        stop_at = args.stop_at

    if args.run_dir:
        run_dir = repo_path(args.run_dir).resolve()
        if not run_dir.exists():
            raise FileNotFoundError(f"Run directory not found: {run_dir}")
        if not args.video:
            preprocess = json.loads((run_dir / "step01_preprocess" / "preprocess.json").read_text(encoding="utf-8"))
            video_path = Path(preprocess["source_video"])
        else:
            video_path = Path(args.video).resolve()
    else:
        if not args.video:
            parser.error("--video is required when --run-dir is not provided")
        video_path = Path(args.video).resolve()
        if not video_path.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")
        run_dir = repo_path("runs", create_run_name(video_path))
        run_dir.mkdir(parents=True, exist_ok=True)

    run_pipeline(
        video_path=video_path,
        run_dir=run_dir,
        stt_provider=args.stt_provider,
        whisper_model=args.whisper_model,
        stop_at=stop_at,
        auto_export=args.auto_export or stop_at == "export",
        title=args.title,
        customer_id=args.customer_id,
    )


if __name__ == "__main__":
    main()
