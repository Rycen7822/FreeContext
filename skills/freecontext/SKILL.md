---
name: freecontext
description: Route multi-file code/workspace exploration, cross-document keyword/topic search, long-document fact extraction, source-bound planning/review/diagnosis via gather_context, including familiar repositories and known candidate files. When selected, first tool turn reads this skill alone—not plan/pwd/Git/list/search/source; next calls FreeContext. Skip when one bounded read/search in one known target fully answers.
---

# FreeContext routing

This skill only routes to the atomic `gather_context` MCP tool; it is not an exploration implementation or CLI fallback.

- First tool turn after selecting this skill: read only this file. Do not combine that read with planning, `pwd`, Git, listing, search, source/document reads, or sibling work in the same `functions.exec`.
- Next tool turn: locate exactly `mcp__freecontext__gather_context` in `ALL_TOOLS` and invoke it in that same `functions.exec`; do not plan or inspect the workspace first, and forward its result to the parent without listing the full catalog.
- Before parent discovery or broad reads, call `gather_context` once when the task spans files, documents, evidence classes, or long-document sections.
- Pass exact argument keys `query` (a focused relationship/evidence request) and `workspace` (the absolute workspace root). Do not send secrets or source dumps.
- Skip FreeContext when one bounded read/search in one known target fully answers; never use it for edits, tests, Git, package managers, web, or credentials.
- After the result, read only decisive/edit ranges. Call again only for a material gap named by the result.
- If the MCP tool is unavailable, continue with native read-only tools and state that FreeContext was unavailable; do not use any CLI fallback.
