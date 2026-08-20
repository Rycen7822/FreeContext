import { isDeepStrictEqual } from "node:util";
import type { FreeContextRequest, FreeContextResult } from "../mcp/contracts.js";
import type { FreeContextTransportObservation } from "./delivery-observation.js";

export type FreeContextInvocationKind = "initial" | "gap_followup" | "reentrant" | "invalid";

export interface FreeContextInvocationWindowInput {
  readonly callId: string;
  readonly request: Readonly<FreeContextRequest>;
  readonly result: Readonly<FreeContextResult>;
  readonly serializedTextSha256: string;
}

export interface FreeContextInvocationWindow {
  readonly inputIndex: number;
  readonly callId: string;
  readonly episodeIndex: number;
  readonly invocationKind: FreeContextInvocationKind;
  readonly windowStartedAfter: string | null;
  readonly windowEndedBefore: string | null;
  readonly windowObserved: boolean;
  readonly exactDuplicate: boolean;
  readonly failureReasons: readonly string[];
}

interface CorrelatedInvocation {
  readonly inputIndex: number;
  readonly input: Readonly<FreeContextInvocationWindowInput>;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly completedAt: string;
  readonly completedMs: number;
}

function questionIds(request: Readonly<FreeContextRequest>): Set<string> {
  return new Set(request.evidenceQuestions.map(({ id }) => id));
}

function sameQuestion(
  current: Readonly<FreeContextRequest>["evidenceQuestions"][number],
  previous: Readonly<FreeContextRequest>["evidenceQuestions"][number],
): boolean {
  return current.id === previous.id && current.role === previous.role &&
    current.question === previous.question && current.required === previous.required &&
    (current.minimumSpans ?? 1) === (previous.minimumSpans ?? 1);
}

function sameRequest(current: Readonly<FreeContextRequest>, previous: Readonly<FreeContextRequest>): boolean {
  return current.taskText === previous.taskText && isDeepStrictEqual(current.knownRefs, previous.knownRefs) &&
    current.evidenceQuestions.length === previous.evidenceQuestions.length &&
    current.evidenceQuestions.every((question, index) => {
      const prior = previous.evidenceQuestions[index];
      return prior !== undefined && sameQuestion(question, prior);
    });
}

function matchesGapQuestions(
  current: Readonly<FreeContextRequest>,
  previous: Readonly<FreeContextRequest>,
  gapIds: ReadonlySet<string>,
): boolean {
  if (current.evidenceQuestions.length !== gapIds.size) return false;
  const previousQuestions = new Map(previous.evidenceQuestions.map((question) => [question.id, question]));
  return current.evidenceQuestions.every((question) => {
    const prior = previousQuestions.get(question.id);
    return gapIds.has(question.id) && prior !== undefined && sameQuestion(question, prior);
  });
}

