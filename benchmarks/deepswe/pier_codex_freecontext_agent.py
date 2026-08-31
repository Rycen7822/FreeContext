#!/usr/bin/env python3
"""Pier Codex adapter with auditable FreeContext benchmark sessions."""

from __future__ import annotations

import json
import os
import shlex
import tempfile
import tomllib
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier_codex_noemaloom_agent import PierCodexBase


_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_ARCHIVE_VALUE = os.environ.get("FREECONTEXT_RUNTIME_ARCHIVE")
_PROVIDER_CONFIG = Path(
    os.environ.get(
        "FREECONTEXT_PROVIDER_CONFIG_PATH", "/home/xu/.codex/freecontext_config.toml"
    )
)
_BUNDLED_FREECONTEXT_CONFIG = _PROJECT_ROOT / "benchmarks/deepswe/freecontext.toml"
_REMOTE_ROOT = PurePosixPath("/tmp/freecontext-runtime")
_REMOTE_SKILLS_DIR = _REMOTE_ROOT / "skills"
_REMOTE_SECRET_ROOT = PurePosixPath("/tmp/freecontext-provider-secrets")
_REMOTE_SECRET = _REMOTE_SECRET_ROOT / "api-key"
_REMOTE_LAUNCHER = PurePosixPath("/tmp/freecontext-mcp-launcher")
_REMOTE_NODE = _REMOTE_ROOT / "runtime-bin/node"
_REMOTE_PYTHON = _REMOTE_ROOT / "runtime-bin/python3"
_REMOTE_CODEX = _REMOTE_ROOT / "runtime-bin/codex"
_REMOTE_CODE_MODE_HOST = _REMOTE_ROOT / "runtime-bin/codex-code-mode-host"
_REMOTE_RG = _REMOTE_ROOT / "runtime-bin/rg"
_REMOTE_AGENT_DIR = PurePosixPath("/logs/agent")
_REMOTE_SESSION_DIR = _REMOTE_AGENT_DIR / "freecontext-sessions"
_REMOTE_WORKSPACE_ROOT = PurePosixPath("/app")
_REMOTE_CODEX_HOME = PurePosixPath("/tmp/codex-home")
_REMOTE_GLOBAL_AGENTS = _REMOTE_CODEX_HOME / "AGENTS.md"

COMMON_TASK_EFFECT_POLICY = (
    "[Benchmark common task-effect policy]\n"
    "Solve only from the workspace and existing local caches. Do not use web search, curl, wget, raw GitHub, remote git clone/ls-remote/fetch, npm view/pack, remote module or package queries, or any other upstream source discovery for the task solution or patch. Provider, Pier, and benchmark-controller network traffic is infrastructure and does not authorize task-solution network access."
)
COMMON_DIAGNOSTIC_CHECKPOINT = (
    "[Benchmark common diagnostic checkpoint]\n"
    "After an edit or failed check, make at most one direct read of the exact failure location. Before a second non-adjacent file read or cross-module search for that diagnosis, stop and classify the remaining gap. Single-file work, exact failures, routine checks, and the same handoff gap remain native. Never force a second call."
)
TREATMENT_DIAGNOSTIC_ROUTE = (
    "At this checkpoint, call gather_context only when the classified remaining gap is a distinct new static cross-module relationship not covered by the prior handoff."
)
CONTROL_DIAGNOSTIC_ROUTE = (
    "At this checkpoint, continue with native repository tools because FreeContext is disabled."
)
CONDITIONAL_FC_TREATMENT_POLICY = (
    "[Benchmark arm policy: conditional_fc_treatment]\n"
    "FreeContext is available in this treatment but arm enablement does not make a call automatic. Follow the installed skill and route the current evidence gap, whether initial or exposed after Evidence, an edit, or a check. Call gather_context only when that gap meets the skill conditions; otherwise handle bounded reads and ordinary edit/check/diff work directly. When called, gather_context is the only tool in that assistant batch/code cell: never parallelize, and do no native or other tool work during dispatch. If a cell ID returns, exclusively call functions.wait with yield_time_ms=300000 until terminal. Consume inline Evidence, handoff, and nextAction directly. Ready/partial and listed gaps do not themselves authorize reentry; only an explicitly parented child blocker exposed by Evidence/edit/check may reenter, while normalized same-target/scope/fact replay remains invalid."
    "\n"
    + TREATMENT_DIAGNOSTIC_ROUTE
)
EXPLICIT_NATIVE_ONLY_POLICY = (
    "[Benchmark arm policy: explicit_native_only]\n"
    "FreeContext is disabled for this arm. Use native repository tools for exploration "
    "and do not invoke FreeContext.\n"
    + CONTROL_DIAGNOSTIC_ROUTE
)


