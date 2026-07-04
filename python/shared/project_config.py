"""プロジェクト設定の読み込みとマージ。

YAML (推奨) または JSON 形式のプロジェクト設定ファイルを読み込み、
デフォルト値とマージして返す。PyYAML がなければ JSON フォールバック。
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict

try:
    import yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


# デフォルト設定 (default.yaml と同等)
DEFAULTS: Dict[str, Any] = {
    "project": {
        "name": "",
        "speaker": "",
        "description": "",
    },
    "text_rules": {
        "enumeration_style": "as_is",
        "known_terms": [],
        "corrections": {},
    },
    "telop": {
        "max_chars_per_line": 12,
        # 改善8-A-4: テロップページ=基本1行 (過去の正解データ学習値 templates/learned_rules.json
        # の "1ページ1行・12文字" に合わせる)。
        "max_lines_per_page": 1,
        "animation_in": "none",
        "animation_out": "none",
        "y_position": 0.5,
    },
    "render": {
        "fps": 30,
        "width": 1080,
        "height": 1920,
        "video_fit": "cover",
        "framing": {
            "scale": 1.0,
            "offset_y": 0,
        },
    },
    "edit": {
        "max_gap_ms": 600,
        # NOTE: "lead_padding_ms" (既定200) / "tail_padding_ms" (既定120) は
        # ここには含めない。DEFAULTS に含めると _deep_merge で個別テンプレート
        # (templates/*.yaml) や学習済みルール (learned_rules.json) が持つ旧
        # "segment_padding_ms" だけの設定にも常にこの既定値が混入してしまい、
        # 「新設定が無ければ旧設定へ両側フォールバック」という後方互換ロジックが
        # 効かなくなる。既定値の適用は step07_cut_proposal.py 側で
        # (lead_padding_ms/tail_padding_ms が無い場合のみ) 行う。
        # edge_head_pad_ms / edge_tail_pad_ms (改善9-A RMSエッジリファイン) も
        # 同様に step07 側で既定値 (80/150ms) を適用する。
        "filler_confidence_threshold": 0.6,
    },
}


def load_project_config(path: str | None) -> Dict[str, Any]:
    """プロジェクト設定ファイルを読み込み、デフォルトとマージして返す。

    Args:
        path: YAML/JSON ファイルパス。None の場合はデフォルト設定のみ返す。

    Returns:
        マージ済みの設定辞書。
    """
    if path is None:
        return _deep_copy(DEFAULTS)

    raw = _load_file(path)
    merged = _deep_merge(DEFAULTS, raw)
    learned = _load_learned_rules(path)
    if learned:
        merged = _deep_merge(merged, learned)
    return merged


def _load_learned_rules(project_path: str) -> Dict[str, Any]:
    """templates/learned_rules.json があれば、通常処理に使う正式ルールとして読み込む。"""
    rules_path = os.path.join(os.path.dirname(os.path.abspath(project_path)), "learned_rules.json")
    if not os.path.exists(rules_path):
        return {}
    try:
        raw = _load_file(rules_path)
    except Exception:
        return {}
    if raw.get("active") is False:
        return {}
    allowed = {}
    for key in ("text_rules", "telop", "edit", "timing", "dp"):
        if isinstance(raw.get(key), dict):
            allowed[key] = raw[key]
    return allowed


def _load_file(path: str) -> Dict[str, Any]:
    """YAML または JSON ファイルを読み込む。"""
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Project config not found: {abs_path}")

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    ext = os.path.splitext(abs_path)[1].lower()
    if ext in (".yaml", ".yml"):
        if not _HAS_YAML:
            raise ImportError(
                "PyYAML is required for .yaml files. "
                "Install with: pip install pyyaml"
            )
        return yaml.safe_load(content) or {}
    elif ext == ".json":
        return json.loads(content)
    else:
        # 拡張子不明の場合: YAML → JSON の順で試す
        if _HAS_YAML:
            try:
                return yaml.safe_load(content) or {}
            except Exception:
                pass
        return json.loads(content)


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """ネストされた辞書を再帰的にマージ。override が優先。"""
    result = _deep_copy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _deep_copy(d: Dict[str, Any]) -> Dict[str, Any]:
    """辞書の深いコピー (json経由)。"""
    return json.loads(json.dumps(d))
