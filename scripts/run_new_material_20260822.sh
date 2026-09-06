#!/bin/bash
# 2026-08-22: 新素材「メタ広告 総体後 一人語りクリエイティブ.MP4」を開発版パイプラインで
# 0から処理する。アプリ(cat-cut-desktop)が実行するのと同じステップ列・引数を
# runs/20260821_140852_EC1646E2.../pipeline.log から再現している(step06dのみアプリ専用のためスキップ)。
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

mkdir -p "$RUN"

echo "=== step01 preprocess ==="
"$PY" python/step01_preprocess.py --video "$VIDEO" --output "$RUN/step01_preprocess"

echo "=== step02 STT (elevenlabs) ==="
"$PY" python/step02_stt.py --provider elevenlabs --language ja \
  --audio "$RUN/step01_preprocess/audio.wav" --output "$RUN/step02_stt"

echo "=== step02b transcript correct ==="
"$PY" python/step02b_transcript_correct.py --stt "$RUN/step02_stt/stt_result.json" \
  --dictionary templates/domain_dictionary.yaml --project templates/vertical.yaml \
  --output "$RUN/step02b_transcript_correct"

echo "=== step03 VAD ==="
"$PY" python/step03_vad.py --audio "$RUN/step01_preprocess/audio.wav" \
  --stt "$RUN/step02b_transcript_correct/stt_corrected.json" --output "$RUN/step03_vad"

echo "=== step04 filler detect ==="
"$PY" python/step04_filler_detect.py --stt "$RUN/step02b_transcript_correct/stt_corrected.json" \
  --vad "$RUN/step03_vad/vad_result.json" --output "$RUN/step04_filler_detect"

echo "=== step05 AI retake detect ==="
"$PY" python/step05_ai_retake.py "$RUN" --stt "$RUN/step02b_transcript_correct/stt_corrected.json" \
  --fillers "$RUN/step04_filler_detect/fillers.json" \
  --retakes-output "$RUN/step05_retake_detect/retakes.json" \
  --review-output "$RUN/step05_ai_retake/ai_review.json" \
  --correction-history "$APPSUP/correction_history.effective.json"

echo "=== step05b retranscribe weak spans ==="
"$PY" python/step05b_retranscribe.py "$RUN" --review "$RUN/step05_ai_retake/ai_review.json" \
  --stt "$RUN/step02b_transcript_correct/stt_corrected.json" \
  --audio "$RUN/step01_preprocess/audio.wav" \
  --output "$RUN/step05b_retranscribe/retranscribe.json" --stt-provider elevenlabs

echo "=== placeholders (scene structure / review) ==="
mkdir -p "$RUN/step06_scene_structure" "$RUN/step06_review"
[ -f "$RUN/step06_scene_structure/scenes.json" ] || echo '{"scenes": []}' > "$RUN/step06_scene_structure/scenes.json"
[ -f "$RUN/step06_review/review.json" ] || echo '{"corrections": {}, "quality_notes": ["headless 2026-08-22"]}' > "$RUN/step06_review/review.json"

echo "=== step07 cut proposal ==="
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
[ -f "$RUN/font_directives.md" ] || cp templates/font_directives_template.md "$RUN/font_directives.md" 2>/dev/null || true
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
echo "run: $ROOT/$RUN"
echo "output: $OUT"
