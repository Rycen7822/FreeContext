import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { resolveConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";
import { runIsolatedFinalizer, runPiSession } from "../src/runtime/pi-session.js";
import { baseRequest } from "./helpers.js";

const DUMMY_KEY = "offline-wire-contract-key";
const SERVICE_BUSY_FIXTURE_TOML = `
version = 1
default_route = "default"

[runtime]
max_turns = 8
max_tool_calls = 18
provider_retry_delays_ms = [3000, 6000, 12000]

[providers.tokenrhythm]
api = "openai"
base_url = "https://tokenrhythm.studio/v1"
credential_env = "SERVICE_BUSY_API_KEY"

[models.tokenrhythm]
provider = "tokenrhythm"
model_id = "deepseek-v4-flash-0731"
context_window = 1000000
max_output_tokens = 8192
thinking_level = "low"

[models.tokenrhythm.openai_compat]
use_streaming = false
supports_reasoning_effort = true
supports_strict_mode = false
supports_required_tool_choice = false
max_tokens_field = "max_tokens"
thinking_format = "deepseek"

[routes.default]
models = ["tokenrhythm"]
`;

async function withTomlFixture<T>(source: string, run: (configFile: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-wire-fixture-"));
  const configFile = path.join(directory, "freecontext.toml");
  try {
    await writeFile(configFile, source, "utf8");
    return await run(configFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertReasoningPayload(
  payload: Record<string, unknown>,
  expectedModel = "glm-5.3-flash",
  expectedReasoning = "low",
): void {
  assert.equal(payload.model, expectedModel);
  assert.deepEqual(payload.thinking, { type: "enabled" });
  assert.equal(payload.reasoning_effort, expectedReasoning);
}

function completionResponse(
  id: string,
  message: Readonly<Record<string, unknown>>,
  finishReason: "stop" | "tool_calls",
  model = "glm-5.3-flash",
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("bundled primary config produces the accepted Pi Chat Completions wire shape offline", async () => {
  const configFile = new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname;
  const route = await resolveConfig({
    cli: { configFile },
    processEnv: { FREECONTEXT_PROVIDER_API_KEY: DUMMY_KEY },
  });
  const config = route.targets[0];
  assert.ok(config);
  assert.equal(config.target, "primary");
  assert.equal(config.provider, "primary");
  assert.equal(config.model, "glm-5.3-flash");
  assert.equal(config.thinkingLevel, "high");
  assert.equal(config.openAICompat.supportsReasoningEffort, true);
  const model = createModel(config);
  assert.equal(model.api, "openai-completions");
  if (model.api !== "openai-completions") throw new Error("benchmark config selected a non-OpenAI model");
  const requestOptions = createRequestOptions(config);
  const capture: { payload?: Record<string, unknown> } = {};
  let endpoint: string | null = null;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    fetchCalls += 1;
    endpoint = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    throw new Error("OFFLINE_FETCH_STOP");
  }) as typeof fetch;

  try {
    const tool = {
      name: "read",
      label: "Read",
      description: "Read one bounded file range.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
    };
    const bindings = await loadPiBindings("openai", null, config.openAICompat.useStreaming);
    const stream = await bindings.streamSimple(
      model,
      {
        systemPrompt: "This is an offline transport contract. Do not call tools.",
        messages: [{ role: "user", content: "Reply with OK.", timestamp: 1 }],
        tools: [tool],
      },
      {
        ...requestOptions,
        maxRetries: 0,
        onPayload: (value) => {
          capture.payload = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
        },
      },
    );
    const result = await stream.result();

    assert.equal(result.stopReason, "error");
    assert.equal(fetchCalls, 1);
    assert.equal(endpoint, "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const payload = capture.payload;
  assert.ok(payload);
  assert.deepEqual(Object.keys(payload).sort(), [
    "max_tokens",
    "messages",
    "model",
    "reasoning_effort",
    "stream",
    "temperature",
    "thinking",
    "tools",
  ]);
  assertReasoningPayload(payload, "glm-5.3-flash", "high");
  assert.equal(payload.stream, false);
  assert.equal(payload.max_tokens, 8192);
  assert.equal(payload.temperature, 0);

  const messages = payload.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  const tools = payload.tools as Array<{ readonly type?: unknown; readonly function?: Record<string, unknown> }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[0]?.function?.name, "read");
  assert.equal(Object.hasOwn(tools[0]?.function ?? {}, "strict"), false);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(DUMMY_KEY), false);
  for (const absent of [
    "tool_choice",
    "stream_options",
    "developer",
    "reasoning",
    "store",
    "prompt_cache_key",
  ]) {
    assert.equal(Object.hasOwn(payload, absent), false, absent);
  }
});

test("the non-stream transport retries a TokenRhythm 200 SERVICE_BUSY body through the harness", async () => {
  const route = await withTomlFixture(SERVICE_BUSY_FIXTURE_TOML, (configFile) => resolveConfig({
    cli: { configFile },
    processEnv: { SERVICE_BUSY_API_KEY: DUMMY_KEY },
  }));
  const selected = route.targets[0];
  assert.ok(selected);
  const config = {
    ...selected,
    contextCompactionEnabled: false,
    providerRetryDelaysMs: [1, 2, 4],
  };
  const payloads: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({ code: "SERVICE_BUSY", message: "服务繁忙，请稍后重试" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return completionResponse("chatcmpl-test", {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "submit-retry",
        type: "function",
        function: {
          name: "submit_evidence",
          arguments: JSON.stringify({
            summary: "No repository evidence was needed for the retry probe.",
            evidence: [],
            gaps: [
              { question_id: "impl", reason: "No repository evidence was requested." },
              { question_id: "tests", reason: "No repository evidence was requested." },
            ],
          }),
        },
      }],
    }, "tool_calls", "deepseek-v4-flash-0731");
  }) as typeof fetch;

  try {
    const result = await runPiSession({
      bindings: await loadPiBindings("openai", null, config.openAICompat.useStreaming),
      model: createModel(config),
      requestOptions: {
        ...createRequestOptions(config),
        onPayload: (value) => {
          payloads.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
        },
      },
      config,
      systemPrompt: "Reply briefly.",
      promptText: "Reply with ok.",
      finalizationRequest: baseRequest(),
      tools: [],
    });
    assert.equal(result.candidate?.summary, "No repository evidence was needed for the retry probe.");
    assert.equal(result.metrics.providerAttempts, 2);
    assert.equal(result.metrics.providerRetries, 1);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(payloads.length, 2);
  for (const payload of payloads) assertReasoningPayload(payload, "deepseek-v4-flash-0731");
});

test("isolated finalization sends required submit_evidence without provider strict mode", async () => {
  const configFile = new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname;
  const route = await resolveConfig({
    cli: { configFile },
    processEnv: { FREECONTEXT_PROVIDER_API_KEY: DUMMY_KEY },
  });
  const selected = route.targets[0];
  assert.ok(selected);
  const config = {
    ...selected,
    openAICompat: { ...selected.openAICompat, supportsRequiredToolChoice: true },
    maxTurns: 2,
    contextCompactionEnabled: false,
    providerRetryDelaysMs: [1, 2, 4],
  };
  const payloads: Record<string, unknown>[] = [];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 3) {
      return new Response(JSON.stringify({ code: "SERVICE_BUSY", message: "busy", traceId: "offline" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (fetchCalls > 3) {
      return new Response(JSON.stringify({ error: { message: "offline finalizer stop" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return completionResponse(
      "chatcmpl-exploration",
      { role: "assistant", content: "explored" },
      "stop",
    );
  }) as typeof fetch;

  try {
    await assert.rejects(runPiSession({
      bindings: await loadPiBindings("openai", null, config.openAICompat.useStreaming),
      model: createModel(config),
      requestOptions: {
        ...createRequestOptions(config),
        onPayload: (value) => {
          payloads.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
        },
      },
      config,
      systemPrompt: "Explore.",
      promptText: "Inspect the repository.",
      finalizationRequest: baseRequest(),
      tools: [],
      tokenCounter: { countBatch: async (texts) => texts.map((text) => Math.ceil(text.length / 4)) },
    }), ProviderError);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 4);
  assert.equal(payloads.length, 4);
  for (const payload of payloads) assertReasoningPayload(payload, "glm-5.3-flash", "high");
  assert.equal(Object.hasOwn(payloads[0] ?? {}, "tool_choice"), false);
  assert.equal(Object.hasOwn(payloads[1] ?? {}, "tool_choice"), false);
  assert.equal(payloads[2]?.tool_choice, "required");
  assert.equal(payloads[3]?.tool_choice, "required");
  assert.deepEqual(payloads[3]?.messages, payloads[2]?.messages);
  assert.deepEqual(payloads[3]?.tools, payloads[2]?.tools);
  const finalTools = payloads[2]?.tools as Array<{ readonly function?: Record<string, unknown> }>;
  assert.equal(finalTools.length, 1);
  assert.equal(finalTools[0]?.function?.name, "submit_evidence");
  assert.equal(Object.hasOwn(finalTools[0]?.function ?? {}, "strict"), false);
  const finalMessages = payloads[2]?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(finalMessages.map((message) => message.role), ["system", "user"]);
  assert.equal(String(finalMessages[0]?.content).includes("untrusted data"), true);
  assert.equal(JSON.stringify(finalMessages).includes("explored"), false);
});

test("provider probe preserves one isolated context across a connection retry", async () => {
  const configFile = new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname;
  const route = await resolveConfig({
    cli: { configFile },
    processEnv: { FREECONTEXT_PROVIDER_API_KEY: DUMMY_KEY },
  });
  const selected = route.targets[0];
  assert.ok(selected);
  const config = { ...selected, contextCompactionEnabled: false, providerRetryDelaysMs: [1, 2, 4] };
  const payloads: Record<string, unknown>[] = [];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    }
    return completionResponse("chatcmpl-probe", {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "submit-probe",
        type: "function",
        function: {
          name: "submit_evidence",
          arguments: JSON.stringify({
            summary: "The fixture export is defined.",
            evidence: [{
              question_id: "impl",
              observation_id: 1,
              start_line: 1,
              end_line: 1,
              why: "Defines the fixture export.",
            }],
            gaps: [{ question_id: "tests", reason: "No test observation was supplied." }],
          }),
        },
      }],
    }, "tool_calls");
  }) as typeof fetch;

  try {
    const result = await runIsolatedFinalizer({
      bindings: await loadPiBindings("openai", null, config.openAICompat.useStreaming),
      model: createModel(config),
      requestOptions: {
        ...createRequestOptions(config),
        onPayload: (value) => {
          payloads.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
        },
      },
      config,
      request: baseRequest(),
      observedReads: [{
        tool: "read",
        path: "fixture.ts",
        startLine: 1,
        endLine: 1,
        content: "1 export const fixture = true;",
      }],
      tokenCounter: { countBatch: async (texts) => texts.map((text) => Math.ceil(text.length / 4)) },
    });
    assert.equal(result.candidate?.summary, "The fixture export is defined.");
    assert.equal(result.metrics.providerAttempts, 2);
    assert.equal(result.metrics.providerRetries, 1);
    assert.equal(result.metrics.finalizationReason, "provider_probe");
    assert.deepEqual(result.explorationTools, []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 2);
  assert.equal(payloads.length, 2);
  for (const payload of payloads) assertReasoningPayload(payload, "glm-5.3-flash", "high");
  assert.equal(payloads[0]?.tool_choice, "auto");
  assert.equal(payloads[1]?.tool_choice, "auto");
  assert.deepEqual(payloads[1]?.messages, payloads[0]?.messages);
  assert.deepEqual(payloads[1]?.tools, payloads[0]?.tools);
  const tools = payloads[0]?.tools as Array<{ readonly function?: Record<string, unknown> }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.function?.name, "submit_evidence");
  assert.equal(Object.hasOwn(tools[0]?.function ?? {}, "strict"), false);
  const toolSchema = JSON.stringify(tools[0]?.function?.parameters);
  assert.equal(toolSchema.includes('"role"'), false);
  assert.equal(toolSchema.includes('"observation_id"'), true);
  assert.equal(toolSchema.includes('"target_id"'), false);
  assert.equal(toolSchema.includes('"focus_line"'), false);
  assert.equal(toolSchema.includes('"path"'), false);
  for (const unsupported of ["anyOf", "oneOf", "allOf", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "maxItems"]) {
    assert.equal(toolSchema.includes(`\"${unsupported}\"`), false, unsupported);
  }
  const messages = payloads[0]?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.equal(String(messages[0]?.content).includes("Repository tools are unavailable"), true);
  const packet = JSON.parse(String(messages[1]?.content)) as {
    readonly questions?: readonly Record<string, unknown>[];
    readonly submissionRules?: { readonly question_id?: string };
    readonly repositoryObservations?: readonly Record<string, unknown>[];
  };
  assert.equal(packet.submissionRules?.question_id, "exact questions[].id; the harness derives the single canonical target and role");
  assert.equal(JSON.stringify(packet).includes("target_id"), false);
  assert.equal(packet.questions?.[0]?.id, "impl");
  assert.deepEqual(packet.questions?.[0]?.target, {
    subject: { kind: "topic", topic: "implementation" },
    factKind: "location",
    coverageMode: "single",
  });
  assert.equal(packet.repositoryObservations?.[0]?.path, "fixture.ts");
  assert.equal(packet.repositoryObservations?.[0]?.content, "1 export const fixture = true;");
  assert.equal(packet.repositoryObservations?.[0]?.id, 1);
  assert.equal(Object.hasOwn(packet.repositoryObservations?.[0] ?? {}, "tool"), false);
});
