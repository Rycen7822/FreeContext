# Provider configuration

FreeContext supports two wire protocols through Pi's direct provider adapters.

## Anthropic Messages-compatible

Set:

```dotenv
FREECONTEXT_API=anthropic
FREECONTEXT_BASE_URL=https://provider.example
FREECONTEXT_MODEL=model-id
FREECONTEXT_API_KEY=secret
```

The provider client appends the Anthropic Messages path expected by its SDK. Use the base URL exactly as documented by the provider.

Authentication modes:

- `auto`: pass the key to the Anthropic SDK;
- `x-api-key`: explicit `x-api-key` header;
- `bearer`: explicit Bearer header with SDK key auth disabled;
- `both`: SDK key plus Bearer header.

Custom gateways commonly differ in authentication and feature support. FreeContext disables long cache retention, strict tools, deferred tool references, and eager tool-input streaming by default to maximize compatibility.

## OpenAI Chat Completions-compatible

Set:

```dotenv
FREECONTEXT_API=openai
FREECONTEXT_BASE_URL=https://provider.example/v1
FREECONTEXT_MODEL=model-id
FREECONTEXT_API_KEY=secret
```

`auto` uses the standard Bearer behavior. Compatibility controls are available for gateways that implement different subsets:

```dotenv
FREECONTEXT_OPENAI_SUPPORTS_DEVELOPER_ROLE=false
FREECONTEXT_OPENAI_SUPPORTS_REASONING_EFFORT=false
FREECONTEXT_OPENAI_SUPPORTS_USAGE_IN_STREAMING=false
FREECONTEXT_OPENAI_SUPPORTS_STRICT_MODE=false
FREECONTEXT_OPENAI_MAX_TOKENS_FIELD=max_tokens
```

## SenseNova profile

`.env.sensenova.example` intentionally leaves the Anthropic-compatible base URL as a placeholder. The public SenseNova examples currently expose an OpenAI-style Chat Completions URL, while account-specific Anthropic-compatible access can use a different gateway and authentication mode. Copy the endpoint from the relevant account documentation rather than deriving it from the public OpenAI URL.

Use `FREECONTEXT_AUTH_MODE=bearer` for the requested SenseNova Anthropic-compatible setup unless the account documentation specifies `x-api-key`.
