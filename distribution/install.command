#!/bin/bash
# Cat-Cut 社内配布用インストーラ（初回インストール・更新 共用）
# 使い方: zipを展開したフォルダ内で、このファイルを右クリック→「開く」
#
# やること:
#   1. Homebrew / ffmpeg / Node.js / Python 3.11 を確認し、無ければインストール
#   2. アプリ本体を ~/CatCut へコピー（編集データ runs/ は保持）
#   3. Python仮想環境と npm 依存をセットアップ
#   4. デスクトップに起動用アイコン「Cat-Cut.command」を作成

set -u

DIST_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$DIST_DIR/app"
TARGET="$HOME/CatCut"
CATCUT_NPM_CACHE="$HOME/Library/Caches/CatCut/npm"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31mエラー: %s\033[0m\n' "$1"; echo "このウィンドウのスクリーンショットを岩本まで送ってください。"; read -r -p "Enterで閉じます..."; exit 1; }

[ -d "$APP_SRC" ] || fail "app フォルダが見つかりません。zipを展開したフォルダの中で実行してください"

# --- 0. ダウングレード防止ガード(2026-09-04) ---
# デスクトップ等に残った古いzipの展開フォルダ(CatCut-setup)から実行すると、
# インストール済みより古いビルドへ巻き戻る事故が実際に起きたため、
# バージョン(YYYYMMDD-で始まるため文字列比較=日付比較)が古い場合は確認を挟む。
NEW_VERSION="$(cat "$APP_SRC/VERSION.txt" 2>/dev/null || echo "")"
OLD_VERSION="$(cat "$TARGET/VERSION.txt" 2>/dev/null || echo "")"
if [ -n "$NEW_VERSION" ] && [ -n "$OLD_VERSION" ] && [ "$NEW_VERSION" \< "$OLD_VERSION" ]; then
  printf '\033[31m警告: これからインストールするビルド(%s)は、\n現在インストール済みの ~/CatCut (%s) より古いものです。\033[0m\n' "$NEW_VERSION" "$OLD_VERSION"
  echo "古いzipの展開フォルダから実行していませんか？"
  echo "NextCloud の CatCut-haifu/README.txt に記載された最新の日付付きzipを展開し直して、その中の install.command を実行してください。"
  read -r -p "それでも古いビルドに戻す場合は yes と入力してください: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { echo "中止しました（何も変更していません）"; read -r -p "Enterで閉じます..."; exit 1; }
fi

bold "=== Cat-Cut インストールを開始します ==="
echo "(初回は環境のダウンロードで20〜40分かかることがあります)"
echo ""

# --- 1. Homebrew ---
if [ -x /opt/homebrew/bin/brew ]; then
  BREW=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
  BREW=/usr/local/bin/brew
else
  bold "[1/5] Homebrew をインストールします（Macのパスワードを聞かれたら入力してください）"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrewのインストールに失敗しました"
  if [ -x /opt/homebrew/bin/brew ]; then BREW=/opt/homebrew/bin/brew; else BREW=/usr/local/bin/brew; fi
fi
eval "$("$BREW" shellenv)"
bold "[1/5] Homebrew OK"

# --- 2. 必要ツール ---
bold "[2/5] ffmpeg / Node.js / Python を確認します"
command -v ffmpeg >/dev/null 2>&1 || "$BREW" install ffmpeg || fail "ffmpegのインストールに失敗しました"
command -v node >/dev/null 2>&1 || "$BREW" install node || fail "Node.jsのインストールに失敗しました"
if command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3.11)"
else
  "$BREW" install python@3.11 || fail "Python 3.11のインストールに失敗しました"
  PYTHON_BIN="$("$BREW" --prefix python@3.11)/bin/python3.11"
fi
[ -x "$PYTHON_BIN" ] || fail "python3.11 が見つかりません"
bold "[2/5] ツール OK (ffmpeg / node / python3.11)"

