import type { FreeContextResult } from "../mcp/contracts.js";
import { isRecord } from "./delivery-observation.js";
import type { FreeContextInvocationKind } from "./invocation-window.js";

export type ParentRepositoryActionKind = "read" | "search" | "edit" | "other";

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
  }>;
}

export interface FreeContextConsumptionAudit {
  readonly schemaVersion: "freecontext-consumption-audit-v3";
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
  readonly firstRepositoryBatchSize: number;
  readonly firstRepositoryBatchConcurrent: boolean;
  readonly firstRepositoryBatchReadOnly: boolean;
  readonly firstRepositoryBatchEvidenceOnly: boolean;
  readonly allEvidenceConsumed: boolean;
  readonly consumedEvidenceCount: number;
  readonly searchCount: number;
  readonly searchBatchCount: number;
  readonly broadSearchCount: number;
  readonly distinctNonEvidenceReadPaths: number;
  readonly editCount: number;
  readonly exactDuplicate: boolean;
  readonly escapedExplorationReasons: readonly string[];
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
  readonly followedByGapFollowup?: boolean;
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
  if (sequence === null || !(observationBatchId === null ||
      (typeof observationBatchId === "string" && observationBatchId.length > 0)) ||
      typeof observationBatchConcurrent !== "boolean" || (observationBatchConcurrent && observationBatchId === null) ||
      !["read", "search", "edit", "other"].includes(String(kind)) ||
      !(path === null || typeof path === "string") ||
      !(startLine === null || positiveInteger(startLine) !== null) ||
      !(endLine === null || positiveInteger(endLine) !== null) || typeof broad !== "boolean" ||
      !Array.isArray(gapQuestionIds) || gapQuestionIds.some((item) => typeof item !== "string" || !item)) {
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
  const first = actions[0];
  const firstRepositoryBatch = first === undefined ? [] : actions.filter((event) => batchKey(event) === batchKey(first));
  const consumedEvidenceCount = result.evidence.filter((evidence) =>
    firstRepositoryBatch.some(({ action }) => hitsEvidenceItem(action, evidence))).length;
  const firstRepositoryBatchReadOnly = firstRepositoryBatch.length > 0 &&
    firstRepositoryBatch.every(({ action }) => action.kind === "read");
  const firstRepositoryBatchEvidenceOnly = firstRepositoryBatchReadOnly &&
    firstRepositoryBatch.every(({ action }) => hitsAnyEvidence(action, result));
  const allEvidenceConsumed = result.evidence.length > 0 && consumedEvidenceCount === result.evidence.length;
  const searches = actions.filter(({ action }) => action.kind === "search");
  const broadSearchCount = searches.filter(({ action }) => action.broad).length;
  const edits = actions.filter(({ action }) => action.kind === "edit");
  const editedPaths = new Set(edits.flatMap(({ action }) => action.path === null ? [] : [normalizePath(action.path)]));
  const distinctNonEvidenceReadPaths = new Set(actions.flatMap(({ action }) =>
    action.kind === "read" && action.path !== null && !hitsAnyEvidence(action, result) &&
      !editedPaths.has(normalizePath(action.path))
      ? [normalizePath(action.path)]
      : [])).size;
  const escaped = [...(context.windowFailureReasons ?? [])];
  const addReason = (reason: string): void => {
    if (!escaped.includes(reason)) escaped.push(reason);
  };
  if (!context.windowObserved) addReason("unobserved_window");
  if (context.exactDuplicate) addReason("exact_request_replay");
  const searchBatchCount = new Set(searches.map(batchKey)).size;
  if (context.windowObserved) {
    if ((result.status === "ready" || result.status === "partial") && !firstRepositoryBatchEvidenceOnly) {
      addReason("first_batch_not_evidence_only");
    }
    if ((result.status === "ready" || result.status === "partial") && !allEvidenceConsumed) {
      addReason("evidence_not_consumed_in_first_batch");
    }
    if (broadSearchCount > 0) addReason("broad_search");
    if (searchBatchCount > 1) addReason("second_search_batch");
    if (distinctNonEvidenceReadPaths >= 3) addReason("third_non_evidence_read_path");
    if (context.followedByGapFollowup && actions.length > firstRepositoryBatch.length) {
      addReason("action_before_gap_followup");
    }
  }
  return Object.freeze({
    schemaVersion: "freecontext-consumption-audit-v3",
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
    firstRepositoryBatchSize: firstRepositoryBatch.length,
    firstRepositoryBatchConcurrent: firstRepositoryBatch.some((event) => event.observationBatchConcurrent),
    firstRepositoryBatchReadOnly,
    firstRepositoryBatchEvidenceOnly,
    allEvidenceConsumed,
    consumedEvidenceCount,
    searchCount: searches.length,
    searchBatchCount,
    broadSearchCount,
    distinctNonEvidenceReadPaths,
    editCount: edits.length,
    exactDuplicate: context.exactDuplicate,
    escapedExplorationReasons: Object.freeze(escaped),
  });
}
