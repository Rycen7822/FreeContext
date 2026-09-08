---
name: freecontext
description: Extract relevant evidence from captured local reads, cross-file searches, and logs. Read already-located edit functions or small dense output natively; Main retains diagnosis, edits, and verification.
---

# FreeContext

Use `gather_context` when selecting relevant evidence can replace substantial reading of an authorized local capture: broad initial source reads, cross-file searches, or logs. Core files are eligible too. Read an already-located function or small window natively when its exact text is needed for an edit; small, dense results can also stay native. No call count is required. Main chooses the command and asks for facts, paths, actual source lines, guards and original excerpts, not design review or globally missing implementation. FC has no tools or inherited conversation. When an explicit successful terminal status already answers the verification question, retain that short status without summarizing a long list of successful tests; inspect failures and anomalies as needed.

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
