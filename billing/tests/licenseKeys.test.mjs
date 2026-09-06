// W12-1: ライセンスキー純関数(署名・検証・改ざん検知・パース異常系)のテスト
import test from "node:test";
import assert from "node:assert/strict";
import {
  LICENSE_KEY_PREFIX,
  derivePublicKey,
  generateKeyPair,
  parseLicenseKey,
  signLicense,
  verifyLicense,
} from "../src/licenseKeys.mjs";

const keys = generateKeyPair();

function samplePayload(overrides = {}) {
  return {
    licenseId: "lic_test_001",
    plan: "monthly",
    kind: "subscription",
    issuedAt: "2026-07-12T00:00:00.000Z",
    stripeCustomerId: "cus_test_001",
    stripeSubscriptionId: "sub_test_001",
    ...overrides,
  };
}

test("generateKeyPair: base64の鍵ペアを返し、毎回異なる", () => {
  assert.ok(keys.privateKey.length > 0);
  assert.ok(keys.publicKey.length > 0);
  const other = generateKeyPair();
  assert.notEqual(other.privateKey, keys.privateKey);
  assert.notEqual(other.publicKey, keys.publicKey);
});

test("derivePublicKey: 秘密鍵から対応する公開鍵を導出できる", () => {
  assert.equal(derivePublicKey(keys.privateKey), keys.publicKey);
});

test("signLicense→verifyLicense: 往復でペイロードが一致する", () => {
  const payload = samplePayload();
  const key = signLicense(payload, keys.privateKey);
  assert.ok(key.startsWith(`${LICENSE_KEY_PREFIX}.`));
  const verified = verifyLicense(key, keys.publicKey);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.payload, payload);
});

test("signLicense: 買い切り(one_time)はstripeSubscriptionIdなしで署名できる", () => {
  const payload = samplePayload({ kind: "one_time" });
  delete payload.stripeSubscriptionId;
  const key = signLicense(payload, keys.privateKey);
  const verified = verifyLicense(key, keys.publicKey);
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.kind, "one_time");
  assert.equal("stripeSubscriptionId" in verified.payload, false);
});

test("signLicense: 必須フィールド欠落・不正kindはthrow", () => {
  const missing = samplePayload();
  delete missing.licenseId;
  assert.throws(() => signLicense(missing, keys.privateKey), /licenseId/);
  assert.throws(() => signLicense(samplePayload({ kind: "trial" }), keys.privateKey), /kind/);
});

test("verifyLicense: ペイロード改ざんを検知する", () => {
  const key = signLicense(samplePayload(), keys.privateKey);
  const [prefix, , signaturePart] = key.split(".");
  // planをlifetimeに書き換えたペイロードへ差し替え(署名は元のまま)
  const tamperedPayload = Buffer.from(
    JSON.stringify(samplePayload({ plan: "lifetime", kind: "one_time" })),
    "utf-8",
  ).toString("base64url");
  const tampered = `${prefix}.${tamperedPayload}.${signaturePart}`;
  const verified = verifyLicense(tampered, keys.publicKey);
  assert.equal(verified.ok, false);
  assert.match(verified.error, /改ざん/);
});

test("verifyLicense: 署名部の改ざん・別鍵の署名を拒否する", () => {
  const key = signLicense(samplePayload(), keys.privateKey);
  const [prefix, payloadPart] = key.split(".");
  const brokenSig = `${prefix}.${payloadPart}.${Buffer.from("x".repeat(64)).toString("base64url")}`;
  assert.equal(verifyLicense(brokenSig, keys.publicKey).ok, false);

  // 別の鍵ペアで署名したキーは、元の公開鍵では検証できない
  const otherKeys = generateKeyPair();
  const otherKey = signLicense(samplePayload(), otherKeys.privateKey);
  assert.equal(verifyLicense(otherKey, keys.publicKey).ok, false);
});

test("parseLicenseKey: 正常なキーからペイロードを取り出せる", () => {
  const key = signLicense(samplePayload(), keys.privateKey);
  const parsed = parseLicenseKey(key);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.licenseId, "lic_test_001");
  // 前後の空白は無視する(コピペ対策)
  assert.equal(parseLicenseKey(`  ${key}  \n`).ok, true);
});

test("parseLicenseKey: 異常系(空・パート数・接頭辞・JSON破損・フィールド欠落)", () => {
  assert.equal(parseLicenseKey("").ok, false);
  assert.equal(parseLicenseKey(null).ok, false);
  assert.equal(parseLicenseKey("catcut_v1.onlytwo").ok, false);
  assert.equal(parseLicenseKey("a.b.c.d").ok, false);

  const key = signLicense(samplePayload(), keys.privateKey);
  const [, payloadPart, signaturePart] = key.split(".");
  assert.equal(parseLicenseKey(`wrong_v9.${payloadPart}.${signaturePart}`).ok, false);

  const notJson = Buffer.from("not-json", "utf-8").toString("base64url");
  assert.equal(parseLicenseKey(`catcut_v1.${notJson}.${signaturePart}`).ok, false);

  const noPlan = samplePayload();
  delete noPlan.plan;
  const noPlanPart = Buffer.from(JSON.stringify(noPlan), "utf-8").toString("base64url");
  const parsed = parseLicenseKey(`catcut_v1.${noPlanPart}.${signaturePart}`);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /plan/);
});
