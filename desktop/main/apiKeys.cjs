const fs = require("fs");
const dns = require("dns");
const https = require("https");
const path = require("path");
const { safeStorage } = require("electron");

// 社内ネットワーク等で IPv6 が壊れている環境向け（キーは正しいのに接続だけ失敗する典型原因）
dns.setDefaultResultOrder("ipv4first");

function normalizeApiKey(key) {
  return String(key || "")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .trim();
}

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

function formatNetworkError(error) {
  if (!error) return "インターネット接続を確認してください";
  const code = error.code || "";
  if (code === "ENOTFOUND") return "api.elevenlabs.io に接続できません（DNS/ネットワークを確認してください）";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || error.message === "timeout") {
    return "接続がタイムアウトしました。VPN/ファイアウォール/プロキシを確認してください";
  }
  if (code === "ECONNREFUSED") return "接続が拒否されました。ファイアウォールを確認してください";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "SSL証明書エラーです。Macの日時設定とmacOSアップデートを確認してください";
  }
  if (code === "ECONNRESET") return "接続が切断されました。VPNを切るか、別のネットワークで再試行してください";
  return `接続に失敗しました（${code || error.message}）。インターネット接続を確認してください`;
}

function formatElevenTestError(statusCode, networkError, errorDetail) {
  if (networkError) return errorDetail || "インターネット接続を確認してください";
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

/** Cat-Cut が実際に使う STT 接続テスト用の短い無音 WAV (0.1秒 / 16kHz mono)。 */
function buildMinimalTestWavBuffer() {
  const sampleRate = 16000;
  const numSamples = 1600;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function buildElevenLabsSttTestBody() {
  const wavBuffer = buildMinimalTestWavBuffer();
  const boundary = `----CatCut${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\nja\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="catcut-test.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    wavBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

function parseElevenLabsErrorMessage(status, body) {
  try {
    const parsed = JSON.parse(body);
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
    // ignore parse errors
  }
  if (status === 403) return "IP制限やスコープ制限を確認してください";
  return "";
}

function nodeHttpsPost(url, headers, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "Content-Length": body.length },
        timeout: timeoutMs,
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, { ...options, family: 4 }, callback);
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

function nodeElevenLabsSttTest(apiKey) {
  const { boundary, body } = buildElevenLabsSttTestBody();
  return nodeHttpsPost("https://api.elevenlabs.io/v1/speech-to-text", {
    "xi-api-key": apiKey,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  }, body);
}

async function testElevenLabsConnection(apiKey, fetchFn) {
  const trimmed = normalizeApiKey(apiKey);
  if (!trimmed) return { ok: false, message: "APIキーを入力してください" };
  try {
    const doFetch =
      fetchFn ||
      (() => nodeElevenLabsSttTest(trimmed));
    const { status, body } = await fetchWithTimeout(doFetch, "https://api.elevenlabs.io/v1/speech-to-text", {}, 30000);
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
    const trimmed = normalizeApiKey(apiKey);
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
          lookup: (hostname, options, callback) => {
            dns.lookup(hostname, { ...options, family: 4 }, callback);
          },
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
    const key = normalizeApiKey(apiKeyOverride) || resolveProviderKey(provider).value;
    if (!key) return { ok: false, message: "APIキーが未設定です" };
    if (provider === "elevenlabs") return testElevenLabsConnection(key);
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
  formatNetworkError,
  normalizeApiKey,
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
