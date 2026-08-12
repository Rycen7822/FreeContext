# Security model

## Security objective

The API-controlled child agent may inspect approved repository text but cannot modify files or invoke arbitrary commands through its tool interface.

## Enforced controls

### Capability allowlist

The model receives only `read`, `rg`, `glob`, and optionally `jq`/`bat`. There is no generic command tool. Tool selection is constructed in code and cannot be extended through prompt text or repository files.

### Process isolation properties

External readers are launched with `spawn(command, args)` and `shell:false`. Commands are resolved to absolute executable paths before use. Model-controlled values occupy individual argv elements, so shell metacharacters have no command-substitution meaning.

Each process has:

- closed stdin;
- bounded stdout/stderr capture;
- wall-clock timeout;
- scrubbed environment and temporary HOME;
- pager and user configuration disabled where supported.

### Filesystem confinement

Every direct path is lexically resolved under the workspace, then resolved again with `realpath`. Both forms must remain inside the real workspace root. This rejects `..`, absolute-path escape, and symlinks targeting outside files.

The following are blocked from direct read and recursive search:

- `.git`;
- real `.env` files;
- npm/Python/netrc credential files;
- conventional SSH private-key names;
- common private-key/certificate/keystore suffixes;
- common credential/service-account JSON names.

Directory-level `rg` and `glob` append mandatory deny globs after all model-controlled globs, then filter returned paths again. They exclude all `.env*` and `*.env` files, so a positive model glob cannot re-include a live dotenv file. Tracked TOML examples contain no credentials and remain ordinary readable repository files; the default populated catalog lives outside the repository.

The TOML schema accepts only a credential environment-variable name, never a credential value, and rejects sensitive custom-header names. Provider credentials are consumed by the model transport; repository tool subprocesses receive a scrubbed environment and the child has no shell or environment-inspection tool.

Direct `read`, `jq`, and `bat` access is capped at 32 MiB per file. The native reader receives both the parent cancellation signal and a tool timeout.

### Prompt injection boundary

Repository content is untrusted input. The system prompt instructs the child to treat source text as data. More importantly, repository instructions cannot grant additional tools or weaken path/process enforcement.

### Output integrity

Evidence citations are validated against the local filesystem. A model cannot fabricate a non-existent path or out-of-range line interval and still produce a successful CLI result.

### Benchmark capture boundary

`--benchmark-session-file` is an explicit host-side audit feature, not a model tool. Its destination parent must already exist, is resolved through `realpath`, and must remain outside the explored workspace. The writer uses a private `0600` file and refuses to overwrite an existing path. Provider credentials, configured secret values, and request headers are not part of the capture schema.

The file intentionally preserves prompts, final model messages, ordered stream deltas, repository tool calls/results, safe tool schemas, effective compacted contexts, and validation outcomes. Repeated growing partial-message snapshots are omitted from each delta because the complete final messages are already retained. A failed serialization or commit removes the incomplete private file instead of leaving a false session artifact. Benchmark operators must therefore protect and retain successful artifacts according to the repository's source-data policy.

## Residual risks

- Allowed repository source is sent to the selected remote model provider.
- Sensitive values embedded in ordinary source files under non-blocked names can be read.
- Local executables found on PATH are trusted; a malicious replacement `rg`, `jq`, or `bat` could violate assumptions.
- The process runs with the invoking user's OS permissions. The tool-level read-only design is not an operating-system sandbox.
- A model may return an incomplete evidence set; local validation establishes citation integrity, not semantic completeness.
- Opt-in benchmark session files may contain substantial repository source and task context even though they exclude provider credentials and request headers.

For stronger isolation, execute FreeContext in a read-only container or mount namespace with a controlled PATH and egress policy.
