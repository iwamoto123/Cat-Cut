"""Natural-language font directives for Cat-Cut telops.

This tool converts a small Japanese natural-language instruction file into a
font plan and applies the selected font families to composition.json. It is
deterministic by design so the desktop app can use it without a paid API.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TEMPLATE = REPO_ROOT / "templates" / "font_directives_template.md"
DEFAULT_COMPOSITION = Path("step08_composition") / "composition.json"

FULL_WIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
KANJI_NUMBERS = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
}

PRESET_ORDER = ["default", "highlight", "calm", "warning", "question", "simple"]
PRESET_LABELS = {
    "default": "通常",
    "highlight": "強調",
    "calm": "落ち着き",
    "warning": "注意",
    "question": "質問",
    "simple": "補足",
}

PRESET_KEYWORDS = {
    "default": ("通常", "標準", "基本", "ベース", "メイン"),
    "highlight": ("強調", "重要", "結論", "数字", "目立", "派手"),
    "calm": ("落ち着", "穏やか", "淡い", "静か", "説明", "整理"),
    "warning": ("注意", "警告", "NG", "危険", "ミス", "否定"),
    "question": ("質問", "問い", "聞き手", "ホスト", "インタビュー"),
    "simple": ("補足", "シンプル", "小さめ", "引用", "地味"),
}

PROFILE_LABELS = {
    "readable_gothic": "読みやすい太ゴシック",
    "rounded_gothic": "丸みのあるゴシック",
    "pop_kawaii": "可愛いポップ体",
    "rock_pop": "勢いのあるポップ体",
    "handwritten": "手書き風",
    "strong_gothic": "強い角ゴシック",
    "mincho": "上品な明朝",
    "serious_mincho": "重厚な明朝",
    "impact": "インパクト系",
    "retro_dot": "ドット/ゲーム風",
    "english_bold": "英字見出し",
    "english_script": "英字手書き",
    "simple_gothic": "控えめなゴシック",
}

PROFILE_KEYWORDS = {
    "serious_mincho": ("重厚", "厳か", "硬派", "真面目", "シリアス", "和風", "高級"),
    "mincho": ("明朝", "上品", "知的", "落ち着", "高級", "しっとり"),
    "pop_kawaii": ("かわいい", "可愛い", "ポップ", "ぷっくり", "楽しい", "明るい", "やわらかい"),
    "rock_pop": ("ロック", "勢い", "元気", "弾け", "ノリ", "コミカル"),
    "handwritten": ("手書き", "手描き", "手がき", "ラフ", "親しみ", "ゆるい", "ゆるめ"),
    "impact": ("インパクト", "迫力", "強烈", "ドン", "バラエティ", "見出し"),
    "retro_dot": ("ドット", "ゲーム", "ピクセル", "レトロ", "デジタル"),
    "english_bold": ("英字", "英語", "アルファベット", "欧文", "縦長", "コンデンス", "condensed"),
    "english_script": ("筆記体", "筆記", "script", "cursive"),
    "rounded_gothic": ("丸", "丸ゴ", "丸ゴシック", "やさしい", "優しい", "柔らか"),
    "strong_gothic": ("角", "強い", "強め", "力強", "太", "インパクト", "迫力", "見出し", "目立"),
    "simple_gothic": ("細", "控えめ", "シンプル", "小さめ", "補足"),
    "readable_gothic": ("読みやす", "ゴシック", "通常", "標準", "基本"),
}

FONT_FAMILIES = {
    "readable_gothic": (
        '"Zen Kaku Gothic Antique", "Hiragino Sans", '
        '"Hiragino Kaku Gothic ProN", "Meiryo", sans-serif'
    ),
    "rounded_gothic": (
        '"Hiragino Maru Gothic ProN", "Zen Kaku Gothic Antique", '
        '"Hiragino Sans", "Meiryo", sans-serif'
    ),
    "strong_gothic": (
        '"Zen Kaku Gothic Antique", "Hiragino Kaku Gothic ProN", '
        '"Hiragino Sans", "Arial Black", "Meiryo", sans-serif'
    ),
    "mincho": (
        '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", '
        '"Noto Serif JP", serif'
    ),
    "simple_gothic": (
        '"Hiragino Sans", "Hiragino Kaku Gothic ProN", '
        '"Yu Gothic", "Meiryo", sans-serif'
    ),
}

DEFAULT_PROFILE_BY_PRESET = {
    "default": "readable_gothic",
    "highlight": "pop_kawaii",
    "calm": "mincho",
    "warning": "strong_gothic",
    "question": "rounded_gothic",
    "simple": "simple_gothic",
}


@dataclass
class ParsedDirective:
    raw: str
    preset: str
    profile: str
    parameters: dict[str, Any]
    font_key: str | None = None
    font_family: str | None = None
    font_label: str | None = None


GOOGLE_FONTS = {
    "noto_sans_jp": {
        "label": "Noto Sans JP",
        "profile": "readable_gothic",
        "font_family": '"Noto Sans JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
        "weights": (400, 700, 900),
        "default_weight": 900,
        "aliases": ("noto sans jp", "noto sans", "ノトサンズ", "ノトサン"),
    },
    "zen_kaku_gothic_antique": {
        "label": "Zen Kaku Gothic Antique",
        "profile": "readable_gothic",
        "font_family": '"Zen Kaku Gothic Antique", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
        "weights": (400, 700, 900),
        "default_weight": 900,
        "aliases": ("zen kaku gothic antique", "zen kaku", "ゼン角", "角ゴ"),
    },
    "m_plus_rounded_1c": {
        "label": "M PLUS Rounded 1c",
        "profile": "rounded_gothic",
        "font_family": '"M PLUS Rounded Onec", "M PLUS Rounded 1c", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif',
        "weights": (400, 700, 800, 900),
        "default_weight": 900,
        "aliases": ("m plus rounded 1c", "m plus rounded", "mplus rounded", "エムプラス", "丸ゴ", "丸ゴシック"),
    },
    "zen_maru_gothic": {
        "label": "Zen Maru Gothic",
        "profile": "rounded_gothic",
        "font_family": '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif',
        "weights": (400, 700, 900),
        "default_weight": 900,
        "aliases": ("zen maru gothic", "zen maru", "丸ゴ", "丸ゴシック"),
    },
    "mochiy_pop_one": {
        "label": "Mochiy Pop One",
        "profile": "pop_kawaii",
        "font_family": '"Mochiy Pop One", "M PLUS Rounded Onec", "M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("mochiy pop one", "mochiy", "モッチーポップ", "もちポップ", "可愛い", "かわいい", "ポップ"),
    },
    "rocknroll_one": {
        "label": "RocknRoll One",
        "profile": "rock_pop",
        "font_family": '"RocknRoll One", "Mochiy Pop One", "M PLUS Rounded Onec", "M PLUS Rounded 1c", "Meiryo", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("rocknroll one", "rocknroll", "rock n roll", "ロックンロール", "勢い", "元気"),
    },
    "klee_one": {
        "label": "Klee One",
        "profile": "handwritten",
        "font_family": '"Klee One", "Hina Mincho", "Yu Mincho", "Hiragino Mincho ProN", serif',
        "weights": (400, 600),
        "default_weight": 600,
        "aliases": ("klee one", "klee", "クレー", "手書き", "手描き", "手がき"),
    },
    "hina_mincho": {
        "label": "Hina Mincho",
        "profile": "handwritten",
        "font_family": '"Hina Mincho", "Klee One", "Yu Mincho", "Hiragino Mincho ProN", serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("hina mincho", "hina", "ひな明朝", "柔らかい明朝", "手書き明朝"),
    },
    "noto_serif_jp": {
        "label": "Noto Serif JP",
        "profile": "mincho",
        "font_family": '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", serif',
        "weights": (400, 700, 900),
        "default_weight": 700,
        "aliases": ("noto serif jp", "noto serif", "ノトセリフ", "明朝"),
    },
    "shippori_mincho": {
        "label": "Shippori Mincho",
        "profile": "serious_mincho",
        "font_family": '"Shippori Mincho", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif',
        "weights": (400, 500, 600, 700, 800),
        "default_weight": 800,
        "aliases": ("shippori mincho", "しっぽり", "しっぽり明朝", "重厚", "上品"),
    },
    "reggae_one": {
        "label": "Reggae One",
        "profile": "impact",
        "font_family": '"Reggae One", "Train One", "Mochiy Pop One", "Arial Black", "Meiryo", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("reggae one", "reggae", "レゲエ", "インパクト", "バラエティ"),
    },
    "train_one": {
        "label": "Train One",
        "profile": "impact",
        "font_family": '"Train One", "Reggae One", "Arial Black", "Meiryo", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("train one", "train", "トレイン", "装飾", "強烈"),
    },
    "dotgothic16": {
        "label": "DotGothic16",
        "profile": "retro_dot",
        "font_family": '"DotGothicOneSix", "DotGothic16", "Osaka-Mono", "Menlo", monospace',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("dotgothic16", "dot gothic", "ドットゴシック", "ドット", "ゲーム", "ピクセル"),
    },
    "bebas_neue": {
        "label": "Bebas Neue",
        "profile": "english_bold",
        "font_family": '"Bebas Neue", "Anton", "Arial Narrow", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("bebas neue", "bebas", "英字", "英語", "アルファベット", "縦長"),
    },
    "anton": {
        "label": "Anton",
        "profile": "english_bold",
        "font_family": '"Anton", "Bebas Neue", "Arial Black", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("anton", "アントン", "英字太字", "太い英字"),
    },
    "caveat": {
        "label": "Caveat",
        "profile": "english_script",
        "font_family": '"Caveat", "Klee One", cursive',
        "weights": (400, 500, 600, 700),
        "default_weight": 700,
        "aliases": ("caveat", "カヴィアット", "筆記体", "英字手書き", "script", "cursive"),
    },
    "biz_udp_gothic": {
        "label": "BIZ UDPGothic",
        "profile": "simple_gothic",
        "font_family": '"BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif',
        "weights": (400, 700),
        "default_weight": 700,
        "aliases": ("biz udpgothic", "biz udp gothic", "biz gothic", "bizゴシック"),
    },
    "kosugi_maru": {
        "label": "Kosugi Maru",
        "profile": "rounded_gothic",
        "font_family": '"Kosugi Maru", "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Meiryo", sans-serif',
        "weights": (400,),
        "default_weight": 400,
        "aliases": ("kosugi maru", "小杉丸", "こすぎ丸"),
    },
}

PROFILE_GOOGLE_FONT = {
    "readable_gothic": "zen_kaku_gothic_antique",
    "rounded_gothic": "m_plus_rounded_1c",
    "pop_kawaii": "mochiy_pop_one",
    "rock_pop": "rocknroll_one",
    "handwritten": "klee_one",
    "strong_gothic": "noto_sans_jp",
    "mincho": "noto_serif_jp",
    "serious_mincho": "shippori_mincho",
    "impact": "reggae_one",
    "retro_dot": "dotgothic16",
    "english_bold": "bebas_neue",
    "english_script": "caveat",
    "simple_gothic": "biz_udp_gothic",
}


def read_default_directives() -> str:
    if DEFAULT_TEMPLATE.exists():
        return DEFAULT_TEMPLATE.read_text(encoding="utf-8")
    return "使うフォントパターンは1つ。\n全テロップを、太めで読みやすいゴシックにする。\n"


def normalize_digits(text: str) -> str:
    return text.translate(FULL_WIDTH_DIGITS)


def extract_pattern_count(text: str) -> int | None:
    normalized = normalize_digits(text)
    for match in re.finditer(r"(\d+)\s*(?:つ|個|種類|パターン)", normalized):
        count = int(match.group(1))
        if count > 0:
            return count

    for kanji, count in KANJI_NUMBERS.items():
        if re.search(fr"{kanji}\s*(?:つ|個|種類|パターン)", normalized):
            return count

    return None


def score_keywords(line: str, keyword_map: dict[str, tuple[str, ...]]) -> dict[str, int]:
    scores: dict[str, int] = {}
    for key, keywords in keyword_map.items():
        score = sum(1 for keyword in keywords if keyword in line)
        if score:
            scores[key] = score
    return scores


def best_score(scores: dict[str, int], fallback: str) -> str:
    if not scores:
        return fallback
    return max(scores.items(), key=lambda item: (item[1], -PRESET_ORDER.index(item[0]) if item[0] in PRESET_ORDER else 0))[0]


def infer_preset(line: str, used_presets: set[str]) -> str:
    scores = score_keywords(line, PRESET_KEYWORDS)
    if scores:
        ordered = sorted(
            scores.items(),
            key=lambda item: (item[1], -PRESET_ORDER.index(item[0])),
            reverse=True,
        )
        for preset, _ in ordered:
            if preset not in used_presets:
                return preset
        return ordered[0][0]

    for preset in PRESET_ORDER:
        if preset not in used_presets:
            return preset
    return "default"


def infer_profile(line: str, preset: str) -> str:
    scores = score_keywords(line, PROFILE_KEYWORDS)
    return best_score(scores, DEFAULT_PROFILE_BY_PRESET.get(preset, "readable_gothic"))


def normalize_font_name(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


GENERIC_FONT_ALIASES = {
    "明朝",
    "丸ゴ",
    "丸ゴシック",
    "かわいい",
    "可愛い",
    "ポップ",
    "手書き",
    "手描き",
    "手がき",
    "インパクト",
    "英字",
    "英語",
    "アルファベット",
    "筆記体",
    "ドット",
    "ゲーム",
    "ピクセル",
    "レトロ",
    "重厚",
    "上品",
    "和風",
}


def extract_google_font(line: str) -> tuple[str, dict[str, Any]] | None:
    bracket = re.search(r"(?:フォント|font|font_family)\s*[\[:：=]\s*([^\]）)]+)", line, flags=re.IGNORECASE)
    candidates = [(bracket.group(1), True)] if bracket else []
    candidates.append((line, False))

    for candidate, is_explicit_slot in candidates:
        normalized = normalize_font_name(candidate)
        for font_key, meta in GOOGLE_FONTS.items():
            names = (meta["label"], *meta["aliases"])
            if any(
                normalize_font_name(name) in normalized
                for name in names
                if is_explicit_slot or name == meta["label"] or name not in GENERIC_FONT_ALIASES
            ):
                return font_key, meta
    return None


def extract_parameters(line: str) -> dict[str, Any]:
    normalized = normalize_digits(line)
    params: dict[str, Any] = {}

    weight = re.search(r"(?:太さ|weight|font_weight)\s*[\[:：=]\s*(\d{3})", normalized, flags=re.IGNORECASE)
    if weight:
        value = int(weight.group(1))
        if 100 <= value <= 900:
            params["font_weight"] = value

    size = re.search(r"(?:サイズ|大きさ|font_size)\s*[\[:：=]\s*(\d{2,3})", normalized, flags=re.IGNORECASE)
    if size:
        value = int(size.group(1))
        if 24 <= value <= 180:
            params["font_size"] = value

    spacing = re.search(r"(?:文字間|letter_spacing)\s*[\[:：=]\s*([0-9.]+(?:em|px)?)", normalized, flags=re.IGNORECASE)
    if spacing:
        value = spacing.group(1)
        params["letter_spacing"] = value if value.endswith(("em", "px")) else f"{value}em"

    line_height = re.search(r"(?:行間|line_height)\s*[\[:：=]\s*([0-9.]+)", normalized, flags=re.IGNORECASE)
    if line_height:
        value = float(line_height.group(1))
        if 0.8 <= value <= 2.4:
            params["line_height"] = value

    return params


def nearest_supported_weight(requested: int, supported: tuple[int, ...]) -> int:
    return min(supported, key=lambda value: (abs(value - requested), -value))


def resolve_font_weight(font_meta: dict[str, Any], params: dict[str, Any]) -> int:
    supported = tuple(int(value) for value in font_meta.get("weights", (400, 700, 900)))
    if "font_weight" in params:
        return nearest_supported_weight(int(params["font_weight"]), supported)
    return int(font_meta.get("default_weight", supported[-1]))


def directive_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.splitlines():
        candidates = [part.strip() for part in re.split(r"(?<=。)|[;；]", raw) if part.strip()]
        if not candidates:
            candidates = [raw.strip()]
        for candidate in candidates:
            line = candidate
            if not line or line.startswith("#"):
                continue
            line = re.sub(r"^\s*(?:[-*]|\d+[.)]|[一二三四五][.)、])\s*", "", line)
            if "書き方例" in line or "例" == line:
                continue
            if (
                score_keywords(line, PRESET_KEYWORDS)
                or score_keywords(line, PROFILE_KEYWORDS)
                or extract_google_font(line)
                or extract_parameters(line)
            ):
                lines.append(line)
    return lines


def parse_directives(text: str) -> dict[str, Any]:
    count = extract_pattern_count(text)
    lines = directive_lines(text)
    used_presets: set[str] = set()
    parsed: list[ParsedDirective] = []

    for line in lines:
        preset = infer_preset(line, used_presets)
        used_presets.add(preset)
        explicit_font = extract_google_font(line)
        if explicit_font:
            font_key, font_meta = explicit_font
            profile = str(font_meta["profile"])
            font_family = str(font_meta["font_family"])
            font_label = str(font_meta["label"])
        else:
            profile = infer_profile(line, preset)
            font_key = PROFILE_GOOGLE_FONT[profile]
            font_meta = GOOGLE_FONTS[font_key]
            font_family = str(font_meta["font_family"])
            font_label = str(font_meta["label"])
        parsed.append(
            ParsedDirective(
                raw=line,
                preset=preset,
                profile=profile,
                parameters=extract_parameters(line),
                font_key=font_key,
                font_family=font_family,
                font_label=font_label,
            )
        )

    if count is None:
        count = max(1, len(parsed))

    apply_to_all = count == 1 and bool(
        re.search(r"(?:1|一)\s*(?:つ|個|種類|パターン)", normalize_digits(text))
        or re.search(r"(全部|全体|全テロップ|すべて|全プリセット|同じフォント|統一)", text)
    )

    notes: list[str] = []
    if count > len(PRESET_ORDER):
        notes.append(f"現在のプリセット数に合わせて {len(PRESET_ORDER)} パターンまで反映します。")
        count = len(PRESET_ORDER)

    selected = parsed[:count]
    while len(selected) < count:
        preset = next((name for name in PRESET_ORDER if name not in {item.preset for item in selected}), "default")
        selected.append(
            ParsedDirective(
                raw=f"{PRESET_LABELS[preset]}は既定のフォント",
                preset=preset,
                profile=DEFAULT_PROFILE_BY_PRESET.get(preset, "readable_gothic"),
                parameters={},
                font_key=None,
                font_family=None,
                font_label=None,
            )
        )

    patterns = []
    for index, item in enumerate(selected, start=1):
        font_key = item.font_key or PROFILE_GOOGLE_FONT[item.profile]
        font_meta = GOOGLE_FONTS[font_key]
        font_family = item.font_family or str(font_meta["font_family"])
        font_label = item.font_label or str(font_meta["label"])
        font_source = "google"
        params = dict(item.parameters)
        params["font_weight"] = resolve_font_weight(font_meta, params)
        patterns.append(
            {
                "id": f"font_{index:02d}_{item.preset}",
                "label": PRESET_LABELS.get(item.preset, item.preset),
                "preset": item.preset,
                "apply_to_all": apply_to_all and index == 1,
                "profile": item.profile,
                "profile_label": PROFILE_LABELS[item.profile],
                "font_family": font_family,
                "font_source": font_source,
                "google_font": font_label,
                "intent": item.raw,
                **params,
            }
        )

    return {
        "version": "1.0.0",
        "source": "font_directives.md",
        "pattern_count": len(patterns),
        "patterns": patterns,
        "notes": notes,
    }


def apply_plan_to_composition(composition: dict[str, Any], plan: dict[str, Any]) -> None:
    try:
        from _telop_presets import embed_presets_into_composition

        if not composition.get("timeline", {}).get("telop_styles"):
            embed_presets_into_composition(composition)
    except Exception:
        composition.setdefault("timeline", {})
        composition["timeline"].setdefault("telop_styles", {})

    timeline = composition.setdefault("timeline", {})
    styles = timeline.setdefault("telop_styles", {})

    def apply_pattern_to_style(style: dict[str, Any], pattern: dict[str, Any]) -> None:
        style["font_family"] = pattern["font_family"]
        style["font_profile"] = pattern["profile"]
        style["font_source"] = pattern.get("font_source", "google")
        if pattern.get("google_font"):
            style["google_font"] = pattern["google_font"]
        for key in ("font_weight", "font_size", "letter_spacing", "line_height"):
            if key in pattern:
                style[key] = pattern[key]

    for pattern in plan["patterns"]:
        if pattern.get("apply_to_all"):
            if not styles:
                styles["default"] = {}
            for style in styles.values():
                apply_pattern_to_style(style, pattern)
            continue
        preset = pattern["preset"]
        if preset not in styles:
            styles[preset] = copy.deepcopy(styles.get("default", {}))
        apply_pattern_to_style(styles[preset], pattern)

    timeline["font_plan"] = plan


def resolve_run_dir(run_dir: str | None) -> Path:
    if not run_dir:
        return Path.cwd()
    path = Path(run_dir)
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(data, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", nargs="?", help="runs/<run_name> へのパス")
    parser.add_argument("--directives", default=None, help="font_directives.md のパス")
    parser.add_argument("--composition", default=None, help="composition.json のパス")
    parser.add_argument("--output", default=None, help="font_plan.json の出力先")
    parser.add_argument("--apply-composition", action="store_true", help="composition.json に font_family を反映")
    args = parser.parse_args()

    run_dir = resolve_run_dir(args.run_dir)
    directives_path = Path(args.directives) if args.directives else run_dir / "font_directives.md"
    if not directives_path.is_absolute():
        directives_path = (REPO_ROOT / directives_path).resolve()

    if directives_path.exists():
        text = directives_path.read_text(encoding="utf-8")
    else:
        text = read_default_directives()
        directives_path.parent.mkdir(parents=True, exist_ok=True)
        directives_path.write_text(text, encoding="utf-8")

    plan = parse_directives(text)
    output_path = Path(args.output) if args.output else run_dir / "font_plan.json"
    if not output_path.is_absolute():
        output_path = (REPO_ROOT / output_path).resolve()
    write_json(output_path, plan)

    if args.apply_composition:
        comp_path = Path(args.composition) if args.composition else run_dir / DEFAULT_COMPOSITION
        if not comp_path.is_absolute():
            comp_path = (REPO_ROOT / comp_path).resolve()
        if not comp_path.exists():
            sys.exit(f"composition.json not found: {comp_path}")
        composition = json.loads(comp_path.read_text(encoding="utf-8"))
        apply_plan_to_composition(composition, plan)
        write_json(comp_path, composition)
        print(f"applied fonts to {comp_path}")

    print(f"font patterns: {plan['pattern_count']}")
    for pattern in plan["patterns"]:
        print(f"  {pattern['preset']}: {pattern['profile_label']}")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
