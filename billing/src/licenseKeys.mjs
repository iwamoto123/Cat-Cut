// W12-1: ライセンスキーの純関数群(鍵生成・署名・検証・パース)。
//
// キー形式: catcut_v1.<base64url(payloadJSON)>.<base64url(signature)>
// payload = {
//   licenseId: string,            // 発行時に採番するUUID
//   plan: string,                 // plans.json のプランID(monthly/yearly/lifetime)
//   kind: "subscription"|"one_time",
//   issuedAt: string,             // ISO8601
//   stripeCustomerId: string,
//   stripeSubscriptionId?: string // サブスクプランのみ
// }
//
// 署名は Ed25519。秘密鍵はサーバ(.envのLICENSE_SIGNING_KEY)のみが持ち、
// デスクトップアプリには公開鍵のみを同梱する(オフラインでも真正性検証可能)。
// 鍵のシリアライズ形式: 秘密鍵=PKCS#8 DER の base64 / 公開鍵=SPKI DER の base64。
import crypto from "node:crypto";

export const LICENSE_KEY_PREFIX = "catcut_v1";

/** ペイロードの必須フィールド。パース・署名の両方で検証する。 */
const REQUIRED_PAYLOAD_FIELDS = ["licenseId", "plan", "kind", "issuedAt", "stripeCustomerId"];
const VALID_KINDS = ["subscription", "one_time"];

/**
 * Ed25519鍵ペアを生成する。
 * 戻り値はどちらも base64 文字列(秘密鍵=PKCS#8 DER / 公開鍵=SPKI DER)。
 */
export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function importPrivateKey(privateKeyBase64) {
  return crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    type: "pkcs8",
    format: "der",
  });
}

function importPublicKey(publicKeyBase64) {
  return crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    type: "spki",
    format: "der",
  });
}

/** 秘密鍵(base64 PKCS#8)から対応する公開鍵(base64 SPKI)を導出する。 */
export function derivePublicKey(privateKeyBase64) {
  const publicKey = crypto.createPublicKey(importPrivateKey(privateKeyBase64));
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "ペイロードがオブジェクトではありません";
  }
  for (const field of REQUIRED_PAYLOAD_FIELDS) {
    if (typeof payload[field] !== "string" || !payload[field]) {
      return `ペイロードに ${field} がありません`;
    }
  }
  if (!VALID_KINDS.includes(payload.kind)) {
    return `kind が不正です: ${payload.kind}`;
  }
  return null;
}

/**
 * ペイロードに署名してライセンスキー文字列を返す。
 * 署名対象は base64url エンコード後のペイロード文字列(検証側と揃えるため)。
 */
export function signLicense(payload, privateKeyBase64) {
  const invalid = validatePayload(payload);
  if (invalid) throw new Error(invalid);
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payloadPart, "utf-8"), importPrivateKey(privateKeyBase64));
  return `${LICENSE_KEY_PREFIX}.${payloadPart}.${signature.toString("base64url")}`;
}

/**
 * キー文字列を形式チェックしてペイロードを取り出す(署名検証はしない)。
 * 戻り値: { ok: true, payload, payloadPart, signaturePart } | { ok: false, error }
 */
export function parseLicenseKey(key) {
  if (typeof key !== "string" || !key.trim()) {
    return { ok: false, error: "キーが空です" };
  }
  const parts = key.trim().split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "キー形式が不正です(3パートではありません)" };
  }
  const [prefix, payloadPart, signaturePart] = parts;
  if (prefix !== LICENSE_KEY_PREFIX) {
    return { ok: false, error: `キー形式が不正です(接頭辞が ${LICENSE_KEY_PREFIX} ではありません)` };
  }
  if (!payloadPart || !signaturePart) {
    return { ok: false, error: "キー形式が不正です(空のパートがあります)" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf-8"));
  } catch {
    return { ok: false, error: "ペイロードを読み取れません" };
  }
  const invalid = validatePayload(payload);
  if (invalid) return { ok: false, error: invalid };
  return { ok: true, payload, payloadPart, signaturePart };
}

/**
 * キーの署名を公開鍵(base64 SPKI)で検証する。
 * 戻り値: { ok: true, payload } | { ok: false, error }
 */
export function verifyLicense(key, publicKeyBase64) {
  const parsed = parseLicenseKey(key);
  if (!parsed.ok) return parsed;
  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(parsed.payloadPart, "utf-8"),
      importPublicKey(publicKeyBase64),
      Buffer.from(parsed.signaturePart, "base64url"),
    );
  } catch {
    return { ok: false, error: "署名を検証できません(公開鍵が不正です)" };
  }
  if (!valid) return { ok: false, error: "署名が一致しません(キーが改ざんされています)" };
  return { ok: true, payload: parsed.payload };
}
