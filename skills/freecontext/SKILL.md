---
name: freecontext
description: Route the current evidence gap, not the whole task size, to gather_context for cross-module, multi-role, long-document, multi-document, or source-bound exploration. Use initially or after Evidence, an edit, or a check exposes such a gap. Handle an exact path or path-bound symbol, stack location, changed hunk, diff or status, test, or exact failure location directly when one bounded action suffices.
---

# FreeContext routing

Choose from the evidence needed **now**. Task size does not decide the route.

## Choose the route

- **Direct:** use native tools for one exact path or path-bound symbol, a stack location, changed hunk, Git diff/status, test, or exact failure location when it closes the gap. Ordinary reads, edits, checks, and diff review stay direct.
- **Gather:** call `tools.mcp__freecontext__gather_context` for a cross-module chain, two or more evidence roles, joint configuration, cross-document synthesis, long-document facts, or source-bound planning/review/diagnosis. This may be initial or a later distinct blocker.
- **Orient once:** if there is no precise reference, one bounded exact path or symbol probe is allowed. Read one candidate only if it can close the gap; call FreeContext before broader native exploration.

The main agent owns edits, checks, Git, packages, and web; FreeContext is read-only.

## Make one atomic request

Call `gather_context` alone in its batch/code cell. Never parallelize or batch it or do other work during dispatch. If an exec cell returns, exclusively await `functions.wait({cell_id,yield_time_ms:300000,max_tokens:10000})` until terminal.

`workUnit` names the stable outer implementation goal, not a lookup. Roles are only `implementation`, `caller`, `test`, or `contract`. `knownRefs` shapes are exactly `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}`. Usually ask for the one concrete `single` target actually needed; never fill a quota. Use `exhaustive` only for complete enumeration. For new behavior, ask for the nearest existing owner or extension seam without assuming a new symbol.

This compact edit request is parsed by `FreeContextCallerRequestSchema`:

`const args={taskText:"Update routing.",workUnit:{outcome:"edit",goal:"Implement conditional routing without changing the public request contract."},knownRefs:[{kind:"symbol",symbol:"route",path:"src/router.ts"}],evidenceQuestions:[{role:"implementation",question:"Where is the decisive routing branch?",required:true,target:{id:"routing-branch",subject:{kind:"symbol",symbol:"route",path:"src/router.ts"},factKind:"behavior",coverageMode:"single"}}]};`

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

No waiting Hook; no replay or session inspection.

## Consume and continue

`ready` and `partial` include a handoff. Consume Evidence and `nextAction` directly. Do not reread covered content; one cited or adjacent read is allowed for omitted change-critical context. A listed partial gap is not permission to replay; ready/partial alone never justifies reentry.

Reenter only when Evidence, an edit, or a check exposes a **distinct new typed blocker** needing gather-level exploration. Ordinary edit/check/read/diff work does not call FreeContext. Send `{reentry:{priorHandoff:<exact result.handoff>,blockingGap:{id,targetId,kind,scope,requiredFact,origin}}}`. Copy `priorHandoff` verbatim and keep top-level `workUnit` exactly equal to `priorHandoff.workUnit`. Origins are `evidence_consumption` (`evidenceIds`, optional `priorGapId`), `edit` (`changedPaths`), or `check` (`check`, optional `failureLocation`). Target and scope must be current and new. Never target a changed path or exact failure path; inspect directly. Do not guess fields, repeat target/scope, or reenter for adjacent context.

For `not_found`, make the one exact probe in `nextAction.recovery`, then send `{recovery:{requestKind:"not_found_recovery",priorSessionId:<exact value>,priorWorkUnit:<exact workUnit>,probe:{kind:"exact_probe",path:<probed path>}}}` with the same top-level `workUnit`. Recovery is once-only and invalid after partial, ready, failure, broad exploration, or bypass. With a handoff use typed reentry; fix `INVALID_REQUEST`; never use broad fallback.
