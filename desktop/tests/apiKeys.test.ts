import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_REFINE_PROVIDER_PRIORITY,
  buildApiKeyStatus,
  buildPipelineEnvKeys,
  formatAnthropicTestError,
  formatElevenTestError,
  formatNetworkError,
  normalizeApiKey,
  formatGeminiTestError,
  formatOpenAiTestError,
  maskLastFour,
  parseDotenvContent,
  providerEnvName,
  providerStorageField,
  resolveActiveAiRefineProvider,
  resolveApiKey,
  testAnthropicConnection,
  testElevenLabsConnection,
  testGeminiConnection,
  testOpenAiConnection,
} from "../src/lib/apiKeys.ts";

test("maskLastFour: 末尾4桁を返し、短いキーは null", () => {
  assert.equal(maskLastFour("sk_test1234567890abcd"), "abcd");
  assert.equal(maskLastFour("abc"), null);
  assert.equal(maskLastFour(""), null);
});

test("resolveApiKey: userData > env > dotenv > settings の優先順位", () => {
  assert.deepEqual(
    resolveApiKey({
      userDataKey: "user-key",
      envKey: "env-key",
      dotenvKey: "dotenv-key",
      settingsKey: "settings-key",
    }),
    { value: "user-key", source: "userData" },
  );
  assert.deepEqual(
    resolveApiKey({
      envKey: "env-key",
      dotenvKey: "dotenv-key",
      settingsKey: "settings-key",
    }),
    { value: "env-key", source: "env" },
  );
  assert.deepEqual(
    resolveApiKey({
      dotenvKey: "dotenv-key",
      settingsKey: "settings-key",
    }),
    { value: "dotenv-key", source: "dotenv" },
  );
  assert.deepEqual(
    resolveApiKey({
      settingsKey: "settings-key",
    }),
    { value: "settings-key", source: "settings" },
  );
  assert.deepEqual(resolveApiKey({}), { value: "", source: null });
});

test("buildApiKeyStatus: configured/lastFour/source を組み立てる", () => {
  assert.deepEqual(buildApiKeyStatus({ value: "sk_abcdefghijklmnop", source: "dotenv" }), {
    configured: true,
    lastFour: "mnop",
    source: "dotenv",
  });
  assert.deepEqual(buildApiKeyStatus({ value: "", source: null }), {
    configured: false,
    lastFour: null,
    source: null,
  });
});

test("parseDotenvContent: コメントと空行を無視して KEY=VALUE を読む", () => {
  const parsed = parseDotenvContent(`
# comment
ELEVEN_API_KEY=dotenv-eleven

ANTHROPIC_API_KEY=dotenv-anthropic
OPENAI_API_KEY=dotenv-openai
GEMINI_API_KEY=dotenv-gemini
`);
  assert.equal(parsed.ELEVEN_API_KEY, "dotenv-eleven");
  assert.equal(parsed.ANTHROPIC_API_KEY, "dotenv-anthropic");
  assert.equal(parsed.OPENAI_API_KEY, "dotenv-openai");
  assert.equal(parsed.GEMINI_API_KEY, "dotenv-gemini");
});

test("providerEnvName / providerStorageField: 4プロバイダ対応", () => {
  assert.equal(providerEnvName("openai"), "OPENAI_API_KEY");
  assert.equal(providerEnvName("gemini"), "GEMINI_API_KEY");
  assert.equal(providerStorageField("openai"), "openai_api_key");
  assert.equal(providerStorageField("gemini"), "gemini_api_key");
});

test("resolveActiveAiRefineProvider: anthropic > openai > gemini", () => {
  const none = {
    anthropic: buildApiKeyStatus({ value: "", source: null }),
    openai: buildApiKeyStatus({ value: "", source: null }),
    gemini: buildApiKeyStatus({ value: "", source: null }),
  };
  assert.equal(resolveActiveAiRefineProvider(none), null);

  const all = {
    anthropic: buildApiKeyStatus({ value: "ant-key", source: "userData" }),
    openai: buildApiKeyStatus({ value: "oai-key", source: "userData" }),
    gemini: buildApiKeyStatus({ value: "gem-key", source: "userData" }),
  };
  assert.equal(resolveActiveAiRefineProvider(all), "anthropic");

  const geminiOnly = {
    anthropic: buildApiKeyStatus({ value: "", source: null }),
    openai: buildApiKeyStatus({ value: "", source: null }),
    gemini: buildApiKeyStatus({ value: "gem-key", source: "userData" }),
  };
  assert.equal(resolveActiveAiRefineProvider(geminiOnly), "gemini");
  assert.deepEqual(AI_REFINE_PROVIDER_PRIORITY, ["anthropic", "openai", "gemini"]);
});

