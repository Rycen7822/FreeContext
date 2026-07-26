import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { redactUrl, resolveConfig } from "../config.mjs";
import { detectToolExecutables } from "../tools/index.mjs";
import { loadPiBindings } from "../runtime/pi-bindings.mjs";

export const MIN_NODE_VERSION = Object.freeze([22, 19, 0]);

export function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = Number(left[index] || 0) - Number(right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function currentNodeVersion() {
  return process.versions.node.split(".").map((value) => Number.parseInt(value, 10));
}

async function readable(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(cli = {}, { includeBindings = true } = {}) {
  const checks = [];
  const nodeVersion = currentNodeVersion();
  checks.push({
    name: "node",
    ok: compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0,
    detail: `${process.versions.node} (required >= ${MIN_NODE_VERSION.join(".")})`,
  });

  let config;
  try {
    config = await resolveConfig({ cli, requireApiKey: false });
    checks.push({ name: "configuration", ok: true, detail: `${config.api} ${config.model} @ ${redactUrl(config.baseUrl)}` });
    checks.push({
      name: "api-key",
      ok: Boolean(config.apiKey),
      detail: config.apiKey ? "configured" : "unset",
    });
    checks.push({
      name: "env-file",
      ok: config.envFileLoaded,
      detail: `${config.envFilePath}${config.envFileLoaded ? "" : " (using process environment/defaults)"}`,
      advisory: !config.envFileLoaded,
    });
    checks.push({ name: "system-prompt", ok: await readable(config.promptPath), detail: config.promptPath });
    if (await readable(config.promptPath)) {
      const prompt = await readFile(config.promptPath, "utf8");
      checks.push({
        name: "prompt-placeholders",
        ok: ["{{WORKSPACE}}", "{{TOOLS}}", "{{OVERVIEW}}"].every((item) => prompt.includes(item)),
        detail: "WORKSPACE, TOOLS, OVERVIEW",
      });
    }
  } catch (error) {
    checks.push({ name: "configuration", ok: false, detail: error.message });
  }

  const executables = await detectToolExecutables();
  checks.push({ name: "rg", ok: Boolean(executables.rg), detail: executables.rg || "not found" });
  checks.push({ name: "jq", ok: Boolean(executables.jq), detail: executables.jq || "not found (optional)", advisory: true });
  checks.push({ name: "bat", ok: Boolean(executables.bat), detail: executables.bat || "not found (optional)", advisory: true });

  if (includeBindings && config) {
    try {
      await loadPiBindings(config.api);
      checks.push({ name: "pi-runtime", ok: true, detail: "loaded" });
    } catch (error) {
      checks.push({ name: "pi-runtime", ok: false, detail: error.message });
    }
  }

  const ok = checks.every((check) => check.ok || check.advisory);
  return Object.freeze({ ok, checks: Object.freeze(checks.map(Object.freeze)) });
}
