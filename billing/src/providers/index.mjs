// W12-4: 決済プロバイダの共通インターフェースと選択ロジック。
//
// 各プロバイダは以下を実装する:
//   name: string
//   createCheckout(body)                → { status, json: {url} }
//   matchWebhook(method, pathname)      → boolean(このプロバイダ宛のwebhookか)
//   handleWebhookRequest({rawBody, headers, pathname})
//                                       → { status, json, after? }
//     after: レスポンス返却「後」に実行する非同期処理(UnivaPayの3秒制限対策)。
//            Stripeは同期処理で足りるため省略可
//   refreshSubscription(license)        → "active"|"past_due"|"revoked"|null
//     null = 照会不要 or 照会失敗(ストアの現状維持)
//
// ライセンス発行(licenseKeys)・store・activate/refresh の共通部はプロバイダに依存しない。
import { createStripeProvider } from "./stripeProvider.mjs";
import { createUnivapayProvider } from "./univapayProvider.mjs";

export const SUPPORTED_PROVIDERS = ["stripe", "univapay"];

/**
 * PAYMENT_PROVIDER env(既定 "stripe")でプロバイダを選択して生成する。
 * deps: { env, plans, store, stripe?, fetchImpl? }
 */
export function createProvider(deps) {
  const name = String(deps.env?.PAYMENT_PROVIDER || "stripe").trim().toLowerCase();
  if (name === "stripe") return createStripeProvider(deps);
  if (name === "univapay") return createUnivapayProvider(deps);
  throw new Error(`不明な PAYMENT_PROVIDER です: ${name}(対応: ${SUPPORTED_PROVIDERS.join(", ")})`);
}
