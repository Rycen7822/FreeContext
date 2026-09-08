---
name: freecontext
description: Summarize captured local read or search output when filtering can replace most reading. Keep core exact-edit code and small dense output native; Main retains diagnosis, edits, and verification.
---

# FreeContext

Use `gather_context` when filtering the next authorized local read/search can replace reading most of its output, such as a broad search result or log with a few relevant facts. Choose by reading replaced, not length alone: read core code needed for precise edits and small, dense output natively. No call is required. Main chooses the command and asks for observable facts, paths, source lines, errors or excerpts in that capture, not a design review or a judgment about globally missing implementation. FC has no tools or inherited conversation.

Discover the actual FC and native execution tool methods available in the host. In one code-mode cell, capture the native result in a variable, send it to FC, and emit only the FC response. For hosts exposing the following methods, the shape is:

```js
// @exec: {"yield_time_ms": 300000, "max_output_tokens": 12000}
const command = "rg -n -C 3 'parseRows|writeRow' src/import.ts";
const result = await tools.exec_command({ cmd: command });
const summary = await tools.mcp__freecontext__gather_context({
  intent: "Extract the shown row-ordering and duplicate-key branches, with their paths, source lines and guards.",
  output: JSON.stringify({ command, ...result })
});
text(summary);
```

The example uses Codex's supported 300000 ms initial yield. If the outer cell returns running, call the host's existing outer `wait` with `{"cell_id":"<the returned cell ID>","yield_time_ms":300000,"max_tokens":12000}`. If it is still running, repeat that long wait with the same cell ID until FC returns success or a real failure; do not impose an arbitrary wait-count limit. On other hosts, use the long yield and wait values their exposed interfaces support. While FC is pending, do not explore natively, edit, or reread the captured material. An intermediate yield or empty output is not failure: do not cancel or use one-second polling. Respect actual provider/FC deadlines and user cancellation; a terminal failure ends this wait.

Use the discovered method names, not an assumed namespace. Keep native command permissions, workspace, timeout and output limits as configured. If execution returns an ongoing session, collect its terminal output inside code mode before summarizing; preserve all captured chunks and status metadata. Never emit the native result or manually copy it through Main. Without code mode, use a host mechanism that captures output outside the model context before calling FC; reading the output first and summarizing later cannot save its first context cost.

The two required strings are `intent` and `output`. Include the original command and native exit/status/truncation metadata in the captured string when available; no nested schema is required. Do not rerun a command because summarization failed. FC saves the supplied capture with its session and returns a reference for precise line-range or byte-range rereads; the capture may itself have been truncated upstream. Short output is returned directly without a model request. Larger captures are sent in full if they fit the configured model context and reserve; otherwise FC fails with the saved capture reference so a smaller segment can be submitted. Provider transient retries remain configured, but FC never starts further investigation.

Expect ordinary assistant text containing relevant original evidence, observed locations, conditions, exceptions and gaps; no strict response format is required. Reuse supported facts without routinely rereading every returned file. Main owns interpretation, design, edits and verification, and reads exact edit locations, gaps, contradictions or new premises narrowly as needed. Preserve necessary tests.
