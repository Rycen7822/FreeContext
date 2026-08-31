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

`workUnit` names the stable outer implementation goal, not a lookup. Roles are only `implementation`, `caller`, `test`, or `contract`. `knownRefs` are `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}`. Initially provide `role` and `question`; the question becomes a topic target and `required:true`, role-appropriate `factKind`, a stable id, and `single` coverage default internally. Add `target:{subject}` only for a known precise path, symbol, or topic; override other target fields only when needed. For new behavior, ask for the nearest existing extension seam without assuming a new symbol.

This compact edit request is parsed by `FreeContextCallerRequestSchema`:

`const args={taskText:"Update routing.",workUnit:{outcome:"edit",goal:"Implement conditional routing without changing the public request contract."},knownRefs:[{kind:"symbol",symbol:"route",path:"src/router.ts"}],evidenceQuestions:[{role:"implementation",question:"Where is the decisive routing branch?"}]};`

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

After an edit or failed check, read the exact failure location at most once. If that makes a concrete local fix clear, continue natively. Before reading a second non-adjacent module or searching across modules, classify the gap. Reenter only to trace runtime, type, data, or control flow, or an owner relationship, into that module; send a new parented child blocker. Single-file work, an accurate stack or location, routine checks, and the same handoff gap remain native. Never force a second call.

Reenter only for a **typed child blocker** needing gather-level exploration; ordinary edit/check/read/diff work stays direct. Copy `priorHandoff` verbatim and keep `workUnit` exactly equal. Send `blockingGap:{id,questionId,targetId,kind,scope,requiredFact,derivation,origin}`; `questionId`, target/scope, and normalized `requiredFact` must match the current evidence question actually sent to the explorer. A gap-free child uses `handoff_child` with the exact handoff id; its origin is `evidence_consumption`, `edit`, or `check`. A listed-gap child uses `gap_concretization` with the exact gap id and an edit/check origin. Reusing an addressed target, scope, and fact after whitespace/case normalization, changing only an id, or omitting the parent is replay. Never target a changed path or exact failure path.

For `not_found`, make the exact probe required by `nextAction`, then call `gather_context` with only `{recovery:{priorSessionId:<exact nextAction.recovery.priorSessionId>,probePath:"<workspace-relative probed path>"}}`. Send no `taskText`, `workUnit`, `knownRefs`, `evidenceQuestions`, or handoff; the server restores them from the committed session. Recovery is once-only and invalid after partial, ready, failure, broad exploration, or bypass. With a handoff use typed reentry; fix `INVALID_REQUEST`; never use broad fallback.
