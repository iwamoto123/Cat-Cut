# Skill: setup

初回セットアップを案内する。ユーザーが初めてこのスキルを使う時に実行。

## 実行条件

以下のいずれかが未完了の場合に実行:
- `.venv/` が存在しない
- `remotion/node_modules/` が存在しない
- `.env` が存在しない

## 手順

### Step 1: 環境確認

以下がインストールされているか確認:

```bash
python3.11 --version   # 3.11 以上
ffmpeg -version         # 必須
node --version          # 22.12 以上
```

未インストールの場合、案内:
- **Python 3.11**: `brew install python@3.11`
- **FFmpeg**: `brew install ffmpeg`
- **Node.js**: `nodenv install 22.12.0` または https://nodejs.org/

### Step 2: ElevenLabs API キー取得

ElevenLabs の Speech-to-Text (文字起こし) API を使用する。API キーが必要。

ユーザーに以下を案内:

1. https://elevenlabs.io/ にアクセスしてアカウント作成 (無料プランでOK)
2. ログイン後、左サイドバーの「Developers」をクリック
3. 「API Keys」タブを開く
4. 「Create API Key」ボタンでキーを生成
5. 表示されたキーをコピー (一度しか表示されない)

無料プランで月20分の音声文字起こしが可能。
10分の動画1本で約10分消費する (動画の長さ分)。
有料プラン (Starter $5/月~) でより多くの分数が使える。

### Step 3: Python 環境セットアップ

```bash
cd {Cat-Cut ディレクトリ}
python3.11 -m venv .venv

# PyTorch CPU版を先に入れる
# *** 必ず --extra-index-url を付ける。付けないと CUDA 版 (10GB) がインストールされる ***
.venv/bin/pip install torch torchaudio --extra-index-url https://download.pytorch.org/whl/cpu

# 残りのパッケージ (httpx, budoux, pyyaml, kanjize, numpy, silero-vad, torchcodec)
.venv/bin/pip install -r python/requirements.txt
```

PyTorch CPU版は約200MB、torchcodec/silero-vad などを含めて初回は2〜5分かかる。

### Step 4: Remotion セットアップ

```bash
cd remotion
npm install
cd ..
```

### Step 5: .env 設定

```bash
cp .env.example .env
```

.env を開いて ElevenLabs API キーを設定:
```
ELEVEN_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxx
```

### Step 6: 動作確認

Silero VAD のロードを確認:

```bash
.venv/bin/python -c "from silero_vad import load_silero_vad; load_silero_vad(); print('Silero VAD OK')"
```

「Silero VAD OK」と表示されれば成功。

注: 旧バージョンは `torch.hub.load("snakers4/silero-vad")` で GitHub からモデルを取得していたが、社内ネットワーク等で GitHub に到達できない環境でも動くように pip 版 (`silero-vad` パッケージ) で動くようにしている。`step03_vad.py` は両方に対応済み。

### 完了メッセージ

セットアップ完了後、ユーザーに以下を伝える:

```
セットアップ完了しました。

使い方:
  /generate {動画ファイルパス}

例:
  /generate ~/Desktop/talk_video.mp4

縦型 (TikTok/Shorts) も横型 (YouTube) も自動判定で対応します。
```
