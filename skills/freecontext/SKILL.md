---
name: freecontext
description: Delegate a concrete repository investigation at any phase when answering it requires substantial new reading or tracing relationships. Small direct checks remain native.
---

# FreeContext routing

At any phase, judge how much new information the whole source-understanding question needs—not just the next file. Call `tools.mcp__freecontext__gather_context` to resolve a concrete behavior, constraint, or missing relationship when it requires substantial reading. Stay native when the answer is already in context or only a small direct check is needed. Known paths, one or two files, or an exact error location do not by themselves make an investigation small. Do not call merely because a task starts. FreeContext is read-only.

## Request

Send one small object:

```js
{
  question: "Does cancellation reach every resource cleanup path? Identify gaps and exact code locations.",
  hints: "Requirement: release each resource once. Already checked: the route forwards the signal; worker cleanup is unverified."
}
```

Delegate the question that would otherwise cost you substantial reading, not just a file inventory. FC sees only `question` and optional `hints`, not your original task or conversation. Include the relevant task constraints and checked facts, distinguishing them from unverified leads; do not forward the whole conversation.

The worker returns ordinary assistant text: a conclusion with concise `path:line-line — function or symbol — relevant fact` locations where verified. Use it as already-read investigation context, not automatically correct. Open precise edit locations and verify decisive claims or unresolved uncertainty without replaying the full map. If reads are truncated or overlapping, narrow to the needed function, branch, or local diff; delegate remaining investigation rather than repeatedly expanding whole files. Keep edits and checks in the main agent.

Use a differential audit only when hints actually describe prior reads or edits. An initial call or a call with no prior findings should answer the question normally.

A test or edit can expose a narrower new question about the same feature; that is not repeating a resolved question. Include the new evidence and relevant earlier findings in `question` or `hints`. Do not ask an unchanged question again or force another call for an obvious local fix.

## Dispatch

Call the exact method directly and alone. In the first gather code-mode cell, begin with `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`. Await the terminal result; if it still returns a cell, call the outer `wait` tool with its returned `cell_id`, `yield_time_ms: 300000`, and `max_tokens: 12000`, with no native tools during the wait. If the call fails, continue directly with native exploration and do not repeat the same question.
