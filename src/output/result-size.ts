import {
  FreeContextResultSchema,
  handoffGapFor,
  MODEL_RESULT_MAX_BYTES,
  questionCoverageTargets,
  RESULT_LIMITS,
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

function compactNextActionReason(result: Readonly<FreeContextResult>): string {
  if (result.nextAction.kind === "exact_probe") {
    return result.nextAction.recovery
      ? "Make one exact probe, then send only recovery.priorSessionId and the workspace-relative probePath."
      : "Make one exact probe; call FreeContext before broader discovery.";
  }
  if (result.nextAction.kind === "native_exploration") {
    return "Continue normal native repository exploration after this terminal failure; do not force an exact probe or recovery.";
  }
  if ((result.handoff?.blockingGaps.length ?? 0) > 0) {
    return "Consume Evidence as read context; no remap; verify 1-2 exact/adjacent contexts, then edit/check; typed gap reentry only.";
  }
  return "Consume Evidence as read context; no remap; verify 1-2 exact/adjacent contexts, then edit/check.";
}

function linkCoverageGaps(
  result: Readonly<FreeContextResult>,
  request: Readonly<FreeContextRequest>,
): Readonly<FreeContextResult> {
  const incomplete = (result.coverage ?? []).filter((item) => item.gaps.length > 0 || item.omittedMembers > 0);
  if (incomplete.length === 0) return result;
  const gaps = [...result.gaps];
  const blockingGaps = [...(result.handoff?.blockingGaps ?? [])];
  for (const coverage of incomplete) {
    const question = request.evidenceQuestions.find((item) => item.coverageTargets.some((target) => target.id === coverage.targetId));
    const target = question?.coverageTargets.find((item) => item.id === coverage.targetId);
    if (!question || !target) continue;
    if (!gaps.some((gap) => gap.targetId === coverage.targetId)) {
      gaps.push({
        questionId: question.id,
        targetId: coverage.targetId,
        reason: coverage.gaps[0] ?? "Exhaustive coverage remains incomplete.",
      });
    }
    if (result.handoff && !blockingGaps.some((gap) => gap.targetId === coverage.targetId)) {
      blockingGaps.push(handoffGapFor(question, target));
    }
  }
  const status = result.status === "ready" ? "partial" : result.status;
  const linked = FreeContextResultSchema.parse({
    ...result,
    status,
    gaps: gaps.slice(0, RESULT_LIMITS.evidence),
    handoff: result.handoff
      ? {
          ...result.handoff,
          blockingGaps: blockingGaps.slice(0, RESULT_LIMITS.evidence),
          outcome: status === "partial" && result.status === "ready"
            ? { ...result.handoff.outcome, instruction: "Use returned Evidence; execute the handoff, and reenter only for a new typed blocking gap." }
            : result.handoff.outcome,
        }
      : result.handoff,
  });
  return FreeContextResultSchema.parse({
    ...linked,
    nextAction: { ...linked.nextAction, reason: compactNextActionReason(linked) },
  });
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
    nextAction: { kind: "native_exploration", reason: "The compiled result exceeded the model-visible byte limit; continue normal native repository exploration." },
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
      reason: compactNextActionReason(result),
    },
  });
  if (resultFits(result)) return Object.freeze(result);

  const required = new Set(request.evidenceQuestions.filter((question) => question.required).map((question) => question.id));
  while (!resultFits(result) && result.evidence.length > 1) {
    const preferredIndex = [...result.evidence].findLastIndex((item) => {
      const sameQuestion = result.evidence.filter((candidate) => candidate.questionId === item.questionId).length;
      const sameTarget = result.evidence.filter((candidate) => candidate.questionId === item.questionId
        && candidate.targetId === item.targetId).length;
      return !required.has(item.questionId) || (sameQuestion > 1 && sameTarget > 1);
    });
    const removeIndex = preferredIndex >= 0 ? preferredIndex : result.evidence.length - 1;
    const removed = result.evidence[removeIndex];
    const evidence = result.evidence.filter((_item, index) => index !== removeIndex);
    const coverage = (result.coverage ?? []).map((item) => {
      if (!removed?.id || !item.basisEvidenceIds.includes(removed.id)) return item;
      const basisEvidenceIds = item.basisEvidenceIds.filter((id) => id !== removed.id);
      return {
        ...item,
        basisEvidenceIds,
        gaps: basisEvidenceIds.length > 0 || item.gaps.length > 0
          ? item.gaps
          : ["Enumeration-boundary Evidence was omitted to fit the model-visible result."],
      };
    });
    const stillTargetCovered = removed ? evidence.some((item) => item.questionId === removed.questionId && item.targetId === removed.targetId) : true;
    const question = removed ? request.evidenceQuestions.find((candidate) => candidate.id === removed.questionId) : undefined;
    const targetId = removed && question ? removed.targetId ?? questionCoverageTargets(question)[0]?.id : undefined;
    const target = question?.coverageTargets.find((candidate) => candidate.id === targetId);
    if (removed && !targetId) return oversizeFailure(invocation, request);
    const needsGap = Boolean(removed && !stillTargetCovered
      && !result.gaps.some((gap) => gap.questionId === removed.questionId && gap.targetId === targetId));
    if (needsGap && result.gaps.length >= RESULT_LIMITS.evidence) return oversizeFailure(invocation, request);
    const gaps = needsGap && removed
      ? [...result.gaps, { questionId: removed.questionId, targetId, reason: "Evidence was omitted rather than truncated to fit the model-visible result." }]
      : result.gaps;
    result = linkCoverageGaps(FreeContextResultSchema.parse({
      ...result,
      status: (needsGap || coverage.some((item) => item.gaps.length > 0)) && result.status === "ready" ? "partial" : result.status,
      evidence,
      gaps,
      coverage,
      handoff: result.handoff
        ? {
            ...result.handoff,
            evidenceIds: result.handoff.evidenceIds.filter((id) => id !== removed?.id),
            blockingGaps: needsGap && question && target && !result.handoff.blockingGaps.some((gap) => gap.targetId === target.id)
              ? [...result.handoff.blockingGaps, handoffGapFor(question, target)]
              : result.handoff.blockingGaps,
          }
        : result.handoff,
      nextAction: evidence.length > 0
        ? {
            kind: "consume_evidence",
            reason: compactNextActionReason(result),
          }
        : result.nextAction,
    }), request);
  }
  if (resultFits(result)) return Object.freeze(result);
  while (!resultFits(result) && (result.coverage ?? []).some((item) => item.members.length > 0)) {
    const index = (result.coverage ?? []).findLastIndex((item) => item.members.length > 0);
    const coverageTarget = result.coverage?.[index]?.targetId;
    const question = request.evidenceQuestions.find((item) => item.coverageTargets.some((target) => target.id === coverageTarget));
    const target = question?.coverageTargets.find((item) => item.id === coverageTarget);
    result = linkCoverageGaps(FreeContextResultSchema.parse({
      ...result,
      status: result.status === "ready" ? "partial" : result.status,
      coverage: (result.coverage ?? []).map((item, itemIndex) => itemIndex === index
        ? {
            ...item,
            members: item.members.slice(0, -1),
            omittedMembers: item.omittedMembers + 1,
            gaps: item.gaps.length > 0
              ? item.gaps
              : ["Discovered members were omitted to fit the model-visible result."],
          }
        : item),
      handoff: result.handoff && question && target && !result.handoff.blockingGaps.some((gap) => gap.targetId === target.id)
        ? { ...result.handoff, blockingGaps: [...result.handoff.blockingGaps, handoffGapFor(question, target)] }
        : result.handoff,
    }), request);
  }
  if (resultFits(result)) return Object.freeze(result);
  return oversizeFailure(invocation, request);
}
