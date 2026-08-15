import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FreeContextInvocationContextSchema,
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
import { clipSingleLine, parseExplorerCandidate, readTextLines } from "./candidate.js";
import { cropAroundFocus, normalizeCandidatePath, selectEvidence } from "./evidence-selection.js";
import type { ValidatedEvidenceCandidate } from "./evidence-selection.js";
import { fitCompiledResult } from "./result-size.js";

export { parseExplorerCandidate } from "./candidate.js";
export type {
  ExplorerEvidenceCandidate,
  ExplorerGapCandidate,
  ParsedExplorerCandidate,
} from "./candidate.js";

export interface FreeContextTerminal {
  readonly errorCode: FreeContextErrorCode | null;
  readonly reason?: string;
}

export async function compileFreeContextResult(
  rawRequest: Readonly<FreeContextRequest>,
  rawInvocation: Readonly<FreeContextInvocationContext>,
  rawCandidate: unknown,
  terminal: Readonly<FreeContextTerminal> = Object.freeze({ errorCode: null }),
): Promise<Readonly<FreeContextResult>> {
  const request = FreeContextRequestSchema.parse(rawRequest);
  const invocation = FreeContextInvocationContextSchema.parse(rawInvocation);
  const candidate = parseExplorerCandidate(rawCandidate);
  const workspace = await createWorkspace(invocation.workspaceRoot);
  const questions = new Map(request.evidenceQuestions.map((question) => [question.id, question]));
  const fileLines = new Map<string, readonly string[]>();
  const validationReasons = new Map<string, string>();
  const validated: ValidatedEvidenceCandidate[] = [];
  const contentHashes = new Set<string>();

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
      const cropped = cropAroundFocus(item.startLine, item.endLine, item.focusLine);
      const content = lines.slice(cropped.startLine - 1, cropped.endLine).join("\n");
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
  const covered = new Set(evidence.map((item) => item.questionId));
  const candidateGaps = new Map(
    candidate.gaps
      .filter((gap) => questions.has(gap.questionId))
      .map((gap) => [gap.questionId, clipSingleLine(gap.reason, RESULT_LIMITS.detailCodePoints)]),
  );
  const gaps: FreeContextGap[] = request.evidenceQuestions
    .filter((question) => !covered.has(question.id))
    .map((question) => Object.freeze({
      questionId: question.id,
      reason: candidateGaps.get(question.id)
        || validationReasons.get(question.id)
        || "No validated evidence was returned for this question.",
    }));
  const requiredCovered = request.evidenceQuestions
    .filter((question) => question.required)
    .every((question) => covered.has(question.id));
  const effectiveError = terminal.errorCode ?? (candidate.problems.length > 0 ? "INTERNAL_ERROR" : null);
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
          reason: "Read the first compiled evidence span before broader exploration.",
        }
      : {
          kind: "direct_search",
          reason: clipSingleLine(
            terminal.reason ?? "Search directly for the unresolved evidence questions.",
            RESULT_LIMITS.detailCodePoints,
          ),
        },
    errorCode: status === "not_found" ? null : effectiveError,
    sessionId: invocation.sessionId,
    sessionFile: invocation.sessionFile,
  });
  return fitCompiledResult(result, request, invocation);
}
