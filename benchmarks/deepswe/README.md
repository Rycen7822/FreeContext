# DeepSWE benchmark context capture

`pier_codex_freecontext_agent.py` exports the canonical treatment `PierCodexFreeContext` and paired `PierCodexControl`. The treatment adds one read-only stdio MCP server named `freecontext`, exposing the single enabled tool `gather_context`, plus one compact routing skill that selects that deferred tool. Both arms receive the same generated diagnostic checkpoint in the isolated Codex home; only the final route differs. Control has neither the server nor the skill and has no FreeContext metadata, provider domain, credential, session directory, or CLI wrapper.

The router is only initially visible selection metadata and selected-skill instructions. It does not explore files, wrap the CLI, change the task instruction, or implement shell polling; exploration remains one atomic `gather_context` MCP call, followed by bounded decisive reads in the parent.

Both arms upload the same local Codex runtime, put the identical common task-effect and diagnostic-checkpoint policies plus the arm-specific policy in Codex `developer_instructions`, and pass the original DeepSWE instruction unchanged to the same `PierCodexBase`. The only arm differences are the FreeContext policy/MCP/provider/skill capabilities and the checkpoint's final route. Keep task revision, image/cache state, model, reasoning effort, service tier, Fast setting, timeout, authentication, Codex CLI version, and any caller-supplied TOML identical. Changing one of those settings is a separate experiment, not a matched pair.

## Bound Pier integration

The adapter imports the active NoemaLoom `PierCodexBase` from `pier_codex_noemaloom_agent.py`. The 2026-08-11 implementation binds NoemaLoom revision `78aae216dcccf569c7cd8b819e238045d64f036f` and `datacurve-pier` 0.3.0. Treatment temporarily appends its MCP table through Pier's inherited `_config_toml` seam, which writes the isolated `/tmp/codex-home/config.toml`, and points inherited `skills_dir` at the uploaded runtime's `skills/` directory. It saves both caller values, sets the routing path only after upload, and restores both after the run. It does not invent or write a project configuration file.

Put the directory containing `pier_codex_noemaloom_agent.py` on `PYTHONPATH` together with this directory before passing `pier_codex_freecontext_agent:PierCodexFreeContext` or `pier_codex_freecontext_agent:PierCodexControl` to Pier.

Set `FREECONTEXT_RUNTIME_ARCHIVE` to a task-owned archive containing the built `dist/`, `bin/`, `prompts/`, `skills/freecontext/SKILL.md`, `skills/freecontext/agents/openai.yaml`, this directory's `freecontext.toml`, production dependencies, and runtime binaries. The treatment registers:

- startup timeout `30` seconds;
- tool timeout `105` seconds, leaving a fixed 15-second transport-finalization margin beyond FreeContext's 90-second internal deadline;
- enabled tool `gather_context` only;
- explicit approval for that read-only annotated tool.

The benchmark host reads the provider-neutral local profile at `/home/xu/.codex/freecontext_config.toml`; `FREECONTEXT_PROVIDER_CONFIG_PATH` may override that path. Its minimal schema is `[provider]` with `base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"` and `api_key = "<provider-api-key>"`. The adapter derives the expected endpoint from the bundled default route's model and provider entries, then verifies that the local profile matches it. The profile is a bootstrap source, not the main Codex or embedded Pi configuration.

The adapter copies only the extracted key to a task-owned mode-`0600` secret; it never changes the main Codex configuration. Codex starts the MCP launcher once. The root-owned launcher reads that secret, exports `FREECONTEXT_PROVIDER_API_KEY` only to the FreeContext server process, and `exec`s `bin/freecontext-mcp.mjs` with the bundled TOML and `/logs/agent/freecontext-sessions`. FreeContext's config resolver passes that credential to the embedded Pi runtime, which resolves the `primary` target at `glm-5.3-flash` with high reasoning from the bundled TOML. That bundled model route uses one non-stream Chat Completions response against `https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions` because the MCP call is atomic; its OpenAI-compatible payload includes `thinking: { type: "enabled" }` and `reasoning_effort: "high"`; the existing FreeContext harness still owns timeout and retry behavior. The key is never written into the bundled TOML, Codex guidance, a master context, or a FreeContext session. The plaintext copy and launcher are removed after verified export.

