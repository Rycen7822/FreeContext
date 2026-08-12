import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { captureRuntimeEvent } from "../src/runtime/session-capture.js";
import type { FreeContextRuntimeEvent } from "../src/runtime/pi-session.js";

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function textDeltaEvent(partial: AssistantMessage, delta: string): FreeContextRuntimeEvent {
  return {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
  };
}

test("runtime event capture preserves stream deltas without repeated message snapshots", () => {
  const marker = "snapshot-only-marker";
  const captured = captureRuntimeEvent(textDeltaEvent(assistantMessage(marker), "delta"));

  assert.deepEqual(captured, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta" },
  });
  assert.doesNotMatch(JSON.stringify(captured), /"(?:partial|message)"|snapshot-only-marker/u);
});

test("runtime event capture grows with deltas instead of repeated partial transcripts", () => {
  const partial = assistantMessage("x".repeat(20_000));
  const raw = Array.from({ length: 50 }, () => textDeltaEvent(partial, "x"));
  const captured = raw.map(captureRuntimeEvent);

  assert.equal(
    captured.map((event) => event.type === "message_update" ? event.assistantMessageEvent : null)
      .filter((event) => event?.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
    "x".repeat(50),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > Buffer.byteLength(JSON.stringify(captured)) * 100);
});
