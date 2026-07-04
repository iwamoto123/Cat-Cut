import { useCallback, useEffect, useState } from "react";
import { Check, Eye, EyeOff, ExternalLink, Loader2, X } from "lucide-react";
import type { AiRefineProvider, ApiKeysStatusResponse, ApiKeyTestResult } from "../lib/apiKeys";
import { AI_REFINE_PROVIDER_PRIORITY, aiRefineProviderLabel } from "../lib/apiKeys";

type WizardStep = 1 | 2 | 3 | "complete";

type ApiKeyWizardProps = {
  open: boolean;
  initialStep?: WizardStep;
  /** 初回オンボーディング（閉じられない）か、設定から開いたか。 */
  onboardingRequired?: boolean;
  onClose: () => void;
  onComplete: () => void;
};

const AI_PROVIDER_META: Record<
  AiRefineProvider,
  {
    badge: string;
    badgeClass: string;
    inputLabel: string;
    keyHint: string;
    steps: Array<{ text: string; link?: { url: string; label: string }; note?: string }>;
    footerNote?: string;
  }
> = {
  gemini: {
    badge: "無料枠あり",
    badgeClass: "recommended",
    inputLabel: "Google Gemini APIキー",
    keyHint: "",
    steps: [
      {
        text: "Google AI Studio を開く",
        link: { url: "https://aistudio.google.com/apikey", label: "APIキー取得ページを開く" },
        note: "Googleアカウントでログイン",
      },
      { text: "「Create API key」を押してキーをコピー" },
      { text: "下の入力欄に貼り付け" },
    ],
    footerNote: "クレジットカード登録なしで無料枠から使えます",
  },
  openai: {
    badge: "ChatGPTの会社",
    badgeClass: "neutral",
    inputLabel: "OpenAI APIキー",
    keyHint: "sk-",
    steps: [
      {
        text: "OpenAI Platform を開く",
        link: { url: "https://platform.openai.com/api-keys", label: "APIキー取得ページを開く" },
        note: "アカウントがない場合は先に作成",
      },
      {
        text: "Billing で前払いクレジットを購入（最低$5）",
        link: { url: "https://platform.openai.com/settings/organization/billing", label: "Billingページを開く" },
      },
      { text: "「Create new secret key」で sk- で始まるキーをコピー" },
      { text: "下の入力欄に貼り付け" },
    ],
  },
  anthropic: {
    badge: "高品質",
    badgeClass: "quality",
    inputLabel: "Anthropic APIキー",
    keyHint: "sk-ant-",
    steps: [
      {
        text: "Anthropic Console を開く",
        link: { url: "https://console.anthropic.com/settings/keys", label: "APIキー取得ページを開く" },
        note: "Googleアカウントでログイン可",
      },
      {
        text: "先に Billing でクレジット購入が必要（最低$5≒約800円）",
        link: { url: "https://console.anthropic.com/settings/billing", label: "Billingページを開く" },
      },
      { text: "「Create Key」を押して名前は自由（例: cat-cut）" },
      { text: "sk-ant- で始まるキーをコピーして下の欄に貼り付け" },
    ],
  },
};

function maskedSuffix(lastFour: string | null): string {
  return lastFour ? `****${lastFour}` : "****";
}

function ApiKeyInputRow({
  label,
  value,
  onChange,
  onTest,
  testing,
  testResult,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onTest: () => void;
  testing: boolean;
  testResult: ApiKeyTestResult | null;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="apiWizardKeyBlock">
      <label className="apiWizardKeyLabel">{label}</label>
      <div className="apiWizardKeyRow">
        <input
          className="apiWizardKeyInput"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="iconButton"
          type="button"
          onClick={() => setVisible((current) => !current)}
          title={visible ? "非表示" : "表示"}
          disabled={disabled}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
        <button className="secondaryButton apiWizardTestButton" type="button" onClick={onTest} disabled={disabled || testing || !value.trim()}>
          {testing ? <Loader2 size={16} className="spinIcon" /> : null}
          <span>接続テスト</span>
        </button>
      </div>
      {testResult && (
        <div className={`apiWizardTestResult ${testResult.ok ? "ok" : "error"}`}>
          {testResult.ok ? <Check size={16} /> : null}
          <span>{testResult.message}</span>
          {testResult.ok && testResult.detail ? <span className="apiWizardTestDetail">{testResult.detail}</span> : null}
        </div>
      )}
    </div>
  );
}

