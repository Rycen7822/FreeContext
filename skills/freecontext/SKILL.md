---
name: freecontext
description: Use before repository exploration when one concrete question is expected to cross multiple non-adjacent owners or relationships. Small, exact local checks remain native.
---

# FreeContext routing

Call `tools.mcp__freecontext__gather_context` when the whole next source-understanding question crosses multiple non-adjacent owners or relationships. Use native tools for exact paths, symbols, local failures, edits, tests, Git, and one or two bounded reads. Do not call merely because a task starts or looks complex. FreeContext is read-only.

## Request

Send one small object:

```js
{
  question: "Which owners and call paths explain this behavior?",
  hints: "Optional paths, symbols, or prior findings"
}
```

The worker returns ordinary assistant text directly. Treat it as useful context, not as a response schema or item limit. Consume the answer, verify only positions that matter, and keep ownership of edits and checks in the main agent.

If information from an earlier FreeContext call is needed, put it directly into the new `question` or `hints`.

## Dispatch

Call the exact method directly and alone. Await its terminal result. The answer may contain precise `path:line-line — symbol — fact` notes, but wording is not validated and there is no submission step.
