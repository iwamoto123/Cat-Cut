// W12-2: ライセンス純関数(パース・Web Crypto署名検証・ステータス導出)のテスト。
// 署名の生成はbilling側(node:crypto Ed25519)と同じ方式で行い、
// renderer側のWeb Crypto検証と相互運用できることを確認する。
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  GRACE_PERIOD_DAYS,
  LICENSE_KEY_PREFIX,
  LICENSE_PUBLIC_KEY,
  REFRESH_INTERVAL_DAYS,
  licenseStatus,
  licenseStatusLabel,
  parseLicenseKey,
  resolveLicenseStatus,
  verifyLicenseSignature,
  type LicensePayload,
  type StoredLicense,
} from "../src/lib/license.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// billing/src/licenseKeys.mjs と同じ発行ロジック(テスト用ミニ実装)
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function samplePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
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

function issueKey(payload: LicensePayload): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payloadPart, "utf-8"), privateKey);
  return `${LICENSE_KEY_PREFIX}.${payloadPart}.${signature.toString("base64url")}`;
}

function storedLicense(overrides: Partial<StoredLicense> = {}, payloadOverrides: Partial<LicensePayload> = {}): StoredLicense {
  const payload = samplePayload(payloadOverrides);
  return {
    key: issueKey(payload),
    payload,
    serverStatus: "active",
    activatedAt: "2026-07-12T00:00:00.000Z",
    lastVerifiedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

// --- parseLicenseKey ---

test("parseLicenseKey: 正規キーからペイロードを取り出せる(前後空白は無視)", () => {
  const key = issueKey(samplePayload());
  const parsed = parseLicenseKey(key);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.payload.licenseId, "lic_test_001");
    assert.equal(parsed.payload.kind, "subscription");
  }
  assert.equal(parseLicenseKey(`  ${key}\n`).ok, true);
});

test("parseLicenseKey: 異常系(空・形式不正・接頭辞違い・JSON破損・フィールド欠落)", () => {
  assert.equal(parseLicenseKey("").ok, false);
  assert.equal(parseLicenseKey("catcut_v1.onlytwo").ok, false);
  assert.equal(parseLicenseKey("a.b.c.d").ok, false);

  const key = issueKey(samplePayload());
  const [, payloadPart, signaturePart] = key.split(".");
  assert.equal(parseLicenseKey(`wrong_v9.${payloadPart}.${signaturePart}`).ok, false);

  const notJson = Buffer.from("not-json", "utf-8").toString("base64url");
  assert.equal(parseLicenseKey(`${LICENSE_KEY_PREFIX}.${notJson}.${signaturePart}`).ok, false);

  const noPlan = samplePayload() as Record<string, unknown>;
  delete noPlan.plan;
  const noPlanPart = Buffer.from(JSON.stringify(noPlan), "utf-8").toString("base64url");
  assert.equal(parseLicenseKey(`${LICENSE_KEY_PREFIX}.${noPlanPart}.${signaturePart}`).ok, false);

  const badKind = samplePayload({ kind: "trial" as LicensePayload["kind"] });
  const badKindPart = Buffer.from(JSON.stringify(badKind), "utf-8").toString("base64url");
  assert.equal(parseLicenseKey(`${LICENSE_KEY_PREFIX}.${badKindPart}.${signaturePart}`).ok, false);
});

// --- verifyLicenseSignature (Web Crypto Ed25519) ---

test("verifyLicenseSignature: node:cryptoで署名したキーをWeb Cryptoで検証できる", async () => {
  const key = issueKey(samplePayload());
  assert.equal(await verifyLicenseSignature(key, publicKeyBase64), true);
});

test("verifyLicenseSignature: ペイロード改ざん・別鍵署名・不正な公開鍵を拒否する", async () => {
  const key = issueKey(samplePayload());
  const [prefix, , signaturePart] = key.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify(samplePayload({ plan: "lifetime", kind: "one_time" })),
    "utf-8",
  ).toString("base64url");
  assert.equal(await verifyLicenseSignature(`${prefix}.${tamperedPayload}.${signaturePart}`, publicKeyBase64), false);

  // 別の鍵で署名されたキー
  const otherPair = crypto.generateKeyPairSync("ed25519");
  const otherPayloadPart = Buffer.from(JSON.stringify(samplePayload()), "utf-8").toString("base64url");
  const otherSig = crypto.sign(null, Buffer.from(otherPayloadPart, "utf-8"), otherPair.privateKey);
  const otherKey = `${LICENSE_KEY_PREFIX}.${otherPayloadPart}.${otherSig.toString("base64url")}`;
  assert.equal(await verifyLicenseSignature(otherKey, publicKeyBase64), false);

  // 公開鍵が壊れていても例外ではなくfalse
  assert.equal(await verifyLicenseSignature(key, "not-a-valid-key"), false);
});

