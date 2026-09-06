---
name: freecontext
description: Delegate one unresolved code-fact or relationship question at any phase when answering it needs substantial new reading. Keep edit-context reads, design decisions, edits, tests, and small syntax/type/patch checks in the main agent.
---

# FreeContext routing

At any phase, call `tools.mcp__freecontext__gather_context` for one unresolved code fact or relationship when answering it needs substantial new reading, such as tracing one value or checking a caller/consumer relationship. Keep architecture decisions and the overall diagnosis or fix yourself; do not ask FC to design the feature or certify the whole implementation. Stay native when the answer is already in context or needs only a small direct check. Known paths or an exact error do not by themselves make an investigation small. Midtask native work can reveal an eligible unknown. FreeContext is read-only.

## Request

Send one small object:

```js
{
  question: "How is the request timeout passed to the worker, including its default?",
  hints: "Requirement: a request override wins over the default. Checked: the route reads request.timeout; worker setup is unverified."
}
```

Delegate one concrete unresolved question whose answer would replace substantial further reading, not a file inventory or a long checklist of requirements to audit. For a complex problem, choose the next uncertain code fact or relationship needed to decide what to do. FC sees only `question` and optional `hints`, not your original task or conversation. Include relevant requirements, checked facts, and a specific error when useful; distinguish unverified leads and do not forward the whole conversation.

Expect the worker to trace the implementation or relationship that decides the requested behavior and return ordinary assistant text with a conclusion, located findings, and important unknowns. It should include a short decisive source excerpt, location, or symbol when needed so the caller can stop tracing rather than infer semantics from names, types, or call syntax. Use supported facts as already-read context, not automatic proof of correctness or completeness. Open precise edit locations and verify decisive claims or uncertainty without replaying the full map. If you still need context, read the relevant function, branch, or local diff instead of reloading whole files. Keep exact edit-context reads, edits, and checks in the main agent.

Native work can reveal an unresolved relationship at any point. If resolving it needs substantial new reading, delegate that question with checked facts and any relevant change or failure; this can concern the same feature as an earlier call, and does not require a failed test or a new module. Do not ask for a full re-audit, repeat a resolved question, or call for an obvious local fix.

## Dispatch

Call the exact method directly and alone. In the first gather code-mode cell, begin with `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`. Await the terminal result; if it still returns a cell, call the outer `wait` tool with its returned `cell_id`, `yield_time_ms: 300000`, and `max_tokens: 12000`, with no native tools during the wait. If the call fails, continue directly with native exploration and do not repeat the same question.
