---
name: freecontext
description: Manual FreeContext CLI compatibility fallback. Use only when the user explicitly requests FreeContext and the gather_context MCP tool is unavailable; never auto-trigger this skill for ordinary exploration or document search.
---

# FreeContext legacy CLI fallback

The primary interface is the read-only `gather_context` MCP tool. It owns multi-file and multi-document exploration, cross-document search, long-document information extraction, tracing, comparison, impact mapping, planning, review, and diagnosis. The parent agent reads the returned decisive ranges before editing or making a high-confidence claim.

Do not load or invoke this skill during normal exploration. Use this compatibility path only when both conditions hold:

- the user explicitly asks to use FreeContext; and
- `gather_context` is unavailable in the current process.

If the MCP tool is available, call it directly without reading this skill. If neither condition holds, use the host's normal tools.

## Manual compatibility command

Run one focused exploration request from the repository root:

```bash
freecontext explore -C "$PWD" --query '<precise evidence request>'
```

The query must state the relationship or facts to trace and the evidence needed. Include likely symbols, files, phrases, or subsystems when known. Do not include API keys, credentials, source dumps, or document contents in the query.

A strong query asks for relationships, for example:

```text
Locate how session IDs are created, displayed in the TUI, persisted, and resolved by session search. Return the defining functions, callers, storage schema, and relevant tests.
```

## Consuming the result

FreeContext returns a validated block:

```text
<final_answer>
summary: ...
evidence:
- path/file.ts:10-42 — ...
gaps:
- none
</final_answer>
```

Use the evidence list as a navigation map. Read the cited narrow ranges with the host's native file reader before editing or making a high-confidence claim. Do not treat the subagent summary as a substitute for inspecting decisive code.

Issue a second FreeContext call only when the first result declares a material gap that cannot be resolved by directly reading its cited files. Make the second query target that gap; do not repeat the original broad request.

## Safety boundary

FreeContext exposes structured `read`, `rg`, `glob`, and optional `jq`/`bat` workspace tools. It has no edit, write, shell, package-manager, test-runner, or version-control capability. Its configured model provider is external, so do not send credentials or unnecessary source/document dumps. Its output should never claim repository modifications.
