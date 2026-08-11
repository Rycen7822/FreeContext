# Using FreeContext

FreeContext exposes one read-only MCP tool, `gather_context`. Give it one focused semantic request and an absolute workspace path. It performs the broad exploratory reads internally, returns compact validated evidence, and writes the complete child session to the private path in `sessionFile`.

The workspace may be a Git repository, a regular document directory, or a directory containing one long document. Familiarity is not a gate: use the tool whenever the answer requires several exploratory reads or evidence classes, even when filenames, symbols, or likely locations are already known.

## Decision table

| Task shape | Use `gather_context`? | Why |
| --- | --- | --- |
| Trace one behavior across implementations, callers, registrations, configuration, and tests | Yes | The answer spans files or evidence classes. |
| Search a document set for a keyword, phrase, or topic and aggregate the relevant passages | Yes | Cross-document search is more than one direct lookup. |
| Extract several facts, constraints, dates, or exceptions from a long document | Yes | The answer requires exploratory reads across sections. |
| Map the impact of a known symbol in a familiar workspace | Yes | Knowing the symbol does not reveal all downstream relationships. |
| Prepare a source-bound plan, review, comparison, or diagnosis from several files | Yes | The tool can return one compact evidence map for the parent. |
| Read one exact bounded range in one known file | No | The parent can perform the decisive read directly. |
| Run one direct search in one known target that fully answers the question | No | No multi-step exploration is needed. |
| Edit files, run tests, install packages, or perform Git operations | No | These remain parent-agent responsibilities. |

An unfamiliar workspace alone is not sufficient when one exact operation answers the request. Conversely, a familiar workspace is not a reason to skip multi-file or multi-document exploration.

## Responsibility matrix

| Responsibility | FreeContext | Parent agent |
| --- | --- | --- |
| Broad read-only exploration and relationship tracing | Owns | Describes the evidence needed. |
| Cross-document search and long-document extraction | Owns | Supplies known phrases, candidates, or constraints. |
| Validate returned file paths and line ranges | Owns | Treats them as a navigation map. |
| Preserve the complete child transcript | Owns | Retains or cites `sessionFile` when full context is needed. |
| Read exact edit or decisive ranges | Does not own | Owns before editing or making a high-confidence claim. |
| Edit, test, install, commit, or push | Cannot perform | Owns. |

## Write a relationship query

Ask for relationships and required evidence, not a vague repository summary:

```text
Trace how <behavior, symbol, phrase, or constraint> is defined, transformed, configured,
called, persisted, and tested across this workspace. Include known candidates <names/paths>
without assuming they are exhaustive. Return the decisive file:line ranges, explain each
relationship, and name any material gap.
```

For document work, replace code relationships with the facts to reconcile:

```text
Find every passage about <keyword/topic> across the documents. Reconcile definitions,
dates, constraints, exceptions, and disagreements. Return the decisive file:line ranges
and name any material gap.
```

Never put credentials or raw source/document dumps in the query. The configured external model provider receives approved workspace content during exploration.

## Examples

- **Known symbol, unknown impact:** “Trace every producer and consumer of `SessionRecord`, including persistence, migration, display, and tests; identify compatibility risks.”
- **Familiar cross-layer bug:** “Trace how cancellation travels from the HTTP route through the service and provider adapter to cleanup; find paths that can leave a session open.”
- **Source-bound planning:** “Map the current configuration-loading seams and tests needed to add per-provider routing without duplicating credential handling.”
- **Review:** “Compare the changed session-store behavior with its callers, security constraints, and tests; return omissions or contradictions with evidence.”
- **Configuration tracing:** “Trace `tool_timeout_sec` from plugin metadata through config parsing to the spawned MCP process and document all defaults.”
- **Cross-document aggregation:** “Find all uses and variants of ‘retention period’ across these policy documents and reconcile their scopes.”
- **Long-document extraction:** “Extract every deadline, prerequisite, exception, and named owner from this specification, with the exact supporting ranges.”
- **Exact skip:** when the only need is `src/config.ts:42-58`, read that range directly; when one search for a unique key in one known file fully answers, search it directly.

## Consume one result

Use `summary`, `evidence`, and `gaps` as the compact navigation result. `completed` means all returned evidence validated; `partial` preserves valid evidence while naming validation gaps; `no_evidence` means no locally valid citation survived; `failed` reports a provider, cancellation, or storage failure. Inspect `sessionFile` only when the complete child context is required.

Do not replay the broad exploration in the parent. Read only the cited ranges that are decisive for the next edit or claim. Make a follow-up call only when the previous result names a material gap that direct reading cannot close; target that gap instead of repeating the successful request.
