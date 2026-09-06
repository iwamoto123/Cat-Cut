export type AiRefineProvider = "anthropic" | "openai" | "gemini";

export type ApiKeyProvider = "elevenlabs" | AiRefineProvider;

export type ApiKeySource = "userData" | "env" | "dotenv" | "settings" | null;

export type ApiKeyStatus = {
  configured: boolean;
  lastFour: string | null;
  source: ApiKeySource;
};

export type StoredApiKeys = {
  eleven_api_key?: string;
  anthropic_api_key?: string;
  openai_api_key?: string;
  gemini_api_key?: string;
};

export type ApiKeysStatusResponse = {
  elevenlabs: ApiKeyStatus;
  anthropic: ApiKeyStatus;
  openai: ApiKeyStatus;
  gemini: ApiKeyStatus;
  /** auto 選択時に使われる AI校正プロバイダ（キーが1つ以上ある場合）。 */
  activeAiRefineProvider: AiRefineProvider | null;
};

export type ApiKeyTestSuccess = {
  ok: true;
  message: string;
  detail?: string;
};

export type ApiKeyTestFailure = {
  ok: false;
  message: string;
};

export type ApiKeyTestResult = ApiKeyTestSuccess | ApiKeyTestFailure;

/** AI校正の auto 選択優先順 (品質順)。 */
export const AI_REFINE_PROVIDER_PRIORITY: AiRefineProvider[] = ["anthropic", "openai", "gemini"];

type ResolveInput = {
  userDataKey?: string;
  envKey?: string;
  dotenvKey?: string;
  settingsKey?: string;
};

type ResolveResult = {
  value: string;
  source: ApiKeySource;
};

/** キー末尾4桁をマスク表示用に返す。4文字未満の場合は null。 */
export function maskLastFour(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

/** 検出優先順位: userData > process.env > .env > settings(legacy)。 */
export function resolveApiKey(input: ResolveInput): ResolveResult {
  const userDataKey = String(input.userDataKey || "").trim();
  if (userDataKey) return { value: userDataKey, source: "userData" };

  const envKey = String(input.envKey || "").trim();
  if (envKey) return { value: envKey, source: "env" };

  const dotenvKey = String(input.dotenvKey || "").trim();
  if (dotenvKey) return { value: dotenvKey, source: "dotenv" };

  const settingsKey = String(input.settingsKey || "").trim();
  if (settingsKey) return { value: settingsKey, source: "settings" };

  return { value: "", source: null };
}

export function buildApiKeyStatus(resolved: ResolveResult): ApiKeyStatus {
  const configured = Boolean(resolved.value);
  return {
    configured,
    lastFour: configured ? maskLastFour(resolved.value) : null,
    source: configured ? resolved.source : null,
  };
}

export function parseDotenvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

/** 貼り付け時に混ざる不可視文字を除去する。 */
export function normalizeApiKey(key: string): string {
  return String(key || "")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim();
}

export function formatNetworkError(error: unknown): string {
  if (!error || typeof error !== "object") return "インターネット接続を確認してください";
  const err = error as { code?: string; message?: string };
  const code = err.code || "";
  if (code === "ENOTFOUND") return "api.elevenlabs.io に接続できません（DNS/ネットワークを確認してください）";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || err.message === "timeout") {
    return "接続がタイムアウトしました。VPN/ファイアウォール/プロキシを確認してください";
  }
  if (code === "ECONNREFUSED") return "接続が拒否されました。ファイアウォールを確認してください";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "SSL証明書エラーです。Macの日時設定とmacOSアップデートを確認してください";
  }
  if (code === "ECONNRESET") return "接続が切断されました。VPNを切るか、別のネットワークで再試行してください";
  return `接続に失敗しました（${code || err.message || "unknown"}）。インターネット接続を確認してください`;
}

export function formatElevenTestError(
  statusCode: number | null,
  networkError: boolean,
  errorDetail?: string,
): string {
  if (networkError) return errorDetail || "インターネット接続を確認してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 403) return "このキーではAPIにアクセスできません。権限を確認してください";
  if (statusCode === 429) return "リクエストが多すぎます。少し待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "ElevenLabs側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

export function formatAnthropicTestError(statusCode: number | null, networkError: boolean): string {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 403) return "Billing（お支払い）でクレジットを購入済みか確認してください";
  if (statusCode === 429) return "リクエストが多すぎます。少し待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "Anthropic側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

export function formatOpenAiTestError(statusCode: number | null, networkError: boolean): string {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 403) return "このキーではAPIにアクセスできません。権限を確認してください";
  if (statusCode === 429) return "リクエスト過多またはクレジット不足の可能性があります。しばらく待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "OpenAI側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

export function formatGeminiTestError(statusCode: number | null, networkError: boolean): string {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 400 || statusCode === 403) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 429) return "リクエストが多すぎます。少し待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "Google側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

type HttpFetchResult = {
  status: number;
  body: string;
};

type HttpFetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<HttpFetchResult>;

