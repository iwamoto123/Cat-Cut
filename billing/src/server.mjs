// W12-1: Cat-Cut 課金サーバ(決済ページ + ライセンスキー発行)。
// W12-4: 決済プロバイダを抽象化し、Stripe / UnivaPay を PAYMENT_PROVIDER env で切替可能にした。
//        Stripe固有ロジックは providers/stripeProvider.mjs へ移設(既存テスト互換のため re-export)。
//
// 依存は stripe SDK のみ(UnivaPayは標準fetchで直接API呼び出し)。HTTPは node:http 標準モジュール。
// テスト容易性のため、各エンドポイントのロジックは handleXxx 純関数(deps注入)として
// 分離し、createRequestListener がルーティング+JSONパースだけを担当する。
//
// エンドポイント:
//   POST /checkout          {plan}            → 決済ページURLを作成して {url}(プロバイダ共通契約)
//   POST /webhook           (Stripe署名付き)   → ライセンス発行・失効(Stripe採用時)
//   POST /webhook/univapay/<secret>           → 同上(UnivaPay採用時。パス内シークレット+API照会で認証)
//   GET  /license/claim?session_id|order_id|charge_id=xxx → 発行済みキー表示の簡易HTML(購入完了ページ)
//   POST /license/activate  {key, deviceId}   → 署名検証+失効確認 → {ok, plan, licenseId}
//   POST /license/refresh   {key}             → ストア+プロバイダのサブスク状態確認 → {ok, status}
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivePublicKey, verifyLicense } from "./licenseKeys.mjs";
import { createStore } from "./store.mjs";
import { createProvider } from "./providers/index.mjs";
import { createStripeProvider } from "./providers/stripeProvider.mjs";

