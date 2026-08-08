import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv, redactSecret, redactUrl, resolveConfig } from "../src/config.js";
import { createModel, createRequestOptions, redactProviderError } from "../src/runtime/model.js";
import { baseConfig } from "./helpers.js";

test("parseEnv handles comments, export, and quoted values", () => {
  const parsed = parseEnv(`
# comment
export A=one
B="two # kept" # removed
C='three # kept'
D=value # trailing
INVALID LINE
`);
  assert.deepEqual(parsed, { A: "one", B: "two # kept", C: "three # kept", D: "value" });
});

test("resolveConfig merges env file, process environment, and CLI in precedence order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-config-"));
  try {
    const envFile = path.join(directory, ".env");
    const prompt = path.join(directory, "prompt.md");
    await writeFile(prompt, "{{WORKSPACE}} {{TOOLS}} {{OVERVIEW}}", "utf8");
    await writeFile(
      envFile,
      [
        "FREECONTEXT_API=openai",
        "FREECONTEXT_AUTH_MODE=auto",
        "FREECONTEXT_BASE_URL=https://file.example/v1/",
        "FREECONTEXT_MODEL=file-model",
        "FREECONTEXT_API_KEY=file-key",
        `FREECONTEXT_PROMPT_PATH=${prompt}`,
        "FREECONTEXT_MAX_TURNS=7",
      ].join("\n"),
      "utf8",
    );
    const config = await resolveConfig({
      cli: { envFile, model: "cli-model", maxTurns: "5" },
      processEnv: { FREECONTEXT_BASE_URL: "https://process.example/v1/" },
    });
    assert.equal(config.api, "openai");
    assert.equal(config.model, "cli-model");
    assert.equal(config.baseUrl, "https://process.example/v1");
    assert.equal(config.apiKey, "file-key");
    assert.equal(config.maxTurns, 5);
    assert.equal(config.promptPath, prompt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request authentication modes keep secrets outside model metadata", () => {
  const automatic = baseConfig();
  const autoModel = createModel(automatic);
  const auto = createRequestOptions(automatic);
  assert.equal(auto.apiKey, automatic.apiKey);
  assert.equal(auto.headers.Authorization, undefined);
  assert.equal(JSON.stringify(autoModel).includes(automatic.apiKey), false);

  const bearer = createRequestOptions(baseConfig({ authMode: "bearer" }));
  assert.equal(bearer.apiKey, undefined);
  assert.equal(bearer.headers.Authorization, "Bearer sk-test-secret");

  const xApi = createRequestOptions(baseConfig({ authMode: "x-api-key" }));
  assert.equal(xApi.apiKey, undefined);
  assert.equal(xApi.headers["x-api-key"], "sk-test-secret");

  const both = createRequestOptions(baseConfig({ authMode: "both" }));
  assert.equal(both.apiKey, "sk-test-secret");
  assert.equal(both.headers.Authorization, "Bearer sk-test-secret");
});

test("OpenAI model uses conservative compatibility metadata", () => {
  const config = baseConfig({ api: "openai", authMode: "auto" });
  const model = createModel(config);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.compat.supportsStore, false);
  assert.equal(model.compat.supportsStrictMode, false);
  assert.equal(model.compat.maxTokensField, "max_tokens");
});

test("invalid OpenAI token field configuration is rejected", async () => {
  await assert.rejects(
    () =>
      resolveConfig({
        cli: { model: "test", promptPath: new URL("../prompts/explorer.md", import.meta.url).pathname },
        processEnv: {
          FREECONTEXT_API: "openai",
          FREECONTEXT_API_KEY: "test",
          FREECONTEXT_OPENAI_MAX_TOKENS_FIELD: "tokens",
        },
      }),
    /max_tokens or max_completion_tokens/u,
  );
});

test("integer configuration rejects numeric prefixes and suffixes", async () => {
  await assert.rejects(
    () =>
      resolveConfig({
        cli: { model: "test", promptPath: new URL("../prompts/explorer.md", import.meta.url).pathname },
        processEnv: {
          FREECONTEXT_API_KEY: "test",
          FREECONTEXT_MAX_TURNS: "8turns",
        },
      }),
    /must be an integer/u,
  );
});

