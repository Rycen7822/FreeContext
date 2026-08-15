import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { resolveConfig } from "../src/config.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";
import { runPiSession } from "../src/runtime/pi-session.js";

const DUMMY_KEY = "offline-wire-contract-key";

test("bundled TokenRhythm config produces the accepted Pi Chat Completions wire shape offline", async () => {
  const configFile = new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname;
  const route = await resolveConfig({
    cli: { configFile },
    processEnv: { TOKENRHYTHM_API_KEY: DUMMY_KEY },
  });
  const config = route.targets[0];
  assert.ok(config);
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
    const stream = await streamSimple(
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
    assert.equal(endpoint, "https://tokenrhythm.studio/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const payload = capture.payload;
  assert.ok(payload);
  assert.deepEqual(Object.keys(payload).sort(), [
    "max_tokens",
    "messages",
    "model",
    "stream",
    "temperature",
    "tools",
  ]);
  assert.equal(payload.model, "deepseek-v4-flash-0731");
  assert.equal(payload.stream, true);
  assert.equal(payload.max_tokens, 4096);
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
    "reasoning_effort",
    "store",
    "prompt_cache_key",
  ]) {
    assert.equal(Object.hasOwn(payload, absent), false, absent);
  }
});

test("the real Pi transport retries a TokenRhythm SERVICE_BUSY response through the harness", async () => {
  const configFile = new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname;
  const route = await resolveConfig({
    cli: { configFile },
    processEnv: { TOKENRHYTHM_API_KEY: DUMMY_KEY },
  });
  const selected = route.targets[0];
  assert.ok(selected);
  const config = {
    ...selected,
    contextCompactionEnabled: false,
    providerRetryDelaysMs: [1, 2, 4],
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({ code: "SERVICE_BUSY", message: "服务繁忙，请稍后重试" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    const event = JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash-0731",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
    const result = await runPiSession({
      bindings: await loadPiBindings("openai"),
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      systemPrompt: "Reply briefly.",
      promptText: "Reply with ok.",
      tools: [],
    });
    assert.equal(result.text, "ok");
    assert.equal(result.metrics.providerAttempts, 2);
    assert.equal(result.metrics.providerRetries, 1);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
