import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FreeContextInvocationContextSchema,
  minimumEvidenceSpans,
  FreeContextRequestSchema,
  FreeContextResultSchema,
  RESULT_LIMITS,
} from "../mcp/contracts.js";
import type {
  FreeContextErrorCode,
  FreeContextGap,
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
} from "../mcp/contracts.js";
import { assertDirectFileSize, createWorkspace } from "../tools/workspace.js";
import { clipSingleLine, readTextLines } from "./candidate.js";
import type { ExplorerCandidate } from "./candidate.js";
import { cropAroundFocus, normalizeCandidatePath, selectEvidence } from "./evidence-selection.js";
import type { ValidatedEvidenceCandidate } from "./evidence-selection.js";
import { fitCompiledResult } from "./result-size.js";
import type { ObservedRead } from "../runtime/finalization.js";

export type {
  ExplorerCandidate,
  ExplorerEvidenceCandidate,
  ExplorerGapCandidate,
} from "./candidate.js";

export interface FreeContextTerminal {
  readonly errorCode: FreeContextErrorCode | null;
  readonly reason?: string;
}

const TEST_DIRECTORY_NAMES = new Set(["__tests__", "spec", "specs", "test", "tests"]);
const INLINE_TEST_DECLARATION = /(?:#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|test)\s*\]|(?:^|\n)\s*(?:(?:async\s+)?def\s+test_|class\s+Test\w*|@Test\b|(?:describe|it|test)\s*\(|TEST(?:_F|_P)?\s*\())/mu;

function supportsTestRole(pathValue: string, content: string): boolean {
  const segments = pathValue.split("/");
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()))) return true;
  const file = segments.at(-1) ?? "";
  const stem = file.replace(/\.[^.]+$/u, "");
  const conventionalName = /^(?:test|tests|spec|specs)$/iu.test(stem)
    || /^(?:test|spec)[_.-]/iu.test(stem)
    || /[_.-](?:test|tests|spec|specs)$/iu.test(stem)
    || /[a-z0-9](?:Test|Tests|Spec|Specs)$/u.test(stem);
  return conventionalName || INLINE_TEST_DECLARATION.test(content);
}

