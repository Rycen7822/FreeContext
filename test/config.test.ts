import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSecret, redactUrl, resolveConfig } from "../src/config.js";
import { createModel, createRequestOptions, redactProviderError } from "../src/runtime/model.js";
import { baseConfig } from "./helpers.js";

const KEYS = Object.freeze({ PRIMARY_KEY: "primary-secret", BACKUP_KEY: "backup-secret" });

function baseToml(): string {
  return `
version = 1
default_route = "default"

[runtime]
prompt_path = "prompt.md"
max_turns = 5
max_tool_calls = 18
provider_retry_delays_ms = [3000, 6000, 12000]

[providers.primary]
api = "anthropic"
base_url = "https://primary.example/v1/"
auth_mode = "bearer"
credential_env = "PRIMARY_KEY"

[providers.backup]
api = "openai"
base_url = "https://backup.example/v1/"
credential_env = "BACKUP_KEY"

[models.primary]
provider = "primary"
model_id = "primary-model"
context_window = 32768
max_output_tokens = 1024
thinking_level = "off"

[models.backup]
provider = "backup"
model_id = "backup-model"
context_window = 128000
max_output_tokens = 4096
thinking_level = "high"

[models.backup.openai_compat]
use_streaming = false
supports_reasoning_effort = true
supports_required_tool_choice = false
max_tokens_field = "max_completion_tokens"
thinking_format = "deepseek"

[routes.default]
models = ["primary", "backup"]
fallback_on = ["timeout", "rate_limit", "server_error", "connection"]

[routes.backup_only]
models = ["backup"]
`;
}

