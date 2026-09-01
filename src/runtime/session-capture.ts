import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../config.js";
import { FreeContextError, ProviderError } from "../errors.js";
import type {
  FreeContextInvocationContext,
  FreeContextRequest,
} from "../mcp/contracts.js";
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
  readonly terminalFailure: string | null;
  readonly messages: readonly AgentMessage[];
  readonly metrics: Readonly<PiSessionMetrics>;
}

export interface ExplorerCapturedError {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly category?: ProviderError["category"];
  readonly statusCode?: number;
}

export interface ExplorerCaptureMetrics {
  readonly routeAttempts: number;
  readonly fallbacks: number;
  readonly setupMs: number;
  readonly primarySessionMs: number;
  readonly totalMs: number;
}

export interface ExplorerSessionCapture {
  readonly schemaVersion: "freecontext-explorer-capture-v4";
  readonly request: Readonly<FreeContextRequest>;
  readonly invocation: Readonly<FreeContextInvocationContext>;
  readonly runtime: Readonly<ExplorerRuntime>;
  readonly primary: Readonly<ExplorerPiSessionCapture>;
  readonly metrics: Readonly<ExplorerCaptureMetrics>;
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

export function capturePiSession(
  session: Readonly<PiSessionResult>,
  systemPrompt: string,
  prompt: string,
): Readonly<ExplorerPiSessionCapture> {
  const captureTools = (tools: readonly AgentTool[]) => Object.freeze(tools.map((tool) => Object.freeze({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
  })));
  return Object.freeze({
    systemPrompt,
    prompt,
    tools: captureTools(session.explorationTools),
    output: session.text,
    terminalFailure: session.terminalFailure,
    messages: Object.freeze([...session.messages]),
    metrics: session.metrics,
  });
}

export function captureError(error: unknown): Readonly<ExplorerCapturedError> {
  const message = error instanceof FreeContextError
    ? error.message
    : error instanceof Error
      ? "Unexpected internal failure."
      : "Unexpected non-error failure.";
  return Object.freeze({
    name: error instanceof Error ? error.name : "Error",
    code: error instanceof FreeContextError ? error.code : "UNEXPECTED_ERROR",
    message,
    ...(error instanceof ProviderError ? {
      category: error.category,
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    } : {}),
  });
}
