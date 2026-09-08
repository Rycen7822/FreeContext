# Using FreeContext

FreeContext exposes one MCP tool, `gather_context`, which summarizes captured native command output. Main chooses and executes the command; FC has no repository tools, shell execution, or inherited conversation.

## Request

Both fields are required strings:

```json
{
  "intent": "Extract timeout defaults and override precedence from this output.",
  "output": "Captured command output, including command, exit status and truncation metadata."
}
```

In the same code-mode cell, await the already-authorized native command into a variable, pass the intent and captured output to FC, and emit only the FC response to Main. Include command, exit status, and truncation metadata in the output string. If the command is still running, collect its terminal output inside code mode before summarizing. FC only knows the supplied intent and output.

## Result and recovery

The response is ordinary text with a `Session: <id>` handle and a `Captured output:` artifact reference. The submitted capture is saved as plain UTF-8 text beside the session for targeted line or byte reads. It preserves what the caller submitted; upstream truncation cannot be recovered or described as complete original command output. The full capture must fit the configured model context window with its response reserve. If it does not fit, FC fails before the provider call and retains the artifact reference so Main can select a smaller relevant portion; FC does not silently discard the tail or recursively summarize it.

Short output can return directly without a provider request, recorded as `result.summaryBypassed: true` in the private session. An MCP call therefore does not imply a model call. Larger output receives a single tool-free summary using the existing Pi/provider configuration and retry policy.

Main retains diagnosis, design, edits, verification, and targeted native reads. Summaries preserve relevant excerpts, observed locations, conditions, exceptions, and gaps. A summary cannot establish facts absent from the capture. On summary failure, use the retained artifact reference rather than rerunning the command merely to retry summarization; a large capture is not returned wholesale to Main.

## CLI

Supply the intent with `--intent` and captured text through `--output-file` or stdin:

```bash
freecontext --intent 'Extract timeout defaults and precedence.' --output-file /path/to/captured-output.txt
rg -n timeout src/config.ts | freecontext --intent 'Extract timeout defaults and precedence.'
```

The CLI reads the supplied text; it does not execute the command mentioned in the intent. Use `--format json` for the result object or `--verbose` for lifecycle diagnostics.
