import { isDeepStrictEqual } from "node:util";
import type { FreeContextRequest, FreeContextResult } from "../mcp/contracts.js";
import { validateFreeContextReentry } from "../mcp/eligibility.js";
import type { FreeContextTransportObservation } from "./delivery-observation.js";

export type FreeContextInvocationKind = "initial" | "reentrant" | "invalid" | "unknown";

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

function sameQuestionDefinition(
  current: Readonly<FreeContextRequest>["evidenceQuestions"][number],
  previous: Readonly<FreeContextRequest>["evidenceQuestions"][number],
): boolean {
  return current.role === previous.role &&
    current.question === previous.question && current.required === previous.required &&
    (current.minimumSpans ?? 1) === (previous.minimumSpans ?? 1) &&
    isDeepStrictEqual(current.coverageTargets, previous.coverageTargets);
}

function sameWorkUnit(current: Readonly<FreeContextRequest>, previous: Readonly<FreeContextRequest>): boolean {
  return isDeepStrictEqual(current.workUnit, previous.workUnit);
}

function sameRequest(current: Readonly<FreeContextRequest>, previous: Readonly<FreeContextRequest>): boolean {
  return current.taskText === previous.taskText && sameWorkUnit(current, previous) &&
    isDeepStrictEqual(current.knownRefs, previous.knownRefs) &&
    isDeepStrictEqual(current.reentry, previous.reentry) &&
    current.evidenceQuestions.length === previous.evidenceQuestions.length &&
    current.evidenceQuestions.every((question, index) => {
      const prior = previous.evidenceQuestions[index];
      return prior !== undefined && question.id === prior.id && sameQuestionDefinition(question, prior);
    });
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
  taskCompleteTimestamps: readonly (string | null)[] = [],
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

  const finalInvocation = correlated.at(-1);
  const taskCompletedAt = taskCompleteTimestamps.length === 1 &&
      typeof taskCompleteTimestamps[0] === "string"
    ? taskCompleteTimestamps[0]
    : null;
  const taskCompletedMs = taskCompletedAt === null ? Number.NaN : Date.parse(taskCompletedAt);
  const finalBoundaryObserved = finalInvocation !== undefined && !Number.isNaN(taskCompletedMs) &&
    taskCompletedMs > finalInvocation.completedMs;

  const priorRequests: Readonly<FreeContextRequest>[] = [];
  let episodeIndex = 1;
  const windows: FreeContextInvocationWindow[] = [];
  for (const [index, invocation] of correlated.entries()) {
    const previous = correlated[index - 1];
    const repeatedRequest = priorRequests.some((request) => sameRequest(request, invocation.input.request));
    let invocationKind: FreeContextInvocationKind = index === 0 ? "initial" : "invalid";
    const failureReasons: string[] = [];

    if (!previous && invocation.input.request.reentry) {
      invocationKind = "invalid";
      failureReasons.push("unexpected_initial_reentry");
    } else if (previous) {
      const previousKind = windows[index - 1]?.invocationKind;
      if (previousKind === "invalid" || previousKind === "unknown") {
        invocationKind = "invalid";
        failureReasons.push("prior_invocation_invalid");
      } else {
        const reentry = invocation.input.request.reentry;
        const priorHandoffObserved = reentry !== undefined && correlated.slice(0, index)
          .some((prior) => prior.input.result.handoff && isDeepStrictEqual(prior.input.result.handoff, reentry.priorHandoff));
        const decision = validateFreeContextReentry(invocation.input.request);
        if (!reentry) failureReasons.push("missing_reentry_contract");
        else if (!priorHandoffObserved) failureReasons.push("unknown_prior_handoff");
        else if (!decision.accepted) failureReasons.push("invalid_reentry_contract");
        else {
          invocationKind = "reentrant";
          episodeIndex += 1;
        }
      }
    }

    const next = correlated[index + 1];
    const exactDuplicate = repeatedRequest;
    windows.push(Object.freeze({
      inputIndex: invocation.inputIndex,
      callId: invocation.input.callId,
      episodeIndex,
      invocationKind,
      windowStartedAfter: invocation.completedAt,
      windowEndedBefore: next?.startedAt ?? (finalBoundaryObserved ? taskCompletedAt : null),
      windowObserved: next !== undefined || finalBoundaryObserved,
      exactDuplicate,
      failureReasons: Object.freeze(failureReasons),
    }));
    priorRequests.push(invocation.input.request);
  }
  return Object.freeze(windows);
}