def _benchmark_developer_instructions(arm_policy: str) -> str:
    return f"{COMMON_TASK_EFFECT_POLICY}\n\n{COMMON_DIAGNOSTIC_CHECKPOINT}\n\n{arm_policy}"


def _global_agents_content(final_route: str) -> str:
    return f"{COMMON_DIAGNOSTIC_CHECKPOINT}\n\n{final_route}\n"


def _runtime_archive() -> Path:
    if _ARCHIVE_VALUE:
        return Path(_ARCHIVE_VALUE)
    return _PROJECT_ROOT / ".work" / "freecontext-runtime.tar.gz"


def _bundled_provider_base_url() -> str:
    with _BUNDLED_FREECONTEXT_CONFIG.open("rb") as stream:
        bundled = tomllib.load(stream)
    default_route = bundled.get("default_route")
    routes = bundled.get("routes")
    if not isinstance(default_route, str) or not isinstance(routes, dict):
        raise RuntimeError("bundled FreeContext configuration has no valid default route")
    route = routes.get(default_route)
    model_ids = route.get("models") if isinstance(route, dict) else None
    if not isinstance(model_ids, list) or len(model_ids) != 1 or not isinstance(model_ids[0], str):
        raise RuntimeError("bundled FreeContext default route must select one model")
    models = bundled.get("models")
    model = models.get(model_ids[0]) if isinstance(models, dict) else None
    provider_id = model.get("provider") if isinstance(model, dict) else None
    providers = bundled.get("providers")
    provider = providers.get(provider_id) if isinstance(providers, dict) and isinstance(provider_id, str) else None
    base_url = provider.get("base_url") if isinstance(provider, dict) else None
    parsed_url = urlparse(base_url) if isinstance(base_url, str) else None
    if (
        not isinstance(base_url, str)
        or parsed_url is None
        or parsed_url.scheme != "https"
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
    ):
        raise RuntimeError("bundled FreeContext default route has no valid HTTPS provider URL")
    return base_url


def _bundled_provider_hostname() -> str:
    hostname = urlparse(_bundled_provider_base_url()).hostname
    if not hostname:
        raise RuntimeError("bundled FreeContext default route has no provider hostname")
    return hostname


def _freecontext_provider_api_key() -> str:
    with _PROVIDER_CONFIG.open("rb") as stream:
        configured = tomllib.load(stream)
    provider = configured.get("provider")
    if not isinstance(configured, dict) or set(configured) != {"provider"}:
        raise RuntimeError("provider config must contain only a [provider] table")
    if not isinstance(provider, dict) or set(provider) != {"base_url", "api_key"}:
        raise RuntimeError("provider config must contain base_url and api_key")
    configured_url = provider.get("base_url") if isinstance(provider, dict) else None
    api_key = provider.get("api_key") if isinstance(provider, dict) else None
    bundled_url = _bundled_provider_base_url()
    if not isinstance(configured_url, str) or configured_url.rstrip("/") != bundled_url.rstrip("/"):
        raise RuntimeError("provider config URL does not match the bundled FreeContext default route")
    if not isinstance(api_key, str) or not api_key:
        raise RuntimeError("provider config is missing api_key")
    return api_key


