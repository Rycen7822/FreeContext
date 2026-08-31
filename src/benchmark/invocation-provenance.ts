import { isDeepStrictEqual } from "node:util";
import {
  FreeContextCallerRequestSchema,
  FreeContextResultSchema,
  LegacyFreeContextResultSchema,
  normalizeFreeContextRequest,
} from "../mcp/contracts.js";
import { validateFreeContextRecovery, validateFreeContextReentry } from "../mcp/eligibility.js";
import type { FreeContextRequest, FreeContextResult } from "../mcp/contracts.js";
import type { ObservedMcpCall } from "./delivery-observation.js";
import type { FreeContextInvocationWindow } from "./invocation-window.js";
import type { FreeContextContinuationRelation } from "./invocation-window.js";

export type FreeContextInvocationLayerStatus =
  | "accepted"
  | "rejected"
  | "not_evaluated"
  | "evidence_unavailable";

export interface FreeContextInvocationLayer {
  readonly status: FreeContextInvocationLayerStatus;
  readonly failureReasons: readonly string[];
}

export interface FreeContextInvocationAttempt {
  readonly attemptIndex: number;
  readonly callId: string;
  readonly schema: Readonly<FreeContextInvocationLayer>;
  readonly intrinsic: Readonly<FreeContextInvocationLayer>;
  readonly chain: Readonly<FreeContextInvocationLayer>;
  readonly correlation: Readonly<FreeContextInvocationLayer>;
  readonly committed: Readonly<FreeContextInvocationLayer>;
  readonly providerExecuted: Readonly<FreeContextInvocationLayer>;
  readonly resultContract: "current" | "legacy" | "unavailable";
  readonly resultStatus: FreeContextResult["status"] | null;
  readonly invocationKind: "initial" | "recovery" | "reentrant" | "invalid" | "unknown";
  readonly continuationRelation: FreeContextContinuationRelation | null;
  readonly inheritedAncestryFailures: readonly string[];
}

export interface FreeContextInvocationCounts {
  readonly attemptedCalls: number;
  readonly schemaAcceptedCalls: number;
  readonly intrinsicAcceptedCalls: number;
  readonly chainAcceptedCalls: number;
  readonly committedCalls: number;
  readonly providerExecutedCalls: number;
}

export interface FreeContextInvocationProvenance {
  readonly schemaVersion: "freecontext-invocation-provenance-v3";
  readonly availability: "observed" | "evidence_unavailable";
  readonly counts: Readonly<FreeContextInvocationCounts> | null;
  readonly attempts: readonly Readonly<FreeContextInvocationAttempt>[];
  readonly freshGate: Readonly<FreeContextFreshInvocationGate>;
}

export interface FreeContextFreshInvocationGateFailure {
  readonly code:
    | "evidence_unavailable"
    | "legacy_result_contract"
    | "result_evidence_unavailable"
    | "counts_unavailable"
    | "counts_mismatch"
    | "schema_rejection"
    | "intrinsic_rejection"
    | "chain_rejection"
    | "inherited_ancestry_failure"
    | "correlation_mismatch"
    | "impossible_commit_state"
    | "impossible_provider_state"
    | "no_committed_provider_call";
  readonly attemptIndex: number | null;
  readonly callId: string | null;
}

export interface FreeContextFreshInvocationGate {
  readonly schemaVersion: "freecontext-fresh-invocation-gate-v2";
  readonly availability: FreeContextInvocationProvenance["availability"];
  readonly accepted: boolean;
  readonly failures: readonly Readonly<FreeContextFreshInvocationGateFailure>[];
}

export interface FreeContextHistoricalInvocationProvenanceV1 {
  readonly schemaVersion: "freecontext-invocation-provenance-v1-adapter";
  readonly sourceSchemaVersion: "freecontext-invocation-provenance-v1";
  readonly availability: "evidence_unavailable";
  readonly legacyCounts: Readonly<{
    readonly attemptedCalls: number;
    readonly schemaAcceptedCalls: number;
    readonly semanticallyAcceptedCalls: number;
    readonly committedCalls: number;
    readonly providerExecutedCalls: number;
  }> | null;
  readonly attempts: readonly Readonly<FreeContextInvocationAttempt>[];
}

type InvocationProvenanceSnapshot = Readonly<Pick<FreeContextInvocationProvenance, "availability" | "counts" | "attempts">>;

type SessionEntry = Readonly<{
  readonly callId: string;
  readonly request: FreeContextRequest;
  readonly result: FreeContextResult;
  readonly capture: Readonly<{ readonly primary: Readonly<{ readonly metrics: Readonly<{ readonly providerAttempts: number }> }> }> | null;
}>;