async function fetchWithTimeout(
  fetchFn: HttpFetchFn,
  url: string,
  init: { headers: Record<string, string> },
  timeoutMs = 15000,
): Promise<HttpFetchResult> {
  return Promise.race([
    fetchFn(url, init),
    new Promise<HttpFetchResult>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeoutMs);
    }),
  ]);
}

export function parseElevenLabsErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { status?: string; message?: string };
    };
    const statusTag = parsed?.detail?.status || "";
    const apiMessage = String(parsed?.detail?.message || "");
    if (statusTag === "missing_permissions") {
      return "Speech to Text の権限がありません。キー作成時に Speech to Text をオンにしてください";
    }
    if (statusTag === "invalid_api_key") {
      return "ElevenLabsが「無効なAPIキー」と返しました。全文コピーし直してください";
    }
    if (apiMessage) return apiMessage;
  } catch {
    // JSON parse failure is non-fatal.
  }
  if (status === 403) return "IP制限やスコープ制限を確認してください";
  return "";
}

export async function testElevenLabsConnection(
  apiKey: string,
  fetchFn: HttpFetchFn,
): Promise<ApiKeyTestResult> {
  const trimmed = normalizeApiKey(apiKey);
  if (!trimmed) {
    return { ok: false, message: "APIキーを入力してください" };
  }
  try {
    const { status, body } = await fetchWithTimeout(
      fetchFn,
      "https://api.elevenlabs.io/v1/speech-to-text",
      { headers: { "xi-api-key": trimmed } },
      30000,
    );
    if (status === 200) {
      return { ok: true, message: "接続できました（文字起こしAPI）" };
    }
    const detailMessage = parseElevenLabsErrorMessage(status, body);
    return {
      ok: false,
      message: detailMessage || formatElevenTestError(status, false),
    };
  } catch (error) {
    return { ok: false, message: formatElevenTestError(null, true, formatNetworkError(error)) };
  }
}

export async function testAnthropicConnection(
  apiKey: string,
  fetchFn: HttpFetchFn,
): Promise<ApiKeyTestResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, message: "APIキーを入力してください" };
  }
  try {
    const { status } = await fetchWithTimeout(fetchFn, "https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": trimmed,
        "anthropic-version": "2023-06-01",
      },
    });
    if (status === 200) {
      return { ok: true, message: "接続できました" };
    }
    return { ok: false, message: formatAnthropicTestError(status, false) };
  } catch {
    return { ok: false, message: formatAnthropicTestError(null, true) };
  }
}

export async function testOpenAiConnection(
  apiKey: string,
  fetchFn: HttpFetchFn,
): Promise<ApiKeyTestResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, message: "APIキーを入力してください" };
  }
  try {
    const { status } = await fetchWithTimeout(fetchFn, "https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (status === 200) {
      return { ok: true, message: "接続できました" };
    }
    return { ok: false, message: formatOpenAiTestError(status, false) };
  } catch {
    return { ok: false, message: formatOpenAiTestError(null, true) };
  }
}

export async function testGeminiConnection(
  apiKey: string,
  fetchFn: HttpFetchFn,
): Promise<ApiKeyTestResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return { ok: false, message: "APIキーを入力してください" };
  }
  try {
    const { status } = await fetchWithTimeout(fetchFn, "https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": trimmed },
    });
    if (status === 200) {
      return { ok: true, message: "接続できました" };
    }
    return { ok: false, message: formatGeminiTestError(status, false) };
  } catch {
    return { ok: false, message: formatGeminiTestError(null, true) };
  }
}

const PROVIDER_ENV_NAMES: Record<ApiKeyProvider, string> = {
  elevenlabs: "ELEVEN_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const PROVIDER_STORAGE_FIELDS: Record<ApiKeyProvider, keyof StoredApiKeys> = {
  elevenlabs: "eleven_api_key",
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  gemini: "gemini_api_key",
};

export function providerEnvName(provider: ApiKeyProvider): string {
  return PROVIDER_ENV_NAMES[provider];
}

export function providerStorageField(provider: ApiKeyProvider): keyof StoredApiKeys {
  return PROVIDER_STORAGE_FIELDS[provider];
}

export function resolveActiveAiRefineProvider(status: Pick<ApiKeysStatusResponse, AiRefineProvider>): AiRefineProvider | null {
  for (const provider of AI_REFINE_PROVIDER_PRIORITY) {
    if (status[provider].configured) return provider;
  }
  return null;
}

export function buildPipelineEnvKeys(resolved: Record<ApiKeyProvider, ResolveResult>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of ["elevenlabs", "anthropic", "openai", "gemini"] as ApiKeyProvider[]) {
    const value = resolved[provider].value;
    if (value) env[providerEnvName(provider)] = value;
  }
  return env;
}

export function aiRefineProviderLabel(provider: AiRefineProvider): string {
  if (provider === "gemini") return "Google Gemini";
  if (provider === "openai") return "OpenAI（ChatGPT）";
  return "Anthropic（Claude）";
}
