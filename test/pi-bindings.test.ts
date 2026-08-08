import test from "node:test";
import assert from "node:assert/strict";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";

const FUNCTION_BINDINGS = [
  "runAgentLoop",
  "runAgentLoopContinue",
  "convertToLlm",
  "estimateContextTokens",
  "estimateTokens",
  "shouldCompact",
  "serializeConversation",
  "createCompactionSummaryMessage",
  "uuidv7",
  "streamSimple",
  "isContextOverflow",
] as const;

for (const api of ["anthropic", "openai"] as const) {
  test(`loadPiBindings loads the complete public ${api} surface without a request`, async () => {
    const bindings = await loadPiBindings(api);
    for (const name of FUNCTION_BINDINGS) assert.equal(typeof bindings[name], "function", name);
    assert.ok(typeof bindings.Type === "object" || typeof bindings.Type === "function");
  });
}
