---
name: freecontext
description: Delegate complex multi-file/document, cross-module, long-document, or source-bound exploration to gather_context first. Reenter before a second search batch or third unrelated path; don't reread it.
---

# FreeContext routing

- Initial: before native exploration of multiple files/documents, cross-module chains, joint config, long documents, or source-bound work.
- Reenter for a new multi-role/module or cross-document issue, before a second search batch or third distinct non-evidence/non-edited path, or when one exact read cannot explain a test failure.
- Direct only: changed hunk, Git diff/status, tests/checks, one failure location, 1–2 exact candidates, or one no-source path/symbol probe. Results of 0 or 3–6 require FreeContext.
- First cell reads only this file; next call `tools.mcp__freecontext__gather_context`. No pwd/rg/fd/Git/plan/catalog/repo action.
- Args (0–12 refs): `{taskText,evidenceQuestions:[{id,role,question,required,minimumSpans}],knownRefs:[{kind:"path",path}|{kind:"symbol",symbol,path?}|{kind:"stack",path,line}]}`. No `questions`, string refs, secrets, or dumps. Required `minimumSpans` sum is at most 6. Initial uses required implementation/caller/contract/test questions with `minimumSpans` 2/2/1/1; other initial uses 2–6. Reentrant uses 1–4 new questions plus edited/failure/confirmed refs. After `partial`, consume its Evidence; then copy only unresolved question objects without rewriting and add every returned evidence path to `knownRefs`.
- Summaries are not reads. After each result, the next repository cell reads every exact Evidence range in one `Promise.all` of literal `tools.exec_command({cmd:"..."})` calls. No generated arrays, loops, `map`, variables, or command-level `for`. Then edit/test; if more exploration is needed, call FreeContext before any non-evidence read or search. Each episode has one main call; only `partial` permits one gap-only follow-up, with no third invocation in that episode. `ready` covers only its invocation. After `not_found`/`failed`, make one exact path or symbol probe at most, never broad search, then reapply eligibility.
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
