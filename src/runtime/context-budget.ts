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

export interface ContextTokenCounter {
  readonly countBatch: (texts: readonly string[]) => Promise<readonly number[]>;
}

function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult":
      return contentText(message.content);
    case "assistant":
      return message.content
        .flatMap((block) => {
          if (block.type === "text") return [block.text];
          if (block.type === "thinking") return [block.thinking];
          if (block.type === "toolCall") return [`${block.name}\n${JSON.stringify(block.arguments)}`];
          return [];
        })
        .join("\n");
    case "bashExecution":
      return `${message.command}\n${message.output}`;
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
  }
}

function effectiveStart(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "compactionSummary") return index;
  }
  return 0;
}

async function messageTokenCounts(
  messages: readonly AgentMessage[],
  counter: ContextTokenCounter,
): Promise<readonly number[]> {
  const counts = await counter.countBatch(messages.map(messageText));
  if (counts.length !== messages.length) throw new ContextBudgetError("Tokenizer returned an invalid batch length.");
  return counts;
}

export async function estimateEffectiveContextTokens(
  messages: readonly AgentMessage[],
  counter: ContextTokenCounter,
): Promise<number> {
  const counts = await messageTokenCounts(messages, counter);
  return counts.slice(effectiveStart(messages)).reduce((total, count) => total + count, 0);
}

function estimationMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 };
}

function serializedTools(tools: readonly AgentTool[]): string {
  return JSON.stringify(
    tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  );
}

export async function estimateInitialRequestTokens({
  systemPrompt,
  promptText,
  messages,
  tools,
  counter,
  contextWindow,
  reserveTokens,
}: {
  readonly systemPrompt: string;
  readonly promptText: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentTool[];
  readonly counter: ContextTokenCounter;
  readonly contextWindow: number;
  readonly reserveTokens: number;
}): Promise<ContextUsageSnapshot> {
  const effectiveMessages = messages.slice(effectiveStart(messages));
  const fixed = estimationMessage(`${systemPrompt}\n${promptText}\n${serializedTools(tools)}`);
  const counts = await counter.countBatch([...effectiveMessages.map(messageText), messageText(fixed)]);
  if (counts.length !== effectiveMessages.length + 1) {
    throw new ContextBudgetError("Tokenizer returned an invalid initial-request batch length.");
  }
  const fixedTokens = counts.at(-1) ?? 0;
  const messageTokens = counts.slice(0, -1).reduce((total, count) => total + count, 0);
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

export async function selectCompactionCut(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
  counter: ContextTokenCounter,
): Promise<CompactionCut | null> {
  if (messages.length < 2) return null;

  const counts = await messageTokenCounts(messages, counter);

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
    const messageTokens = counts[index] ?? 0;
    if (estimatedRetainedTokens > 0 && messageTokens > keepRecentTokens) break;
    estimatedRetainedTokens += messageTokens;
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
    tokensBefore: counts.slice(effectiveStart(messages)).reduce((total, count) => total + count, 0),
    estimatedRetainedTokens: counts.slice(cutIndex).reduce((total, count) => total + count, 0),
  });
}

export function assertInitialRequestFits(
  snapshot: ContextUsageSnapshot,
  cut: CompactionCut | null,
): void {
  if (snapshot.totalTokens <= snapshot.availableTokens) return;
  if (cut) return;
  throw new ContextBudgetError(
    `Initial request requires approximately ${snapshot.totalTokens} tokens but only ` +
      `${snapshot.availableTokens} are available after the context reserve.`,
  );
}
