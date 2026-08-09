#!/usr/bin/env python3
"""Pier Codex adapter with auditable FreeContext benchmark sessions."""

from __future__ import annotations

import os
import shlex
import tempfile
import tomllib
from pathlib import Path, PurePosixPath

from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier_codex_noemaloom_agent import PierCodexBase


_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_ARCHIVE_VALUE = os.environ.get("FREECONTEXT_RUNTIME_ARCHIVE")
_PROFILE = Path(os.environ.get("FREECONTEXT_SUBAGENT_PROFILE", "/home/xu/.codex/ds.config.toml"))
_REMOTE_ROOT = PurePosixPath("/tmp/freecontext-runtime")
_REMOTE_SECRET_ROOT = PurePosixPath("/tmp/freecontext-secrets")
_REMOTE_SECRET = _REMOTE_SECRET_ROOT / "tokenrhythm"
_REMOTE_WRAPPER = _REMOTE_ROOT / "freecontext-pier"
_REMOTE_NODE = _REMOTE_ROOT / "runtime-bin/node"
_REMOTE_CODEX = _REMOTE_ROOT / "runtime-bin/codex"
_REMOTE_CODE_MODE_HOST = _REMOTE_ROOT / "runtime-bin/codex-code-mode-host"
_REMOTE_RG = _REMOTE_ROOT / "runtime-bin/rg"
_REMOTE_AGENT_DIR = PurePosixPath("/logs/agent")
_GUIDANCE = (
    "FreeContext is installed. Read and follow the installed `freecontext` skill "
    "for broad or cold repository exploration, then inspect decisive cited ranges "
    "before editing. A call may take several minutes: never start another while one "
    "is running, and never repeat a successful query. Every call prints the path to "
    "its preserved full session; keep that reference in the master-agent context. "
    "Never expose credentials or held-out solution material."
)


def _runtime_archive() -> Path:
    if _ARCHIVE_VALUE:
        return Path(_ARCHIVE_VALUE)
    return _PROJECT_ROOT / ".work" / "freecontext-runtime.tar.gz"


