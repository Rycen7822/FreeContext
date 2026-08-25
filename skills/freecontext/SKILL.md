---
name: freecontext
description: Delegate multi-file, cross-module, long-document, multi-document, or source-bound exploration to gather_context; follow its structured nextAction and continuation contract.
---

1. Eligibility: call before native exploration for multi-file/cross-module, multi-keyword/document, long-document, or source-bound work. A changed hunk or exact failure location may be read directly; if it expands, call FC. Checks, edits, Git, packages, and web stay outside FC.
2. Request: read this file in the first cell, then call `tools.mcp__freecontext__gather_context`. Public args are `taskText`, `workUnit`, `evidenceQuestions` (role, question, required, one target), and `knownRefs` (path, symbol, or stack). Each target uses `subject`, `factKind`, and `coverageMode` (`exhaustive` only for all/every/complete-list). With path-backed knownRefs, read the exact reference first; before any read only a bounded non-recursive immediate-parent probe is permitted. Root/higher-ancestor glob/rg, default-all, and `**` first-pass searches are blocked. Search output is not an observed read.
3. Consume: `ready` and `partial` always include a handoff. Follow the handoff and structured `nextAction`; use inline Evidence for the stated edit/check/answer/decision. After partial Evidence, allow one necessary cited-adjacent read only when change-critical context is omitted, then execute the handoff or reenter for a new typed blocker. Exact failure/tail reads are bounded direct reads; broader search, listing, keyword expansion, or extra paths call FC.
4. Reenter only for a new blocker exposed by Evidence consumption, edit, or check: `{reentry:{priorHandoff:<exact result.handoff>,blockingGap:{id,targetId,kind,scope,requiredFact,origin}}}`. Copy `priorHandoff` verbatim and its `workUnit` exactly. Origin is `evidence_consumption` (evidenceIds, optional priorGapId), `edit` (changedPaths), or `check` (check, optional failureLocation). Do not guess hidden fields or reenter for adjacent context.
5. No-handoff recovery: `not_found` has no handoff. Follow `nextAction.recovery`, perform exactly one non-broad exact probe, then send `{recovery:{requestKind:"not_found_recovery",priorSessionId:<exact value>,priorWorkUnit:<exact workUnit>,probe:{kind:"exact_probe",path:<probed path>}}}` with the same top-level `workUnit`. Recovery is once-only, invalid after partial/ready/failure, broad exploration, or an initial bypass. Once it returns a handoff, use typed reentry. Fix specific `INVALID_REQUEST` reasons; never fall back to broad exploration or hidden state.

Use after constructing `args`:

```js
if (typeof tools.mcp__freecontext__gather_context !== "function") throw new Error("FC unavailable.");
const result = await tools.mcp__freecontext__gather_context(args);
const terminalTexts = result?.content?.filter((item) => item?.type === "text") ?? [];
if (terminalTexts.length !== 1 || typeof terminalTexts[0].text !== "string") throw new Error("no unique terminal text result");
text(terminalTexts[0].text);
```

On a cell ID, call `functions.wait({ cell_id, yield_time_ms: 300000, max_tokens: 10000 })`; if pending, repeat it. Never replay/inspect sessions. No waiting Hook.
