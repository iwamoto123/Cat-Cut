// W12-2: ライセンスの純関数(キー形式パース・Web Crypto署名検証・ステータス導出)。
//
// キー形式: catcut_v1.<base64url(payloadJSON)>.<base64url(signature)>
// billing/src/licenseKeys.mjs(発行側)と形式・署名対象を揃えること。
// window等に依存しないため node --test でそのままテストできる。

/**
 * ライセンス検証用の公開鍵(base64 SPKI)。billing/scripts/generate-keys.mjs の
 * 出力を貼る。空文字プレースホルダの間は署名検証をスキップし unlicensed 扱いにする。
 * main/license.cjs の同名定数と同じ値を設定すること。
 */
export const LICENSE_PUBLIC_KEY = "";

export const LICENSE_KEY_PREFIX = "catcut_v1";

/** サブスクの再確認(refresh)推奨間隔。これを超えると grace に落とす。 */
export const REFRESH_INTERVAL_DAYS = 7;
/** lastVerifiedAt からの猶予期間。これを超えると expired に落とす。 */
export const GRACE_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type LicenseKind = "subscription" | "one_time";

export type LicensePayload = {
  licenseId: string;
  plan: string;
  kind: LicenseKind;
  issuedAt: string;
  stripeCustomerId: string;
  stripeSubscriptionId?: string;
};

export type StoredLicense = {
  key: string;
  payload: LicensePayload;
  /** billing-server確認時点の状態。 */
  serverStatus: string;
  activatedAt: string;
  lastVerifiedAt: string;
};

/**
 * アプリ内でのライセンス状態。
 * - unlicensed: 未認証(または公開鍵未設定で検証不能)
 * - active:     有効(サブスクは7日以内に確認済み)
 * - grace:      要再確認(オフライン等で確認が古い/支払い保留)。猶予期間内は動作継続
 * - expired:    失効(解約済み or 猶予期間超過)
 */
export type LicenseStatus = "unlicensed" | "active" | "grace" | "expired";

export type ParsedLicenseKey =
  | { ok: true; payload: LicensePayload; payloadPart: string; signaturePart: string }
  | { ok: false; error: string };

/** base64url → バイト列(atobはbase64のみ対応のため変換してから使う)。 */
function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  // Web CryptoのBufferSourceはArrayBuffer裏付けを要求するため明示的に確保する
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** キー文字列の形式チェック+ペイロード取り出し(署名検証はしない)。 */
export function parseLicenseKey(key: string): ParsedLicenseKey {
  if (typeof key !== "string" || !key.trim()) return { ok: false, error: "キーが空です" };
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_KEY_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, error: "ライセンスキーの形式が正しくありません" };
  }
  let payload: LicensePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch {
    return { ok: false, error: "ライセンスキーを読み取れません" };
  }
  const record = payload as unknown as Record<string, unknown>;
  for (const field of ["licenseId", "plan", "kind", "issuedAt", "stripeCustomerId"]) {
    if (typeof record[field] !== "string" || !record[field]) {
      return { ok: false, error: "ライセンスキーの内容が不完全です" };
    }
  }
  if (payload.kind !== "subscription" && payload.kind !== "one_time") {
    return { ok: false, error: "ライセンスキーの種別が不正です" };
  }
  return { ok: true, payload, payloadPart: parts[1], signaturePart: parts[2] };
}

/**
 * Web Crypto(Ed25519)によるローカル署名検証。
 * 公開鍵が空文字プレースホルダの間は false(=unlicensed扱い)を返す。
 */
export async function verifyLicenseSignature(key: string, publicKeyBase64: string): Promise<boolean> {
  if (!publicKeyBase64) return false;
  const parsed = parseLicenseKey(key);
  if (!parsed.ok) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(publicKeyBase64),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlToBytes(parsed.signaturePart),
      new TextEncoder().encode(parsed.payloadPart),
    );
  } catch {
    return false;
  }
}

/**
 * 保存済みライセンスからアプリ内ステータスを導出する(署名検証済み前提)。
 * - 買い切り(one_time)は失効(revoked)以外は常に active
 * - サブスクは lastVerifiedAt からの経過で active(7日以内)→grace→expired(30日超)
 * - 支払い保留(past_due)は猶予期間内なら grace
 */
export function licenseStatus(license: StoredLicense | null, nowMs: number): LicenseStatus {
  if (!license) return "unlicensed";
  if (license.serverStatus === "revoked") return "expired";
  if (license.payload.kind === "one_time") return "active";
  const verifiedMs = Date.parse(license.lastVerifiedAt);
  if (!Number.isFinite(verifiedMs)) return "expired";
  const elapsedDays = (nowMs - verifiedMs) / DAY_MS;
  if (elapsedDays > GRACE_PERIOD_DAYS) return "expired";
  if (license.serverStatus === "past_due") return "grace";
  if (elapsedDays > REFRESH_INTERVAL_DAYS) return "grace";
  return "active";
}

/**
 * 署名検証込みのステータス解決。公開鍵未設定・署名不正はいずれも unlicensed
 * (=課金基盤が有効化されるまでは全ユーザーがこの状態)。
 */
export async function resolveLicenseStatus(
  license: StoredLicense | null,
  publicKeyBase64: string,
  nowMs: number,
): Promise<LicenseStatus> {
  if (!license) return "unlicensed";
  const verified = await verifyLicenseSignature(license.key, publicKeyBase64);
  if (!verified) return "unlicensed";
  return licenseStatus(license, nowMs);
}

/** UI表示用のステータスラベル。 */
export function licenseStatusLabel(status: LicenseStatus): string {
  if (status === "active") return "有効";
  if (status === "grace") return "要再確認(猶予期間中)";
  if (status === "expired") return "失効";
  return "未認証";
}
