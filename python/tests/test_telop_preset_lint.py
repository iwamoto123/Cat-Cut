"""フェーズT2.5-2: テロッププリセットのデザイン原則リント。

telop_presets.yaml の演出系プリセット(フェーズT1/T2.5で追加したもの)が
デザイン原則を満たすことを機械的に検証する:

原則1: 濃色×濃色の隣接縁を作らない。隣接するレイヤー
       (fill → inner_stroke → outer_stroke → background) は
       十分な明度差(相対輝度差 0.30 以上)を持つこと
原則2: 縁は細く(外縁でも 14px 以下)。太い第2縁の代わりに
       「細い縁 + shadow_offset(ハード影)」または「細い縁 + drop_shadow」を使う
原則3: shadow_offset を使う場合はスキーマ ({x, y, color}) を満たすこと

将来プリセットを追加してもこのテストが原則違反を検出する。
旧スタイル群(default/highlight/カラーウェイ42種等)は対象外(後方互換のため変更しない)。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from _telop_presets import load_presets

# リント対象 = 演出系プリセット(フェーズT1の10種 + T2.5の追加分)
DIRECTED_PRESET_NAMES = [
    "fact_yellow",
    "neutral_white",
    "neutral_white_pink",
    "emotion_red",
    "question_blue",
    "reply_cyan",
    "special_purple",
    "box_yellow",
    "box_red",
    "cta_yellow",
    "op_brush",
    "serif_quote",
    "serif_harsh",
]

# 原則1: 隣接レイヤーに要求する最小の相対輝度差
MIN_ADJACENT_LUMINANCE_DIFF = 0.30
# 原則2: 縁幅の上限(px)
MAX_STROKE_WIDTH = 14


def _hex_to_rgb(color: str):
    value = color.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) != 6:
        return None
    try:
        return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except ValueError:
        return None


def relative_luminance(color: str):
    """WCAG相対輝度(0=黒, 1=白)。#RRGGBB以外はNone。"""
    rgb = _hex_to_rgb(color)
    if rgb is None:
        return None

    def linearize(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (linearize(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def fill_luminance(fill: dict):
    """fill の代表輝度(グラデーションは両端の平均)。"""
    if not isinstance(fill, dict):
        return None
    if fill.get("type") == "gradient":
        lums = [
            relative_luminance(str(fill.get(key, "")))
            for key in ("gradient_from", "gradient_to")
        ]
        lums = [v for v in lums if v is not None]
        return sum(lums) / len(lums) if lums else None
    return relative_luminance(str(fill.get("color", "")))


def adjacent_layers(preset: dict):
    """内側から外側への隣接レイヤー列 [(名前, 輝度), ...] を作る。

    fill → inner_stroke → outer_stroke → background の順。null のレイヤーは飛ばす
    (飛ばした結果隣り合うペアが実描画でも隣接する)。
    """
    layers = []
    fill_lum = fill_luminance(preset.get("fill"))
    if fill_lum is not None:
        layers.append(("fill", fill_lum))
    for key in ("inner_stroke", "outer_stroke"):
        stroke = preset.get(key)
        if isinstance(stroke, dict):
            lum = relative_luminance(str(stroke.get("color", "")))
            if lum is not None:
                layers.append((key, lum))
    background = preset.get("background")
    if isinstance(background, dict):
        lum = relative_luminance(str(background.get("color", "")))
        if lum is not None:
            layers.append(("background", lum))
    return layers


class TelopPresetLintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.presets = load_presets()

    def test_all_directed_presets_exist(self):
        for name in DIRECTED_PRESET_NAMES:
            self.assertIn(name, self.presets, f"演出系プリセット {name} が無い")

    def test_adjacent_layers_have_luminance_contrast(self):
        # 原則1: 濃色隣接なし = 隣接レイヤー間の相対輝度差 >= 0.30
        for name in DIRECTED_PRESET_NAMES:
            layers = adjacent_layers(self.presets[name])
            for (inner_name, inner_lum), (outer_name, outer_lum) in zip(layers, layers[1:]):
                with self.subTest(preset=name, pair=f"{inner_name}-{outer_name}"):
                    diff = abs(inner_lum - outer_lum)
                    self.assertGreaterEqual(
                        diff,
                        MIN_ADJACENT_LUMINANCE_DIFF,
                        f"{name}: {inner_name}(輝度{inner_lum:.2f}) と {outer_name}(輝度{outer_lum:.2f}) の"
                        f"明度差 {diff:.2f} が {MIN_ADJACENT_LUMINANCE_DIFF} 未満 (濃色隣接/低コントラスト縁)",
                    )

    def test_stroke_widths_are_thin(self):
        # 原則2: 縁は細く(太縁の立体感は shadow_offset / drop_shadow で出す)
        for name in DIRECTED_PRESET_NAMES:
            preset = self.presets[name]
            for key in ("inner_stroke", "outer_stroke"):
                stroke = preset.get(key)
                if isinstance(stroke, dict):
                    with self.subTest(preset=name, stroke=key):
                        self.assertLessEqual(
                            stroke.get("width", 0),
                            MAX_STROKE_WIDTH,
                            f"{name}.{key}: 縁幅 {stroke.get('width')}px が {MAX_STROKE_WIDTH}px を超過",
                        )

    def test_shadow_offset_schema(self):
        # 原則3: shadow_offset は {x, y, color} を満たす
        for name, preset in self.presets.items():
            shadow_offset = preset.get("shadow_offset")
            if shadow_offset is None:
                continue
            with self.subTest(preset=name):
                self.assertIsInstance(shadow_offset, dict, f"{name}.shadow_offset が辞書でない")
                self.assertIsInstance(shadow_offset.get("x"), (int, float), f"{name}.shadow_offset.x が数値でない")
                self.assertIsInstance(shadow_offset.get("y"), (int, float), f"{name}.shadow_offset.y が数値でない")
                self.assertIsNotNone(
                    relative_luminance(str(shadow_offset.get("color", ""))),
                    f"{name}.shadow_offset.color が #RRGGBB でない",
                )

    def test_serif_presets_use_shippori_mincho(self):
        # T2.5-3: 明朝プリセットは Shippori Mincho B1 (システム明朝フォールバック付き)
        for name in ("serif_quote", "serif_harsh"):
            font_family = self.presets[name]["font_family"]
            self.assertIn("Shippori Mincho B1", font_family)
            self.assertIn("serif", font_family)

    def test_legacy_presets_untouched_shape(self):
        # 後方互換: 旧スタイル群はこのリントの対象外だが、存在と形は維持されている
        default = self.presets["default"]
        self.assertEqual(default["fill"]["type"], "gradient")
        self.assertEqual(default["font_size"], 72)


if __name__ == "__main__":
    unittest.main()
