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
# フェーズW24 Phase B-1: 広告向け4種(blur_in/typewriter/wipe_up/drop_settle)を追加
# フェーズW26: ショート向けの強い5種(slam/bounce_left/bounce_right/rise_bounce/drop_bounce)を追加
ANIMATION_IN_TYPES = (
    "pop_big", "slide_left", "slide_up", "zoom", "stamp", "fade",
    "blur_in", "typewriter", "wipe_up", "drop_settle",
    "slam", "bounce_left", "bounce_right", "rise_bounce", "drop_bounce", "none",
)
# フェーズT3: 退場アニメーションID
ANIMATION_OUT_TYPES = ("fade", "pop_out", "none")
# フェーズT3: assets/sfx/ に同梱する効果音ID(generate_sfx.py と同期)。
# "none" はマッピングで「このtypeは鳴らさない」を明示するための特殊値
# フェーズW2: teen(チーン。映像ギミックpinchの既定SFX)を追加
SFX_IDS = ("don", "shakin", "pon", "jan", "hyu", "teen")

# フェーズU7: シーンタイトル(chapter_titleオーバーレイ)の描画パターンID。
# remotion/src/lib/overlayStyles.ts の CHAPTER_TITLE_PATTERNS と同期すること
OVERLAY_TITLE_PATTERNS = ("box_accent", "band_gradient", "tag_ribbon", "minimal_line", "neon_plate")
DEFAULT_OVERLAY_TITLE_PATTERN = "box_accent"

# フェーズW1: 話者カラーの既定(templates/telop_type_mapping.yaml の speaker_colors と同内容の保険)。
# 「基本」タイプ(default/reply)のみ話者で色を変える。speaker_0 はマッピング無し=既定色のまま。
# desktop/src/lib/designExtras.ts の DEFAULT_SPEAKER_COLORS / main側と同期すること。
DEFAULT_SPEAKER_COLOR_APPLY_TYPES = ("default", "reply")
FALLBACK_SPEAKER_COLOR_STYLES: Dict[str, str] = {
    "speaker_1": "fact_cyan",
    "speaker_2": "fact_green",
}

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
    orientation: Optional[str] = None,
) -> Dict[str, Dict[str, str]]:
    """type → {style, animation_in?, sfx?} のフルエントリを解決する(フェーズT3)。

    優先順位はフィールド単位で「フォールバック < 既定YAML < ユーザーJSON」。
    どちらのファイルも無い/壊れている場合でも、必ず全typeのエントリ(styleあり)を返す。

    フェーズW26: orientation="vertical" のとき、vertical_type_styles
    (縦型ショート広告用の4スタイル集約デザインシステム)を type_styles の上へ重ねる。

    フェーズW30: ユーザーJSONの type_styles は横型デザインテーマ画面の保存値であり、
    縦型を知らない(実データ: 2026-07-07保存のユーザーJSONが縦型の広告スタイルを全typeで
    横型スタイルに戻し、アクセント割当も全滅していた)。縦型では
    「既定type_styles < ユーザーtype_styles < 既定vertical_type_styles < ユーザーvertical_type_styles」
    の順で重ね、縦型デザインはユーザーが縦型用として明示保存した場合のみ上書きされる。
    """
    entries: Dict[str, Dict[str, str]] = {
        semantic_type: {"style": style}
        for semantic_type, style in FALLBACK_TYPE_STYLE_MAPPING.items()
    }

    def _merge(loaded: Dict[str, Dict[str, str]]) -> None:
        for semantic_type, entry in loaded.items():
            entries.setdefault(semantic_type, {}).update(entry)

    default_data = None
    default_path = Path(default_file) if default_file else DEFAULT_TYPE_MAPPING_FILE
    if default_path.exists():
        try:
            import yaml

            default_data = yaml.safe_load(default_path.read_text(encoding="utf-8"))
            _merge(_extract_type_entries(default_data))
        except Exception:
            default_data = None

    user_data = None
    if user_file:
        user_path = Path(user_file)
        if user_path.exists():
            try:
                user_data = json.loads(user_path.read_text(encoding="utf-8"))
                _merge(_extract_type_entries(user_data))
            except Exception:
                user_data = None

    if orientation == "vertical":
        if isinstance(default_data, dict):
            _merge(_extract_type_entries(default_data.get("vertical_type_styles")))
        if isinstance(user_data, dict):
            _merge(_extract_type_entries(user_data.get("vertical_type_styles")))

    return entries


def sanitize_custom_styles(raw: Any) -> Dict[str, Dict[str, Any]]:
    """フェーズU6: カスタムスタイル定義(custom_* ID → TelopStyle辞書)を検証する。

    値が辞書で fill(辞書) を持つエントリのみ残す(描画側が最低限必要とする形)。
    IDはUI側の生成規則(custom_で始まる)を強制しない(将来の命名変更に寛容にするため)が、
    文字列でないキー・空キーは捨てる。
    """
    if not isinstance(raw, dict):
        return {}
    result: Dict[str, Dict[str, Any]] = {}
    for key, value in raw.items():
        style_id = str(key or "").strip()
        if not style_id or not isinstance(value, dict):
            continue
        if not isinstance(value.get("fill"), dict):
            continue
        result[style_id] = value
    return result


