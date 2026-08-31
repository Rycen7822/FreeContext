# FreeContext optimization history

This file is the durable, Git-tracked history for the FreeContext skill. The current `skills/freecontext/SKILL.md` and `skills/freecontext/agents/openai.yaml` are also Git-tracked. Keep this history beside them so a skill change and its evidence can be reviewed together.

## Maintenance rules

Append one entry in the same change whenever `SKILL.md`, `agents/openai.yaml`, or a harness policy that directly changes skill routing or invocation behavior is modified. Record the evidence source and distinguish live benchmark results, local proof, inference, and proposal. Never write a proposal as verified, and never describe a small-sample result as a stable gain or loss. A commit is only a version locator; it is not semantic proof of correctness, authorization, completion, or release readiness.

Do not copy early task or Slice execution logs into this file. Keep only reusable routing, contract, validation, benchmark, and complete-trace findings. If a later change supersedes a conclusion, retain the old entry and state the new boundary explicitly.

## Entry template

### YYYY-MM-DD — short change title

- 日期：YYYY-MM-DD
- commit/source：`<commit or source>`; use the commit only to locate the version.
- 目标/问题：What evidence gap, routing failure, or contract problem was being addressed?
- 通用改动：What generic skill, manifest, harness-policy, or contract behavior changed?
- 验证范围：List local proof and, when applicable, the exact live benchmark denominator and settings.
- 关键 benchmark 数据：Report denominators, reward, token, FC-increment, wall, and call-layer counts with control/treatment labels where applicable.
- 完整轨迹观察：Report call timing, reentry/recovery behavior, waiting/concurrency, and concrete trace observations.
- 结论/下一步：State what the evidence supports and the next authorized or proposed step.
- 已知边界：State sample-size, attribution, instrumentation, environment, or authorization limits.

## Recorded stages

### 2026-08-30 — Release baseline

- 日期：2026-08-30
- commit/source：`26ad344` (`v0.1.0-rc.1` release baseline); current Git history, the active Program/decision record in `.work/orchestrator/note.md`, and the baseline audit notes.
- 目标/问题：Establish the starting FreeContext contract and the evidence that motivated conditional routing and later reentry work.
- 通用改动：This release commit is a version baseline, not a routing optimization. At this point the tracked skill described FC-first eligibility for broad or multi-file work, and both the skill and agent manifest were already tracked.
- 验证范围：Historical live baseline evidence was used for diagnosis; it is not a benchmark of this release commit in isolation and is not a causal claim about the release.
- 关键 benchmark 数据：The completed 240-trial baseline had 120/120 treatment trials call FC before native repository exploration, zero valid post-edit/post-check reentry, 100 audited post-edit cross-file exploration events without FC, and 119 schema, 50 intrinsic, and 30 chain rejections.
- 完整轨迹观察：FC waiting and downstream consumption were already functioning. The recurring issue was route selection and later route reevaluation, not concurrent native work during a provider wait.
- 结论/下一步：Use the current evidence gap, rather than task size alone, as the routing decision. Preserve the atomic wait, read-only ownership, and strict continuation/recovery validation.
- 已知边界：The baseline campaign is historical diagnostic evidence with a different denominator and source state; it must not be pooled with later paired campaigns as if it were a matched treatment effect.

### 2026-08-30 — Conditional evidence-gap routing

- 日期：2026-08-30
- commit/source：`f5bd3e6` (`feat: enable conditional FreeContext reentry`); source and authority are recorded in `.work/orchestrator/note.md` and the implementation Program.
- 目标/问题：Remove automatic FC-first routing for every broad task and make initial and later calls depend on the concrete evidence gap.
- 通用改动：The skill and manifest now route precise bounded evidence directly and reserve FC for cross-module, multi-role, long-document, multi-document, or source-bound gaps. MCP eligibility/tool wording and partial-result guidance were aligned, and the DeepSWE treatment policy no longer mandates FC-first. Wire schemas and strict typed reentry/recovery validation were preserved.
- 验证范围：Local proof passed focused behavior tests 65/65, the configured full suite 223/223, Gigatoken qualification, typecheck, build, static checks, skill validation, adapter syntax, and diff-check. A live paired benchmark ran five tasks with three repetitions per arm, 30 trials total, no retry, and max dynamic concurrency four.
- 关键 benchmark 数据：Control and treatment each solved 9/15. Treatment main-Agent reasoning-excluded tokens were 6.4% lower, but FC increment made total-system tokens 4.4% higher and wall time 7.5% higher.
- 完整轨迹观察：All 15 treatment traces still called FC before native exploration; valid typed reentry, post-edit calls, and post-check calls were zero. All 21 provider calls were synchronous waits with no concurrent main-Agent work, and all 13 usable Evidence results were consumed. A complete audit confirmed three of 15 traces with mid-session opportunities (Effect r2 and Scriggo r2/r3), with Scriggo r1 uncertain; the other 11 had no confirmed opportunity.
- 结论/下一步：The change established conditional wording but did not make later route reevaluation reliable. It does not prove a reward or token benefit. The next generic step was a post-edit/failed-check diagnostic checkpoint, without forcing a second call.
- 已知边界：Five tasks and three repetitions per arm are descriptive only. The confirmed opportunities identify routing misses, not counterfactual FC benefit.

