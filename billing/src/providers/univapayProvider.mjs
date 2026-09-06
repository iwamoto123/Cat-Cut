// W12-4: UnivaPay 決済プロバイダ(リンクフォーム + ウェブフック + API照会)。
//
// docs.univapay.com 準拠:
// - 認証: JWTアプリトークン `Authorization: Bearer {secret}.{jwt}`(店舗トークン)
//   https://docs.univapay.com/docs/api/auth/
// - 決済ページ: リンクフォーム(ホスト型)。`https://checkout.univapay.com/forms/<フォームID>`
//   に GET クエリパラメータを付けたURLへ消費者を遷移させる
//   https://docs.univapay.com/docs/guide/implement/link/
//   https://docs.univapay.com/docs/guide/implement/link/param-basic/
// - ウェブフック: 3秒以内に200を返す必要がある(超過はリトライ=重複送信の元)ため、
//   200応答を先に返し、ライセンス発行処理は応答後に非同期実行する(after コールバック)
//   https://docs.univapay.com/docs/guide/detail/webhook/
// - 真正性確認: UnivaPayにはStripeのような署名ヘッダがないため、
//   (1) URLパスに含めたシークレット(UNIVAPAY_WEBHOOK_SECRET)の一致 と
//   (2) ペイロード中の課金ID/定期課金IDを UnivaPay API に GET で照会
//   の二段構えで偽装ウェブフックを弾いてからライセンスを発行する
//   課金GET:     https://docs.univapay.com/docs/api/charges/request/get/
//   定期課金GET: https://docs.univapay.com/docs/api/subscriptions/request/get/
import crypto from "node:crypto";
import { signLicense } from "../licenseKeys.mjs";

/** UnivaPay REST API のベースURL(課金GETのドキュメント記載値)。 */
export const UNIVAPAY_API_BASE = "https://api.univapay.com";

/** プランID → リンクフォームの定期課金間隔(subscriptionPeriod)。plans.json の period を参照する。 */
function subscriptionPeriodOf(plan) {
  // 指定可能な値: daily/weekly/biweekly/monthly/bimonthly/quarterly/semiannually/annually
  // (リンクフォーム パラメータ(定期課金) ドキュメントより)
  return String(plan.period || "monthly");
}

/**
 * プランIDを plans.json で解決し、UnivaPay 用の課金額(JPY)を env から取り出す。
 * Stripe の Price ID と同様、金額はリポジトリに書かず env をプレースホルダにする。
 * 戻り値: { ok: true, plan, amount } | { ok: false, error }
 */
export function resolveUnivapayPlan(plans, planId, env) {
  const plan = plans.find((p) => p.id === String(planId || ""));
  if (!plan) return { ok: false, error: `不明なプランです: ${planId}` };
  const amountEnv = String(plan.univapayAmountEnv || "");
  const amount = Number.parseInt(String(env[amountEnv] || "").trim(), 10);
  if (!amountEnv || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: `課金額が未設定です(env ${amountEnv || "univapayAmountEnv"})。金額決定後に .env へ設定してください` };
  }
  return { ok: true, plan, amount };
}

/**
 * リンクフォームURLを組み立てる純関数。
 * - orderId: 事前生成したUUID。metadata に載せて webhook でのプラン照合と claim に使う
 * - サブスクプランは type=subscription(定期課金モード)、買い切りは type=one_time(通常課金モード)
 */
