# Provider configuration

FreeContext supports Anthropic Messages-compatible and OpenAI Chat Completions-compatible transports through Pi's direct provider adapters. Transport providers, model targets, and routes are declared separately in `config.toml`; credentials are read only from the environment-variable names declared by each provider.

## Anthropic Messages-compatible

```toml
[providers.anthropic_gateway]
api = "anthropic"
base_url = "https://provider.example"
auth_mode = "auto"
credential_env = "ANTHROPIC_GATEWAY_KEY"

[models.anthropic_model]
provider = "anthropic_gateway"
model_id = "model-id"
context_window = 128000
max_output_tokens = 4096
```

The provider client appends the Anthropic Messages path expected by its SDK. Use the base URL exactly as documented by the provider.

Authentication modes:

- `auto`: pass the key to the Anthropic SDK;
- `x-api-key`: explicit `x-api-key` header;
- `bearer`: explicit Bearer header with SDK key auth disabled;
- `both`: SDK key plus Bearer header.

Custom gateways commonly differ in authentication and feature support. FreeContext disables long cache retention, strict tools, deferred tool references, and eager tool-input streaming by default to maximize compatibility.

## OpenAI Chat Completions-compatible

```toml
[providers.openai_gateway]
api = "openai"
base_url = "https://provider.example/v1"
auth_mode = "auto"
credential_env = "OPENAI_GATEWAY_KEY"

[models.openai_model]
provider = "openai_gateway"
model_id = "model-id"
context_window = 128000
max_output_tokens = 4096

[models.openai_model.openai_compat]
use_streaming = true
supports_developer_role = false
supports_reasoning_effort = false
supports_usage_in_streaming = false
supports_strict_mode = false
supports_required_tool_choice = true
max_tokens_field = "max_tokens"
thinking_format = "openai"
```

`auto` uses standard Bearer authentication. Compatibility controls belong to each model because one gateway may expose models with different feature subsets. `use_streaming` defaults to `true`; set it to `false` when an atomic caller needs one auditable terminal Chat Completions response instead of incremental SSE. FreeContext converts that complete response back into the same Pi event contract, while its existing harness remains the sole retry owner. `supports_required_tool_choice` defaults to `true`; set it to `false` only when that model route rejects string `tool_choice = "required"`. The isolated finalizer then sends `auto` while still accepting only a locally validated `submit_evidence` call and failing closed on text or any other tool. `thinking_format` defaults to `openai`; set it to `deepseek` for a DeepSeek-compatible route so `thinking_level = "off"` is sent as `thinking: { "type": "disabled" }` instead of relying on the provider default.

## Credentials and headers

Export the variable named by `credential_env` before starting FreeContext. The catalog does not accept API-key values, and custom provider headers reject authentication, cookie, and other sensitive header names. Non-sensitive static routing headers may be declared under `[providers.<id>.headers]`.

Every target selected by a route must have its named credential available. The direct `--target` selector chooses one model and disables route fallback. See the root README and [`freecontext.example.toml`](../freecontext.example.toml) for route selection and an ordered multi-provider example.

## Timeout and retry

`[runtime]` owns provider resilience. `request_timeout_ms` limits each request, while `provider_retry_delays_ms` owns the complete retry-wait vector and defaults to `[3000, 6000, 12000]`; each wait receives up to ±20% jitter. Retryability comes from bounded structured HTTP/provider/transport metadata, Pi's retry signal, or the exact TokenRhythm compatibility response, not broad natural-language matching. Only the failed assistant turn is retried, successful repository tool results remain in context, and the Pi transport has its own retries disabled. Retry waits honor cancellation, verbose mode reports their base and actual delays, and exhausted failures enter route fallback only when the configured route and pre-tool safety boundary permit it. Use an empty vector to disable retries.

## SenseNova profile

[`freecontext.sensenova.example.toml`](../freecontext.sensenova.example.toml) intentionally leaves the Anthropic-compatible base URL as a placeholder. Public SenseNova examples may expose an OpenAI-style Chat Completions URL, while account-specific Anthropic-compatible access can use a different gateway and authentication mode. Copy the endpoint from the relevant account documentation rather than deriving it from the public OpenAI URL.

The template uses `auth_mode = "bearer"`; change it only when the account documentation requires another supported mode, such as `x-api-key`.
