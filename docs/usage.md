# Using FreeContext

FreeContext exposes one read-only MCP tool, `gather_context`. Call it for one concrete repository question whose answer crosses multiple non-adjacent owners or relationships. Small exact reads, local failures, edits, tests, and Git remain native to the parent agent.

## Request

The public request is intentionally small:

```json
{
  "question": "Trace cancellation from the route to provider cleanup.",
  "hints": "Optional paths, symbols, or prior findings"
}
```

`hints` is optional. If earlier FreeContext findings matter, put them directly into a new question or hints value.

The worker returns ordinary assistant text directly in the MCP content. Formatting guidance is a prompt hint, not a response schema. The response ends with a visible `Session: <id>` line and may repeat that id in MCP metadata for transport and benchmark association. The private session file stores the invocation record and diagnostic capture.

## Routing

Use `gather_context` when the whole question needs exploratory reads across modules, documents, or relationships. Do not call because a task starts, a phase changes, or the task looks complex. Use native tools when one or two bounded reads answer the whole question.

FreeContext is read-only and cannot edit files, run tests or Git, install packages, use the network, or access credentials. The parent agent owns all changes and verification. Treat returned text as navigation context and verify only decisive locations before acting; do not replay the broad exploration automatically.

## Answer style

The system prompt asks the worker to lead with the answer, keep paths, symbols, numbers, commands, and errors exact, and use concise locations such as `path:line-line — symbol — short fact`. It removes filler, hedging, pleasantries, search narration, decorative tables, raw logs, and long excerpts. It emits plain text, with a short `Unknown` only for an important unresolved fact.
