const fs = require("fs");
const https = require("https");
const path = require("path");
const { safeStorage } = require("electron");

function maskLastFour(key) {
  const trimmed = String(key || "").trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

function parseDotenvContent(content) {
  const env = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function resolveApiKey(input) {
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

function buildApiKeyStatus(resolved) {
  const configured = Boolean(resolved.value);
  return {
    configured,
    lastFour: configured ? maskLastFour(resolved.value) : null,
    source: configured ? resolved.source : null,
  };
}

function formatElevenTestError(statusCode, networkError) {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 403) return "このキーではAPIにアクセスできません。権限を確認してください";
  if (statusCode === 429) return "リクエストが多すぎます。少し待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "ElevenLabs側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

function formatAnthropicTestError(statusCode, networkError) {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 403) return "Billing（お支払い）でクレジットを購入済みか確認してください";
  if (statusCode === 429) return "リクエストが多すぎます。少し待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "Anthropic側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

function formatOpenAiTestError(statusCode, networkError) {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 403) return "このキーではAPIにアクセスできません。権限を確認してください";
  if (statusCode === 429) return "リクエスト過多またはクレジット不足の可能性があります。しばらく待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "OpenAI側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

function formatGeminiTestError(statusCode, networkError) {
  if (networkError) return "インターネット接続を確認してください";
  if (statusCode === 400 || statusCode === 403) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 401) return "キーが正しくありません。コピーし直してください";
  if (statusCode === 429) return "リクエストが多すぎます。少し待ってから再試行してください";
  if (statusCode && statusCode >= 500) return "Google側でエラーが発生しました。しばらく待ってから再試行してください";
  return "接続に失敗しました。キーとネットワークを確認してください";
}

const PROVIDER_ENV_NAMES = {
  elevenlabs: "ELEVEN_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const PROVIDER_STORAGE_FIELDS = {
  elevenlabs: "eleven_api_key",
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  gemini: "gemini_api_key",
};

/** AI校正の auto 選択優先順 (品質順)。 */
const AI_REFINE_PROVIDER_PRIORITY = ["anthropic", "openai", "gemini"];

function providerEnvName(provider) {
  return PROVIDER_ENV_NAMES[provider] || "";
}

function providerStorageField(provider) {
  return PROVIDER_STORAGE_FIELDS[provider] || "";
}

function resolveActiveAiRefineProvider(status) {
  for (const provider of AI_REFINE_PROVIDER_PRIORITY) {
    if (status[provider]?.configured) return provider;
  }
  return null;
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs = 15000) {
  return Promise.race([
    fetchFn(url, init),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeoutMs);
    }),
  ]);
}

async function testElevenLabsConnection(apiKey, fetchFn) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) return { ok: false, message: "APIキーを入力してください" };
  try {
    const { status, body } = await fetchWithTimeout(fetchFn, "https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": trimmed },
    });
    if (status === 200) {
      let detail = "";
      try {
        const parsed = JSON.parse(body);
        const tier = parsed.subscription?.tier || parsed.subscription_tier || "";
        const used = parsed.character_count;
        const limit = parsed.character_limit;
        const parts = [];
        if (tier) parts.push(`プラン: ${tier}`);
        if (typeof used === "number" && typeof limit === "number") {
          parts.push(`残クレジット目安: ${Math.max(0, limit - used).toLocaleString()} / ${limit.toLocaleString()}`);
        }
        detail = parts.join(" · ");
      } catch {
        // ignore parse errors
      }
      return { ok: true, message: "接続できました", detail: detail || undefined };
    }
    return { ok: false, message: formatElevenTestError(status, false) };
  } catch {
    return { ok: false, message: formatElevenTestError(null, true) };
  }
}

async function testAnthropicConnection(apiKey, fetchFn) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) return { ok: false, message: "APIキーを入力してください" };
  try {
    const { status } = await fetchWithTimeout(fetchFn, "https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": trimmed,
        "anthropic-version": "2023-06-01",
      },
    });
    if (status === 200) return { ok: true, message: "接続できました" };
    return { ok: false, message: formatAnthropicTestError(status, false) };
  } catch {
    return { ok: false, message: formatAnthropicTestError(null, true) };
  }
}

async function testOpenAiConnection(apiKey, fetchFn) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) return { ok: false, message: "APIキーを入力してください" };
  try {
    const { status } = await fetchWithTimeout(fetchFn, "https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (status === 200) return { ok: true, message: "接続できました" };
    return { ok: false, message: formatOpenAiTestError(status, false) };
  } catch {
    return { ok: false, message: formatOpenAiTestError(null, true) };
  }
}

async function testGeminiConnection(apiKey, fetchFn) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) return { ok: false, message: "APIキーを入力してください" };
  try {
    const { status } = await fetchWithTimeout(fetchFn, "https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": trimmed },
    });
    if (status === 200) return { ok: true, message: "接続できました" };
    return { ok: false, message: formatGeminiTestError(status, false) };
  } catch {
    return { ok: false, message: formatGeminiTestError(null, true) };
  }
}