def _tokenrhythm_token() -> str:
    with _PROFILE.open("rb") as stream:
        config = tomllib.load(stream)
    provider_id = config.get("model_provider")
    provider = config.get("model_providers", {}).get(provider_id, {})
    token = provider.get("experimental_bearer_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError(f"missing TokenRhythm bearer token in {_PROFILE}")
    return token


class PierCodexFreeContext(PierCodexBase):
    """Current-default Codex with project-local FreeContext exploration."""

    @staticmethod
    def name() -> str:
        return "codex-freecontext"

    def network_allowlist(self) -> NetworkAllowlist:
        base = super().network_allowlist()
        return NetworkAllowlist(domains=[*base.domains, "tokenrhythm.studio"])

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

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await self._upload_freecontext(environment)
        original_skills_dir = getattr(self, "skills_dir", None)
        self.skills_dir = (_REMOTE_ROOT / "skills").as_posix()
        run_failed = False
        try:
            guided = f"{_GUIDANCE}\n\n<task>\n{instruction}\n</task>\n"
            await super().run(guided, environment, context)
        except BaseException:
            run_failed = True
            raise
        finally:
            try:
                await self._export_master_context(environment)
            except Exception:
                if run_failed:
                    self.logger.exception("Context export also failed after the master agent failed")
                else:
                    raise
            finally:
                self.skills_dir = original_skills_dir
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
                f"mkdir -p {remote_root} {remote_secret_root}"
            ),
        )
        await environment.upload_file(archive, remote_archive)

        secret_dir = archive.parent / "runtime-secrets"
        secret_dir.mkdir(mode=0o700, exist_ok=True)
        secret_path: Path | None = None
        try:
            descriptor, raw_path = tempfile.mkstemp(prefix="tokenrhythm-", dir=secret_dir)
            secret_path = Path(raw_path)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf8") as stream:
                stream.write(_tokenrhythm_token())
            await environment.upload_file(secret_path, _REMOTE_SECRET.as_posix())
        finally:
            if secret_path is not None:
                secret_path.unlink(missing_ok=True)

        default_user = environment.default_user or "agent"
        wrapper = _REMOTE_WRAPPER.as_posix()
        config = (_REMOTE_ROOT / "benchmarks/deepswe/freecontext.toml").as_posix()
        cli = (_REMOTE_ROOT / "bin/freecontext.mjs").as_posix()
        await self.exec_as_root(
            environment,
            command=(
                f"tar -xzf {remote_archive} -C {remote_root}; rm -f {remote_archive}; "
                f"chown -R {default_user} {remote_root} {remote_secret_root}; "
                f"chmod 755 {_REMOTE_NODE.as_posix()} {_REMOTE_CODEX.as_posix()} "
                f"{_REMOTE_CODE_MODE_HOST.as_posix()} {_REMOTE_RG.as_posix()}; "
                f"chmod 600 {_REMOTE_SECRET.as_posix()}; "
                f"cat > {wrapper} <<'SH'\n"
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f"TOKENRHYTHM_API_KEY=\"$(cat {_REMOTE_SECRET.as_posix()})\"\n"
                "export TOKENRHYTHM_API_KEY NODE_USE_ENV_PROXY=1\n"
                f"session_dir={(_REMOTE_AGENT_DIR / 'freecontext-sessions').as_posix()}\n"
                "mkdir -p \"$session_dir\"\n"
                "session_id=\"$(date -u +%Y%m%dT%H%M%S%N)-$$-${RANDOM}\"\n"
                "session_file=\"$session_dir/$session_id.json\"\n"
                "set +e\n"
                f"{_REMOTE_NODE.as_posix()} {cli} \"$@\" --config {config} "
                "--benchmark-session-file \"$session_file\"\n"
                "status=$?\n"
                "set -e\n"
                "if [[ -s \"$session_file\" ]]; then\n"
                "  printf '\\nFreeContext full session: %s\\n' \"$session_file\"\n"
                "else\n"
                "  printf '\\nFreeContext full session unavailable: %s\\n' \"$session_file\"\n"
                "fi\n"
                "exit \"$status\"\n"
                "SH\n"
                f"chmod 755 {wrapper}; "
                f"ln -sfn {_REMOTE_CODEX.as_posix()} /usr/local/bin/codex; "
                "if ! command -v rg >/dev/null 2>&1; then "
                f"ln -sfn {_REMOTE_RG.as_posix()} /usr/local/bin/rg; fi; "
                f"ln -sfn {wrapper} /usr/local/bin/freecontext"
            ),
        )

    async def _export_master_context(self, environment: BaseEnvironment) -> None:
        exporter = (_REMOTE_ROOT / "bin/freecontext-benchmark-context.mjs").as_posix()
        task_name = self.logs_dir.parent.name
        await self.exec_as_agent(
            environment,
            command=(
                f"{_REMOTE_NODE.as_posix()} {exporter} "
                f"--agent-dir {_REMOTE_AGENT_DIR.as_posix()} "
                f"--task-name {shlex.quote(task_name)}"
            ),
        )

    async def _cleanup_freecontext(self, environment: BaseEnvironment) -> None:
        wrapper = _REMOTE_WRAPPER.as_posix()
        try:
            await self.exec_as_root(
                environment,
                command=(
                    "if [ \"$(readlink /usr/local/bin/freecontext 2>/dev/null || true)\" = "
                    f"\"{wrapper}\" ]; then rm -f /usr/local/bin/freecontext; fi; "
                    "if [ \"$(readlink /usr/local/bin/codex 2>/dev/null || true)\" = "
                    f"\"{_REMOTE_CODEX.as_posix()}\" ]; then rm -f /usr/local/bin/codex; fi; "
                    "if [ \"$(readlink /usr/local/bin/rg 2>/dev/null || true)\" = "
                    f"\"{_REMOTE_RG.as_posix()}\" ]; then rm -f /usr/local/bin/rg; fi; "
                    f"rm -rf {_REMOTE_ROOT.as_posix()} {_REMOTE_SECRET_ROOT.as_posix()}"
                ),
            )
        except Exception:
            self.logger.exception("FreeContext task-container cleanup failed")
