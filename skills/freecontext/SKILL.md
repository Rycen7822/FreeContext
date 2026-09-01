---
name: freecontext
description: Use before repository exploration when the whole next source-understanding phase has one concrete question expected to cross multiple non-adjacent owners or relationships. One or two small reads, exact paths, symbols, failures, diff or status, edits, tests, and direct checks stay native; planned cross-module audits may reenter after edit or check.
---

# FreeContext routing

Judge the whole next source-understanding phase, not its next command. Call `tools.mcp__freecontext__gather_context` before searching or reading when one concrete question is expected to cross multiple non-adjacent owners or relationships. Use native tools when the entire question clearly closes with one or two small reads. Do not call because a task starts, a phase changes, the task looks complex, or a probability threshold is reached. Known references are optional priority hints, never a gate.

Use native repository tools for exact paths, symbols, precise local failures, diff/status, edits, tests, and direct checks. After an edit or check, a planned cross-module consistency audit may start a typed reentry even without a failure; exact local failure diagnosis remains native. Reentry is optional: do not force a second call. Evidence-origin reentry is only for an independent child needed before acting; do not broaden the same topic. Ready or partial Evidence is already read context: consume it without a full remap, verify at most one or two truly necessary exact positions or adjacent contexts, then edit/check.

The main Agent owns edits, checks, Git, packages, and web; FreeContext is read-only. Do not force a call count. Consume returned Evidence and `nextAction` directly. A `ready` or `partial` handoff, a listed gap, or a rejected request does not itself authorize replay or reentry. If status is `failed`, continue normal native exploration directly; do not force an exact probe, recovery, or another FreeContext call.

## One atomic request

Call the exact method name `tools.mcp__freecontext__gather_context` directly; do not do a tool-directory or catalog lookup first. Call it alone in one cell. Never parallelize it or do other work during dispatch. If an exec cell returns a call ID, exclusively await `functions.wait({cell_id,yield_time_ms:300000,max_tokens:10000})` until terminal.

`workUnit` names the stable outer goal, not a lookup. Roles are only `implementation`, `caller`, `test`, or `contract`. The initial invocation remains one call: use the fewest items needed to cover the required areas, with one `evidenceQuestions` item per required source area, each containing `role` and `question` (up to six; do not combine multiple required areas in one question or pad the list). `knownRefs` and the precise `target.subject` override are optional. The server derives IDs, required defaults, and role coverage: caller means relationship plus `exhaustive`; other roles keep their role-appropriate fact kind and `single` default.

```js
// @exec: {"yield_time_ms": 300000, "max_output_tokens": 10000}
const args = {
  taskText: "Trace the repository-wide owner relationship needed for this change.",
  workUnit: { outcome: "edit", goal: "Implement the requested change without altering its public contract." },
  evidenceQuestions: [
    { role: "implementation", question: "Which implementation owner must be verified?" },
    { role: "caller", question: "Which callers or consumers must be enumerated?" },
  ],
};
if (typeof tools.mcp__freecontext__gather_context !== "function") throw new Error("FC unavailable.");
const result = await tools.mcp__freecontext__gather_context(args);
const terminalTexts = result?.content?.filter((item) => item?.type === "text") ?? [];
if (terminalTexts.length !== 1 || typeof terminalTexts[0].text !== "string") throw new Error("no unique terminal text result");
text(terminalTexts[0].text);
```

## Continuation and recovery

For a new typed child question exposed by Evidence, or a planned cross-module audit after an edit or check, send only `reentry:{priorSessionId,question:{role,question,target?},origin:{kind:"evidence"|"edit"|"check",...},knownRefs?,parentGapId?}`. The server restores the prior task, work unit, handoff, and request context. Omit `parentGapId` for a handoff child; provide the exact prior gap ID only for gap concretization. Never target a changed path or exact failure path. Each required question is independent: exhaustive caller coverage must enumerate every discovered member and cite an observed boundary; unresolved scope is a gap and keeps the result partial.

For `not_found`, make the exact probe named by `nextAction`, then send only `{recovery:{priorSessionId:<exact nextAction.recovery.priorSessionId>,probePath:"<workspace-relative probed path>"}}`. Recovery is once-only and invalid after partial, ready, failure, broad exploration, or bypass. A `failed` result goes directly to normal native exploration.