test("verifyLicenseSignature: 公開鍵が空(プレースホルダ)なら検証スキップでfalse", async () => {
  const key = issueKey(samplePayload());
  assert.equal(await verifyLicenseSignature(key, ""), false);
  // 同梱定数は現時点で空文字プレースホルダ(金額決定後に貼り替える規約)
  assert.equal(LICENSE_PUBLIC_KEY, "");
});

// --- licenseStatus (猶予期間の判定) ---

test("licenseStatus: 未認証はunlicensed、失効(revoked)はexpired", () => {
  const nowMs = Date.parse("2026-07-12T00:00:00.000Z");
  assert.equal(licenseStatus(null, nowMs), "unlicensed");
  assert.equal(licenseStatus(storedLicense({ serverStatus: "revoked" }), nowMs), "expired");
});

test("licenseStatus: 買い切りはrefreshなしでもずっとactive", () => {
  const base = Date.parse("2026-07-12T00:00:00.000Z");
  const license = storedLicense({}, { kind: "one_time" });
  assert.equal(licenseStatus(license, base + 365 * DAY_MS), "active");
  // 買い切りでも失効(返金等でrevoked)は反映される
  assert.equal(licenseStatus({ ...license, serverStatus: "revoked" }, base), "expired");
});

test("licenseStatus: サブスクはlastVerifiedAtからの経過で active→grace→expired", () => {
  const verifiedAt = "2026-07-12T00:00:00.000Z";
  const base = Date.parse(verifiedAt);
  const license = storedLicense({ lastVerifiedAt: verifiedAt });
  // 7日以内はactive
  assert.equal(licenseStatus(license, base), "active");
  assert.equal(licenseStatus(license, base + REFRESH_INTERVAL_DAYS * DAY_MS), "active");
  // 7日超〜30日以内はgrace(オフライン猶予)
  assert.equal(licenseStatus(license, base + (REFRESH_INTERVAL_DAYS + 1) * DAY_MS), "grace");
  assert.equal(licenseStatus(license, base + GRACE_PERIOD_DAYS * DAY_MS), "grace");
  // 30日超はexpired
  assert.equal(licenseStatus(license, base + (GRACE_PERIOD_DAYS + 1) * DAY_MS), "expired");
});

test("licenseStatus: 支払い保留(past_due)は猶予期間内grace、超過でexpired", () => {
  const verifiedAt = "2026-07-12T00:00:00.000Z";
  const base = Date.parse(verifiedAt);
  const license = storedLicense({ serverStatus: "past_due", lastVerifiedAt: verifiedAt });
  assert.equal(licenseStatus(license, base), "grace");
  assert.equal(licenseStatus(license, base + (GRACE_PERIOD_DAYS + 1) * DAY_MS), "expired");
});

test("licenseStatus: lastVerifiedAtが読めない場合は安全側(expired)に倒す", () => {
  const license = storedLicense({ lastVerifiedAt: "invalid-date" });
  assert.equal(licenseStatus(license, Date.now()), "expired");
});

// --- resolveLicenseStatus (署名検証込みの複合判定) ---

test("resolveLicenseStatus: 署名が正当ならlicenseStatusの結果、公開鍵未設定ならunlicensed", async () => {
  const nowMs = Date.parse("2026-07-12T00:00:00.000Z");
  const license = storedLicense();
  assert.equal(await resolveLicenseStatus(license, publicKeyBase64, nowMs), "active");
  // 公開鍵プレースホルダ(空)の間は認証済みデータがあってもunlicensed
  assert.equal(await resolveLicenseStatus(license, "", nowMs), "unlicensed");
  assert.equal(await resolveLicenseStatus(null, publicKeyBase64, nowMs), "unlicensed");
});

test("resolveLicenseStatus: 改ざんされた保存データはunlicensed", async () => {
  const nowMs = Date.parse("2026-07-12T00:00:00.000Z");
  const license = storedLicense();
  const [prefix, , signaturePart] = license.key.split(".");
  const tamperedPart = Buffer.from(
    JSON.stringify(samplePayload({ plan: "lifetime" })),
    "utf-8",
  ).toString("base64url");
  const tampered = { ...license, key: `${prefix}.${tamperedPart}.${signaturePart}` };
  assert.equal(await resolveLicenseStatus(tampered, publicKeyBase64, nowMs), "unlicensed");
});

// --- licenseStatusLabel ---

test("licenseStatusLabel: 各ステータスの日本語ラベル", () => {
  assert.equal(licenseStatusLabel("unlicensed"), "未認証");
  assert.equal(licenseStatusLabel("active"), "有効");
  assert.equal(licenseStatusLabel("grace"), "要再確認(猶予期間中)");
  assert.equal(licenseStatusLabel("expired"), "失効");
});
