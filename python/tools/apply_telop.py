"""telop.txt の編集内容を composition.json に反映する。

使い方:
    .venv/bin/python python/tools/apply_telop.py runs/<run_name>

動作:
    1. runs/<run_name>/telop.txt を読み、ページIDごとにlinesを抽出
    2. runs/<run_name>/step08_composition/composition.json を更新 (主ファイル)
    3. remotion/public/composition.json があれば同期 (file_path は維持)
"""
import argparse
import json
import re
import sys
from pathlib import Path

# 同階層の _telop_presets を import 可能にする
sys.path.insert(0, str(Path(__file__).resolve().parent))

PAGE_HEADER_RE = re.compile(r"^#\s*(cut_\d+_p\d+)\b")
TIME_RANGE_RE = re.compile(r"\[(\d+):(\d{2})\.(\d{2})-(\d+):(\d{2})\.(\d{2})\]")
STYLE_DIRECTIVE_RE = re.compile(r"@style=([\w\-]+)")
PUNCT_TO_REMOVE_RE = re.compile(r"[。、！？!?,.]")


def load_style_plan(run_dir: Path) -> dict | None:
    """UIで作成した実行単位のテロップスタイル計画を読み込む。"""
    plan_path = run_dir / "telop_style_plan.json"
    if not plan_path.exists():
        return None
    with open(plan_path, encoding="utf-8") as f:
        plan = json.load(f)
    if not isinstance(plan.get("styles"), dict):
        return None
    return plan


def apply_style_plan(composition: dict, plan: dict | None) -> bool:
    """style plan があれば composition.timeline に反映する。"""
    if not plan:
        return False
    composition.setdefault("timeline", {})
    composition["timeline"]["telop_styles"] = plan["styles"]
    composition["timeline"]["default_telop_style"] = plan.get("default_style", "default")
    composition["timeline"]["telop_style_plan"] = {
        "version": plan.get("version", "1.0.0"),
        "source": plan.get("source", "telop_style_plan.json"),
        "updated_at": plan.get("updated_at"),
    }
    return True


def _time_to_ms(minutes: str, seconds: str, centiseconds: str) -> int:
    return (int(minutes) * 60 + int(seconds)) * 1000 + int(centiseconds) * 10


def parse_header_timing(line: str) -> dict[str, int] | None:
    match = TIME_RANGE_RE.search(line)
    if not match:
        return None
    start_ms = _time_to_ms(match.group(1), match.group(2), match.group(3))
    end_ms = _time_to_ms(match.group(4), match.group(5), match.group(6))
    if end_ms <= start_ms:
        return None
    return {"start_ms": start_ms, "end_ms": end_ms}


def parse_telop(text: str) -> tuple[dict[str, list[str]], dict[str, str], dict[str, dict[str, int]]]:
    """telop.txt を解析し、(page_id -> lines, page_id -> style名, page_id -> time range) を返す。"""
    pages: dict[str, list[str]] = {}
    styles: dict[str, str] = {}
    timings: dict[str, dict[str, int]] = {}
    current_id: str | None = None
    current_lines: list[str] = []

    def flush():
        nonlocal current_id, current_lines
        if current_id is not None:
            while current_lines and current_lines[-1] == "":
                current_lines.pop()
            pages[current_id] = list(current_lines)
        current_id = None
        current_lines = []

    for raw in text.splitlines():
        line = raw.rstrip("\r")
        m = PAGE_HEADER_RE.match(line.strip())
        if m:
            flush()
            current_id = m.group(1)
            current_lines = []
            sm = STYLE_DIRECTIVE_RE.search(line)
            if sm:
                styles[current_id] = sm.group(1)
            timing = parse_header_timing(line)
            if timing:
                timings[current_id] = timing
            continue
        if line.startswith("#"):
            if current_id is None:
                continue
            continue
        if current_id is None:
            continue
        current_lines.append(line)
    flush()
    return pages, styles, timings


def remove_punctuation(text: str) -> str:
    return PUNCT_TO_REMOVE_RE.sub("", text).strip()


