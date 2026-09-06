"""フェーズT3: テロップ効果音(SFX)の自家生成スクリプト。

外部サイトの音源はライセンス確認が難しいため、ffmpeg の aevalsrc で
合成音を生成して同梱する(自家生成・利用制限なし。assets/sfx/LICENSE.md 参照)。

生成物:
- assets/sfx/<id>.wav          : 正本(モノラル 44.1kHz s16)
- remotion/public/sfx/<id>.wav : Remotion バンドル用コピー(staticFile("sfx/<id>.wav") で参照)

効果音ID(6種。telop_presets.yaml の sfx / type マッピングの sfx が参照する):
- don    : ドン。低周波サイン(ピッチ落ち)+ノイズバースト。強調・煽り系(pop_big)向け
- shakin : シャキーン。高周波の上昇スイープ+シマー。名言・辛辣系(slide_left)向け
- pon    : ポン。短いサイン波ポップ。質問系(slide_up)向け
- jan    : ジャン。長三和音バースト。要点・オチ・CTA系(zoom)向け
- hyu    : ヒュッ。下降スイープ+ノイズ。汎用の風切り音
- teen   : チーン。ベル系(高音サイン+非整数倍音+長いディケイ)。映像ギミックpinch向け(フェーズW2)

Usage:
    .venv/bin/python python/tools/generate_sfx.py            # 全効果音を生成
    .venv/bin/python python/tools/generate_sfx.py teen       # 指定IDのみ生成(既存wavを触らない)
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

EDITOR_ROOT = Path(__file__).resolve().parents[2]
ASSETS_SFX_DIR = EDITOR_ROOT / "assets" / "sfx"
REMOTION_SFX_DIR = EDITOR_ROOT / "remotion" / "public" / "sfx"

# (効果音ID, aevalsrc式, 尺秒)。式の合成振幅はクリップしないよう常にピーク<1.0に抑える
SFX_DEFINITIONS: list[tuple[str, str, float]] = [
    (
        "don",
        # 低音サイン(100→60Hzへピッチ落ち)+立ち上がりのノイズバースト
        "0.85*sin(2*PI*(60+40*exp(-20*t))*t)*exp(-7*t)"
        "+0.22*(random(0)-0.5)*exp(-45*t)",
        0.7,
    ),
    (
        "shakin",
        # 2.5k→8.5kHzの上昇スイープ+高域シマー2声
        "0.42*sin(2*PI*(2500+6000*t)*t)*exp(-4*t)"
        "+0.26*sin(2*PI*5200*t)*exp(-6*t)"
        "+0.18*sin(2*PI*7800*t)*exp(-3.5*t)",
        0.9,
    ),
    (
        "pon",
        # 短いサイン波ポップ(900→700Hzへ軽くピッチ落ち)
        "0.8*sin(2*PI*(700+200*exp(-30*t))*t)*exp(-16*t)",
        0.35,
    ),
    (
        "jan",
        # Cメジャー和音(C5+E5+G5+C4)のバースト
        "0.26*(sin(2*PI*523.25*t)+sin(2*PI*659.25*t)+sin(2*PI*783.99*t)"
        "+0.5*sin(2*PI*261.63*t))*exp(-3*t)",
        1.0,
    ),
    (
        "hyu",
        # 下降スイープ(2000Hz→0Hz)+わずかなノイズの風切り音
        "0.55*sin(2*PI*(2000-2500*t)*t)*exp(-5*t)"
        "+0.14*(random(0)-0.5)*exp(-8*t)",
        0.4,
    ),
    (
        "teen",
        # フェーズW2: チーン。仏鈴系のベル(基音2.09kHz+非整数倍音2声+アタックのきらめき)。
        # 倍音ほど早く減衰させ、基音は長いディケイで「チーン…」の余韻を残す
        "0.5*sin(2*PI*2093*t)*exp(-2.2*t)"
        "+0.28*sin(2*PI*5561*t)*exp(-4.5*t)"
        "+0.16*sin(2*PI*9247*t)*exp(-7*t)"
        "+0.08*(random(0)-0.5)*exp(-60*t)",
        1.8,
    ),
]

SFX_IDS = tuple(sfx_id for sfx_id, _, _ in SFX_DEFINITIONS)


def generate_sfx(
    output_dir: Path = ASSETS_SFX_DIR,
    copy_dir: Path | None = REMOTION_SFX_DIR,
    only_ids: list[str] | None = None,
) -> list[Path]:
    """効果音を生成し、生成したwavのパス一覧を返す。ffmpeg必須。

    only_ids 指定時はそのIDだけ生成する(フェーズW2: 効果音追加時に既存wavを
    再生成しないため。random()成分を含む式は実行のたびにバイトが変わる)。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    if copy_dir is not None:
        copy_dir.mkdir(parents=True, exist_ok=True)
    generated: list[Path] = []
    for sfx_id, expr, duration in SFX_DEFINITIONS:
        if only_ids is not None and sfx_id not in only_ids:
            continue
        out_path = output_dir / f"{sfx_id}.wav"
        fade_start = max(0.0, duration - 0.05)
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi",
            "-i", f"aevalsrc={expr}:d={duration}:s=44100",
            # 末尾クリック防止の短いフェードアウト
            "-af", f"afade=t=out:st={fade_start}:d=0.05",
            "-ac", "1",
            "-ar", "44100",
            "-sample_fmt", "s16",
            str(out_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
            raise RuntimeError(f"ffmpeg failed for {sfx_id}: {result.stderr[-300:]}")
        generated.append(out_path)
        if copy_dir is not None:
            (copy_dir / out_path.name).write_bytes(out_path.read_bytes())
    return generated


def main() -> None:
    only_ids = sys.argv[1:] or None
    if only_ids:
        unknown = [sfx_id for sfx_id in only_ids if sfx_id not in SFX_IDS]
        if unknown:
            raise SystemExit(f"unknown sfx id(s): {', '.join(unknown)} (available: {', '.join(SFX_IDS)})")
    generated = generate_sfx(only_ids=only_ids)
    for path in generated:
        size_kb = path.stat().st_size / 1024
        print(f"[generate_sfx] {path.relative_to(EDITOR_ROOT)} ({size_kb:.1f} KB)")
    print(f"[generate_sfx] {len(generated)} 件生成 (コピー先: {REMOTION_SFX_DIR.relative_to(EDITOR_ROOT)})")


if __name__ == "__main__":
    sys.exit(main())