function layer(status: FreeContextInvocationLayerStatus, failureReasons: readonly string[] = []): Readonly<FreeContextInvocationLayer> {
  return Object.freeze({ status, failureReasons: Object.freeze([...new Set(failureReasons)]) });
}

function safeSchemaReasons(error: { issues: readonly Readonly<{ path: readonly PropertyKey[]; code: string }>[]}): readonly string[] {
  const reasons = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.map((part) => typeof part === "number" ? `[${part}]` : String(part)).join(".") || "request";
    return `schema_rejection:${path}:${issue.code}`;
  });
  return Object.freeze([...new Set(reasons)]);
}

function resultFromObservedCall(call: Readonly<ObservedMcpCall>): Readonly<FreeContextResult> | null {
  const parsed = FreeContextResultSchema.safeParse(call.structuredContent);
  if (parsed.success) return parsed.data;
  const legacy = LegacyFreeContextResultSchema.safeParse(call.structuredContent);
  return legacy.success ? legacy.data as unknown as FreeContextResult : null;
}

function observedResultContract(call: Readonly<ObservedMcpCall>): "current" | "legacy" | "unavailable" {
  if (call.structuredContent === null || call.structuredContent === undefined) return "unavailable";
  if (FreeContextResultSchema.safeParse(call.structuredContent).success) return "current";
  if (LegacyFreeContextResultSchema.safeParse(call.structuredContent).success) return "legacy";
  return "unavailable";
}

function comparableCallId(callId: string): string {
  return callId.replace(/^item_/u, "");
}

function gateFailure(
  code: FreeContextFreshInvocationGateFailure["code"],
  attempt: Readonly<FreeContextInvocationAttempt> | null = null,
): Readonly<FreeContextFreshInvocationGateFailure> {
  return Object.freeze({ code, attemptIndex: attempt?.attemptIndex ?? null, callId: attempt?.callId ?? null });
}

function acceptedCount(
  attempts: readonly Readonly<FreeContextInvocationAttempt>[],
  selector: (attempt: Readonly<FreeContextInvocationAttempt>) => Readonly<FreeContextInvocationLayer>,
): number {
  return attempts.filter((attempt) => selector(attempt).status === "accepted").length;
}

