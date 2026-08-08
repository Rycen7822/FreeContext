# Architecture

## Scope

FreeContext performs one operation: read-only repository exploration for a parent coding agent. The parent sends a semantic evidence request; the child returns a compact, locally validated navigation map.

## Runtime layers

1. **Codex skill**
   - Encodes delegation triggers and skip conditions.
   - Keeps routine exact-file reads in the main agent.
   - Requires the parent to inspect decisive cited ranges before editing.

2. **CLI boundary**
   - Accepts a repository root and evidence request.
   - Loads a strict TOML provider/model/route catalog, credentials from named environment variables, and the system prompt from Markdown.
   - Emits the final evidence block to stdout; operational diagnostics use stderr.
   - Runs from generated ESM in `dist`; TypeScript under `src` is authoritative and declarations are shipped with the package.

3. **Pi agent loop**
   - Resolves one ordered route before primary execution and builds the binding, model, request options, and bounded tools for the current target.
   - Loads the public typed `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` contracts through one adapter.
   - Uses `runAgentLoop` for the initial request and `runAgentLoopContinue` only for one recognized context-overflow recovery.
   - Uses `@earendil-works/pi-ai` direct Anthropic Messages or OpenAI Chat Completions `streamSimple` adapter.
   - Executes independent tool calls in parallel.
   - Enforces turn and tool-call budgets in hooks.
   - Removes all tools and injects a finalization message when the budget is exhausted.

4. **Read-only tool layer**
   - Registers a closed, explicitly typed capability list; compaction does not add or replace tools.
   - `read`: native bounded text line reader.
   - `rg`: repository text search.
   - `glob`: path discovery via `rg --files`.
   - `jq`: constrained query over one existing JSON file.
   - `bat`: optional bounded file rendering.
   - Keeps native subprocess execution confined to the audited `src/tools/process.ts` boundary with `shell: false`.

5. **Evidence validator**
   - Parses the last `<final_answer>` block.
   - Resolves every citation against the workspace.
   - Verifies file existence and line ranges.
   - Deduplicates exact ranges.
   - Performs one no-tool repair request when needed.

## Configuration and routing

The default catalog is `$XDG_CONFIG_HOME/freecontext/config.toml`, falling back to `~/.config/freecontext/config.toml`. `--config` overrides `FREECONTEXT_CONFIG`, which overrides that default; FreeContext never auto-loads a repository-local configuration file. TOML `version = 1` separates `[providers]`, `[models]`, `[routes]`, and shared `[runtime]` limits. Unknown keys, invalid values, broken references, and oversized configuration files fail before transport setup.

Provider entries name a `credential_env`; secret values and sensitive authentication headers are rejected in TOML. Model entries own context/output budgets and protocol compatibility metadata. Route entries contain unique ordered model targets plus the allowed `timeout`, `rate_limit`, and `server_error` fallback categories. `--target` pins one model and disables fallback; it is mutually exclusive with `--route`.

The route resolver attempts a later target only when an allowed transient provider failure occurs before any tool call has been accepted in the primary session. It never falls back for authentication/configuration errors, aborts, generic failures, post-tool failures, compaction, or format repair. Each attempt reconstructs provider-specific bindings, model metadata, request options, and context-aware tool bounds. Once primary execution succeeds, compaction and repair stay on that selected target and authenticated transport.

Runtime limits follow CLI, environment override, TOML, then built-in default precedence. Prompt selection follows `--prompt`, `FREECONTEXT_PROMPT_PATH`, TOML `[runtime].prompt_path`, then the bundled prompt; a relative TOML prompt path is resolved beside the catalog.

## Context asymmetry

The child model receives its own search transcript and tool outputs. The parent receives only summary, evidence spans, gaps, and optional aggregate usage. This prevents broad search output from entering the parent context while preserving an auditable path to the underlying code.

The transcript is memory-only. FreeContext does not create session trees, transcript files, JSONL logs, checkpoints, or resume state. A format-repair request receives the effective post-compaction context and the invalid answer, never a stale copy of the original history.

## Context resilience

Before the first provider call, FreeContext estimates the system prompt, request, current messages, tool schemas, and reserved output budget. An oversized request with no compressible history fails locally. At later turn boundaries, the Pi estimator and configured reserve determine whether older history must be summarized.

Compaction selects a valid prefix without splitting an assistant tool call from its results. It sends that prefix to the same authenticated provider transport with no tools, a fresh summary-session id, and an evidence-focused prompt. The returned Pi compaction-summary message is joined to the exact recent tail; empty or non-reducing summaries are rejected. Repeated compaction merges the previous summary instead of serializing it as raw history.

If Pi identifies a provider context overflow, FreeContext performs at most one compaction and continues the same loop context. The continuation retains the same tools, limits, event handler, request settings, and abort signal. Generic provider errors and aborted responses never enter overflow continuation; only the separate pre-tool route policy above can try another target.

## Budget convergence

The loop has two independent limits:

- `maxTurns`: model response rounds;
- `maxToolCalls`: prepared structured tool calls.

After the penultimate turn with tool results, or after the tool budget is reached, `prepareNextTurn` returns a context with no tools and a finalization instruction. The final request can only synthesize evidence already in the child transcript.

## Provider boundary

The model metadata and request options are constructed separately:

- model object: protocol, endpoint, model id, context/output limits, compatibility flags;
- request options: API key/header mode, timeout, retry cap, temperature, cache policy, reasoning level.

Provider errors are classified from structured status data where available and redacted before leaving the runtime. Classification controls only the bounded route fallback above; Pi context-overflow recovery remains a separate same-target operation.

## Runtime metrics

Metrics report selected route/target/provider identity, route attempts and fallbacks, setup, primary/repair session and validation durations, total time, paired tool-execution total/max durations, provider attempts, compaction counts/reasons/time/usage, and overflow retries. They contain aggregate numbers only—never prompts, tool arguments, file contents, headers, keys, or credential-bearing URLs. Compaction may add one summary provider call per attempt; a short baseline session makes none.
