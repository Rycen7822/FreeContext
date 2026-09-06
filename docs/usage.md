# Using FreeContext

FreeContext exposes one read-only MCP tool, `gather_context`. Delegate a concrete investigation that needs substantial new reading or relationship tracing. Small direct checks, edits, tests, and Git remain native to the parent agent.

## Request

The public request is intentionally small:

```json
{
  "question": "Does cancellation reach every resource cleanup path? Identify gaps and exact code locations.",
  "hints": "Requirement: release each resource once. Already checked: the route forwards the signal; worker cleanup is unverified."
}
```

`hints` is optional. FC sees only this request, not the original task or conversation. Include relevant requirements and checked facts, distinguishing them from unverified leads. If earlier FreeContext findings matter, put them directly into a new question or hints value, not the whole conversation.

The worker returns ordinary assistant text directly in the MCP content. Formatting guidance is a prompt hint, not a response schema. The response ends with a visible `Session: <id>` line and may repeat that id in MCP metadata for transport and benchmark association. The private session file stores the invocation record and diagnostic capture.

## Routing

At any phase, judge how much new information the whole question needs. Stay native when the answer is already in context or needs only a small direct check. Known paths, one or two files, and an exact error location do not by themselves make an investigation small. Ask FC to resolve the behavior or missing relationship, not just list files; do not call merely because a task starts. A test or edit can expose a narrower new question about the same feature: include the new evidence and earlier findings rather than repeating a resolved question. Obvious local fixes do not require another call.

FreeContext is read-only and cannot edit files, run tests or Git, install packages, use the network, or access credentials. The parent agent owns all changes and verification. Use returned facts as already-read investigation context, not automatically correct. Read precise edit locations and verify decisive claims or unresolved uncertainty without replaying the full map. Narrow truncated or overlapping reads to relevant functions, branches, or local diffs; delegate remaining investigation instead of repeatedly expanding whole files. Use a differential audit only when hints describe prior reads or edits; without prior findings, answer normally. If a call fails, continue directly with native exploration. Dispatch it alone with the first gather cell pragma `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`; if a cell returns, call the outer `wait` tool with its `cell_id`, `yield_time_ms` 300000, and `max_tokens` 12000, with no native tools during the wait.

## Answer style

The system prompt asks for a conclusion grounded in concise locations: `path:line-line — enclosing function/method or symbol — relevant behavior or relationship`, similar to a readable LSP result. Locations must be observed, not guessed; unavailable exact lines are stated as a limitation. A short signature or decisive branch excerpt is useful when it saves a broad reread. Facts, proposed changes, and unknowns stay distinct. The answer remains plain text without a required layout or parser; there is no LSP dependency. Filler, repeated maps, raw logs, and long excerpts are omitted.
