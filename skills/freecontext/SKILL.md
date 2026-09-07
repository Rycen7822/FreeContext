---
name: freecontext
description: Delegate an unresolved repository fact or relationship that would otherwise require substantial new reading. Keep local reads, design, edits, and tests in the main agent.
---

# FreeContext routing

At any phase, use read-only `tools.mcp__freecontext__gather_context` for one unresolved fact or relationship when its answer can replace substantial new reading. If the small edit-context read Main needs anyway can settle it, stay native. Delegate a useful cross-boundary question as it emerges; do not finish the investigation first, request a recap of already-read code, or call routinely at task start. Keep overall diagnosis, design, edits, tests, and local fixes in Main.

## Request

Send one small object:

```js
{
  question: "How does the import pipeline handle duplicate rows on the way to storage?",
  hints: "Replacing per-row writes with a batch must preserve last-row-wins behavior. Checked: parseRows preserves input order. Unknown: where deduplication occurs; batch equivalence is unverified."
}
```

FC sees only `question` and optional `hints`, not the original task or conversation. Include the original operation and semantics to preserve, relevant checked facts, and the remaining unknown; label proposed changes and unverified assumptions. Ask for the next needed relationship, not a feature design, file inventory, or full audit.

Expect ordinary assistant text with supported facts, observed `path:line` locations plus function or symbol, and conditions that affect their use, plus a short source excerpt when needed. Design choices remain with Main.

Treat supported located facts as already-read context. Read exact edit locations and narrowly check missing or contradictory evidence or a new design/test premise, using existing evidence first. New cross-boundary questions can be delegated during work, including on the same feature; no failed test, new module, or call count is required.

## Dispatch

Call the exact method directly and alone. In the first gather code-mode cell, begin with `// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}`. Await the terminal result; if it still returns a cell, call the outer `wait` tool with its returned `cell_id`, `yield_time_ms: 300000`, and `max_tokens: 12000`, with no native tools during the wait. If the call fails, continue directly with native exploration and do not repeat the same question.
