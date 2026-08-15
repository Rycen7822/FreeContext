import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FreeContextInvocationContext, FreeContextRequest } from "../src/mcp/contracts.js";
import { serializeForModel } from "../src/mcp/contracts.js";
import { compileFreeContextResult, parseExplorerCandidate } from "../src/output/evidence.js";

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

test("parser reads the role/question/focus final block contract", () => {
  const parsed = parseExplorerCandidate(`<final_answer>
summary: Routing evidence is verified.
evidence:
- [implementation][implementation] src/router.ts:1-120 (focus 60) — Defines the routing branch.
gaps:
- [tests] Tests were not inspected.
</final_answer>`);
  assert.equal(parsed.problems.length, 0);
  assert.deepEqual(parsed.evidence[0], {
    role: "implementation",
    questionId: "implementation",
    path: "src/router.ts",
    startLine: 1,
    endLine: 120,
    focusLine: 60,
    why: "Defines the routing branch.",
  });
  assert.deepEqual(parsed.gaps, [{ questionId: "tests", reason: "Tests were not inspected." }]);
});

test("compiler validates, crops, orders, and emits a ready result", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(request(), invocation(root), `<final_answer>
summary: Routing and tests are verified.
evidence:
- [test][tests] test/router.test.ts:1-1 (focus 1) — Covers routing behavior.
- [implementation][implementation] src/router.ts:1-120 (focus 60) — Defines the routing branch.
gaps:
-
</final_answer>`);
  assert.equal(result.status, "ready");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.evidence.map((item) => item.questionId), ["implementation", "tests"]);
  const first = result.evidence[0];
  assert.ok(first);
  assert.equal(first.endLine - first.startLine + 1, 80);
  assert.equal(result.nextAction.kind, "read");
  assert.equal(result.nextAction.path, "src/router.ts");
  assert.match(serializeForModel(result), /\[implementation\]\[implementation\] src\/router\.ts:/u);
}));

test("compiler turns role mismatch and rejected generated paths into explicit gaps", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(request(), invocation(root), `<final_answer>
summary: Only one valid item remains.
evidence:
- [implementation][implementation] src/router.ts:10-20 (focus 15) — Defines routing.
- [caller][tests] test/router.test.ts:1-1 (focus 1) — Wrong requested role.
- [test][tests] dist/router.test.ts:1-1 (focus 1) — Generated output.
gaps:
- [tests] Test evidence remains unresolved.
</final_answer>`);
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.evidence.map((item) => item.questionId), ["implementation"]);
  assert.deepEqual(result.gaps, [{ questionId: "tests", reason: "Test evidence remains unresolved." }]);
}));

test("compiler does not treat a trailing newline as an extra citable line", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(request(), invocation(root), `<final_answer>
summary: The requested range is outside the test file.
evidence:
- [test][tests] test/router.test.ts:2-2 (focus 2) — This line does not exist.
gaps:
- [implementation] Implementation was not inspected.
</final_answer>`);
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.gaps.find((gap) => gap.questionId === "tests"), {
    questionId: "tests",
    reason: "Evidence range exceeded the file length.",
  });
}));

test("normal empty evidence is not_found while malformed output is failed", async () => withWorkspace(async (root) => {
  const notFound = await compileFreeContextResult(request(), invocation(root), `<final_answer>
summary: No matching implementation was found.
evidence:
-
gaps:
- [implementation] No matching implementation.
- [tests] No matching tests.
</final_answer>`);
  assert.equal(notFound.status, "not_found");
  assert.equal(notFound.errorCode, null);
  assert.equal(notFound.nextAction.kind, "direct_search");

  const failed = await compileFreeContextResult(request(), invocation(root), "not a final block");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "INTERNAL_ERROR");
  assert.equal(failed.evidence.length, 0);
}));

test("compiler drops lower-ranked spans until the canonical text fits 8 KiB", async () => withWorkspace(async (root) => {
  const segments = Array.from({ length: 80 }, (_, index) => `segment-${index.toString().padStart(3, "0")}`);
  const directory = path.join(root, ...segments);
  await mkdir(directory, { recursive: true });
  const relativeDirectory = path.relative(root, directory).split(path.sep).join("/");
  const evidence: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const filename = `router-${index}.ts`;
    await writeFile(path.join(directory, filename), `unique ${index}\n`);
    evidence.push(`- [implementation][implementation] ${relativeDirectory}/${filename}:1-1 (focus 1) — ${"detail ".repeat(20)}${index}`);
  }
  const result = await compileFreeContextResult(request(), invocation(root), `<final_answer>
summary: ${"summary ".repeat(60)}
evidence:
${evidence.join("\n")}
gaps:
- [tests] No test evidence.
</final_answer>`);
  assert.equal(result.status, "partial");
  assert.ok(result.evidence.length >= 1 && result.evidence.length < 6);
  assert.ok(Buffer.byteLength(serializeForModel(result), "utf8") <= 8_192);
}));