### 2026-08-31 — Diagnostic checkpoint and arm alignment

- 日期：2026-08-31
- commit/source：`3e66293` (`fix: reinforce FreeContext diagnostic reentry`); the complete checkpoint decision and authority are in `.work/orchestrator/note.md`.
- 目标/问题：Make the post-edit/failed-check route explicit: read the exact failure location at most once, then classify before a second non-adjacent or cross-module diagnostic read.
- 通用改动：Added a generic checkpoint to the skill and paired DeepSWE harness. Both benchmark arms received the same checkpoint through the isolated global policy layer; only the final route differed. The treatment route allowed FC only for a distinct new static cross-module relationship not covered by the prior handoff. No schema or validator relaxation was made.
- 验证范围：Local proof passed focused routing/context tests 18/18, the configured full suite 223/223, typecheck, build, static checks, skill validation, adapter proof/syntax, and diff-check. A live exact-12 paired benchmark used the two tasks, three repetitions per arm, paired seeds, attempt 1, no retry/replacement, and max dynamic concurrency six.
- 关键 benchmark 数据：Control solved 2/6 and treatment 1/6. Treatment used 5.7% more main-Agent tokens, 11.9% more total-system tokens, and 13.8% more wall time. The treatment made 17 FC attempts, including 10 schema-accepted, 6 chain-accepted, and 9 provider-executed attempts.
- 完整轨迹观察：All 12 sessions loaded the common checkpoint and correct arm route, yet typed reentry remained zero. Two treatment traces had clear eligible cross-module post-check episodes, but the main Agent continued natively; the remaining traces lacked a clean distinct continuation. Provider waits were synchronous, with no native work during execution.
- 结论/下一步：The checkpoint clarified the intended route but did not establish actual typed reentry. Do not merge or release this stage as a successful reentry fix. The next generic correction was to distinguish same-question replay from a newly concrete child blocker and simplify valid caller shapes.
- 已知边界：The exact-12 denominator is noisy and cannot establish a stable treatment effect. Zero reentry means the reentry constraints were not tested on a real later call.

### 2026-08-31 — Typed continuation children and recovery-shape repair attempt

- 日期：2026-08-31
- commit/source：`c0a98d9` (`fix: distinguish FreeContext continuation children`); evidence is the exact-12 complete audit at `.work/freecontext-continuation-contract-2x3-paired-20260831/summaries/full-trace-audit.md` and the active Program record.
- 目标/问题：Keep identical replay invalid while accepting a distinct, explicitly parented child blocker exposed by Evidence consumption, an edit, or a check; reduce malformed continuation and recovery calls.
- 通用改动：Added typed `handoff_child` and `gap_concretization` derivations, normalized addressed-target/scope/fact replay checks, and simpler caller guidance. The attempted recovery simplification was still partly caller-reconstructed rather than genuinely session-loaded; no task-specific wording or forced call count was introduced.
- 验证范围：Local proof passed the configured full suite 225/225 plus focused continuation/recovery/history tests, typecheck, build, static checks, skill validation, adapter syntax, and diff-check. The live exact-12 campaign completed all 12 runner terminals with no retry or cleanup failure, using control/treatment repetitions 1–3 for Scriggo and Effect SSE at max concurrency six.
- 关键 benchmark 数据：Control=treatment=2/6. Treatment used 3.0% fewer main-Agent reasoning-excluded uncached tokens and 3.4% fewer visible tokens; FC added 145,748 provider-native tokens, total-system tokens rose 2.7%, and wall rose 0.6%. The FC attempt layers were 14 attempted / 13 schema-accepted / 12 intrinsic-accepted / 8 chain-accepted / 8 committed / 8 provider-executed.
- 完整轨迹观察：All provider calls occurred before the first edit. Typed `handoff_child` and `gap_concretization` reentry were both zero. Several Scriggo post-check episodes crossed compiler, emitter, VM, and interface-representation files without FC, confirming a policy miss rather than absence of eligible work. Calls were atomic waits with no native work during provider execution. Recovery traces showed that callers still resent the original request facts and produced avoidable malformed attempts.
- 结论/下一步：The campaign is valid evidence but the behavioral objective was not met; do not merge or release `c0a98d9` as a successful continuation fix. The next local correction was to make recovery session-loaded and recovery-only, and to broaden the post-check relation wording without forcing a second call.
- 已知边界：The six paired observations are descriptive only. The audit also found a strict call/session correlation mismatch that must not relabel valid runner terminals or provider executions; cross-campaign comparisons are not causal.

### 2026-08-31 — Session-restored recovery and provenance correction

