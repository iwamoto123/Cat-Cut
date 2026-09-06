// W12-2: ライセンス基盤(main側)。
//
// - userData/license.json の読み書き(0600)
// - 公開鍵によるローカル署名検証(オフラインでも真正性を確認できる)
// - billing-server(editor/billing/)への activate / refresh / checkout 呼び出し
//
// FEATURES.billing(App.tsx)が false の間はUIから一切呼ばれないが、
// IPC自体は常時登録しておく(フラグONだけで動く状態にするため)。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// billing-server のURL。未デプロイのため空文字プレースホルダ。
// 金額決定後にデプロイ先URL(例: "https://billing.example.com")を設定する。
const BILLING_SERVER_URL = "";

// ライセンス検証用の公開鍵(base64 SPKI)。billing/scripts/generate-keys.mjs の
// 出力を貼る。空の間はローカル署名検証をスキップする(=課金機能は事実上無効)。
const LICENSE_PUBLIC_KEY = "";

const LICENSE_KEY_PREFIX = "catcut_v1";

/** キー文字列の形式チェック+ペイロード取り出し(署名検証はしない)。 */
function parseLicenseKey(key) {
  if (typeof key !== "string" || !key.trim()) return { ok: false, error: "キーが空です" };
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_KEY_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, error: "ライセンスキーの形式が正しくありません" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return { ok: false, error: "ライセンスキーを読み取れません" };
  }
  for (const field of ["licenseId", "plan", "kind", "issuedAt", "stripeCustomerId"]) {
    if (typeof payload[field] !== "string" || !payload[field]) {
      return { ok: false, error: "ライセンスキーの内容が不完全です" };
    }
  }
  return { ok: true, payload, payloadPart: parts[1], signaturePart: parts[2] };
}

/**
 * 公開鍵(base64 SPKI)でローカル署名検証する。
 * 戻り値: true=正当 / false=改ざん / null=公開鍵未設定で検証スキップ
 */
