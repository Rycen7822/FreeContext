---
name: freecontext
description: For complex multi-file, multi-document, cross-module, long-document, or source-bound reads, the first tool cell must only read this SKILL.md—no pwd/rg/fd/Git/plan/catalog. The next cell directly calls tools.mcp__freecontext__gather_context.
---

# FreeContext routing

- Select before native reads/searches for multi-file/document evidence, cross-module chains, jointly constraining config, long-document extraction, or source-bound planning/review/diagnosis.
- Direct-read only when one known bounded implementation suffices, or 1–2 exact candidates after the probe.
- First tool cell: read only this file—never append pwd, rg, fd, Git, plan, catalog, or repo actions. Next cell directly calls `tools.mcp__freecontext__gather_context`; never inspect a tool catalog first.
- Include `knownRefs` (`[]` when none): 0–12 `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}`; no query refs. Code changes use all 6 ids—parse, catalog, apply, span, metric, test—one independent decision each; never combine clauses or role buckets. Other work uses 2–6. Roles: `implementation`, `caller`, `test`, `contract`; contract only for a task/knownRefs-named API/schema/spec/compatibility source. No identity/secrets/dumps.

```json
{"taskText":"Trace the change.","knownRefs":[],"evidenceQuestions":[{"id":"parser","role":"implementation","question":"Where is input parsed?","required":true},{"id":"application","role":"caller","question":"Where is parsed state applied?","required":true},{"id":"tests","role":"test","question":"Which tests assert it?","required":true}]}
```

- Summaries are not reads. Next repository cell reads exactly every Evidence range—no widening or other action. Then ready edits directly; partial permits one separate targeted named-gap search batch. Never broad-discover or replay.
- If unavailable, continue with native read-only tools and say so.

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

If that `functions.exec` yields `Script running with cell ID ...`, make exactly one next top-level call: `functions.wait({ cell_id, yield_time_ms: 300000, max_tokens: 10000 })`. Consume its terminal output immediately. Never invoke FreeContext again, wait twice, make repeated status checks, read a private session to reconstruct output, or stringify the whole result. Fast completion emits no reminder; a slow call emits at most the one timer notification. FreeContext installs no waiting Hook.