def load_custom_styles(user_file: Optional[Path | str] = None) -> Dict[str, Dict[str, Any]]:
    """フェーズU6: ユーザーマッピングJSON(telop_type_mapping.effective.json等)の
    custom_styles セクションを読む。無い・壊れている場合は空辞書。
    """
    if not user_file:
        return {}
    user_path = Path(user_file)
    if not user_path.exists():
        return {}
    try:
        data = json.loads(user_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return sanitize_custom_styles(data.get("custom_styles"))


def sanitize_overlay_title(raw: Any) -> Dict[str, Any]:
    """フェーズU7: overlay_title 設定を正規化する。

    欠落・不正は「enabled=True, box_accent」= U7以前と同じ挙動(後方互換)。
    """
    result = {"enabled": True, "style": DEFAULT_OVERLAY_TITLE_PATTERN}
    if not isinstance(raw, dict):
        return result
    if raw.get("enabled") is False:
        result["enabled"] = False
    style = raw.get("style")
    if isinstance(style, str) and style in OVERLAY_TITLE_PATTERNS:
        result["style"] = style
    return result


def load_overlay_title(user_file: Optional[Path | str] = None) -> Dict[str, Any]:
    """フェーズU7: ユーザーマッピングJSON(telop_type_mapping.effective.json等)の
    overlay_title セクションを読む。無い・壊れている場合は既定(有効・box_accent)。
    """
    if not user_file:
        return sanitize_overlay_title(None)
    user_path = Path(user_file)
    if not user_path.exists():
        return sanitize_overlay_title(None)
    try:
        data = json.loads(user_path.read_text(encoding="utf-8"))
    except Exception:
        return sanitize_overlay_title(None)
    return sanitize_overlay_title(data.get("overlay_title") if isinstance(data, dict) else None)


def sanitize_speaker_colors(raw: Any) -> Dict[str, Any]:
    """フェーズW1: speaker_colors 設定1ソース分の部分正規化。

    存在するフィールドだけ検証して返す(欠落フィールドは呼び出し側のマージで
    下位ソースの値が残る)。不正値のフィールドは捨てる。
    - enabled: bool のみ
    - apply_types: SEMANTIC_TYPES に含まれるものだけ残す(有効値ゼロは捨てる)
    - styles: {speaker_id(str): style_id(str)} の非空エントリだけ残す
      (style_idの実在検証はしない。未定義IDは effective_slot_style の sanitize で
      fact_yellow=既定へ落ちるため安全)
    """
    result: Dict[str, Any] = {}
    if not isinstance(raw, dict):
        return result
    if isinstance(raw.get("enabled"), bool):
        result["enabled"] = raw["enabled"]
    apply_types = raw.get("apply_types")
    if isinstance(apply_types, list):
        valid = [str(t) for t in apply_types if str(t) in SEMANTIC_TYPES]
        if valid:
            result["apply_types"] = valid
    styles = raw.get("styles")
    if isinstance(styles, dict):
        clean = {
            str(k).strip(): str(v).strip()
            for k, v in styles.items()
            if str(k or "").strip() and isinstance(v, str) and v.strip()
        }
        if clean:
            result["styles"] = clean
    return result


def load_speaker_colors(
    default_file: Optional[Path | str] = None,
    user_file: Optional[Path | str] = None,
) -> Dict[str, Any]:
    """フェーズW1: 話者カラー設定を解決する(フォールバック < 既定YAML < ユーザーJSON)。

    type_styles と同じ経路(templates/telop_type_mapping.yaml + --type-mapping の
    ユーザーJSON)の speaker_colors セクションをフィールド単位でマージする。
    どちらのファイルも無い/壊れている場合でも必ず完全形
    {"enabled", "apply_types", "styles"} を返す。
    """
    result: Dict[str, Any] = {
        "enabled": True,
        "apply_types": list(DEFAULT_SPEAKER_COLOR_APPLY_TYPES),
        "styles": dict(FALLBACK_SPEAKER_COLOR_STYLES),
    }

    def _merge_from(data: Any) -> None:
        if isinstance(data, dict):
            result.update(sanitize_speaker_colors(data.get("speaker_colors")))

    default_path = Path(default_file) if default_file else DEFAULT_TYPE_MAPPING_FILE
    if default_path.exists():
        try:
            import yaml

            _merge_from(yaml.safe_load(default_path.read_text(encoding="utf-8")))
        except Exception:
            pass

    if user_file:
        user_path = Path(user_file)
        if user_path.exists():
            try:
                _merge_from(json.loads(user_path.read_text(encoding="utf-8")))
            except Exception:
                pass

    return result


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
