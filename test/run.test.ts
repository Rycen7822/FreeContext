import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderError } from "../src/errors.js";
import type {
  FreeContextInvocationContext,
  FreeContextRequest,
} from "../src/mcp/contracts.js";
import type { ExplorerDependencies, ExplorerSessionCapture } from "../src/runtime/run.js";
import { runExplorer } from "../src/runtime/run.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { assistantText, baseRouteConfig, fakeBindings } from "./helpers.js";

const tokenCounter = {
  countBatch: async (texts: readonly string[]) => texts.map((text) => Math.ceil(text.length / 4)),
};

function request(taskText = "find a"): FreeContextRequest {
  return {
    taskText,
    knownRefs: [{ kind: "path", path: "a.js" }],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is a implemented?", required: true },
      { id: "tests", role: "test", question: "How is a tested?", required: false },
    ],
  };
}

function invocation(root: string): FreeContextInvocationContext {
  return {
    invocationId: "invocation-1",
    callId: "call-1",
    workspaceRoot: root,
    workspaceRevision: "revision-1",
    sessionId: "session-1",
    sessionFile: path.join(root, ".work", "sessions", "session-1.json"),
  };
}

async function fakeDependencies(
  root: string,
  responses: readonly AssistantMessage[],
  onCall?: () => void,
): Promise<ExplorerDependencies> {
  let index = 0;
  return {
    routeConfig: baseRouteConfig(),
    workspace: await createWorkspace(root),
    tokenCounter,
    bindings: fakeBindings(async (prompts, context, loopConfig, emit) => {
      onCall?.();
      const response = responses[index++];
      if (!response) throw new Error("missing fake response");
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: response, toolResults: [] });
      await loopConfig.shouldStopAfterTurn?.({
        message: response,
        toolResults: [],
        context: { ...context, messages: [...prompts, response] },
        newMessages: [...prompts, response],
      });
      return [...prompts, response];
    }),
    repositoryTools: {
      tools: [],
      names: ["read", "rg", "glob"],
      executables: { rg: null, jq: null, bat: null },
    },
    systemPrompt: "system",
  };
}

test("runExplorer compiles a canonical ready result and v2 capture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\nexport { a };\n", "utf8");
    const output = assistantText(
      "<final_answer>\nsummary: a is exported.\nevidence:\n" +
      "- [implementation][impl] a.js:1-2 (focus 1) — Defines and exports a.\n" +
      "gaps:\n- [tests] No test was found.\n</final_answer>",
    );
    let capture: Readonly<ExplorerSessionCapture> | undefined;
    const result = await runExplorer({
      request: request(),
      invocation: invocation(root),
      onSessionCapture: (value) => { capture = value; },
      dependencies: await fakeDependencies(root, [output]),
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.evidence.map(({ path: evidencePath }) => evidencePath), ["a.js"]);
    assert.equal(result.gaps[0]?.questionId, "tests");
    assert.equal(result.sessionId, "session-1");
    assert.ok(capture);
    assert.equal(capture.schemaVersion, "freecontext-explorer-capture-v2");
    assert.equal(capture.request.taskText, "find a");
    assert.equal(capture.invocation.callId, "call-1");
    assert.equal(capture.primary.output, output.content[0]?.type === "text" ? output.content[0].text : "");
    assert.equal(capture.primary.metrics.finalizationReason, "coverage");
    assert.equal(capture.primary.metrics.evidenceProgress.length, 1);
    assert.equal(capture.compiler.evidenceCount, 1);
    assert.equal(capture.metrics.routeAttempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer makes one model call and returns partial when a required question is uncovered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const output = assistantText(
      "<final_answer>\nsummary: only tests were located.\nevidence:\n" +
      "- [test][tests] a.js:1-1 (focus 1) — Test-shaped fixture.\n" +
      "gaps:\n- [impl] Implementation was not found.\n</final_answer>",
    );
    let calls = 0;
    const result = await runExplorer({
      request: request(),
      invocation: invocation(root),
      dependencies: await fakeDependencies(root, [output], () => { calls += 1; }),
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.evidence.map(({ questionId }) => questionId), ["tests"]);
    assert.deepEqual(result.gaps.map(({ questionId }) => questionId), ["impl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer converts malformed model output into a canonical failure without repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    const result = await runExplorer({
      request: request("  preserve task whitespace  "),
      invocation: invocation(root),
      dependencies: await fakeDependencies(root, [assistantText("not a final block")]),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "INTERNAL_ERROR");
    assert.equal(result.nextAction.kind, "direct_search");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer leaves provider failures for the MCP boundary to classify", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    const dependencies: ExplorerDependencies = {
      ...(await fakeDependencies(root, [])),
      bindings: fakeBindings(async () => {
        throw new ProviderError("busy", { category: "server_error", statusCode: 503 });
      }),
    };
    await assert.rejects(
      runExplorer({ request: request(), invocation: invocation(root), dependencies }),
      (error: unknown) => error instanceof ProviderError && error.statusCode === 503,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
