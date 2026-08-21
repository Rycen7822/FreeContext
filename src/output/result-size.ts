import {
  FreeContextResultSchema,
  MODEL_RESULT_MAX_BYTES,
  serializeForModel,
} from "../mcp/contracts.js";
import type {
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
} from "../mcp/contracts.js";
import { clipSingleLine } from "./candidate.js";

function resultFits(result: Readonly<FreeContextResult>): boolean {
  try {
    return Buffer.byteLength(serializeForModel(result), "utf8") <= MODEL_RESULT_MAX_BYTES;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function oversizeFailure(
  invocation: Readonly<FreeContextInvocationContext>,
  request: Readonly<FreeContextRequest>,
): Readonly<FreeContextResult> {
  const result = FreeContextResultSchema.parse({
    status: "failed",
    summary: "",
    evidence: [],
    gaps: request.evidenceQuestions.map((question) => ({
      questionId: question.id,
      reason: "The compiled result exceeded the model-visible byte limit.",
    })),
    nextAction: { kind: "direct_search", reason: "The compiled result exceeded the model-visible byte limit." },
    errorCode: "RESULT_TOO_LARGE",
    sessionId: invocation.sessionId,
    sessionFile: null,
  });
  if (!resultFits(result)) throw new RangeError("Minimal RESULT_TOO_LARGE response exceeds the model-visible byte limit.");
  return Object.freeze(result);
}

export function fitCompiledResult(
  initial: Readonly<FreeContextResult>,
  request: Readonly<FreeContextRequest>,
  invocation: Readonly<FreeContextInvocationContext>,
): Readonly<FreeContextResult> {
  let result = initial;
  const required = new Set(request.evidenceQuestions.filter((question) => question.required).map((question) => question.id));
  while (!resultFits(result) && result.evidence.length > 1) {
    const removeIndex = [...result.evidence].findLastIndex((item) => {
      const sameQuestion = result.evidence.filter((candidate) => candidate.questionId === item.questionId).length;
      return !required.has(item.questionId) || sameQuestion > 1;
    });
    if (removeIndex < 0) break;
    const removed = result.evidence[removeIndex];
    const evidence = result.evidence.filter((_item, index) => index !== removeIndex);
    const stillCovered = removed ? evidence.some((item) => item.questionId === removed.questionId) : true;
    const gaps = removed && !stillCovered && !result.gaps.some((gap) => gap.questionId === removed.questionId)
      ? [...result.gaps, { questionId: removed.questionId, reason: "Lower-ranked evidence was omitted to fit the model-visible result." }]
      : result.gaps;
    const first = evidence[0];
    result = FreeContextResultSchema.parse({
      ...result,
      evidence,
      gaps,
      nextAction: first
        ? {
            kind: "read",
            path: first.path,
            startLine: first.startLine,
            endLine: first.endLine,
            reason: result.nextAction.reason,
          }
        : result.nextAction,
    });
  }
  if (resultFits(result)) return Object.freeze(result);

  const questions = new Map(request.evidenceQuestions.map((question) => [question.id, question]));
  result = FreeContextResultSchema.parse({
    ...result,
    summary: clipSingleLine(result.summary, 120),
    evidence: result.evidence.map((item) => ({
      ...item,
      why: clipSingleLine(item.why, 60) || "Supports this question.",
    })),
    gaps: result.gaps.map((gap) => ({
      ...gap,
      reason: questions.get(gap.questionId)?.required
        ? gap.reason
        : clipSingleLine(gap.reason, 60) || "Evidence remains unresolved.",
    })),
    nextAction: {
      ...result.nextAction,
      reason: clipSingleLine(result.nextAction.reason, 60) || "Read the first evidence span.",
    },
  });
  return resultFits(result) ? Object.freeze(result) : oversizeFailure(invocation, request);
}
