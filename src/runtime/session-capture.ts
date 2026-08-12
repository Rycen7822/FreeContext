import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../config.js";
import { FreeContextError, ProviderError } from "../errors.js";
import type { ExplorerOutputValidation, ValidatedEvidenceCitation } from "../output/evidence.js";
import type {
  FreeContextRuntimeEvent,
  PiSessionMetrics,
  PiSessionResult,
} from "./pi-session.js";

type CapturedAssistantEvent<Event> = Event extends Readonly<{
  type: "error";
  error: Readonly<{ errorMessage?: string }>;
}>
  ? Omit<Event, "error"> & Readonly<{ errorMessage?: string }>
  : Omit<Event, "partial" | "message">;

export type CapturedAssistantMessageEvent = CapturedAssistantEvent<AssistantMessageEvent>;

type MessageUpdateRuntimeEvent = Extract<FreeContextRuntimeEvent, Readonly<{ type: "message_update" }>>;

export type CapturedFreeContextRuntimeEvent =
  | Exclude<FreeContextRuntimeEvent, MessageUpdateRuntimeEvent>
  | Readonly<{
      type: "message_update";
      assistantMessageEvent: Readonly<CapturedAssistantMessageEvent>;
    }>;

export interface ExplorerRuntime {
  readonly route: string;
  readonly target: string;
  readonly provider: string;
  readonly api: FreeContextConfig["api"];
  readonly authMode: FreeContextConfig["authMode"];
  readonly baseUrl: string;
  readonly model: string;
  readonly workspace: string;
  readonly promptPath: string;
  readonly tools: readonly string[];
}

export interface ExplorerValidationCapture {
  readonly valid: boolean;
  readonly status: ExplorerOutputValidation["status"];
  readonly summary: string;
  readonly evidence: readonly ValidatedEvidenceCitation[];
  readonly gaps: readonly string[];
  readonly problems: readonly string[];
}

export interface ExplorerPiSessionCapture {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly tools: readonly Readonly<{
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: unknown;
  }>[];
  readonly output: string;
  readonly messages: readonly AgentMessage[];
  readonly effectiveContextMessages: readonly AgentMessage[];
  readonly metrics: Readonly<PiSessionMetrics>;
}

export interface ExplorerCapturedError {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly category?: ProviderError["category"];
  readonly statusCode?: number;
}

export type ExplorerCaptureOutcome =
  | Readonly<{ status: "completed"; answer: string }>
  | Readonly<{ status: "partial"; answer: string; problemCount: number }>
  | Readonly<{ status: "output_validation_error"; error: ExplorerCapturedError }>
  | Readonly<{ status: "repair_error"; error: ExplorerCapturedError }>;

export interface ExplorerSessionCapture {
  readonly schemaVersion: "freecontext-session-v1";
  readonly request: string;
  readonly runtime: Readonly<ExplorerRuntime>;
  readonly primary: Readonly<ExplorerPiSessionCapture>;
  readonly primaryValidation: Readonly<ExplorerValidationCapture>;
  readonly repair: Readonly<{
    readonly prompt: string;
    readonly session: Readonly<ExplorerPiSessionCapture> | null;
    readonly validation: Readonly<ExplorerValidationCapture> | null;
  }> | null;
  readonly outcome: ExplorerCaptureOutcome;
}

export type ExplorerSessionCaptureHandler = (
  capture: Readonly<ExplorerSessionCapture>,
) => Promise<void> | void;

function captureAssistantMessageEvent(
  event: AssistantMessageEvent,
): Readonly<CapturedAssistantMessageEvent> {
  if (event.type === "done") {
    return Object.freeze({ type: event.type, reason: event.reason });
  }
  if (event.type === "error") {
    return Object.freeze({
      type: event.type,
      reason: event.reason,
      ...(event.error.errorMessage ? { errorMessage: event.error.errorMessage } : {}),
    });
  }
  const { partial: _partial, ...captured } = event;
  return Object.freeze(captured);
}

export function captureRuntimeEvent(
  event: FreeContextRuntimeEvent,
): Readonly<CapturedFreeContextRuntimeEvent> {
  if (event.type !== "message_update") return event;
  return Object.freeze({
    type: event.type,
    assistantMessageEvent: captureAssistantMessageEvent(event.assistantMessageEvent),
  });
}

export function captureValidation(
  validation: ExplorerOutputValidation,
): Readonly<ExplorerValidationCapture> {
  return Object.freeze({
    valid: validation.valid,
    status: validation.status,
    summary: validation.summary,
    evidence: Object.freeze(validation.evidence.map((item) => Object.freeze({ ...item }))),
    gaps: Object.freeze([...validation.gaps]),
    problems: Object.freeze([...validation.problems]),
  });
}

export function capturePiSession(
  session: Readonly<PiSessionResult>,
  systemPrompt: string,
  prompt: string,
  tools: readonly AgentTool[],
): Readonly<ExplorerPiSessionCapture> {
  return Object.freeze({
    systemPrompt,
    prompt,
    tools: Object.freeze(tools.map((tool) => Object.freeze({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    }))),
    output: session.text,
    messages: Object.freeze([...session.messages]),
    effectiveContextMessages: Object.freeze([...session.contextMessages]),
    metrics: session.metrics,
  });
}

export function captureError(error: unknown): Readonly<ExplorerCapturedError> {
  return Object.freeze({
    name: error instanceof Error ? error.name : "Error",
    code: error instanceof FreeContextError ? error.code : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ProviderError ? {
      category: error.category,
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    } : {}),
  });
}