async function withConfig<T>(source: string, run: (configFile: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-toml-"));
  try {
    await writeFile(path.join(directory, "prompt.md"), "{{WORKSPACE}} {{TOOLS}} {{OVERVIEW}}", "utf8");
    const configFile = path.join(directory, "config.toml");
    await writeFile(configFile, source, "utf8");
    return await run(configFile, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resolveConfig loads TOML catalogs and keeps CLI over environment over file precedence", async () => {
  await withConfig(baseToml(), async (configFile, directory) => {
    const route = await resolveConfig({
      cli: { configFile, maxTurns: "5" },
      processEnv: { ...KEYS, FREECONTEXT_MAX_TURNS: "6" },
    });
    assert.equal(route.route, "default");
    assert.deepEqual(route.fallbackOn, ["timeout", "rate_limit", "server_error", "connection"]);
    assert.equal(route.targets.length, 2);
    assert.equal(route.targets[0]?.target, "primary");
    assert.equal(route.targets[0]?.provider, "primary");
    assert.equal(route.targets[0]?.apiKey, KEYS.PRIMARY_KEY);
    assert.equal(route.targets[0]?.baseUrl, "https://primary.example/v1");
    assert.equal(route.targets[0]?.maxTurns, 5);
    assert.deepEqual(route.targets[0]?.providerRetryDelaysMs, [3000, 6000, 12000]);
    assert.equal(route.targets[0]?.promptPath, path.join(directory, "prompt.md"));
    assert.equal(route.targets[1]?.apiKey, KEYS.BACKUP_KEY);
    assert.equal(route.targets[0]?.openAICompat.supportsRequiredToolChoice, true);
    assert.equal(route.targets[1]?.openAICompat.supportsRequiredToolChoice, false);
    assert.equal(route.targets[0]?.openAICompat.useStreaming, true);
    assert.equal(route.targets[1]?.openAICompat.useStreaming, false);
  });
});

test("tracked TOML examples remain loadable without embedded credentials", async () => {
  const general = await resolveConfig({
    cli: { configFile: new URL("../freecontext.example.toml", import.meta.url).pathname },
    processEnv: { ANTHROPIC_API_KEY: "example-test-key" },
  });
  assert.deepEqual(general.targets.map((target) => target.target), ["claude"]);

  const sensenova = await resolveConfig({
    cli: { configFile: new URL("../freecontext.sensenova.example.toml", import.meta.url).pathname },
    processEnv: { SENSENOVA_API_KEY: "example-test-key" },
  });
  assert.deepEqual(sensenova.targets.map((target) => target.target), ["sensenova_flash"]);

  const benchmark = await resolveConfig({
    cli: { configFile: new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname },
    processEnv: { TOKENRHYTHM_API_KEY: "example-test-key" },
  });
  assert.deepEqual(benchmark.targets.map((target) => target.target), ["tokenrhythm"]);
  assert.equal(benchmark.targets[0]?.model, "deepseek-v4-flash-0731");
  assert.equal(benchmark.targets[0]?.openAICompat.useStreaming, false);
});

test("target and route overrides are deterministic", async () => {
  await withConfig(baseToml(), async (configFile) => {
    const target = await resolveConfig({ cli: { configFile, target: "backup" }, processEnv: KEYS });
    assert.equal(target.route, "target:backup");
    assert.deepEqual(target.fallbackOn, []);
    assert.deepEqual(target.targets.map((item) => item.target), ["backup"]);

    const route = await resolveConfig({
      cli: { configFile },
      processEnv: { ...KEYS, FREECONTEXT_ROUTE: "backup_only" },
    });
    assert.equal(route.route, "backup_only");
    assert.deepEqual(route.fallbackOn, ["timeout", "rate_limit", "server_error", "connection"]);
    assert.deepEqual(route.targets.map((item) => item.target), ["backup"]);
  });
});

test("runtime exploration ceilings reject values above eight turns or eighteen calls", async () => {
  await withConfig(baseToml(), async (configFile) => {
    await assert.rejects(
      () => resolveConfig({ cli: { configFile, maxTurns: "9" }, processEnv: KEYS }),
      /max_turns.*\[2, 8\]/u,
    );
    await assert.rejects(
      () => resolveConfig({ cli: { configFile, maxToolCalls: "19" }, processEnv: KEYS }),
      /max_tool_calls.*\[1, 18\]/u,
    );
  });
});

test("TOML schema rejects unknown fields, sensitive headers, and broken references", async () => {
  await withConfig(
    baseToml().replace('credential_env = "PRIMARY_KEY"', 'credential_env = "PRIMARY_KEY"\napi_key = "secret"'),
    async (configFile) => {
      await assert.rejects(() => resolveConfig({ cli: { configFile }, processEnv: KEYS }), /unknown key.*api_key/u);
    },
  );
  await withConfig(
    baseToml().replace(
      '[providers.backup]',
      '[providers.primary.headers]\nAuthorization = "secret"\n\n[providers.backup]',
    ),
    async (configFile) => {
      await assert.rejects(() => resolveConfig({ cli: { configFile }, processEnv: KEYS }), /is sensitive/u);
    },
  );
  await withConfig(baseToml().replace('models = ["backup"]', 'models = ["missing"]'), async (configFile) => {
    await assert.rejects(() => resolveConfig({ cli: { configFile }, processEnv: KEYS }), /unknown model: missing/u);
  });
});

test("selected targets require credentials only from named environment variables", async () => {
  await withConfig(baseToml(), async (configFile) => {
    await assert.rejects(
      () => resolveConfig({ cli: { configFile, target: "primary" }, processEnv: {} }),
      /requires credential environment variable PRIMARY_KEY/u,
    );
    const route = await resolveConfig({
      cli: { configFile, target: "primary" },
      processEnv: { PRIMARY_KEY: KEYS.PRIMARY_KEY },
    });
    assert.equal(route.targets[0]?.apiKey, KEYS.PRIMARY_KEY);
  });
});

test("request authentication keeps secrets outside model metadata", () => {
  const automatic = baseConfig();
  const autoModel = createModel(automatic);
  const auto = createRequestOptions(automatic);
  assert.equal(auto.apiKey, automatic.apiKey);
  assert.equal(auto.headers.Authorization, undefined);
  assert.equal(auto.timeoutMs, automatic.requestTimeoutMs);
  assert.equal(auto.maxRetries, 0);
  assert.equal(JSON.stringify(autoModel).includes(automatic.apiKey), false);

  const bearer = createRequestOptions(baseConfig({ authMode: "bearer" }));
  assert.equal(bearer.apiKey, undefined);
  assert.equal(bearer.headers.Authorization, "Bearer sk-test-secret");

  const xApi = createRequestOptions(baseConfig({ authMode: "x-api-key" }));
  assert.equal(xApi.apiKey, undefined);
  assert.equal(xApi.headers["x-api-key"], "sk-test-secret");
});

test("OpenAI model consumes model-specific compatibility metadata", async () => {
  await withConfig(baseToml(), async (configFile) => {
    const route = await resolveConfig({ cli: { configFile, target: "backup" }, processEnv: KEYS });
    const config = route.targets[0];
    assert.ok(config);
    const model = createModel(config);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.equal(model.compat.maxTokensField, "max_completion_tokens");
    assert.equal(model.compat.thinkingFormat, "deepseek");
    assert.equal(config.openAICompat.supportsRequiredToolChoice, false);
  });
});

test("invalid OpenAI compatibility and integer values are rejected", async () => {
  await withConfig(
    baseToml().replace('max_tokens_field = "max_completion_tokens"', 'max_tokens_field = "tokens"'),
    async (configFile) => {
      await assert.rejects(
        () => resolveConfig({ cli: { configFile, target: "backup" }, processEnv: KEYS }),
        /max_tokens or max_completion_tokens/u,
      );
    },
  );
  await withConfig(
    baseToml().replace('thinking_format = "deepseek"', 'thinking_format = "unknown"'),
    async (configFile) => {
      await assert.rejects(
        () => resolveConfig({ cli: { configFile, target: "backup" }, processEnv: KEYS }),
        /must be openai or deepseek/u,
      );
    },
  );
  await withConfig(baseToml(), async (configFile) => {
    await assert.rejects(
      () => resolveConfig({ cli: { configFile }, processEnv: { ...KEYS, FREECONTEXT_MAX_TURNS: "8turns" } }),
      /must be an integer/u,
    );
    await assert.rejects(
      () => resolveConfig({
        cli: { configFile, providerRetryDelaysMs: "100,200,300,400,500,600" },
        processEnv: KEYS,
      }),
      /at most 5 values/u,
    );
    await assert.rejects(
      () => resolveConfig({ cli: { configFile, providerRetryDelaysMs: "99" }, processEnv: KEYS }),
      /integer in \[100, 60000\]/u,
    );
  });
});

test("retry delay vector follows CLI over environment over TOML and supports explicit disable", async () => {
  await withConfig(baseToml(), async (configFile) => {
    const fromCli = await resolveConfig({
      cli: { configFile, providerRetryDelaysMs: "100,200" },
      processEnv: { ...KEYS, FREECONTEXT_PROVIDER_RETRY_DELAYS_MS: "300,400" },
    });
    assert.deepEqual(fromCli.targets[0]?.providerRetryDelaysMs, [100, 200]);

    const disabled = await resolveConfig({
      cli: { configFile, providerRetryDelaysMs: "" },
      processEnv: KEYS,
    });
    assert.deepEqual(disabled.targets[0]?.providerRetryDelaysMs, []);
  });
});

test("context budget defaults are compiled independently for each model", async () => {
  const source = baseToml()
    .replace("context_window = 32768", "context_window = 8192")
    .replace("max_output_tokens = 1024", "max_output_tokens = 4096");
  await withConfig(source, async (configFile) => {
    const route = await resolveConfig({ cli: { configFile }, processEnv: KEYS });
    const small = route.targets[0];
    const normal = route.targets[1];
    assert.equal(small?.contextReserveTokens, 4096);
    assert.equal(small?.contextKeepRecentTokens, 2048);
    assert.equal(small?.effectiveToolOutputBytes, 8192);
    assert.equal(normal?.contextReserveTokens, 16384);
    assert.equal(normal?.contextKeepRecentTokens, 20000);
    assert.equal(normal?.effectiveToolOutputBytes, 65536);
  });
});

test("conflicting model context budgets are rejected", async () => {
  const source = baseToml().replace(
    "max_output_tokens = 1024",
    "max_output_tokens = 4096\ncontext_reserve_tokens = 3000\ncontext_keep_recent_tokens = 1024",
  );
  await withConfig(source, async (configFile) => {
    await assert.rejects(() => resolveConfig({ cli: { configFile }, processEnv: KEYS }), /conflicting context budget/u);
  });
});

test("disabled compaction preserves the configured tool output ceiling", async () => {
  await withConfig(baseToml(), async (configFile) => {
    const route = await resolveConfig({
      cli: { configFile, maxToolOutputBytes: 12000 },
      processEnv: { ...KEYS, FREECONTEXT_COMPACTION_ENABLED: "false" },
    });
    assert.equal(route.targets[0]?.contextCompactionEnabled, false);
    assert.equal(route.targets[0]?.effectiveToolOutputBytes, 12000);
  });
});

test("provider errors, helper values, and invalid URLs stay redacted", async () => {
  const config = baseConfig();
  assert.equal(redactProviderError("failed with sk-test-secret", config), "failed with <redacted>");
  assert.equal(redactSecret("sk-test-secret"), "<redacted>");
  assert.equal(
    redactUrl("https://user:password@example.invalid/v1?api_key=secret#fragment"),
    "https://redacted:redacted@example.invalid/v1?api_key=redacted",
  );

  const source = baseToml().replace(
    "https://primary.example/v1/",
    "not-a-url?api_key=embedded-secret",
  );
  await withConfig(source, async (configFile) => {
    await assert.rejects(
      () => resolveConfig({ cli: { configFile, target: "primary" }, processEnv: KEYS }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /embedded-secret/u);
        return true;
      },
    );
  });
});
