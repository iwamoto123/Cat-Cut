"""composition.json からテロップ本文だけを抽出して telop.txt に書き出す。

使い方:
    .venv/bin/python python/tools/extract_telop.py runs/<run_name>

出力:
    runs/<run_name>/telop.txt

フォーマット:
    # cut_001_p00 [00:00.00-00:02.15] @style=default
    はい
    今日のテーマです

    # cut_002_p00 [00:02.16-00:06.34] @style=highlight
    急遽お願いしました

@style=<preset名> はオプション。未指定なら default を使う。
利用可能な preset 名は templates/telop_presets.yaml を参照。
"""
import argparse
import json
import sys
from pathlib import Path


def fmt_time(ms: int) -> str:
    s = ms / 1000
    m = int(s // 60)
    rem = s - m * 60
    return f"{m:02d}:{rem:05.2f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--composition", default=None, help="composition.json のパス (省略時は run_dir/step08_composition/composition.json)")
    parser.add_argument("--output", default=None, help="出力先 (省略時は run_dir/telop.txt)")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    comp_path = Path(args.composition) if args.composition else run_dir / "step08_composition" / "composition.json"
    out_path = Path(args.output) if args.output else run_dir / "telop.txt"

    if not comp_path.exists():
        sys.exit(f"composition.json not found: {comp_path}")

    data = json.load(open(comp_path))
    cuts = data["timeline"]["cuts"]

    # preset 一覧をヘッダにメタコメントとして添える
    presets = data.get("timeline", {}).get("telop_styles", {})
    preset_names = list(presets.keys())

    lines = []
    lines.append("# Cat-Cut テロップ確認ファイル")
    lines.append("# この欄で、書き出し前のテロップ本文を確認・修正できます。")
    lines.append("#")
    lines.append("# やること:")
    lines.append("# 1. 動画に表示したい文章だけを直してください。")
    lines.append("# 2. 改行したい位置で行を分けてください。1行が画面上のテロップ1行になります。")
    lines.append("# 3. ページを分けたい場合は空行を入れてください。空行の次が次のテロップページです。")
    lines.append("# 4. 強調したいページは、ページID行の末尾に @style=highlight のように付けます。")
    lines.append("# 5. 編集後は画面の「テロップを確定」を押すと、プレビューと書き出しに反映されます。")
    lines.append("#")
    lines.append("# 変更しないもの:")
    lines.append("# - '# cut_XXX_pYY [時間]' で始まる行はページIDです。基本的に変更しないでください。")
    lines.append("# - source は元データの場所です。表示テロップには出ません。")
    lines.append("#")
    lines.append(f"# source: {comp_path}")
    lines.append(f"# 手動で反映する場合: .venv/bin/python python/tools/apply_telop.py {run_dir}")
    if preset_names:
        descs = [
            f"#     {name}: {p.get('description','(no description)')}"
            for name, p in presets.items()
        ]
        lines.append("#")
        lines.append("# 使えるスタイル名:")
        lines.extend(descs)
    lines.append("")

    # voice_data.cuts[].telops[].style と紐付ける (cut_id, telop_index) → style
    voice_cuts = {vc["id"]: vc for vc in data.get("voice_data", {}).get("cuts", [])}
    default_style = data.get("timeline", {}).get("default_telop_style", "default")

    for cut in cuts:
        timeline = cut["timeline"]
        cut_start = timeline["start_ms"]
        cut_end = timeline["end_ms"]
        pages = cut["telop"]["pages"]
        if not pages:
            continue
        vc = voice_cuts.get(cut["cut_id"])
        vtelops = vc.get("telops", []) if vc else []

        n = len(pages)
        dur = cut_end - cut_start

        def telop_range(i: int) -> tuple[int, int]:
            if i >= len(vtelops):
                return cut_start + dur * i // n, cut_start + dur * (i + 1) // n
            telop = vtelops[i]
            if isinstance(telop.get("start"), (int, float)) and isinstance(telop.get("end"), (int, float)):
                p_start = cut_start + int(float(telop["start"]) * 1000)
                p_end = cut_start + int(float(telop["end"]) * 1000)
                return p_start, max(p_start + 100, p_end)
            words = vc.get("voice", {}).get("words", []) if vc else []
            indices = telop.get("word_indices", [])
            if indices and words:
                first_idx = min(indices)
                last_idx = max(indices)
                next_indices = vtelops[i + 1].get("word_indices", []) if i + 1 < len(vtelops) else []
                next_idx = min(next_indices) if next_indices else None
                first = words[first_idx] if first_idx < len(words) else {}
                last = words[last_idx] if last_idx < len(words) else {}
                next_word = words[next_idx] if next_idx is not None and next_idx < len(words) else None
                p_start = cut_start + int(float(first.get("start", 0)) * 1000)
                p_end = cut_start + int(float((next_word or last).get("start" if next_word else "end", 0)) * 1000)
                return p_start, max(p_start + 100, p_end)
            return cut_start + dur * i // n, cut_start + dur * (i + 1) // n

        for i, page in enumerate(pages):
            p_start, p_end = telop_range(i)
            style = default_style
            if i < len(vtelops):
                style = vtelops[i].get("style") or default_style
            style_marker = f" @style={style}" if style != default_style else ""
            lines.append(f"# {page['id']} [{fmt_time(p_start)}-{fmt_time(p_end)}]{style_marker}")
            for ln in page["lines"]:
                lines.append(ln)
            lines.append("")  # ページ区切り

    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out_path}")
    print(f"  cuts: {len(cuts)}")
    print(f"  pages: {sum(len(c['telop']['pages']) for c in cuts)}")


if __name__ == "__main__":
    main()
