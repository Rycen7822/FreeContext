import assert from "node:assert/strict";
import test from "node:test";
import {
  FreeContextRequestSchema,
  FreeContextResultSchema,
  MODEL_RESULT_MAX_BYTES,
  normalizeFreeContextRequest,
  serializeForModel,
} from "../src/mcp/contracts.js";

const readyResult = () => ({
  status: "ready" as const,
  summary: "The implementation and test locations are verified.",
  evidence: [{
    role: "implementation" as const,
    path: "src/router.ts",
    startLine: 10,
    endLine: 24,
    focusLine: 17,
    questionId: "implementation",
    why: "Defines provider routing.",
  }],
  gaps: [],
  nextAction: {
    kind: "read" as const,
    path: "src/router.ts",
    startLine: 10,
    endLine: 24,
    reason: "Read the decisive implementation span.",
  },
  errorCode: null,
  sessionId: "session-1",
  sessionFile: "/private/freecontext/session-1.json",
});

test("request normalization deduplicates refs and keeps the documented priority", () => {
  const normalized = normalizeFreeContextRequest({
    taskText: "Preserve this task exactly.\n",
    knownRefs: [
      ...Array.from({ length: 12 }, (_, index) => ({ kind: "symbol" as const, symbol: `symbol${index}` })),
      { kind: "path", path: "./src/router.ts" },
      { kind: "path", path: "src/router.ts" },
      { kind: "symbol", symbol: "route", path: "src/router.ts" },
      { kind: "stack", path: "src/router.ts", line: 42 },
      { kind: "path", path: "../outside.ts" },
    ],
    evidenceQuestions: [
      { id: "implementation", role: "implementation", question: "Where is routing implemented?", required: true, minimumSpans: 2 },
      { id: "tests", role: "test", question: "Which tests cover it?", required: true },
    ],
  });
  assert.equal(normalized.taskText, "Preserve this task exactly.\n");
  assert.deepEqual(normalized.knownRefs.slice(0, 3), [
    { kind: "stack", path: "src/router.ts", line: 42 },
    { kind: "symbol", symbol: "route", path: "src/router.ts" },
    { kind: "path", path: "src/router.ts" },
  ]);
  assert.equal(normalized.knownRefs.length, 12);
  assert.equal(normalized.evidenceQuestions[0]?.minimumSpans, 2);
});

test("canonical request separates model intent from host invocation facts", () => {
  const taskText = "  Trace the implementation, callers, tests, and configuration contract without losing API constraints.\n";
  const request = FreeContextRequestSchema.parse({
    taskText,
    knownRefs: [{ kind: "path", path: "src/router.ts" }],
    evidenceQuestions: [
      { id: "implementation", role: "implementation", question: "Where is routing implemented?", required: true },
      { id: "tests", role: "test", question: "Which tests cover it?", required: true },
    ],
  });
  assert.equal(request.taskText, taskText);
  assert.equal(request.evidenceQuestions.length, 2);
  assert.equal(FreeContextRequestSchema.safeParse({
    ...request,
    evidenceQuestions: [request.evidenceQuestions[1]],
  }).success, true);
  assert.equal("workspaceRoot" in request, false);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...request,
    evidenceQuestions: [request.evidenceQuestions[0], request.evidenceQuestions[0]],
  }), /question id must be unique/u);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...request,
    evidenceQuestions: request.evidenceQuestions.map((question) => ({ ...question, minimumSpans: 4 })),
  }), /required minimum spans cannot exceed 6/u);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...request,
    evidenceQuestions: request.evidenceQuestions.map((question) => ({ ...question, required: false, minimumSpans: 2 })),
  }), /optional questions cannot require multiple spans/u);
});

test("serializeForModel is text-first and contains every canonical evidence field", () => {
  const result = FreeContextResultSchema.parse(readyResult());
  const text = serializeForModel(result);
  assert.equal(text, [
    "Status: ready",
    "Evidence:",
    "1. [implementation][implementation] src/router.ts:10-24 (focus 17) — Defines provider routing.",
    "First repository cell: read exactly all Evidence ranges above; no range widening, search, status, plan, or branch. Read the decisive implementation span.",
    "Gaps:",
    "-",
    "Summary: The implementation and test locations are verified.",
    "Error: -",
    "Session: /private/freecontext/session-1.json",
  ].join("\n"));
  assert.ok(Buffer.byteLength(text, "utf8") <= MODEL_RESULT_MAX_BYTES);
});

test("canonical result schema enforces terminal state and span invariants", () => {
  const sixGaps = Array.from({ length: 6 }, (_, index) => ({ questionId: `question-${index}`, reason: "No observed evidence." }));
  assert.equal(FreeContextResultSchema.parse({
    ...readyResult(),
    status: "not_found",
    evidence: [],
    gaps: sixGaps,
    nextAction: { kind: "direct_search", reason: "Search the unresolved questions." },
  }).gaps.length, 6);
  assert.throws(() => FreeContextResultSchema.parse({
    ...readyResult(),
    status: "failed",
    errorCode: "INTERNAL_ERROR",
  }), /failed cannot contain evidence/u);
  assert.throws(() => FreeContextResultSchema.parse({
    ...readyResult(),
    evidence: [{ ...readyResult().evidence[0], focusLine: 30 }],
  }), /focusLine must be inside the span/u);
  assert.throws(() => FreeContextResultSchema.parse({
    ...readyResult(),
    summary: "invalid\nsecond line",
  }), /single line/u);
});

test("serializer refuses an oversized result instead of silently dropping evidence", () => {
  const result = FreeContextResultSchema.parse({
    ...readyResult(),
    evidence: Array.from({ length: 6 }, (_, index) => ({
      ...readyResult().evidence[0],
      path: `${"deep/".repeat(350)}file-${index}.ts`,
      startLine: index * 10 + 1,
      endLine: index * 10 + 2,
      focusLine: index * 10 + 1,
      questionId: `question-${index}`,
    })),
  });
  assert.throws(() => serializeForModel(result), /exceeds 8192 bytes/u);
});