function createApiKeysModule(deps) {
  const { userDataPath, repoRoot, readSettingsRaw } = deps;

  function apiKeysPath() {
    return userDataPath("api_keys.json");
  }

  function readDotenv() {
    const envPath = path.join(repoRoot(), ".env");
    if (!fs.existsSync(envPath)) return {};
    try {
      return parseDotenvContent(fs.readFileSync(envPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function readStoredApiKeys() {
    const filePath = apiKeysPath();
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeStoredApiKeys(data) {
    const filePath = apiKeysPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, encoding: "utf-8" });
  }

  function readLegacyElevenKeyFromSettings() {
    const raw = readSettingsRaw();
    if (!raw?.elevenApiKey) return "";
    try {
      if (raw.elevenApiKeyEncoding === "safeStorage" && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(raw.elevenApiKey, "base64"));
      }
      return String(raw.elevenApiKey);
    } catch {
      return "";
    }
  }

  function resolveProviderKey(provider) {
    const stored = readStoredApiKeys();
    const dotenv = readDotenv();
    const field = providerStorageField(provider);
    const envName = providerEnvName(provider);
    return resolveApiKey({
      userDataKey: stored[field],
      envKey: process.env[envName],
      dotenvKey: dotenv[envName],
      settingsKey: provider === "elevenlabs" ? readLegacyElevenKeyFromSettings() : "",
    });
  }

  function getApiKeysStatus() {
    const status = {
      elevenlabs: buildApiKeyStatus(resolveProviderKey("elevenlabs")),
      anthropic: buildApiKeyStatus(resolveProviderKey("anthropic")),
      openai: buildApiKeyStatus(resolveProviderKey("openai")),
      gemini: buildApiKeyStatus(resolveProviderKey("gemini")),
    };
    status.activeAiRefineProvider = resolveActiveAiRefineProvider(status);
    return status;
  }

  function getResolvedElevenApiKey() {
    return resolveProviderKey("elevenlabs").value;
  }

  function getResolvedAnthropicApiKey() {
    return resolveProviderKey("anthropic").value;
  }

  function getResolvedOpenAiApiKey() {
    return resolveProviderKey("openai").value;
  }

  function getResolvedGeminiApiKey() {
    return resolveProviderKey("gemini").value;
  }

  function isElevenConfigured() {
    return getApiKeysStatus().elevenlabs.configured;
  }

  function saveApiKey(provider, apiKey) {
    const trimmed = String(apiKey || "").trim();
    if (!trimmed) throw new Error("APIキーが空です");
    const stored = readStoredApiKeys();
    stored[providerStorageField(provider)] = trimmed;
    writeStoredApiKeys(stored);
    return getApiKeysStatus();
  }

  function deleteApiKey(provider) {
    const stored = readStoredApiKeys();
    delete stored[providerStorageField(provider)];
    writeStoredApiKeys(stored);
    return getApiKeysStatus();
  }

  function buildPipelineEnv(baseEnv = process.env) {
    const env = { ...baseEnv, PYTHONUNBUFFERED: "1" };
    const eleven = getResolvedElevenApiKey();
    const anthropic = getResolvedAnthropicApiKey();
    const openai = getResolvedOpenAiApiKey();
    const gemini = getResolvedGeminiApiKey();
    if (eleven) env.ELEVEN_API_KEY = eleven;
    if (anthropic) env.ANTHROPIC_API_KEY = anthropic;
    if (openai) env.OPENAI_API_KEY = openai;
    if (gemini) env.GEMINI_API_KEY = gemini;
    return env;
  }

  function nodeHttpsFetch(url, init) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers: init.headers,
          timeout: 15000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            resolve({ status: res.statusCode || 0, body });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.end();
    });
  }

  async function testApiKeyConnection(provider, apiKeyOverride) {
    const key = String(apiKeyOverride || "").trim() || resolveProviderKey(provider).value;
    if (!key) return { ok: false, message: "APIキーが未設定です" };
    if (provider === "elevenlabs") return testElevenLabsConnection(key, nodeHttpsFetch);
    if (provider === "anthropic") return testAnthropicConnection(key, nodeHttpsFetch);
    if (provider === "openai") return testOpenAiConnection(key, nodeHttpsFetch);
    if (provider === "gemini") return testGeminiConnection(key, nodeHttpsFetch);
    return { ok: false, message: "不明なAPIキー種別です" };
  }

  return {
    apiKeysPath,
    getApiKeysStatus,
    getResolvedElevenApiKey,
    getResolvedAnthropicApiKey,
    getResolvedOpenAiApiKey,
    getResolvedGeminiApiKey,
    isElevenConfigured,
    saveApiKey,
    deleteApiKey,
    buildPipelineEnv,
    testApiKeyConnection,
  };
}

module.exports = {
  createApiKeysModule,
  maskLastFour,
  parseDotenvContent,
  resolveApiKey,
  buildApiKeyStatus,
  formatElevenTestError,
  formatAnthropicTestError,
  formatOpenAiTestError,
  formatGeminiTestError,
  providerEnvName,
  providerStorageField,
  AI_REFINE_PROVIDER_PRIORITY,
  resolveActiveAiRefineProvider,
  testElevenLabsConnection,
  testAnthropicConnection,
  testOpenAiConnection,
  testGeminiConnection,
};
