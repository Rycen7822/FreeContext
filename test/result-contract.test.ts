import assert from "node:assert/strict";
import test from "node:test";
import {
  FreeContextCallerRequestSchema,
  FreeContextRequestSchema,
  FreeContextResultSchema,
  LegacyFreeContextResultSchema,
  MODEL_RESULT_MAX_BYTES,
  normalizeFreeContextRequest,
  serializeForModel,
} from "../src/mcp/contracts.js";

const readyResult = () => ({
  status: "ready" as const,
  summary: "The implementation and test locations are verified.",
  evidence: [{
    id: "e1",
    role: "implementation" as const,
    path: "src/router.ts",
    startLine: 10,
    endLine: 24,
    focusLine: 17,
    questionId: "implementation",
    excerpt: "export function routeProvider() {}",
    why: "Defines provider routing.",
  }],
  gaps: [],
  handoff: {
    id: "handoff:session-1",
    workUnit: { outcome: "answer" as const, goal: "Use the verified routing evidence." },
    evidenceIds: ["e1"],
    outcome: { kind: "answer" as const, instruction: "Answer from the verified routing evidence." },
    blockingGaps: [],
  },
  nextAction: {
    kind: "consume_evidence" as const,
    reason: "Read the decisive implementation span.",
  },
  errorCode: null,
  sessionId: "session-1",
  sessionFile: "/private/freecontext/session-1.json",
});

test("request normalization deduplicates refs and keeps the documented priority", () => {
  const normalized = normalizeFreeContextRequest({
    taskText: "Preserve this task exactly.\n",
    workUnit: { outcome: "edit", goal: "Update routing without changing its public contract." },
    knownRefs: [
      ...Array.from({ length: 8 }, (_, index) => ({ kind: "symbol" as const, symbol: `symbol${index}` })),
      { kind: "path", path: "./src/router.ts" },
      { kind: "symbol", symbol: "route", path: "src/router.ts" },
      { kind: "stack", path: "src/router.ts", line: 42 },
      { kind: "path", path: "../outside.ts" },
    ],
    evidenceQuestions: [
      { role: "implementation", question: "Where is routing implemented?" },
      { role: "test", question: "Which tests cover routing?", target: { subject: { kind: "symbol", symbol: "route" } } },
    ],
  });
  assert.equal(normalized.taskText, "Preserve this task exactly.\n");
  assert.deepEqual(normalized.workUnit, { outcome: "edit", goal: "Update routing without changing its public contract." });
  assert.deepEqual(normalized.knownRefs.slice(0, 3), [
    { kind: "stack", path: "src/router.ts", line: 42 },
    { kind: "symbol", symbol: "route", path: "src/router.ts" },
    { kind: "path", path: "src/router.ts" },
  ]);
  assert.equal(normalized.knownRefs.length, 11);
  assert.deepEqual(normalized.evidenceQuestions[0], {
    id: "q1",
    role: "implementation",
    question: "Where is routing implemented?",
    required: true,
    coverageTargets: [{ id: "target:q1", subject: { kind: "topic", topic: "Where is routing implemented?" }, factKind: "behavior", coverageMode: "single" }],
  });
  assert.deepEqual(normalized.evidenceQuestions[1], {
    id: "q2",
    role: "test",
    question: "Which tests cover routing?",
    required: true,
    coverageTargets: [{ id: "target:q2", subject: { kind: "symbol", symbol: "route" }, factKind: "verification", coverageMode: "single" }],
  });
  assert.throws(() => normalizeFreeContextRequest({
    taskText: "Missing work unit.",
    evidenceQuestions: [{ role: "implementation", question: "Where is routing implemented?", required: true, target: { id: "routing", subject: { kind: "topic", topic: "routing" }, factKind: "location", coverageMode: "single" } }],
  }), /workUnit/iu);
  assert.throws(() => normalizeFreeContextRequest({
    taskText: "Old string-target shape.",
    workUnit: { outcome: "answer", goal: "Locate routing." },
    evidenceQuestions: [{ role: "implementation", question: "Where is routing implemented?", required: true, targets: ["routing"] }],
  }), /target/iu);
  assert.throws(() => normalizeFreeContextRequest({
    taskText: "Duplicate target IDs.",
    workUnit: { outcome: "answer", goal: "Locate routing." },
    evidenceQuestions: [
      { role: "implementation", question: "Where is routing implemented?", required: true, target: { id: "routing", subject: { kind: "topic", topic: "routing implementation" }, factKind: "location", coverageMode: "single" } },
      { role: "test", question: "Where is routing tested?", required: false, target: { id: "routing", subject: { kind: "topic", topic: "routing tests" }, factKind: "verification", coverageMode: "single" } },
    ],
  }), /target id must be unique/iu);
});

