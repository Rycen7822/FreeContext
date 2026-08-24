import type { FreeContextResult } from "../mcp/contracts.js";
import { isRecord } from "./delivery-observation.js";
import type { FreeContextInvocationKind } from "./invocation-window.js";

export type ParentRepositoryActionKind = "read" | "search" | "edit" | "check" | "other";
export type FreeContextConsumptionPhase = "pre_edit_handoff" | "post_edit_diagnostic" | "reentry";

export interface FreeContextConsumptionPhaseSummary {
  readonly phase: FreeContextConsumptionPhase;
  readonly actionCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
}

export interface ParentRepositoryActionEvent {
  readonly schemaVersion: "freecontext-parent-action-v1";
  readonly taskId: string;
  readonly callId: string;
  readonly repetition: string;
  readonly sequence: number;
  readonly observationBatchId: string | null;
  readonly observationBatchConcurrent: boolean;
  readonly action: Readonly<{
    readonly kind: ParentRepositoryActionKind;
    readonly path: string | null;
    readonly startLine: number | null;
    readonly endLine: number | null;
    readonly broad: boolean;
    readonly gapQuestionIds: readonly string[];
    readonly externalSource?: true;
  }>;
}

export interface FreeContextConsumptionAudit {
  readonly schemaVersion: "freecontext-consumption-audit-v6";
  readonly observationSource: "explicit_host_event" | "completed_codex_tool_call";
  readonly taskId: string;
  readonly callId: string;
  readonly repetition: string;
  readonly episodeIndex: number;
  readonly invocationKind: FreeContextInvocationKind;
  readonly windowStartedAfter: string | null;
  readonly windowEndedBefore: string | null;
  readonly windowObserved: boolean;
  readonly actionCount: number;
  readonly inlineEvidenceCount: number;
  readonly inlineEvidenceProvenanceComplete: boolean;
  readonly nativeEvidenceRereadCount: number;
  readonly firstRepositoryActionKind: ParentRepositoryActionKind | null;
  readonly preEditNativeExplorationCount: number;
  readonly postEditNativeExplorationCount: number;
  readonly searchCount: number;
  readonly searchBatchCount: number;
  readonly broadSearchCount: number;
  readonly distinctNonEvidenceReadPaths: number;
  readonly editCount: number;
  readonly checkCount: number;
  readonly followedByReentrant: boolean;
  readonly editOrCheckObserved: boolean;
  readonly exactDuplicate: boolean;
  readonly externalSourceCommandCount: number;
  readonly phases: readonly Readonly<FreeContextConsumptionPhaseSummary>[];
  readonly failureReasons: readonly string[];
}

export interface FreeContextConsumptionAuditContext {
  readonly observationSource: FreeContextConsumptionAudit["observationSource"];
  readonly taskId: string;
  readonly callId: string;
  readonly repetition: string;
  readonly episodeIndex: number;
  readonly invocationKind: FreeContextInvocationKind;
  readonly windowStartedAfter: string | null;
  readonly windowEndedBefore: string | null;
  readonly windowObserved: boolean;
  readonly exactDuplicate: boolean;
  readonly windowFailureReasons?: readonly string[];
  readonly followedByReentrant?: boolean;
  readonly reentryOrigin?: "evidence_consumption" | "edit" | "check" | null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseActionEvent(value: unknown): Readonly<ParentRepositoryActionEvent> | null {
  if (!isRecord(value) || value.schemaVersion !== "freecontext-parent-action-v1") return null;
  if (typeof value.taskId !== "string" || !value.taskId || typeof value.callId !== "string" || !value.callId ||
      typeof value.repetition !== "string" || !value.repetition || !isRecord(value.action)) {
    throw new Error("Invalid freecontext-parent-action-v1 identity.");
  }
  const sequence = positiveInteger(value.sequence);
  const observationBatchId = value.observationBatchId ?? null;
  const observationBatchConcurrent = value.observationBatchConcurrent ?? false;
  const kind = value.action.kind;
  const path = value.action.path;
  const startLine = value.action.startLine;
  const endLine = value.action.endLine;
  const broad = value.action.broad;
  const gapQuestionIds = value.action.gapQuestionIds;
  const externalSource = value.action.externalSource ?? false;
  if (sequence === null || !(observationBatchId === null ||
      (typeof observationBatchId === "string" && observationBatchId.length > 0)) ||
      typeof observationBatchConcurrent !== "boolean" || (observationBatchConcurrent && observationBatchId === null) ||
      !["read", "search", "edit", "check", "other"].includes(String(kind)) ||
      !(path === null || typeof path === "string") ||
      !(startLine === null || positiveInteger(startLine) !== null) ||
      !(endLine === null || positiveInteger(endLine) !== null) || typeof broad !== "boolean" ||
      !Array.isArray(gapQuestionIds) || gapQuestionIds.some((item) => typeof item !== "string" || !item) ||
      typeof externalSource !== "boolean") {
    throw new Error("Invalid freecontext-parent-action-v1 action.");
  }
  if ((startLine === null) !== (endLine === null) ||
      (typeof startLine === "number" && typeof endLine === "number" && endLine < startLine)) {
    throw new Error("Invalid freecontext-parent-action-v1 range.");
  }
  return Object.freeze({
    schemaVersion: "freecontext-parent-action-v1",
    taskId: value.taskId,
    callId: value.callId,
    repetition: value.repetition,
    sequence,
    observationBatchId,
    observationBatchConcurrent,
    action: Object.freeze({
      kind: kind as ParentRepositoryActionKind,
      path: path as string | null,
      startLine: startLine as number | null,
      endLine: endLine as number | null,
      broad,
      gapQuestionIds: Object.freeze([...(gapQuestionIds as string[])]),
      ...(externalSource ? { externalSource: true as const } : {}),
    }),
  });
}

export function collectParentRepositoryActions(
  rawJsonl: string,
  callId: string,
): readonly Readonly<ParentRepositoryActionEvent>[] {
  const actions: ParentRepositoryActionEvent[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (!isRecord(value) || depth > 5) return;
    const event = parseActionEvent(value);
    if (event?.callId === callId) actions.push(event);
    if (isRecord(value.payload)) visit(value.payload, depth + 1);
    if (isRecord(value.event)) visit(value.event, depth + 1);
  };
  for (const line of rawJsonl.split("\n")) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line)); } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  actions.sort((left, right) => left.sequence - right.sequence);
  if (new Set(actions.map(({ sequence }) => sequence)).size !== actions.length) {
    throw new Error(`Duplicate parent-action sequence for callId ${callId}.`);
  }
  return Object.freeze(actions);
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function hitsEvidenceItem(
  action: ParentRepositoryActionEvent["action"],
  evidence: FreeContextResult["evidence"][number],
): boolean {
  if (action.kind !== "read" || action.path === null || action.startLine === null || action.endLine === null) return false;
  const actionPath = normalizePath(action.path);
  return normalizePath(evidence.path) === actionPath &&
    action.startLine <= evidence.endLine && action.endLine >= evidence.startLine;
}

