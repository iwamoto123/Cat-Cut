// W12-2: ライセンスモーダル。
//
// - 現在のライセンス状態表示(未認証/有効/要再確認/失効)
// - ライセンスキー入力→認証、認証済みキーの解除、状態の再確認
// - プラン購入ボタン(billing-serverの /checkout → 外部ブラウザでStripe Checkout)
//
// FEATURES.billing(App.tsx)が true の間のみ描画される。
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, Loader2, X } from "lucide-react";
import { LICENSE_PUBLIC_KEY, licenseStatusLabel, resolveLicenseStatus, type LicenseStatus, type StoredLicense } from "../lib/license";
import { BILLING_PLANS } from "../lib/billingPlans";

type LicenseModalProps = {
  open: boolean;
  onClose: () => void;
};

export function LicenseModal({ open, onClose }: LicenseModalProps) {
  const [license, setLicense] = useState<StoredLicense | null>(null);
  const [status, setStatus] = useState<LicenseStatus>("unlicensed");
  const [serverConfigured, setServerConfigured] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refreshState = useCallback(async () => {
    const state = await window.catcut.getLicense();
    setLicense(state.license);
    setServerConfigured(state.billingServerConfigured);
    setStatus(await resolveLicenseStatus(state.license as StoredLicense | null, LICENSE_PUBLIC_KEY, Date.now()));
  }, []);

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setMessage("");
    setError("");
    refreshState().catch(() => {
      setLicense(null);
      setStatus("unlicensed");
    });
  }, [open, refreshState]);

  if (!open) return null;

  async function handleActivate() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await window.catcut.activateLicense({ key: keyInput.trim() });
      if (!result.ok) {
        setError(result.error || "認証に失敗しました");
        return;
      }
      setMessage("ライセンスを認証しました");
      setKeyInput("");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await window.catcut.deactivateLicense();
      setMessage("この端末のライセンスを解除しました");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await window.catcut.refreshLicense();
      if (!result.ok && result.error) setError(result.error);
      else setMessage("ライセンス状態を更新しました");
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePurchase(planId: string) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await window.catcut.startLicenseCheckout({ plan: planId });
      if (!result.ok || !result.url) {
        setError(result.error || "決済ページを開けませんでした");
        return;
      }
      // 決済はアプリ内ではなく外部ブラウザ(Stripe Checkout)で行う
      await window.catcut.openExternalUrl(result.url);
      setMessage("ブラウザで決済ページを開きました。購入完了後に表示されるライセンスキーを下の欄に貼り付けてください");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="apiWizardBackdrop" onClick={onClose}>
      <div className="apiWizardDialog" onClick={(event) => event.stopPropagation()}>
        <div className="apiWizardHeader">
          <div>
            <h2>ライセンス</h2>
            <p className="apiWizardConfiguredHint">
              状態: {licenseStatusLabel(status)}
              {license ? `（プラン: ${license.payload.plan}）` : ""}
            </p>
          </div>
          <button className="apiWizardCloseButton" type="button" onClick={onClose} title="閉じる">
            <X size={18} />
          </button>
        </div>

        <div className="apiWizardBody">
          {license ? (
            <>
              <p className="apiWizardLead">このアプリはライセンス認証済みです。</p>
              <div className="apiWizardActions">
                <button className="secondaryButton" type="button" onClick={handleRefresh} disabled={busy}>
                  {busy ? <Loader2 size={16} className="spinIcon" /> : null}
                  状態を再確認
                </button>
                <button className="secondaryButton" type="button" onClick={handleDeactivate} disabled={busy}>
                  この端末の認証を解除
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="apiWizardLead">プランを購入すると、完了ページにライセンスキーが表示されます。キーをお持ちの方は下の欄に貼り付けて認証してください。</p>

              <div className="apiWizardCards">
                {BILLING_PLANS.map((plan) => (
                  <article key={plan.id} className="apiWizardCard optional">
                    <h3>{plan.label}</h3>
                    <p>{plan.description}</p>
                    <p className="apiWizardCost">{plan.priceLabel}</p>
                    <button
                      className="secondaryButton"
                      type="button"
                      onClick={() => handlePurchase(plan.id)}
                      disabled={busy || !serverConfigured}
                      title={serverConfigured ? "外部ブラウザで決済ページを開きます" : "販売準備中です"}
                    >
                      <ExternalLink size={14} />
                      {serverConfigured ? "購入する" : "準備中"}
                    </button>
                  </article>
                ))}
              </div>

              <div className="apiWizardKeyBlock">
                <label className="apiWizardKeyLabel">ライセンスキー</label>
                <div className="apiWizardKeyRow">
                  <input
                    className="apiWizardKeyInput"
                    type="text"
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                    placeholder="catcut_v1. で始まるキーを貼り付け"
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={handleActivate}
                    disabled={busy || !keyInput.trim()}
                  >
                    {busy ? <Loader2 size={16} className="spinIcon" /> : <KeyRound size={16} />}
                    <span>認証</span>
                  </button>
                </div>
              </div>
            </>
          )}

          {message && <p className="apiWizardConfiguredHint">{message}</p>}
          {error && <div className="apiWizardError">{error}</div>}
        </div>
      </div>
    </div>
  );
}
