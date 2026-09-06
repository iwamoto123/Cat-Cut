# Cat-Cut billing-server（W12-1 / W12-4）

決済ページでプランを販売し、決済完了 webhook で Ed25519 署名付きライセンスキーを自動発行する小さなサーバです。デスクトップアプリ（`desktop/`）はこのサーバの `/license/activate` `/license/refresh` を呼びます。

- ランタイム: Node 22 / 依存は `stripe` のみ（UnivaPay は標準 fetch で直接 API 呼び出し）
- **決済プロバイダは `PAYMENT_PROVIDER` env で切替**（`stripe`＝既定 / `univapay`）。W12-4 でプロバイダ抽象（`src/providers/`）を導入し、ライセンス発行・署名・ストア・activate/refresh は共通のままです
- 金額・プラン価格はこのリポジトリに書きません。Stripe は Price ID、UnivaPay は課金額を `.env` に貼るだけで動きます

## エンドポイント

| メソッド/パス | 役割 |
|---|---|
| `POST /checkout` `{plan}` | 決済ページURLを返す（Stripe: Checkout Session / UnivaPay: リンクフォームURL） |
| `POST /webhook` | Stripe webhook。決済完了でライセンス発行、解約・支払い失敗で失効/保留 |
| `POST /webhook/univapay/<シークレット>` | UnivaPay webhook。パス内シークレット＋API照会で認証してから発行/失効 |
| `GET /license/claim?session_id=`（または `order_id=` / `charge_id=`） | 購入完了ページ。発行済みキーを表示する |
| `POST /license/activate` `{key, deviceId}` | キーの署名検証+失効確認 |
| `POST /license/refresh` `{key}` | ライセンス状態の再確認（サブスクはプロバイダにも照会） |

ライセンスは `data/licenses.json` に保存されます（ストレージ抽象は `src/store.mjs`。将来 SQLite 化する場合はここだけ差し替え）。

## 開発・テスト

```bash
cd billing
npm install
npm test          # node --test "tests/*.test.mjs"
```

## 金額決定後にやること（手順書）

### 1. Stripe アカウントと Product/Price の作成

