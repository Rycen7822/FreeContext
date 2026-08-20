import path from "node:path";
import { RESULT_LIMITS } from "../mcp/contracts.js";
import type { EvidenceRole, FreeContextEvidence, FreeContextRequest } from "../mcp/contracts.js";

const GENERATED_OR_VENDOR_SEGMENTS = new Set([
  ".cache",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const ROLE_ORDER: Readonly<Record<EvidenceRole, number>> = Object.freeze({
  implementation: 0,
  caller: 1,
  test: 2,
  contract: 3,
});

export interface ValidatedEvidenceCandidate extends FreeContextEvidence {
  readonly contentHash: string;
}

export function normalizeCandidatePath(value: string): string | null {
  const slashes = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!slashes || slashes.includes("\0") || path.posix.isAbsolute(slashes)) return null;
  const normalized = path.posix.normalize(slashes);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  const segments = normalized.toLowerCase().split("/");
  return segments.some((segment) => GENERATED_OR_VENDOR_SEGMENTS.has(segment)) ? null : normalized;
}

export function cropAroundFocus(
  startLine: number,
  endLine: number,
  focusLine: number,
  targetLines: number = RESULT_LIMITS.spanLines,
): Readonly<{ startLine: number; endLine: number }> {
  const limit = Math.max(1, Math.min(RESULT_LIMITS.spanLines, Math.floor(targetLines)));
  if (endLine - startLine + 1 <= limit) return { startLine, endLine };
  let start = Math.max(startLine, focusLine - Math.floor((limit - 1) / 2));
  let end = Math.min(endLine, start + limit - 1);
  start = Math.max(startLine, end - limit + 1);
  return { startLine: start, endLine: end };
}

function mergeCandidates(values: readonly ValidatedEvidenceCandidate[]): readonly ValidatedEvidenceCandidate[] {
  const ordered = [...values].sort((left, right) => left.path.localeCompare(right.path)
    || left.questionId.localeCompare(right.questionId)
    || ROLE_ORDER[left.role] - ROLE_ORDER[right.role]
    || left.startLine - right.startLine
    || left.endLine - right.endLine);
  const merged: ValidatedEvidenceCandidate[] = [];
  for (const item of ordered) {
    const previous = merged.at(-1);
    const mergedEnd = previous ? Math.max(previous.endLine, item.endLine) : 0;
    if (previous
      && previous.path === item.path
      && previous.questionId === item.questionId
      && previous.role === item.role
      && item.startLine <= previous.endLine + 10
      && mergedEnd - Math.min(previous.startLine, item.startLine) + 1 <= RESULT_LIMITS.spanLines) {
      merged[merged.length - 1] = Object.freeze({
        ...previous,
        startLine: Math.min(previous.startLine, item.startLine),
        endLine: mergedEnd,
        contentHash: `${previous.contentHash}:${item.contentHash}`,
      });
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function rankCandidates(
  values: readonly ValidatedEvidenceCandidate[],
  request: Readonly<FreeContextRequest>,
): readonly ValidatedEvidenceCandidate[] {
  const questionIndex = new Map(request.evidenceQuestions.map((question, index) => [question.id, index]));
  const required = new Set(request.evidenceQuestions.filter((question) => question.required).map((question) => question.id));
  return [...values].sort((left, right) => Number(required.has(right.questionId)) - Number(required.has(left.questionId))
    || (questionIndex.get(left.questionId) ?? Number.MAX_SAFE_INTEGER) - (questionIndex.get(right.questionId) ?? Number.MAX_SAFE_INTEGER)
    || ROLE_ORDER[left.role] - ROLE_ORDER[right.role]
    || left.path.localeCompare(right.path)
    || left.startLine - right.startLine);
}

export function selectEvidence(
  values: readonly ValidatedEvidenceCandidate[],
  request: Readonly<FreeContextRequest>,
): readonly FreeContextEvidence[] {
  const ranked = rankCandidates(mergeCandidates(values), request);
  const selected: ValidatedEvidenceCandidate[] = [];
  const selectedKeys = new Set<string>();
  let totalLines = 0;
  const trySelect = (item: ValidatedEvidenceCandidate): void => {
    const key = `${item.path}\0${item.startLine}\0${item.endLine}\0${item.questionId}\0${item.role}`;
    const lines = item.endLine - item.startLine + 1;
    if (selectedKeys.has(key) || selected.length >= RESULT_LIMITS.evidence || totalLines + lines > RESULT_LIMITS.totalLines) return;
    selected.push(item);
    selectedKeys.add(key);
    totalLines += lines;
  };
  for (const question of request.evidenceQuestions.filter((item) => item.required)) {
    const item = ranked.find((candidate) => candidate.questionId === question.id);
    if (item) trySelect(item);
  }
  for (const question of request.evidenceQuestions) {
    if (selected.some((item) => item.questionId === question.id)) continue;
    const item = ranked.find((candidate) => candidate.questionId === question.id);
    if (item) trySelect(item);
  }
  for (const item of ranked) trySelect(item);
  return Object.freeze(selected.map(({ contentHash: _contentHash, ...item }) => Object.freeze(item)));
}