test("caller recovery is a strict recovery-only relative-path payload", () => {
  assert.deepEqual(FreeContextCallerRequestSchema.parse({
    recovery: { priorSessionId: "session-1", probePath: "src/router.ts" },
  }), {
    recovery: { priorSessionId: "session-1", probePath: "src/router.ts" },
  });
  assert.throws(() => FreeContextCallerRequestSchema.parse({
    taskText: "Caller must not override prior facts.",
    recovery: { priorSessionId: "session-1", probePath: "src/router.ts" },
  }), /Recovery must be the only caller field/u);
  assert.throws(() => FreeContextCallerRequestSchema.parse({
    knownRefs: [],
    recovery: { priorSessionId: "session-1", probePath: "src/router.ts" },
  }), /Recovery must be the only caller field/u);
  assert.throws(() => FreeContextCallerRequestSchema.parse({
    recovery: { priorSessionId: "session-1", probePath: "/workspace/src/router.ts" },
  }), /workspace-relative/u);
  assert.throws(() => FreeContextCallerRequestSchema.parse({
    recovery: { priorSessionId: "session-1", probePath: "C:\\workspace\\src\\router.ts" },
  }), /workspace-relative/u);
});

test("canonical request separates model intent from host invocation facts", () => {
  const taskText = "  Trace the implementation, callers, tests, and configuration contract without losing API constraints.\n";
  const request = FreeContextRequestSchema.parse({
    taskText,
    workUnit: { outcome: "decision", goal: "Identify the routing contract owners." },
    knownRefs: [{ kind: "path", path: "src/router.ts" }],
    evidenceQuestions: [
      { id: "implementation", role: "implementation", question: "Where is routing implemented?", required: true, coverageTargets: [{ id: "routing-body", subject: { kind: "symbol", symbol: "route" }, factKind: "definition", coverageMode: "single" }] },
      { id: "tests", role: "test", question: "Which tests cover it?", required: true, coverageTargets: [{ id: "routing-tests", subject: { kind: "symbol", symbol: "route" }, factKind: "verification", coverageMode: "single" }] },
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
  }), /required coverage slots cannot exceed 6/u);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...request,
    evidenceQuestions: request.evidenceQuestions.map((question) => ({ ...question, required: false, minimumSpans: 2 })),
  }), /optional questions cannot require multiple spans/u);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...request,
    evidenceQuestions: request.evidenceQuestions.map((question) => ({
      ...question,
      coverageTargets: [{ ...question.coverageTargets[0]!, id: "same" }],
    })),
  }), /target id must be unique/u);
});

test("serializeForModel is text-first and contains every canonical evidence field", () => {
  const result = FreeContextResultSchema.parse(readyResult());
  const text = serializeForModel(result);
  assert.equal(text, [
    "Status: ready",
    "Evidence:",
    "1. [e1][implementation][implementation] src/router.ts:10-24 (focus 17) — Defines provider routing.",
    "Excerpt (observed):",
    "export function routeProvider() {}",
    "Exhaustive coverage:",
    "-",
    "Handoff:",
    "- prior_handoff={\"id\":\"handoff:session-1\",\"workUnit\":{\"outcome\":\"answer\",\"goal\":\"Use the verified routing evidence.\"},\"evidenceIds\":[\"e1\"],\"outcome\":{\"kind\":\"answer\",\"instruction\":\"Answer from the verified routing evidence.\"},\"blockingGaps\":[]}",
    "Follow nextAction: consume inline Evidence and proceed to edit/check. If change-critical context is omitted, one necessary adjacent read on an Evidence path is allowed. A listed gap is not replay authorization; for a new gather-level child, send compact reentry with priorSessionId, one question, and a typed evidence/edit/check origin, plus parentGapId only for gap concretization. Same-fact replay remains invalid. Read the decisive implementation span.",
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
  const legacyNotFound = {
    ...readyResult(),
    status: "not_found",
    evidence: [],
    gaps: sixGaps,
    handoff: null,
    nextAction: { kind: "exact_probe", reason: "Search the unresolved questions." },
  };
  assert.equal(LegacyFreeContextResultSchema.parse(legacyNotFound).gaps.length, 6);
  assert.throws(() => FreeContextResultSchema.parse(legacyNotFound), /not_found requires structured recovery/u);
  assert.equal(FreeContextResultSchema.parse({
    ...legacyNotFound,
    nextAction: {
      ...legacyNotFound.nextAction,
      recovery: {
        priorSessionId: "session-1",
      },
    },
  }).status, "not_found");
  assert.throws(() => FreeContextResultSchema.parse({
    ...legacyNotFound,
    nextAction: {
      ...legacyNotFound.nextAction,
      recovery: {
        priorSessionId: "other-session",
      },
    },
  }), /must bind to the result session/u);
  assert.throws(() => FreeContextResultSchema.parse({
    ...readyResult(),
    nextAction: { kind: "exact_probe", reason: "Probe despite complete Evidence." },
  }), /ready requires consume_evidence/u);
  assert.throws(() => FreeContextResultSchema.parse({
    ...readyResult(),
    status: "not_found",
    evidence: [],
    gaps: sixGaps,
    nextAction: { kind: "consume_evidence", reason: "Consume absent Evidence." },
  }), /not_found requires exact_probe/u);
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
      id: `e${index + 1}`,
      path: `${"deep/".repeat(350)}file-${index}.ts`,
      startLine: index * 10 + 1,
      endLine: index * 10 + 2,
      focusLine: index * 10 + 1,
      questionId: `question-${index}`,
    })),
  });
  assert.throws(() => serializeForModel(result), /exceeds 8192 bytes/u);
});
