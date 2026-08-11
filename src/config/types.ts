export type ApiProtocol = "anthropic" | "openai";
export type AuthMode = "auto" | "x-api-key" | "bearer" | "both";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAIMaxTokensField = "max_tokens" | "max_completion_tokens";
export type FallbackReason = "timeout" | "rate_limit" | "server_error" | "connection";

export interface OpenAICompatConfig {
  readonly supportsDeveloperRole: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsUsageInStreaming: boolean;
  readonly supportsStrictMode: boolean;
  readonly supportsStore: false;
  readonly maxTokensField: OpenAIMaxTokensField;
}

export interface CliConfigOverrides {
  readonly configFile?: string;
  readonly route?: string;
  readonly target?: string;
  readonly promptPath?: string;
  readonly maxTurns?: string | number;
  readonly maxToolCalls?: string | number;
  readonly requestTimeoutMs?: string | number;
  readonly toolTimeoutMs?: string | number;
  readonly maxToolOutputBytes?: string | number;
  readonly maxParallelTools?: string | number;
  readonly contextCompactionEnabled?: boolean;
}

export interface RuntimeConfig {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly requestTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxToolOutputBytes: number;
  readonly maxParallelTools: number;
  readonly contextCompactionEnabled: boolean;
}

export interface FreeContextConfig extends RuntimeConfig {
  readonly target: string;
  readonly provider: string;
  readonly api: ApiProtocol;
  readonly authMode: AuthMode;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly promptPath: string;
  readonly configFilePath: string;
  readonly maxOutputTokens: number;
  readonly contextWindow: number;
  readonly contextReserveTokens: number;
  readonly contextKeepRecentTokens: number;
  readonly effectiveToolOutputBytes: number;
  readonly temperature: number;
  readonly thinkingLevel: ThinkingLevel;
  readonly headers: Readonly<Record<string, string>>;
  readonly openAICompat: Readonly<OpenAICompatConfig>;
}

export interface ResolvedRouteConfig {
  readonly route: string;
  readonly configFilePath: string;
  readonly fallbackOn: readonly FallbackReason[];
  readonly targets: readonly FreeContextConfig[];
}

export type Environment = Readonly<Record<string, string | undefined>>;
