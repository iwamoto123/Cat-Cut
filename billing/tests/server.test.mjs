// W12-1: サーバハンドラ(checkout / webhookイベント分岐 / activate / refresh / claim)のテスト。
// stripe SDK はモック注入(server.mjs がハンドラ関数を分離exportしているため、HTTP起動不要)。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, signLicense, verifyLicense } from "../src/licenseKeys.mjs";
import { createStore } from "../src/store.mjs";
import {
  handleActivate,
  handleCheckout,
  handleClaim,
  handleRefresh,
  handleWebhookEvent,
  loadPlans,
  resolvePlan,
} from "../src/server.mjs";

const keys = generateKeyPair();
const plans = loadPlans();

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-billing-server-"));
  return createStore(path.join(dir, "licenses.json"));
}

function checkoutCompletedEvent(overrides = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_001",
        customer: "cus_test_001",
        subscription: "sub_test_001",
        metadata: { plan: "monthly" },
        ...overrides,
      },
    },
  };
}

// --- plans.json / resolvePlan ---

test("plans.json: 3プラン定義があり、金額フィールドを持たない", () => {
  assert.deepEqual(plans.map((p) => p.id), ["monthly", "yearly", "lifetime"]);
  for (const plan of plans) {
    assert.ok(["subscription", "one_time"].includes(plan.kind));
    assert.ok(plan.priceIdEnv.startsWith("PRICE_ID_"));
    assert.equal("price" in plan || "amount" in plan, false);
  }
});

test("resolvePlan: envからPrice IDを解決し、未知プラン・未設定envはエラー", () => {
  const env = { PRICE_ID_MONTHLY: "price_m" };
  const resolved = resolvePlan(plans, "monthly", env);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.priceId, "price_m");
  assert.equal(resolvePlan(plans, "unknown", env).ok, false);
  const noEnv = resolvePlan(plans, "yearly", env);
  assert.equal(noEnv.ok, false);
  assert.match(noEnv.error, /PRICE_ID_YEARLY/);
});

// --- POST /checkout ---

test("handleCheckout: サブスクプランは mode=subscription、成功URLにsession_idプレースホルダ", async () => {
  let created = null;
  const stripe = { checkout: { sessions: { create: async (params) => { created = params; return { url: "https://checkout.stripe.com/xxx" }; } } } };
  const env = { PRICE_ID_MONTHLY: "price_m", PUBLIC_BASE_URL: "https://billing.example.com/" };
  const result = await handleCheckout({ plan: "monthly" }, { stripe, plans, env });
  assert.equal(result.status, 200);
  assert.equal(result.json.url, "https://checkout.stripe.com/xxx");
  assert.equal(created.mode, "subscription");
  assert.deepEqual(created.line_items, [{ price: "price_m", quantity: 1 }]);
  assert.equal(created.metadata.plan, "monthly");
  // 末尾スラッシュは正規化され、claimページへ session_id が渡る
  assert.equal(created.success_url, "https://billing.example.com/license/claim?session_id={CHECKOUT_SESSION_ID}");
});

test("handleCheckout: 買い切りプランは mode=payment", async () => {
  let created = null;
  const stripe = { checkout: { sessions: { create: async (params) => { created = params; return { url: "https://checkout.stripe.com/yyy" }; } } } };
  const env = { PRICE_ID_LIFETIME: "price_l", PUBLIC_BASE_URL: "https://billing.example.com" };
  const result = await handleCheckout({ plan: "lifetime" }, { stripe, plans, env });
  assert.equal(result.status, 200);
  assert.equal(created.mode, "payment");
});

test("handleCheckout: 不明プラン・Price未設定は400でstripeを呼ばない", async () => {
  const stripe = { checkout: { sessions: { create: async () => { throw new Error("呼ばれてはいけない"); } } } };
  const env = { PUBLIC_BASE_URL: "https://billing.example.com" };
  assert.equal((await handleCheckout({ plan: "nope" }, { stripe, plans, env })).status, 400);
  assert.equal((await handleCheckout({ plan: "monthly" }, { stripe, plans, env })).status, 400);
});

// --- POST /webhook イベント分岐 ---

