# Pi coding-agent pruning

FreeContext is a headless extraction from Pi coding-agent's runtime stack. It deliberately depends on the small public packages beneath the full interactive application rather than importing its full session UI.

## Retained

- Low-level stateful agent loop.
- Structured tool schemas and argument validation.
- Parallel tool execution.
- Assistant/tool-result transcript handling.
- Anthropic Messages streaming conversion.
- OpenAI Chat Completions streaming conversion.
- Provider error-as-message semantics.
- Model/tool token usage fields.

## Removed

- TUI rendering and keyboard handling.
- Interactive editor and command palette.
- Session tree, branching, resume, compaction, and persistence.
- Authentication UI and provider catalog UI.
- Extension/plugin loader inside the child runtime.
- General-purpose bash/shell tool.
- Write/edit/patch tools.
- Git operations.
- Web/network tools.
- Image handling.
- Background jobs and process sessions.
- Custom themes, widgets, notifications, and status UI.

## Why this boundary

Importing the full coding-agent package would retain code paths that the repository explorer must never expose and would make the read-only claim depend on runtime configuration. Using `pi-agent-core` plus direct provider adapters makes the capability set construction explicit: the model sees only the tools instantiated in `src/tools/index.mjs`.

The resulting CLI still follows Pi's agent/tool/provider contracts while keeping the executable surface small enough to audit.

The upstream `pi-ai` npm package declares SDK dependencies for several providers at package granularity. Those transitive packages may therefore be installed even though FreeContext imports only the Anthropic Messages or OpenAI Chat Completions subpath selected at runtime. They are not registered as model tools and do not enlarge the child agent's capability set.
