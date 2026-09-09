#!/bin/bash
# Cat-Cut 社内配布zipの作成（岩本さんのMacで実行する）
# 使い方: cd editor && bash distribution/make_package.sh
# 出力: ~/Desktop/CatCut-haifu-YYYYMMDD-HHMMSS.zip（日本時間）
#       + NextCloud共有フォルダへ同じ日時付きファイル名で自動公開
#         公開先は環境変数 CATCUT_PUBLISH_DIR で変更可

set -eu

EDITOR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(TZ=Asia/Tokyo date +%Y%m%d-%H%M%S)"
PACKAGE_NAME="CatCut-haifu-$STAMP.zip"
SETUP_NAME="CatCut-setup-$STAMP"
OUT="$HOME/Desktop/$PACKAGE_NAME"
PUBLISH_DIR="${CATCUT_PUBLISH_DIR:-$HOME/Desktop/NextCloud/CatCut-haifu}"
WORK_ROOT=""
ARCHIVE_DIR=""
PUBLISH_TEMP=""
refuse_existing_archive() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    echo "エラー: 同名の配布zipが既にあります。上書きせず中止します: $1" >&2
    exit 1
  fi
}
move_new_archive() {
  refuse_existing_archive "$2"
  # -n also prevents a concurrent build from replacing the destination after the check.
  mv -n "$1" "$2"
  if [ -e "$1" ]; then
    echo "エラー: 同名の配布zipが作成されました。上書きせず中止します: $2" >&2
    exit 1
  fi
}
cleanup() {
  # These paths are created by this process; never remove the published/archive outputs.
  [ -z "$WORK_ROOT" ] || rm -rf "$WORK_ROOT"
  [ -z "$ARCHIVE_DIR" ] || rm -rf "$ARCHIVE_DIR"
  [ -z "$PUBLISH_TEMP" ] || rm -f "$PUBLISH_TEMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
refuse_existing_archive "$OUT"
refuse_existing_archive "$PUBLISH_DIR/$PACKAGE_NAME"
WORK_ROOT="$(mktemp -d)"
WORK="$WORK_ROOT/$SETUP_NAME"
mkdir -p "$(dirname "$OUT")"
# A new archive on the destination filesystem prevents stale entries and permits an atomic move.
ARCHIVE_DIR="$(mktemp -d "$(dirname "$OUT")/.CatCut-package.XXXXXX")"
TEMP_ARCHIVE="$ARCHIVE_DIR/CatCut-haifu.zip"

echo "配布パッケージを作成します: $OUT"
mkdir -p "$WORK/app"

# アプリ本体（重い生成物・ローカルデータ・秘密情報は除外）
rsync -a \
  --exclude ".git/" \
  --exclude "runs/" \
  --exclude "learning_data/" \
  --exclude ".venv/" \
  --exclude ".node-*/" \
  --exclude "node_modules/" \
  --exclude "__pycache__/" \
  --exclude "*.pyc" \
  --exclude ".pytest_cache/" \
  --exclude ".claude/" \
  --exclude ".DS_Store" \
  --exclude ".env" \
  --exclude "billing/data/" \
  --exclude "templates/samples/out/" \
  --exclude "distribution/" \
  --exclude "remotion/build/" \
  --exclude "remotion/public/segments" \
  --exclude "remotion/public/composition*.json" \
  --exclude "desktop/dist/" \
  --exclude "node_modules/.cache/" \
  "$EDITOR_DIR/" "$WORK/app/"

# インストーラと手順書を同梱
cp "$EDITOR_DIR/distribution/install.command" "$WORK/"
cp "$EDITOR_DIR/distribution/check_network.command" "$WORK/"
cp "$EDITOR_DIR/distribution/VERSION" "$WORK/app/VERSION.txt"
cp "$EDITOR_DIR/distribution/SETUP_GUIDE.md" "$WORK/はじめにお読みください.md"
NOTES_GUIDANCE=""
if [ -f "$EDITOR_DIR/distribution/RELEASE_NOTES.md" ]; then
  cp "$EDITOR_DIR/distribution/RELEASE_NOTES.md" "$WORK/社員用更新内容.md"
  NOTES_GUIDANCE="今回の更新内容: zip内の「社員用更新内容.md」を参照してください。"
fi
chmod +x "$WORK/install.command" "$WORK/check_network.command"

# Studio's default preview must not contain the developer's source paths or transcripts.
mkdir -p "$WORK/app/remotion/public"
cat > "$WORK/app/remotion/public/composition-v2.json" <<'EOF'
{"timeline":{"version":"1.0.0","total_duration_ms":1000,"video_fit":"cover","fps":30,"cuts":[]},"voice_data":{"version":"1.0.0","cuts":[]},"meta":{"display_width":1280,"display_height":720}}
EOF

# .env が紛れ込んでいないか最終チェック
if find "$WORK" -name ".env" | grep -q .; then
  echo "エラー: .env が含まれています。中止します"; exit 1
fi

# -y: シンボリックリンクを実体化せずリンクのまま格納（runへのリンク等の巻き込み防止）
(cd "$WORK_ROOT" && zip -ryq "$TEMP_ARCHIVE" "$(basename "$WORK")")
unzip -tq "$TEMP_ARCHIVE"
move_new_archive "$TEMP_ARCHIVE" "$OUT"
echo "完了: $OUT"
du -sh "$OUT"

# NextCloud共有フォルダへ最新版を公開（社員は常に同じ場所から最新版を取得できる）
if [ -d "$(dirname "$PUBLISH_DIR")" ]; then
  mkdir -p "$PUBLISH_DIR"
  # 一時ファイルに書いてから同名zipを上書きせず公開（同期中の不完全なzip配信を防ぐ）
  refuse_existing_archive "$PUBLISH_DIR/$PACKAGE_NAME"
  PUBLISH_TEMP="$(mktemp "$PUBLISH_DIR/.${PACKAGE_NAME}.XXXXXX")"
  cp "$OUT" "$PUBLISH_TEMP"
  move_new_archive "$PUBLISH_TEMP" "$PUBLISH_DIR/$PACKAGE_NAME"
  PUBLISH_TEMP=""
  cp "$EDITOR_DIR/distribution/VERSION" "$PUBLISH_DIR/VERSION.txt"
  cat > "$PUBLISH_DIR/README.txt" <<EOF
Cat-Cut 最新版の配布フォルダ

【インストール・更新の手順】
1. $PACKAGE_NAME をダウンロードしてダブルクリックで展開する
2. 展開された $SETUP_NAME フォルダの中の install.command を右クリック →「開く」
3. 画面の指示に従って完了を待つ（更新の場合も同じ手順。編集中のデータは消えません）
4. デスクトップの Cat-Cut.command から起動する

「適切なアクセス権限がないために実行できません」と出る場合は、
ターミナルで bash と半角スペースを入力し、展開した install.command を
ウィンドウへドラッグして Enter を押してください。

【注意】
- zipと展開フォルダの名前には配布日時（YYYYMMDD-HHMMSS、日本時間）が入っています。
  最新版は上記のファイルです。同名のzipは上書きしません。
- 必ず「いま展開したフォルダ」の install.command を実行してください。
  デスクトップやダウンロードに残っている古い CatCut-setup フォルダから実行すると
  古いバージョンに巻き戻ります（古い展開フォルダは削除を推奨）
- いま入っているバージョンは ~/CatCut/VERSION.txt で確認できます

現在のバージョン: VERSION.txt を参照（配布日時: ${STAMP}、日本時間）
$NOTES_GUIDANCE
EOF
  echo "NextCloudへ公開しました: $PUBLISH_DIR/${PACKAGE_NAME}（バージョン: $(cat "$EDITOR_DIR/distribution/VERSION")）"
else
  echo "注意: NextCloudフォルダが見つからないため公開をスキップしました: $(dirname "$PUBLISH_DIR")"
  echo "      公開先を変える場合は CATCUT_PUBLISH_DIR を設定してください"
fi
