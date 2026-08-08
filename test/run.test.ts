import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExplorerDependencies } from "../src/runtime/run.js";
import { runExplorer } from "../src/runtime/run.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { assistantText, baseConfig, fakeBindings } from "./helpers.js";

async function fakeDependencies(root: string, responses: readonly AssistantMessage[]): Promise<ExplorerDependencies> {
  let index = 0;
  const bindings = fakeBindings(async (prompts, _context, _config, emit) => {
    const response = responses[index++];
    if (!response) throw new Error("missing fake response");
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message: response, toolResults: [] });
    return [...prompts, response];
  });
  return {
    config: baseConfig(),
    workspace: await createWorkspace(root),
    bindings,
    repositoryTools: {
      tools: [],
      names: ["read", "rg", "glob"],
      executables: { rg: null, jq: null, bat: null },
    },
    systemPrompt: "system",
  };
}

function unitClock(): () => number {
  let tick = 0;
  return () => tick++;
}

test("runExplorer returns locally validated evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\nexport { a };\n", "utf8");
    const valid = assistantText(
      "<final_answer>\nsummary: a is exported.\nevidence:\n- a.js:1-2 — Defines and exports a.\ngaps:\n- none\n</final_answer>",
    );
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      dependencies: { ...(await fakeDependencies(root, [valid])), clock: unitClock() },
    });
    assert.equal(result.summary, "a is exported.");
    assert.equal(result.evidence[0]?.path, "a.js");
    assert.equal(result.metrics.repaired, false);
    assert.equal(result.metrics.setupMs, 1);
    assert.equal(result.metrics.primarySessionMs, 3);
    assert.equal(result.metrics.primaryValidationMs, 1);
    assert.equal(result.metrics.repairSessionMs, 0);
    assert.equal(result.metrics.repairValidationMs, 0);
    assert.equal(result.metrics.toolExecutionMsTotal, 0);
    assert.equal(result.metrics.toolExecutionMsMax, 0);
    assert.equal(result.metrics.totalMs, 8);
    assert.equal(result.metrics.primary.sessionMs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer performs one no-tool format repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const invalid = assistantText("The answer is a.js.");
    const repaired = assistantText(
      "<final_answer>\nsummary: a is defined.\nevidence:\n- a.js:1-1 — Defines a.\ngaps:\n- none\n</final_answer>",
    );
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      dependencies: { ...(await fakeDependencies(root, [invalid, repaired])), clock: unitClock() },
    });
    assert.equal(result.metrics.repaired, true);
    assert.equal(result.evidence[0]?.start, 1);
    assert.equal(result.metrics.setupMs, 1);
    assert.equal(result.metrics.primarySessionMs, 3);
    assert.equal(result.metrics.primaryValidationMs, 1);
    assert.equal(result.metrics.repairSessionMs, 3);
    assert.equal(result.metrics.repairValidationMs, 1);
    assert.equal(result.metrics.toolExecutionMsTotal, 0);
    assert.equal(result.metrics.toolExecutionMsMax, 0);
    assert.equal(result.metrics.totalMs, 14);
    assert.equal(result.metrics.primary.sessionMs, 1);
    assert.equal(result.metrics.repair?.sessionMs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("format repair receives only effective compacted context and no tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const invalid = assistantText("The answer is a.js.");
    const repaired = assistantText(
      "<final_answer>\nsummary: a is defined.\nevidence:\n- a.js:1-1 — Defines a.\ngaps:\n- none\n</final_answer>",
    );
    const oldAssistant = assistantText("old finding", {
      usage: {
        input: 900,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 920,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    let invocation = 0;
    let repairContext: AgentContext | undefined;
    const bindings = fakeBindings(async (prompts, context, loopConfig, emit) => {
      invocation += 1;
      if (invocation === 1) {
        const longRaw = { role: "user" as const, content: `raw ${"x".repeat(1000)}`, timestamp: 1 };
        const beforeCompaction = {
          ...context,
          messages: [
            ...prompts,
            longRaw,
            oldAssistant,
            { role: "user" as const, content: `recent ${"y".repeat(100)}`, timestamp: 2 },
          ],
        };
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: oldAssistant, toolResults: [] });
        const update = await loopConfig.prepareNextTurn?.({
          message: oldAssistant,
          toolResults: [],
          context: beforeCompaction,
          newMessages: [...beforeCompaction.messages],
        });
        const compacted = update?.context ?? beforeCompaction;
        const finalContext = { ...compacted, messages: [...compacted.messages, invalid] };
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: invalid, toolResults: [] });
        await loopConfig.shouldStopAfterTurn?.({
          message: invalid,
          toolResults: [],
          context: finalContext,
          newMessages: [...prompts, invalid],
        });
        return [...prompts, invalid];
      }
      repairContext = context;
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: repaired, toolResults: [] });
      return [...prompts, repaired];
    });
    const inspectionTool: AgentTool = {
      name: "read",
      label: "Read",
      description: "Read fixture",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    };
    const workspace = await createWorkspace(root);
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      dependencies: {
        config: baseConfig({
          contextWindow: 1200,
          contextReserveTokens: 400,
          contextKeepRecentTokens: 10,
          maxOutputTokens: 200,
        }),
        workspace,
        bindings,
        repositoryTools: {
          tools: [inspectionTool],
          names: ["read"],
          executables: { rg: null, jq: null, bat: null },
        },
        systemPrompt: "system",
      },
    });

    assert.ok(repairContext);
    assert.deepEqual(repairContext.tools, []);
    assert.equal(repairContext.messages[0]?.role, "compactionSummary");
    assert.ok(repairContext.messages.includes(invalid));
    assert.equal(
      repairContext.messages.some(
        (message) => message.role === "user" && typeof message.content === "string" && message.content.includes("x".repeat(100)),
      ),
      false,
    );
    assert.equal(result.metrics.repaired, true);
    assert.equal(result.metrics.primary.compactions, 1);
    assert.equal(result.evidence[0]?.path, "a.js");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
