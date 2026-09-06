---
name: freecontext
description: Delegate a bounded code-fact or relationship question at any phase when it needs substantial new reading. Keep design decisions, edits, tests, and small direct checks in the main agent.
---

# FreeContext routing

At any phase, judge how much new reading the current question needs—not just the next file. Call `tools.mcp__freecontext__gather_context` for a bounded factual investigation such as tracing one value or checking a caller/consumer relationship. Keep architecture decisions and the overall diagnosis or fix yourself; do not ask FC to design the feature or certify the whole implementation. Stay native when the answer is already in context or needs only a small direct check. Known paths or an exact error do not by themselves make an investigation small. Do not call merely because a task starts. FreeContext is read-only.

## Request

Send one small object:

```js
{
  question: "How is the request timeout passed to the worker, including its default?",
  hints: "Requirement: a request override wins over the default. Checked: the route reads request.timeout; worker setup is unverified."
}
```

Delegate one concrete question that would otherwise cost you substantial reading, not a file inventory or a long checklist of requirements to audit. For a complex problem, choose the next uncertain code fact you need to decide what to do. FC sees only `question` and optional `hints`, not your original task or conversation. Include the relevant requirements, checked facts, and specific error when useful; distinguish unverified leads and do not forward the whole conversation.

The worker returns ordinary assistant text with located findings and important unknowns. Use supported facts as already-read context, not automatic proof of correctness or completeness. Open precise edit locations and verify decisive claims or uncertainty without replaying the full map. If you still need context, read the relevant function, branch, or local diff instead of reloading whole files. Keep edits and checks in the main agent.

A test or edit can contradict your current understanding. If resolving that contradiction needs substantial new reading, delegate one specific relationship to investigate, with the relevant change and failure; this can concern the same feature as an earlier call. Do not ask for a full re-audit, repeat a resolved question, or call for an obvious local fix.

## Dispatch

Call the exact method directly and alone. In the first gather code-mode cell, begin with `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`. Await the terminal result; if it still returns a cell, call the outer `wait` tool with its returned `cell_id`, `yield_time_ms: 300000`, and `max_tokens: 12000`, with no native tools during the wait. If the call fails, continue directly with native exploration and do not repeat the same question.
