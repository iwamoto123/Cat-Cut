// W12-1: ライセンスストア(JSONファイル永続化)のテスト
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.mjs";

function tempStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-billing-store-"));
  return path.join(dir, "data", "licenses.json");
}

function sampleRecord(overrides = {}) {
  return {
    licenseId: "lic_001",
    plan: "monthly",
    kind: "subscription",
    issuedAt: "2026-07-12T00:00:00.000Z",
    stripeCustomerId: "cus_001",
    stripeSubscriptionId: "sub_001",
    key: "catcut_v1.xxx.yyy",
    status: "active",
    stripeCheckoutSessionId: "cs_001",
    deviceIds: [],
    ...overrides,
  };
}

test("put/get: 保存したレコードを licenseId で取得できる(updatedAt付与)", () => {
  const store = createStore(tempStorePath());
  store.put(sampleRecord());
  const found = store.get("lic_001");
  assert.equal(found.plan, "monthly");
  assert.ok(found.updatedAt);
  assert.equal(store.get("lic_unknown"), null);
});

test("put: 同じ licenseId は上書き(upsert)される", () => {
  const store = createStore(tempStorePath());
  store.put(sampleRecord());
  store.put(sampleRecord({ status: "revoked" }));
  assert.equal(store.get("lic_001").status, "revoked");
});

test("put: licenseId のないレコードは拒否する", () => {
  const store = createStore(tempStorePath());
  assert.throws(() => store.put({ plan: "monthly" }), /licenseId/);
});

test("findBySessionId / findBySubscriptionId: 対応レコードを引ける", () => {
  const store = createStore(tempStorePath());
  store.put(sampleRecord());
  store.put(sampleRecord({ licenseId: "lic_002", stripeCheckoutSessionId: "cs_002", stripeSubscriptionId: "sub_002" }));
  assert.equal(store.findBySessionId("cs_002").licenseId, "lic_002");
  assert.equal(store.findBySessionId("cs_unknown"), null);
  assert.equal(store.findBySessionId(""), null);
  assert.equal(store.findBySubscriptionId("sub_001").licenseId, "lic_001");
  assert.equal(store.findBySubscriptionId("sub_unknown"), null);
});

test("永続化: 別インスタンスからも同じファイルの内容が読める", () => {
  const filePath = tempStorePath();
  createStore(filePath).put(sampleRecord());
  const reopened = createStore(filePath);
  assert.equal(reopened.get("lic_001").plan, "monthly");
  // tmpファイルが残らない(アトミック書き込みのrename完了)
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test("壊れたJSONファイルは空ストアとして扱い、次のputで復旧する", () => {
  const filePath = tempStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{broken json", "utf-8");
  const store = createStore(filePath);
  assert.equal(store.get("lic_001"), null);
  store.put(sampleRecord());
  assert.equal(store.get("lic_001").plan, "monthly");
});
