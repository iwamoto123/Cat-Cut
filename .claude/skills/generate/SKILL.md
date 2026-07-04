# Skill: generate (Cat-Cut)

トーク動画の編集自動化。無音カット、フィラー除去、リテイク検出、誤字脱字修正、テロップ付与を一気通貫で実行する。

定型フロー: STT → カット提案 → セグメント生成 → **テロップ抽出→AI校正→ユーザーレビュー** → プレビュー → レンダリング

## 使い方

```
/generate {動画ファイルパス} [--project {project.yamlパス}]
```

## 前提条件

- Python 3.11+ (`.venv/bin/python` 推奨)
- FFmpeg (システムインストール)
- Node.js 22.12+
- ELEVEN_API_KEY 環境変数
- `python/requirements.txt` インストール済み
- `remotion/node_modules` インストール済み

## 実行手順

### 変数定義

```
{app_dir} = Cat-Cut ディレクトリの絶対パス
{run}      = run名 (例: 20260324_test)
{動画パス}  = 入力動画の絶対パス
{project}  = プロジェクト設定パス (省略時は自動判定で vertical.yaml or horizontal.yaml)
```

### 準備

1. run名を決定 (例: `20260324_test`)
2. `runs/{run}/` ディレクトリを作成

### Step 1: preprocess (Python)

```bash
cd {app_dir}/python
.venv/bin/python step01_preprocess.py \
  --video {動画パス} \
  --output ../runs/{run}/step01_preprocess
```

出力確認:
- `preprocess.json` の `orientation` フィールドを確認 (vertical or horizontal)
- この値に応じて以降のステップで使う project 設定が決まる
- project 未指定時: `templates/{orientation}.yaml` を自動使用

### Step 2: stt (Python)

```bash
.venv/bin/python step02_stt.py \
  --audio ../runs/{run}/step01_preprocess/audio.wav \
  --output ../runs/{run}/step02_stt
```

出力確認: `stt_result.json` の sentences 数と raw_text をユーザーに報告

### Step 2b: transcript_correct (Python)

STTの生データは保持し、辞書ベースの補正済みコピーを作る。Macアプリ連携を見据え、
`stt_corrected.json`、`transcript_patch.json`、`app_report.json` を分けて保存する。

```bash
.venv/bin/python step02b_transcript_correct.py \
  --stt ../runs/{run}/step02_stt/stt_result.json \
  --dictionary ../templates/domain_dictionary.yaml \
  --project ../templates/{orientation}.yaml \
  --output ../runs/{run}/step02b_transcript_correct
```

以降の `--stt` には原則として
`../runs/{run}/step02b_transcript_correct/stt_corrected.json` を渡す。

### Step 3: vad (Python)

```bash
.venv/bin/python step03_vad.py \
  --audio ../runs/{run}/step01_preprocess/audio.wav \
  --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \
  --output ../runs/{run}/step03_vad
```

出力確認: 検出された silence_regions 数を報告

### Step 4: filler_detect (Python)

```bash
.venv/bin/python step04_filler_detect.py \
  --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \
  --vad ../runs/{run}/step03_vad/vad_result.json \
  --output ../runs/{run}/step04_filler_detect
```

出力確認: フィラー数と種類を報告

### Step 4b: filler_review (LLM補助)

Step 4 のパターンマッチ結果を確認・修正する。

1. `runs/{run}/step02b_transcript_correct/stt_corrected.json` を Read で読む
2. `runs/{run}/step04_filler_detect/fillers.json` を Read で読む
3. STT テキストを通し読みしながら以下を実施:
   - 検出されたフィラーが本当にフィラーか確認 (誤検出の除外)
   - パターンで検出できなかったフィラーの追加検出
   - 特に「あの」「その」「こう」等の文脈依存フィラーを重点確認
4. 修正が必要な場合、`fillers.json` を更新して Write で上書き保存
5. 修正内容をユーザーに報告

### Step 5: retake_detect (LLM補助)

