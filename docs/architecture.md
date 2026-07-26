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
   - Loads provider settings from `.env` and the system prompt from Markdown.
   - Emits the final evidence block to stdout; operational diagnostics use stderr.

3. **Pi agent loop**
   - Uses `@earendil-works/pi-agent-core` `runAgentLoop` directly.
   - Uses `@earendil-works/pi-ai` direct Anthropic Messages or OpenAI Chat Completions `streamSimple` adapter.
   - Executes independent tool calls in parallel.
   - Enforces turn and tool-call budgets in hooks.
   - Removes all tools and injects a finalization message when the budget is exhausted.

4. **Read-only tool layer**
   - `read`: native bounded text line reader.
   - `rg`: repository text search.
   - `glob`: path discovery via `rg --files`.
   - `jq`: constrained query over one existing JSON file.
   - `bat`: optional bounded file rendering.

5. **Evidence validator**
   - Parses the last `<final_answer>` block.
   - Resolves every citation against the workspace.
   - Verifies file existence and line ranges.
   - Deduplicates exact ranges.
   - Performs one no-tool repair request when needed.

## Context asymmetry

The child model receives its own search transcript and tool outputs. The parent receives only summary, evidence spans, gaps, and optional aggregate usage. This prevents broad search output from entering the parent context while preserving an auditable path to the underlying code.

## Budget convergence

The loop has two independent limits:

- `maxTurns`: model response rounds;
- `maxToolCalls`: prepared structured tool calls.

After the penultimate turn with tool results, or after the tool budget is reached, `prepareNextTurn` returns a context with no tools and a finalization instruction. The final request can only synthesize evidence already in the child transcript.

## Provider boundary

The model metadata and request options are constructed separately:

- model object: protocol, endpoint, model id, context/output limits, compatibility flags;
- request options: API key/header mode, timeout, retry cap, temperature, cache policy, reasoning level.

Provider errors are redacted before leaving the runtime.
