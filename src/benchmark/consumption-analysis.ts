import type { FreeContextResult } from "../mcp/contracts.js";
import { isRecord } from "./delivery-observation.js";

export type ParentRepositoryActionKind = "read" | "search" | "edit" | "other";

export interface ParentRepositoryActionEvent {
  readonly schemaVersion: "freecontext-parent-action-v1";
  readonly taskId: string;
  readonly callId: string;
  readonly repetition: string;
  readonly sequence: number;
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
  readonly schemaVersion: "freecontext-consumption-audit-v1";
  readonly observationSource: "explicit_host_event" | "completed_codex_tool_call";
  readonly taskId: string;
  readonly callId: string;
  readonly repetition: string;
  readonly actionCount: number;
  readonly firstRepositoryAction: Readonly<ParentRepositoryActionEvent["action"]> | null;
  readonly firstActionEvidenceHit: boolean | null;
  readonly evidenceConsumed: boolean;
  readonly firstEvidenceHitSequence: number | null;
  readonly broadSearchCount: number;
  readonly repeatedBroadSearch: boolean;
  readonly partialGapSearchCount: number;
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
  const kind = value.action.kind;
  const path = value.action.path;
  const startLine = value.action.startLine;
  const endLine = value.action.endLine;
  const broad = value.action.broad;
  const gapQuestionIds = value.action.gapQuestionIds;
  if (sequence === null || !["read", "search", "edit", "other"].includes(String(kind)) ||
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

function hitsEvidence(action: ParentRepositoryActionEvent["action"], result: Readonly<FreeContextResult>): boolean {
  if (action.kind !== "read" || action.path === null || action.startLine === null || action.endLine === null) return false;
  const actionPath = normalizePath(action.path);
  return result.evidence.some((item) => normalizePath(item.path) === actionPath &&
    action.startLine! <= item.endLine && action.endLine! >= item.startLine);
}

export function analyzeFreeContextConsumption(
  result: Readonly<FreeContextResult>,
  actions: readonly Readonly<ParentRepositoryActionEvent>[],
  observationSource: FreeContextConsumptionAudit["observationSource"] = "explicit_host_event",
): Readonly<FreeContextConsumptionAudit> | null {
  if (actions.length === 0) return null;
  const [first, ...rest] = actions;
  if (!first) return null;
  for (const event of rest) {
    if (event.taskId !== first.taskId || event.callId !== first.callId || event.repetition !== first.repetition) {
      throw new Error(`Mixed parent-action identity for callId ${first.callId}.`);
    }
  }
  const firstEvidenceHit = actions.find((event) => hitsEvidence(event.action, result)) ?? null;
  const broadSearchCount = actions.filter((event) => event.action.kind === "search" && event.action.broad).length;
  const gapIds = new Set(result.gaps.map(({ questionId }) => questionId));
  const partialGapSearchCount = result.status === "partial" && firstEvidenceHit
    ? actions.filter((event) => event.sequence > firstEvidenceHit.sequence && event.action.kind === "search" &&
      event.action.gapQuestionIds.some((questionId) => gapIds.has(questionId))).length
    : 0;
  return Object.freeze({
    schemaVersion: "freecontext-consumption-audit-v1",
    observationSource,
    taskId: first.taskId,
    callId: first.callId,
    repetition: first.repetition,
    actionCount: actions.length,
    firstRepositoryAction: first.action,
    firstActionEvidenceHit: hitsEvidence(first.action, result),
    evidenceConsumed: firstEvidenceHit !== null,
    firstEvidenceHitSequence: firstEvidenceHit?.sequence ?? null,
    broadSearchCount,
    repeatedBroadSearch: broadSearchCount > 0,
    partialGapSearchCount,
  });
}