1. `runs/{run}/step02b_transcript_correct/stt_corrected.json` を Read で読む
2. sentences の内容を確認し、言い直しを判断 (retake-detect skill の基準)
3. `runs/{run}/step05_retake_detect/` ディレクトリを作成
4. 結果を `runs/{run}/step05_retake_detect/retakes.json` に Write で保存

### Step 6: review (LLM補助)

1. `runs/{run}/step02b_transcript_correct/stt_corrected.json` を Read で読む
2. テキスト全体を通し読みし、以下を実施:
   - 誤字脱字の特定 (STT誤認識、固有名詞の間違い等)
   - カット後の流れの品質チェック
3. `runs/{run}/step06_review/` ディレクトリを作成
4. 結果を `runs/{run}/step06_review/review.json` に Write で保存:
   ```json
   {
     "corrections": {"間違い": "正しい"},
     "quality_notes": ["全体的に問題なし"]
   }
   ```
5. corrections は Step 8 で `--review` 引数経由でテロップに自動反映される

### Step 7: cut_proposal (Python)

scenes.json が必要。リテイク検出結果がなければ空で作成。

```bash
# scenes.json が未作成の場合、空で作成
mkdir -p ../runs/{run}/step06_scene_structure
echo '{"scenes": []}' > ../runs/{run}/step06_scene_structure/scenes.json

.venv/bin/python step07_cut_proposal.py \
  --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \
  --fillers ../runs/{run}/step04_filler_detect/fillers.json \
  --retakes ../runs/{run}/step05_retake_detect/retakes.json \
  --scenes ../runs/{run}/step06_scene_structure/scenes.json \
  --vad ../runs/{run}/step03_vad/vad_result.json \
  --project ../templates/{orientation}.yaml \
  --output ../runs/{run}/step07_cut_proposal
```

`--project` を渡すと yaml の `edit.max_gap_ms` `edit.segment_padding_ms` で無音カット強度を制御。
`--vad` を渡すと VAD speech_segments で word boundaries をクランプ (ElevenLabs の timestamp padding 対策、長い無音を確実にカット)。

出力確認: keep_segments 数、削減率をユーザーに報告し確認を取る

### Step 8: composition (Python)

```bash
.venv/bin/python step08_composition.py \
  --proposal ../runs/{run}/step07_cut_proposal/cut_proposal.json \
  --stt ../runs/{run}/step02b_transcript_correct/stt_corrected.json \
  --video {動画パス} \
  --output ../runs/{run}/step08_composition \
  --project ../templates/{orientation}.yaml \
  --review ../runs/{run}/step06_review/review.json
```

`{orientation}` は Step 1 で判定した値 (vertical or horizontal)。
ユーザーが --project で別の yaml を指定した場合はそちらを使う。

出力確認:
- `composition.json` 生成確認
- `segments/` にカットごとのMP4が生成されたか確認
- カット数とテロップページ数を報告

### Step 8.5: テロップ校正 (定型ワークフロー)

プレビュー前にテロップ本文をテキストファイルとして抽出し、AIで自動校正してからユーザーレビューに出す。

#### Step 8.5a: telop.txt 抽出

```bash
.venv/bin/python tools/extract_telop.py ../runs/{run}
```

出力: `runs/{run}/telop.txt` (ページIDヘッダ + 本文 + 空行で構成)

#### Step 8.5b: AI自動校正 (サブエージェント)

`general-purpose` サブエージェントで `telop.txt` を校正させる。バックアップを `telop.txt.bak` として保存してから実行。

エージェントには **必ず以下を読み込ませる**:
- `.claude/skills/generate/telop_correction_rules.md` (校正ルール集・固有名詞辞書・ユーザー追記ルール)

校正ルールはこのファイルが Single Source of Truth。SKILL.md にハードコードしない。

ID行 (`# cut_XXX_pYY`) と空行構造は絶対変更しないことを必ず指示する。

#### Step 8.5c: ユーザーレビュー (定型)