class PierCodexFreeContext(PierCodexBase):
    """Current-default Codex with project-local FreeContext exploration."""

    @staticmethod
    def name() -> str:
        return "codex-freecontext"

    def network_allowlist(self) -> NetworkAllowlist:
        base = super().network_allowlist()
        return NetworkAllowlist(domains=[*base.domains, _bundled_provider_hostname()])

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(
                    user="root",
                    run="command -v bash >/dev/null && command -v tar >/dev/null",
                )
            ],
        )

    async def _configure_benchmark_git_identity(
        self, environment: BaseEnvironment
    ) -> None:
        await self.exec_as_agent(
            environment,
            command="git config --local user.name 'DeepSWE Benchmark Agent'",
            cwd=_REMOTE_WORKSPACE_ROOT.as_posix(),
        )
        await self.exec_as_agent(
            environment,
            command="git config --local user.email 'benchmark-agent@local.invalid'",
            cwd=_REMOTE_WORKSPACE_ROOT.as_posix(),
        )

    def _freecontext_mcp_config_toml(self) -> str:
        return f'''[mcp_servers.freecontext]
command = "{_REMOTE_LAUNCHER.as_posix()}"
args = ["--workspace-root", "{_REMOTE_WORKSPACE_ROOT.as_posix()}"]
env_vars = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]
required = true
startup_timeout_sec = 30
tool_timeout_sec = 300
enabled_tools = ["gather_context"]

[mcp_servers.freecontext.tools.gather_context]
approval_mode = "approve"
'''

    def _benchmark_config_toml(
        self,
        base_config: str | None,
        arm_policy: str,
        *,
        mcp_config: str | None = None,
    ) -> str:
        base_text = base_config or ""
        parsed_base = tomllib.loads(base_text) if base_text.strip() else {}
        if "developer_instructions" in parsed_base:
            raise RuntimeError("base Codex config already owns developer_instructions")
        layers = [
            f"developer_instructions = {json.dumps(_benchmark_developer_instructions(arm_policy))}",
            base_text.strip(),
            mcp_config.strip() if mcp_config else "",
        ]
        combined = "\n\n".join(layer for layer in layers if layer)
        tomllib.loads(combined)
        return f"{combined}\n"

    def _freecontext_config_toml(self, base_config: str | None) -> str:
        return self._benchmark_config_toml(
            base_config,
            CONDITIONAL_FC_TREATMENT_POLICY,
            mcp_config=self._freecontext_mcp_config_toml(),
        )

    async def _write_global_agents(
        self, environment: BaseEnvironment, final_route: str
    ) -> None:
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {_REMOTE_CODEX_HOME.as_posix()} && "
                f"printf '%s' {shlex.quote(_global_agents_content(final_route))} "
                f"> {_REMOTE_GLOBAL_AGENTS.as_posix()}"
            ),
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        original_config_toml = self._config_toml
        original_skills_dir = getattr(self, "skills_dir", None)
        run_started = False
        run_failed = False
        try:
            await self._upload_freecontext(environment)
            await self._configure_benchmark_git_identity(environment)
            self.skills_dir = _REMOTE_SKILLS_DIR.as_posix()
            self._config_toml = self._freecontext_config_toml(original_config_toml)
            await self._write_global_agents(environment, TREATMENT_DIAGNOSTIC_ROUTE)
            run_started = True
            await PierCodexBase.run(
                self,
                instruction,
                environment,
                context,
            )
        except BaseException:
            run_failed = True
            raise
        finally:
            try:
                if run_started:
                    await self._export_master_context(environment)
            except Exception:
                if run_failed:
                    self.logger.exception("Context export also failed after the master agent failed")
                else:
                    raise
            finally:
                self.skills_dir = original_skills_dir
                self._config_toml = original_config_toml
                await self._cleanup_freecontext(environment)

    async def _upload_freecontext(self, environment: BaseEnvironment) -> None:
        archive = _runtime_archive()
        if not archive.is_file():
            raise RuntimeError(f"missing FreeContext runtime archive: {archive}")

        remote_root = _REMOTE_ROOT.as_posix()
        remote_secret_root = _REMOTE_SECRET_ROOT.as_posix()
        remote_archive = "/tmp/freecontext-runtime.tar.gz"
        await self.exec_as_root(
            environment,
            command=(
                f"rm -rf {remote_root} {remote_secret_root} {remote_archive}; "
                f"rm -f {_REMOTE_LAUNCHER.as_posix()}; "
                f"mkdir -p {remote_root} {remote_secret_root}"
            ),
        )
        await environment.upload_file(archive, remote_archive)

        secret_dir = archive.parent / "runtime-secrets"
        secret_dir.mkdir(mode=0o700, exist_ok=True)
        secret_path: Path | None = None
        try:
            descriptor, raw_path = tempfile.mkstemp(prefix="provider-", dir=secret_dir)
            secret_path = Path(raw_path)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf8") as stream:
                stream.write(_freecontext_provider_api_key())
            await environment.upload_file(secret_path, _REMOTE_SECRET.as_posix())
        finally:
            if secret_path is not None:
                secret_path.unlink(missing_ok=True)

        default_user = environment.default_user or "agent"
        config = (_REMOTE_ROOT / "benchmarks/deepswe/freecontext.toml").as_posix()
        mcp_server = (_REMOTE_ROOT / "bin/freecontext-mcp.mjs").as_posix()
        await self.exec_as_root(
            environment,
            command=(
                f"tar -xzf {remote_archive} -C {remote_root}; rm -f {remote_archive}; "
                f"chown -R {default_user} {remote_root} {remote_secret_root}; "
                f"chmod 755 {_REMOTE_NODE.as_posix()} {_REMOTE_PYTHON.as_posix()} "
                f"{_REMOTE_CODEX.as_posix()} "
                f"{_REMOTE_CODE_MODE_HOST.as_posix()} {_REMOTE_RG.as_posix()}; "
                f"chmod 600 {_REMOTE_SECRET.as_posix()}; "
                f"mkdir -p {_REMOTE_SESSION_DIR.as_posix()}; "
                f"chown {default_user} {_REMOTE_SESSION_DIR.as_posix()}; "
                f"chmod 700 {_REMOTE_SESSION_DIR.as_posix()}; "
                f"cat > {_REMOTE_LAUNCHER.as_posix()} <<'SH'\n"
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f"FREECONTEXT_PROVIDER_API_KEY=\"$(cat {_REMOTE_SECRET.as_posix()})\"\n"
                f"FREECONTEXT_PYTHON={_REMOTE_PYTHON.as_posix()}\n"
                "export FREECONTEXT_PROVIDER_API_KEY FREECONTEXT_PYTHON NODE_USE_ENV_PROXY=1\n"
                f"exec {_REMOTE_NODE.as_posix()} {mcp_server} --config {config} "
                f"--session-dir {_REMOTE_SESSION_DIR.as_posix()} \"$@\"\n"
                "SH\n"
                f"chmod 755 {_REMOTE_LAUNCHER.as_posix()}; "
                f"ln -sfn {_REMOTE_CODEX.as_posix()} /usr/local/bin/codex; "
                "if ! command -v rg >/dev/null 2>&1; then "
                f"ln -sfn {_REMOTE_RG.as_posix()} /usr/local/bin/rg; fi"
            ),
        )

    async def _export_master_context(
        self,
        environment: BaseEnvironment,
        *,
        allow_unreferenced_sessions: bool = False,
    ) -> None:
        exporter = (_REMOTE_ROOT / "bin/freecontext-benchmark-context.mjs").as_posix()
        task_name = self.logs_dir.parent.name
        allow_flag = (
            " --allow-unreferenced-sessions" if allow_unreferenced_sessions else ""
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"{_REMOTE_NODE.as_posix()} {exporter} "
                f"--agent-dir {_REMOTE_AGENT_DIR.as_posix()} "
                f"--task-name {shlex.quote(task_name)}{allow_flag}"
            ),
        )

    async def _cleanup_freecontext(self, environment: BaseEnvironment) -> None:
        try:
            await self.exec_as_root(
                environment,
                command=(
                    f"rm -f {_REMOTE_SECRET.as_posix()} {_REMOTE_LAUNCHER.as_posix()}; "
                    f"rmdir {_REMOTE_SECRET_ROOT.as_posix()} 2>/dev/null || true; "
                    f"rm -rf {_REMOTE_CODEX_HOME.as_posix()}"
                ),
            )
        except Exception:
            self.logger.exception("FreeContext task-container cleanup failed")


