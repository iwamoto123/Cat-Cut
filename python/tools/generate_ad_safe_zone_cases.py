"""フェーズW24 Phase A-4: adSafeZoneCases.json(TS/Python同期ケース表)の生成ツール。

resolve_cut_telop_y のケース表を Python実装の実出力で生成する。
TS側(remotion/desktop の adSafeZone.test.ts)と Python側(test_telop_placement.py)が
同じJSONを読み、同じ期待値に一致することで両言語実装の同期を担保する。

ロジックを変更したら再実行して remotion/tests/adSafeZoneCases.json を更新すること:
    .venv/bin/python python/tools/generate_ad_safe_zone_cases.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shared import telop_placement as tp  # noqa: E402

CASES = [
    {"name": "横型は素通し(顔があっても無視)",
     "input": {"orientation": "horizontal", "base_telop_y": 0.85,
               "face_box": {"x": 0.3, "y": 0.4, "w": 0.3, "h": 0.3}}},
    {"name": "横型・顔なしも素通し",
     "input": {"orientation": "horizontal", "base_telop_y": 0.5, "face_box": None}},
    {"name": "縦型・顔なしは既定の中央少し下(0.64)",
     "input": {"orientation": "vertical", "base_telop_y": 0.75, "face_box": None}},
    {"name": "縦型・不正な顔box(w=0)は顔なし扱い",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.2, "y": 0.2, "w": 0.0, "h": 0.3}}},
    {"name": "縦型・顔が上部: 既定0.64のままで顔に当たらない",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.3, "y": 0.15, "w": 0.35, "h": 0.2}}},
    {"name": "縦型・顔が中央: 顔の下端+マージンまで下げる(下帯内)",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.3, "y": 0.3, "w": 0.35, "h": 0.3}}},
    {"name": "縦型・顔が中央やや下: 下帯に収まらず上帯の既定0.36へ",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.3, "y": 0.5, "w": 0.35, "h": 0.3}}},
    {"name": "縦型・顔が下寄り: 上帯で顔上端側へ寄せる(0.36が顔に当たる)",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.3, "y": 0.42, "w": 0.35, "h": 0.25}}},
    {"name": "縦型・顔が画面をほぼ覆う(中心下寄り): 上帯既定へフォールバック",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}}},
    {"name": "縦型・顔が画面をほぼ覆う(中心上寄り): 下帯既定へフォールバック",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.05, "y": 0.0, "w": 0.9, "h": 0.9}}},
    {"name": "縦型・style_offset(0.1)は先に差し引かれる",
     "input": {"orientation": "vertical", "base_telop_y": 0.75, "face_box": None,
               "style_offset": 0.1}},
    {"name": "縦型・style_offsetで帯を割る場合は帯上端へクランプ",
     "input": {"orientation": "vertical", "base_telop_y": 0.75, "face_box": None,
               "style_offset": 0.4}},
    {"name": "縦型・ブロック高0.12(2行相当)でも顔下に収まるケース",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.3, "y": 0.2, "w": 0.35, "h": 0.35},
               "block_height_ratio": 0.12}},
    {"name": "縦型・ブロック高0.16では上下どちらにも収まらずフォールバック",
     "input": {"orientation": "vertical", "base_telop_y": 0.75,
               "face_box": {"x": 0.3, "y": 0.25, "w": 0.35, "h": 0.4},
               "block_height_ratio": 0.16}},
]


def main():
    for case in CASES:
        params = case["input"]
        case["expected"] = tp.resolve_cut_telop_y(
            orientation=params["orientation"],
            base_telop_y=params["base_telop_y"],
            face_box=params.get("face_box"),
            block_height_ratio=params.get("block_height_ratio", tp.DEFAULT_BLOCK_HEIGHT_RATIO),
            style_offset=params.get("style_offset", 0.0),
        )
    data = {
        "_comment": (
            "adSafeZone.ts(TS)と telop_placement.py(Python)の二重実装を同期させる共有ケース表。"
            "python/tools/generate_ad_safe_zone_cases.py で生成する(手編集しない)。"
        ),
        "constants": {
            "TELOP_BAND_TOP": tp.TELOP_BAND_TOP,
            "TELOP_BAND_BOTTOM": tp.TELOP_BAND_BOTTOM,
            "VERTICAL_DEFAULT_TELOP_Y": tp.VERTICAL_DEFAULT_TELOP_Y,
            "LOWER_BAND_TOP": tp.LOWER_BAND_TOP,
            "LOWER_BAND_BOTTOM": tp.LOWER_BAND_BOTTOM,
            "UPPER_BAND_TOP": tp.UPPER_BAND_TOP,
            "UPPER_BAND_BOTTOM": tp.UPPER_BAND_BOTTOM,
            "VERTICAL_UPPER_DEFAULT_TELOP_Y": tp.VERTICAL_UPPER_DEFAULT_TELOP_Y,
            "FACE_TELOP_MARGIN": tp.FACE_TELOP_MARGIN,
            "DEFAULT_BLOCK_HEIGHT_RATIO": tp.DEFAULT_BLOCK_HEIGHT_RATIO,
        },
        "cases": CASES,
    }
    out_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "remotion", "tests", "adSafeZoneCases.json",
    )
    with open(os.path.abspath(out_path), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {os.path.abspath(out_path)} ({len(CASES)} cases)")
    for case in CASES:
        print(f"  {case['expected']}: {case['name']}")


if __name__ == "__main__":
    main()