test("buildPipelineEnvKeys: 設定済みキーのみ環境変数に注入", () => {
  const env = buildPipelineEnvKeys({
    elevenlabs: resolveApiKey({ userDataKey: "el" }),
    anthropic: resolveApiKey({}),
    openai: resolveApiKey({ envKey: "oai" }),
    gemini: resolveApiKey({ dotenvKey: "gem" }),
  });
  assert.equal(env.ELEVEN_API_KEY, "el");
  assert.equal(env.OPENAI_API_KEY, "oai");
  assert.equal(env.GEMINI_API_KEY, "gem");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("normalizeApiKey: 不可視文字と前後空白を除去", () => {
  assert.equal(normalizeApiKey("  sk_test  "), "sk_test");
  assert.equal(normalizeApiKey("\uFEFFsk_test"), "sk_test");
});

test("formatNetworkError: 典型エラーコード別メッセージ", () => {
  assert.match(formatNetworkError({ code: "ENOTFOUND" }), /api\.elevenlabs\.io/);
  assert.match(formatNetworkError({ code: "ETIMEDOUT" }), /タイムアウト/);
  assert.match(formatNetworkError({ message: "timeout" }), /タイムアウト/);
});

test("formatElevenTestError / formatAnthropicTestError / OpenAI / Gemini: ステータス別メッセージ", () => {
  assert.equal(formatElevenTestError(null, true), "インターネット接続を確認してください");
  assert.equal(formatElevenTestError(null, true, "詳細エラー"), "詳細エラー");
  assert.equal(formatElevenTestError(401, false), "キーが正しくありません。コピーし直してください");
  assert.equal(formatAnthropicTestError(null, true), "インターネット接続を確認してください");
  assert.equal(formatAnthropicTestError(403, false), "Billing（お支払い）でクレジットを購入済みか確認してください");
  assert.equal(formatOpenAiTestError(401, false), "キーが正しくありません。コピーし直してください");
  assert.equal(formatOpenAiTestError(429, false), "リクエスト過多またはクレジット不足の可能性があります。しばらく待ってから再試行してください");
  assert.equal(formatGeminiTestError(403, false), "キーが正しくありません。コピーし直してください");
});

test("testElevenLabsConnection: 成功レスポンスをモックで検証", async () => {
  const result = await testElevenLabsConnection("sk_test", async () => ({
    status: 200,
    body: JSON.stringify({ text: "", words: [] }),
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.message, "接続できました（文字起こしAPI）");
  }
});

test("testElevenLabsConnection: 401 をモックで検証", async () => {
  const result = await testElevenLabsConnection("bad-key", async () => ({ status: 401, body: "" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "キーが正しくありません。コピーし直してください");
  }
});

test("testElevenLabsConnection: ネットワークエラーをモックで検証", async () => {
  const result = await testElevenLabsConnection("sk_test", async () => {
    throw new Error("network");
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /接続に失敗しました/);
  }
});

test("testAnthropicConnection: 200成功と401失敗をモックで検証", async () => {
  const ok = await testAnthropicConnection("sk-ant-test", async () => ({ status: 200, body: "{}" }));
  assert.equal(ok.ok, true);

  const bad = await testAnthropicConnection("sk-ant-bad", async () => ({ status: 401, body: "" }));
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.message, "キーが正しくありません。コピーし直してください");
  }
});

test("testOpenAiConnection: 200成功・401失敗・ネットワークエラー", async () => {
  const ok = await testOpenAiConnection("sk-openai", async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer sk-openai");
    return { status: 200, body: "{}" };
  });
  assert.equal(ok.ok, true);

  const bad = await testOpenAiConnection("bad", async () => ({ status: 401, body: "" }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.message, "キーが正しくありません。コピーし直してください");

  const net = await testOpenAiConnection("sk", async () => {
    throw new Error("network");
  });
  assert.equal(net.ok, false);
});

test("testGeminiConnection: 200成功・403失敗・ネットワークエラー", async () => {
  const ok = await testGeminiConnection("gem-key", async (_url, init) => {
    assert.equal(init.headers["x-goog-api-key"], "gem-key");
    return { status: 200, body: "{}" };
  });
  assert.equal(ok.ok, true);

  const bad = await testGeminiConnection("bad", async () => ({ status: 403, body: "" }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.message, "キーが正しくありません。コピーし直してください");

  const net = await testGeminiConnection("gem", async () => {
    throw new Error("network");
  });
  assert.equal(net.ok, false);
});
