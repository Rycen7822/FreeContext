---
name: freecontext
description: Delegate multi-file, cross-module, long-document, multi-document, or source-bound exploration to gather_context; follow its structured nextAction and continuation contract.
---

1. Eligibility: call FC before native work for multi-file/cross-module, multi-keyword/document, long-document, or source-bound tasks.
2. Request: read this file first; the next cell calls `tools.mcp__freecontext__gather_context` alone. Never parallelize or batch. During dispatch do no native or other tool work. Caller fields: `taskText`, `workUnit`, `evidenceQuestions`, `knownRefs(path/symbol/stack)`; copy this valid edit shape: `const args={taskText:"Request.",workUnit:{outcome:"edit",goal:"Change goal."},knownRefs:[],evidenceQuestions:[{role:"implementation",question:"Where is the existing owner or seam?",required:true,target:{id:"owner",subject:{kind:"topic",topic:"existing owner or seam"},factKind:"location",coverageMode:"single"}}]};`. Edit uses `outcome="edit"` with the current goal. Default 2–4 concrete `single` targets; `exhaustive` only for an explicit complete enumeration. New behavior asks the nearest owner/seam/caller/test; do not assume a new symbol. With path refs, read exact references first; only a bounded parent probe precedes reads. No broad/root glob/rg first pass; search output is unobserved. Main agent owns edits, checks, Git, packages, and web.
3. Terminal: `ready`/`partial` include a handoff. Consume inline Evidence/`nextAction` directly. Before first edit/check do not reread covered content; allow one cited-adjacent read only if critical context is omitted. Broader discovery calls FC. If a cell ID returns, only call `functions.wait({cell_id,yield_time_ms:300000,max_tokens:10000})`; repeat pending; do no other work.
4. Reenter only for an Evidence/edit/check blocker: `{reentry:{priorHandoff:<exact result.handoff>,blockingGap:{id,targetId,kind,scope,requiredFact,origin}}}`. Copy `priorHandoff` verbatim and its `workUnit` exactly. Origin is `evidence_consumption` (evidenceIds[,priorGapId]), `edit` (changedPaths), or `check` (check[,failureLocation]). Do not guess fields or reenter for adjacent context.
5. Recovery: `not_found` has no handoff. Follow `nextAction.recovery`, make one exact probe, then send `{recovery:{requestKind:"not_found_recovery",priorSessionId:<exact value>,priorWorkUnit:<exact workUnit>,probe:{kind:"exact_probe",path:<probed path>}}}` with the same top-level `workUnit`. Once-only; invalid after partial/ready/failure, broad exploration, or bypass. Use typed reentry on a handoff; fix `INVALID_REQUEST`; no broad fallback.

One cell:

```js
// @exec: {"yield_time_ms": 300000, "max_output_tokens": 10000}
// Construct documented args here.
if (typeof tools.mcp__freecontext__gather_context !== "function") throw new Error("FC unavailable.");
const result = await tools.mcp__freecontext__gather_context(args);
const terminalTexts = result?.content?.filter((item) => item?.type === "text") ?? [];
if (terminalTexts.length !== 1 || typeof terminalTexts[0].text !== "string") throw new Error("no unique terminal text result");
text(terminalTexts[0].text);
```

No waiting Hook; no replay/inspect sessions.