class PierCodexControl(PierCodexFreeContext):
    """Current-default Codex using the same local runtime without FreeContext."""

    @staticmethod
    def name() -> str:
        return "codex-control"

    def network_allowlist(self) -> NetworkAllowlist:
        return PierCodexBase.network_allowlist(self)

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await self._upload_control_runtime(environment)
        original_config_toml = self._config_toml
        try:
            await self._configure_benchmark_git_identity(environment)
            self._config_toml = self._benchmark_config_toml(
                original_config_toml,
                EXPLICIT_NATIVE_ONLY_POLICY,
            )
            await self._write_global_agents(environment, CONTROL_DIAGNOSTIC_ROUTE)
            await PierCodexBase.run(
                self,
                instruction,
                environment,
                context,
            )
        finally:
            self._config_toml = original_config_toml
            await self._cleanup_control_runtime(environment)

    async def _upload_control_runtime(self, environment: BaseEnvironment) -> None:
        archive = _runtime_archive()
        if not archive.is_file():
            raise RuntimeError(f"missing FreeContext runtime archive: {archive}")

        remote_root = _REMOTE_ROOT.as_posix()
        remote_archive = "/tmp/codex-control-runtime.tar.gz"
        await self.exec_as_root(
            environment,
            command=f"rm -rf {remote_root} {remote_archive}; mkdir -p {remote_root}",
        )
        await environment.upload_file(archive, remote_archive)

        default_user = environment.default_user or "agent"
        await self.exec_as_root(
            environment,
            command=(
                f"tar -xzf {remote_archive} -C {remote_root}; rm -f {remote_archive}; "
                f"chown -R {default_user} {remote_root}; "
                f"chmod 755 {_REMOTE_CODEX.as_posix()} "
                f"{_REMOTE_CODE_MODE_HOST.as_posix()} {_REMOTE_RG.as_posix()}; "
                f"ln -sfn {_REMOTE_CODEX.as_posix()} /usr/local/bin/codex; "
                "if ! command -v rg >/dev/null 2>&1; then "
                f"ln -sfn {_REMOTE_RG.as_posix()} /usr/local/bin/rg; fi"
            ),
        )

    async def _cleanup_control_runtime(self, environment: BaseEnvironment) -> None:
        try:
            await self.exec_as_root(
                environment,
                command=(
                    "if [ \"$(readlink /usr/local/bin/codex 2>/dev/null || true)\" = "
                    f"\"{_REMOTE_CODEX.as_posix()}\" ]; then rm -f /usr/local/bin/codex; fi; "
                    "if [ \"$(readlink /usr/local/bin/rg 2>/dev/null || true)\" = "
                    f"\"{_REMOTE_RG.as_posix()}\" ]; then rm -f /usr/local/bin/rg; fi; "
                    f"rm -rf {_REMOTE_ROOT.as_posix()} {_REMOTE_CODEX_HOME.as_posix()}"
                ),
            )
        except Exception:
            self.logger.exception("Codex control task-container cleanup failed")
