# Using FreeContext

FreeContext exposes one read-only MCP tool, `gather_context`. Delegate one unresolved code-fact or relationship question when its answer would replace substantial additional repository reading beyond context already seen, after accounting for the small exact edit-context read Main must make anyway. Keep that local read, architecture decisions, the overall diagnosis or fix, small direct checks, edits, tests, and Git with the parent agent.

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

At any phase, judge whether the unresolved relationship needs substantial unfamiliar reading beyond what is already seen, after accounting for the small local edit-context read Main is about to need. If that local read will likely settle it, stay native; if a specific cross-boundary relationship still needs that substantial additional reading, it can be delegated immediately. Do not trace everything first just to decide or call merely because a task starts. For a complex problem, delegate the next uncertain code fact you need, not a feature design or full correctness audit. Include checked facts and any relevant change or failure. Do not repeat a resolved question or call for an obvious local fix.

FreeContext is read-only and cannot edit files, run tests or Git, install packages, use the network, or access credentials. The parent agent owns all changes and verification. Use supported located findings as read context. Main opens exact edit locations and checks missing or contradictory facts, or the new assumption introduced when applying a fact to a design or test, using already-seen evidence first. Do not re-walk source merely because FC provided it; verify as needed. If a call fails, continue directly with native exploration. Dispatch it alone with the first gather cell pragma `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`; if a cell returns, repeat the outer `wait` tool with its `cell_id`, `yield_time_ms` 300000, and `max_tokens` 12000 until terminal, with no native tools during the wait.

## Answer style

The system prompt asks the worker for a decisive factual relationship grounded in a concise observed location: `path:line-line — enclosing function/method or symbol — relevant behavior or relationship`, similar to a readable LSP result. The worker traces the implementation that decides the requested behavior and does not infer semantics from names, types, or call syntax alone. When needed to establish the conclusion, it adds the shortest useful source excerpt plus only the condition or scope relevant to the asked relationship. If exact lines are unavailable, it gives the verified path or symbol and states that limitation. If the question mixes fact and design, it returns factual constraints and leaves choices to Main, without unsolicited design menus, new fields, or recommendations. The answer remains plain text without a required layout or parser; there is no LSP dependency.

Incomplete searches must not become claims that a component is unaffected, a caller is unique, or a design is correct. While continuing with tools, the worker is prompted to leave short, self-contained confirmed findings that remain useful if a later model request fails. This is ordinary assistant text, not a separate checkpoint format; no answer can be guaranteed if the provider never returns useful text.

The default exploration allowance is 16 turns and 36 tool calls. After 360 seconds, the next model-request or tool boundary switches to answering from current findings; an in-flight model request is not interrupted merely to insert the prompt. The whole call remains capped at 600 seconds, with the existing 180-second per-request timeout and bounded retries. These are ceilings, not targets: finish as soon as the question is answered.