def remap_telops_to_words(
    pages: list[dict],
    voice_words: list[dict],
    original_telops: list[dict],
    cut_start_ms: int = 0,
) -> list[dict]:
    """編集後のページ本文を voice.words に再マッピングする。

    ページ結合や行移動後も、Remotion 側の表示開始/終了が本文に追従するようにする。
    完全一致できないページは、同じ位置の既存 word_indices をフォールバックとして使う。
    """
    if not pages:
        return []

    has_explicit_timing = any("start_ms" in page and "end_ms" in page for page in pages)
    if not voice_words and not has_explicit_timing:
        return []

    full_text_raw = "".join(str(w.get("text", "")) for w in voice_words)
    full_text_clean = remove_punctuation(full_text_raw)

    char_to_word_idx: dict[int, int] = {}
    raw_pos = 0
    for wi, word in enumerate(voice_words):
        for _ in str(word.get("text", "")):
            char_to_word_idx[raw_pos] = wi
            raw_pos += 1

    clean_to_raw: dict[int, int] = {}
    clean_pos = 0
    for pos, ch in enumerate(full_text_raw):
        if not PUNCT_TO_REMOVE_RE.match(ch):
            clean_to_raw[clean_pos] = pos
            clean_pos += 1

    telops = []
    original_by_id = {t.get("id"): t for t in original_telops if isinstance(t, dict)}
    page_clean_offset = 0
    for page_idx, page in enumerate(pages):
        lines = [str(line) for line in page.get("lines", [])]
        page_text = "".join(lines)
        page_len = len(page_text)
        match_pos = full_text_clean.find(page_text, page_clean_offset) if page_text else -1
        exact_match = match_pos != -1
        if match_pos == -1:
            match_pos = page_clean_offset

        word_indices = set()
        for ci in range(match_pos, min(match_pos + page_len, len(full_text_clean))):
            raw = clean_to_raw.get(ci)
            if raw is not None and raw in char_to_word_idx:
                word_indices.add(char_to_word_idx[raw])

        fallback_telop = original_telops[page_idx] if page_idx < len(original_telops) else {}
        fallback_indices = fallback_telop.get("word_indices", [])
        sorted_indices = sorted(word_indices) if word_indices else list(fallback_indices)

        segments = []
        line_clean_offset = match_pos
        for line_text in lines:
            line_len = len(line_text)
            line_word_indices = set()
            for ci in range(line_clean_offset, min(line_clean_offset + line_len, len(full_text_clean))):
                raw = clean_to_raw.get(ci)
                if raw is not None and raw in char_to_word_idx:
                    line_word_indices.add(char_to_word_idx[raw])
            segments.append({
                "text": line_text,
                "word_indices": sorted(line_word_indices) if line_word_indices else list(sorted_indices),
            })
            line_clean_offset += line_len

        next_telop = {
            "id": page.get("id"),
            "text": page_text,
            "word_indices": sorted_indices,
            "segments": segments,
        }
        if "start_ms" in page and "end_ms" in page:
            start_ms = max(0, int(page["start_ms"]) - int(cut_start_ms))
            end_ms = max(start_ms + 100, int(page["end_ms"]) - int(cut_start_ms))
            next_telop["start"] = start_ms / 1000
            next_telop["end"] = end_ms / 1000
        if page.get("style"):
            next_telop["style"] = page["style"]
        # フェーズT2: directedモードのtelopが持つ部分強調(highlight_words)を、
        # telop.txt往復(remap)で落とさない。同一page_idの既存telopから引き継ぎ、
        # 編集後の本文に実在する語だけを残す。
        source_telop = original_by_id.get(page.get("id")) or fallback_telop
        original_highlights = source_telop.get("highlight_words") if isinstance(source_telop, dict) else None
        if isinstance(original_highlights, list):
            kept_highlights = [
                str(word) for word in original_highlights
                if str(word) and str(word) in page_text
            ]
            if kept_highlights:
                next_telop["highlight_words"] = kept_highlights
        # フェーズW31: 演出メタデータ(type/アニメ/SFX/話者/上書きフラグ)をremapで
        # 落とさない。従来はここで毎回剥がれており、type別アニメ・SFX・W31の
        # アニメローテーションがレンダリングに一切反映されていなかった
        # (Remotionのテロップ描画は voice_data.cuts.telops を読む)。
        # sfx は「キーあり+null=明示的に鳴らさない」の意味を持つためキー存在で判定する
        if isinstance(source_telop, dict):
            for key in (
                "type", "animation_in", "animation_out", "sfx", "speaker",
                "style_overridden", "animation_overridden",
                "video_effect", "video_effect_overridden",
            ):
                if key in source_telop and key not in next_telop:
                    next_telop[key] = source_telop[key]
        telops.append(next_telop)

        if exact_match:
            page_clean_offset = match_pos + page_len
        else:
            page_clean_offset = min(match_pos + page_len, len(full_text_clean))

    return telops