export function evaluateFreshInvocationGate(
  provenance: InvocationProvenanceSnapshot,
): Readonly<FreeContextFreshInvocationGate> {
  const failures: FreeContextFreshInvocationGateFailure[] = [];
  const add = (failure: Readonly<FreeContextFreshInvocationGateFailure>): void => {
    if (!failures.some((candidate) => candidate.code === failure.code && candidate.attemptIndex === failure.attemptIndex && candidate.callId === failure.callId)) {
      failures.push(failure);
    }
  };
  if (provenance.availability !== "observed") add(gateFailure("evidence_unavailable"));
  if (!provenance.counts) {
    add(gateFailure("counts_unavailable"));
  } else {
    const expectedCounts: FreeContextInvocationCounts = {
      attemptedCalls: provenance.attempts.length,
      schemaAcceptedCalls: acceptedCount(provenance.attempts, (attempt) => attempt.schema),
      intrinsicAcceptedCalls: acceptedCount(provenance.attempts, (attempt) => attempt.intrinsic),
      chainAcceptedCalls: acceptedCount(provenance.attempts, (attempt) => attempt.chain),
      committedCalls: acceptedCount(provenance.attempts, (attempt) => attempt.committed),
      providerExecutedCalls: acceptedCount(provenance.attempts, (attempt) => attempt.providerExecuted),
    };
    if (!isDeepStrictEqual(provenance.counts, expectedCounts)) add(gateFailure("counts_mismatch"));
  }
  for (const attempt of provenance.attempts) {
    for (const candidate of [attempt.schema, attempt.intrinsic, attempt.chain, attempt.correlation, attempt.committed, attempt.providerExecuted]) {
      if (candidate.status === "evidence_unavailable") add(gateFailure("evidence_unavailable", attempt));
    }
    if (attempt.resultContract === "legacy") add(gateFailure("legacy_result_contract", attempt));
    if (attempt.resultContract === "unavailable" && attempt.schema.status === "accepted") {
      add(gateFailure("result_evidence_unavailable", attempt));
    }
    if (attempt.schema.status === "rejected") add(gateFailure("schema_rejection", attempt));
    if (attempt.intrinsic.status === "rejected") add(gateFailure("intrinsic_rejection", attempt));
    if (attempt.chain.status === "rejected") add(gateFailure("chain_rejection", attempt));
    if (attempt.inheritedAncestryFailures.length > 0) add(gateFailure("inherited_ancestry_failure", attempt));
    if (attempt.correlation.status === "rejected") add(gateFailure("correlation_mismatch", attempt));
    if (attempt.committed.status === "accepted" &&
        (attempt.schema.status === "rejected" || attempt.intrinsic.status === "rejected")) {
      add(gateFailure("impossible_commit_state", attempt));
    }
    if (attempt.providerExecuted.status === "accepted" && attempt.committed.status !== "accepted") {
      add(gateFailure("impossible_provider_state", attempt));
    }
    if (attempt.committed.status === "accepted" && attempt.providerExecuted.status === "evidence_unavailable") {
      add(gateFailure("evidence_unavailable", attempt));
    }
  }
  if (provenance.availability === "observed" && provenance.counts &&
      (provenance.counts.committedCalls < 1 || provenance.counts.providerExecutedCalls < 1)) {
    add(gateFailure("no_committed_provider_call"));
  }
  return Object.freeze({
    schemaVersion: "freecontext-fresh-invocation-gate-v2",
    availability: provenance.availability,
    accepted: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

function inheritedFailures(attempts: readonly Readonly<FreeContextInvocationAttempt>[]): readonly string[] {
  return Object.freeze(attempts.flatMap((attempt) => [
    ...(attempt.schema.status === "rejected" ? [`attempt_${attempt.attemptIndex}:schema_rejected`] : []),
    ...(attempt.intrinsic.status === "rejected" ? [`attempt_${attempt.attemptIndex}:intrinsic_rejected`] : []),
    ...(attempt.chain.status === "rejected" ? [`attempt_${attempt.attemptIndex}:chain_rejected`] : []),
    ...attempt.inheritedAncestryFailures,
  ]));
}

function previousHandoffObserved(
  calls: readonly Readonly<ObservedMcpCall>[],
  sessionByCallId: ReadonlyMap<string, SessionEntry>,
  index: number,
  request: Readonly<FreeContextRequest>,
): boolean {
  return request.reentry !== undefined && calls.slice(0, index)
    .map((call) => {
      const observed = resultFromObservedCall(call);
      const session = sessionByCallId.get(call.callId) ?? sessionByCallId.get(comparableCallId(call.callId));
      return session?.result.handoff ?? observed?.handoff;
    })
    .some((handoff) => handoff !== null && handoff !== undefined && isDeepStrictEqual(handoff, request.reentry?.priorHandoff));
}

function currentResultContract(
  session: SessionEntry | undefined,
  call: Readonly<ObservedMcpCall>,
): "current" | "legacy" | "unavailable" {
  return session
    ? (FreeContextResultSchema.safeParse(session.result).success ? "current" : "legacy")
    : observedResultContract(call);
}

function providerLayer(session: SessionEntry | undefined): Readonly<FreeContextInvocationLayer> {
  if (!session) return layer("not_evaluated");
  const attempts = session.capture?.primary.metrics.providerAttempts;
  if (typeof attempts !== "number") return layer("evidence_unavailable", ["provider_attempt_count_unavailable"]);
  return attempts > 0 ? layer("accepted") : layer("rejected", ["provider_not_executed"]);
}

export function collectInvocationProvenance({
  calls,
  sessions,
  windows = [],
}: Readonly<{
  readonly calls: readonly Readonly<ObservedMcpCall>[];
  readonly sessions: readonly Readonly<SessionEntry>[];
  readonly windows?: readonly Readonly<FreeContextInvocationWindow>[];
}>): Readonly<FreeContextInvocationProvenance> {
  const directCalls = calls.filter((call) => call.source === "direct_mcp");
  if (directCalls.length === 0) {
    const unavailable = {
      schemaVersion: "freecontext-invocation-provenance-v3" as const,
      availability: "evidence_unavailable" as const,
      counts: null,
      attempts: Object.freeze([]) as readonly Readonly<FreeContextInvocationAttempt>[],
    };
    return Object.freeze({ ...unavailable, freshGate: evaluateFreshInvocationGate(unavailable) });
  }
  const sessionByCallId = new Map(sessions.flatMap((session) => [
    [session.callId, session] as const,
    [comparableCallId(session.callId), session] as const,
    [session.result.sessionId, session] as const,
  ]));
  const windowByCallId = new Map(windows.flatMap((window) => [
    [window.callId, window] as const,
    [comparableCallId(window.callId), window] as const,
  ]));
  const attempts: FreeContextInvocationAttempt[] = [];
  for (const [index, call] of directCalls.entries()) {
    const parsed = FreeContextCallerRequestSchema.safeParse(call.arguments);
    const observedSessionId = resultFromObservedCall(call)?.sessionId;
    const session = (observedSessionId ? sessionByCallId.get(observedSessionId) : undefined)
      ?? sessionByCallId.get(call.callId) ?? sessionByCallId.get(comparableCallId(call.callId));
    const result = session?.result ?? resultFromObservedCall(call);
    const window = (session ? windowByCallId.get(session.callId) : undefined)
      ?? windowByCallId.get(call.callId) ?? windowByCallId.get(comparableCallId(call.callId));
    const resultContract = currentResultContract(session, call);
    const correlation = !session
      ? layer("not_evaluated")
      : comparableCallId(session.callId) === comparableCallId(call.callId)
        ? layer("accepted")
        : layer("rejected", ["call_session_correlation_mismatch"]);
    const committed = session ? layer("accepted") : layer("not_evaluated");
    const providerExecuted = providerLayer(session);
    const resultStatus = result?.status ?? null;
    const inherited = inheritedFailures(attempts);
    let schema = layer("rejected");
    let intrinsic = layer("not_evaluated");
    let chain = layer("not_evaluated");
    let invocationKind: FreeContextInvocationAttempt["invocationKind"] = "invalid";
    let continuationRelation: FreeContextContinuationRelation | null = null;
    let request: FreeContextRequest | null = null;

    if (!parsed.success) {
      schema = layer("rejected", safeSchemaReasons(parsed.error));
    } else {
      schema = layer("accepted");
      try {
        request = normalizeFreeContextRequest(parsed.data);
        if (request.recovery) {
          const decision = validateFreeContextRecovery(request);
          intrinsic = decision.accepted ? layer("accepted") : layer("rejected", [decision.reason]);
        } else if (request.reentry) {
          const decision = validateFreeContextReentry(request);
          intrinsic = decision.accepted ? layer("accepted") : layer("rejected", [decision.reason]);
        } else {
          intrinsic = layer("accepted");
        }
      } catch {
        intrinsic = layer("rejected", ["normalization_rejected"]);
      }
      if (intrinsic.status === "accepted" && request) {
        const chainReasons: string[] = [];
        const previousCall = directCalls[index - 1];
        const previousSession = previousCall
          ? sessionByCallId.get(previousCall.callId) ?? sessionByCallId.get(comparableCallId(previousCall.callId))
          : undefined;
        const previousResult = previousSession?.result ?? (previousCall ? resultFromObservedCall(previousCall) : null);
        if (index === 0 || (!previousResult && attempts.every((attempt) => attempt.chain.status !== "accepted"))) {
          if (request.reentry || request.recovery) chainReasons.push("unexpected_initial_continuation");
          else invocationKind = "initial";
        } else if (request.recovery) {
          const recovery = request.recovery;
          const recoveryUsed = directCalls.slice(0, index).some((prior) => {
            const priorParsed = FreeContextCallerRequestSchema.safeParse(prior.arguments);
            return priorParsed.success && priorParsed.data.recovery !== undefined;
          });
          if (!previousResult || previousResult.status !== "not_found" || previousResult.handoff) {
            chainReasons.push("recovery_requires_prior_not_found_without_handoff");
          } else if (recoveryUsed) {
            chainReasons.push("recovery_already_used");
          } else if (recovery.priorSessionId !== previousResult.sessionId) {
            chainReasons.push("recovery_prior_session_mismatch");
          } else {
            invocationKind = "recovery";
          }
        } else if (request.reentry) {
          if (!previousHandoffObserved(directCalls, sessionByCallId, index, request)) chainReasons.push("unknown_prior_handoff");
          else {
            invocationKind = "reentrant";
            continuationRelation = request.reentry.blockingGap.derivation.kind;
          }
        } else {
          if (previousResult?.status === "not_found" && !previousResult.handoff) chainReasons.push("missing_not_found_recovery");
          else chainReasons.push("missing_reentry_contract");
        }
        if (window?.failureReasons.length) chainReasons.push(...window.failureReasons);
        chain = chainReasons.length === 0 ? layer("accepted") : layer("rejected", chainReasons);
      }
    }
    if (window) {
      invocationKind = window.invocationKind;
      continuationRelation = window.continuationRelation;
    }
    const windowInherited = window?.chainFailureReasons ?? [];
    const allInherited = Object.freeze([...new Set([...inherited, ...windowInherited])]);
    attempts.push(Object.freeze({
      attemptIndex: index + 1,
      callId: call.callId,
      schema,
      intrinsic,
      chain,
      correlation,
      committed,
      providerExecuted,
      resultContract,
      resultStatus,
      invocationKind,
      continuationRelation,
      inheritedAncestryFailures: allInherited,
    }));
  }
  const counts = Object.freeze({
    attemptedCalls: attempts.length,
    schemaAcceptedCalls: acceptedCount(attempts, (attempt) => attempt.schema),
    intrinsicAcceptedCalls: acceptedCount(attempts, (attempt) => attempt.intrinsic),
    chainAcceptedCalls: acceptedCount(attempts, (attempt) => attempt.chain),
    committedCalls: acceptedCount(attempts, (attempt) => attempt.committed),
    providerExecutedCalls: acceptedCount(attempts, (attempt) => attempt.providerExecuted),
  });
  const provenance = {
    schemaVersion: "freecontext-invocation-provenance-v3" as const,
    availability: "observed" as const,
    counts,
    attempts: Object.freeze(attempts),
  };
  return Object.freeze({ ...provenance, freshGate: evaluateFreshInvocationGate(provenance) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function historicalBooleanLayer(value: unknown, label: string): Readonly<FreeContextInvocationLayer> {
  if (typeof value !== "boolean") return layer("evidence_unavailable", [`v1_${label}_unavailable`]);
  return value ? layer("accepted") : layer("rejected", [`v1_${label}_rejected`]);
}

function historicalAmbiguousLayer(): Readonly<FreeContextInvocationLayer> {
  return layer("evidence_unavailable", ["v1_semantic_layer_ambiguous"]);
}

function historicalCounts(value: unknown): FreeContextHistoricalInvocationProvenanceV1["legacyCounts"] {
  if (!isRecord(value)) return null;
  const keys = ["attemptedCalls", "schemaAcceptedCalls", "semanticallyAcceptedCalls", "committedCalls", "providerExecutedCalls"] as const;
  if (!keys.every((key) => typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0)) return null;
  return Object.freeze({
    attemptedCalls: value.attemptedCalls as number,
    schemaAcceptedCalls: value.schemaAcceptedCalls as number,
    semanticallyAcceptedCalls: value.semanticallyAcceptedCalls as number,
    committedCalls: value.committedCalls as number,
    providerExecutedCalls: value.providerExecutedCalls as number,
  });
}

export function adaptHistoricalInvocationProvenanceV1(
  input: unknown,
): Readonly<FreeContextHistoricalInvocationProvenanceV1> {
  if (!isRecord(input) || input.schemaVersion !== "freecontext-invocation-provenance-v1") {
    throw new TypeError("Expected freecontext-invocation-provenance-v1 historical input.");
  }
  const rawAttempts = Array.isArray(input.attempts) ? input.attempts : [];
  const attempts = rawAttempts.map((raw, index) => {
    const value = isRecord(raw) ? raw : {};
    const chainFailureReasons = Array.isArray(value.chainFailureReasons)
      ? value.chainFailureReasons.filter((reason): reason is string => typeof reason === "string")
      : [];
    const invocationKind = value.invocationKind === "initial" || value.invocationKind === "recovery" ||
      value.invocationKind === "reentrant" || value.invocationKind === "invalid" || value.invocationKind === "unknown"
      ? value.invocationKind
      : "unknown";
    const resultContract = value.resultContract === "current" || value.resultContract === "legacy"
      ? value.resultContract
      : "unavailable";
    return Object.freeze({
      attemptIndex: typeof value.attemptIndex === "number" && Number.isInteger(value.attemptIndex) ? value.attemptIndex : index + 1,
      callId: typeof value.callId === "string" ? value.callId : `historical_unknown_${index + 1}`,
      schema: historicalBooleanLayer(value.schemaAccepted, "schema"),
      intrinsic: historicalAmbiguousLayer(),
      chain: historicalAmbiguousLayer(),
      correlation: historicalAmbiguousLayer(),
      committed: historicalBooleanLayer(value.committed, "committed"),
      providerExecuted: historicalBooleanLayer(value.providerExecuted, "provider_executed"),
      resultContract,
      resultStatus: typeof value.resultStatus === "string" ? value.resultStatus as FreeContextResult["status"] : null,
      invocationKind,
      continuationRelation: null,
      inheritedAncestryFailures: Object.freeze([...chainFailureReasons]),
    });
  });
  return Object.freeze({
    schemaVersion: "freecontext-invocation-provenance-v1-adapter",
    sourceSchemaVersion: "freecontext-invocation-provenance-v1",
    availability: "evidence_unavailable",
    legacyCounts: historicalCounts(input.counts),
    attempts: Object.freeze(attempts),
  });
}
