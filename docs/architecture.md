# Architecture

## Scope

FreeContext performs one operation: read-only repository exploration for a parent coding agent. The public boundary accepts `{question, hints?}`. The worker's ordinary assistant text is returned directly; no result schema sits between worker and parent.

## Runtime layers

1. **Codex skill**
   - Routes one concrete cross-module or cross-document question to `gather_context`.
   - Keeps exact local reads, edits, tests, Git, and direct failures in the main agent.
   - Passes optional paths, symbols, or prior findings as `hints`.

2. **MCP and CLI boundary**
   - Validates only the small request object.
   - Resolves one workspace and binds each call to a private invocation/session.
   - Emits one text content item ending with a visible `Session: <id>` handle and may repeat the id in metadata. Failed calls use the MCP error bit; worker wording is not parsed.

3. **Pi worker**
   - Resolves the configured provider route, model, request options, and bounded read-only tools.
   - Uses `runAgentLoop` for exploration and the same loop context for soft finalization.
   - Enforces turn/tool budgets, records useful reads privately, and retries provider failures only when no useful answer exists.

4. **Read-only tool layer**
   - `read` and `bat` return bounded line ranges; `rg` searches repository text; `glob` discovers paths; `jq` queries one JSON file.
   - Native subprocess execution remains confined to `src/tools/process.ts` with `shell: false`.

## Configuration and routing

The default catalog is `$XDG_CONFIG_HOME/freecontext/config.toml`, falling back to `~/.config/freecontext/config.toml`. `--config` overrides `FREECONTEXT_CONFIG`, which overrides that default. TOML separates providers, models, routes, and shared runtime limits. Credentials and sensitive headers never enter prompts or private captures.

The route resolver may try a later target only for an allowed transient provider failure before useful text or accepted tool work exists. Provider errors are redacted before they leave the runtime. Model context compaction is an internal optimization, not a result-format stage.

## Context and session records

The worker receives its own search transcript and tool outputs. The parent receives only the final text. A committed private session keeps the request, invocation identity, result text, and diagnostic capture for transport, debugging, and benchmark association. If earlier findings matter, the parent places them directly in a new question or hints.

## Soft finalization and failure

When the soft deadline fires, the active batch finishes, then the same worker receives a prompt to stop using tools and answer from current findings. The prompt requires exact paths/symbols/numbers/commands/errors and compact prose, but the returned text is accepted as-is. If a later provider error follows useful streamed assistant text, that latest useful text is retained and delivered as partial output; it is never replaced by an empty failure.

## Runtime metrics

Private metrics cover route/session timings, provider attempts, tool calls, compaction, and aggregate token usage. They do not define or validate the public answer. Public MCP output remains one ordinary text item plus an optional session handle.
