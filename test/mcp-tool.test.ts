import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OutputValidationError,
  ProviderError,
  SessionPersistenceError,
} from "../src/errors.js";
import {
  GatherContextOutputSchema,
  INVOCATION_POLICY,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
  VISIBLE_TRUNCATION_GAP,
} from "../src/mcp/contracts.js";
import { createGatherContextHandler } from "../src/mcp/tool.js";
import type { ContextTokenCounter } from "../src/runtime/context-budget.js";
import type { ExplorerResult, RunExplorerOptions } from "../src/runtime/run.js";
import type { ExplorerSessionCapture } from "../src/runtime/session-capture.js";

const tokenCounter: ContextTokenCounter = {
  countBatch: async (texts) => texts.map(() => 0),
};

function fakeResult(overrides: Partial<ExplorerResult> = {}): Readonly<ExplorerResult> {
  return {
    status: "completed",
    answer: "<final_answer>validated</final_answer>",
    summary: "Validated summary.",
    evidence: [{ path: "document.md", start: 1, end: 1, reason: "Supports the summary." }],
    gaps: ["none"],
    validationProblems: [],
    metrics: { marker: "hidden-metrics" },
    runtime: { workspace: "/unused" },
    ...overrides,
  } as unknown as Readonly<ExplorerResult>;
}

function fakeCapture(workspace: string, rawOutput = "RAW_SUBAGENT_SESSION_ONLY"): Readonly<ExplorerSessionCapture> {
  return {
    schemaVersion: "freecontext-session-v1",
    request: "collect evidence",
    runtime: { workspace },
    primary: { output: rawOutput },
    outcome: { status: "completed", answer: "validated" },
  } as unknown as Readonly<ExplorerSessionCapture>;
}

function outputOf(result: Awaited<ReturnType<ReturnType<typeof createGatherContextHandler>>>) {
  return GatherContextOutputSchema.parse(result.structuredContent);
}

test("gather_context metadata makes broad read delegation salient without claiming parent actions", () => {
  const fixtures = [
    ["before-parent decision seam", /^Before parent discovery or broad reads/u],
    ["multi-file or evidence-class work", /spanning files\/docs\/evidence classes/u],
    ["cross-document keyword search", /cross-document keyword\/topic search/u],
    ["long-document extraction", /long-document facts\/constraints/u],
    ["planning, review, and diagnosis", /planning, review, or diagnosis/u],
    ["familiar workspace use", /familiar workspaces\/known files/u],
    ["immediate post-selection invocation", /After selecting FreeContext, make gather_context the next tool action/u],
    ["no listing or search before delegation", /do not first list or search the repository/u],
    ["single-target skip", /one bounded read\/search in a known target fully answers/u],
    ["parent decisive read", /parent reads decisive\/edit ranges/u],
    ["compact output and private session", /compact cited evidence plus a private full-session path/u],
  ] as const;

  for (const [label, pattern] of fixtures) {
    assert.match(TOOL_DESCRIPTION, pattern, label);
  }
  assert.equal(TOOL_DESCRIPTION, INVOCATION_POLICY);
  assert.ok(TOOL_DESCRIPTION.length >= 560 && TOOL_DESCRIPTION.length <= 640);
  assert.equal(
    SERVER_INSTRUCTIONS,
    "FreeContext exposes one read-only gather_context tool. Follow the tool description. Never send secrets/source dumps; retry only for a material gap.",
  );
  assert.equal(SERVER_INSTRUCTIONS.length, 147);
  assert.equal(`${SERVER_INSTRUCTIONS}\n${TOOL_DESCRIPTION}`.split(INVOCATION_POLICY).length - 1, 1);
  const skipRule = TOOL_DESCRIPTION.slice(TOOL_DESCRIPTION.indexOf("Skip if"));
  assert.doesNotMatch(skipRule, /cross-document|long-document|code\/workspace/u);
  assert.match(TOOL_DESCRIPTION, /FreeContext never edits/u);
  assert.doesNotMatch(
    `${SERVER_INSTRUCTIONS}\n${TOOL_DESCRIPTION}`,
    /\b(?:run tests|install packages|commit|push|edit files|write files)\b/u,
  );
  assert.doesNotMatch(`${SERVER_INSTRUCTIONS}\n${TOOL_DESCRIPTION}`, /explore_repository/u);
});

