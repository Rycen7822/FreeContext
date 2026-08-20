import { isRecord } from "./delivery-observation.js";
import type { ParentRepositoryActionEvent } from "./consumption-analysis.js";
import {
  extractRepositoryActionsFromCode,
} from "./shell-action-parser.js";
import type { ExtractedRepositoryActions, RepositoryAction } from "./shell-action-parser.js";

export interface HostActionBoundary {
  readonly completedAt: string;
  readonly endedBefore: string | null;
  readonly taskId: string;
  readonly callId: string;
  readonly repetition: string;
  readonly gapQuestionIds: readonly string[];
}

export interface HostActionObservation {
  readonly complete: boolean;
  readonly actions: readonly Readonly<ParentRepositoryActionEvent>[];
}

function event(value: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value.payload) ? value.payload : value;
}

function callId(value: Record<string, unknown>): string | null {
  const candidate = value.call_id ?? value.callId;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : null;
}

function renderedOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n");
}

export function collectCompletedHostRepositoryActions(
  rawJsonl: string,
  boundary: Readonly<HostActionBoundary>,
): Readonly<HostActionObservation> {
  const completedAt = Date.parse(boundary.completedAt);
  const endedBefore = boundary.endedBefore === null ? null : Date.parse(boundary.endedBefore);
  if (Number.isNaN(completedAt) || (endedBefore !== null &&
      (Number.isNaN(endedBefore) || endedBefore < completedAt))) {
    return Object.freeze({ complete: false, actions: Object.freeze([]) });
  }
  const records: { readonly value: Record<string, unknown>; readonly timestamp: number; readonly index: number }[] = [];
  let recordIndex = 0;
  for (const line of rawJsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const item = event(parsed);
      const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      const source = typeof item.input === "string" ? item.input : typeof item.arguments === "string" ? item.arguments : "";
      if (Number.isNaN(timestamp)) {
        if (item.name === "exec" && (source.includes("tools.exec_command") || source.includes("tools.apply_patch"))) {
          return Object.freeze({ complete: false, actions: Object.freeze([]) });
        }
        continue;
      }
      records.push({ value: parsed, timestamp, index: recordIndex });
      recordIndex += 1;
    } catch { /* Preserved raw JSONL cannot prove an action on this line. */ }
  }
  records.sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);
  const observed: {
    readonly repositoryAction: RepositoryAction;
    readonly batchId: string;
    readonly batchConcurrent: boolean;
    readonly batchOrder: number;
  }[] = [];
  const pending = new Map<string, Readonly<{
    extracted: ExtractedRepositoryActions;
    batchOrder: number;
    startedAt: number;
  }>>();
  const seenCallIds = new Set<string>();
  let nextBatchOrder = 0;
  for (const record of records) {
    const item = event(record.value);
    const type = item.type;
    const id = callId(item);
    if ((type === "custom_tool_call" || type === "function_call") && item.name === "exec" && id) {
      const source = typeof item.input === "string" ? item.input : typeof item.arguments === "string" ? item.arguments : "";
      if (!source.includes("tools.exec_command") && !source.includes("tools.apply_patch")) continue;
      if (endedBefore !== null && record.timestamp >= endedBefore) continue;
      const extracted = extractRepositoryActionsFromCode(source, boundary.gapQuestionIds);
      if (seenCallIds.has(id)) {
        return Object.freeze({ complete: false, actions: Object.freeze([]) });
      }
      seenCallIds.add(id);
      const inside = record.timestamp > completedAt;
      pending.set(id, { extracted, batchOrder: inside ? nextBatchOrder : -1, startedAt: record.timestamp });
      if (inside) nextBatchOrder += 1;
      continue;
    }
    if ((type !== "custom_tool_call_output" && type !== "function_call_output") || !id) continue;
    const batch = pending.get(id);
    if (!batch) continue;
    pending.delete(id);
    const { extracted, batchOrder, startedAt } = batch;
    if (startedAt <= completedAt) {
      if (record.timestamp > completedAt) {
        return Object.freeze({ complete: false, actions: Object.freeze([]) });
      }
      continue;
    }
    if (endedBefore !== null && record.timestamp >= endedBefore) {
      return Object.freeze({ complete: false, actions: Object.freeze([]) });
    }
    if (!extracted.complete) return Object.freeze({ complete: false, actions: Object.freeze([]) });
    const output = renderedOutput(item.output);
    if (extracted.actions.length > 0 && /Script (?:error|failed)|exec_command failed/iu.test(output)) {
      if (extracted.actions.every(({ kind }) => kind === "edit")) continue;
      return Object.freeze({ complete: false, actions: Object.freeze([]) });
    }
    observed.push(...extracted.actions.map((repositoryAction) => ({
      repositoryAction,
      batchId: id,
      batchConcurrent: extracted.concurrent,
      batchOrder,
    })));
  }
  if (pending.size > 0) return Object.freeze({ complete: false, actions: Object.freeze([]) });
  observed.sort((left, right) => left.batchOrder - right.batchOrder);
  const actions = observed.map(({ repositoryAction, batchId, batchConcurrent }, index) => Object.freeze({
    schemaVersion: "freecontext-parent-action-v1" as const,
    taskId: boundary.taskId,
    callId: boundary.callId,
    repetition: boundary.repetition,
    sequence: index + 1,
    observationBatchId: batchId,
    observationBatchConcurrent: batchConcurrent,
    action: Object.freeze(repositoryAction),
  }));
  return Object.freeze({ complete: true, actions: Object.freeze(actions) });
}
