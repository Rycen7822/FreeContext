---
name: freecontext
description: For complex multi-file, multi-document, cross-module, long-document, or source-bound reads, the first tool cell must only read this SKILL.md—no pwd/rg/fd/Git/plan/catalog. The next cell directly calls tools.mcp__freecontext__gather_context.
---

# FreeContext routing

- Use before native reads/searches for multi-file/document evidence, cross-module chains, joint config, long-document extraction, or source-bound work.
- Direct-read only for one known bounded implementation or 1–2 exact post-probe candidates.
- First tool cell: read only this file—never append pwd, rg, fd, Git, plan, catalog, or repo actions. Next cell directly calls `tools.mcp__freecontext__gather_context`; never inspect a tool catalog first.
- Args: `knownRefs` (`[]` when none) accepts 0–12 path, symbol, or stack refs. Code tasks use four required outcome questions—implementation, caller, contract, tests—with `minimumSpans` 2/2/1/1; keep other constraints in `taskText`, not six shallow questions. Other tasks use 2–6 questions; omitted `minimumSpans` means 1. Contract role requires a named API/schema/spec/compatibility rule. No identities, secrets, dumps, or query refs.

```json
{"taskText":"Trace the change.","knownRefs":[],"evidenceQuestions":[{"id":"implementation","role":"implementation","question":"Entry and state owners?","required":true,"minimumSpans":2},{"id":"application","role":"caller","question":"Consumers and behavior?","required":true,"minimumSpans":2},{"id":"contract","role":"contract","question":"Compatibility contract?","required":true},{"id":"tests","role":"test","question":"Focused tests?","required":true}]}
```

- Summaries are not reads. Next repository cell reads every Evidence range in one `Promise.all` of literal `tools.exec_command({cmd:"..."})` calls—no arrays/maps, widening, or other action. Ready then edits directly. For partial, run at most one narrow native search batch for only the named gaps after that read cell; never call FreeContext again or broad-discover.
- If unavailable, use native read-only tools and say so.

Use this exact caller after constructing `args`:

```js
if (typeof tools.mcp__freecontext__gather_context !== "function") {
  throw new Error("FreeContext MCP tool is unavailable.");
}
const reminder = setTimeout(() => {
  notify("FreeContext is still running. Do not call it again; wait for this cell until the terminal result.");
}, 8_000);
try {
  const result = await tools.mcp__freecontext__gather_context(args);
  const terminalTexts = result?.content?.filter((item) => item?.type === "text") ?? [];
  if (terminalTexts.length !== 1 || typeof terminalTexts[0].text !== "string") {
    throw new Error("FreeContext returned no unique terminal text result.");
  }
  text(terminalTexts[0].text);
} finally {
  clearTimeout(reminder);
}
```

If `functions.exec` yields a cell ID, call `functions.wait({ cell_id, yield_time_ms: 300000, max_tokens: 10000 })` exactly once next. While pending, never recall FreeContext, wait twice, inspect private sessions, or stringify results. A slow call emits one timer notice at most. FreeContext installs no waiting Hook.
