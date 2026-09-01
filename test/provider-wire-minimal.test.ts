import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { resolveConfig } from "../src/config.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";

test("the configured DeepSWE target keeps its OpenAI-compatible wire shape", async () => {
  const route = await resolveConfig({
    cli: { configFile: new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url).pathname },
    processEnv: { FREECONTEXT_PROVIDER_API_KEY: "offline-wire-test-key" },
  });
  const config = route.targets[0];
  assert.ok(config);
  assert.equal(config.model, "glm-5.3-flash");
  assert.equal(config.openAICompat.useStreaming, false);
  const model = createModel(config);
  assert.equal(model.api, "openai-completions");
  const payloads: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline wire test");
  }) as typeof fetch;
  try {
    const bindings = await loadPiBindings("openai", null, false);
    const tool = {
      name: "read",
      label: "Read",
      description: "Read one bounded file range.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
    };
    const stream = await bindings.streamSimple(
      model,
      { systemPrompt: "Reply with OK.", messages: [{ role: "user", content: "Question", timestamp: 1 }], tools: [tool] },
      { ...createRequestOptions(config), maxRetries: 0, onPayload: (payload) => payloads.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>) },
    );
    assert.equal((await stream.result()).stopReason, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const payload = payloads[0];
  assert.ok(payload);
  assert.equal(payload.model, "glm-5.3-flash");
  assert.deepEqual(payload.thinking, { type: "enabled" });
  assert.equal(payload.reasoning_effort, "high");
  assert.equal(payload.stream, false);
  assert.equal(payload.max_tokens, 8192);
  assert.equal(JSON.stringify(payload).includes("offline-wire-test-key"), false);
});
