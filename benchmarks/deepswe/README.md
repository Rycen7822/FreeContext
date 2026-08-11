# DeepSWE benchmark context capture

`pier_codex_freecontext_agent.py` exports the canonical treatment `PierCodexFreeContext` and paired `PierCodexControl`. The treatment differs only by one read-only stdio MCP server named `freecontext`, exposing the single enabled tool `gather_context`; control has no FreeContext server, metadata, provider domain, credential, session directory, skill, guidance, or CLI wrapper.

Both arms upload the same local Codex runtime and pass the original DeepSWE instruction unchanged to the same `PierCodexBase`. Keep task revision, image/cache state, model, reasoning effort, service tier, Fast setting, timeout, authentication, Codex CLI version, and any caller-supplied TOML identical. Changing one of those settings is a separate experiment, not a matched pair.

## Bound Pier integration

The adapter imports the active NoemaLoom `PierCodexBase` from `pier_codex_noemaloom_agent.py`. The 2026-08-11 implementation binds NoemaLoom revision `78aae216dcccf569c7cd8b819e238045d64f036f` and `datacurve-pier` 0.3.0. Treatment temporarily appends its MCP table through Pier's inherited `_config_toml` seam, which writes the isolated `/tmp/codex-home/config.toml`, and restores the caller's original value after the run. It does not invent or write a project configuration file.

Put the directory containing `pier_codex_noemaloom_agent.py` on `PYTHONPATH` together with this directory before passing `pier_codex_freecontext_agent:PierCodexFreeContext` or `pier_codex_freecontext_agent:PierCodexControl` to Pier.

Set `FREECONTEXT_RUNTIME_ARCHIVE` to a task-owned archive containing the built `dist/`, `bin/`, `prompts/`, this directory's `freecontext.toml`, production dependencies, and runtime binaries. The treatment registers:

- startup timeout `30` seconds;
- tool timeout `1800` seconds;
- enabled tool `gather_context` only;
- explicit approval for that read-only annotated tool.

Codex starts the MCP launcher once. The root-owned launcher reads the task-owned mode-`0600` TokenRhythm secret, exports `TOKENRHYTHM_API_KEY` only to the FreeContext server process, and `exec`s `bin/freecontext-mcp.mjs` with the bundled TOML and `/logs/agent/freecontext-sessions`. The token is never written into TOML, Codex guidance, a master context, or a FreeContext session. The plaintext copy and launcher are removed after verified export.

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

The adapter never lists, stops, prunes, removes, or rebuilds Docker containers, images, layers, volumes, or shared caches. Container lifecycle remains owned by the existing Pier harness. The historical `.work/deepswe-*` directories are evidence rather than canonical source; use this directory and a fresh matched canary before a full paired run.