def apply_to_composition(
    comp: dict,
    page_map: dict[str, list[str]],
    style_map: dict[str, str] | None = None,
    timing_map: dict[str, dict[str, int]] | None = None,
) -> tuple[int, int, int, int]:
    """telop.txt にあるページIDで composition の timeline.cuts.telop.pages と voice_data.cuts.telops を同時更新。
    telop.txt から削除されたページIDは両方から削除する。
    style_map (page_id -> preset 名) があれば voice_data 側 telops の style に反映する。

    Returns: (updated_lines, untouched, removed, style_applied)
    """
    if style_map is None:
        style_map = {}
    if timing_map is None:
        timing_map = {}
    updated = 0
    untouched = 0
    removed = 0
    style_applied = 0

    page_items_by_cut: dict[str, list[tuple[str, list[str]]]] = {}
    for pid, lines in page_map.items():
        cut_id = pid.rsplit("_p", 1)[0]
        page_items_by_cut.setdefault(cut_id, []).append((pid, lines))

    # timeline.cuts 側を更新。telop.txt のページIDをSOTにして、追加・削除も反映する。
    for cut in comp["timeline"]["cuts"]:
        cut_id = cut["cut_id"]
        desired_pages = page_items_by_cut.get(cut_id, [])
        existing_pages = {page["id"]: page for page in cut.get("telop", {}).get("pages", [])}
        old_ids = set(existing_pages.keys())
        new_ids = {pid for pid, _lines in desired_pages}
        new_pages = []
        for pid, new_lines in desired_pages:
            page = dict(existing_pages.get(pid, {"id": pid, "lines": []}))
            if new_lines != page.get("lines", []):
                updated += 1
            else:
                untouched += 1
            page["id"] = pid
            page["lines"] = new_lines
            if pid in style_map:
                page["style"] = style_map[pid]
            else:
                page.pop("style", None)
            if pid in timing_map:
                page["start_ms"] = timing_map[pid]["start_ms"]
                page["end_ms"] = timing_map[pid]["end_ms"]
            else:
                page.pop("start_ms", None)
                page.pop("end_ms", None)
            new_pages.append(page)
        removed += len(old_ids - new_ids)
        cut.setdefault("telop", {})["pages"] = new_pages

    # voice_data.cuts.telops も同期 (Telop コンポーネントが描画に使う実体)
    if "voice_data" in comp and "cuts" in comp["voice_data"]:
        for vcut in comp["voice_data"]["cuts"]:
            cut_id = vcut.get("id")
            tl_cut = next((c for c in comp["timeline"]["cuts"] if c["cut_id"] == cut_id), None)
            if not tl_cut:
                continue
            pages = tl_cut["telop"]["pages"]
            for page in pages:
                page_id = page["id"]
                if page_id in style_map:
                    page["style"] = style_map[page_id]
                    style_applied += 1
                else:
                    page.pop("style", None)
            cut_start_ms = int(tl_cut.get("timeline", {}).get("start_ms", 0))
            vcut["telops"] = remap_telops_to_words(
                pages,
                vcut.get("voice", {}).get("words", []),
                vcut.get("telops", []),
                cut_start_ms,
            )

    return updated, untouched, removed, style_applied


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", help="runs/<run_name> へのパス")
    parser.add_argument("--telop", default=None, help="telop.txt のパス")
    parser.add_argument("--composition", default=None, help="composition.json のパス")
    parser.add_argument("--public", default=None, help="remotion/public/composition.json のパス (自動検出)")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    telop_path = Path(args.telop) if args.telop else run_dir / "telop.txt"
    comp_path = Path(args.composition) if args.composition else run_dir / "step08_composition" / "composition.json"

    if not telop_path.exists():
        sys.exit(f"telop.txt not found: {telop_path}")
    if not comp_path.exists():
        sys.exit(f"composition.json not found: {comp_path}")

    page_map, style_map, timing_map = parse_telop(telop_path.read_text(encoding="utf-8"))
    print(f"telop.txt: {len(page_map)} pages parsed, {len(style_map)} pages with @style")

    # 主ファイルを更新
    comp = json.load(open(comp_path))
    style_plan = load_style_plan(run_dir)
    # UIで作成した実行単位の style plan があれば最優先。なければ最新 yaml を埋め込む。
    if apply_style_plan(comp, style_plan):
        print(f"loaded telop style plan: {run_dir / 'telop_style_plan.json'}")
    else:
        try:
            from _telop_presets import embed_presets_into_composition
            embed_presets_into_composition(comp)
        except Exception as e:
            print(f"  (preset embed skipped: {e})")
    updated, untouched, removed, style_applied = apply_to_composition(comp, page_map, style_map, timing_map)
    json.dump(comp, open(comp_path, "w"), ensure_ascii=False)
    print(f"updated {comp_path}: {updated} changed, {untouched} unchanged, {removed} removed, {style_applied} styles applied")

    # public ファイルを同期 (file_path は public 側のものを維持)
    public_path: Path
    if args.public:
        public_path = Path(args.public)
    else:
        # Cat-Cut/remotion/public/composition-v2.json を探す (Studio 用)
        app_root = comp_path.parents[3]  # runs/<run>/step08_composition/composition.json -> Cat-Cut/
        public_path = app_root / "remotion" / "public" / "composition-v2.json"

    if public_path.exists():
        pdata = json.load(open(public_path))
        if not apply_style_plan(pdata, style_plan):
            try:
                from _telop_presets import embed_presets_into_composition
                embed_presets_into_composition(pdata)
            except Exception:
                pass
        pup, _, prem, _ = apply_to_composition(pdata, page_map, style_map, timing_map)
        # font_size など他フィールドも主ファイルから同期
        pdata["timeline"]["telop_font_size"] = comp["timeline"].get("telop_font_size", pdata["timeline"].get("telop_font_size"))
        pdata["timeline"]["telop_y"] = comp["timeline"].get("telop_y", pdata["timeline"].get("telop_y"))
        json.dump(pdata, open(public_path, "w"), ensure_ascii=False)
        print(f"synced {public_path}: {pup} changed, {prem} removed")
    else:
        print(f"(public composition not found: {public_path}, skip)")


if __name__ == "__main__":
    main()
