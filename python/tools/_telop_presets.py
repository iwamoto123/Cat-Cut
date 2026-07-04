"""テロッププリセット読み込みユーティリティ。

将来 GUI からも呼び出せるように、純粋関数として提供する。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


DEFAULT_PRESET_FILE = Path(__file__).resolve().parents[2] / "templates" / "telop_presets.yaml"


def load_presets(preset_file: Path | str | None = None) -> dict[str, dict[str, Any]]:
    """telop_presets.yaml を読み込み、{preset_name: TelopStyle dict} を返す。"""
    path = Path(preset_file) if preset_file else DEFAULT_PRESET_FILE
    if not path.exists():
        raise FileNotFoundError(f"preset file not found: {path}")
    data = yaml.safe_load(open(path, encoding="utf-8")) or {}
    presets = data.get("presets", {})
    # description は Telop コンポーネントには不要だが残しても無害
    return presets


def list_preset_names(preset_file: Path | str | None = None) -> list[str]:
    return list(load_presets(preset_file).keys())


def embed_presets_into_composition(
    composition: dict,
    preset_file: Path | str | None = None,
    default_style: str = "default",
) -> dict:
    """composition の timeline に telop_styles と default_telop_style を埋め込む (in-place)。"""
    presets = load_presets(preset_file)
    composition.setdefault("timeline", {})
    composition["timeline"]["telop_styles"] = presets
    composition["timeline"]["default_telop_style"] = default_style
    return composition
