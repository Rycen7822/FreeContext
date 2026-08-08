import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { redactUrl, resolveConfig } from "../config.js";
import { detectToolExecutables } from "../tools/index.js";
import { loadPiBindings } from "../runtime/pi-bindings.js";
import type { CliConfigOverrides, ResolvedRouteConfig } from "../config.js";

export const MIN_NODE_VERSION = Object.freeze([22, 19, 0]);

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly advisory?: boolean;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly Readonly<DoctorCheck>[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = Number(left[index] || 0) - Number(right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function currentNodeVersion(): number[] {
  return process.versions.node.split(".").map((value) => Number.parseInt(value, 10));
}

async function readable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(
  cli: CliConfigOverrides = {},
  { includeBindings = true }: Readonly<{ includeBindings?: boolean }> = {},
): Promise<Readonly<DoctorReport>> {
  const checks: DoctorCheck[] = [];
  const nodeVersion = currentNodeVersion();
  checks.push({
    name: "node",
    ok: compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0,
    detail: `${process.versions.node} (required >= ${MIN_NODE_VERSION.join(".")})`,
  });

  let routeConfig: ResolvedRouteConfig | undefined;
  try {
    routeConfig = await resolveConfig({ cli, requireApiKey: false });
    checks.push({
      name: "configuration",
      ok: true,
      detail: `route ${routeConfig.route} (${routeConfig.targets.length} target${routeConfig.targets.length === 1 ? "" : "s"})`,
    });
    checks.push({ name: "config-file", ok: true, detail: routeConfig.configFilePath });
    for (const target of routeConfig.targets) {
      checks.push({
        name: `target:${target.target}`,
        ok: true,
        detail: `${target.provider}/${target.api} ${target.model} @ ${redactUrl(target.baseUrl)}`,
      });
      checks.push({
        name: `api-key:${target.target}`,
        ok: Boolean(target.apiKey),
        detail: target.apiKey ? "configured" : "unset",
      });
    }
    const promptPath = routeConfig.targets[0]?.promptPath;
    if (!promptPath) throw new Error("Selected route has no model targets.");
    checks.push({ name: "system-prompt", ok: await readable(promptPath), detail: promptPath });
    if (await readable(promptPath)) {
      const prompt = await readFile(promptPath, "utf8");
      checks.push({
        name: "prompt-placeholders",
        ok: ["{{WORKSPACE}}", "{{TOOLS}}", "{{OVERVIEW}}"].every((item) => prompt.includes(item)),
        detail: "WORKSPACE, TOOLS, OVERVIEW",
      });
    }
  } catch (error) {
    checks.push({ name: "configuration", ok: false, detail: errorMessage(error) });
  }

  const executables = await detectToolExecutables();
  checks.push({ name: "rg", ok: Boolean(executables.rg), detail: executables.rg || "not found" });
  checks.push({ name: "jq", ok: Boolean(executables.jq), detail: executables.jq || "not found (optional)", advisory: true });
  checks.push({ name: "bat", ok: Boolean(executables.bat), detail: executables.bat || "not found (optional)", advisory: true });

  if (includeBindings && routeConfig) {
    for (const api of new Set(routeConfig.targets.map((target) => target.api))) {
      try {
        await loadPiBindings(api);
        checks.push({ name: `pi-runtime:${api}`, ok: true, detail: "loaded" });
      } catch (error) {
        checks.push({ name: `pi-runtime:${api}`, ok: false, detail: errorMessage(error) });
      }
    }
  }

  const ok = checks.every((check) => check.ok || check.advisory);
  return Object.freeze({ ok, checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))) });
}