- 日期：2026-08-31
- commit/source：`bee6fce` (`fix: restore FreeContext recovery context`); source and local authority are recorded in `.work/orchestrator/note.md` and `.work/orchestrator/CODEX_STATE.md`.
- 目标/问题：Finish the recovery contract exposed by the exact-12 audit and repair false provenance rejection without changing provider behavior or adding task-specific routing.
- 通用改动：Recovery now accepts only `priorSessionId` plus one workspace-relative `probePath`; the server restores immutable facts from the latest eligible committed `not_found` session and rejects overrides, chaining, wrong workspace, stale sessions, handoff results, and invalid paths before provider execution. The diagnostic route now covers runtime, type, data, control-flow, and owner relations after one exact failure read. Fresh provenance accepts a matching structured session id, unique exact serialized session reference, or unique exact call-id route, while missing or ambiguous evidence remains fail-closed.
- 验证范围：Focused tests passed 49/49 and the configured full suite passed 229/229 with zero skip/failure; typecheck, build, static checks, skill validation, adapter syntax, and diff-check passed. No live benchmark, provider, Pier, Docker, or network run was authorized or performed for this correction.
- 关键 benchmark 数据：No new benchmark data belongs to `bee6fce`. The latest live exact-12 numbers remain the `c0a98d9` record above and must not be attributed to this local-only correction.
- 完整轨迹观察：The correction is motivated by the c0 audit: all eight provider-executed calls were before the first edit and typed child reentry was zero, while Scriggo contained eligible post-check cross-module episodes. Local tests exercise recovery-only restoration, no-chain and fail-closed checks, and correlation matching; they do not demonstrate future live reentry.
- 结论/下一步：`bee6fce` is qualified local feature-branch evidence only. Preserve the exact-12 audit, keep the current skill behavior unchanged by this history file, and require a separately authorized benchmark before making any performance or reentry claim.
- 已知边界：No live validation exists for the corrected contract. Cross-process servers sharing one session directory still lack an atomic recovery claim; isolated per-trial session directories are unaffected. Merge, release, retry, replacement, and another live campaign remain outside the recorded authority.

### 2026-08-31 — Three-arm live reentry qualification

- 日期：2026-08-31
- commit/source：`00b182f` documentation tip with `bee6fce` as the latest behavior commit; live evidence is `.work/freecontext-deepswe-reentry-skill-ab-20260831/analysis/final-report.md`. The previous-skill arm used the two tracked skill files from `v0.1.0-rc.1/26ad344` while all arms shared the current product, server, harness, runtime, model settings, and paired seeds.
- 目标/问题：Test whether the session-restored recovery and continuation policy produces real post-edit or post-check reentry in long sessions, and compare it with both no FC and the previous release skill without changing task-specific behavior.
- 通用改动：No skill or product behavior was changed for this entry. It records a fresh three-arm qualification of the existing generic policy so later optimization can distinguish behavioral proof from performance claims.
- 验证范围：Five historically positive-control tasks, three repetitions per arm, 45 fresh trials total, max total concurrency six, attempt 1, no retry or replacement. All 45 result, aggregate, trajectory, verifier, and cleanup records passed root cross-check; the cost report rebuilt exactly from retained artifacts.
- 关键 benchmark 数据：Control, new skill, and previous skill each solved 6/15. Relative to control, the new skill used 3.16% more main-Agent reasoning-excluded uncached tokens, 18.50% more total-system tokens, and 17.54% more cumulative wall time. The previous skill used 0.90%, 13.05%, and 14.26% more respectively. New versus previous total-system tokens were 4.82% higher. New made 41 gather dispatches, 26 schema-accepted calls, and 22 provider-executed calls; previous made 33 tool dispatches, 32 reached MCP, and 19 executed the provider.
- 完整轨迹观察：The new arm produced one genuine process reentry in Pest r3 after the first edit and check. Step 27 accepted a typed `gap_concretization`, step 28 recovery returned ready Evidence for generator and parser-state seams, and steps 29 and 32 directly applied the result to generator and VM code; the trial still had reward 0. Obtaining that usable continuation required six post-check dispatch attempts, exposing caller-shape friction. The previous arm produced no process reentry. All four asynchronous calls across FC arms were explicitly waited to terminal completion. Evidence was consumed rather than ignored, but 11/12 new-skill Evidence calls and 13/13 previous-skill Evidence calls were followed by native rereads.
- 结论/下一步：The live behavior objective is minimally proven because one real post-check continuation completed and influenced edits. Performance and correctness improvement are not proven: aggregate reward was identical, main-Agent and total-system costs increased, and only one of 15 new-skill traces reentered. If work continues, simplify generic caller construction from retained session/handoff state and make post-check route reevaluation more reliable before another larger benchmark; do not add rules specialized to these five tasks.
- 已知边界：The task pool was deliberately selected from historical positive-control evidence and is not held out. Eight of 15 task-repetition groups had arm reward disagreement, so per-task outcome shifts are noisy. This entry does not authorize merge, release, publication, retry, replacement, or a new live campaign.