export async function compileFreeContextResult(
  rawRequest: Readonly<FreeContextRequest>,
  rawInvocation: Readonly<FreeContextInvocationContext>,
  rawCandidate: Readonly<ExplorerCandidate> | null,
  terminal: Readonly<FreeContextTerminal> = Object.freeze({ errorCode: null }),
  observedReads: readonly Readonly<ObservedRead>[] = Object.freeze([]),
): Promise<Readonly<FreeContextResult>> {
  const request = FreeContextRequestSchema.parse(rawRequest);
  const invocation = FreeContextInvocationContextSchema.parse(rawInvocation);
  const candidate = rawCandidate ?? Object.freeze({ summary: "", evidence: [], gaps: [] });
  const workspace = await createWorkspace(invocation.workspaceRoot);
  const questions = new Map(request.evidenceQuestions.map((question) => [question.id, question]));
  const fileLines = new Map<string, readonly string[]>();
  const validationReasons = new Map<string, string>();
  const validated: ValidatedEvidenceCandidate[] = [];
  const contentHashes = new Set<string>();
  const spanTargetLines = Math.floor(RESULT_LIMITS.totalLines
    / Math.max(1, Math.min(candidate.evidence.length, RESULT_LIMITS.evidence)));

  for (const item of candidate.evidence) {
    const question = questions.get(item.questionId);
    if (!question || item.role !== question.role) {
      if (questions.has(item.questionId)) {
        validationReasons.set(item.questionId, "Evidence role did not match the requested role.");
      }
      continue;
    }
    const normalizedPath = normalizeCandidatePath(item.path);
    const validNumbers = Number.isSafeInteger(item.startLine)
      && Number.isSafeInteger(item.endLine)
      && Number.isSafeInteger(item.focusLine)
      && item.startLine >= 1
      && item.endLine >= item.startLine
      && item.focusLine >= item.startLine
      && item.focusLine <= item.endLine;
    if (!normalizedPath || !validNumbers) {
      validationReasons.set(item.questionId, "Evidence path, range, or focus line was invalid.");
      continue;
    }
    const observed = observedReads.some((read) => (
      read.path === normalizedPath && item.startLine >= read.startLine && item.endLine <= read.endLine
    ));
    if (!observed) {
      validationReasons.set(item.questionId, "Evidence range was not present in a successful read observation.");
      continue;
    }
    try {
      const target = await workspace.resolveExisting(normalizedPath, { kind: "file" });
      assertDirectFileSize(target);
      let lines = fileLines.get(target.absolute);
      if (!lines) {
        lines = readTextLines(await readFile(target.absolute, "utf8"));
        fileLines.set(target.absolute, lines);
      }
      if (item.endLine > lines.length) {
        validationReasons.set(item.questionId, "Evidence range exceeded the file length.");
        continue;
      }
      const cropped = cropAroundFocus(item.startLine, item.endLine, item.focusLine, spanTargetLines);
      const content = lines.slice(cropped.startLine - 1, cropped.endLine).join("\n");
      if (question.role === "test" && !supportsTestRole(normalizedPath, content)) {
        validationReasons.set(item.questionId, "Evidence range was not an actual test/spec or inline test block.");
        continue;
      }
      const contentHash = createHash("sha256").update(content).digest("hex");
      const duplicateKey = `${question.id}\0${question.role}\0${contentHash}`;
      if (contentHashes.has(duplicateKey)) continue;
      contentHashes.add(duplicateKey);
      validated.push(Object.freeze({
        role: question.role,
        path: target.relative,
        startLine: cropped.startLine,
        endLine: cropped.endLine,
        focusLine: item.focusLine,
        questionId: question.id,
        why: clipSingleLine(item.why, RESULT_LIMITS.detailCodePoints)
          || "Supports the requested evidence question.",
        contentHash,
      }));
    } catch {
      validationReasons.set(
        item.questionId,
        "Evidence path was missing, sensitive, generated, outside the workspace, or oversized.",
      );
    }
  }

  const evidence = selectEvidence(validated, request);
  const evidenceCounts = new Map<string, number>();
  for (const item of evidence) evidenceCounts.set(item.questionId, (evidenceCounts.get(item.questionId) ?? 0) + 1);
  const candidateGaps = new Map(
    candidate.gaps
      .filter((gap) => questions.has(gap.questionId))
      .map((gap) => [gap.questionId, clipSingleLine(gap.reason, RESULT_LIMITS.detailCodePoints)]),
  );
  const gaps: FreeContextGap[] = request.evidenceQuestions
    .filter((question) => (evidenceCounts.get(question.id) ?? 0) < minimumEvidenceSpans(question))
    .map((question) => Object.freeze({
      questionId: question.id,
      reason: candidateGaps.get(question.id)
        || validationReasons.get(question.id)
        || ((evidenceCounts.get(question.id) ?? 0) === 0
          ? "No validated evidence was returned for this question."
          : `Only ${evidenceCounts.get(question.id)} of ${minimumEvidenceSpans(question)} required spans were validated.`),
    }));
  const requiredCovered = request.evidenceQuestions
    .filter((question) => question.required)
    .every((question) => (evidenceCounts.get(question.id) ?? 0) >= minimumEvidenceSpans(question));
  const effectiveError = terminal.errorCode;
  const status = evidence.length === 0
    ? (effectiveError ? "failed" : "not_found")
    : (requiredCovered && effectiveError === null ? "ready" : "partial");
  const first = evidence[0];
  const result = FreeContextResultSchema.parse({
    status,
    summary: clipSingleLine(candidate.summary, RESULT_LIMITS.summaryCodePoints),
    evidence,
    gaps,
    nextAction: first
      ? {
          kind: "read",
          path: first.path,
          startLine: first.startLine,
          endLine: first.endLine,
          reason: status === "ready"
            ? "Then edit/test directly; if more context is needed, call FreeContext before any non-evidence read or search."
            : "Then call FreeContext once with the exact unresolved questions and all Evidence paths before any other action.",
        }
      : {
          kind: "direct_search",
          reason: clipSingleLine(
            terminal.reason ?? "No validated evidence was found for the unresolved questions.",
            RESULT_LIMITS.detailCodePoints,
          ),
        },
    errorCode: status === "not_found" ? null : effectiveError,
    sessionId: invocation.sessionId,
    sessionFile: invocation.sessionFile,
  });
  return fitCompiledResult(result, request, invocation);
}
