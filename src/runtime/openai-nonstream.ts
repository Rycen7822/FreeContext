import OpenAI from "openai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICompletionsCompat,
  type ProviderStreams,
  type SimpleStreamOptions,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";

type OpenAIModel = Model<"openai-completions">;
type NonStreamingPayload = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "reasoning_effort"
> & {
  thinking?: { readonly type: "enabled" | "disabled" };
  reasoning_effort?: string;
};
type NonStreamingOptions = SimpleStreamOptions & {
  readonly toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
};
type ResolvedCompat = Parameters<typeof convertMessages>[2];

function hasHeader(headers: SimpleStreamOptions["headers"], expected: string): boolean {
  const normalized = expected.toLowerCase();
  return Object.entries(headers ?? {}).some(([name, value]) => (
    name.toLowerCase() === normalized && typeof value === "string" && value.trim().length > 0
  ));
}

function clientApiKey(model: OpenAIModel, options: NonStreamingOptions): string {
  if (options.apiKey) return options.apiKey;
  if (hasHeader(options.headers, "authorization") || hasHeader(options.headers, "cf-aig-authorization")) return "unused";
  throw new Error(`No API key for provider: ${model.provider}`);
}

function resolveCompat(model: OpenAIModel): ResolvedCompat {
  const compat: OpenAICompletionsCompat = model.compat ?? {};
  return {
    supportsStore: compat.supportsStore ?? false,
    supportsDeveloperRole: compat.supportsDeveloperRole ?? false,
    supportsReasoningEffort: compat.supportsReasoningEffort ?? false,
    supportsUsageInStreaming: compat.supportsUsageInStreaming ?? false,
    maxTokensField: compat.maxTokensField ?? "max_tokens",
    requiresToolResultName: compat.requiresToolResultName ?? false,
    requiresAssistantAfterToolResult: compat.requiresAssistantAfterToolResult ?? false,
    requiresThinkingAsText: compat.requiresThinkingAsText ?? false,
    requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages ?? false,
    thinkingFormat: compat.thinkingFormat ?? "openai",
    openRouterRouting: compat.openRouterRouting ?? {},
    vercelGatewayRouting: compat.vercelGatewayRouting ?? {},
    chatTemplateKwargs: compat.chatTemplateKwargs ?? {},
    zaiToolStream: compat.zaiToolStream ?? false,
    supportsStrictMode: compat.supportsStrictMode ?? true,
    supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false,
    cacheControlFormat: compat.cacheControlFormat,
    sendSessionAffinityHeaders: compat.sendSessionAffinityHeaders ?? false,
    deferredToolsMode: compat.deferredToolsMode,
    sessionAffinityFormat: compat.sessionAffinityFormat ?? "openai",
    supportsLongCacheRetention: compat.supportsLongCacheRetention ?? true,
  };
}

function hasToolHistory(context: Context): boolean {
  return context.messages.some((message) => (
    message.role === "toolResult"
    || (message.role === "assistant" && message.content.some((block) => block.type === "toolCall"))
  ));
}

function buildPayload(
  model: OpenAIModel,
  context: Context,
  options: NonStreamingOptions,
  compat: ResolvedCompat,
): NonStreamingPayload {
  const payload: NonStreamingPayload = {
    model: model.id,
    messages: convertMessages(model, context, compat),
    stream: false,
  };
  if (options.maxTokens) payload[compat.maxTokensField] = options.maxTokens;
  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (context.tools?.length) {
    payload.tools = context.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
        ...(compat.supportsStrictMode ? { strict: false } : {}),
      },
    }));
  } else if (hasToolHistory(context)) {
    payload.tools = [];
  }
  if (options.toolChoice) payload.tool_choice = options.toolChoice;
  if (model.reasoning && compat.thinkingFormat === "deepseek") {
    payload.thinking = { type: options.reasoning ? "enabled" : "disabled" };
    if (options.reasoning && compat.supportsReasoningEffort) payload.reasoning_effort = options.reasoning;
  } else if (model.reasoning && options.reasoning && compat.supportsReasoningEffort) {
    payload.reasoning_effort = options.reasoning;
  }
  return payload;
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function failureText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "Provider request failed.");
  const record = error as Record<string, unknown>;
  const nested = [record.error, record.cause]
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
  const envelope: Record<string, unknown> = {};
  const status = record.status ?? record.statusCode;
  if (typeof status === "number") envelope.status = status;
  const code = record.code ?? nested.find((value) => typeof value.code === "string")?.code;
  if (typeof code === "string") envelope.code = code;
  const type = record.type ?? nested.find((value) => typeof value.type === "string")?.type;
  if (typeof type === "string") envelope.type = type;
  const message = record.message ?? nested.find((value) => typeof value.message === "string")?.message;
  if (typeof message === "string") envelope.message = message.slice(0, 4_000);
  return Object.keys(envelope).length > 0 ? JSON.stringify(envelope) : String(error);
}

