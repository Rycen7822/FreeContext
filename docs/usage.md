# Using FreeContext

FreeContext exposes one read-only MCP tool, `gather_context`. Delegate one unresolved code-fact or relationship question whose answer needs substantial new reading and replaces further investigation. Exact edit-context reads, architecture decisions, the overall diagnosis or fix, small direct checks, edits, tests, and Git remain with the parent agent.

## Request

The public request is intentionally small:

```json
{
  "question": "How is the request timeout passed to the worker, including its default?",
  "hints": "Requirement: a request override wins over the default. Checked: the route reads request.timeout; worker setup is unverified."
}
```

`hints` is optional. FC sees only this request, not the original task or conversation. Include relevant requirements and checked facts, distinguishing them from unverified leads. If earlier FreeContext findings matter, put them directly into a new question or hints value, not the whole conversation.

The worker returns ordinary assistant text directly in the MCP content. Formatting guidance is a prompt hint, not a response schema. The response ends with a visible `Session: <id>` line and may repeat that id in MCP metadata for transport and benchmark association. The private session file stores the invocation record and diagnostic capture.

## Routing

At any phase, judge the unresolved relationship and reading needed for the current question. Stay native when the answer is already in context or needs only a small direct check. Known paths or an exact error do not by themselves make an investigation small. For a complex problem, delegate the next uncertain code fact you need, not a feature design or full correctness audit. Native midtask work can reveal a relationship needing another investigation; a failed test or new module is not required. Include checked facts and any relevant change or failure. Do not repeat a resolved question, call merely because a task starts, or call for an obvious local fix.

FreeContext is read-only and cannot edit files, run tests or Git, install packages, use the network, or access credentials. The parent agent owns all changes and verification. Use supported findings as already-read context, not proof of correctness or completeness. Read precise edit locations and verify decisive claims or uncertainty without replaying the full map. Narrow further reads to the relevant function, branch, or local diff. If a call fails, continue directly with native exploration. Dispatch it alone with the first gather cell pragma `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`; if a cell returns, repeat the outer `wait` tool with its `cell_id`, `yield_time_ms` 300000, and `max_tokens` 12000 until terminal, with no native tools during the wait.

## Answer style

The system prompt asks the worker for a conclusion grounded in concise locations: `path:line-line — enclosing function/method or symbol — relevant behavior or relationship`, similar to a readable LSP result. The worker is instructed to trace through the implementation or relationship that decides the requested behavior and not infer semantics from names, types, or call syntax alone. Locations must be observed, not guessed; unavailable exact lines are stated as a limitation. A short decisive source excerpt, signature, or branch is useful when it lets the caller act or stop tracing without a broad reread. If an important relationship remains unchecked, name it concretely. Facts, proposed changes, and unknowns stay distinct. The answer remains plain text without a required layout or parser; there is no LSP dependency. Filler, repeated maps, raw logs, and long excerpts are omitted.

Incomplete searches must not become claims that a component is unaffected, a caller is unique, or a design is correct. While continuing with tools, the worker is prompted to leave short, self-contained confirmed findings that remain useful if a later model request fails. This is ordinary assistant text, not a separate checkpoint format; no answer can be guaranteed if the provider never returns useful text.

The default exploration allowance is 16 turns and 36 tool calls. After 360 seconds, the next model-request or tool boundary switches to answering from current findings; an in-flight model request is not interrupted merely to insert the prompt. The whole call remains capped at 600 seconds, with the existing 180-second per-request timeout and bounded retries. These are ceilings, not targets: finish as soon as the question is answered.
