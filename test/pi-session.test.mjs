import test from "node:test";
import assert from "node:assert/strict";
import { runPiSession } from "../src/runtime/pi-session.mjs";
import { createModel, createRequestOptions } from "../src/runtime/model.mjs";
import { ProviderError } from "../src/errors.mjs";
import { assistantText, baseConfig } from "./helpers.mjs";

function bindingsWith(handler) {
  return {
    Type: {},
    streamSimple: () => {},
    runAgentLoop: handler,
  };
}

test("runPiSession wires the low-level Pi loop in parallel mode", async () => {
  const config = baseConfig();
  let captured;
  const final = assistantText("done");
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit, signal, streamSimple) => {
    captured = { prompts, context, loopConfig, signal, streamSimple };
    await emit({ type: "agent_start" });
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [{ name: "read" }],
  });
  assert.equal(captured.loopConfig.toolExecution, "parallel");
  assert.equal(captured.context.systemPrompt, "system");
  assert.equal(captured.prompts[0].content, "prompt");
  assert.equal(result.text, "done");
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.usage.totalTokens, 15);
});

test("budget hooks block excess calls and force a no-tool final turn", async () => {
  const config = baseConfig({ maxTurns: 3, maxToolCalls: 2 });
  let snapshot;
  const final = assistantText("done");
  const bindings = bindingsWith(async (prompts, context, loopConfig, emit) => {
    await emit({ type: "turn_start" });
    assert.equal(await loopConfig.beforeToolCall(), undefined);
    assert.equal(await loopConfig.beforeToolCall(), undefined);
    const blocked = await loopConfig.beforeToolCall();
    assert.equal(blocked.block, true);
    snapshot = await loopConfig.prepareNextTurn({
      context: { ...context, messages: [...prompts], tools: context.tools },
      toolResults: [{ role: "toolResult" }],
    });
    await emit({ type: "turn_end", message: final, toolResults: [] });
    return [...prompts, final];
  });
  const result = await runPiSession({
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    systemPrompt: "system",
    promptText: "prompt",
    tools: [{ name: "read" }],
  });
  assert.deepEqual(snapshot.context.tools, []);
  assert.match(snapshot.context.messages.at(-1).content, /budget is exhausted/u);
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.finalizationInjected, true);
});

test("provider errors redact configured secrets", async () => {
  const config = baseConfig();
  const errorMessage = assistantText("", {
    stopReason: "error",
    errorMessage: `authorization failed for ${config.apiKey}`,
  });
  const bindings = bindingsWith(async (prompts, _context, _loopConfig, emit) => {
    await emit({ type: "turn_start" });
    return [...prompts, errorMessage];
  });
  await assert.rejects(
    () =>
      runPiSession({
        bindings,
        model: createModel(config),
        requestOptions: createRequestOptions(config),
        config,
        systemPrompt: "system",
        promptText: "prompt",
        tools: [],
      }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(config.apiKey), false);
      assert.match(error.message, /<redacted>/u);
      return true;
    },
  );
});
