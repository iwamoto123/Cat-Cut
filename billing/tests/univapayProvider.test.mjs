// W12-4: UnivaPay プロバイダのテスト。
// fetch(UnivaPay API 照会)はモック注入し、HTTPを発行せずに検証する。
// 検証対象: リンクフォームURL生成 / webhookイベント分岐 / API照会による真正性確認 /
//           冪等性 / シークレット不一致の401 / プロバイダ切替 / claim / refresh
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, verifyLicense } from "../src/licenseKeys.mjs";
import { createStore } from "../src/store.mjs";
import { handleClaim, handleRefresh, loadPlans } from "../src/server.mjs";
import { createProvider } from "../src/providers/index.mjs";
import {
  buildLinkFormUrl,
  createUnivapayProvider,
  licenseStatusFromUnivapaySubscription,
  processUnivapayEvent,
  resolveUnivapayPlan,
} from "../src/providers/univapayProvider.mjs";

const keys = generateKeyPair();
const plans = loadPlans();

const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";

/** UnivaPay採用時の env(テスト用に全項目埋めたもの)。 */
function univapayEnv(overrides = {}) {
  return {
    PAYMENT_PROVIDER: "univapay",
    PUBLIC_BASE_URL: "https://billing.example.com",
    LICENSE_SIGNING_KEY: keys.privateKey,
    UNIVAPAY_APP_TOKEN: "jwt-token",
    UNIVAPAY_APP_SECRET: "app-secret",
    UNIVAPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    UNIVAPAY_LINK_FORM_BASE: "https://checkout.univapay.com/forms/form-uuid-001",
    UNIVAPAY_AMOUNT_MONTHLY: "980",
    UNIVAPAY_AMOUNT_YEARLY: "9800",
    UNIVAPAY_AMOUNT_LIFETIME: "19800",
    ...overrides,
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-billing-univapay-"));
  return createStore(path.join(dir, "licenses.json"));
}

/**
 * UnivaPay API のGET照会モック。
 * routes: { "/stores/st_1/charges/ch_1": {...} | Error } 形式で応答を定義する。
 * 呼び出しURLは calls に記録される(照会が行われた/行われないの検証用)。
 */
function mockFetch(routes, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    const found = routes[pathname];
    if (!found) return { ok: false, status: 404, json: async () => ({ code: "NOT_FOUND" }) };
    return { ok: true, status: 200, json: async () => found };
  };
}

function chargeFinishedEvent(overrides = {}) {
  return {
    event: "charge_finished",
    data: {
      id: "ch_test_001",
      store_id: "st_test_001",
      subscription_id: null,
      status: "successful",
      metadata: {},
      ...overrides,
    },
  };
}

// --- resolveUnivapayPlan / buildLinkFormUrl(リンクフォームURL生成) ---

test("resolveUnivapayPlan: envから課金額を解決し、未知プラン・金額未設定はエラー", () => {
  const env = univapayEnv();
  const resolved = resolveUnivapayPlan(plans, "monthly", env);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.amount, 980);
  assert.equal(resolveUnivapayPlan(plans, "unknown", env).ok, false);
  const noAmount = resolveUnivapayPlan(plans, "yearly", univapayEnv({ UNIVAPAY_AMOUNT_YEARLY: "" }));
  assert.equal(noAmount.ok, false);
  assert.match(noAmount.error, /UNIVAPAY_AMOUNT_YEARLY/);
});

