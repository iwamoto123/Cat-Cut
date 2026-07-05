"""フェーズT2.5-4: シーン種類(semantic type)ベースのプリセット体系。

AIパス3(step06c)は「シーンの意味種類」(10種)を返し、step08/UI が
type → preset マッピングを解決してスタイルを適用する。

マッピングの優先順位(上が強い):
1. ユーザーマッピング(desktop の userData に保存された telop_type_mapping.json)
2. 既定マッピング(templates/telop_type_mapping.yaml)
3. 本モジュールのフォールバック定数(YAMLが読めない場合の保険)

desktop/src/lib/telopTypes.ts と type一覧・既定マッピングを同期すること。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

# シーンの意味種類(semantic type)10種。順序はUI表示順でもある
SEMANTIC_TYPES = (
    "default",    # 説明・事実
    "surprise",   # 意外な事実
    "harsh",      # 辛辣・毒舌
    "quote",      # 名言・格言
    "emphasis",   # 強調・断言
    "question",   # 質問
    "reply",      # 相槌・軽い返し
    "punchline",  # 要点・オチ
    "hype",       # 煽り
    "cta",        # 行動喚起
)

DEFAULT_SEMANTIC_TYPE = "default"

# フェーズT3: プリセット/マッピングが指定できる登場アニメーションID
ANIMATION_IN_TYPES = ("pop_big", "slide_left", "slide_up", "zoom", "stamp", "fade", "none")
# フェーズT3: 退場アニメーションID
ANIMATION_OUT_TYPES = ("fade", "pop_out", "none")
# フェーズT3: assets/sfx/ に同梱する効果音ID(generate_sfx.py と同期)。
# "none" はマッピングで「このtypeは鳴らさない」を明示するための特殊値
SFX_IDS = ("don", "shakin", "pon", "jan", "hyu")

# templates/telop_type_mapping.yaml と同内容のフォールバック(YAML未読込時の保険)
FALLBACK_TYPE_STYLE_MAPPING: Dict[str, str] = {
    "default": "fact_yellow",
    "surprise": "box_yellow",
    "harsh": "serif_harsh",
    "quote": "serif_quote",
    "emphasis": "emotion_red",
    "question": "question_blue",
    "reply": "reply_cyan",
    "punchline": "box_yellow",
    "hype": "special_purple",
    "cta": "cta_yellow",
}

DEFAULT_TYPE_MAPPING_FILE = Path(__file__).resolve().parents[2] / "templates" / "telop_type_mapping.yaml"


def sanitize_semantic_type(value: Any) -> str:
    """AIが返したtypeを10種へ正規化する(不明・欠落は default)。"""
    if isinstance(value, str) and value in SEMANTIC_TYPES:
        return value
    return DEFAULT_SEMANTIC_TYPE


def _normalize_mapping_entry(value: Any) -> Optional[Dict[str, str]]:
    """マッピング1エントリを正規化する(フェーズT3: 新旧形式対応)。

    - 旧形式: "fact_yellow" のような文字列(style のみ)
    - 新形式: { "style": str, "animation_in"?: str, "sfx"?: str } の辞書
    無効なエントリは None を返す(呼び出し側で捨てる)。
    """
    if isinstance(value, str):
        return {"style": value} if value.strip() else None
    if isinstance(value, dict):
        entry: Dict[str, str] = {}
        style = value.get("style")
        if isinstance(style, str) and style.strip():
            entry["style"] = style.strip()
        animation = value.get("animation_in")
        if isinstance(animation, str) and animation in ANIMATION_IN_TYPES:
            entry["animation_in"] = animation
        sfx = value.get("sfx")
        if isinstance(sfx, str) and (sfx in SFX_IDS or sfx == "none"):
            entry["sfx"] = sfx
        return entry or None
    return None


def _extract_type_entries(data: Any) -> Dict[str, Dict[str, str]]:
    """YAML/JSONの type_styles セクション(または直下の辞書)から有効なエントリだけ拾う。

    フェーズT3: エントリ値は文字列(旧形式)と {style, animation_in?, sfx?} 辞書(新形式)の
    両方を受け付ける。
    """
    if not isinstance(data, dict):
        return {}
    section = data.get("type_styles", data)
    if not isinstance(section, dict):
        return {}
    result: Dict[str, Dict[str, str]] = {}
    for key, value in section.items():
        if str(key) not in SEMANTIC_TYPES:
            continue
        entry = _normalize_mapping_entry(value)
        if entry:
            result[str(key)] = entry
    return result


def load_type_mapping_entries(
    default_file: Optional[Path | str] = None,
    user_file: Optional[Path | str] = None,
) -> Dict[str, Dict[str, str]]:
    """type → {style, animation_in?, sfx?} のフルエントリを解決する(フェーズT3)。

    優先順位はフィールド単位で「フォールバック < 既定YAML < ユーザーJSON」。
    どちらのファイルも無い/壊れている場合でも、必ず全typeのエントリ(styleあり)を返す。
    """
    entries: Dict[str, Dict[str, str]] = {
        semantic_type: {"style": style}
        for semantic_type, style in FALLBACK_TYPE_STYLE_MAPPING.items()
    }

    def _merge(loaded: Dict[str, Dict[str, str]]) -> None:
        for semantic_type, entry in loaded.items():
            entries.setdefault(semantic_type, {}).update(entry)

    default_path = Path(default_file) if default_file else DEFAULT_TYPE_MAPPING_FILE
    if default_path.exists():
        try:
            import yaml

            _merge(_extract_type_entries(yaml.safe_load(default_path.read_text(encoding="utf-8"))))
        except Exception:
            pass

    if user_file:
        user_path = Path(user_file)
        if user_path.exists():
            try:
                _merge(_extract_type_entries(json.loads(user_path.read_text(encoding="utf-8"))))
            except Exception:
                pass

    return entries


def load_type_mapping(
    default_file: Optional[Path | str] = None,
    user_file: Optional[Path | str] = None,
) -> Dict[str, str]:
    """type → preset(styleのみ) マッピングを解決する(フォールバック < 既定YAML < ユーザーJSON)。

    どちらのファイルも無い/壊れている場合でも、必ず全typeのエントリを持つ辞書を返す。
    フェーズT3以降のアニメ・SFXを含むフルエントリは load_type_mapping_entries() を使う。
    """
    entries = load_type_mapping_entries(default_file, user_file)
    return {
        semantic_type: entry.get("style") or FALLBACK_TYPE_STYLE_MAPPING[semantic_type]
        for semantic_type, entry in entries.items()
    }


def _mapping_entry_for(semantic_type: str, mapping: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """マッピングから該当typeのエントリを取り出す(値は文字列/辞書の両形式を許容)。"""
    if not mapping:
        return {}
    return _normalize_mapping_entry(mapping.get(semantic_type)) or {}


def resolve_style_for_type(semantic_type: Any, mapping: Optional[Dict[str, Any]] = None) -> str:
    """semantic type からプリセットIDを解決する。

    mapping の値は旧形式(文字列)と新形式({style, ...} 辞書)の両方を受け付ける。
    """
    normalized = sanitize_semantic_type(semantic_type)
    entry = _mapping_entry_for(normalized, mapping)
    return entry.get("style") or FALLBACK_TYPE_STYLE_MAPPING[normalized]


def resolve_animation_for_type(semantic_type: Any, mapping: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """semantic type からマッピングの登場アニメーションを解決する(フェーズT3)。

    マッピングにアニメ指定が無ければ None(=プリセット既定に任せる)。
    """
    normalized = sanitize_semantic_type(semantic_type)
    animation = _mapping_entry_for(normalized, mapping).get("animation_in")
    return animation if animation in ANIMATION_IN_TYPES else None


def resolve_sfx_for_type(semantic_type: Any, mapping: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """semantic type からマッピングの効果音IDを解決する(フェーズT3)。

    Returns:
        効果音ID / "none"(鳴らさない明示) / None(=プリセット既定に任せる)
    """
    normalized = sanitize_semantic_type(semantic_type)
    sfx = _mapping_entry_for(normalized, mapping).get("sfx")
    if sfx == "none" or sfx in SFX_IDS:
        return sfx
    return None
