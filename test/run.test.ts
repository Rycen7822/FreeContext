import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { OutputValidationError, ProviderError } from "../src/errors.js";
import type { ExplorerDependencies, ExplorerSessionCapture } from "../src/runtime/run.js";
import { runExplorer } from "../src/runtime/run.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { assistantText, baseConfig, baseRouteConfig, fakeBindings } from "./helpers.js";

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
    routeConfig: baseRouteConfig(),
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
    let capture: Readonly<ExplorerSessionCapture> | undefined;
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      onSessionCapture: (value) => { capture = value; },
      dependencies: { ...(await fakeDependencies(root, [valid])), clock: unitClock() },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "a is exported.");
    assert.deepEqual(result.validationProblems, []);
    assert.equal(result.evidence[0]?.path, "a.js");
    assert.equal(result.metrics.repaired, false);
    assert.equal(result.metrics.routeAttempts, 1);
    assert.equal(result.metrics.fallbacks, 0);
    assert.equal(result.runtime.route, "test-route");
    assert.equal(result.runtime.target, "test");
    assert.equal(result.runtime.provider, "test-provider");
    assert.equal(result.metrics.setupMs, 1);
    assert.equal(result.metrics.primarySessionMs, 3);
    assert.equal(result.metrics.primaryValidationMs, 1);
    assert.equal(result.metrics.repairSessionMs, 0);
    assert.equal(result.metrics.repairValidationMs, 0);
    assert.equal(result.metrics.toolExecutionMsTotal, 0);
    assert.equal(result.metrics.toolExecutionMsMax, 0);
    assert.equal(result.metrics.totalMs, 8);
    assert.equal(result.metrics.primary.sessionMs, 1);
    assert.equal(capture?.outcome.status, "completed");
    assert.equal(capture?.primaryValidation.status, "completed");
    assert.equal(capture?.request, "find a");
    assert.equal(capture?.primary.output, valid.content[0]?.type === "text" ? valid.content[0].text : "");
    assert.equal(capture?.repair, null);
    assert.equal(capture?.runtime.baseUrl, "https://example.invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer returns primary partial evidence without repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const partial = assistantText(
      "<final_answer>\nsummary: a is defined.\nevidence:\n- a.js:1-1 — Defines a.\n- missing.js:1-1 — Fabricated citation.\ngaps:\n- none\n</final_answer>",
    );
    let capture: Readonly<ExplorerSessionCapture> | undefined;
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      onSessionCapture: (value) => { capture = value; },
      dependencies: await fakeDependencies(root, [partial]),
    });

    assert.equal(result.status, "partial");
    assert.equal(result.metrics.repaired, false);
    assert.deepEqual(result.evidence.map(({ path }) => path), ["a.js"]);
    assert.deepEqual(result.validationProblems, [
      "Evidence path rejected by workspace policy (missing, sensitive, outside, oversized, or unsupported).",
    ]);
    assert.doesNotMatch(result.answer, /missing\.js/u);
    assert.equal(capture?.primaryValidation.status, "partial");
    assert.equal(capture?.repair, null);
    assert.deepEqual(capture?.outcome, {
      status: "partial",
      answer: result.answer,
      problemCount: 1,
    });
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
    let capture: Readonly<ExplorerSessionCapture> | undefined;
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      onSessionCapture: (value) => { capture = value; },
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
    assert.equal(capture?.primary.output, "The answer is a.js.");
    assert.equal(capture?.repair?.session?.output, result.answer);
    assert.equal(capture?.primaryValidation.valid, false);
    assert.equal(capture?.repair?.validation?.valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer accepts partial evidence from the single repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const invalid = assistantText("The answer is a.js.");
    const partial = assistantText(
      "<final_answer>\nsummary: a is defined.\nevidence:\n- a.js:1-1 — Defines a.\n- malformed evidence\ngaps:\n- none\n</final_answer>",
    );
    let capture: Readonly<ExplorerSessionCapture> | undefined;
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      onSessionCapture: (value) => { capture = value; },
      dependencies: await fakeDependencies(root, [invalid, partial]),
    });

    assert.equal(result.status, "partial");
    assert.equal(result.metrics.repaired, true);
    assert.deepEqual(result.validationProblems, ["Malformed evidence citation."]);
    assert.equal(capture?.repair?.validation?.status, "partial");
    assert.equal(capture?.outcome.status, "partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer captures both raw answers when repair still fails validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const primary = assistantText("Primary answer without the required block.");
    const repair = assistantText("Repair answer without the required block.");
    let capture: Readonly<ExplorerSessionCapture> | undefined;

    await assert.rejects(
      runExplorer({
        query: "find a",
        cwd: root,
        onSessionCapture: (value) => { capture = value; },
        dependencies: await fakeDependencies(root, [primary, repair]),
      }),
      (error: unknown) => error instanceof OutputValidationError,
    );

    assert.equal(capture?.outcome.status, "output_validation_error");
    assert.equal(capture?.primary.output, "Primary answer without the required block.");
    assert.equal(capture?.repair?.session?.output, "Repair answer without the required block.");
    assert.deepEqual(capture?.repair?.validation?.problems, ["Missing <final_answer> block."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("format repair stays on the selected target and never enters route fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const invalid = assistantText("The answer is a.js.");
    let invocations = 0;
    const bindings = fakeBindings(async (prompts, _context, _config, emit) => {
      invocations += 1;
      if (invocations === 1) {
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: invalid, toolResults: [] });
        return [...prompts, invalid];
      }
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    });
    const workspace = await createWorkspace(root);
    let capture: Readonly<ExplorerSessionCapture> | undefined;

    await assert.rejects(
      runExplorer({
        query: "find a",
        cwd: root,
        onSessionCapture: (value) => { capture = value; },
        dependencies: {
          routeConfig: baseRouteConfig([
            baseConfig({ target: "selected" }),
            baseConfig({ target: "unused-backup" }),
          ]),
          workspace,
          bindings,
          repositoryTools: {
            tools: [],
            names: [],
            executables: { rg: null, jq: null, bat: null },
          },
          systemPrompt: "system",
        },
      }),
      (error: unknown) => error instanceof ProviderError,
    );
    assert.equal(invocations, 2);
    assert.equal(capture?.outcome.status, "repair_error");
    assert.equal(capture?.primary.output, "The answer is a.js.");
    assert.equal(capture?.repair?.session, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("format repair uses a fresh no-tool context containing only the prior output", async () => {
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
    let repairPrompt = "";
    const bindings = fakeBindings(async (prompts, context, loopConfig, emit) => {
      invocation += 1;
      if (invocation === 1) {
        const longRaw = {
          role: "user" as const,
          content: `raw ${Array.from({ length: 1000 }, (_, index) => `word${index}`).join(" ")}`,
          timestamp: 1,
        };
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
      const prompt = prompts[0];
      repairPrompt = prompt?.role === "user" && typeof prompt.content === "string" ? prompt.content : "";
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
    let capture: Readonly<ExplorerSessionCapture> | undefined;
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      onSessionCapture: (value) => { capture = value; },
      dependencies: {
        routeConfig: baseRouteConfig([
          baseConfig({
            contextWindow: 1200,
            contextReserveTokens: 400,
            contextKeepRecentTokens: 10,
            maxOutputTokens: 200,
          }),
        ]),
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
    assert.deepEqual(repairContext.messages, []);
    assert.match(repairContext.systemPrompt, /repair one repository-explorer response/u);
    assert.match(repairPrompt, /<previous_output>\nThe answer is a\.js\.\n<\/previous_output>/u);
    assert.doesNotMatch(repairPrompt, /word0 word1/u);
    assert.equal(result.metrics.repaired, true);
    assert.equal(result.metrics.primary.compactions, 1);
    assert.equal(result.evidence[0]?.path, "a.js");
    assert.equal(capture?.primary.tools[0]?.name, "read");
    assert.deepEqual(capture?.repair?.session?.tools, []);
    assert.doesNotThrow(() => JSON.stringify(capture));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