export function buildLinkFormUrl({ plan, amount, orderId, env }) {
  const base = String(env.UNIVAPAY_LINK_FORM_BASE || "").trim().replace(/\/$/, "");
  if (!base) return { ok: false, error: "UNIVAPAY_LINK_FORM_BASE が未設定です(管理画面のリンクフォーム設定のURLを設定してください)" };
  const publicBase = String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!publicBase) return { ok: false, error: "PUBLIC_BASE_URL が未設定です" };

  const url = new URL(base);
  // appId: 管理画面で発行されるリンクフォームURLに含まれるアプリケーションID。
  // ベースURLに既に付いていない場合はアプリトークン(jwt)を設定する。
  // 【要実機確認】appId の値が「アプリトークンのJWT文字列そのもの」で正しいか
  // (管理画面のURLコードで生成されるURLの appId と一致するか確認すること)
  if (!url.searchParams.has("appId")) {
    url.searchParams.set("appId", String(env.UNIVAPAY_APP_TOKEN || ""));
  }
  url.searchParams.set("checkout", "payment");
  // 単数指定はフィールド名末尾に [] が必須(リンクフォーム パラメータ(基本動作)より)
  url.searchParams.set("paymentMethods[]", "card");
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("currency", "jpy");
  if (plan.kind === "subscription") {
    // 定期課金モード: type=subscription + subscriptionPeriod
    url.searchParams.set("type", "subscription");
    url.searchParams.set("subscriptionPeriod", subscriptionPeriodOf(plan));
  } else {
    // 買い切り: 通常課金モード(一度だけ課金可のトークン)
    url.searchParams.set("type", "one_time");
  }
  // metadata: プラン識別(plan)と注文ID(order-id)。キーはケバブケースで記述
  // (ウィジェットの data-metadata と同仕様と想定)。
  // 【要実機確認】リンクフォームのパラメータ表に metadata の記載がないため、
  // 複数フィールドを1つの metadata パラメータで渡す書式("plan:xxx,order-id:yyy")が
  // 実際に2つのメタデータとして保存されるかテスト決済で確認すること。
  // 保存されない場合はリンクフォーム設定のカスタムフィールド等での代替を検討する
  url.searchParams.set("metadata", `plan:${plan.id},order-id:${orderId}`);
  // 決済成功後は claim ページへリダイレクト(orderId でキーを引ける)
  url.searchParams.set("successRedirectUrl", `${publicBase}/license/claim?order_id=${orderId}`);
  url.searchParams.set("failureRedirectUrl", `${publicBase}/license/claim?canceled=1`);
  return { ok: true, url: url.toString() };
}

/**
 * UnivaPay の定期課金ステータス → ライセンスstatus のマッピング。
 * (定期課金-概要ドキュメントのステータス一覧より)
 */
export function licenseStatusFromUnivapaySubscription(subscriptionStatus) {
  // completed は回数/総額指定の定期課金の全支払完了(=支払済み)なので active 扱い。
  // 【要実機確認】completed をライセンス有効継続と見なす運用でよいか(プラン設計時に再確認)
  if (subscriptionStatus === "current" || subscriptionStatus === "completed") return "active";
  // unpaid(リトライ待ち)・unverified(初回課金待機中)は猶予扱い
  if (subscriptionStatus === "unpaid" || subscriptionStatus === "unverified") return "past_due";
  // canceled(永久停止)・suspended(一時停止=リトライ回数超過等)・unconfirmed(初回失敗)は失効
  return "revoked";
}

/** UnivaPay API へ認証付きGET。失敗(非2xx・疎通エラー)は例外を投げる。 */
async function univapayGet(pathname, { env, fetchImpl }) {
  const base = String(env.UNIVAPAY_API_BASE || UNIVAPAY_API_BASE).replace(/\/$/, "");
  const response = await fetchImpl(`${base}${pathname}`, {
    headers: {
      // 店舗アプリトークン: Bearer {secret}.{jwt}(認証ドキュメントより)
      Authorization: `Bearer ${env.UNIVAPAY_APP_SECRET}.${env.UNIVAPAY_APP_TOKEN}`,
    },
  });
  if (!response.ok) {
    throw new Error(`UnivaPay API が ${response.status} を返しました: GET ${pathname}`);
  }
  return response.json();
}

