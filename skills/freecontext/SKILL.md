---
name: freecontext
description: Summarize substantial captured local read or search output before it enters Main's context. Main selects the command and retains diagnosis, edits, and verification.
---

# FreeContext

Use `gather_context` when the next authorized local read/search is likely to return substantial output. Main chooses the command and its intent; FC only extracts evidence from the captured result, without tools or inherited conversation. A small targeted edit-context read can stay native.

Discover the actual FC and native execution tool methods available in the host. In one code-mode cell, capture the native result in a variable, send it to FC, and emit only the FC response. For hosts exposing the following methods, the shape is:

```js
const command = "rg -n -C 3 'parseRows|writeRow' src/import.ts";
const result = await tools.exec_command({ cmd: command });
const summary = await tools.mcp__freecontext__gather_context({
  intent: "Extract the row ordering and duplicate-key behavior, with guards and exceptions.",
  output: JSON.stringify({ command, ...result })
});
text(summary);
```

Use the discovered method names, not an assumed namespace. Keep native command permissions, workspace, timeout and output limits as configured. If execution returns an ongoing session, collect its terminal output inside code mode before summarizing; preserve all captured chunks and status metadata. Never emit the native result or manually copy it through Main. Without code mode, use a host mechanism that captures output outside the model context before calling FC; reading the output first and summarizing later cannot save its first context cost.

The two required strings are `intent` and `output`. Include the original command and native exit/status/truncation metadata in the captured string when available; no nested schema is required. Do not rerun a command because summarization failed. FC saves the supplied capture with its session and returns a reference for precise line-range or byte-range rereads; the capture may itself have been truncated upstream. Short output is returned directly without a model request. Larger captures are sent in full if they fit the configured model context and reserve; otherwise FC fails with the saved capture reference so a smaller segment can be submitted. Provider transient retries remain configured, but FC never starts further investigation.

Expect ordinary assistant text containing relevant original evidence, observed locations, conditions, exceptions and gaps. Main owns interpretation, design, edits and verification, and reads exact edit locations or missing evidence narrowly as needed.