// W12-4: 既存テスト・外部利用との互換のため、Stripe固有の純関数を re-export する
export { handleCheckout, handleWebhookEvent, resolvePlan } from "./providers/stripeProvider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** config/plans.json を読む。金額は持たない(Stripe Price / UnivaPay env が正)。 */
export function loadPlans(plansPath = path.join(__dirname, "..", "config", "plans.json")) {
  const parsed = JSON.parse(fs.readFileSync(plansPath, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error("plans.json は配列である必要があります");
  return parsed;
}

/**
 * GET /license/claim: 購入完了ページから参照する簡易HTML。
 * identifier は Stripe の Checkout セッションID、または UnivaPay の
 * orderId(metadata の order-id)・課金ID のいずれでもよい(W12-4)。
 */
export function handleClaim(identifier, { store }) {
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const page = (title, bodyHtml) => `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1f2937}
code{display:block;background:#f3f4f6;padding:16px;word-break:break-all;font-size:13px;margin:16px 0}</style>
</head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`;

  if (!identifier) {
    return { status: 400, html: page("Cat-Cut ライセンス", "<p>セッションIDが指定されていません。</p>") };
  }
  const license = store.findBySessionId(identifier)
    || store.findByField("univapayOrderId", identifier)
    || store.findByField("univapayChargeId", identifier);
  if (!license) {
    // webhook到達前にリダイレクトされてくることがあるため「処理中」として案内する
    return {
      status: 404,
      html: page(
        "ライセンスを発行しています",
        "<p>決済は完了しています。ライセンスキーの発行に少し時間がかかる場合があります。<br>1分ほど待ってからこのページを再読み込みしてください。</p>",
      ),
    };
  }
  return {
    status: 200,
    html: page(
      "ご購入ありがとうございます",
      `<p>以下のライセンスキーを Cat-Cut アプリの「ライセンス」画面に貼り付けて認証してください。</p><code>${escapeHtml(license.key)}</code><p>このページのURLは他人と共有しないでください。</p>`,
    ),
  };
}

/** POST /license/activate: 署名検証+ストアの失効確認+端末IDの記録。 */
export function handleActivate(body, { store, signingKey }) {
  const key = String(body?.key || "").trim();
  const deviceId = String(body?.deviceId || "").trim();
  if (!key) return { status: 400, json: { ok: false, error: "key を指定してください" } };
  const verified = verifyLicense(key, derivePublicKey(signingKey));
  if (!verified.ok) return { status: 400, json: { ok: false, error: verified.error } };
  const license = store.get(verified.payload.licenseId);
  if (!license) return { status: 404, json: { ok: false, error: "ライセンスが見つかりません" } };
  if (license.status === "revoked") {
    return { status: 403, json: { ok: false, error: "このライセンスは失効しています" } };
  }
  if (deviceId && !license.deviceIds.includes(deviceId)) {
    store.put({ ...license, deviceIds: [...license.deviceIds, deviceId] });
  }
  return { status: 200, json: { ok: true, plan: license.plan, licenseId: license.licenseId } };
}

/**
 * POST /license/refresh: ストアの状態を返す。サブスクプランは決済プロバイダの
 * サブスク状態も確認してストアへ反映する(解約webhook取りこぼしの保険)。
 * W12-4: プロバイダ抽象経由に変更(stripe を直接渡す旧シグネチャも互換維持)。
 */
export async function handleRefresh(body, { store, provider, stripe, signingKey }) {
  const key = String(body?.key || "").trim();
  if (!key) return { status: 400, json: { ok: false, error: "key を指定してください" } };
  const verified = verifyLicense(key, derivePublicKey(signingKey));
  if (!verified.ok) return { status: 400, json: { ok: false, error: verified.error } };
  const license = store.get(verified.payload.licenseId);
  if (!license) return { status: 404, json: { ok: false, error: "ライセンスが見つかりません" } };

  // 旧シグネチャ互換: provider 未指定で stripe が渡された場合は Stripe プロバイダを組み立てる
  const activeProvider = provider ?? (stripe ? createStripeProvider({ stripe }) : null);
  let status = license.status;
  if (activeProvider) {
    // 照会不要(買い切り)・疎通失敗時は null が返り、ストアの現状を維持する
    const refreshed = await activeProvider.refreshSubscription(license);
    if (refreshed) {
      status = refreshed;
      if (status !== license.status) store.put({ ...license, status });
    }
  }
  return { status: 200, json: { ok: status === "active", status } };
}

/** リクエストボディを生バッファで読む(webhookの署名検証は生ボディが必須)。 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * ルーティング本体。deps を注入できるため、テストでは stripe / fetchImpl を
 * モックにしてサーバごと起動せずに検証できる。
 * provider を渡さなければ PAYMENT_PROVIDER env から生成する(既定 stripe)。
 */
export function createRequestListener(deps) {
  const { store, env } = deps;
  const provider = deps.provider ?? createProvider(deps);

  return async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const pathname = requestUrl.pathname;
    const route = `${req.method} ${pathname}`;

    const sendJson = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(json));
    };
    const sendHtml = (status, html) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    };

    try {
      if (provider.matchWebhook(req.method, pathname)) {
        const rawBody = await readRawBody(req);
        const result = await provider.handleWebhookRequest({ rawBody, headers: req.headers, pathname });
        // W12-4: UnivaPayは3秒以内の200応答が必須のため、先にレスポンスを返す
        sendJson(result.status, result.json);
        if (result.after) {
          // 発行・失効処理はレスポンス返却後に非同期実行(失敗はログのみ。
          // UnivaPay側のリトライ再送で回復する)
          try {
            const outcome = await result.after();
            if (outcome && outcome.handled === false && outcome.error) {
              console.error(`[billing] webhook後処理を拒否しました(${outcome.action}): ${outcome.error}`);
            }
          } catch (error) {
            console.error("[billing] webhook後処理でエラー:", error);
          }
        }
        return;
      }

      if (route === "GET /license/claim") {
        const identifier = requestUrl.searchParams.get("session_id")
          || requestUrl.searchParams.get("order_id")
          || requestUrl.searchParams.get("charge_id");
        const result = handleClaim(identifier, { store });
        sendHtml(result.status, result.html);
        return;
      }

      if (req.method === "POST") {
        let body = {};
        const rawBody = await readRawBody(req);
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString("utf-8"));
          } catch {
            sendJson(400, { error: "JSONボディを解釈できません" });
            return;
          }
        }
        if (pathname === "/checkout") {
          const result = await provider.createCheckout(body);
          sendJson(result.status, result.json);
          return;
        }
        if (pathname === "/license/activate") {
          const result = handleActivate(body, { store, signingKey: env.LICENSE_SIGNING_KEY });
          sendJson(result.status, result.json);
          return;
        }
        if (pathname === "/license/refresh") {
          const result = await handleRefresh(body, { store, provider, signingKey: env.LICENSE_SIGNING_KEY });
          sendJson(result.status, result.json);
          return;
        }
      }

      sendJson(404, { error: "not found" });
    } catch (error) {
      console.error(`[billing] ${route} でエラー:`, error);
      sendJson(500, { error: "internal server error" });
    }
  };
}

/** env の必須項目チェック(起動時に不足を明示してデプロイミスを早期検知)。 */
function assertRequiredEnv(env, providerName) {
  const required = ["LICENSE_SIGNING_KEY", "PUBLIC_BASE_URL"];
  if (providerName === "stripe") {
    required.push("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET");
  } else if (providerName === "univapay") {
    required.push("UNIVAPAY_APP_TOKEN", "UNIVAPAY_APP_SECRET", "UNIVAPAY_WEBHOOK_SECRET", "UNIVAPAY_LINK_FORM_BASE");
  }
  const missing = required.filter((name) => !String(env[name] || "").trim());
  if (missing.length > 0) {
    throw new Error(`環境変数が未設定です: ${missing.join(", ")}(.env.example を参照)`);
  }
}

// 直接実行時のみサーバを起動する(テストからのimportでは起動しない)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const providerName = String(env.PAYMENT_PROVIDER || "stripe").trim().toLowerCase();
  assertRequiredEnv(env, providerName);
  // stripe SDK は Stripe 採用時のみロードする(UnivaPayは標準fetchのみで動く)
  let stripe = null;
  if (providerName === "stripe") {
    const { default: Stripe } = await import("stripe");
    stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  const listener = createRequestListener({
    stripe,
    store: createStore(path.join(__dirname, "..", "data", "licenses.json")),
    plans: loadPlans(),
    env,
  });
  const port = Number(env.PORT || 8788);
  http.createServer(listener).listen(port, () => {
    console.log(`[billing] Cat-Cut billing-server listening on :${port} (provider: ${providerName})`);
  });
}
