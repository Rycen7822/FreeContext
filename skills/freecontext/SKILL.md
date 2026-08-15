---
name: freecontext
description: Manual FreeContext compatibility bridge. Use only when the user explicitly requests FreeContext or when diagnosing an unavailable gather_context MCP tool; never auto-trigger for ordinary exploration or document search.
---

# FreeContext routing

This skill is only a manual compatibility bridge to `gather_context`; it is not the ordinary exploration route, eligibility policy, or CLI fallback.

- Use this skill only after an explicit user request for FreeContext or while diagnosing why the MCP tool is unavailable. Never select it automatically for repository exploration, multi-document search, long-document extraction, planning, review, or diagnosis.
- Locate exactly `mcp__freecontext__gather_context` in `ALL_TOOLS` and invoke it once in that same `functions.exec`; do not list or output the full catalog.
- Use the current MCP tool description as the sole eligibility policy; this file deliberately does not restate its four ordered gates.
- Pass only `taskText`, `knownRefs`, and 2–5 typed `evidenceQuestions`. FreeContext binds invocation, call, workspace, revision, and session facts from public MCP context. Do not send identity fields, secrets, or source dumps.
- After a ready or partial result, read the returned `nextAction` span before broader exploration. Address a material gap with the named targeted action; never replay the same request.
- If the MCP tool is unavailable, continue with native read-only tools and state that FreeContext was unavailable; do not use any CLI fallback.

Use this exact caller after constructing `args`:

```js
if (!ALL_TOOLS.some(({ name }) => name === "mcp__freecontext__gather_context")) {
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
