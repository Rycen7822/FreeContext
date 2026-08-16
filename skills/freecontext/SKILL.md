---
name: freecontext
description: Route complex reads through FreeContext. For multi-file, multi-document, cross-module, long-document, or source-bound work, open this skill alone before repository read/search, then call gather_context first.
---

# FreeContext routing

- Select it before native repository or document read/search when the task requires multi-file evidence, multi-document synthesis, a cross-module call chain, jointly constraining configuration, long-document multi-fact extraction, or source-bound planning, review, or diagnosis.
- Keep direct reads for an exact known implementation that needs one bounded read, or for one or two exact candidates after the tool description's permitted probe.
- Use the caller below as this semantic call's first and only `functions.exec`. Check the direct tool property; never query catalogs or print metadata.
- Use the MCP tool description as the sole eligibility policy; this file deliberately does not restate its four ordered gates.
- Include `knownRefs` (`[]` when none): 0–12 `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}` objects; no query refs. Use 2–5 unique ids with roles `implementation`, `caller`, `test`, or `contract`; contract requires a distinct existing repository source, not requested new behavior. Never send identity, secrets, or dumps.

```json
{"taskText":"Trace the change.","knownRefs":[{"kind":"path","path":"src/router.ts"}],"evidenceQuestions":[{"id":"implementation","role":"implementation","question":"Where is it implemented?","required":true},{"id":"tests","role":"test","question":"How is it tested?","required":true}]}
```

- Summaries are not reads. Next repository cell: evidence reads only, including `nextAction`; no plan, branch, status, or search. Then partial gets one targeted named-gap search batch; ready none. Never use broad discovery or replay.
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