test("webhook checkout.session.completed: 署名済みライセンスを発行して保存する", () => {
  const store = tempStore();
  const result = handleWebhookEvent(checkoutCompletedEvent(), {
    store, plans, signingKey: keys.privateKey,
    now: () => new Date("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(result.action, "issued");
  const saved = store.findBySessionId("cs_test_001");
  assert.equal(saved.plan, "monthly");
  assert.equal(saved.kind, "subscription");
  assert.equal(saved.status, "active");
  assert.equal(saved.stripeSubscriptionId, "sub_test_001");
  assert.equal(saved.issuedAt, "2026-07-12T00:00:00.000Z");
  // 発行されたキーは公開鍵で検証できる本物の署名付き
  const verified = verifyLicense(saved.key, keys.publicKey);
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.licenseId, saved.licenseId);
});

test("webhook checkout.session.completed: 同一セッションの再送は再発行しない(冪等)", () => {
  const store = tempStore();
  const deps = { store, plans, signingKey: keys.privateKey };
  const first = handleWebhookEvent(checkoutCompletedEvent(), deps);
  const second = handleWebhookEvent(checkoutCompletedEvent(), deps);
  assert.equal(first.action, "issued");
  assert.equal(second.action, "already_issued");
  assert.equal(store.findBySessionId("cs_test_001").licenseId, first.licenseId);
});

test("webhook checkout.session.completed: 買い切りはsubscriptionなしで発行される", () => {
  const store = tempStore();
  const event = checkoutCompletedEvent({ subscription: null, metadata: { plan: "lifetime" } });
  const result = handleWebhookEvent(event, { store, plans, signingKey: keys.privateKey });
  assert.equal(result.action, "issued");
  const saved = store.get(result.licenseId);
  assert.equal(saved.kind, "one_time");
  assert.equal("stripeSubscriptionId" in saved, false);
});

test("webhook checkout.session.completed: metadata.plan が不明なら発行しない", () => {
  const store = tempStore();
  const event = checkoutCompletedEvent({ metadata: { plan: "hacked" } });
  const result = handleWebhookEvent(event, { store, plans, signingKey: keys.privateKey });
  assert.equal(result.handled, false);
  assert.equal(store.findBySessionId("cs_test_001"), null);
});

test("webhook customer.subscription.deleted: 該当ライセンスを revoked にする", () => {
  const store = tempStore();
  handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const result = handleWebhookEvent(
    { type: "customer.subscription.deleted", data: { object: { id: "sub_test_001" } } },
    { store, plans, signingKey: keys.privateKey },
  );
  assert.equal(result.action, "revoked");
  assert.equal(store.get(result.licenseId).status, "revoked");
});

test("webhook invoice.payment_failed: 該当ライセンスを past_due にする", () => {
  const store = tempStore();
  handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const result = handleWebhookEvent(
    { type: "invoice.payment_failed", data: { object: { subscription: "sub_test_001" } } },
    { store, plans, signingKey: keys.privateKey },
  );
  assert.equal(result.action, "past_due");
  assert.equal(store.get(result.licenseId).status, "past_due");
});

test("webhook: 該当ライセンスなし・未対応イベントは無害に流す", () => {
  const store = tempStore();
  const deps = { store, plans, signingKey: keys.privateKey };
  assert.equal(
    handleWebhookEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_none" } } }, deps).action,
    "no_matching_license",
  );
  assert.equal(handleWebhookEvent({ type: "payment_intent.created", data: { object: {} } }, deps).action, "ignored");
});

// --- GET /license/claim ---

test("handleClaim: 発行済みならキーを含むHTML、未発行なら処理中案内", () => {
  const store = tempStore();
  const issued = handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const found = handleClaim("cs_test_001", { store });
  assert.equal(found.status, 200);
  assert.ok(found.html.includes(store.get(issued.licenseId).key));
  const pending = handleClaim("cs_not_yet", { store });
  assert.equal(pending.status, 404);
  assert.ok(pending.html.includes("再読み込み"));
  assert.equal(handleClaim("", { store }).status, 400);
});

// --- POST /license/activate ---

test("handleActivate: 正規キーは ok=true でプランを返し、deviceIdを記録する", () => {
  const store = tempStore();
  const issued = handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const key = store.get(issued.licenseId).key;
  const result = handleActivate({ key, deviceId: "device-abc" }, { store, signingKey: keys.privateKey });
  assert.deepEqual(result.json, { ok: true, plan: "monthly", licenseId: issued.licenseId });
  assert.deepEqual(store.get(issued.licenseId).deviceIds, ["device-abc"]);
  // 同じ端末の再認証で重複記録しない
  handleActivate({ key, deviceId: "device-abc" }, { store, signingKey: keys.privateKey });
  assert.deepEqual(store.get(issued.licenseId).deviceIds, ["device-abc"]);
});

test("handleActivate: 偽署名キー・ストア未登録・失効済みを拒否する", () => {
  const store = tempStore();
  const issued = handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const key = store.get(issued.licenseId).key;

  assert.equal(handleActivate({ key: "" }, { store, signingKey: keys.privateKey }).status, 400);

  // 別鍵で署名した(=偽の)キー
  const fakeKeys = generateKeyPair();
  const fakeKey = signLicense(
    { licenseId: issued.licenseId, plan: "monthly", kind: "subscription", issuedAt: "2026-01-01T00:00:00.000Z", stripeCustomerId: "cus_x" },
    fakeKeys.privateKey,
  );
  assert.equal(handleActivate({ key: fakeKey }, { store, signingKey: keys.privateKey }).status, 400);

  // 署名は本物だがストアに存在しない
  const ghostKey = signLicense(
    { licenseId: "lic_ghost", plan: "monthly", kind: "subscription", issuedAt: "2026-01-01T00:00:00.000Z", stripeCustomerId: "cus_x" },
    keys.privateKey,
  );
  assert.equal(handleActivate({ key: ghostKey }, { store, signingKey: keys.privateKey }).status, 404);

  // 失効済み
  store.put({ ...store.get(issued.licenseId), status: "revoked" });
  const revoked = handleActivate({ key }, { store, signingKey: keys.privateKey });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.json.ok, false);
});

// --- POST /license/refresh ---

test("handleRefresh: サブスクはStripeの状態を反映してストアを更新する", async () => {
  const store = tempStore();
  const issued = handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const key = store.get(issued.licenseId).key;

  const activeStripe = { subscriptions: { retrieve: async () => ({ status: "active" }) } };
  const active = await handleRefresh({ key }, { store, stripe: activeStripe, signingKey: keys.privateKey });
  assert.deepEqual(active.json, { ok: true, status: "active" });

  const canceledStripe = { subscriptions: { retrieve: async () => ({ status: "canceled" }) } };
  const canceled = await handleRefresh({ key }, { store, stripe: canceledStripe, signingKey: keys.privateKey });
  assert.deepEqual(canceled.json, { ok: false, status: "revoked" });
  assert.equal(store.get(issued.licenseId).status, "revoked");
});

test("handleRefresh: Stripe疎通失敗時はストアの現状を返す(オフライン耐性)", async () => {
  const store = tempStore();
  const issued = handleWebhookEvent(checkoutCompletedEvent(), { store, plans, signingKey: keys.privateKey });
  const key = store.get(issued.licenseId).key;
  const downStripe = { subscriptions: { retrieve: async () => { throw new Error("network down"); } } };
  const result = await handleRefresh({ key }, { store, stripe: downStripe, signingKey: keys.privateKey });
  assert.deepEqual(result.json, { ok: true, status: "active" });
});

test("handleRefresh: 買い切りはStripe照会せずストアの状態を返す", async () => {
  const store = tempStore();
  const event = checkoutCompletedEvent({ subscription: null, metadata: { plan: "lifetime" } });
  const issued = handleWebhookEvent(event, { store, plans, signingKey: keys.privateKey });
  const key = store.get(issued.licenseId).key;
  const stripe = { subscriptions: { retrieve: async () => { throw new Error("呼ばれてはいけない"); } } };
  const result = await handleRefresh({ key }, { store, stripe, signingKey: keys.privateKey });
  assert.deepEqual(result.json, { ok: true, status: "active" });
});
