---
name: freecontext
description: Route complex reads through FreeContext. For multi-file, multi-document, cross-module, long-document, or source-bound work, open this skill alone before repository read/search, then call gather_context first.
---

# FreeContext routing

- Select before native repository/document read/search for multi-file evidence, multi-document synthesis, cross-module call chains, jointly constraining config, long-document multi-fact extraction, or source-bound planning, review, or diagnosis.
- Direct-read an exact known implementation when one bounded read suffices, or 1–2 exact candidates after the permitted probe.
- Use this caller as first and only `functions.exec`; never query catalogs or print metadata.
- Tool description sets eligibility; do not repeat its gates.
- Include `knownRefs` (`[]` when none): 0–12 `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}`; no query refs. Use 2–5 unique ids, one per editable facet (parse, apply, metric, test), never role-wide buckets; roles are `implementation`, `caller`, `test`, or `contract`. Contract only if task/knownRefs names an existing API/schema/spec/compatibility source, never inferred from new behavior or another role. No identity/secrets/dumps.

```json
{"taskText":"Trace the change.","knownRefs":[],"evidenceQuestions":[{"id":"parser","role":"implementation","question":"Where is input parsed?","required":true},{"id":"application","role":"caller","question":"Where is parsed state applied?","required":true},{"id":"tests","role":"test","question":"Which tests assert it?","required":true}]}
```

- Summaries are not reads. Next repository cell: evidence reads only, including `nextAction`; no other action. Then ready edits without pre-edit search; partial gets at most one targeted named-gap search batch before edit. Never use broad discovery or replay.
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
