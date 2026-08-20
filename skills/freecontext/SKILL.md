---
name: freecontext
description: For complex multi-file, multi-document, cross-module, long-document, or source-bound reads, the first tool cell must only read this SKILL.md—no pwd/rg/fd/Git/plan/catalog. The next cell directly calls tools.mcp__freecontext__gather_context.
---

# FreeContext routing

- Use before native reads/searches for multi-file/document evidence, cross-module chains, joint config, long-document extraction, or source-bound work.
- Direct-read only for one known bounded implementation or 1–2 exact post-probe candidates.
- First tool cell: read only this file—never append pwd, rg, fd, Git, plan, catalog, or repo actions. Next cell directly calls `tools.mcp__freecontext__gather_context`; never inspect a tool catalog first.
- Include `knownRefs` (`[]` when none): 0–12 `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}`; no query refs. Code changes use all 6 ids—parse, catalog, apply, span, metric, test—one independent decision each; never combine clauses or role buckets. Other work uses 2–6. Roles: `implementation`, `caller`, `test`, `contract`; contract only for a task/knownRefs-named API/schema/spec/compatibility source. No identity/secrets/dumps.

```json
{"taskText":"Trace the change.","knownRefs":[],"evidenceQuestions":[{"id":"parser","role":"implementation","question":"Where is input parsed?","required":true},{"id":"application","role":"caller","question":"Where is parsed state applied?","required":true},{"id":"tests","role":"test","question":"Which tests assert it?","required":true}]}
```

- Summaries are not reads. Next repository cell reads every Evidence range in one `Promise.all` of literal `tools.exec_command({cmd:"..."})` calls—no command arrays/maps, widening, or other action. Then ready edits directly; partial permits one targeted named-gap search batch. Never broad-discover or replay.
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

If `functions.exec` yields `Script running with cell ID ...`, make exactly one next top-level call: `functions.wait({ cell_id, yield_time_ms: 300000, max_tokens: 10000 })`. Consume the terminal output. Never call FreeContext again, wait twice, repeat status checks, read a private session, or stringify the result. Fast completion emits no reminder; a slow call emits at most one timer notification. FreeContext installs no waiting Hook.
