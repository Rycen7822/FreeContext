# FreeContext

[English](#english) | [简体中文](#简体中文)

## English

FreeContext is a read-only repository-exploration subagent for Codex. It offloads high-noise path discovery, symbol search, call-chain tracing, and narrow file reads to an external model session, while the main agent receives the worker's ordinary answer text.

The project uses a **skill + headless CLI** design:

- The Codex skill decides when to delegate broad or cold-start repository exploration.
- The `freecontext` CLI drives a streamlined Pi agent loop through a model API.
- The subagent exposes only structured `read`, `rg`, and `glob` tools, plus `jq` and `bat` when those local commands are detected.
- It has no TUI, interactive session tree, editor, arbitrary shell, file-writing, Git, web-browsing, extension-loading, or package-management tools.
- The system prompt is loaded from standalone Markdown; provider, model, and route settings come from strict TOML, while credentials stay in named environment variables.

The repository-exploration protocol is based on [FastContext: Training Efficient Repository Explorer for Coding Agents (v3)](https://arxiv.org/pdf/2606.14066v3). This project replaces the paper's specially trained model with a general Anthropic/OpenAI-compatible model API.

### Core Contract

The public MCP request is `{ question, hints?, sessionId? }`. The worker returns ordinary assistant text directly; the transport does not parse, size-fit, or validate a result format. The MCP content appends a short `Session: <id>` line so the main agent can continue with that id when useful. Formatting guidance lives in the worker system prompt.

### Architecture

```text
Codex main agent
      │
      │ skill selects a broad/cold exploration task
      ▼
freecontext CLI
      │
      ├── config.toml catalog + credential environment + external prompt
      ├── Pi low-level runAgentLoop (parallel tool execution)
      ├── Anthropic Messages or OpenAI Chat Completions adapter
      └── read-only structured tools
             ├── read   Node.js bounded line reader
             ├── rg     argv-only ripgrep search
             ├── glob   rg --files path discovery
             ├── jq     constrained JSON query (optional)
             └── bat    bounded rendering (optional)
      │
      ▼
ordinary answer text and a visible session id
```

The full interactive layer of the Pi coding agent is not included at runtime. FreeContext reuses the low-level `@earendil-works/pi-agent-core` agent loop and `@earendil-works/pi-ai` provider adapters, retaining parallel tool calls, the streaming message protocol, Anthropic/OpenAI-compatible conversion, and tool-schema validation while removing features unrelated to repository exploration. See [`docs/pi-pruning.md`](docs/pi-pruning.md) for details.

### Requirements

- Node.js `>= 22.19.0`
- Python `>= 3.10` with `gigatoken` and `tiktoken` for `o200k_base` context measurement; set `FREECONTEXT_PYTHON` when the executable is not `python3`
- `rg`: required
- `jq`: optional; enabled automatically when available
- `bat`, or `batcat` on Debian/Ubuntu: optional; enabled automatically when available

### Installation

```bash
git clone https://github.com/Rycen7822/FreeContext.git
cd FreeContext
npm install
python3 -m pip install gigatoken tiktoken
npm link
```

Check the runtime and local tools:

```bash
freecontext doctor
```

Install the local Codex skill:

```bash
bash scripts/install-codex-skill.sh
```

By default, the script creates a symbolic link at `$HOME/.agents/skills/freecontext`. To copy the skill instead, run:

```bash
bash scripts/install-codex-skill.sh copy
```

The repository also contains `.codex-plugin/plugin.json`, so it can be added to a local marketplace as a skills-only Codex plugin.

### Configuration

The default configuration file is:

```text
~/.config/freecontext/config.toml
```

Start from the tracked catalog:

```bash
mkdir -p ~/.config/freecontext
cp freecontext.example.toml ~/.config/freecontext/config.toml
chmod 600 ~/.config/freecontext/config.toml
```

Select another file with `--config` or `FREECONTEXT_CONFIG`:

```bash
freecontext --config /secure/path/freecontext.toml --query 'Locate the request routing path.'
```

#### TOML catalog

The versioned catalog separates transport providers, model targets, and named routes. Unknown fields and broken references fail locally before a provider request.

```toml
version = 1
default_route = "default"

[providers.primary]
api = "anthropic"
base_url = "https://api.anthropic.com"
auth_mode = "auto"
credential_env = "ANTHROPIC_API_KEY"

[models.claude]
provider = "primary"
model_id = "claude-model-id"
context_window = 128000
max_output_tokens = 4096

[routes.default]
models = ["claude"]
```

`providers` own protocol, endpoint, authentication mode, credential-variable name, and optional non-sensitive headers. `models` own model ids, context budgets, sampling/thinking settings, and OpenAI compatibility flags. `routes` contain ordered model-target ids and optional `fallback_on` categories. See [`freecontext.example.toml`](freecontext.example.toml) for Anthropic, OpenAI, and multi-provider route examples.

Provider `auth_mode` supports:

- `auto`: SDK API-key authentication for the Anthropic protocol and Bearer authentication for the OpenAI protocol.
- `bearer`: explicitly send `Authorization: Bearer ...`.
- `x-api-key`: explicitly send `x-api-key` for the Anthropic protocol.
- `both`: send both the SDK API key and a Bearer header for the small number of gateways that require them together.

Secret values are deliberately absent from TOML and CLI arguments. Export each variable named by `credential_env` through the shell or a secret manager; every target selected by a route must have its credential available. The parser rejects credential fields and sensitive custom-header names in TOML.

#### Route selection and fallback

Use the catalog's `default_route`, select a named route, or pin one target and disable fallback:

```bash
freecontext --route resilient --query 'Trace request routing.'
freecontext --target gpt --query 'Trace request routing.'
```

`--route` and `--target` are mutually exclusive. CLI selection overrides `FREECONTEXT_ROUTE` or `FREECONTEXT_TARGET`, which override `default_route`. Operational limits follow CLI > environment > `[runtime]` > built-in defaults. Repository exploration uses soft turn/tool budgets and a same-worker soft finalization prompt; the worker stops using tools and answers from current findings when the soft deadline arrives. Configure the budgets with `max_turns` and `max_tool_calls`, their `FREECONTEXT_MAX_TURNS` and `FREECONTEXT_MAX_TOOL_CALLS` environment variables, or the matching CLI options.

Transient failures identified by structured HTTP/provider/transport metadata, Pi's retry signal, or the exact TokenRhythm compatibility response retry only the failed assistant turn. The default retry-wait vector is 3/6/12 seconds with up to ±20% jitter. Completed repository tool results stay in context and are not executed again. Configure the full vector with `provider_retry_delays_ms = [3000, 6000, 12000]`, `FREECONTEXT_PROVIDER_RETRY_DELAYS_MS=3000,6000,12000`, or `--provider-retry-delays-ms 3000,6000,12000`; use an empty vector to disable retries.

A route tries model targets in declared order after the selected target exhausts its retry budget. Fallback is limited to configured `timeout`, `rate_limit`, `server_error`, and `connection` failures before any tool call has been accepted in the primary session. Authentication/configuration errors, aborts, generic failures, post-tool failures, and compaction never switch targets. Once a target succeeds, primary execution and compaction keep that same target and authenticated transport.

#### SenseNova

Copy the dedicated template:

```bash
mkdir -p ~/.config/freecontext
cp freecontext.sensenova.example.toml ~/.config/freecontext/config.toml
chmod 600 ~/.config/freecontext/config.toml
```

Then enter the **Anthropic-compatible base URL** provided by your SenseNova account documentation and supply the credential named by the template:

```bash
# Load SENSENOVA_API_KEY from your shell or secret manager first.
freecontext doctor
```

Do not infer an Anthropic-compatible URL from the OpenAI Chat Completions example URL in the public documentation. Use the actual endpoint shown in the account console or the documentation for the corresponding API. See [`docs/providers.md`](docs/providers.md) for details.

### Usage

Pass a request directly:

```bash
freecontext explore -C /path/to/repo \
  --query 'Locate how sessions are created, persisted, displayed, and resolved by session search. Return definitions, callers, schema, and tests.'
```

Pass a request through stdin:

```bash
printf '%s\n' 'Trace the plugin loading and hook dispatch path.' | freecontext -C /path/to/repo
```

Return JSON:

```bash
freecontext -C /path/to/repo --format json --query 'Find the configuration precedence rules.'
```

Enable lifecycle diagnostics:

```bash
freecontext -C /path/to/repo --verbose --query 'Find the request retry implementation.'
```

`--verbose` reports only turn/tool start and tool end events. It does not print model reasoning, file contents, tool arguments, or authentication information.

### External System Prompt

The default file is [`prompts/explorer.md`](prompts/explorer.md). Override it in TOML, with `FREECONTEXT_PROMPT_PATH`, or with `--prompt`:

```toml
[runtime]
prompt_path = "/absolute/path/custom-explorer.md"
```

A relative TOML path is resolved from the directory containing `config.toml`; CLI and environment paths are resolved from the current process.

The template supports three placeholders:

- `{{WORKSPACE}}`: the resolved workspace root.
- `{{TOOLS}}`: the names of the tools that are actually enabled.
- `{{OVERVIEW}}`: an overview of top-level directories and files.

The external prompt defines the search strategy and concise answer guidance. The worker returns ordinary assistant text; no output schema is enforced. The security boundary is enforced by tool registration, path resolution, and process invocation in code; it does not depend on prompt compliance.

### Read-Only Security Boundary

The model-facing explorer tool surface exposes no file-writing API. An optional host-controlled session capture is never registered as a model tool and refuses targets inside the explored workspace. External commands are implemented by fixed tools, invoked with argument arrays, and constrained by:

- `shell: false`.
- Executables resolved to absolute paths in advance.
- Closed stdin.
- A sanitized, minimal environment.
- Time, concurrency, and output-byte limits.
- Disabled ripgrep configuration files.
- Disabled bat configuration and pager.
- A jq module path pointing to an empty directory.
- Workspace realpath confinement.
- Blocking of `.git`, real `.env`/`*.env` files, and common private-key, certificate, and credential files.
- A 32 MiB limit for direct file reads, with cancellation and timeout handling in the native reader as well.

Directory-level `rg` and `glob` searches exclude every `.env*` and `*.env` file so that a positive glob supplied by the model cannot add sensitive files back. Tracked TOML examples contain no credentials and may be read like normal repository files; the default populated catalog lives outside the repository and secret values remain in its named environment variables.

These constraints prevent the subagent from modifying the workspace. It still sends retrieved code excerpts to the configured model API. Before using a private repository, confirm the provider's data-processing policy. See [`docs/security.md`](docs/security.md) for the complete threat model.

### Tests

```bash
npm test
npm run check
npm run smoke:mcp
```

Run a smoke test against a real provider:

```bash
npm run smoke:live -- 'Locate the CLI entry point and tool registry.'
```

The tests cover strict TOML parsing and precedence, route fallback safety, authentication headers, URL/key redaction, context compaction, path traversal, symlink escape, sensitive-file blocking, glob re-inclusion attacks, command injection, line-range reads, direct answer delivery, budget convergence, CLI arguments, and the router/worker loop.

### Relationship to the Paper

| FastContext design | FreeContext implementation |
|---|---|
| Specially trained repository explorer | General model API + strongly constrained external system prompt |
| READ / GLOB / GREP | `read` / `glob` / `rg`, plus constrained `jq` / `bat` |
| Parallel first-pass retrieval | Parallel tool execution in Pi `runAgentLoop` |
| Main agent receives only the worker answer | CLI stdout returns ordinary answer text |
| Paths and line ranges | The system prompt asks the worker to preserve exact locations |
| Rewrite the search after failure | Prompt requires independent hypotheses and refinement after failure |
| Main agent decides when to delegate | Codex skill defines broad/cold/failure triggers and an exact-file skip |

FreeContext does not reproduce the paper's training process, so it must not be assumed to achieve the token or success-rate gains reported in the paper. The project provides a replaceable model, a fixed protocol, and observable usage; future evaluation should use repository-level coding benchmarks to compare the main-agent baseline, different FreeContext models, and different invocation thresholds in paired trials.

## 简体中文

FreeContext 是面向 Codex 的只读代码仓库探索子代理。它把高噪声的路径发现、符号搜索、调用链追踪和窄范围文件读取放到外置模型会话中，主代理直接接收 worker 的普通回答文本。

项目采用 **skill + headless CLI** 形态：

- Codex skill 决定何时委派广泛或冷启动仓库探索。
- `freecontext` CLI 通过模型 API 驱动精简的 Pi agent loop。
- 子代理仅暴露结构化 `read`、`rg`、`glob`，以及检测到本机命令后启用的 `jq`、`bat`。
- 没有 TUI、交互会话树、编辑器、任意 shell、写文件、Git、网络浏览、扩展加载或包管理工具。
- system prompt 从独立 Markdown 加载；provider、model、route 使用严格 TOML 配置，凭据只从具名环境变量读取。

仓库探索协议参考 [FastContext: Training Efficient Repository Explorer for Coding Agents（v3）](https://arxiv.org/pdf/2606.14066v3)。本项目用通用 Anthropic/OpenAI 兼容模型 API 替代论文中的专门训练模型。

### 核心契约

公开 MCP 请求只有 `{ question, hints?, sessionId? }`。worker 直接返回普通 assistant 文本；传输层不解析、不拟合大小，也不验证结果格式。MCP content 末尾附加短的 `Session: <id>` 行，主代理需要继续追问时可使用该 id。输出风格只由 worker 的 system prompt 提示。

### 架构

```text
Codex main agent
      │
      │ skill selects a broad/cold exploration task
      ▼
freecontext CLI
      │
      ├── config.toml catalog + credential environment + external prompt
      ├── Pi low-level runAgentLoop (parallel tool execution)
      ├── Anthropic Messages or OpenAI Chat Completions adapter
      └── read-only structured tools
             ├── read   Node.js bounded line reader
             ├── rg     argv-only ripgrep search
             ├── glob   rg --files path discovery
             ├── jq     constrained JSON query (optional)
             └── bat    bounded rendering (optional)
      │
      ▼
ordinary answer text and a visible session id
```

Pi coding-agent 的完整交互层没有进入运行时。FreeContext 复用其底层 `@earendil-works/pi-agent-core` agent loop 与 `@earendil-works/pi-ai` provider adapters，保留并行 tool calling、流式消息协议、Anthropic/OpenAI 兼容转换和工具 schema 校验，删除仓库探索任务无关的功能。具体裁剪见 [`docs/pi-pruning.md`](docs/pi-pruning.md)。

### 环境要求

- Node.js `>= 22.19.0`
- Python `>= 3.10`，并安装 `gigatoken` 和 `tiktoken`，用于基于 `o200k_base` 的上下文 token 计量；可用 `FREECONTEXT_PYTHON` 指定非默认的 Python 可执行文件
- `rg`：必需
- `jq`：可选，存在时自动启用
- `bat` 或 Debian/Ubuntu 上的 `batcat`：可选，存在时自动启用

### 安装

```bash
git clone https://github.com/Rycen7822/FreeContext.git
cd FreeContext
npm install
python3 -m pip install gigatoken tiktoken
npm link
```

确认运行时和本地工具：

```bash
freecontext doctor
```

安装本地 Codex skill：

```bash
bash scripts/install-codex-skill.sh
```

该脚本默认把 skill 符号链接到 `$HOME/.agents/skills/freecontext`。需要复制时使用：

```bash
bash scripts/install-codex-skill.sh copy
```

仓库本身同时包含 `.codex-plugin/plugin.json`，可作为 skills-only Codex 插件加入本地 marketplace。

### 配置

默认配置文件：

```text
~/.config/freecontext/config.toml
```

从仓库内模板开始：

```bash
mkdir -p ~/.config/freecontext
cp freecontext.example.toml ~/.config/freecontext/config.toml
chmod 600 ~/.config/freecontext/config.toml
```

也可以用 `--config` 或 `FREECONTEXT_CONFIG` 指定其他文件：

```bash
freecontext --config /secure/path/freecontext.toml --query 'Locate the request routing path.'
```

#### TOML 配置目录

带版本号的配置目录把传输 provider、模型 target 和具名 route 分离；未知字段或错误引用会在发起 provider 请求前于本地失败。

```toml
version = 1
default_route = "default"

[providers.primary]
api = "anthropic"
base_url = "https://api.anthropic.com"
auth_mode = "auto"
credential_env = "ANTHROPIC_API_KEY"

[models.claude]
provider = "primary"
model_id = "claude-model-id"
context_window = 128000
max_output_tokens = 4096

[routes.default]
models = ["claude"]
```

`providers` 管理协议、endpoint、认证模式、凭据变量名和可选的非敏感 header；`models` 管理模型 id、上下文预算、采样/思考设置和 OpenAI 兼容标记；`routes` 保存有序模型 target id 和可选 `fallback_on` 分类。Anthropic、OpenAI 和多 provider route 完整示例见 [`freecontext.example.toml`](freecontext.example.toml)。

Provider 的 `auth_mode` 支持：

- `auto`：Anthropic 协议使用 SDK API-key 认证，OpenAI 协议使用 Bearer 认证；
- `bearer`：显式发送 `Authorization: Bearer ...`；
- `x-api-key`：Anthropic 协议显式发送 `x-api-key`；
- `both`：同时发送 SDK API key 与 Bearer header，用于少数代理网关。

TOML 和 CLI 参数都不接受 secret 值。请通过 shell 或 secret manager 提供每个 `credential_env` 指定的环境变量；route 选中的所有 target 都必须具备凭据。解析器会拒绝 TOML 中的凭据字段和敏感自定义 header 名。

#### Route 选择与降级

可以使用配置中的 `default_route`、指定具名 route，或锁定单个 target 并关闭降级：

```bash
freecontext --route resilient --query 'Trace request routing.'
freecontext --target gpt --query 'Trace request routing.'
```

`--route` 与 `--target` 互斥。CLI 选择覆盖 `FREECONTEXT_ROUTE` 或 `FREECONTEXT_TARGET`，后者再覆盖 `default_route`。运行限制遵循 CLI > 环境变量 > `[runtime]` > 内置默认值。仓库探索默认使用 8 个模型回合、18 次已接受工具调用作为软预算；软截止会在同一 worker 中提示停止工具并立即回答。不可配置的 24 回合、64 次已接受工具调用紧急上限也会结束探索。可通过 `max_turns`、`max_tool_calls`，对应的 `FREECONTEXT_MAX_TURNS`、`FREECONTEXT_MAX_TOOL_CALLS` 环境变量或 CLI 选项配置软预算。

仅当结构化 HTTP/provider/transport 元数据、Pi 的重试信号或 TokenRhythm 的精确兼容响应判定为短暂故障时，FreeContext 才会重试失败的 assistant turn。默认等待向量为 3/6/12 秒，并带最多 ±20% 抖动；已经完成的仓库工具结果会保留在上下文中，不会重复执行。可通过 `provider_retry_delays_ms = [3000, 6000, 12000]`、`FREECONTEXT_PROVIDER_RETRY_DELAYS_MS=3000,6000,12000` 或 `--provider-retry-delays-ms 3000,6000,12000` 配置完整向量；使用空向量即可关闭重试。

选中 target 的重试预算耗尽后，Route 才按声明顺序尝试下一个模型 target。仅当主会话尚未获得有用文本且错误属于已配置的 `timeout`、`rate_limit`、`server_error` 或 `connection` 时才允许降级。认证/配置错误、取消、普通错误和工具调用后的失败都不会切换 target。某个 target 成功后，主执行和压缩始终复用该 target 及其认证传输。

#### SenseNova

复制专用模板：

```bash
mkdir -p ~/.config/freecontext
cp freecontext.sensenova.example.toml ~/.config/freecontext/config.toml
chmod 600 ~/.config/freecontext/config.toml
```

随后填写 SenseNova 账户文档中给出的 **Anthropic 兼容 base URL**，并在环境中提供模板指定的凭据：

```bash
# 先通过 shell 或 secret manager 加载 SENSENOVA_API_KEY。
freecontext doctor
```

公开文档中的 OpenAI Chat Completions 示例地址不能据此推断 Anthropic 兼容地址；应使用账户控制台或对应接口文档给出的实际 endpoint。详见 [`docs/providers.md`](docs/providers.md)。

### 使用

直接传入请求：

```bash
freecontext explore -C /path/to/repo \
  --query 'Locate how sessions are created, persisted, displayed, and resolved by session search. Return definitions, callers, schema, and tests.'
```

通过 stdin 传入：

```bash
printf '%s\n' 'Trace the plugin loading and hook dispatch path.' | freecontext -C /path/to/repo
```

JSON 输出：

```bash
freecontext -C /path/to/repo --format json --query 'Find the configuration precedence rules.'
```

生命周期诊断：

```bash
freecontext -C /path/to/repo --verbose --query 'Find the request retry implementation.'
```

`--verbose` 只输出 turn/tool start/tool end，不打印模型思考、文件内容、工具参数或认证信息。

### 外部 system prompt

默认文件是 [`prompts/explorer.md`](prompts/explorer.md)。可通过 TOML、`FREECONTEXT_PROMPT_PATH` 或 `--prompt` 替换：

```toml
[runtime]
prompt_path = "/absolute/path/custom-explorer.md"
```

TOML 中的相对路径以 `config.toml` 所在目录为基准；CLI 与环境变量路径以当前进程为基准解析。

模板支持三个占位符：

- `{{WORKSPACE}}`：解析后的工作区根目录；
- `{{TOOLS}}`：当前实际启用的工具名；
- `{{OVERVIEW}}`：顶层目录/文件概览。

外部 prompt 负责搜索策略和精简回答提示；安全边界由代码层工具注册、路径解析和进程调用实现，不依赖 prompt 自律。

### 只读安全边界

面向模型的 explorer 工具面没有任何文件写入 API。外部命令由固定工具实现以 argv 数组调用，并强制：

- `shell: false`；
- 可执行文件预先解析为绝对路径；
- stdin 关闭；
- 清洗后的最小环境变量；
- 超时、并发和输出字节上限；
- ripgrep 配置文件禁用；
- bat 配置和 pager 禁用；
- jq module path 指向空目录；
- 工作区 realpath confinement；
- `.git`、真实 `.env`/`*.env`、常见私钥/证书/凭据文件阻断；
- 直接文件读取限制为 32 MiB，原生 reader 同样受取消信号和超时控制。

目录级 `rg`/`glob` 会排除全部 `.env*` 与 `*.env`，防止模型提供正向 glob 后重新纳入敏感文件。仓库内 TOML 示例不含凭据，可按普通项目文件读取；实际默认配置位于仓库之外，secret 值始终保留在其具名环境变量中。

这些约束阻止子代理修改工作区；它仍会把检索到的代码片段发送给配置的模型 API。私有仓库使用前必须确认相应供应商的数据处理政策。完整威胁模型见 [`docs/security.md`](docs/security.md)。

### 测试

```bash
npm test
npm run check
npm run smoke:mcp
```

真实 provider smoke test：

```bash
npm run smoke:live -- 'Locate the CLI entry point and tool registry.'
```

测试覆盖严格 TOML 解析与优先级、route 降级安全、认证 header、URL/key 去密、上下文压缩、路径越界、符号链接逃逸、敏感文件阻断、glob 重新纳入攻击、命令注入、行号读取、普通文本交付、预算收敛、CLI 参数和 router/worker loop。

### 与论文方案的对应关系

| FastContext 设计 | FreeContext 实现 |
|---|---|
| 专门训练的 repository explorer | 通用模型 API + 强约束外部 system prompt |
| READ / GLOB / GREP | `read` / `glob` / `rg`，补充受限 `jq` / `bat` |
| 并行首轮检索 | Pi `runAgentLoop` 的 parallel tool execution |
| 主代理只接收 worker 回答 | CLI stdout 返回普通回答文本 |
| 路径与行范围 | system prompt 要求 worker 保留精确位置 |
| 失败后改写搜索 | prompt 要求独立假设与失败后 refinement |
| 主代理决定何时委派 | Codex skill 明确 broad/cold/failure trigger 与 exact-file skip |

FreeContext 没有复现论文训练过程，因此不能预设达到论文报告的 token/成功率增益。项目提供了可替换模型、固定协议与可观测 usage，后续应通过 repository-level coding benchmark 对主代理基线、FreeContext 不同模型和不同调用阈值做成对评估。