function normalizedReferencePaths(request: Readonly<FreeContextRequest>): Set<string> {
  return new Set(request.knownRefs.flatMap((reference) => {
    if (reference.kind === "path" || reference.kind === "stack") return [reference.path];
    return reference.path ? [reference.path] : [];
  }).map((value) => value.replace(/\\/gu, "/").replace(/^\.\//u, "")));
}

function coversEvidencePaths(
  request: Readonly<FreeContextRequest>,
  result: Readonly<FreeContextResult>,
): boolean {
  const references = normalizedReferencePaths(request);
  return result.evidence.every(({ path }) =>
    references.has(path.replace(/\\/gu, "/").replace(/^\.\//u, "")));
}

function invalidWindows(
  inputs: readonly Readonly<FreeContextInvocationWindowInput>[],
  reasons: readonly string[],
): readonly Readonly<FreeContextInvocationWindow>[] {
  return Object.freeze(inputs.map((input, inputIndex) => Object.freeze({
    inputIndex,
    callId: input.callId,
    episodeIndex: 1,
    invocationKind: "invalid" as const,
    windowStartedAfter: null,
    windowEndedBefore: null,
    windowObserved: false,
    exactDuplicate: inputs.some((candidate, candidateIndex) =>
      candidateIndex !== inputIndex && sameRequest(candidate.request, input.request)),
    failureReasons: Object.freeze([...reasons]),
  })));
}

export function buildFreeContextInvocationWindows(
  inputs: readonly Readonly<FreeContextInvocationWindowInput>[],
  transports: readonly Readonly<FreeContextTransportObservation>[],
): readonly Readonly<FreeContextInvocationWindow>[] {
  if (inputs.length === 0) return Object.freeze([]);
  if (new Set(inputs.map(({ callId }) => callId)).size !== inputs.length) {
    return invalidWindows(inputs, ["duplicate_call_id"]);
  }

  const correlated: CorrelatedInvocation[] = [];
  const transportIndicesByHash = new Map<string, number[]>();
  for (const [transportIndex, transport] of transports.entries()) {
    if (typeof transport.terminalTextSha256 !== "string") continue;
    const indices = transportIndicesByHash.get(transport.terminalTextSha256) ?? [];
    indices.push(transportIndex);
    transportIndicesByHash.set(transport.terminalTextSha256, indices);
  }
  const usedTransports = new Set<number>();
  for (const [inputIndex, input] of inputs.entries()) {
    const matchingIndices = transportIndicesByHash.get(input.serializedTextSha256) ?? [];
    const transportIndex = matchingIndices[0];
    if (matchingIndices.length !== 1 || transportIndex === undefined || usedTransports.has(transportIndex)) {
      return invalidWindows(inputs, ["transport_correlation"]);
    }
    const transport = transports[transportIndex];
    if (!transport) return invalidWindows(inputs, ["transport_correlation"]);
    if (transport.startedAt === null || transport.completedAt === null) {
      return invalidWindows(inputs, ["missing_transport_timestamp"]);
    }
    const startedMs = Date.parse(transport.startedAt);
    const completedMs = Date.parse(transport.completedAt);
    if (Number.isNaN(startedMs) || Number.isNaN(completedMs) || completedMs < startedMs) {
      return invalidWindows(inputs, ["invalid_transport_timestamp"]);
    }
    usedTransports.add(transportIndex);
    correlated.push({
      inputIndex,
      input,
      startedAt: transport.startedAt,
      startedMs,
      completedAt: transport.completedAt,
      completedMs,
    });
  }
  if (usedTransports.size !== transports.length) return invalidWindows(inputs, ["orphan_transport"]);

  correlated.sort((left, right) => left.startedMs - right.startedMs || left.inputIndex - right.inputIndex);
  for (let index = 1; index < correlated.length; index += 1) {
    const previous = correlated[index - 1];
    const current = correlated[index];
    if (!previous || !current || current.startedMs < previous.completedMs) {
      return invalidWindows(inputs, ["overlapping_invocation"]);
    }
  }

  const seenQuestionIds = new Set<string>();
  const priorRequests: Readonly<FreeContextRequest>[] = [];
  let episodeIndex = 1;
  const windows: FreeContextInvocationWindow[] = [];
  for (const [index, invocation] of correlated.entries()) {
    const previous = correlated[index - 1];
    const currentIds = questionIds(invocation.input.request);
    const exactDuplicate = priorRequests.some((request) => sameRequest(request, invocation.input.request));
    let invocationKind: FreeContextInvocationKind = index === 0 ? "initial" : "invalid";
    const failureReasons: string[] = [];

    if (exactDuplicate) {
      invocationKind = "invalid";
      failureReasons.push("exact_request_replay");
    } else if (previous) {
      const previousGapIds = new Set(previous.input.result.gaps.map(({ questionId }) => questionId));
      const previousQuestionIds = questionIds(previous.input.request);
      const touchesPreviousGap = [...currentIds].some((questionId) => previousGapIds.has(questionId));
      if (previous.input.result.status === "partial" && touchesPreviousGap) {
        if ([...previousGapIds].every((questionId) => previousQuestionIds.has(questionId)) &&
            matchesGapQuestions(invocation.input.request, previous.input.request, previousGapIds) &&
            coversEvidencePaths(invocation.input.request, previous.input.result)) {
          invocationKind = "gap_followup";
        } else {
          invocationKind = "invalid";
          failureReasons.push("invalid_gap_followup");
        }
      } else if (currentIds.size >= 1 && currentIds.size <= 4 &&
          [...currentIds].every((questionId) => !seenQuestionIds.has(questionId))) {
        invocationKind = "reentrant";
        episodeIndex += 1;
      } else {
        invocationKind = "invalid";
        if (currentIds.size < 1 || currentIds.size > 4) {
          failureReasons.push("invalid_reentrant_question_count");
        }
        if ([...currentIds].some((questionId) => seenQuestionIds.has(questionId))) {
          failureReasons.push("resolved_question_reuse");
        }
      }
    }

    const next = correlated[index + 1];
    windows.push(Object.freeze({
      inputIndex: invocation.inputIndex,
      callId: invocation.input.callId,
      episodeIndex,
      invocationKind,
      windowStartedAfter: invocation.completedAt,
      windowEndedBefore: next?.startedAt ?? null,
      windowObserved: true,
      exactDuplicate,
      failureReasons: Object.freeze(failureReasons),
    }));
    priorRequests.push(invocation.input.request);
    for (const questionId of currentIds) seenQuestionIds.add(questionId);
  }
  return Object.freeze(windows);
}