function hitsAnyEvidence(
  action: ParentRepositoryActionEvent["action"],
  result: Readonly<FreeContextResult>,
): boolean {
  return result.evidence.some((evidence) => hitsEvidenceItem(action, evidence));
}

function isEvidencePath(
  action: ParentRepositoryActionEvent["action"],
  result: Readonly<FreeContextResult>,
): boolean {
  if (action.kind !== "read" || action.path === null) return false;
  const actionPath = normalizePath(action.path);
  return result.evidence.some((evidence) => normalizePath(evidence.path) === actionPath);
}

function isNativeExploration(
  action: ParentRepositoryActionEvent["action"],
  result: Readonly<FreeContextResult>,
): boolean {
  return action.kind === "search" || (action.kind === "read" && !hitsAnyEvidence(action, result));
}

function batchKey(event: Readonly<ParentRepositoryActionEvent>): string {
  return event.observationBatchId ?? `sequence:${event.sequence}`;
}

export function analyzeFreeContextConsumption(
  result: Readonly<FreeContextResult>,
  actions: readonly Readonly<ParentRepositoryActionEvent>[],
  context: Readonly<FreeContextConsumptionAuditContext>,
): Readonly<FreeContextConsumptionAudit> {
  if (!context.windowObserved && actions.length > 0) {
    throw new Error(`Unobserved window ${context.callId} cannot contain attributed actions.`);
  }
  for (const event of actions) {
    if (event.taskId !== context.taskId || event.callId !== context.callId ||
        event.repetition !== context.repetition) {
      throw new Error(`Mixed parent-action identity for callId ${context.callId}.`);
    }
  }
  if (new Set(actions.map(({ sequence }) => sequence)).size !== actions.length) {
    throw new Error(`Duplicate parent-action sequence for callId ${context.callId}.`);
  }
  const tracksEvidenceHandoff = result.status === "ready" || result.status === "partial";
  const inlineEvidenceCount = result.evidence.filter(({ excerpt }) =>
    typeof excerpt === "string" && excerpt.trim().length > 0).length;
  const inlineEvidenceProvenanceComplete = !tracksEvidenceHandoff ||
    (result.evidence.length > 0 && inlineEvidenceCount === result.evidence.length);
  const nativeEvidenceRereadCount = actions.filter(({ action }) => hitsAnyEvidence(action, result)).length;
  const firstEditAt = actions.findIndex(({ action }) => action.kind === "edit" || action.kind === "check");
  const preEditActions = firstEditAt < 0 ? actions : actions.slice(0, firstEditAt);
  const postEditActions = firstEditAt < 0 ? [] : actions.slice(firstEditAt);
  const preEditNativeExplorationCount = actions.filter(({ action }, index) =>
    (firstEditAt < 0 || index < firstEditAt) && isNativeExploration(action, result)).length;
  const postEditNativeExplorationCount = firstEditAt < 0 ? 0 : actions.filter(({ action }, index) =>
    index > firstEditAt && isNativeExploration(action, result)).length;
  const searches = actions.filter(({ action }) => action.kind === "search");
  const broadSearchCount = searches.filter(({ action }) => action.broad).length;
  const searchBatchCount = new Set(searches.map(batchKey)).size;
  const edits = actions.filter(({ action }) => action.kind === "edit");
  const checks = actions.filter(({ action }) => action.kind === "check");
  const followedByReentrant = context.followedByReentrant === true;
  const editOrCheckObserved = edits.length > 0 || checks.length > 0;
  const editedPaths = new Set(edits.flatMap(({ action }) => action.path === null ? [] : [normalizePath(action.path)]));
  const distinctNonEvidenceReadPaths = new Set(actions.flatMap(({ action }) =>
    action.kind === "read" && action.path !== null && !hitsAnyEvidence(action, result) &&
      !editedPaths.has(normalizePath(action.path))
      ? [normalizePath(action.path)]
      : [])).size;
  const preDiscoveredReadPaths = new Set<string>();
  let preAdjacentEvidenceReadCount = 0;
  for (const { action } of preEditActions) {
    if (action.kind !== "read" || action.path === null || hitsAnyEvidence(action, result)) continue;
    const normalized = normalizePath(action.path);
    if (isEvidencePath(action, result)) preAdjacentEvidenceReadCount += 1;
    else preDiscoveredReadPaths.add(normalized);
  }
  const failures = [...(context.windowFailureReasons ?? [])];
  const addReason = (reason: string): void => {
    if (!failures.includes(reason)) failures.push(reason);
  };
  if (!context.windowObserved) addReason("unobserved_window");
  if (context.exactDuplicate) addReason("exact_request_replay");
  if (!inlineEvidenceProvenanceComplete) addReason("inline_evidence_provenance_missing");
  const externalSourceCommandCount = actions.filter(({ action }) => action.externalSource === true).length;
  if (externalSourceCommandCount > 0) addReason("task_solution_external_source");
  if (followedByReentrant && !editOrCheckObserved && context.reentryOrigin !== "evidence_consumption") {
    addReason("reentry_without_typed_origin");
  }
  const preSearches = preEditActions.filter(({ action }) => action.kind === "search");
  const preBroadSearchCount = preSearches.filter(({ action }) => action.broad).length;
  const preSearchExceeded = result.nextAction.kind === "consume_evidence"
    ? preSearches.length > 0
    : preSearches.length > 1;
  const preReadExceeded = result.nextAction.kind === "consume_evidence"
    ? preAdjacentEvidenceReadCount > 1 || preDiscoveredReadPaths.size > 0
    : preDiscoveredReadPaths.size > 1;
  if (preBroadSearchCount > 0 || preSearchExceeded || preReadExceeded) addReason("pre_edit_handoff_scope_exceeded");
  const postSearches = postEditActions.filter(({ action }) => action.kind === "search");
  const postDiagnosticPaths = new Set(postEditActions.flatMap(({ action }) =>
    action.kind === "read" && action.path !== null && !hitsAnyEvidence(action, result)
      && !editedPaths.has(normalizePath(action.path)) ? [normalizePath(action.path)] : []));
  const postSearchBatches = new Set(postSearches.map(batchKey)).size;
  if (postSearches.some(({ action }) => action.broad) || postSearchBatches > 1 || postDiagnosticPaths.size > 1) {
    addReason("post_edit_cross_file_exploration_without_fc");
  }
  const phaseSummary = (
    phase: FreeContextConsumptionPhase,
    phaseActions: readonly Readonly<ParentRepositoryActionEvent>[],
  ): Readonly<FreeContextConsumptionPhaseSummary> => Object.freeze({
    phase,
    actionCount: phaseActions.length,
    firstSequence: phaseActions[0]?.sequence ?? null,
    lastSequence: phaseActions.at(-1)?.sequence ?? null,
  });
  const phases = [phaseSummary("pre_edit_handoff", preEditActions)];
  if (postEditActions.length > 0) phases.push(phaseSummary("post_edit_diagnostic", postEditActions));
  if (followedByReentrant) phases.push(phaseSummary("reentry", []));
  return Object.freeze({
    schemaVersion: "freecontext-consumption-audit-v6",
    observationSource: context.observationSource,
    taskId: context.taskId,
    callId: context.callId,
    repetition: context.repetition,
    episodeIndex: context.episodeIndex,
    invocationKind: context.invocationKind,
    windowStartedAfter: context.windowStartedAfter,
    windowEndedBefore: context.windowEndedBefore,
    windowObserved: context.windowObserved,
    actionCount: actions.length,
    inlineEvidenceCount,
    inlineEvidenceProvenanceComplete,
    nativeEvidenceRereadCount,
    firstRepositoryActionKind: actions[0]?.action.kind ?? null,
    preEditNativeExplorationCount,
    postEditNativeExplorationCount,
    searchCount: searches.length,
    searchBatchCount,
    broadSearchCount,
    distinctNonEvidenceReadPaths,
    editCount: edits.length,
    checkCount: checks.length,
    followedByReentrant,
    editOrCheckObserved,
    exactDuplicate: context.exactDuplicate,
    externalSourceCommandCount,
    phases: Object.freeze(phases),
    failureReasons: Object.freeze(failures),
  });
}