/** ウェブフックURLパスのシークレット照合(タイミング攻撃対策で timingSafeEqual)。 */
function webhookSecretMatches(pathname, secret) {
  const expected = `/webhook/univapay/${secret}`;
  const a = Buffer.from(String(pathname));
  const b = Buffer.from(expected);
  if (!secret || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 照会済みリソースの metadata から plan / order-id を取り出す。 */
function planFromMetadata(metadata, plans) {
  const planId = String(metadata?.plan || "");
  const plan = plans.find((p) => p.id === planId);
  const orderId = String(metadata?.["order-id"] || "");
  return { plan, orderId };
}

/**
 * ウェブフックイベントの処理本体(200応答後に非同期実行される)。
 * ペイロードを鵜呑みにせず、課金ID/定期課金IDを UnivaPay API に GET で照会して
 * 真正性を確認(偽装対策)してからライセンスを発行する。
 *
 * イベント分岐(ウェブフック-イベント名の一覧より):
 * - charge_finished(status=successful, 買い切り)      → ライセンス発行
 * - charge_finished(successful, subscription_id あり) → 定期課金の初回=発行 / 2回目以降=active回復
 * - subscription_payment(定期課金成功)                → 同上(charge_finished と重複到達しても冪等)
 * - charge_finished(failed, subscription_id あり)・subscription_failure → past_due
 * - subscription_canceled・subscription_suspended     → revoked
 * 冪等性: 同一課金ID/定期課金IDの二重発行は store 照会で防止する。
 */
export async function processUnivapayEvent(payload, { store, plans, env, signingKey, fetchImpl, now = () => new Date() }) {
  const event = String(payload?.event || "");
  const data = payload?.data || {};
  const storeId = String(data.store_id || "");

  // 共通: 署名済みライセンスを発行して保存する
  const issueLicense = ({ plan, orderId, kind, resourceId, extraFields }) => {
    const licensePayload = {
      licenseId: crypto.randomUUID(),
      plan: plan.id,
      kind,
      issuedAt: now().toISOString(),
      // フィールド名は W12-1(Stripe)由来だがデスクトップ側の検証仕様で必須のため、
      // UnivaPay では "univapay:<リソースID>" を顧客識別子として入れる
      stripeCustomerId: `univapay:${resourceId}`,
    };
    const key = signLicense(licensePayload, signingKey);
    const record = store.put({
      ...licensePayload,
      key,
      status: "active",
      univapayOrderId: orderId,
      univapayStoreId: storeId,
      deviceIds: [],
      ...extraFields,
    });
    return { handled: true, action: "issued", licenseId: record.licenseId };
  };

  // --- 課金完了(買い切りの成功/失敗、定期課金の各回課金の成功/失敗) ---
  if (event === "charge_finished") {
    const chargeId = String(data.id || "");
    const subscriptionId = String(data.subscription_id || "");

    if (data.status === "successful" && !subscriptionId) {
      // 買い切りの課金成功。冪等: 同一課金IDは再発行しない
      if (store.findByField("univapayChargeId", chargeId)) {
        return { handled: true, action: "already_issued" };
      }
      // 真正性確認: 課金GETで実在とステータスを照会し、metadata もAPIの値を正とする
      let charge;
      try {
        charge = await univapayGet(`/stores/${storeId}/charges/${chargeId}`, { env, fetchImpl });
      } catch (error) {
        return { handled: false, action: "verification_failed", error: error.message };
      }
      if (charge.status !== "successful") {
        return { handled: false, action: "verification_failed", error: `課金ステータスが successful ではありません: ${charge.status}` };
      }
      const { plan, orderId } = planFromMetadata(charge.metadata, plans);
      if (!plan) {
        return { handled: false, action: "unknown_plan", error: `metadata.plan が不明です: ${charge.metadata?.plan}` };
      }
      return issueLicense({
        plan, orderId, kind: "one_time", resourceId: chargeId,
        extraFields: { univapayChargeId: chargeId },
      });
    }

    if (subscriptionId) {
      // 定期課金に紐づく課金 → 定期課金イベントとして扱う(初回成功は subscription_payment
      // と重複到達し得るが、下の処理は冪等なのでどちらが先でも結果は同じ)
      if (data.status === "successful") {
        return ensureSubscriptionLicense(subscriptionId, { store, plans, env, signingKey, fetchImpl, storeId, issueLicense });
      }
      if (data.status === "failed") {
        // 支払失敗は即失効にせず past_due(最終失効は subscription_canceled / suspended)
        const license = store.findByField("univapaySubscriptionId", subscriptionId);
        if (!license) return { handled: true, action: "no_matching_license" };
        store.put({ ...license, status: "past_due" });
        return { handled: true, action: "past_due", licenseId: license.licenseId };
      }
    }
    return { handled: false, action: "ignored" };
  }

  // --- 定期課金の課金成功(初回=発行 / 継続回=active回復) ---
  if (event === "subscription_payment") {
    return ensureSubscriptionLicense(String(data.id || ""), { store, plans, env, signingKey, fetchImpl, storeId, issueLicense });
  }

  // --- 定期課金の支払失敗 → past_due ---
  if (event === "subscription_failure") {
    const license = store.findByField("univapaySubscriptionId", String(data.id || ""));
    if (!license) return { handled: true, action: "no_matching_license" };
    store.put({ ...license, status: "past_due" });
    return { handled: true, action: "past_due", licenseId: license.licenseId };
  }

  // --- 定期課金の永久停止/一時停止 → revoked ---
  // suspended はリトライ回数超過等で移行するため失効扱いにする(再開時は
  // subscription_payment の active 回復で復活する)
  if (event === "subscription_canceled" || event === "subscription_suspended") {
    const license = store.findByField("univapaySubscriptionId", String(data.id || ""));
    if (!license) return { handled: true, action: "no_matching_license" };
    store.put({ ...license, status: "revoked" });
    return { handled: true, action: "revoked", licenseId: license.licenseId };
  }

  return { handled: false, action: "ignored" };
}

/**
 * 定期課金IDに対応するライセンスを保証する:
 * - 未発行なら定期課金GETで真正性確認してから発行(初回課金)
 * - 発行済みなら active へ回復(past_due からの復帰。冪等)
 */
async function ensureSubscriptionLicense(subscriptionId, { store, plans, env, signingKey, fetchImpl, storeId, issueLicense }) {
  const existing = store.findByField("univapaySubscriptionId", subscriptionId);
  if (existing) {
    if (existing.status !== "active") {
      store.put({ ...existing, status: "active" });
      return { handled: true, action: "reactivated", licenseId: existing.licenseId };
    }
    return { handled: true, action: "already_issued" };
  }
  // 真正性確認: 定期課金GETで実在と状態を照会(照会失敗時は発行しない)
  let subscription;
  try {
    subscription = await univapayGet(`/stores/${storeId}/subscriptions/${subscriptionId}`, { env, fetchImpl });
  } catch (error) {
    return { handled: false, action: "verification_failed", error: error.message };
  }
  if (licenseStatusFromUnivapaySubscription(subscription.status) !== "active") {
    return { handled: false, action: "verification_failed", error: `定期課金ステータスが有効ではありません: ${subscription.status}` };
  }
  const { plan, orderId } = planFromMetadata(subscription.metadata, plans);
  if (!plan) {
    return { handled: false, action: "unknown_plan", error: `metadata.plan が不明です: ${subscription.metadata?.plan}` };
  }
  return issueLicense({
    plan, orderId, kind: "subscription", resourceId: subscriptionId,
    extraFields: { univapaySubscriptionId: subscriptionId },
  });
}

/**
 * UnivaPay プロバイダを生成する(共通インターフェース実装)。
 * fetchImpl を注入できるため、テストでは HTTP を発行せずに検証できる。
 */
export function createUnivapayProvider({ env, plans, store, fetchImpl = globalThis.fetch } = {}) {
  return {
    name: "univapay",

    /** POST /checkout: リンクフォームURLを生成して {url} を返す。 */
    async createCheckout(body) {
      const resolved = resolveUnivapayPlan(plans, body?.plan, env);
      if (!resolved.ok) return { status: 400, json: { error: resolved.error } };
      const orderId = crypto.randomUUID();
      const built = buildLinkFormUrl({ plan: resolved.plan, amount: resolved.amount, orderId, env });
      if (!built.ok) return { status: 500, json: { error: built.error } };
      return { status: 200, json: { url: built.url } };
    },

    /** UnivaPay webhook はシークレット入りパス POST /webhook/univapay/<secret> を使う。 */
    matchWebhook(method, pathname) {
      return method === "POST" && pathname.startsWith("/webhook/univapay/");
    },

    /**
     * POST /webhook/univapay/<secret>:
     * UnivaPay は3秒以内に200を返さないと失敗扱い→リトライされるため、
     * ここでは検証と応答だけを行い、発行処理は after(応答後の非同期実行)に回す。
     */
    async handleWebhookRequest({ rawBody, pathname }) {
      // 認証(1段目): URLパスのシークレット照合。不一致は401
      if (!webhookSecretMatches(pathname, String(env.UNIVAPAY_WEBHOOK_SECRET || ""))) {
        return { status: 401, json: { error: "webhookシークレットが一致しません" } };
      }
      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf-8"));
      } catch {
        return { status: 400, json: { error: "JSONボディを解釈できません" } };
      }
      return {
        status: 200,
        json: { received: true },
        // 認証(2段目=API照会による真正性確認)とライセンス発行は応答後に実行する
        after: () => processUnivapayEvent(payload, {
          store, plans, env, signingKey: env.LICENSE_SIGNING_KEY, fetchImpl,
        }),
      };
    },

    /**
     * /license/refresh 用: 定期課金GETで状態を照会してライセンスstatusを返す。
     * 買い切り・照会失敗時は null(=ストアの現状を維持。アプリ側の猶予期間で吸収)。
     */
    async refreshSubscription(license) {
      if (license.kind !== "subscription" || !license.univapaySubscriptionId || !license.univapayStoreId) return null;
      try {
        const subscription = await univapayGet(
          `/stores/${license.univapayStoreId}/subscriptions/${license.univapaySubscriptionId}`,
          { env, fetchImpl },
        );
        return licenseStatusFromUnivapaySubscription(subscription.status);
      } catch {
        return null;
      }
    },
  };
}