校正完了したら **必ず** ユーザーに `runs/{run}/telop.txt` を提示し、レビュー・修正依頼を受ける:
- ファイルパスを伝え、IDEで開くよう促す
- 「修正したい箇所があれば指摘してください。OKならプレビューに進みます」と案内
- ユーザーが追加修正を指示した場合、その通りに編集
- ヘッダごと削除すれば該当ページがcomposition.jsonからも削除される(本文を空にしても同じ効果)

##### ルール学習ループ (重要)

ユーザーが指示した修正は **次回以降の自動校正にも反映する** ため、`telop_correction_rules.md` に追記する:

1. ユーザーから「○○を△△に直して」「××は××にして」等の指示を受けた直後に判断:
   - **ジャンル横断のパターン** (固有名詞・誤認識・口癖) → 「動画ジャンル別ガイド」または「一般ルール」セクションに追記
   - **単発・特殊** → 「ユーザー追記ルール」に日付付きで追記
2. 追記後、ユーザーに「ルールに反映しました: ○○」と簡潔に報告
3. 同じパターンが複数案件で出てきたら、専用セクションに昇格させる

ユーザーがファイル直接編集で telop.txt を修正した場合も、終了時に `diff telop.txt.bak telop.txt` で差分を確認し、汎用化できそうな修正パターンを抽出してルールに追記する。

#### Step 8.5c-2: テロップスタイル割り当て (任意)

ジャンル固有のテロップ演出が欲しい場合に、自然言語の指示書で AI に style 割り当てさせる。

1. `runs/{run}/style_directives.md` を作成 (テンプレ: `templates/style_directives_template.md` をコピー or 編集)
2. `general-purpose` サブエージェントを起動し、指示書 + telop.txt を読ませて各ページに `@style=<preset>` を付与
3. ID 行と空行は厳守 (本文も改変禁止と明示)
4. preset は `templates/telop_presets.yaml` 定義 (default/highlight/simple/warning/question)
5. 同じトピックに連続して別 style を当てない (視聴者が疲れる) ことをエージェントに指示

#### Step 8.5d: composition.json に反映

ユーザー承認後にのみ実行:

```bash
.venv/bin/python tools/apply_telop.py ../runs/{run}
```

主ファイル + remotion/public/composition-v2.json の両方が同期される。

**重要(再発防止)**: composition.json にはテロップ情報が **2箇所** ある:
- `timeline.cuts[].telop.pages[].lines` (ページID・編集用)
- `voice_data.cuts[].telops[].segments[].text` (**Telop コンポーネントが実際に描画するソース**)

`apply_telop.py` は両方を同期する実装になっている。新規にテロップ書き換えツールを作る場合も、**必ず voice_data 側も更新する**こと。timeline 側だけ書き換えても描画には反映されない。

レンダリング前に `composition.json` を直接編集する場合は両方の整合を取る必要がある。

### Step 9: プレビュー (Remotion Studio)

**本番レンダリングの前に必ずプレビューで確認する。**

```bash
cd {app_dir}/remotion
npx remotion studio
```

ユーザーに以下を案内:
- ブラウザで http://localhost:3000 を開く
- composition.json を読み込んでプレビュー
- テロップ表示タイミング、見た目、黒フラッシュの有無を確認
- 問題があれば修正してから Step 10 に進む

### Step 10: render (Remotion CLI)

プレビュー確認後にのみ実行。

```bash
cd {app_dir}/remotion
npx tsx scripts/render-cli.ts \
  --composition ../runs/{run}/step08_composition/composition.json \
  --output ../runs/{run}/output/final.mp4 \
  --width {display_width} --height {display_height} \
  --concurrency 4
```

`{display_width}` `{display_height}` は composition.json の meta から取得。
concurrency は 4 固定 (8以上だと OffthreadVideo タイムアウト)。

### 完了報告

ユーザーに以下を報告:
- 元動画: {duration}秒 ({orientation})
- 編集後: {edited_duration}秒 (削減率 {reduction}%)
- 検出: フィラー {n}個、リテイク {n}個、無音 {n}箇所
- カット: {n}個、テロップページ: {n}ページ
- 出力: `{出力パス}`