test("createCheckout: サブスクプランは定期課金モード(type=subscription+period)のリンクフォームURL", async () => {
  const provider = createUnivapayProvider({ env: univapayEnv(), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  const result = await provider.createCheckout({ plan: "monthly" });
  assert.equal(result.status, 200);
  const url = new URL(result.json.url);
  assert.equal(url.origin + url.pathname, "https://checkout.univapay.com/forms/form-uuid-001");
  assert.equal(url.searchParams.get("appId"), "jwt-token");
  assert.equal(url.searchParams.get("checkout"), "payment");
  assert.equal(url.searchParams.get("paymentMethods[]"), "card");
  assert.equal(url.searchParams.get("amount"), "980");
  assert.equal(url.searchParams.get("currency"), "jpy");
  assert.equal(url.searchParams.get("type"), "subscription");
  assert.equal(url.searchParams.get("subscriptionPeriod"), "monthly");
  // metadata に plan と orderId(UUID) が入り、成功リダイレクトは claim ページへ向く
  const metadata = url.searchParams.get("metadata");
  const match = metadata.match(/^plan:monthly,order-id:([0-9a-f-]{36})$/);
  assert.ok(match, `metadata形式が不正: ${metadata}`);
  assert.equal(url.searchParams.get("successRedirectUrl"), `https://billing.example.com/license/claim?order_id=${match[1]}`);
  assert.equal(url.searchParams.get("failureRedirectUrl"), "https://billing.example.com/license/claim?canceled=1");
});

test("createCheckout: 年額プランは period=annually、買い切りは type=one_time", async () => {
  const provider = createUnivapayProvider({ env: univapayEnv(), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  const yearly = new URL((await provider.createCheckout({ plan: "yearly" })).json.url);
  assert.equal(yearly.searchParams.get("subscriptionPeriod"), "annually");
  const lifetime = new URL((await provider.createCheckout({ plan: "lifetime" })).json.url);
  assert.equal(lifetime.searchParams.get("type"), "one_time");
  assert.equal(lifetime.searchParams.get("subscriptionPeriod"), null);
  assert.equal(lifetime.searchParams.get("amount"), "19800");
});

test("createCheckout: 不明プラン・金額未設定は400、LINK_FORM_BASE未設定は500", async () => {
  const provider = createUnivapayProvider({ env: univapayEnv(), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  assert.equal((await provider.createCheckout({ plan: "nope" })).status, 400);
  const noAmount = createUnivapayProvider({ env: univapayEnv({ UNIVAPAY_AMOUNT_MONTHLY: "" }), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  assert.equal((await noAmount.createCheckout({ plan: "monthly" })).status, 400);
  const noBase = createUnivapayProvider({ env: univapayEnv({ UNIVAPAY_LINK_FORM_BASE: "" }), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  assert.equal((await noBase.createCheckout({ plan: "monthly" })).status, 500);
});

test("buildLinkFormUrl: ベースURLに既に appId がある場合は上書きしない", () => {
  const env = univapayEnv({ UNIVAPAY_LINK_FORM_BASE: "https://checkout.univapay.com/forms/form-uuid-001?appId=preset" });
  const built = buildLinkFormUrl({ plan: plans[0], amount: 980, orderId: "order-1", env });
  assert.equal(built.ok, true);
  assert.equal(new URL(built.url).searchParams.get("appId"), "preset");
});

// --- webhook 認証(URLパスのシークレット) ---

test("webhook: パスのシークレット不一致・欠落は401で後処理を返さない", async () => {
  const provider = createUnivapayProvider({ env: univapayEnv(), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  const body = Buffer.from(JSON.stringify(chargeFinishedEvent()));
  const wrong = await provider.handleWebhookRequest({ rawBody: body, pathname: "/webhook/univapay/wrong-secret" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.after, undefined);
  const missing = await provider.handleWebhookRequest({ rawBody: body, pathname: "/webhook/univapay/" });
  assert.equal(missing.status, 401);
});

test("webhook: シークレット一致なら即200を返し、発行処理はafter(応答後実行)に分離される", async () => {
  const store = tempStore();
  const fetchImpl = mockFetch({
    "/stores/st_test_001/charges/ch_test_001": {
      id: "ch_test_001", status: "successful",
      metadata: { plan: "lifetime", "order-id": "order-uuid-1" },
    },
  });
  const provider = createUnivapayProvider({ env: univapayEnv(), plans, store, fetchImpl });
  const result = await provider.handleWebhookRequest({
    rawBody: Buffer.from(JSON.stringify(chargeFinishedEvent())),
    pathname: `/webhook/univapay/${WEBHOOK_SECRET}`,
  });
  // 3秒制限対策: 200のレスポンスが先に確定し、この時点ではまだ発行されていない
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { received: true });
  assert.equal(store.findByField("univapayChargeId", "ch_test_001"), null);
  // afterの実行で発行される
  const outcome = await result.after();
  assert.equal(outcome.action, "issued");
  assert.equal(store.findByField("univapayChargeId", "ch_test_001").plan, "lifetime");
});

test("webhook: 不正JSONは400", async () => {
  const provider = createUnivapayProvider({ env: univapayEnv(), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  const result = await provider.handleWebhookRequest({
    rawBody: Buffer.from("{broken"),
    pathname: `/webhook/univapay/${WEBHOOK_SECRET}`,
  });
  assert.equal(result.status, 400);
});

// --- イベント分岐: 課金成功(買い切り) ---

test("charge_finished(買い切り成功): API照会で真正性を確認して署名済みライセンスを発行する", async () => {
  const store = tempStore();
  const calls = [];
  const fetchImpl = mockFetch({
    "/stores/st_test_001/charges/ch_test_001": {
      id: "ch_test_001", status: "successful",
      metadata: { plan: "lifetime", "order-id": "order-uuid-1" },
    },
  }, calls);
  const result = await processUnivapayEvent(chargeFinishedEvent(), {
    store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl,
    now: () => new Date("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(result.action, "issued");
  // API照会は認証ヘッダ Bearer {secret}.{jwt} 付きで行われる
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.univapay.com/stores/st_test_001/charges/ch_test_001");
  assert.equal(calls[0].options.headers.Authorization, "Bearer app-secret.jwt-token");
  const saved = store.findByField("univapayChargeId", "ch_test_001");
  assert.equal(saved.plan, "lifetime");
  assert.equal(saved.kind, "one_time");
  assert.equal(saved.status, "active");
  assert.equal(saved.univapayOrderId, "order-uuid-1");
  assert.equal(saved.univapayStoreId, "st_test_001");
  assert.equal(saved.issuedAt, "2026-07-12T00:00:00.000Z");
  // 発行されたキーは公開鍵で検証できる本物の署名付き
  const verified = verifyLicense(saved.key, keys.publicKey);
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.licenseId, saved.licenseId);
});

test("charge_finished: 同一課金IDの再送は再発行しない(冪等)", async () => {
  const store = tempStore();
  const fetchImpl = mockFetch({
    "/stores/st_test_001/charges/ch_test_001": {
      id: "ch_test_001", status: "successful", metadata: { plan: "lifetime", "order-id": "o1" },
    },
  });
  const deps = { store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl };
  const first = await processUnivapayEvent(chargeFinishedEvent(), deps);
  const second = await processUnivapayEvent(chargeFinishedEvent(), deps);
  assert.equal(first.action, "issued");
  assert.equal(second.action, "already_issued");
  assert.equal(store.findByField("univapayChargeId", "ch_test_001").licenseId, first.licenseId);
});

test("charge_finished: API照会失敗(404)・照会結果がsuccessfulでない場合は発行しない(偽装対策)", async () => {
  const store = tempStore();
  const deps = { store, plans, env: univapayEnv(), signingKey: keys.privateKey };
  // 照会404(=偽装ペイロードで実在しない課金ID)
  const notFound = await processUnivapayEvent(chargeFinishedEvent(), { ...deps, fetchImpl: mockFetch({}) });
  assert.equal(notFound.handled, false);
  assert.equal(notFound.action, "verification_failed");
  // ペイロードはsuccessfulでも、APIの照会結果がfailedなら発行しない
  const mismatched = await processUnivapayEvent(chargeFinishedEvent(), {
    ...deps,
    fetchImpl: mockFetch({ "/stores/st_test_001/charges/ch_test_001": { id: "ch_test_001", status: "failed", metadata: { plan: "lifetime" } } }),
  });
  assert.equal(mismatched.action, "verification_failed");
  assert.equal(store.findByField("univapayChargeId", "ch_test_001"), null);
});

test("charge_finished: 照会したmetadata.planが不明なら発行しない", async () => {
  const store = tempStore();
  const fetchImpl = mockFetch({
    "/stores/st_test_001/charges/ch_test_001": { id: "ch_test_001", status: "successful", metadata: { plan: "hacked" } },
  });
  const result = await processUnivapayEvent(chargeFinishedEvent(), {
    store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl,
  });
  assert.equal(result.handled, false);
  assert.equal(result.action, "unknown_plan");
});

// --- イベント分岐: 定期課金 ---

const SUBSCRIPTION_ROUTES = {
  "/stores/st_test_001/subscriptions/sub_test_001": {
    id: "sub_test_001", status: "current",
    metadata: { plan: "monthly", "order-id": "order-uuid-2" },
  },
};

async function issueSubscriptionLicense(store, deps = {}) {
  return processUnivapayEvent(
    { event: "subscription_payment", data: { id: "sub_test_001", store_id: "st_test_001", status: "current" } },
    { store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl: mockFetch(SUBSCRIPTION_ROUTES), ...deps },
  );
}

test("subscription_payment(初回): 定期課金GETで確認してサブスクライセンスを発行する", async () => {
  const store = tempStore();
  const result = await issueSubscriptionLicense(store);
  assert.equal(result.action, "issued");
  const saved = store.findByField("univapaySubscriptionId", "sub_test_001");
  assert.equal(saved.plan, "monthly");
  assert.equal(saved.kind, "subscription");
  assert.equal(saved.status, "active");
  assert.equal(saved.univapayOrderId, "order-uuid-2");
});

test("subscription_payment(2回目以降): 再発行せず、past_dueからはactiveへ回復する(冪等)", async () => {
  const store = tempStore();
  const first = await issueSubscriptionLicense(store);
  assert.equal((await issueSubscriptionLicense(store)).action, "already_issued");
  // past_due からの復帰
  store.put({ ...store.get(first.licenseId), status: "past_due" });
  assert.equal((await issueSubscriptionLicense(store)).action, "reactivated");
  assert.equal(store.get(first.licenseId).status, "active");
});

test("subscription_payment: 照会した定期課金が有効でなければ発行しない", async () => {
  const store = tempStore();
  const result = await issueSubscriptionLicense(store, {
    fetchImpl: mockFetch({
      "/stores/st_test_001/subscriptions/sub_test_001": { id: "sub_test_001", status: "canceled", metadata: { plan: "monthly" } },
    }),
  });
  assert.equal(result.action, "verification_failed");
  assert.equal(store.findByField("univapaySubscriptionId", "sub_test_001"), null);
});

test("charge_finished(定期課金の初回課金): subscription_id経由でも発行され、subscription_paymentと重複しても冪等", async () => {
  const store = tempStore();
  const deps = { store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl: mockFetch(SUBSCRIPTION_ROUTES) };
  const viaCharge = await processUnivapayEvent(
    chargeFinishedEvent({ subscription_id: "sub_test_001" }),
    deps,
  );
  assert.equal(viaCharge.action, "issued");
  // 同じ定期課金への subscription_payment が後着しても二重発行しない
  const viaPayment = await issueSubscriptionLicense(store);
  assert.equal(viaPayment.action, "already_issued");
});

test("subscription_failure・charge_finished(失敗)はpast_due、canceled/suspendedはrevokedにする", async () => {
  const store = tempStore();
  const issued = await issueSubscriptionLicense(store);
  const deps = { store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl: mockFetch({}) };

  const failed = await processUnivapayEvent(
    { event: "subscription_failure", data: { id: "sub_test_001", store_id: "st_test_001", status: "unpaid" } }, deps);
  assert.equal(failed.action, "past_due");
  assert.equal(store.get(issued.licenseId).status, "past_due");

  store.put({ ...store.get(issued.licenseId), status: "active" });
  const chargeFailed = await processUnivapayEvent(
    chargeFinishedEvent({ subscription_id: "sub_test_001", status: "failed" }), deps);
  assert.equal(chargeFailed.action, "past_due");

  const canceled = await processUnivapayEvent(
    { event: "subscription_canceled", data: { id: "sub_test_001", store_id: "st_test_001", status: "canceled" } }, deps);
  assert.equal(canceled.action, "revoked");
  assert.equal(store.get(issued.licenseId).status, "revoked");

  const suspended = await processUnivapayEvent(
    { event: "subscription_suspended", data: { id: "sub_test_001", store_id: "st_test_001", status: "suspended" } }, deps);
  assert.equal(suspended.action, "revoked");
});

test("webhook: 該当ライセンスなし・未対応イベントは無害に流す", async () => {
  const store = tempStore();
  const deps = { store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl: mockFetch({}) };
  assert.equal(
    (await processUnivapayEvent({ event: "subscription_canceled", data: { id: "sub_none" } }, deps)).action,
    "no_matching_license",
  );
  assert.equal((await processUnivapayEvent({ event: "token_created", data: {} }, deps)).action, "ignored");
});

// --- claim(orderId / 課金IDからのキー表示) ---

test("handleClaim: UnivaPayのorderId・課金IDでも発行済みキーを表示できる", async () => {
  const store = tempStore();
  const fetchImpl = mockFetch({
    "/stores/st_test_001/charges/ch_test_001": {
      id: "ch_test_001", status: "successful", metadata: { plan: "lifetime", "order-id": "order-uuid-1" },
    },
  });
  const issued = await processUnivapayEvent(chargeFinishedEvent(), {
    store, plans, env: univapayEnv(), signingKey: keys.privateKey, fetchImpl,
  });
  const key = store.get(issued.licenseId).key;
  assert.ok(handleClaim("order-uuid-1", { store }).html.includes(key));
  assert.ok(handleClaim("ch_test_001", { store }).html.includes(key));
  assert.equal(handleClaim("order-unknown", { store }).status, 404);
});

// --- refresh(定期課金GETによる状態確認) ---

test("refreshSubscription: 定期課金GETの状態をライセンスstatusへ反映し、照会失敗はnull", async () => {
  const store = tempStore();
  const issued = await issueSubscriptionLicense(store);
  const license = store.get(issued.licenseId);
  const env = univapayEnv();

  const current = createUnivapayProvider({ env, plans, store, fetchImpl: mockFetch(SUBSCRIPTION_ROUTES) });
  assert.equal(await current.refreshSubscription(license), "active");

  const canceled = createUnivapayProvider({
    env, plans, store,
    fetchImpl: mockFetch({ "/stores/st_test_001/subscriptions/sub_test_001": { id: "sub_test_001", status: "canceled" } }),
  });
  assert.equal(await canceled.refreshSubscription(license), "revoked");

  // 疎通失敗(404)はnull=ストアの現状維持(オフライン耐性)
  const down = createUnivapayProvider({ env, plans, store, fetchImpl: mockFetch({}) });
  assert.equal(await down.refreshSubscription(license), null);

  // 買い切りは照会しない
  assert.equal(await current.refreshSubscription({ kind: "one_time" }), null);
});

test("handleRefresh: UnivaPayプロバイダ経由でサブスク状態を反映してストアを更新する", async () => {
  const store = tempStore();
  const issued = await issueSubscriptionLicense(store);
  const key = store.get(issued.licenseId).key;
  const env = univapayEnv();

  const unpaidProvider = createUnivapayProvider({
    env, plans, store,
    fetchImpl: mockFetch({ "/stores/st_test_001/subscriptions/sub_test_001": { id: "sub_test_001", status: "unpaid" } }),
  });
  const result = await handleRefresh({ key }, { store, provider: unpaidProvider, signingKey: keys.privateKey });
  assert.deepEqual(result.json, { ok: false, status: "past_due" });
  assert.equal(store.get(issued.licenseId).status, "past_due");
});

test("licenseStatusFromUnivapaySubscription: ステータスマッピング", () => {
  assert.equal(licenseStatusFromUnivapaySubscription("current"), "active");
  assert.equal(licenseStatusFromUnivapaySubscription("completed"), "active");
  assert.equal(licenseStatusFromUnivapaySubscription("unpaid"), "past_due");
  assert.equal(licenseStatusFromUnivapaySubscription("unverified"), "past_due");
  assert.equal(licenseStatusFromUnivapaySubscription("canceled"), "revoked");
  assert.equal(licenseStatusFromUnivapaySubscription("suspended"), "revoked");
  assert.equal(licenseStatusFromUnivapaySubscription("unconfirmed"), "revoked");
});

// --- プロバイダ切替(PAYMENT_PROVIDER env) ---

test("createProvider: PAYMENT_PROVIDERでstripe/univapayを切り替え、既定はstripe、不明はエラー", () => {
  const base = { plans, store: tempStore(), stripe: {}, fetchImpl: mockFetch({}) };
  assert.equal(createProvider({ ...base, env: {} }).name, "stripe");
  assert.equal(createProvider({ ...base, env: { PAYMENT_PROVIDER: "stripe" } }).name, "stripe");
  assert.equal(createProvider({ ...base, env: univapayEnv() }).name, "univapay");
  assert.equal(createProvider({ ...base, env: { PAYMENT_PROVIDER: "UnivaPay" } }).name, "univapay");
  assert.throws(() => createProvider({ ...base, env: { PAYMENT_PROVIDER: "paypal" } }), /PAYMENT_PROVIDER/);
});

test("プロバイダのwebhookルーティング: stripeは/webhook、univapayは/webhook/univapay/…にのみ反応", () => {
  const stripeProvider = createProvider({ env: {}, plans, store: tempStore(), stripe: {} });
  assert.equal(stripeProvider.matchWebhook("POST", "/webhook"), true);
  assert.equal(stripeProvider.matchWebhook("POST", `/webhook/univapay/${WEBHOOK_SECRET}`), false);
  const univapayProvider = createProvider({ env: univapayEnv(), plans, store: tempStore(), fetchImpl: mockFetch({}) });
  assert.equal(univapayProvider.matchWebhook("POST", "/webhook"), false);
  assert.equal(univapayProvider.matchWebhook("POST", `/webhook/univapay/${WEBHOOK_SECRET}`), true);
  assert.equal(univapayProvider.matchWebhook("GET", `/webhook/univapay/${WEBHOOK_SECRET}`), false);
});