test("gather_context calls one explorer with the shared counter and commits one non-Git session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "documents");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    const signal = new AbortController().signal;
    let calls = 0;
    const explore = async (options: RunExplorerOptions) => {
      calls += 1;
      assert.equal(options.cwd, workspace);
      assert.equal(options.dependencies?.tokenCounter, tokenCounter);
      assert.equal(options.signal, signal);
      await options.onEvent?.(
        { type: "turn_start" },
        { turnCount: 0, toolCallCount: 0, providerAttempts: 1 },
      );
      await options.onSessionCapture?.(fakeCapture(workspace));
      return fakeResult({ runtime: { workspace } as ExplorerResult["runtime"] });
    };
    const handler = createGatherContextHandler({ tokenCounter, sessionDirectory: sessions, runExplorer: explore });
    const call = await handler({ query: "collect evidence", workspace }, signal);
    const output = outputOf(call);

    assert.equal(calls, 1);
    assert.equal(output.status, "completed");
    assert.equal(output.sessionFile, (await readdir(sessions)).map((name) => path.join(sessions, name))[0]);
    assert.ok(output.sessionFile);
    const document = JSON.parse(await readFile(output.sessionFile, "utf8"));
    assert.equal(document.schemaVersion, "freecontext-mcp-session-v1");
    assert.equal(document.transport, "mcp");
    assert.equal(document.invocation.request, "collect evidence");
    assert.equal(document.invocation.workspace, workspace);
    assert.equal(document.capture.primary.output, "RAW_SUBAGENT_SESSION_ONLY");
    const visible = call.content[0];
    assert.ok(visible && visible.type === "text");
    assert.equal(document.modelVisibleText, visible.text);
    assert.equal(document.result.sessionFile, output.sessionFile);
    assert.equal(document.runtimeEvents.length, 1);

    const visibleText = JSON.stringify(call.content);
    assert.doesNotMatch(visibleText, /Validated summary|Supports the summary|RAW_SUBAGENT|hidden-metrics/u);
    assert.match(visibleText, /Status: completed/u);
    assert.match(visibleText, /Full session:/u);
    assert.equal((call._meta?.freecontext as { metrics?: { marker?: string } }).metrics?.marker, "hidden-metrics");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gather_context applies deterministic visible caps without duplicating evidence in text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "documents");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    const evidence = Array.from({ length: 10 }, (_, index) => ({
      path: `document-${index}.md`,
      start: 1,
      end: 1,
      reason: `reason-${index}-${"r".repeat(400)}`,
    }));
    const explore = async (options: RunExplorerOptions) => {
      await options.onSessionCapture?.(fakeCapture(workspace));
      return fakeResult({
        status: "partial",
        summary: "s".repeat(1_400),
        evidence,
        gaps: Array.from({ length: 5 }, (_, index) => `gap-${index}-${"g".repeat(400)}`),
        validationProblems: ["partial"],
      });
    };
    const call = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: explore,
    })({ query: "collect evidence", workspace });
    const output = outputOf(call);

    assert.equal(output.status, "partial");
    assert.equal([...output.summary].length, 1_200);
    assert.equal(output.evidence.length, 8);
    assert.ok(output.evidence.every((item) => [...item.reason].length <= 300));
    assert.equal(output.gaps.length, 4);
    assert.equal(output.gaps.at(-1), VISIBLE_TRUNCATION_GAP);
    assert.doesNotMatch(JSON.stringify(call.content), /document-0|reason-0|gap-0/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gather_context persists no_evidence, provider failure, and abort terminal states", async () => {
  const cases = [
    {
      expectedStatus: "no_evidence",
      expectedCode: "OUTPUT_VALIDATION_ERROR",
      expectedCategory: undefined,
      expectedStatusCode: undefined,
      abort: false,
      error: new OutputValidationError("No locally valid evidence.", { problems: ["Missing evidence."] }),
    },
    {
      expectedStatus: "failed",
      expectedCode: "PROVIDER_ERROR",
      expectedCategory: "server_error",
      expectedStatusCode: 503,
      abort: false,
      error: new ProviderError("provider unavailable", {
        category: "server_error",
        statusCode: 503,
        cause: { apiKey: "private-provider-key", baseUrl: "https://private-provider.invalid/v1" },
      }),
    },
    {
      expectedStatus: "failed",
      expectedCode: "PROVIDER_ERROR",
      expectedCategory: "connection",
      expectedStatusCode: undefined,
      abort: false,
      error: new ProviderError("Connection error.", { category: "connection" }),
    },
    {
      expectedStatus: "failed",
      expectedCode: "ABORTED",
      expectedCategory: undefined,
      expectedStatusCode: undefined,
      abort: true,
      error: new Error("raw abort reason"),
    },
  ] as const;

  for (const fixture of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
    const workspace = path.join(root, "documents");
    const sessions = path.join(root, "sessions");
    try {
      await mkdir(workspace);
      const controller = new AbortController();
      if (fixture.abort) controller.abort(new Error("cancelled"));
      let calls = 0;
      const explore = async (options: RunExplorerOptions): Promise<Readonly<ExplorerResult>> => {
        calls += 1;
        if (fixture.expectedStatus === "no_evidence") {
          await options.onSessionCapture?.(fakeCapture(workspace, "RAW_INVALID_OUTPUT"));
        }
        throw fixture.error;
      };
      const call = await createGatherContextHandler({
        tokenCounter,
        sessionDirectory: sessions,
        runExplorer: explore,
      })({ query: "collect evidence", workspace }, controller.signal);
      const output = outputOf(call);
      assert.equal(calls, 1);
      assert.equal(output.status, fixture.expectedStatus);
      assert.equal(output.error?.code, fixture.expectedCode);
      assert.ok(output.sessionFile);
      const document = JSON.parse(await readFile(output.sessionFile, "utf8"));
      assert.equal(document.result.status, fixture.expectedStatus);
      assert.equal(document.terminalError.code, fixture.expectedCode);
      assert.equal(document.terminalError.category, fixture.expectedCategory);
      assert.equal(document.terminalError.statusCode, fixture.expectedStatusCode);
      const visible = JSON.stringify({ content: call.content, structuredContent: call.structuredContent });
      assert.doesNotMatch(visible, /category|statusCode|server_error|503/u);
      assert.doesNotMatch(JSON.stringify(document), /private-provider-key|private-provider\.invalid/u);
      if (fixture.expectedStatus === "no_evidence") {
        assert.deepEqual(
          (call._meta?.freecontext as { validationProblems?: unknown }).validationProblems,
          ["Missing evidence."],
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("gather_context reports reservation and commit failures without false session pointers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "documents");
  try {
    await mkdir(workspace);
    let calls = 0;
    const explore = async () => {
      calls += 1;
      return fakeResult();
    };
    const reservationFailure = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: path.join(workspace, "sessions"),
      runExplorer: explore,
    })({ query: "collect evidence", workspace });
    assert.equal(outputOf(reservationFailure).sessionFile, null);
    assert.equal(calls, 0);

    const commitFailure = await createGatherContextHandler({
      tokenCounter,
      sessionDirectory: path.join(root, "sessions"),
      runExplorer: explore,
      commitSession: async () => {
        throw new SessionPersistenceError("write", { cause: new Error("private disk detail") });
      },
    })({ query: "collect evidence", workspace });
    const failedOutput = outputOf(commitFailure);
    assert.equal(calls, 1);
    assert.equal(failedOutput.status, "failed");
    assert.equal(failedOutput.sessionFile, null);
    assert.equal(failedOutput.error?.code, "SESSION_PERSISTENCE_ERROR");
    assert.match(JSON.stringify(commitFailure.content), /Full session: unavailable/u);
    assert.equal(
      (commitFailure._meta?.freecontext as { persistenceStage?: string }).persistenceStage,
      "write",
    );
    assert.doesNotMatch(JSON.stringify(commitFailure.content), /private disk detail|during write/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gather_context commits an unexpected failure before surfacing an MCP error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-tool-"));
  const workspace = path.join(root, "documents");
  const sessions = path.join(root, "sessions");
  try {
    await mkdir(workspace);
    const handler = createGatherContextHandler({
      tokenCounter,
      sessionDirectory: sessions,
      runExplorer: async () => { throw new Error("internal sentinel"); },
    });
    await assert.rejects(handler({ query: "collect evidence", workspace }), /internal sentinel/u);
    const files = await readdir(sessions);
    assert.equal(files.length, 1);
    const document = JSON.parse(await readFile(path.join(sessions, files[0] as string), "utf8"));
    assert.equal(document.result.status, "failed");
    assert.equal(document.terminalError.code, "UNEXPECTED_ERROR");
    assert.doesNotMatch(JSON.stringify(document.result), /internal sentinel/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
