# DeepSWE benchmark context capture

`pier_codex_freecontext_agent.py` exports the canonical treatment `PierCodexFreeContext` and paired `PierCodexControl`. The treatment adds one read-only stdio MCP server named `freecontext`, exposing the single enabled tool `gather_context`, plus one compact routing skill that selects that deferred tool. Control has neither the server nor the skill and has no FreeContext metadata, provider domain, credential, session directory, guidance, or CLI wrapper.

The router is only initially visible selection metadata and selected-skill instructions. It does not explore files, wrap the CLI, change the task instruction, or implement shell polling; exploration remains one atomic `gather_context` MCP call, followed by bounded decisive reads in the parent.

Both arms upload the same local Codex runtime and pass the original DeepSWE instruction unchanged to the same `PierCodexBase`. Keep task revision, image/cache state, model, reasoning effort, service tier, Fast setting, timeout, authentication, Codex CLI version, and any caller-supplied TOML identical. Changing one of those settings is a separate experiment, not a matched pair.

## Bound Pier integration

The adapter imports the active NoemaLoom `PierCodexBase` from `pier_codex_noemaloom_agent.py`. The 2026-08-11 implementation binds NoemaLoom revision `78aae216dcccf569c7cd8b819e238045d64f036f` and `datacurve-pier` 0.3.0. Treatment temporarily appends its MCP table through Pier's inherited `_config_toml` seam, which writes the isolated `/tmp/codex-home/config.toml`, and points inherited `skills_dir` at the uploaded runtime's `skills/` directory. It saves both caller values, sets the routing path only after upload, and restores both after the run. It does not invent or write a project configuration file.

Put the directory containing `pier_codex_noemaloom_agent.py` on `PYTHONPATH` together with this directory before passing `pier_codex_freecontext_agent:PierCodexFreeContext` or `pier_codex_freecontext_agent:PierCodexControl` to Pier.

Set `FREECONTEXT_RUNTIME_ARCHIVE` to a task-owned archive containing the built `dist/`, `bin/`, `prompts/`, `skills/freecontext/SKILL.md`, `skills/freecontext/agents/openai.yaml`, this directory's `freecontext.toml`, production dependencies, and runtime binaries. The treatment registers:

- startup timeout `30` seconds;
- tool timeout `1800` seconds;
- enabled tool `gather_context` only;
- explicit approval for that read-only annotated tool.

The benchmark host may set `FREECONTEXT_PROVIDER_BOOTSTRAP_PROFILE` to a local profile containing the authorized TokenRhythm URL and API key; it defaults to `/home/xu/.codex/ds.config.toml`. The adapter reads only the `model_providers.tokenrhythm` URL/key, verifies that the URL matches the bundled FreeContext TOML, and ignores the profile's selected model, wire protocol, and other Codex settings. The profile is a bootstrap source, not the main Codex or embedded Pi configuration.

The adapter copies only the extracted key to a task-owned mode-`0600` secret; it never changes the main Codex configuration. Codex starts the MCP launcher once. The root-owned launcher reads that secret, exports `TOKENRHYTHM_API_KEY` only to the FreeContext server process, and `exec`s `bin/freecontext-mcp.mjs` with the bundled TOML and `/logs/agent/freecontext-sessions`. FreeContext's embedded Pi runtime resolves TokenRhythm and `deepseek-v4-flash-0731` from that TOML. The token is never written into TOML, Codex guidance, a master context, or a FreeContext session. The plaintext copy and launcher are removed after verified export.

## Preserved artifacts

Each MCP result includes its separate in-container session path in compact text and structured output:

```text
Status: completed
Validated spans: 3
Gaps: 0
Full session: /logs/agent/freecontext-sessions/<call>.json
```

After Codex exits, the adapter preserves these artifacts under Pier's task `agent/` directory:

- `master-agent-context.json`: the complete raw Codex session JSONL plus an ordered FreeContext index containing `promptToFreeContext`, compact `outputToMasterAgent`, status, `fullSessionFile`, and `runtimeSessionFile`. Export fails if an MCP session declares a different path or its runtime path is absent from the raw master context.
- `freecontext-sessions/*.json`: separate original MCP session documents containing the exact request, raw primary/repair capture, effective post-compaction context, validation result, runtime events, compact result, terminal status, and exact model-visible text. Provider credentials and request headers are never serialized.
- `sessions/**/*.jsonl`: Pier's unchanged raw Codex session source.

The exporter continues to read legacy `freecontext-benchmark-session-v1` files during shadow adoption, but new treatment calls use MCP-v1 only. It references full sessions by path and never embeds their raw JSON in the call index. These artifacts may contain retained source text and are not deleted automatically.

The adapter never lists, stops, prunes, removes, or rebuilds Docker containers, images, layers, volumes, or shared caches. Container lifecycle remains owned by the existing Pier harness. The historical `.work/deepswe-*` directories are evidence rather than canonical source. The benchmark remains stopped: do not start a credentialed canary or full treatment run until the user explicitly resumes it; after resume, require a fresh treatment-only use/skip canary before the full treatment gate.
