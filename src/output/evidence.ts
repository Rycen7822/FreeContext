import { readFile } from "node:fs/promises";
import {
  FreeContextInvocationContextSchema,
  handoffGapFor,
  minimumEvidenceSpans,
  questionCoverageTargets,
  requiredEvidenceSlots,
  FreeContextRequestSchema,
  FreeContextResultSchema,
  RESULT_LIMITS,
} from "../mcp/contracts.js";
import type {
  FreeContextErrorCode,
  FreeContextCoverage,
  FreeContextGap,
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
  EvidenceQuestion,
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
  ExplorerCoverageCandidate,
  ExplorerEvidenceCandidate,
  ExplorerGapCandidate,
} from "./candidate.js";

export interface FreeContextTerminal {
  readonly errorCode: FreeContextErrorCode | null;
  readonly reason?: string;
}

const TEST_DIRECTORY_NAMES = new Set(["__tests__", "spec", "specs", "test", "tests"]);
const INLINE_TEST_DECLARATION = /(?:#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|test)\s*\]|(?:^|\n)\s*(?:(?:async\s+)?def\s+test_|class\s+Test\w*|@Test\b|(?:describe|it|test)\s*\(|TEST(?:_F|_P)?\s*\())/mu;

function resolveCandidateTarget(question: Readonly<EvidenceQuestion>, targetId: string | undefined): string | null {
  const targets = questionCoverageTargets(question);
  if (targetId) return targets.some((target) => target.id === targetId) ? targetId : null;
  return targets.length === 1 ? targets[0]?.id ?? null : null;
}

function targetKey(question: Readonly<EvidenceQuestion>, targetId: string | undefined): string {
  return `${question.id}\0${targetId ?? questionCoverageTargets(question)[0]?.id ?? "__question__"}`;
}

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
  const candidate: Readonly<ExplorerCandidate> = rawCandidate ?? Object.freeze({ summary: "", evidence: [], gaps: [], coverage: [] });
  const workspace = await createWorkspace(invocation.workspaceRoot);
  const questions = new Map(request.evidenceQuestions.map((question) => [question.id, question]));
  const fileLines = new Map<string, readonly string[]>();
  const validationReasons = new Map<string, string>();
  const validated: ValidatedEvidenceCandidate[] = [];
  const observedContents = new Set<string>();
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
    const resolvedTargetId = resolveCandidateTarget(question, item.targetId);
    if (!resolvedTargetId) {
      validationReasons.set(item.questionId, "Evidence target was missing or not declared by the requested question.");
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
      const contentKey = `${question.id}\0${question.role}\0${content}`;
      if (observedContents.has(contentKey)) continue;
      observedContents.add(contentKey);
      validated.push(Object.freeze({
        role: question.role,
        path: target.relative,
        startLine: cropped.startLine,
        endLine: cropped.endLine,
        focusLine: item.focusLine,
        questionId: question.id,
        targetId: resolvedTargetId,
        excerpt: content,
        coverageBasis: item.coverageBasis === true,
        why: clipSingleLine(item.why, RESULT_LIMITS.detailCodePoints)
          || "Supports the requested evidence question.",
        contentKey,
      }));
    } catch {
      validationReasons.set(
        item.questionId,
        "Evidence path was missing, sensitive, generated, outside the workspace, or oversized.",
      );
    }
  }

  const selectedEvidence = selectEvidence(validated, request);
  const evidence = selectedEvidence.map(({ coverageBasis: _coverageBasis, ...item }, index) => Object.freeze({
    ...item,
    id: `e${index + 1}`,
  }));
  const evidenceCounts = new Map<string, number>();
  const evidenceTargetCounts = new Map<string, number>();
  for (const item of evidence) {
    evidenceCounts.set(item.questionId, (evidenceCounts.get(item.questionId) ?? 0) + 1);
    const question = questions.get(item.questionId);
    if (question) {
      const key = targetKey(question, item.targetId);
      evidenceTargetCounts.set(key, (evidenceTargetCounts.get(key) ?? 0) + 1);
    }
  }
  const candidateGaps = new Map<string, string>();
  const candidateQuestionGaps = new Map<string, string>();
  for (const gap of candidate.gaps) {
    const question = questions.get(gap.questionId);
    if (!question) continue;
    const reason = clipSingleLine(gap.reason, RESULT_LIMITS.detailCodePoints);
    const resolvedTargetId = resolveCandidateTarget(question, gap.targetId);
    if (gap.targetId && resolvedTargetId) candidateGaps.set(targetKey(question, resolvedTargetId), reason);
    else candidateQuestionGaps.set(question.id, reason);
  }
  const candidateCoverage = new Map<string, Readonly<{ readonly members: readonly string[]; readonly gaps: readonly string[] }>>();
  const duplicateCoverageTargets = new Set<string>();
  for (const item of candidate.coverage ?? []) {
    if (candidateCoverage.has(item.targetId)) duplicateCoverageTargets.add(item.targetId);
    else candidateCoverage.set(item.targetId, item);
  }
  const coverage: readonly Readonly<FreeContextCoverage>[] = request.evidenceQuestions.flatMap((question) => questionCoverageTargets(question)
    .filter((target) => target.coverageMode === "exhaustive")
    .map((target) => {
      const submitted = candidateCoverage.get(target.id);
      const allMembers = [...new Set((submitted?.members ?? []).map((member) => clipSingleLine(member, RESULT_LIMITS.detailCodePoints)).filter(Boolean))];
      const omittedMembers = Math.max(0, allMembers.length - 64);
      const members = allMembers.slice(0, 64);
      const basisEvidenceIds = selectedEvidence.flatMap((item, index) => item.targetId === target.id && item.coverageBasis
        ? [`e${index + 1}`]
        : []);
      const coverageGaps = [...new Set([
        ...(submitted?.gaps ?? []).map((gap) => clipSingleLine(gap, RESULT_LIMITS.detailCodePoints)).filter(Boolean),
        ...[candidateGaps.get(`${question.id}\0${target.id}`), candidateQuestionGaps.get(question.id)].filter((gap): gap is string => Boolean(gap)),
        ...(duplicateCoverageTargets.has(target.id) ? ["Multiple exhaustive coverage declarations were submitted for this target."] : []),
        ...(members.length === 0 ? ["No discovered members were declared for this exhaustive target."] : []),
        ...(basisEvidenceIds.length === 0 ? ["No returned Evidence proves the enumeration boundary for this exhaustive target."] : []),
        ...(omittedMembers > 0 ? [`${omittedMembers} discovered members exceeded the exhaustive coverage envelope.`] : []),
      ])].slice(0, RESULT_LIMITS.evidence);
      return Object.freeze({ targetId: target.id, mode: "exhaustive" as const, members, basisEvidenceIds, gaps: coverageGaps, omittedMembers });
    }));
  const incompleteCoverage = new Map(coverage.filter((item) => item.gaps.length > 0 || item.omittedMembers > 0)
    .map((item) => [item.targetId, item.gaps[0] ?? "Exhaustive coverage remains incomplete."]));
  const gaps: FreeContextGap[] = request.evidenceQuestions.flatMap((question) => {
    const count = evidenceCounts.get(question.id) ?? 0;
    const missingTargets = questionCoverageTargets(question)
      .filter((target) => {
        const key = `${question.id}\0${target.id}`;
        return !(evidenceTargetCounts.get(key) ?? 0) || candidateGaps.has(key) || incompleteCoverage.has(target.id);
      });
    const questionGap = candidateQuestionGaps.get(question.id);
    if (count >= minimumEvidenceSpans(question) && missingTargets.length === 0 && !questionGap) return [];
    const fallbackReason = questionGap
      || validationReasons.get(question.id)
      || (count === 0
        ? "No validated evidence was returned for this question."
        : `Only ${count} of ${requiredEvidenceSlots(question)} required coverage slots were validated.`);
    const unresolvedTargets = missingTargets.length > 0 ? missingTargets : questionCoverageTargets(question);
    return unresolvedTargets.map((target) => Object.freeze({
        questionId: question.id,
        targetId: target.id,
        reason: candidateGaps.get(`${question.id}\0${target.id}`) || incompleteCoverage.get(target.id) || fallbackReason,
      }));
  }).slice(0, RESULT_LIMITS.evidence);
  const requiredCovered = request.evidenceQuestions
    .filter((question) => question.required)
    .every((question) => !candidateQuestionGaps.has(question.id)
      && (evidenceCounts.get(question.id) ?? 0) >= minimumEvidenceSpans(question)
      && questionCoverageTargets(question).every((target) => {
        const key = `${question.id}\0${target.id}`;
        return (evidenceTargetCounts.get(key) ?? 0) > 0 && !candidateGaps.has(key) && !incompleteCoverage.has(target.id);
      }));
  const effectiveError = terminal.errorCode;
  const status = evidence.length === 0
    ? (effectiveError ? "failed" : "not_found")
    : (requiredCovered && effectiveError === null ? "ready" : "partial");
  const blockingGaps = gaps.flatMap((gap) => {
    const question = questions.get(gap.questionId);
    if (!question) return [];
    const target = questionCoverageTargets(question).find((item) => item.id === gap.targetId);
    return question?.required && target ? [handoffGapFor(question, target)] : [];
  });
  const handoff = evidence.length > 0
    ? {
        id: `handoff:${invocation.invocationId}`,
        workUnit: request.workUnit,
        evidenceIds: evidence.flatMap((item) => item.id ? [item.id] : []),
        outcome: {
          kind: request.workUnit.outcome,
          instruction: clipSingleLine(status === "ready"
            ? `Proceed with ${request.workUnit.outcome}: ${request.workUnit.goal}`
            : `Use delivered Evidence for ${request.workUnit.outcome}; reenter only if a typed blocking gap prevents: ${request.workUnit.goal}`, 500),
        },
        blockingGaps,
      }
    : null;
  const result = FreeContextResultSchema.parse({
    status,
    summary: clipSingleLine(candidate.summary, RESULT_LIMITS.summaryCodePoints),
    evidence,
    gaps,
    coverage,
    handoff,
    nextAction: evidence.length > 0
      ? {
          kind: "consume_evidence",
          reason: clipSingleLine(status === "ready"
            ? "Use inline Evidence for the next edit/check; call FreeContext when edit/check exposes a new source-bound gap."
            : "Use supported Evidence now; if a listed gap blocks the next edit/check, call FreeContext for that gap.", RESULT_LIMITS.detailCodePoints),
        }
      : {
          kind: "exact_probe",
          reason: clipSingleLine(
            terminal.reason ?? "No validated evidence was found; make one exact non-broad probe and read at most one candidate, or call FreeContext before broader discovery.",
            RESULT_LIMITS.detailCodePoints,
          ),
        },
    errorCode: status === "not_found" ? null : effectiveError,
    sessionId: invocation.sessionId,
    sessionFile: invocation.sessionFile,
  });
  return fitCompiledResult(result, request, invocation);
}