## Preserved artifacts

Each MCP result includes its separate in-container session path in compact text and structured output:

```text
Status: ready
Summary: Routing evidence is verified.
Evidence:
1. [implementation][impl] src/router.ts:10-24 (focus 17) — Defines routing.
Excerpt (observed):
export function route() { return provider; }
Gaps:
-
Next: read src/router.ts:10-24 — Read the decisive implementation span.
Error: -
Session: /logs/agent/freecontext-sessions/<call>.json
```

After Codex exits, the adapter preserves these artifacts under Pier's task `agent/` directory:

- `master-agent-context.json`: the complete raw Codex session JSONL plus an ordered FreeContext index containing request, nullable actual parent observation, delivery hashes/status, separate session paths, optional consumption audit, and duplicate-task observations. Atomic MCP export fails if a v2 session path or actual call observation is missing or mismatched.
- `delivery-observations.jsonl`: append-only actual MCP delivery matches indexed by invocation/session identity and, when available, host call identity, including typed missing-return causal evidence. A persisted terminal result with no provider cause is `harness`; provider exhaustion/fatal evidence plus a missing host completion is `mixed`. Private session content never substitutes for a missing parent observation.
- `consumption-observations.jsonl`: append-only targeted-first, evidence-range hit, broad-search, partial-gap-search, and duplicate-task observations. Explicit `freecontext-parent-action-v1` records remain authoritative; otherwise the exporter may conservatively derive actions from completed Codex host tool-call records after the matching FreeContext return. Actions from one completed outer exec cell share a batch identity; a concurrent first batch passes only when every provable repository action hits returned evidence, and same-batch searches are not ordered after a peer evidence read. Unsupported literals, failed cells, and incomplete calls remain unobserved rather than inferring parent intent or claiming a hard guard.
- `freecontext-sessions/*.json`: separate original MCP v2 session documents containing invocation identity, exact request, raw Pi capture, effective post-compaction context, typed provider attempt/schedule events with usage and base/actual delay, canonical compiler result, terminal decision, and exact model-visible text hash. Provider credentials and request headers are never serialized.
- `sessions/**/*.jsonl`: Pier's unchanged raw Codex session source.

The exporter continues to read legacy MCP v1 and benchmark-session v1 files during shadow adoption, but new treatment calls use MCP v2 only. Legacy observations are retained only when their exact output appears in the raw master JSONL. For a direct MCP observation, V2 export requires matching started/completed call identity, request, model-visible text hash, and structured result; the code-await fallback instead requires an observed terminal output whose session reference and text match the preserved session, while unavailable call-id/request/structured fields remain explicitly missing or null. A private session result alone is retained only as `recoverableResult` and never counted as delivered. The exporter never inserts a missing response into the raw master context or embeds raw session JSON in the call index. These artifacts may contain retained source text and are not deleted automatically.

## Cost report

Create a JSON input with schema `freecontext-cost-input-v1` and one `{ "taskId", "success", "agentDir" }` record per accepted trial, then run `freecontext-benchmark-costs INPUT.json OUTPUT.json`. Add matching `pairId` and `arm` (`control` or `treatment`) fields when a complete paired ratio is required. The command initializes one persistent Python Gigatoken worker with `tiktoken` `o200k_base`, batches all normalized main-agent input/output text through `encode_batch()`, and reports per-call, per-task, and per-success totals. It reports local main-visible counts, FreeContext output delivered to the parent, main provider-native usage, subagent provider-native usage, and additive provider-native system totals as separate domains; it never mixes provider-native usage with local Gigatoken counts. The primary main-agent metric is `uncachedInputTokens + visibleOutputTokens`, with reasoning excluded from `visibleOutputTokens`; cached input, legacy counted totals, raw provider totals, and reasoning details remain separate diagnostics, and complete pairs include a treatment/control ratio.

The adapter never lists, stops, prunes, removes, or rebuilds Docker containers, images, layers, volumes, or shared caches. Container lifecycle remains owned by the existing Pier harness. The historical `.work/deepswe-*` directories are evidence rather than canonical source. Credentialed benchmark execution requires explicit user authorization and a fresh same-manifest use/skip canary before the full gate.
