---
name: freecontext
description: Route complex reads through FreeContext. For multi-file, multi-document, cross-module, long-document, or source-bound work, open this skill alone before repository read/search, then call gather_context first.
---

# FreeContext routing

Prompt-visible discovery shim for the atomic `gather_context` tool.

- Select it before native repository or document read/search when the task requires multi-file evidence, multi-document synthesis, a cross-module call chain, jointly constraining configuration, long-document multi-fact extraction, or source-bound planning, review, or diagnosis.
- Keep direct reads for an exact known implementation that needs one bounded read, or for one or two exact candidates after the tool description's permitted probe.
- Use the exact caller below as the first and only `functions.exec` for this semantic call. Check the direct tool property only; never run a separate tool-catalog lookup or print tool metadata.
- Use the current MCP tool description as the sole eligibility policy; this file deliberately does not restate its four ordered gates.
- Include `knownRefs` (`[]` when none): 0–12 `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}` objects; no `query`/keyword refs. Use 2–5 unique question ids; roles: `implementation`, `caller`, `test`, or `contract`. Never send identity, secrets, or dumps.

```json
{"taskText":"Trace the change.","knownRefs":[{"kind":"path","path":"src/router.ts"}],"evidenceQuestions":[{"id":"implementation","role":"implementation","question":"Where is it implemented?","required":true},{"id":"tests","role":"test","question":"How is it tested?","required":true}]}
```

- After ready/partial, consume evidence and `nextAction`. Treat gaps as negative evidence: before editing, make at most one targeted search. Never repeat searches or replay the call.
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
