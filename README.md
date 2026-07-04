# Cat-Cut Editor（video-podcast SaaS 用）

Desktop の Cat-Cut を `video-podcast-saas/editor/` に統合した編集エンジンです。

## 役割分担

| 用途 | ツール |
|------|--------|
| 社内レビュー（テロップ・フォント調整） | Cat-Cut デスクトップアプリ (`desktop/`) |
| SaaS バッチ（無人処理） | `python/run_headless_pipeline.py` |
| 配信連携 | `python/tools/build_delivery_manifest.py` → Ayrshare |

選定理由: [outputs/2026-07-02_editor-platform-decision.md](../outputs/2026-07-02_editor-platform-decision.md)

## セットアップ

```bash
cd video-podcast-saas/editor

python3.11 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
pip install torch torchaudio --extra-index-url https://download.pytorch.org/whl/cpu

cd remotion && npm install && cd ..

cp .env.example .env
# ELEVEN_API_KEY を設定
```

## デスクトップアプリ（レビュー用）

```bash
cd desktop
nodenv exec npm run dev
```

**重要:** `http://127.0.0.1:5174` をブラウザで開かないでください。Vite は開発用サーバーで、UI は **Electron の別ウィンドウ** で開きます（`npm run dev` 実行後、数秒で自動起動）。

真っ白な画面になる場合:
1. VS Code の Simple Browser / Chrome で 5174 を開いていないか確認 → タブを閉じる
2. Dock に「Electron」ウィンドウがないか確認
3. 既存プロセスを止めて再起動:
   ```bash
   lsof -ti :5174 | xargs kill -9 2>/dev/null; nodenv exec npm run dev
   ```

## ヘッドレスパイプライン（SaaS用）

```bash
# 解析まで（レビュー前で停止 → Cat-Cut UIで確認）
.venv/bin/python python/run_headless_pipeline.py --video /path/to/zoom.mp4

# フル自動（レンダリング + delivery_manifest まで）
.venv/bin/python python/run_headless_pipeline.py \
  --video /path/to/zoom.mp4 \
  --auto-export \
  --title "2026-07 社長インタビュー" \
  --customer-id customer-001
```

60分超の ElevenLabs STT は `step02_stt.py` が自動的に 10 分チャンクに分割します（rough-cut から移植）。

## 出力

```
runs/{run_name}/
├── step08_composition/composition.json
├── telop.txt
├── output/final.mp4
└── delivery_manifest.json   # Ayrshare 連携用
```

## テスト

```bash
.venv/bin/python -m unittest discover -s python/tests -v
```
