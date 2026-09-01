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

At any phase, before expanding repository reading, judge the whole source-understanding question. Use `gather_context` when it crosses multiple non-adjacent owners or relationships. One or two known or changed files and exact compiler/test failures remain native; known paths do not make a multi-file consistency audit local. Only facts that hints clearly describe as previously checked are settled; paths and symbols are leads. Do not repeat the same question: a later call must address a genuinely new gap.

FreeContext is read-only and cannot edit files, run tests or Git, install packages, use the network, or access credentials. The parent agent owns all changes and verification. Treat returned FC facts as already-read navigation context, not automatically correct; open only locations that will be edited, verify decisive or change-critical claims as needed, or resolve uncertainty, and do not broadly replay exploration. Use a differential audit only when hints describe prior reads or edits; without prior findings, answer normally. If a call fails, continue directly with native exploration. Dispatch it alone with the first gather cell pragma `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`; if a cell returns, call the outer `wait` tool with its `cell_id`, `yield_time_ms` 300000, and `max_tokens` 12000, with no native tools during the wait.

## Answer style

The system prompt asks the worker to lead with the answer, keep paths, symbols, numbers, commands, and errors exact, and use concise locations such as `path:line-line — symbol — short fact`. It removes filler, hedging, pleasantries, search narration, decorative tables, raw logs, and long excerpts. It emits plain text, with a short `Unknown` only for an important unresolved fact.