function AiProviderStatusHints({ status }: { status: ApiKeysStatusResponse | null }) {
  if (!status) return null;
  const configured = AI_REFINE_PROVIDER_PRIORITY.filter((p) => status[p].configured);
  if (configured.length === 0) return null;
  return (
    <>
      {configured.map((provider) => (
        <p key={provider} className="apiWizardConfiguredHint">
          ✓ {aiRefineProviderLabel(provider)} 設定済み（{maskedSuffix(status[provider].lastFour)}）
        </p>
      ))}
      {status.activeAiRefineProvider && configured.length > 1 && (
        <p className="apiWizardActiveProviderHint">
          AI校正で使用: {aiRefineProviderLabel(status.activeAiRefineProvider)}（優先順: Anthropic → OpenAI → Gemini）
        </p>
      )}
    </>
  );
}

export function ApiKeyWizard({
  open,
  initialStep = 1,
  onboardingRequired = false,
  onClose,
  onComplete,
}: ApiKeyWizardProps) {
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [status, setStatus] = useState<ApiKeysStatusResponse | null>(null);
  const [elevenInput, setElevenInput] = useState("");
  const [aiInputs, setAiInputs] = useState<Record<AiRefineProvider, string>>({
    gemini: "",
    openai: "",
    anthropic: "",
  });
  const [selectedAiProvider, setSelectedAiProvider] = useState<AiRefineProvider>("gemini");
  const [aiChangeMode, setAiChangeMode] = useState<Record<AiRefineProvider, boolean>>({
    gemini: false,
    openai: false,
    anthropic: false,
  });
  const [elevenUseDetected, setElevenUseDetected] = useState(true);
  const [elevenChangeMode, setElevenChangeMode] = useState(false);
  const [elevenTesting, setElevenTesting] = useState(false);
  const [aiTesting, setAiTesting] = useState<AiRefineProvider | null>(null);
  const [elevenTestResult, setElevenTestResult] = useState<ApiKeyTestResult | null>(null);
  const [aiTestResults, setAiTestResults] = useState<Partial<Record<AiRefineProvider, ApiKeyTestResult>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshStatus = useCallback(async () => {
    const next = await window.catcut.getApiKeysStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setElevenInput("");
    setAiInputs({ gemini: "", openai: "", anthropic: "" });
    setSelectedAiProvider("gemini");
    setAiChangeMode({ gemini: false, openai: false, anthropic: false });
    setElevenUseDetected(true);
    setElevenChangeMode(false);
    setElevenTestResult(null);
    setAiTestResults({});
    setError("");
    refreshStatus().catch(() => setStatus(null));
  }, [open, initialStep, refreshStatus]);

  if (!open) return null;

  const elevenConfigured = status?.elevenlabs.configured ?? false;
  const elevenDetected = elevenConfigured && !elevenChangeMode;
  const selectedAiConfigured = status?.[selectedAiProvider]?.configured ?? false;
  const selectedAiDetected = selectedAiConfigured && !aiChangeMode[selectedAiProvider] && !aiInputs[selectedAiProvider];

  async function openExternal(url: string) {
    await window.catcut.openExternalUrl(url);
  }

  async function handleElevenTest() {
    setElevenTesting(true);
    setElevenTestResult(null);
    setError("");
    try {
      const result = await window.catcut.testApiKey({
        provider: "elevenlabs",
        apiKey: elevenInput.trim() || undefined,
      });
      setElevenTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setElevenTesting(false);
    }
  }

  async function handleAiTest(provider: AiRefineProvider) {
    setAiTesting(provider);
    setAiTestResults((current) => ({ ...current, [provider]: undefined }));
    setError("");
    try {
      const result = await window.catcut.testApiKey({
        provider,
        apiKey: aiInputs[provider].trim() || undefined,
      });
      setAiTestResults((current) => ({ ...current, [provider]: result }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiTesting(null);
    }
  }

  async function saveElevenAndContinue() {
    setBusy(true);
    setError("");
    try {
      if (!elevenDetected || !elevenUseDetected) {
        if (!elevenInput.trim()) {
          setError("ElevenLabsのAPIキーを入力してください");
          return;
        }
        const test = elevenTestResult?.ok
          ? elevenTestResult
          : await window.catcut.testApiKey({ provider: "elevenlabs", apiKey: elevenInput.trim() });
        if (!test.ok) {
          setElevenTestResult(test);
          setError(test.message);
          return;
        }
        await window.catcut.setApiKey({ provider: "elevenlabs", apiKey: elevenInput.trim() });
      }
      await refreshStatus();
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveAiAndFinish() {
    setBusy(true);
    setError("");
    try {
      const input = aiInputs[selectedAiProvider].trim();
      if (input) {
        const cached = aiTestResults[selectedAiProvider];
        const test = cached?.ok
          ? cached
          : await window.catcut.testApiKey({ provider: selectedAiProvider, apiKey: input });
        if (!test.ok) {
          setAiTestResults((current) => ({ ...current, [selectedAiProvider]: test }));
          setError(test.message);
          return;
        }
        await window.catcut.setApiKey({ provider: selectedAiProvider, apiKey: input });
      }
      await refreshStatus();
      onComplete();
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function finishWithoutAiKey() {
    onComplete();
    setStep("complete");
  }

  function handleBackdropClick() {
    if (onboardingRequired && step !== "complete") return;
    onClose();
  }

  const aiMeta = AI_PROVIDER_META[selectedAiProvider];

  return (
    <div className="apiWizardBackdrop" onClick={handleBackdropClick}>
      <div className="apiWizardDialog" onClick={(event) => event.stopPropagation()}>
        <div className="apiWizardHeader">
          <div>
            <div className="apiWizardSteps">
              <span className={step === 1 || step === "complete" ? "active" : step > 1 ? "done" : ""}>1</span>
              <span className={step === 2 ? "active" : step === 3 || step === "complete" ? "done" : ""}>2</span>
              <span className={step === 3 ? "active" : step === "complete" ? "done" : ""}>3</span>
            </div>
            {step === 1 && (
              <>
                <h2>ようこそ Cat-Cut へ</h2>
                {elevenConfigured && (
                  <p className="apiWizardConfiguredHint">✓ ElevenLabs 設定済み（{maskedSuffix(status?.elevenlabs.lastFour ?? null)}）</p>
                )}
                <AiProviderStatusHints status={status} />
              </>
            )}
            {step === 2 && (
              <>
                <h2>ElevenLabs のAPIキーを設定</h2>
                {elevenConfigured && (
                  <p className="apiWizardConfiguredHint">✓ 設定済み（{maskedSuffix(status?.elevenlabs.lastFour ?? null)}）</p>
                )}
              </>
            )}
            {step === 3 && (
              <>
                <h2>AI校正の設定（任意）</h2>
                <AiProviderStatusHints status={status} />
              </>
            )}
            {step === "complete" && <h2>設定完了！</h2>}
          </div>
          {!onboardingRequired || step === "complete" ? (
            <button className="apiWizardCloseButton" type="button" onClick={onClose} title="閉じる">
              <X size={18} />
            </button>
          ) : null}
        </div>

        {step === 1 && (
          <div className="apiWizardBody">
            <p className="apiWizardLead">
              Cat-Cutを使うには、ElevenLabs（文字起こし）のAPIキーが必要です。AI校正は任意で、Google Gemini・OpenAI・Anthropicのいずれか1つを設定できます。
            </p>
            <div className="apiWizardCards">
              <article className="apiWizardCard required">
                <h3>① ElevenLabs（文字起こし）【必須】</h3>
                <p>動画の音声を文字に変換します。</p>
                <p className="apiWizardCost">目安: 15分の動画1本で約30〜60円</p>
              </article>
              <article className="apiWizardCard optional">
                <h3>② AI校正【任意・あとでも可】</h3>
                <p>誤字修正・改行調整をAIが自動で行います。Google Gemini（無料枠あり）・OpenAI・Anthropicから選べます。</p>
                <p className="apiWizardCost">目安: 15分の動画1本で数円〜50円</p>
              </article>
            </div>
            <div className="apiWizardActions">
              <button className="primaryButton" type="button" onClick={() => setStep(elevenConfigured ? 3 : 2)}>
                設定をはじめる
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="apiWizardBody">
            <ol className="apiWizardStepsList">
              <li>
                <button className="linkButton" type="button" onClick={() => openExternal("https://elevenlabs.io/app/settings/api-keys")}>
                  <ExternalLink size={16} />
                  ElevenLabsのサイトを開く
                </button>
                <span className="apiWizardStepNote">アカウントがない場合は先に無料登録（GoogleアカウントでOK）</span>
              </li>
              <li>画面の「Create API Key」を押す</li>
              <li>表示されたキー（<code>sk_</code> で始まる長い文字列）を「Copy」ボタンでコピー</li>
              <li>下の入力欄に貼り付け</li>
            </ol>

            {elevenDetected && elevenUseDetected ? (
              <div className="apiWizardDetectedBox">
                <p>
                  ✓ 設定済みのキーを検出しました（末尾 {maskedSuffix(status?.elevenlabs.lastFour ?? null)}）
                </p>
                <div className="apiWizardDetectedActions">
                  <button className="primaryButton" type="button" onClick={() => setStep(3)} disabled={busy}>
                    このまま使う
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => {
                      setElevenChangeMode(true);
                      setElevenUseDetected(false);
                      setElevenTestResult(null);
                    }}
                    disabled={busy}
                  >
                    別のキーに変更
                  </button>
                </div>
              </div>
            ) : (
              <>
                <ApiKeyInputRow
                  label="ElevenLabs APIキー"
                  value={elevenInput}
                  onChange={(value) => {
                    setElevenInput(value);
                    setElevenTestResult(null);
                  }}
                  onTest={handleElevenTest}
                  testing={elevenTesting}
                  testResult={elevenTestResult}
                  disabled={busy}
                />
                <div className="apiWizardActions">
                  <button className="primaryButton" type="button" onClick={saveElevenAndContinue} disabled={busy}>
                    次へ
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="apiWizardBody">
            <p className="apiWizardLead">
              テロップの誤字修正・改行調整をAIが自動で行います。スキップしてもすべての機能が使えます（AI校正のみ無効、誤字はアプリ内で手修正可能）。
            </p>

            <div className="apiWizardProviderCards">
              {AI_REFINE_PROVIDER_PRIORITY.slice().reverse().map((provider) => {
                const meta = AI_PROVIDER_META[provider];
                const isSelected = selectedAiProvider === provider;
                const isConfigured = status?.[provider]?.configured ?? false;
                return (
                  <button
                    key={provider}
                    type="button"
                    className={`apiWizardProviderCard ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      setSelectedAiProvider(provider);
                      setError("");
                    }}
                  >
                    <div className="apiWizardProviderCardHeader">
                      <span className="apiWizardProviderName">{aiRefineProviderLabel(provider)}</span>
                      <span className={`apiWizardProviderBadge ${meta.badgeClass}`}>{meta.badge}</span>
                    </div>
                    {isConfigured && (
                      <span className="apiWizardProviderConfigured">
                        ✓ {maskedSuffix(status?.[provider]?.lastFour ?? null)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {selectedAiDetected ? (
              <div className="apiWizardDetectedBox">
                <p>
                  ✓ 設定済みのキーを検出しました（末尾 {maskedSuffix(status?.[selectedAiProvider]?.lastFour ?? null)}）
                </p>
                <div className="apiWizardDetectedActions">
                  <button className="primaryButton" type="button" onClick={finishWithoutAiKey} disabled={busy}>
                    このまま使う
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => {
                      setAiChangeMode((current) => ({ ...current, [selectedAiProvider]: true }));
                      setAiInputs((current) => ({ ...current, [selectedAiProvider]: "" }));
                      setAiTestResults((current) => ({ ...current, [selectedAiProvider]: undefined }));
                    }}
                    disabled={busy}
                  >
                    別のキーに変更
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await window.catcut.deleteApiKey({ provider: selectedAiProvider });
                        await refreshStatus();
                        setAiChangeMode((current) => ({ ...current, [selectedAiProvider]: true }));
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    キーを削除
                  </button>
                </div>
              </div>
            ) : (
              <>
                <ol className="apiWizardStepsList">
                  {aiMeta.steps.map((item, index) => (
                    <li key={`${selectedAiProvider}-${index}`}>
                      {item.link ? (
                        <>
                          <button className="linkButton" type="button" onClick={() => openExternal(item.link!.url)}>
                            <ExternalLink size={16} />
                            {item.link.label}
                          </button>
                          {item.note ? <span className="apiWizardStepNote">{item.note}</span> : null}
                        </>
                      ) : (
                        item.text
                      )}
                    </li>
                  ))}
                </ol>
                {aiMeta.footerNote ? <p className="apiWizardProviderFooterNote">{aiMeta.footerNote}</p> : null}
                <ApiKeyInputRow
                  label={aiMeta.inputLabel}
                  value={aiInputs[selectedAiProvider]}
                  onChange={(value) => {
                    setAiInputs((current) => ({ ...current, [selectedAiProvider]: value }));
                    setAiTestResults((current) => ({ ...current, [selectedAiProvider]: undefined }));
                  }}
                  onTest={() => handleAiTest(selectedAiProvider)}
                  testing={aiTesting === selectedAiProvider}
                  testResult={aiTestResults[selectedAiProvider] ?? null}
                  disabled={busy}
                />
                {aiMeta.keyHint ? (
                  <p className="apiWizardStepNote">
                    <code>{aiMeta.keyHint}</code> で始まるキーを貼り付けてください
                  </p>
                ) : null}
              </>
            )}

            <div className="apiWizardActions">
              {aiInputs[selectedAiProvider].trim() ? (
                <button className="primaryButton" type="button" onClick={saveAiAndFinish} disabled={busy}>
                  保存して完了
                </button>
              ) : selectedAiDetected ? null : (
                <button className="primaryButton" type="button" onClick={finishWithoutAiKey} disabled={busy}>
                  完了
                </button>
              )}
              <button className="secondaryButton" type="button" onClick={finishWithoutAiKey} disabled={busy}>
                スキップ（あとで設定）
              </button>
            </div>
          </div>
        )}

        {step === "complete" && (
          <div className="apiWizardBody apiWizardComplete">
            <p className="apiWizardLead">設定完了！動画を読み込んで解析をはじめましょう</p>
            <div className="apiWizardStatusSummary">
              <p className="apiWizardConfiguredHint">
                ElevenLabs: {status?.elevenlabs.configured ? `✓ ${maskedSuffix(status.elevenlabs.lastFour)}` : "未設定"}
              </p>
              {AI_REFINE_PROVIDER_PRIORITY.map((provider) => (
                <p key={provider} className="apiWizardConfiguredHint">
                  {aiRefineProviderLabel(provider)}:{" "}
                  {status?.[provider]?.configured ? `✓ ${maskedSuffix(status[provider].lastFour)}` : "未設定"}
                </p>
              ))}
              {status?.activeAiRefineProvider && (
                <p className="apiWizardActiveProviderHint">
                  AI校正で使用: {aiRefineProviderLabel(status.activeAiRefineProvider)}
                </p>
              )}
            </div>
            <div className="apiWizardActions">
              <button className="primaryButton" type="button" onClick={onClose}>
                はじめる
              </button>
            </div>
          </div>
        )}

        {error && <div className="apiWizardError">{error}</div>}
      </div>
    </div>
  );
}
