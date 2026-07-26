import { ConfigurationError } from "../errors.mjs";

const API_MODULES = Object.freeze({
  anthropic: "@earendil-works/pi-ai/api/anthropic-messages",
  openai: "@earendil-works/pi-ai/api/openai-completions",
});

export async function loadPiBindings(api, overrides = null) {
  if (overrides) {
    const required = ["runAgentLoop", "Type", "streamSimple"];
    for (const name of required) {
      if (!overrides[name]) throw new ConfigurationError(`Injected Pi binding is missing: ${name}`);
    }
    return overrides;
  }

  const apiModule = API_MODULES[api];
  if (!apiModule) throw new ConfigurationError(`Unsupported Pi API binding: ${api}`);

  try {
    const [agent, ai, provider] = await Promise.all([
      import("@earendil-works/pi-agent-core"),
      import("@earendil-works/pi-ai"),
      import(apiModule),
    ]);
    if (typeof agent.runAgentLoop !== "function") throw new Error("runAgentLoop export is unavailable");
    if (!ai.Type) throw new Error("Type export is unavailable");
    if (typeof provider.streamSimple !== "function") throw new Error("streamSimple export is unavailable");
    return Object.freeze({ runAgentLoop: agent.runAgentLoop, Type: ai.Type, streamSimple: provider.streamSimple });
  } catch (error) {
    throw new ConfigurationError(
      "Pi runtime could not be loaded. Install dependencies with `npm install` under Node.js 22.19 or newer.",
      { cause: error },
    );
  }
}