# --- 3. アプリ本体のコピー（編集データ・ローカル設定・依存環境は保持） ---
bold "[3/5] アプリ本体を $TARGET へコピーします"
mkdir -p "$TARGET"
rsync -a --delete \
  --exclude "runs/" \
  --exclude "learning_data/" \
  --exclude ".env" \
  --exclude ".venv/" \
  --exclude "node_modules/" \
  "$APP_SRC/" "$TARGET/" || fail "ファイルのコピーに失敗しました"
mkdir -p "$TARGET/runs"
bold "[3/5] コピー OK（編集データは保持されています）"

# --- 4. 依存セットアップ ---
bold "[4/5] Python環境と依存パッケージをセットアップします（時間がかかります）"
if [ ! -x "$TARGET/.venv/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$TARGET/.venv" || fail "Python仮想環境の作成に失敗しました"
fi
"$TARGET/.venv/bin/pip" install --upgrade pip -q || true
"$TARGET/.venv/bin/pip" install -r "$TARGET/python/requirements.txt" || fail "Pythonパッケージのインストールに失敗しました"
# 過去に別権限で作られた ~/.npm があっても、現在のユーザーの専用キャッシュで導入する。
mkdir -p "$CATCUT_NPM_CACHE" || fail "Cat-Cut用のnpmキャッシュを作成できません: $CATCUT_NPM_CACHE"
(cd "$TARGET/desktop" && npm install --cache "$CATCUT_NPM_CACHE" --no-audit --no-fund) || fail "アプリ依存(desktop)のインストールに失敗しました"
# npmがライフサイクルスクリプトを省略しても、Electron本体の欠落を見逃さない。
bold "[4/5] Electron本体を確認します（初回はダウンロードします）"
(
  cd "$TARGET/desktop" &&
  env -u ELECTRON_SKIP_BINARY_DOWNLOAD -u ELECTRON_OVERRIDE_DIST_PATH node node_modules/electron/install.js &&
  env -u ELECTRON_OVERRIDE_DIST_PATH ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e '
    const expected = require("./node_modules/electron/package.json").version;
    if (process.versions.electron !== expected) {
      console.error("Electron本体のバージョンが一致しません", process.versions.electron, expected);
      process.exit(1);
    }
    console.log("Electron本体の起動確認 OK: " + process.versions.electron);
  '
) || fail "Electron本体の取得・起動確認に失敗しました。直前のエラーをご確認ください"
(cd "$TARGET/remotion" && npm install --cache "$CATCUT_NPM_CACHE" --no-audit --no-fund) || fail "アプリ依存(remotion)のインストールに失敗しました"
bold "[4/5] 依存セットアップ OK"

# --- 5. 起動アイコン ---
bold "[5/5] デスクトップに起動アイコンを作成します"
LAUNCHER="$HOME/Desktop/Cat-Cut.command"
cat > "$LAUNCHER" <<'EOF'
#!/bin/bash
# Cat-Cut 起動（このウィンドウはアプリ使用中は閉じないでください）
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
cd "$HOME/CatCut/desktop" || { echo "~/CatCut が見つかりません。install.command を先に実行してください"; read -r; exit 1; }
if [ -f ../VERSION.txt ]; then echo "Cat-Cut ビルド: $(cat ../VERSION.txt)"; fi
env -u ELECTRON_OVERRIDE_DIST_PATH npm --cache "$HOME/Library/Caches/CatCut/npm" run dev
EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "Cat-Cutがエラーで終了しました（終了コード: ${EXIT_CODE}）。"
  echo "このウィンドウのエラー内容を岩本まで送ってください。"
  read -r -p "Enterで閉じます..."
fi
exit "$EXIT_CODE"
EOF
chmod +x "$LAUNCHER"
bold "[5/5] 起動アイコン OK"

if [ -f "$TARGET/VERSION.txt" ]; then
  echo "ビルド: $(cat "$TARGET/VERSION.txt")"
fi

echo ""
bold "=== インストール完了です ==="
echo "デスクトップの「Cat-Cut.command」をダブルクリックすると起動します。"
echo "初回起動時にAPIキーの入力画面が出ます（キーは岩本から受け取ってください）。"
read -r -p "Enterで閉じます..."
