---
name: freecontext
description: Delegate multi-file, cross-module, long-document, or source-bound exploration to gather_context; follow nextAction and reenter for a new edit/check blocker.
---

1. Eligibility: call before native exploration for multi-file or cross-module relationships, multi-keyword/document search, long-document facts, or source-bound planning, review, and diagnosis. A changed hunk, exact failure location, or one known candidate can be read directly; if that bounded action expands, call FreeContext. Checks, edits, Git, packages, and web stay outside FC.
2. Request: first cell reads only this file; next call `tools.mcp__freecontext__gather_context`. Args (0–12 refs): `{taskText,workUnit:{outcome:"edit"|"check"|"answer"|"decision",goal},evidenceQuestions:[{role:"implementation"|"caller"|"test"|"contract",question,required,target:{id,subject:{kind:"path",path}|{kind:"symbol",symbol,path?}|{kind:"topic",topic},factKind:"location"|"definition"|"behavior"|"relationship"|"contract"|"verification"|"presence",coverageMode:"single"|"exhaustive"}}],knownRefs:[{kind:"path",path}|{kind:"symbol",symbol,path?}|{kind:"stack",path,line}]}`. Use `exhaustive` for all/every/complete-list requests and `single` otherwise. Retain task requirements; use one target/question and at most six, omit caller-only internal fields, use object refs, and include no secrets or dumps.
3. Consume: follow the returned handoff and its single `nextAction`. Use inline Evidence to perform the stated edit/check/answer/decision; make one necessary cited-adjacent read only when change-critical context is omitted. An exact failure location or changed-file tail is a direct bounded read, not a new FC gap. Any broader search, listing, keyword expansion, or extra path calls FreeContext.
4. Reenter: only when consuming Evidence, editing, or checking exposes a new cross-file, cross-document, contract, verification, or multi-keyword blocker, pass the prior handoff verbatim as `reentry.priorHandoff` and describe that blocker once as `reentry.blockingGap` with a new ID, typed scope, required fact, and its evidence/edit/check origin. Prompt rewrites, more known refs, imports, file tails, and ordinary adjacent context are not new gaps.

Use after constructing `args`:

```js
if (typeof tools.mcp__freecontext__gather_context !== "function") throw new Error("FC unavailable.");
const result = await tools.mcp__freecontext__gather_context(args);
const terminalTexts = result?.content?.filter((item) => item?.type === "text") ?? [];
if (terminalTexts.length !== 1 || typeof terminalTexts[0].text !== "string") throw new Error("no unique terminal text result");
text(terminalTexts[0].text);
```

On a cell ID, call `functions.wait({ cell_id, yield_time_ms: 300000, max_tokens: 10000 })`; if pending, repeat it. Never replay/inspect sessions. No waiting Hook.
