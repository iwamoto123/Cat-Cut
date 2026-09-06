#!/bin/bash
# フェーズW32: Google Fontsをローカル同梱するためのダウンロードスクリプト。
# Remotionレンダリングがfonts.gstatic.comへのネットワークアクセスに依存していると、
# 回線が不安定な環境で delayRender タイムアウト → 書き出し失敗になる
# (2026-08-22 社員PCで発生: ERR_NETWORK_CHANGED → npm exited with code 1)。
# google/fonts リポジトリ(OFL/Apacheライセンス。商用利用・同梱可)からTTFを取得する。
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="remotion/public/fonts/google"
mkdir -p "$DEST"
BASE="https://raw.githubusercontent.com/google/fonts/main"

# 形式: <保存名>|<リポジトリ内パス>
FILES=(
  "ZenKakuGothicAntique-Regular.ttf|ofl/zenkakugothicantique/ZenKakuGothicAntique-Regular.ttf"
  "ZenKakuGothicAntique-Bold.ttf|ofl/zenkakugothicantique/ZenKakuGothicAntique-Bold.ttf"
  "ZenKakuGothicAntique-Black.ttf|ofl/zenkakugothicantique/ZenKakuGothicAntique-Black.ttf"
  "NotoSansJP-Variable.ttf|ofl/notosansjp/NotoSansJP[wght].ttf"
  "NotoSerifJP-Variable.ttf|ofl/notoserifjp/NotoSerifJP[wght].ttf"
  "ZenMaruGothic-Regular.ttf|ofl/zenmarugothic/ZenMaruGothic-Regular.ttf"
  "ZenMaruGothic-Bold.ttf|ofl/zenmarugothic/ZenMaruGothic-Bold.ttf"
  "ZenMaruGothic-Black.ttf|ofl/zenmarugothic/ZenMaruGothic-Black.ttf"
  "ShipporiMincho-Regular.ttf|ofl/shipporimincho/ShipporiMincho-Regular.ttf"
  "ShipporiMincho-Bold.ttf|ofl/shipporimincho/ShipporiMincho-Bold.ttf"
  "ShipporiMincho-ExtraBold.ttf|ofl/shipporimincho/ShipporiMincho-ExtraBold.ttf"
  "ShipporiMinchoB1-Regular.ttf|ofl/shipporiminchob1/ShipporiMinchoB1-Regular.ttf"
  "ShipporiMinchoB1-Bold.ttf|ofl/shipporiminchob1/ShipporiMinchoB1-Bold.ttf"
  "ShipporiMinchoB1-ExtraBold.ttf|ofl/shipporiminchob1/ShipporiMinchoB1-ExtraBold.ttf"
  "DelaGothicOne-Regular.ttf|ofl/delagothicone/DelaGothicOne-Regular.ttf"
  "YujiSyuku-Regular.ttf|ofl/yujisyuku/YujiSyuku-Regular.ttf"
  "BIZUDPGothic-Regular.ttf|ofl/bizudpgothic/BIZUDPGothic-Regular.ttf"
  "BIZUDPGothic-Bold.ttf|ofl/bizudpgothic/BIZUDPGothic-Bold.ttf"
  "KosugiMaru-Regular.ttf|apache/kosugimaru/KosugiMaru-Regular.ttf"
  "MPLUSRounded1c-Regular.ttf|ofl/mplusrounded1c/MPLUSRounded1c-Regular.ttf"
  "MPLUSRounded1c-Bold.ttf|ofl/mplusrounded1c/MPLUSRounded1c-Bold.ttf"
  "MPLUSRounded1c-ExtraBold.ttf|ofl/mplusrounded1c/MPLUSRounded1c-ExtraBold.ttf"
  "MPLUSRounded1c-Black.ttf|ofl/mplusrounded1c/MPLUSRounded1c-Black.ttf"
  "MochiyPopOne-Regular.ttf|ofl/mochiypopone/MochiyPopOne-Regular.ttf"
  "RocknRollOne-Regular.ttf|ofl/rocknrollone/RocknRollOne-Regular.ttf"
  "KleeOne-Regular.ttf|ofl/kleeone/KleeOne-Regular.ttf"
  "KleeOne-SemiBold.ttf|ofl/kleeone/KleeOne-SemiBold.ttf"
  "HinaMincho-Regular.ttf|ofl/hinamincho/HinaMincho-Regular.ttf"
  "ReggaeOne-Regular.ttf|ofl/reggaeone/ReggaeOne-Regular.ttf"
  "TrainOne-Regular.ttf|ofl/trainone/TrainOne-Regular.ttf"
  "DotGothic16-Regular.ttf|ofl/dotgothic16/DotGothic16-Regular.ttf"
  "BebasNeue-Regular.ttf|ofl/bebasneue/BebasNeue-Regular.ttf"
  "Anton-Regular.ttf|ofl/anton/Anton-Regular.ttf"
  "Caveat-Variable.ttf|ofl/caveat/Caveat[wght].ttf"
)

failed=0
for entry in "${FILES[@]}"; do
  name="${entry%%|*}"
  path="${entry#*|}"
  out="$DEST/$name"
  if [ -s "$out" ]; then
    echo "skip (exists): $name"
    continue
  fi
  # パス内の [wght] をURLエンコード
  url="$BASE/${path//\[wght\]/%5Bwght%5D}"
  echo "download: $name"
  if ! curl -fsSL --retry 3 -o "$out" "$url"; then
    echo "  FAILED: $url" >&2
    rm -f "$out"
    failed=1
  fi
done

echo "---"
# TTF→WOFF2圧縮(180MB→67MB)。Root.tsxは .woff2 を参照するため変換必須。
# fontTools+brotli が必要: python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli
PYBIN="${FONTTOOLS_PYTHON:-python3}"
if "$PYBIN" -c "import fontTools, brotli" 2>/dev/null; then
  "$PYBIN" - <<'PYEOF'
from fontTools.ttLib import TTFont
import glob, os
for path in sorted(glob.glob("remotion/public/fonts/google/*.ttf")):
    out = path[:-4] + ".woff2"
    if os.path.exists(out):
        os.remove(path)
        continue
    f = TTFont(path)
    f.flavor = "woff2"
    f.save(out)
    os.remove(path)
    print(f"woff2: {os.path.basename(out)}")
PYEOF
else
  echo "WARN: fontTools/brotli が見つからないため WOFF2 変換をスキップしました。" >&2
  echo "      FONTTOOLS_PYTHON=<venvのpython> を指定して再実行してください。" >&2
  failed=1
fi
ls -la "$DEST" | tail -n +2 | awk '{printf "%10d  %s\n", $5, $9}'
exit $failed
