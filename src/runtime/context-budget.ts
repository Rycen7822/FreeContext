import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { ContextBudgetError } from "../errors.js";

export interface ContextCompactionConfig {
  readonly enabled: boolean;
  readonly contextWindow: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

export interface ContextUsageSnapshot {
  readonly messageTokens: number;
  readonly fixedTokens: number;
  readonly totalTokens: number;
  readonly availableTokens: number;
}

export interface CompactionCut {
  readonly cutIndex: number;
  readonly messagesToSummarize: readonly AgentMessage[];
  readonly retainedTail: readonly AgentMessage[];
  readonly previousSummary: string | undefined;
  readonly tokensBefore: number;
  readonly estimatedRetainedTokens: number;
}

export interface ContextEstimators {
  readonly estimateContextTokens: (messages: AgentMessage[]) => { readonly tokens: number };
  readonly estimateTokens: (message: AgentMessage) => number;
}

export function estimateEffectiveContextTokens(
  messages: readonly AgentMessage[],
  estimators: ContextEstimators,
): number {
  let lastSummaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "compactionSummary") {
      lastSummaryIndex = index;
      break;
    }
  }
  if (lastSummaryIndex < 0) return estimators.estimateContextTokens([...messages]).tokens;
  let tokens = 0;
  for (let index = lastSummaryIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message) tokens += estimators.estimateTokens(message);
  }
  return tokens;
}

function estimationMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 };
}

function serializedTools(tools: readonly AgentTool[]): string {
  return JSON.stringify(
    tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  );
}

export function estimateInitialRequestTokens({
  systemPrompt,
  promptText,
  messages,
  tools,
  estimators,
  contextWindow,
  reserveTokens,
}: {
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentTool[];
  readonly estimators: ContextEstimators;
  readonly contextWindow: number;
  readonly reserveTokens: number;
}): ContextUsageSnapshot {
  const messageTokens = estimateEffectiveContextTokens(messages, estimators);
  const fixedTokens = estimators.estimateTokens(
    estimationMessage(`${systemPrompt}\n${promptText}\n${serializedTools(tools)}`),
  );
  return Object.freeze({
    messageTokens,
    fixedTokens,
    totalTokens: messageTokens + fixedTokens,
    availableTokens: contextWindow - reserveTokens,
  });
}

function isRetainedBoundary(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "assistant" || message.role === "compactionSummary";
}

export function selectCompactionCut(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
  estimators: ContextEstimators,
): CompactionCut | null {
  if (messages.length < 2) return null;

  let previousSummary: string | undefined;
  let historyStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "compactionSummary") {
      previousSummary = message.summary;
      historyStart = index + 1;
      break;
    }
  }

  let cutIndex = messages.length;
  let estimatedRetainedTokens = 0;
  for (let index = messages.length - 1; index >= historyStart; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    estimatedRetainedTokens += estimators.estimateTokens(message);
    cutIndex = index;
    if (estimatedRetainedTokens >= keepRecentTokens) break;
  }

  while (cutIndex < messages.length) {
    const candidate = messages[cutIndex];
    if (candidate && isRetainedBoundary(candidate)) break;
    cutIndex += 1;
  }
  if (cutIndex <= historyStart || cutIndex >= messages.length) return null;

  const messagesToSummarize = messages.slice(historyStart, cutIndex);
  if (messagesToSummarize.length === 0) return null;
  const retainedTail = messages.slice(cutIndex);
  if (retainedTail[0]?.role === "toolResult") return null;

  return Object.freeze({
    cutIndex,
    messagesToSummarize: Object.freeze(messagesToSummarize),
    retainedTail: Object.freeze(retainedTail),
    previousSummary,
    tokensBefore: estimateEffectiveContextTokens(messages, estimators),
    estimatedRetainedTokens: retainedTail.reduce((total, message) => total + estimators.estimateTokens(message), 0),
  });
}

export function assertInitialRequestFits(
  snapshot: ContextUsageSnapshot,
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
  estimators: ContextEstimators,
): void {
  if (snapshot.totalTokens <= snapshot.availableTokens) return;
  if (selectCompactionCut(messages, keepRecentTokens, estimators)) return;
  throw new ContextBudgetError(
    `Initial request requires approximately ${snapshot.totalTokens} tokens but only ` +
      `${snapshot.availableTokens} are available after the context reserve.`,
  );
}
