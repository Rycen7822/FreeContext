---
name: freecontext
description: Delegate broad, cold-start, or repeatedly failing repository search to a read-only external subagent that returns compact file:line evidence. Use for locating implementations, call chains, registrations, configuration, tests, or cross-cutting behavior across an unfamiliar codebase. Skip when the exact file and narrow line range are already known.
---

# FreeContext repository exploration

Use FreeContext to keep exploratory search traces outside the main Codex context.

## Invocation rule

Invoke FreeContext when at least one condition holds:

- The repository or relevant subsystem is unfamiliar.
- The request spans several files, layers, symbols, registrations, tests, or configuration paths.
- Two ordinary searches failed to identify the relevant implementation.
- A compact evidence map is more useful than loading search output into the main context.

Do not invoke it when the exact target file and narrow range are already known, or when one direct `rg`/read call will answer the question.

## Command

Run one focused exploration request from the repository root:

```bash
freecontext explore -C "$PWD" --query '<precise evidence request>'
```

The query must state the behavior to trace and the evidence needed. Include likely symbols or subsystems when known. Do not include API keys, credentials, or file contents in the query.

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

FreeContext exposes structured `read`, `rg`, `glob`, and optional `jq`/`bat` tools. It has no edit, write, shell, network, package-manager, or version-control tool. Its output should never claim repository modifications.
