# Cat-Cut セットアップ手順（社内配布版）

動画を入れると、カット・テロップ・書き出しまで自動でやってくれる編集アプリです。
Macのみ対応です（Apple Silicon / Intel どちらも可。Intel Macでは一部のオプション機能=ローカルWhisper文字起こしが使えませんが、通常の利用には影響ありません）。

## インストール（初回のみ）

1. 受け取った日付付きzip（`CatCut-haifu-YYYYMMDD.zip`）をダブルクリックで展開する
2. 展開したフォルダを開き、`install.command` を **右クリック →「開く」→「開く」**
   （ダブルクリックだと「開発元を確認できません」と出て開けないため、必ず右クリックから）
3. 黒い画面（ターミナル）が開いて自動で進みます。Macのパスワードを聞かれたら入力してください
4. 初回は20〜40分かかります。「インストール完了です」と出たら終わりです

「適切なアクセス権限がないために実行できません」と出る場合は、ターミナルを開き、`bash `（最後に半角スペース）と入力してから、展開した `install.command` をそのウィンドウへドラッグし、Enterを押してください。

## 起動

- デスクトップにできた **`Cat-Cut.command`** をダブルクリックすると、編集画面が開きます
- `install.command` はセットアップ用です。インストール後の起動には `Cat-Cut.command` を使ってください
- 黒い画面が一緒に開きますが、**アプリを使っている間は閉じないでください**
- 初回起動時にAPIキーの入力画面が出ます。キーは岩本から受け取って貼り付けてください

## 使い方（最短）

1. 左上の「動画」でファイルを選ぶ（横型/縦型を選択）
2. 「開始」を押して解析が終わるのを待つ
3. シーン検品でテキストを直す（編集は自動保存されます）
4. 「書き出し」を押す。完了するとFinderでファイルが開きます

## 更新（新しいバージョンが配られたとき）

新しいzipを展開して、同じように `install.command` を右クリック→「開く」で実行するだけです。
**編集中のプロジェクトデータは消えません。**

## 困ったとき

- エラーが出た: ターミナルの画面のスクリーンショットを岩本へ送る
- **APIキーを入れても接続テストが失敗する**（岩本のキーでも社員のキーでも同じ）:
  1. zip内の `check_network.command` を右クリック→「開く」で診断する
  2. 「401=キー未設定だが通信は成功」と出れば **ネットワークはOK** → キーのコピペミスを疑う（前後空白・改行混入）
  3. 接続失敗の場合 → **会社Wi-Fi/VPN/ファイアウォール**で `api.elevenlabs.io` がブロックされている可能性大。スマホテザリング等の別回線で試す
  4. 最新zip（Intel Mac対応版）で `install.command` を再実行しているか確認
- アプリが真っ白/動かない: 黒い画面ごと閉じて、もう一度「Cat-Cut」をダブルクリック
- アプリの場所: 起動用ファイルはデスクトップの `Cat-Cut.command`、本体は `~/CatCut`（ホームフォルダのCatCut）に入っています。「アプリケーション」フォルダにCat-Cut.appが作られる方式ではありません

### 「Electron failed to install correctly」と表示されて起動しない

画面表示に必要なElectron本体が正しく展開されていない状態です。Node.js 26などと旧展開ライブラリの組み合わせで、エラーを出さず途中終了する場合があります。最新版のzipからインストールし直すと修正版の展開ライブラリが適用されます。

すぐ修復する場合は、ターミナルに次をまとめて貼り付け、Enterを押してください。展開ライブラリを修正版へ変更し、Electron本体の動作確認後にCat-Cutを起動します。

```bash
cd "$HOME/CatCut/desktop" &&
npm --cache "$HOME/Library/Caches/CatCut/npm" pkg set 'overrides.extract-zip.yauzl=3.3.1' &&
npm install --cache "$HOME/Library/Caches/CatCut/npm" --no-audit --no-fund &&
env -u ELECTRON_SKIP_BINARY_DOWNLOAD -u ELECTRON_OVERRIDE_DIST_PATH node node_modules/electron/install.js &&
env -u ELECTRON_OVERRIDE_DIST_PATH ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -p 'process.versions.electron' &&
env -u ELECTRON_OVERRIDE_DIST_PATH npm --cache "$HOME/Library/Caches/CatCut/npm" run dev
```

ダウンロードに数分かかる場合があります。エラーで止まった場合は、その内容を岩本へ送ってください。次回からは通常どおりデスクトップの `Cat-Cut.command` から起動できます。

### npmの「EACCES」「EEXIST」で止まる

エラーのパスが `~/.npm/_cacache` の場合は、npmの共通キャッシュへ書き込めない状態です。上記の修復コマンドでは `~/Library/Caches/CatCut/npm` に専用キャッシュを作成して取得します。最新版のインストーラもこの保存先を使用します。

インストール途中で止まった場合は、最新版zipの `install.command` を再実行してください。書き出し用の依存パッケージの導入と起動用ファイルの作成まで完了できます。