function usageOf(raw: OpenAI.Completions.CompletionUsage | undefined, model: OpenAIModel): Usage {
  const extended = raw as (OpenAI.Completions.CompletionUsage & {
    readonly prompt_cache_hit_tokens?: number;
    readonly prompt_tokens_details?: OpenAI.Completions.CompletionUsage["prompt_tokens_details"] & {
      readonly cache_write_tokens?: number;
    };
  }) | undefined;
  const promptTokens = raw?.prompt_tokens ?? 0;
  const cacheRead = raw?.prompt_tokens_details?.cached_tokens ?? extended?.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = extended?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const output = raw?.completion_tokens ?? 0;
  const usage: Usage = {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    ...(raw?.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoning: raw.completion_tokens_details.reasoning_tokens }
      : {}),
    totalTokens: promptTokens + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function stopReasonOf(reason: string | null): Pick<AssistantMessage, "stopReason" | "errorMessage"> {
  if (reason === "stop" || reason === "end") return { stopReason: "stop" };
  if (reason === "length") return { stopReason: "length" };
  if (reason === "function_call" || reason === "tool_calls") return { stopReason: "toolUse" };
  return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason ?? "missing"}` };
}

function contentOf(response: OpenAI.Chat.Completions.ChatCompletion): AssistantMessage["content"] {
  const choice = response.choices[0];
  if (!choice) throw response;
  const message = choice.message as typeof choice.message & {
    reasoning?: unknown;
    reasoning_content?: unknown;
    reasoning_text?: unknown;
  };
  const content: AssistantMessage["content"] = [];
  const thinkingField = ["reasoning_content", "reasoning", "reasoning_text"]
    .find((field) => typeof message[field as keyof typeof message] === "string"
      && String(message[field as keyof typeof message]).length > 0);
  if (thinkingField) {
    content.push({
      type: "thinking",
      thinking: String(message[thinkingField as keyof typeof message]),
      thinkingSignature: thinkingField,
    });
  }
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function" || !call.id || !call.function.name) throw response;
    const toolCall: ToolCall = {
      type: "toolCall",
      id: call.id,
      name: call.function.name,
      arguments: parseStreamingJson(call.function.arguments),
    };
    content.push(toolCall);
  }
  return content;
}

function emitContent(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  output: AssistantMessage,
  content: AssistantMessage["content"],
): void {
  content.forEach((block) => {
    const contentIndex = output.content.length;
    output.content.push(block);
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex, partial: output });
      stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: output });
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
    } else {
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: output });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
    }
  });
}

export const streamOpenAINonStreaming: ProviderStreams["streamSimple"] = (
  rawModel,
  context,
  rawOptions = {},
) => {
  if (rawModel.api !== "openai-completions") throw new Error("Non-streaming OpenAI transport requires openai-completions.");
  const model = rawModel as OpenAIModel;
  const stream = createAssistantMessageEventStream();
  const options = rawOptions as NonStreamingOptions;
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usageOf(undefined, model),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  void (async () => {
    try {
      const compat = resolveCompat(model);
      let payload: unknown = buildPayload(model, context, options, compat);
      payload = await options.onPayload?.(payload, model) ?? payload;
      if (!payload || typeof payload !== "object" || (payload as { stream?: unknown }).stream !== false) {
        throw new Error("Non-streaming OpenAI payload must retain stream=false.");
      }
      const client = new OpenAI({
        apiKey: clientApiKey(model, options),
        baseURL: model.baseUrl,
        defaultHeaders: { ...model.headers, ...options.headers },
      });
      const { data, response } = await client.chat.completions.create(
        payload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          maxRetries: 0,
        },
      ).withResponse();
      await options.onResponse?.({ status: response.status, headers: responseHeaders(response.headers) }, model);
      if (!data || !Array.isArray(data.choices) || !data.choices[0]) throw data;
      const content = contentOf(data);
      Object.assign(output, stopReasonOf(data.choices[0].finish_reason));
      output.usage = usageOf(data.usage, model);
      if (data.id) output.responseId = data.id;
      if (data.model) output.responseModel = data.model;
      if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error(output.errorMessage);
      stream.push({ type: "start", partial: output });
      emitContent(stream, output, content);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = failureText(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};
