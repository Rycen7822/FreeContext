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
import { assistantText, baseRouteConfig, fakeBindings, topicTarget } from "./helpers.js";

const tokenCounter = {
  countBatch: async (texts: readonly string[]) => texts.map((text) => Math.ceil(text.length / 4)),
};

function request(taskText = "find a"): FreeContextRequest {
  return {
    taskText,
    workUnit: { outcome: "answer", goal: "Find a." },
    knownRefs: [{ kind: "path", path: "a.js" }],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is a implemented?", required: true, coverageTargets: [topicTarget("a-implementation", "a implementation", "location")] },
      { id: "tests", role: "test", question: "How is a tested?", required: false, coverageTargets: [topicTarget("a-tests", "a tests", "verification")] },
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

function submission(args: Readonly<Record<string, unknown>>): AssistantMessage {
  return assistantText("", {
    content: [{ type: "toolCall", id: "submit-1", name: "submit_evidence", arguments: args }],
  });
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
      await emit({
        type: "tool_execution_end",
        toolCallId: "read-1",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "[read a.js:1-2]\n1 const a = 1;\n2 export { a };" }],
          details: { tool: "read", path: "a.js", startLine: 1, actualEndLine: 2, truncated: false },
        },
        isError: false,
      });
      const call = response.content.find((block) => block.type === "toolCall");
      if (call) {
        const submit = context.tools?.find((tool) => tool.name === "submit_evidence");
        if (!submit) throw new Error("missing submit tool");
        const before = await loopConfig.beforeToolCall?.({ assistantMessage: response, toolCall: call, args: call.arguments, context });
        if (!before?.block) {
          const submitted = await submit.execute(call.id, call.arguments);
          await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: submitted, isError: false });
        }
      }
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

test("runExplorer compiles a canonical ready result and v3 capture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\nexport { a };\n", "utf8");
    const output = submission({
      summary: "a is exported.",
      evidence: [{ question_id: "impl", observation_id: 1, start_line: 1, end_line: 2, why: "Defines and exports a." }],
      gaps: [{ question_id: "tests", reason: "No test was found." }],
    });
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
    assert.equal(capture.schemaVersion, "freecontext-explorer-capture-v3");
    assert.equal(capture.request.taskText, "find a");
    assert.equal(capture.invocation.callId, "call-1");
    assert.equal(capture.primary.output, "");
    assert.equal(capture.primary.candidate?.summary, "a is exported.");
    assert.equal(capture.primary.effectiveSystemPrompt, "system");
    assert.deepEqual(capture.primary.tools.map((tool) => tool.name), ["submit_evidence"]);
    assert.deepEqual(capture.primary.effectiveTools.map((tool) => tool.name), ["submit_evidence"]);
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
    await writeFile(path.join(root, "a.js"), "test(\"a\", () => {});\n", "utf8");
    const output = submission({
      summary: "only tests were located.",
      evidence: [{ question_id: "tests", observation_id: 1, start_line: 1, end_line: 1, why: "Test-shaped fixture." }],
      gaps: [{ question_id: "impl", reason: "Implementation was not found." }],
    });
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
    assert.equal(result.nextAction.kind, "exact_probe");
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
