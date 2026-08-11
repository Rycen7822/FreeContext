# DeepSWE benchmark context capture

`pier_codex_freecontext_agent.py` is the canonical Pier adapter for FreeContext-enabled DeepSWE runs. It keeps the main Codex configuration unchanged and injects only the TokenRhythm credential used by the FreeContext subagent.

The same module exports `PierCodexControl` for paired benchmarks. It uploads the identical local Codex runtime but does not register the FreeContext skill, wrapper, guidance, or TokenRhythm credential. Pass the same model, reasoning, authentication, and Codex TOML to both classes so FreeContext remains the only experimental distinction.

The adapter subclasses the existing NoemaLoom Pier Codex base used by the local DeepSWE harness. Put that harness directory (containing `pier_codex_noemaloom_agent.py`) on `PYTHONPATH` together with this directory before passing `pier_codex_freecontext_agent:PierCodexFreeContext` to Pier.

Set `FREECONTEXT_RUNTIME_ARCHIVE` to a task-owned runtime archive containing the built `dist/`, `bin/`, `prompts/`, `skills/`, this directory's `freecontext.toml`, production dependencies, and runtime binaries. The adapter never pulls or removes Docker images and does not clean resources owned by other runs.

Each `freecontext` invocation writes a unique private JSON file outside the explored repository and prints its durable in-container path back to the main agent:

```text
<final_answer>
...
</final_answer>

FreeContext full session: /logs/agent/freecontext-sessions/<invocation>.json
```

After Codex exits, the adapter writes these artifacts under Pier's task `agent/` directory:

- `master-agent-context.json`: a self-contained document containing the complete raw Codex session JSONL plus an ordered FreeContext call index (`promptToFreeContext`, `outputToMasterAgent`, and `fullSessionFile`). Export fails if a preserved FreeContext file is not referenced from the raw master context.
- `freecontext-sessions/*.json`: the separate original FreeContext session files, including the exact request, system prompts, raw primary/repair messages, effective post-compaction contexts, validation results, runtime events, and terminal outcome. Provider credentials and request headers are never serialized.
- `sessions/**/*.jsonl`: Pier's unchanged raw Codex session source.

The historical `.work/deepswe-*` directories are benchmark evidence, not the canonical adapter source. Use this directory for subsequent runs.
