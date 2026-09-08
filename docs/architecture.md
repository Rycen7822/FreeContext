# Architecture

## Scope

FreeContext summarizes caller-captured output. The public boundary accepts exactly `{intent: string, output: string}`. Main owns command selection and native execution; FC has no repository exploration tools, shell execution, or inherited Main context.

## Runtime layers

1. **Main and routing skill** capture an already-authorized native command result into a variable inside code mode, including command, exit status, and truncation information. In that same cell they call `gather_context` with the intent and captured output, emitting only the FC response.
2. **MCP and CLI boundary** validate the request and bind it to a private invocation/session. CLI obtains output from `--output-file` or stdin and requires `--intent`.
3. **Summary runtime** returns short captures directly with `result.summaryBypassed: true`; otherwise it reuses the configured Pi/provider route for a single tool-free summary. Existing transient retry and deadline policies still apply.
4. **Result transport** returns ordinary text, the session handle, and a captured-output artifact reference. The host does not parse the model's prose into an answer schema.

## Configuration and routing

The default catalog is `$XDG_CONFIG_HOME/freecontext/config.toml`, falling back to `~/.config/freecontext/config.toml`. `--config` overrides `FREECONTEXT_CONFIG`, which overrides that default. TOML separates providers, models, routes, and shared runtime limits. Configured authentication material is not added to model prompts or captures. Caller-supplied output may itself contain sensitive text; the caller selects what may be submitted.

Existing provider adapters, request options, transient retries, and route fallback remain in use. Removing repository tools does not replace the configured model route.

## Context and session records

FC receives only the intent and supplied output. Before a provider request, the full capture must fit the configured model context window with its response reserve; an oversized capture fails with its artifact reference so Main can select a smaller portion. FC does not silently truncate the capture or recursively summarize it. The exact submitted output is retained in a plain UTF-8 artifact beside the private session for targeted line/byte reads. This is a capture of the caller's returned text, not proof that upstream output was complete. Session records associate the invocation, result, artifact, and diagnostics.

## Failure and metrics

Summary failure retains the capture reference for recovery without placing a large raw capture into Main's response. Main can reread the relevant range or retry summarization without repeating command execution.

Private metrics retain provider attempts, timing, and usage. A short-output bypass records `result.summaryBypassed: true` and makes no provider request, so MCP invocation counts and provider request counts are distinct.