test("context budget defaults scale at the minimum and normal context windows", async () => {
  const promptPath = new URL("../prompts/explorer.md", import.meta.url).pathname;
  const small = await resolveConfig({
    cli: { model: "test", promptPath, contextWindow: 8192 },
    processEnv: { FREECONTEXT_API_KEY: "test" },
  });
  assert.equal(small.contextCompactionEnabled, true);
  assert.equal(small.contextReserveTokens, 4096);
  assert.equal(small.contextKeepRecentTokens, 2048);
  assert.equal(small.effectiveToolOutputBytes, 8192);

  const normal = await resolveConfig({
    cli: { model: "test", promptPath, contextWindow: 128000 },
    processEnv: { FREECONTEXT_API_KEY: "test" },
  });
  assert.equal(normal.contextReserveTokens, 16384);
  assert.equal(normal.contextKeepRecentTokens, 20000);
  assert.equal(normal.effectiveToolOutputBytes, 65536);
});

test("context budget rejects conflicting enabled overrides", async () => {
  const promptPath = new URL("../prompts/explorer.md", import.meta.url).pathname;
  await assert.rejects(
    () => resolveConfig({
      cli: {
        model: "test",
        promptPath,
        contextWindow: 8192,
        maxOutputTokens: 4096,
        contextReserveTokens: 3000,
        contextKeepRecentTokens: 1024,
      },
      processEnv: { FREECONTEXT_API_KEY: "test" },
    }),
    /MAX_OUTPUT_TOKENS=4096.*CONTEXT_RESERVE_TOKENS=3000/u,
  );
  await assert.rejects(
    () => resolveConfig({
      cli: {
        model: "test",
        promptPath,
        contextWindow: 8192,
        contextReserveTokens: 4096,
        contextKeepRecentTokens: 4096,
      },
      processEnv: { FREECONTEXT_API_KEY: "test" },
    }),
    /CONTEXT_KEEP_RECENT_TOKENS=4096.*CONTEXT_WINDOW=8192/u,
  );
});

test("disabled compaction preserves the configured legacy tool output ceiling", async () => {
  const config = await resolveConfig({
    cli: {
      model: "test",
      promptPath: new URL("../prompts/explorer.md", import.meta.url).pathname,
      maxToolOutputBytes: 12000,
      contextReserveTokens: 0,
      contextKeepRecentTokens: 0,
    },
    processEnv: {
      FREECONTEXT_API_KEY: "test",
      FREECONTEXT_COMPACTION_ENABLED: "false",
    },
  });
  assert.equal(config.contextCompactionEnabled, false);
  assert.equal(config.effectiveToolOutputBytes, 12000);
});

test("provider errors and helper key display are redacted", () => {
  const config = baseConfig();
  assert.equal(redactProviderError("failed with sk-test-secret", config), "failed with <redacted>");
  const headerConfig = baseConfig({
    apiKey: "different-test-key",
    headers: { Authorization: "Bearer header-only-secret" },
  });
  assert.equal(
    redactProviderError(
      "request failed: Bearer header-only-secret (credential header-only-secret)",
      headerConfig,
    ),
    "request failed: <redacted> (credential <redacted>)",
  );
  assert.equal(redactSecret("sk-test-secret"), "<redacted>");
  assert.equal(
    redactUrl("https://user:password@example.invalid/v1?api_key=secret#fragment"),
    "https://redacted:redacted@example.invalid/v1?api_key=redacted",
  );
});

test("invalid base URL errors do not echo embedded credentials", async () => {
  await assert.rejects(
    () =>
      resolveConfig({
        cli: {
          model: "test",
          promptPath: new URL("../prompts/explorer.md", import.meta.url).pathname,
          baseUrl: "not-a-url?api_key=embedded-secret",
        },
        processEnv: { FREECONTEXT_API_KEY: "test" },
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /<invalid-url>/u);
      assert.doesNotMatch(error.message, /embedded-secret/u);
      return true;
    },
  );
});