1. [Stripe](https://dashboard.stripe.com/) アカウントを作成（まずテストモードで進める）
2. 「商品カタログ」で Product「Cat-Cut」を作成し、Price を3つ作る
   - 月額（continuous / monthly）→ `PRICE_ID_MONTHLY`
   - 年額（continuous / yearly）→ `PRICE_ID_YEARLY`
   - 買い切り（one-off）→ `PRICE_ID_LIFETIME`
3. 各 Price の ID（`price_...`）を控える

※ Checkout を本番で使うには Stripe の本人確認と、特商法表記・利用規約ページの用意が必要。

### 2. 署名鍵の生成

```bash
node scripts/generate-keys.mjs
```

- 出力された `LICENSE_SIGNING_KEY=...` を `.env` へ
- 出力された公開鍵を `desktop/main/license.cjs` と `desktop/src/lib/license.ts` の `LICENSE_PUBLIC_KEY` 定数へ

**注意: 鍵を作り直すと発行済みライセンスは全て無効になります。秘密鍵は厳重に保管してください。**

### 3. .env の設定

```bash
cp .env.example .env
```

`STRIPE_SECRET_KEY` / `PRICE_ID_*` / `LICENSE_SIGNING_KEY` / `PUBLIC_BASE_URL`（デプロイ先URL）を埋める。

### 4. デプロイ

Render / Fly.io / Railway 等の Node 対応 PaaS に単一プロセスでデプロイ（`npm start`）。`data/` が消えない永続ディスクを割り当てること（無い場合はライセンスストアが消えるため、S3等へのバックアップか SQLite+永続ボリュームへの切り替えを検討）。

### 5. webhook エンドポイントの登録

1. Stripe ダッシュボード →「開発者」→「Webhook」→ エンドポイント追加
2. URL: `https://<デプロイ先>/webhook`
3. イベント: `checkout.session.completed` / `customer.subscription.deleted` / `invoice.payment_failed`
4. 発行された署名シークレット（`whsec_...`）を `.env` の `STRIPE_WEBHOOK_SECRET` へ

### 6. アプリ側の設定

- `desktop/main/license.cjs` の `BILLING_SERVER_URL` にデプロイ先URLを設定
- `desktop/src/App.tsx` の `FEATURES.billing` を `true` に
- `desktop/src/lib/billingPlans.ts` の価格表示（「準備中」）を実際の金額表記に更新

### 7. テストモードでの E2E チェックリスト

ローカル確認は [Stripe CLI](https://stripe.com/docs/stripe-cli) の `stripe listen --forward-to localhost:8788/webhook` が便利。

- [ ] アプリの購入ボタン → 外部ブラウザで Checkout が開く
- [ ] テストカード `4242 4242 4242 4242` で決済 → `/license/claim` にキーが表示される
- [ ] キーをアプリに貼り付けて認証 → ステータスが「有効」になる
- [ ] アプリ再起動 → オフラインでもライセンスが維持される（ローカル署名検証）
- [ ] `POST /license/refresh` が `{ok: true, status: "active"}` を返す
- [ ] ダッシュボードでサブスクを解約 → webhook 後に refresh が `revoked` を返す
- [ ] キーの一部を書き換えて認証 → 改ざん検知で拒否される
- [ ] 買い切りプランでも同じフローで発行・認証できる

### 8. 本番切り替え

テストモードの手順を本番モードで繰り返す（本番の Price ID・`sk_live_` キー・本番 webhook シークレットに差し替え）。

## W12-4: UnivaPay を採用する場合のセットアップ手順

Stripe の代わりに UnivaPay（リンクフォーム決済）でライセンス販売を行う場合の手順です。`PAYMENT_PROVIDER=univapay` を設定すると `/checkout` はリンクフォームURLを返し、webhook は `POST /webhook/univapay/<シークレット>` で受けます。

> **【重要・契約の事前確認】** 既存の UnivaPay 契約は塾月謝（役務）の商材で審査されています。加盟店審査は商材単位のため、**ソフトウェアライセンス販売（デジタルコンテンツ/無形商材）が現契約でカバーされるか、必ず UnivaPay 担当者に確認**してください。カバーされない場合は商材追加の申請が必要です。

### 1. アプリトークンの作成（管理画面）

1. UnivaPay 管理画面 → 店舗 → 店舗名 → アプリトークンで**「店舗」権限のアプリトークン**を作成
2. 表示された**シークレットは作成時にしか表示されない**ので必ず控える
3. `.env` に設定: `UNIVAPAY_APP_TOKEN`（JWT部分）/ `UNIVAPAY_APP_SECRET`（シークレット）

### 2. .env の設定

```bash
cp .env.example .env
```

- `PAYMENT_PROVIDER=univapay`
- `UNIVAPAY_WEBHOOK_SECRET`: 自前で生成するランダム値（例: `openssl rand -hex 32`）。webhook URL のパスに埋め込んで認証に使う（UnivaPay には Stripe のような署名ヘッダがないため）
- `UNIVAPAY_AMOUNT_MONTHLY` / `UNIVAPAY_AMOUNT_YEARLY` / `UNIVAPAY_AMOUNT_LIFETIME`: 金額決定後に JPY 整数で設定
- `LICENSE_SIGNING_KEY` / `PUBLIC_BASE_URL` は Stripe 採用時と共通（鍵生成手順は上記「2. 署名鍵の生成」）

### 3. リンクフォーム設定の作成（管理画面）

1. 管理画面 → 店舗 → 店舗名 → 決済フォームタブ → **リンクフォーム設定**を作成（モード: まずテスト）
2. 「URLコード」からフォームURL（`https://checkout.univapay.com/forms/<フォームID>`）を控え、`.env` の `UNIVAPAY_LINK_FORM_BASE` に設定
3. お客様情報は**メールアドレス必須**を推奨（購入者への連絡・照合手段になるため）

### 4. ウェブフックの登録（管理画面）

1. 管理画面 → ウェブフック → ウェブフック追加
2. URL: `https://<デプロイ先>/webhook/univapay/<UNIVAPAY_WEBHOOK_SECRETの値>`
3. トリガー（チェックを入れるイベント）:
   - **課金**（`charge_finished`）… 買い切りの発行
   - **定期課金成功**（`subscription_payment`）… サブスク初回の発行・復帰
   - **定期課金失敗**（`subscription_failure`）… past_due（猶予）
   - **定期課金永久停止**（`subscription_canceled`）… 失効
   - **定期課金一時停止**（`subscription_suspended`）… 失効（リトライ回数超過など）
4. 注意: UnivaPay は **3秒以内に 200 応答がないと失敗と判定してリトライ**します。本サーバは 200 を先に返し、発行処理は応答後に非同期実行する設計です。リトライで同一イベントが重複送信されても、課金ID/定期課金IDで冪等化しているため二重発行はされません

### 5. テスト手順（テストモード）

- [ ] `POST /checkout {"plan":"monthly"}` → 返ってきたリンクフォームURLをブラウザで開き、テストカードで決済
- [ ] webhook 受信後、`/license/claim?order_id=<orderId>` にキーが表示される（決済後のリダイレクトでも同URLに着地する）
- [ ] キーをアプリに貼り付けて認証 → ステータスが「有効」になる
- [ ] `POST /license/refresh` が `{ok: true, status: "active"}` を返す
- [ ] 管理画面で定期課金を永久停止 → webhook 後に refresh が `revoked` を返す
- [ ] 買い切りプラン（lifetime）でも発行・認証できる
- [ ] **要実機確認（コード内コメント参照）**: リンクフォームURLの `metadata=plan:...,order-id:...` が課金/定期課金のメタデータとして2フィールドで保存されること、`appId` にアプリトークンのJWTをそのまま使えることをテスト決済で確認する

### 6. 本番切り替え

リンクフォーム設定のモードを本番に切り替え、本番用アプリトークン・webhook URL を再設定して同じチェックリストを実施する。

### 手数料メモ（2026-07-12 調査。仕様書 W12-4 参照）

- Stripe: カード 3.6% + サブスクは Billing 利用料 +0.7% ＝ 実質約 4.3%
- UnivaPay: 個別契約料率（一般に 2.8〜3.24%〜）+ 仮実同時処理料（約10円/件）。定期課金の追加%なし
- サブスク販売では UnivaPay が約1%ポイント有利。ただし月額最低手数料の有無は既存契約を確認
