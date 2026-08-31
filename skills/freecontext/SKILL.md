---
name: freecontext
description: Route the current evidence gap, not the whole task size, to gather_context for cross-module, multi-role, long-document, multi-document, or source-bound exploration. During execution, if the next step seems roughly 30% likely to need repo-wide search or substantial reading, call FreeContext prospectively. Use initially or after Evidence, an edit, or a check exposes such a gap. Handle an exact path or path-bound symbol, stack location, changed hunk, diff or status, test, or exact failure location directly when one bounded action suffices.
---

# FreeContext routing

Route current evidence, not task size. During execution, notice whether the next step may require repo-wide search or substantial reading; if roughly 30% likely, call FreeContext without hesitation. Prospective, not mechanical or final-count based.

## Choose the route

- **Direct:** use native tools for one exact path or path-bound symbol, stack location, changed hunk, Git diff/status, test, or exact failure location when it closes the gap. Ordinary reads, edits, checks, and diff review stay direct.
- **Gather:** call `tools.mcp__freecontext__gather_context` for cross-module chains, multiple evidence roles, joint configs, cross-document synthesis, long-document facts, or source-bound planning/review/diagnosis.
- **Orient once:** without a precise reference, probe one bounded exact path or symbol. Read a candidate only if it closes the gap; call FreeContext before broader exploration.

Call before continuing discovery for a repo-wide search, an unknown owner/caller/implementation, runtime/type/data/control-flow tracing, or a second non-adjacent module after one exact read. If one exact read makes a concrete local fix clear, continue natively.

The main agent owns edits, checks, Git, packages, and web; FreeContext is read-only.

## Make one atomic request

Call `gather_context` alone in one cell. Never parallelize or batch it or do other work during dispatch. If an exec cell returns, exclusively await `functions.wait({cell_id,yield_time_ms:300000,max_tokens:10000})` until terminal.

`workUnit` names the stable outer implementation goal, not a lookup. Roles are only `implementation`, `caller`, `test`, or `contract`. `knownRefs` are `{kind:"path",path}`, `{kind:"symbol",symbol,path?}`, or `{kind:"stack",path,line}`. Initially provide `role` and `question`; the question becomes a topic target and `required:true`, role-appropriate `factKind`, a stable id, and `single` coverage default internally. Add `target:{subject}` only for a known path, symbol, or topic. For new behavior, ask for the nearest seam without assuming a new symbol.

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

No waiting Hook; no replay/session inspection.

## Consume and continue

`ready` and `partial` include a handoff. Consume Evidence and `nextAction` directly. Do not reread covered content; one cited or adjacent read is allowed for omitted change-critical context. A listed partial gap is not permission to replay; ready/partial alone never justifies reentry.

After an edit or failed check, one exact failure read remains native when it makes a local fix clear. Otherwise classify before a second non-adjacent module or cross-module search; reenter only for runtime/type/data/control-flow or owner tracing. Single-file work, accurate locations, routine checks, and the same handoff gap remain native. Never force a second call.

Reenter only for a **typed child blocker** needing gather-level exploration; ordinary edit/check/read/diff work stays direct. Send only `reentry:{priorSessionId,question:{role,question,target?},origin:{kind:"evidence"|"edit"|"check",...},knownRefs?,parentGapId?}`. The server restores the prior task, work unit, handoff, and request context. Omit `parentGapId` for a handoff child; provide the exact prior gap id for gap concretization. Reusing a prior session, scope/fact, or wrong origin is invalid. Never target a changed path or exact failure path.

For `not_found`, make the exact probe required by `nextAction`, then call `gather_context` with only `{recovery:{priorSessionId:<exact nextAction.recovery.priorSessionId>,probePath:"<workspace-relative probed path>"}}`. Send no `taskText`, `workUnit`, `knownRefs`, `evidenceQuestions`, or handoff; the server restores them from the committed session. Recovery is once-only and invalid after partial, ready, failure, broad exploration, or bypass. With a handoff use typed reentry; fix `INVALID_REQUEST`; never use broad fallback.
