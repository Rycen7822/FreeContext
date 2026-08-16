import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FreeContextInvocationContext, FreeContextRequest } from "../src/mcp/contracts.js";
import { serializeForModel } from "../src/mcp/contracts.js";
import { compileFreeContextResult } from "../src/output/evidence.js";
import type { ExplorerCandidate, ExplorerEvidenceCandidate, ExplorerGapCandidate } from "../src/output/evidence.js";
import type { ObservedRead } from "../src/runtime/finalization.js";

const request = (): FreeContextRequest => ({
  taskText: "Trace the routing implementation and its tests.",
  knownRefs: [{ kind: "path", path: "src/router.ts" }],
  evidenceQuestions: [
    { id: "implementation", role: "implementation", question: "Where is routing implemented?", required: true },
    { id: "tests", role: "test", question: "Where is routing tested?", required: true },
  ],
});

const invocation = (root: string): FreeContextInvocationContext => ({
  invocationId: "invocation-1",
  callId: "call-1",
  workspaceRoot: root,
  workspaceRevision: "revision-1",
  sessionId: "session-1",
  sessionFile: path.join(root, ".freecontext-sessions/session-1.json"),
});

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-compiler-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(path.join(root, "src/router.ts"), Array.from({ length: 160 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"));
    await writeFile(path.join(root, "test/router.test.ts"), "test('router', () => route());\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const candidate = (
  summary: string,
  evidence: readonly ExplorerEvidenceCandidate[],
  gaps: readonly ExplorerGapCandidate[] = [],
): Readonly<ExplorerCandidate> => ({ summary, evidence, gaps });

const observed = (
  pathValue: string,
  startLine: number,
  endLine: number,
): Readonly<ObservedRead> => ({ tool: "read", path: pathValue, startLine, endLine, content: "observed fixture" });

test("compiler rejects a typed citation outside successful read provenance", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(request(), invocation(root), candidate(
    "Routing evidence was claimed without a read.",
    [{
      role: "implementation",
      questionId: "implementation",
      path: "src/router.ts",
      startLine: 1,
      endLine: 20,
      focusLine: 10,
      why: "Defines routing.",
    }],
  ));
  assert.equal(result.status, "not_found");
  assert.equal(result.gaps[0]?.reason, "Evidence range was not present in a successful read observation.");
}));

test("compiler validates observed spans, crops, orders, and emits a ready result", async () => withWorkspace(async (root) => {
  const evidence: ExplorerEvidenceCandidate[] = [
    { role: "test", questionId: "tests", path: "test/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Covers routing behavior." },
    { role: "implementation", questionId: "implementation", path: "src/router.ts", startLine: 1, endLine: 120, focusLine: 60, why: "Defines the routing branch." },
  ];
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Routing and tests are verified.", evidence),
    { errorCode: null },
    [observed("test/router.test.ts", 1, 1), observed("src/router.ts", 1, 120)],
  );
  assert.equal(result.status, "ready");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.evidence.map((item) => item.questionId), ["implementation", "tests"]);
  const first = result.evidence[0];
  assert.ok(first);
  assert.equal(first.endLine - first.startLine + 1, 80);
  assert.equal(result.nextAction.kind, "read");
  assert.equal(result.nextAction.path, "src/router.ts");
  assert.equal(result.nextAction.reason, "Read all evidence in this cell only; afterward edit directly with no intervening search.");
  assert.match(serializeForModel(result), /\[implementation\]\[implementation\] src\/router\.ts:/u);
}));

test("compiler turns role mismatch and rejected generated paths into explicit gaps", async () => withWorkspace(async (root) => {
  const evidence: ExplorerEvidenceCandidate[] = [
    { role: "implementation", questionId: "implementation", path: "src/router.ts", startLine: 10, endLine: 20, focusLine: 15, why: "Defines routing." },
    { role: "caller", questionId: "tests", path: "test/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Wrong requested role." },
    { role: "test", questionId: "tests", path: "dist/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Generated output." },
  ];
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Only one valid item remains.", evidence, [{ questionId: "tests", reason: "Test evidence remains unresolved." }]),
    { errorCode: null },
    [observed("src/router.ts", 10, 20), observed("dist/router.test.ts", 1, 1)],
  );
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.evidence.map((item) => item.questionId), ["implementation"]);
  assert.deepEqual(result.gaps, [{ questionId: "tests", reason: "Test evidence remains unresolved." }]);
  assert.equal(result.nextAction.reason, "Read all evidence in this cell only; afterward use at most one targeted named-gap search batch before editing.");
}));

test("compiler does not treat a trailing newline as an extra citable line", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("The requested range is outside the test file.", [
      { role: "test", questionId: "tests", path: "test/router.test.ts", startLine: 2, endLine: 2, focusLine: 2, why: "This line does not exist." },
    ], [{ questionId: "implementation", reason: "Implementation was not inspected." }]),
    { errorCode: null },
    [observed("test/router.test.ts", 2, 2)],
  );
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.gaps.find((gap) => gap.questionId === "tests"), {
    questionId: "tests",
    reason: "Evidence range exceeded the file length.",
  });
}));

test("normal empty evidence is not_found while malformed output is failed", async () => withWorkspace(async (root) => {
  const notFound = await compileFreeContextResult(request(), invocation(root), candidate(
    "No matching implementation was found.",
    [],
    [
      { questionId: "implementation", reason: "No matching implementation." },
      { questionId: "tests", reason: "No matching tests." },
    ],
  ));
  assert.equal(notFound.status, "not_found");
  assert.equal(notFound.errorCode, null);
  assert.equal(notFound.nextAction.kind, "direct_search");

  const failed = await compileFreeContextResult(
    request(),
    invocation(root),
    null,
    { errorCode: "INTERNAL_ERROR", reason: "Terminal submission was missing." },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "INTERNAL_ERROR");
  assert.equal(failed.evidence.length, 0);
}));

test("compiler drops lower-ranked spans until the canonical text fits 8 KiB", async () => withWorkspace(async (root) => {
  const segments = Array.from({ length: 80 }, (_, index) => `segment-${index.toString().padStart(3, "0")}`);
  const directory = path.join(root, ...segments);
  await mkdir(directory, { recursive: true });
  const relativeDirectory = path.relative(root, directory).split(path.sep).join("/");
  const evidence: ExplorerEvidenceCandidate[] = [];
  const reads: ObservedRead[] = [];
  for (let index = 0; index < 6; index += 1) {
    const filename = `router-${index}.ts`;
    await writeFile(path.join(directory, filename), `unique ${index}\n`);
    const relativePath = `${relativeDirectory}/${filename}`;
    evidence.push({
      role: "implementation",
      questionId: "implementation",
      path: relativePath,
      startLine: 1,
      endLine: 1,
      focusLine: 1,
      why: `${"detail ".repeat(20)}${index}`,
    });
    reads.push(observed(relativePath, 1, 1));
  }
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate(`${"summary ".repeat(60)}`, evidence, [{ questionId: "tests", reason: "No test evidence." }]),
    { errorCode: null },
    reads,
  );
  assert.equal(result.status, "partial");
  assert.ok(result.evidence.length >= 1 && result.evidence.length < 6);
  assert.ok(Buffer.byteLength(serializeForModel(result), "utf8") <= 8_192);
}));