export function serializeExplorerFeedback(rawResult: Readonly<FreeContextResult>): string {
  const result = FreeContextResultSchema.parse(rawResult);
  const lines = [`Status: ${result.status}`, "Verified evidence:"];
  if (result.evidence.length === 0) lines.push("-");
  for (const item of result.evidence) {
    lines.push(`- [${item.role}][${item.questionId}]${item.targetId ? `[target:${item.targetId}]` : ""} ${item.path}:${item.startLine}-${item.endLine} (focus ${item.focusLine}) — ${item.why}`);
    if (item.excerpt !== undefined) lines.push(`Excerpt (observed):\n${item.excerpt}`);
  }
  lines.push("Unresolved questions:");
  if (result.gaps.length === 0) lines.push("-");
  for (const gap of result.gaps) lines.push(`- [${gap.questionId}]${gap.targetId ? `[target:${gap.targetId}]` : ""} ${gap.reason}`);
  lines.push(`Next action: ${result.nextAction.kind} — ${result.nextAction.reason}`);
  lines.push(result.status === "ready"
    ? "This candidate is terminal for these questions only. Do not continue native exploration; call gather_context first if task work exposes any new path, symbol, or missing context."
    : "This is non-terminal feedback. Continue this same Pi exploration session, resolve only the listed gaps with repository tools, and submit an updated candidate. Do not call gather_context or start another session.");
  return lines.join("\n");
}
