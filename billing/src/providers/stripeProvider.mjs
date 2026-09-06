// W12-4: Stripe 決済プロバイダ。
//
// W12-1 で server.mjs に実装していた Stripe 固有ロジック(checkout / webhook /
// サブスク状態照会)をここへ移設した。ライセンス発行・licenseKeys・store の
// 共通部は変えず、プロバイダ共通インターフェース(providers/index.mjs 参照)を実装する。
//
// 純関数(handleCheckout / handleWebhookEvent / resolvePlan)は W12-1 から変更なし。
// 既存テストとの互換のため server.mjs からも re-export される。
import crypto from "node:crypto";
import { signLicense } from "../licenseKeys.mjs";

/**
 * プランIDを plans.json で解決し、対応する Stripe Price ID を env から取り出す。
 * 戻り値: { ok: true, plan, priceId } | { ok: false, error }
 */
export function resolvePlan(plans, planId, env) {
  const plan = plans.find((p) => p.id === String(planId || ""));
  if (!plan) return { ok: false, error: `不明なプランです: ${planId}` };
  const priceId = String(env[plan.priceIdEnv] || "").trim();
  if (!priceId) {
    return { ok: false, error: `Price IDが未設定です(env ${plan.priceIdEnv})。Stripeダッシュボードで作成後 .env に設定してください` };
  }
  return { ok: true, plan, priceId };
}

/**
 * POST /checkout: プラン種別に応じて mode(subscription|payment) を切り替えて
 * Checkout Session を作成する。success_url の {CHECKOUT_SESSION_ID} は
 * Stripe側が実セッションIDに展開する(claimページでキーを引くのに使う)。
 */
export async function handleCheckout(body, { stripe, plans, env }) {
  const resolved = resolvePlan(plans, body?.plan, env);
  if (!resolved.ok) return { status: 400, json: { error: resolved.error } };
  const { plan, priceId } = resolved;
  const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return { status: 500, json: { error: "PUBLIC_BASE_URL が未設定です" } };
  const session = await stripe.checkout.sessions.create({
    mode: plan.kind === "subscription" ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    // metadata.plan を webhook(checkout.session.completed)でのライセンス発行時に参照する
    metadata: { plan: plan.id },
    success_url: `${baseUrl}/license/claim?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/license/claim?canceled=1`,
  });
  return { status: 200, json: { url: session.url } };
}

/** Stripeのサブスク状態 → ライセンスstatus のマッピング。 */
export function licenseStatusFromStripeSubscription(subscriptionStatus) {
  if (subscriptionStatus === "active" || subscriptionStatus === "trialing") return "active";
  if (subscriptionStatus === "past_due") return "past_due";
  // canceled / unpaid / incomplete_expired 等は失効扱い
  return "revoked";
}

/**
 * POST /webhook のイベント分岐本体。署名検証済みの event を受け取る
 * (constructEvent は handleWebhookRequest 側。テストはこの関数を直接叩く)。
 */
export function handleWebhookEvent(event, { store, plans, signingKey, now = () => new Date() }) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    // 同一セッションの再送(Stripeはwebhookをリトライする)を冪等化
    if (store.findBySessionId(session.id)) {
      return { handled: true, action: "already_issued" };
    }
    const planId = String(session.metadata?.plan || "");
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
      return { handled: false, action: "unknown_plan", error: `metadata.plan が不明です: ${planId}` };
    }
    const payload = {
      licenseId: crypto.randomUUID(),
      plan: plan.id,
      kind: plan.kind,
      issuedAt: now().toISOString(),
      stripeCustomerId: String(session.customer || ""),
      ...(session.subscription ? { stripeSubscriptionId: String(session.subscription) } : {}),
    };
    const key = signLicense(payload, signingKey);
    const record = store.put({
      ...payload,
      key,
      status: "active",
      stripeCheckoutSessionId: session.id,
      deviceIds: [],
    });
    return { handled: true, action: "issued", licenseId: record.licenseId };
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const license = store.findBySubscriptionId(subscription.id);
    if (!license) return { handled: true, action: "no_matching_license" };
    store.put({ ...license, status: "revoked" });
    return { handled: true, action: "revoked", licenseId: license.licenseId };
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    const license = store.findBySubscriptionId(invoice.subscription);
    if (!license) return { handled: true, action: "no_matching_license" };
    // 支払い失敗は即失効にせず past_due(アプリ側は猶予期間で動作継続)。
    // 最終的な失効は customer.subscription.deleted で行う。
    store.put({ ...license, status: "past_due" });
    return { handled: true, action: "past_due", licenseId: license.licenseId };
  }

  return { handled: false, action: "ignored" };
}

/**
 * Stripe プロバイダを生成する(共通インターフェース実装)。
 * refresh のみの用途では stripe だけ渡せばよい(plans/env/store は checkout/webhook 用)。
 */
export function createStripeProvider({ stripe, plans, env, store } = {}) {
  return {
    name: "stripe",

    /** POST /checkout: Stripe Checkout Session を作成して {url} を返す。 */
    createCheckout(body) {
      return handleCheckout(body, { stripe, plans, env });
    },

    /** Stripe webhook は W12-1 と同じ POST /webhook を使う。 */
    matchWebhook(method, pathname) {
      return method === "POST" && pathname === "/webhook";
    },

    /**
     * POST /webhook: Stripe-Signature ヘッダで署名検証してからイベント処理。
     * Stripe は応答期限が緩い(リトライ前提)ため、応答前に同期処理して問題ない。
     */
    async handleWebhookRequest({ rawBody, headers }) {
      let event;
      try {
        // Stripe-Signature ヘッダで署名検証。失敗=偽装リクエストとして400
        event = stripe.webhooks.constructEvent(rawBody, headers["stripe-signature"], env.STRIPE_WEBHOOK_SECRET);
      } catch (error) {
        return { status: 400, json: { error: `webhook署名の検証に失敗しました: ${error.message}` } };
      }
      const result = handleWebhookEvent(event, { store, plans, signingKey: env.LICENSE_SIGNING_KEY });
      return { status: 200, json: { received: true, action: result.action } };
    },

    /**
     * /license/refresh 用: Stripe subscription の状態を照会してライセンスstatusを返す。
     * 買い切り・照会失敗時は null(=ストアの現状を維持。アプリ側の猶予期間で吸収)。
     */
    async refreshSubscription(license) {
      if (license.kind !== "subscription" || !license.stripeSubscriptionId || !stripe) return null;
      try {
        const subscription = await stripe.subscriptions.retrieve(license.stripeSubscriptionId);
        return licenseStatusFromStripeSubscription(subscription.status);
      } catch {
        return null;
      }
    },
  };
}
