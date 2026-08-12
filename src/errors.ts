export interface FreeContextErrorOptions extends ErrorOptions {
  readonly code?: string;
  readonly exitCode?: number;
}

export class FreeContextError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, { code = "FREECONTEXT_ERROR", exitCode = 1, cause }: FreeContextErrorOptions = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class ConfigurationError extends FreeContextError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { code: "CONFIGURATION_ERROR", exitCode: 2, ...options });
  }
}

export class SecurityError extends FreeContextError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { code: "SECURITY_ERROR", exitCode: 3, ...options });
  }
}

export type SessionPersistenceStage = "serialize" | "write" | "sync" | "close";

export class SessionPersistenceError extends FreeContextError {
  readonly stage: SessionPersistenceStage;

  constructor(stage: SessionPersistenceStage, options: ErrorOptions = {}) {
    super(`Session persistence failed during ${stage}.`, {
      code: "SESSION_PERSISTENCE_ERROR",
      ...options,
    });
    this.stage = stage;
  }
}

export type ProviderFailureCategory = "timeout" | "rate_limit" | "server_error" | "connection" | "other";

export interface ProviderErrorOptions extends ErrorOptions {
  readonly category?: ProviderFailureCategory;
  readonly statusCode?: number;
  readonly safeToFallback?: boolean;
}

export class ProviderError extends FreeContextError {
  readonly category: ProviderFailureCategory;
  readonly statusCode?: number;
  readonly safeToFallback: boolean;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, { code: "PROVIDER_ERROR", exitCode: 4, ...options });
    this.category = options.category ?? "other";
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    this.safeToFallback = options.safeToFallback ?? false;
  }
}

export class OutputValidationError extends FreeContextError {
  readonly problems?: readonly string[];
  readonly rawOutput?: string;

  constructor(message: string, options: ErrorOptions & { readonly problems?: readonly string[]; readonly rawOutput?: string } = {}) {
    super(message, { code: "OUTPUT_VALIDATION_ERROR", exitCode: 5, ...options });
    if (options.problems) this.problems = options.problems;
    if (options.rawOutput) this.rawOutput = options.rawOutput;
  }
}

export class ContextBudgetError extends FreeContextError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { code: "CONTEXT_BUDGET_ERROR", exitCode: 6, ...options });
  }
}
