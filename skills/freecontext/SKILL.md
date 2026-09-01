---
name: freecontext
description: Use before expanding repository reading at any phase when one concrete source-understanding question crosses multiple non-adjacent owners or relationships. Small, exact local checks remain native.
---

# FreeContext routing

At any phase, before expanding repository reading, judge the whole source-understanding question—not just the next file or current phase. Call `tools.mcp__freecontext__gather_context` when that question crosses multiple non-adjacent owners or relationships. Keep one or two known or changed files, exact paths or symbols, and exact compiler/test failures native. A multi-file consistency audit remains multi-file even when its starting paths are already known or changed. Do not call merely because a task starts or looks complex. FreeContext is read-only.

## Request

Send one small object:

```js
{
  question: "Which owners and call paths explain this behavior?",
  hints: "Optional paths, symbols, or prior findings"
}
```

The worker returns ordinary assistant text directly. Treat only facts that hints clearly describe as previously checked as settled; paths and symbols remain leads that may be checked as needed. Treat returned FC facts as already-read navigation context, not automatically correct. Do not repeat the same question or broadly replay exploration; open only positions you will edit, verify decisive or change-critical claims as needed, or use to resolve uncertainty, and keep ownership of edits and checks in the main agent.

Use a differential audit only when hints actually describe prior reads or edits. An initial call or a call with no prior findings should answer the question normally.

If information from an earlier FreeContext call is needed, put it directly into the new `question` or `hints`.

## Dispatch

Call the exact method directly and alone. In the first gather code-mode cell, begin with `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`. Await the terminal result; if it still returns a cell, call the outer `wait` tool with its returned `cell_id`, `yield_time_ms: 300000`, and `max_tokens: 12000`, with no native tools during the wait. If the call fails, continue directly with native exploration and do not repeat the same question. The answer may contain precise `path:line-line — symbol — fact` notes, but wording is not validated and there is no submission step.