function verifyLicenseLocally(key, publicKeyBase64) {
  if (!publicKeyBase64) return null;
  const parsed = parseLicenseKey(key);
  if (!parsed.ok) return false;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      type: "spki",
      format: "der",
    });
    return crypto.verify(
      null,
      Buffer.from(parsed.payloadPart, "utf-8"),
      publicKey,
      Buffer.from(parsed.signaturePart, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * ライセンスモジュール本体。依存(userDataPath / fetch / 定数)を注入できる形にして
 * テスト・将来のサーバURL差し替えを容易にする。
 */
function createLicenseModule(deps) {
  const {
    userDataPath,
    fetchFn = fetch,
    serverUrl = BILLING_SERVER_URL,
    publicKey = LICENSE_PUBLIC_KEY,
    now = () => new Date(),
  } = deps;

  function licenseFilePath() {
    return userDataPath("license.json");
  }

  /** userData/license.json を読む。壊れていれば null(未認証扱い)。 */
  function readStoredLicense() {
    const filePath = licenseFilePath();
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.key !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** license.json へ保存(APIキーと同様に0600)。 */
  function writeStoredLicense(license) {
    const filePath = licenseFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(license, null, 2)}\n`, { mode: 0o600, encoding: "utf-8" });
  }

  /**
   * この端末の匿名ID。初回アクセス時に採番してuserDataへ永続化する
   * (billing-server側で端末数を把握するためのもの。個人情報は含まない)。
   */
  function getDeviceId() {
    const filePath = userDataPath("license_device_id.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed.deviceId === "string" && parsed.deviceId) return parsed.deviceId;
    } catch {
      // 初回 or 破損時は下で再採番する
    }
    const deviceId = crypto.randomUUID();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ deviceId }, null, 2)}\n`, { mode: 0o600, encoding: "utf-8" });
    return deviceId;
  }

  async function postJson(pathname, body) {
    const response = await fetchFn(`${serverUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  /** IPC license:get: 保存済みライセンスとローカル署名検証結果を返す。 */
  function getLicenseState() {
    const license = readStoredLicense();
    return {
      license,
      deviceId: getDeviceId(),
      // true=正当 / false=改ざん / null=公開鍵未設定 or 未認証
      locallyVerified: license ? verifyLicenseLocally(license.key, publicKey) : null,
      billingServerConfigured: Boolean(serverUrl),
    };
  }

  /** IPC license:activate: サーバ認証+ローカル保存。 */
  async function activate(input) {
    const key = String(input?.key || "").trim();
    if (!key) return { ok: false, error: "ライセンスキーを入力してください" };
    const parsed = parseLicenseKey(key);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const verified = verifyLicenseLocally(key, publicKey);
    if (verified === false) return { ok: false, error: "ライセンスキーの署名が正しくありません" };
    if (!serverUrl) return { ok: false, error: "課金サーバが未設定です(BILLING_SERVER_URL)" };
    try {
      const result = await postJson("/license/activate", { key, deviceId: getDeviceId() });
      if (!result.ok) return { ok: false, error: result.error || "認証に失敗しました" };
      const nowIso = now().toISOString();
      const license = {
        key,
        payload: parsed.payload,
        serverStatus: "active",
        activatedAt: nowIso,
        lastVerifiedAt: nowIso,
      };
      writeStoredLicense(license);
      return { ok: true, license };
    } catch {
      return { ok: false, error: "課金サーバに接続できません。ネットワークを確認してください" };
    }
  }

  /** IPC license:deactivate: ローカルのライセンス保存を破棄する(この端末の解除)。 */
  function deactivate() {
    try {
      fs.rmSync(licenseFilePath(), { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * IPC license:refresh: サーバへ状態確認して lastVerifiedAt を更新する。
   * 通信失敗時はローカル状態を変えずに返す(lastVerifiedAtから30日の猶予は
   * renderer側 lib/license.ts の licenseStatus が判定する)。
   */
  async function refresh() {
    const license = readStoredLicense();
    if (!license) return { ok: false, error: "ライセンスが未登録です", license: null };
    // 買い切りはサーバ照会不要(失効はactivate時のみ確認)
    if (license.payload?.kind === "one_time") return { ok: true, license };
    if (!serverUrl) return { ok: false, error: "課金サーバが未設定です(BILLING_SERVER_URL)", license };
    try {
      const result = await postJson("/license/refresh", { key: license.key });
      const updated = {
        ...license,
        serverStatus: result.status || license.serverStatus,
        lastVerifiedAt: now().toISOString(),
      };
      writeStoredLicense(updated);
      return { ok: Boolean(result.ok), license: updated };
    } catch {
      return { ok: false, error: "課金サーバに接続できません", license };
    }
  }

  /** IPC license:checkout: /checkout でCheckout URLを取得する(開くのはrenderer側)。 */
  async function startCheckout(input) {
    const plan = String(input?.plan || "").trim();
    if (!plan) return { ok: false, error: "プランを指定してください" };
    if (!serverUrl) return { ok: false, error: "課金サーバが未設定です(BILLING_SERVER_URL)" };
    try {
      const result = await postJson("/checkout", { plan });
      if (!result.url) return { ok: false, error: result.error || "決済ページを作成できませんでした" };
      return { ok: true, url: result.url };
    } catch {
      return { ok: false, error: "課金サーバに接続できません。ネットワークを確認してください" };
    }
  }

  return { getLicenseState, activate, deactivate, refresh, startCheckout, getDeviceId };
}

/** ipcMain へのハンドラ登録(index.cjs から1行で呼べるように分離)。 */
function registerLicenseIpc(ipcMain, licenseModule) {
  ipcMain.handle("license:get", () => licenseModule.getLicenseState());
  ipcMain.handle("license:activate", (_event, input) => licenseModule.activate(input || {}));
  ipcMain.handle("license:deactivate", () => licenseModule.deactivate());
  ipcMain.handle("license:refresh", () => licenseModule.refresh());
  ipcMain.handle("license:checkout", (_event, input) => licenseModule.startCheckout(input || {}));
}

module.exports = {
  BILLING_SERVER_URL,
  LICENSE_PUBLIC_KEY,
  parseLicenseKey,
  verifyLicenseLocally,
  createLicenseModule,
  registerLicenseIpc,
};
