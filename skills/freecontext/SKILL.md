---
name: freecontext
description: Before starting or changing a task phase, judge whether the whole upcoming phase may require searching or reading many files or substantial content. Use native repository reads only when you clearly know one small bounded read is enough; otherwise call gather_context before searching or reading. Recheck after Evidence, an edit, or a check. Exact paths, changed hunks, diff or status, tests, and exact failure locations stay direct when no broader reading is needed.
---

# FreeContext routing

Judge the whole upcoming phase, not only the next command. Do this before starting work and whenever the work changes phase.

## Choose the route

- **Direct:** use native repository reading only when you clearly know one small bounded read is enough. Exact locations, changed hunks, Git diff/status, tests, edits, and checks stay direct when they need no broader reading.
- **Gather:** otherwise call `tools.mcp__freecontext__gather_context` before repository search or reading.

Repeat this decision after Evidence, an edit, a check, or another phase change. A rejected request affects only that request; judge a different later phase normally. Never force a call count.

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

After Evidence, an edit, or a check, apply the same whole-phase decision. One exact failure read stays native only when you clearly know it is enough; a new phase that may need many files or substantial content should reenter before searching or reading.

Reenter only for a **new typed child evidence question** exposed by Evidence, an edit, or a check and needing gather-level exploration. A rejected continuation affects only that request and does not disable a different later broad phase. Send only `reentry:{priorSessionId,question:{role,question,target?},origin:{kind:"evidence"|"edit"|"check",...},knownRefs?,parentGapId?}`. The server restores the prior task, work unit, handoff, and request context. Omit `parentGapId` for a handoff child; provide the exact prior gap id for gap concretization. Reusing a prior session, scope/fact, or wrong origin is invalid. Never target a changed path or exact failure path.

For `not_found`, make the exact probe required by `nextAction`, then call `gather_context` with only `{recovery:{priorSessionId:<exact nextAction.recovery.priorSessionId>,probePath:"<workspace-relative probed path>"}}`. Send no `taskText`, `workUnit`, `knownRefs`, `evidenceQuestions`, or handoff; the server restores them from the committed session. Recovery is once-only and invalid after partial, ready, failure, broad exploration, or bypass. With a handoff use typed reentry; fix `INVALID_REQUEST`; never use broad fallback.
