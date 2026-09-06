#!/bin/bash
# Cat-Cut 社内配布zipの作成（岩本さんのMacで実行する）
# 使い方: cd editor && bash distribution/make_package.sh
# 出力: ~/Desktop/CatCut-配布用-YYYYMMDD.zip
#       + NextCloud共有フォルダへ最新版を自動公開（CatCut-latest.zip）
#         公開先は環境変数 CATCUT_PUBLISH_DIR で変更可

set -eu

EDITOR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d)"
WORK="$(mktemp -d)/CatCut-setup"
OUT="$HOME/Desktop/CatCut-haifu-$STAMP.zip"
PUBLISH_DIR="${CATCUT_PUBLISH_DIR:-$HOME/Desktop/NextCloud/CatCut-haifu}"

echo "配布パッケージを作成します: $OUT"
mkdir -p "$WORK/app"

# アプリ本体（重い生成物・ローカルデータ・秘密情報は除外）
rsync -a \
  --exclude ".git/" \
  --exclude "runs/" \
  --exclude "learning_data/" \
  --exclude ".venv/" \
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
  --exclude "desktop/dist/" \
  --exclude "node_modules/.cache/" \
  "$EDITOR_DIR/" "$WORK/app/"

# インストーラと手順書を同梱
cp "$EDITOR_DIR/distribution/install.command" "$WORK/"
cp "$EDITOR_DIR/distribution/check_network.command" "$WORK/"
cp "$EDITOR_DIR/distribution/VERSION" "$WORK/app/VERSION.txt"
cp "$EDITOR_DIR/distribution/SETUP_GUIDE.md" "$WORK/はじめにお読みください.md"
chmod +x "$WORK/install.command" "$WORK/check_network.command"

# .env が紛れ込んでいないか最終チェック
if find "$WORK" -name ".env" | grep -q .; then
  echo "エラー: .env が含まれています。中止します"; exit 1
fi

# -y: シンボリックリンクを実体化せずリンクのまま格納（runへのリンク等の巻き込み防止）
(cd "$(dirname "$WORK")" && zip -ryq "$OUT" "$(basename "$WORK")")
rm -rf "$(dirname "$WORK")"
echo "完了: $OUT"
du -sh "$OUT"

# NextCloud共有フォルダへ最新版を公開（社員は常に同じ場所から最新版を取得できる）
if [ -d "$(dirname "$PUBLISH_DIR")" ]; then
  mkdir -p "$PUBLISH_DIR"
  # 一時ファイルに書いてからmvで置き換え（Nextcloud同期中の中途半端なzip配信を防ぐ）
  cp "$OUT" "$PUBLISH_DIR/.CatCut-latest.zip.tmp"
  mv "$PUBLISH_DIR/.CatCut-latest.zip.tmp" "$PUBLISH_DIR/CatCut-latest.zip"
  cp "$EDITOR_DIR/distribution/VERSION" "$PUBLISH_DIR/VERSION.txt"
  cat > "$PUBLISH_DIR/README.txt" <<EOF
Cat-Cut 最新版の配布フォルダ

【インストール・更新の手順】
1. CatCut-latest.zip をダウンロードしてダブルクリックで展開する
2. 展開されたフォルダの中の install.command を右クリック →「開く」
3. 画面の指示に従って完了を待つ（更新の場合も同じ手順。編集中のデータは消えません）
4. デスクトップの Cat-Cut.command から起動する

【注意】
- 必ず「いま展開したフォルダ」の install.command を実行してください。
  デスクトップやダウンロードに残っている古い CatCut-setup フォルダから実行すると
  古いバージョンに巻き戻ります（古い展開フォルダは削除を推奨）
- いま入っているバージョンは ~/CatCut/VERSION.txt で確認できます

現在のバージョン: VERSION.txt を参照（$(date +%Y-%m-%d) 更新）
EOF
  echo "NextCloudへ公開しました: $PUBLISH_DIR/CatCut-latest.zip（バージョン: $(cat "$EDITOR_DIR/distribution/VERSION")）"
else
  echo "注意: NextCloudフォルダが見つからないため公開をスキップしました: $(dirname "$PUBLISH_DIR")"
  echo "      公開先を変える場合は CATCUT_PUBLISH_DIR を設定してください"
fi
