export class FreeContextError extends Error {
  constructor(message, { code = "FREECONTEXT_ERROR", exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class ConfigurationError extends FreeContextError {
  constructor(message, options = {}) {
    super(message, { code: "CONFIGURATION_ERROR", exitCode: 2, ...options });
  }
}

export class SecurityError extends FreeContextError {
  constructor(message, options = {}) {
    super(message, { code: "SECURITY_ERROR", exitCode: 3, ...options });
  }
}

export class ProviderError extends FreeContextError {
  constructor(message, options = {}) {
    super(message, { code: "PROVIDER_ERROR", exitCode: 4, ...options });
  }
}

export class OutputValidationError extends FreeContextError {
  constructor(message, options = {}) {
    super(message, { code: "OUTPUT_VALIDATION_ERROR", exitCode: 5, ...options });
  }
}
