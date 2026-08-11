---
name: freecontext
description: Route multi-file code/workspace exploration, cross-document keyword/topic search, long-document fact extraction, and source-bound planning/review/diagnosis to the read-only gather_context MCP tool, including familiar repositories and known candidate files. Use before broad parent reads; skip when one bounded read/search in one known target fully answers.
---

# FreeContext routing

Use this skill only to select and call the atomic `gather_context` MCP tool. It is not an exploration implementation or CLI fallback.

- Before parent discovery or broad reads, call `gather_context` once when the task spans files, documents, evidence classes, or long-document sections.
- In Codex code mode, locate exactly `mcp__freecontext__gather_context` in `ALL_TOOLS` and invoke it from the same `functions.exec` call; forward its result to the parent without listing the full catalog.
- Pass exact argument keys `query` (a focused relationship/evidence request) and `workspace` (the absolute workspace root). Do not send secrets or source dumps.
- Skip FreeContext when one bounded read/search in one known target fully answers; never use it for edits, tests, Git, package managers, web, or credentials.
- After the result, read only decisive/edit ranges. Call again only for a material gap named by the result.
- If the MCP tool is unavailable, continue with native read-only tools and state that FreeContext was unavailable; do not use any CLI fallback.
