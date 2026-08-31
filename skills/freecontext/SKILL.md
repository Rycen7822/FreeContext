---
name: freecontext
description: Use before repository exploration only when the main Agent can state a concrete next multi-file or multi-relation evidence gap that native bounded reads cannot close. Exact paths, symbols, failures, one bounded read, diff or status, edits, tests, and direct checks stay native; reconsider after an edit or check only for a new cross-file question.
---

# FreeContext routing

Call `tools.mcp__freecontext__gather_context` only when the main Agent can name a specific next repository exploration spanning multiple files or relationships, and native bounded reads cannot close it. Do not call because a task starts, a phase changes, the task looks complex, or a probability threshold is reached. Known references are optional priority hints, never a gate.

Use native repository tools for exact paths, symbols, failure locations, one bounded read, diff/status, edits, tests, and direct checks. After an edit or check, reconsider only if it exposes a new cross-file evidence question. Evidence-origin reentry is only for an independent child exposed by Evidence and needed before acting; prefer edit/check origins and do not broaden the same topic. A verification read of the decisive implementation owner is allowed after Evidence.

The main Agent owns edits, checks, Git, packages, and web; FreeContext is read-only. Do not force a call count. Consume returned Evidence and `nextAction` directly. A `ready` or `partial` handoff, a listed gap, or a rejected request does not itself authorize replay or reentry.

## One atomic request

Call `gather_context` alone in one cell. Never parallelize it or do other work during dispatch. If an exec cell returns a call ID, exclusively await `functions.wait({cell_id,yield_time_ms:300000,max_tokens:10000})` until terminal.

`workUnit` names the stable outer goal, not a lookup. Roles are only `implementation`, `caller`, `test`, or `contract`. Initially send only the required `taskText`, `workUnit`, and one `evidenceQuestions` item with `role` and `question`; `knownRefs` and `target` are optional and omitted unless they materially narrow the gap. The server assigns the question and its one target, role-appropriate fact kind, required flag, stable IDs, and `single` coverage default.

```js
// @exec: {"yield_time_ms": 300000, "max_output_tokens": 10000}
const args = {
  taskText: "Trace the repository-wide owner relationship needed for this change.",
  workUnit: { outcome: "edit", goal: "Implement the requested change without altering its public contract." },
  evidenceQuestions: [{ role: "implementation", question: "Which concrete multi-file relationship must be verified?" }],
};
if (typeof tools.mcp__freecontext__gather_context !== "function") throw new Error("FC unavailable.");
const result = await tools.mcp__freecontext__gather_context(args);
const terminalTexts = result?.content?.filter((item) => item?.type === "text") ?? [];
if (terminalTexts.length !== 1 || typeof terminalTexts[0].text !== "string") throw new Error("no unique terminal text result");
text(terminalTexts[0].text);
```

## Continuation and recovery

For a new typed child question exposed by Evidence, an edit, or a check, send only `reentry:{priorSessionId,question:{role,question,target?},origin:{kind:"evidence"|"edit"|"check",...},knownRefs?,parentGapId?}`. The server restores the prior task, work unit, handoff, and request context. Omit `parentGapId` for a handoff child; provide the exact prior gap ID only for gap concretization. Never target a changed path or exact failure path.

For `not_found`, make the exact probe named by `nextAction`, then send only `{recovery:{priorSessionId:<exact nextAction.recovery.priorSessionId>,probePath:"<workspace-relative probed path>"}}`. Recovery is once-only and invalid after partial, ready, failure, broad exploration, or bypass. Fix `INVALID_REQUEST`; never use a broad fallback.
