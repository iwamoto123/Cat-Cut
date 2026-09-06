#!/bin/bash
# 2026-08-22: W29修正(step07のword IDリテイク解決バグ修正)反映のため、
# 既存run(20260822_120000)の step07 以降だけを再実行して再レンダリングする。
# (step05のAIリテイク検出結果 retakes.json はそのまま再利用する)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PY="$ROOT/.venv/bin/python"
APPSUP="/Users/takeshi/Library/Application Support/cat-cut-desktop"
VIDEO="/Users/takeshi/Downloads/メタ広告 総体後 一人語りクリエイティブ.MP4"
RUN="runs/20260822_120000_メタ広告_総体後_一人語り"
OUT="/Users/takeshi/Downloads/メタ広告総体後_一人語り_CatCut編集済み.mp4"

set -a; source .env; set +a
export PYTHONUNBUFFERED=1

echo "=== step07 cut proposal (W29再実行) ==="
"$PY" python/step07_cut_proposal.py --stt "$RUN/step02b_transcript_correct/stt_corrected.json" \
  --fillers "$RUN/step04_filler_detect/fillers.json" \
  --retakes "$RUN/step05_retake_detect/retakes.json" \
  --scenes "$RUN/step06_scene_structure/scenes.json" \
  --vad "$RUN/step03_vad/vad_result.json" \
  --project templates/vertical.yaml --output "$RUN/step07_cut_proposal"

echo "=== step06c direction (AI演出決定) ==="
"$PY" python/step06c_direction.py "$RUN" --proposal "$RUN/step07_cut_proposal/cut_proposal.json" \
  --stt "$RUN/step02b_transcript_correct/stt_corrected.json" \
  --title "メタ広告 総体後 一人語りクリエイティブ" --project templates/vertical.yaml \
  --edit-examples "$APPSUP/telop_edit_examples.json"

echo "=== step08 composition ==="
"$PY" python/step08_composition.py --proposal "$RUN/step07_cut_proposal/cut_proposal.json" \
  --stt "$RUN/step02b_transcript_correct/stt_corrected.json" \
  --video "$VIDEO" --output "$RUN/step08_composition" \
  --project templates/vertical.yaml --review "$RUN/step06_review/review.json" \
  --type-mapping "$APPSUP/telop_type_mapping.json" --orientation vertical

echo "=== telop extract / review ==="
"$PY" python/tools/extract_telop.py "$RUN"
"$PY" python/tools/review_telop.py "$RUN" --dictionary templates/domain_dictionary.yaml

echo "=== font directives / apply telop ==="
"$PY" python/tools/apply_font_directives.py "$RUN" --apply-composition
"$PY" python/tools/apply_telop.py "$RUN"
"$PY" python/tools/apply_font_directives.py "$RUN" --apply-composition

echo "=== render (Remotion 720x1280) ==="
cd remotion
npm run render:cli -- --composition "../$RUN/step08_composition/composition.json" \
  --output "$OUT" --width 720 --height 1280 --concurrency 4 \
  --hardware-acceleration if-possible --video-bitrate 10000k
cd ..

echo "=== DONE ==="
echo "output: $OUT"
