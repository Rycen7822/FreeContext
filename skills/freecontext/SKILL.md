---
name: freecontext
description: For complex multi-file/document, cross-module, long-document, or source-bound exploration, first read only this skill, then call gather_context. Reenter before a second search batch or third unrelated path; do not reread the skill.
---

# FreeContext routing

- Initial call: before native exploration for multi-file/document evidence, cross-module chains, joint config, long documents, or source-bound work.
- Reenter for a new multi-role/module or cross-document issue, before a second search batch or third distinct non-evidence/non-edited path, or when one exact read cannot explain a test failure.
- Direct only: changed hunk, Git diff/status, tests/checks, one failure location, 1–2 exact candidates, or one no-source path/symbol probe. Results of 0 or 3–6 require FreeContext.
- First tool cell reads only this file—no pwd/rg/fd/Git/plan/catalog/repo action. Next call `tools.mcp__freecontext__gather_context`. Episodes call it directly.
- Args: 0–12 path/symbol/stack `knownRefs`; no secrets/dumps/identities/query refs. Initial code uses required implementation/caller/contract/test questions with `minimumSpans` 2/2/1/1, not six shallow questions; other initial calls use 2–6. Reentrant calls use 1–4 new questions plus edited/failure/confirmed paths. Gap follow-up uses exactly its unresolved questions and returned paths. Contract asks for a named API/schema/spec.

- Summaries are not reads. After each result, the next repository cell reads every exact Evidence range in one `Promise.all` of literal `tools.exec_command({cmd:"..."})` calls and nothing else. Each episode has one main call; only `partial` permits one gap-only follow-up, with no third invocation in that episode. `ready` covers only its invocation. Later triggers start new episodes. After `not_found`/`failed`, make one exact probe at most, then reapply eligibility.
- If unavailable, use native read-only tools and say so.

Use this exact caller after constructing `args`:

```js
if (typeof tools.mcp__freecontext__gather_context !== "function") {
  throw new Error("FreeContext MCP tool is unavailable.");
}
const reminder = setTimeout(() => {
  notify("FreeContext is still running. Do not replay this call; wait for its terminal result.");
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

If `functions.exec` yields a cell ID, next call `functions.wait({ cell_id, yield_time_ms: 300000, max_tokens: 10000 })` once. While pending, never replay, wait twice, or inspect sessions. FreeContext installs no waiting Hook.
