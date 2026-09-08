# FreeContext

[English](#english) | [简体中文](#简体中文)

## English

FreeContext summarizes captured native command output for Codex. Main selects and executes the command in code mode, passes its captured result to FreeContext, and receives only the final summary.

The project uses a **skill + headless CLI** design:

- The Codex skill keeps native execution and summary delivery in the same code-mode cell.
- The `freecontext` CLI drives a streamlined Pi agent loop through a model API.
- The summary worker has no tools and receives only the supplied intent and output.
- It has no TUI, interactive session tree, editor, arbitrary shell, file-writing, Git, web-browsing, extension-loading, or package-management tools.
- The system prompt is loaded from standalone Markdown; provider, model, and route settings come from strict TOML, while credentials stay in named environment variables.

The project was inspired by [FastContext: Training Efficient Repository Explorer for Coding Agents (v3)](https://arxiv.org/pdf/2606.14066v3). The current command-output summary route differs from that repository-exploration design.

### Core Contract

The public MCP request is `{ intent: string, output: string }`. In one code-mode cell Main captures its native command result, passes it with command/exit/truncation metadata to `gather_context`, and emits only the FC response. FC has no tools or inherited conversation. Responses include ordinary text, a session handle, and a plain-text capture artifact reference for targeted rereads, including on summary failure. Short output bypasses the provider with `result.summaryBypassed: true`; an MCP call is not necessarily a model call. The capture preserves submitted text, not missing upstream-truncated output. See [`docs/usage.md`](docs/usage.md).

### Architecture

```text
Main native command -> captured variable (same code-mode cell)
                    -> gather_context {intent, output}
                    -> short-output bypass OR Pi/provider summary (no tools)
                    -> final text + session/capture reference -> Main
```

FreeContext reuses the low-level Pi runtime and provider adapters for a single tool-free summary, retaining existing provider/model/route configuration.

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
freecontext --config /secure/path/freecontext.toml --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
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
freecontext --route resilient --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
freecontext --target gpt --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
```

`--route` and `--target` are mutually exclusive. CLI selection overrides `FREECONTEXT_ROUTE` or `FREECONTEXT_TARGET`, which override `default_route`. Operational limits follow CLI > environment > `[runtime]` > built-in defaults. The summary worker makes no repository tool calls; existing provider timeout and retry configuration remains applicable.

Transient failures identified by structured HTTP/provider/transport metadata, Pi's retry signal, or the exact TokenRhythm compatibility response retry only the failed assistant turn. The default retry-wait vector is 3/6/12 seconds with up to ±20% jitter. Retries reuse the supplied capture. Configure the full vector with `provider_retry_delays_ms = [3000, 6000, 12000]`, `FREECONTEXT_PROVIDER_RETRY_DELAYS_MS=3000,6000,12000`, or `--provider-retry-delays-ms 3000,6000,12000`; use an empty vector to disable retries.

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

Summarize captured output from a file or stdin:

```bash
freecontext --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
rg -n timeout src/config.ts | freecontext --intent 'Extract timeout defaults and precedence.'
```

Add `--format json` for structured results or `--verbose` for lifecycle diagnostics. The CLI does not execute commands supplied in the intent.

### External System Prompt

The default file is [`prompts/explorer.md`](prompts/explorer.md). Override it in TOML, with `FREECONTEXT_PROMPT_PATH`, or with `--prompt`:

```toml
[runtime]
prompt_path = "/absolute/path/custom-explorer.md"
```

A relative TOML path is resolved from the directory containing `config.toml`; CLI and environment paths are resolved from the current process.

The external prompt guides evidence extraction from supplied output. No repository tools or workspace overview are passed to the summary worker.

### Security Boundary

FC cannot execute commands or explore files. Main controls which native output is submitted to the configured model API. Configured authentication material is not added to prompts or captures, but caller-supplied output may contain sensitive text. Captured text is stored beside the session; summary failure returns its reference instead of a large raw capture.

### Tests

```bash
npm test
npm run check
npm run smoke:mcp
```

The checks cover configuration, provider routing, CLI/MCP contracts, captured-output persistence, and summary delivery.

### Relationship to the Paper

The current route keeps command execution in Main and delegates only captured-output summarization. Historical exploration results do not establish the benefit of this route.

FreeContext does not reproduce the paper's training process, so it must not be assumed to achieve the token or success-rate gains reported in the paper. The project provides a replaceable model, a fixed protocol, and observable usage; future evaluation should use repository-level coding benchmarks to compare the main-agent baseline, different FreeContext models, and different invocation thresholds in paired trials.

## 简体中文

FreeContext 为 Codex 摘要原生命令的捕获输出。Main 在 code mode 中选择并执行命令，将捕获结果交给 FreeContext，只接收最终摘要。

项目采用 **skill + headless CLI** 形态：

- Codex skill 将原生命令执行和摘要交付放在同一个 code-mode cell 中。
- `freecontext` CLI 通过模型 API 驱动精简的 Pi agent loop。
- 摘要 worker 没有工具，只接收提供的 intent 和 output，不继承 Main 上下文。
- 没有 TUI、交互会话树、编辑器、任意 shell、写文件、Git、网络浏览、扩展加载或包管理工具。
- system prompt 从独立 Markdown 加载；provider、model、route 使用严格 TOML 配置，凭据只从具名环境变量读取。

项目最初参考 [FastContext: Training Efficient Repository Explorer for Coding Agents（v3）](https://arxiv.org/pdf/2606.14066v3)。当前命令输出摘要路线与论文的自主仓库探索设计不同。

### 核心契约

公开 MCP 请求为 `{ intent: string, output: string }`。Main 在同一个 code-mode cell 中捕获原生命令结果，将命令、退出状态和截断信息随 output 交给 `gather_context`，只输出 FC 返回。FC 没有工具，也不继承对话。返回包含普通文本、session 标识和可定点回读的纯文本 capture artifact 引用；摘要失败时仍保留引用。短输出直接返回，记录 `result.summaryBypassed: true`，所以 MCP 调用不等于模型调用。capture 只保留提交的文本，不能恢复上游截断内容。见 [`docs/usage.md`](docs/usage.md)。

### 架构

```text
Main native command -> captured variable (same code-mode cell)
                    -> gather_context {intent, output}
                    -> short-output bypass OR Pi/provider summary (no tools)
                    -> final text + session/capture reference -> Main
```

FreeContext 复用底层 Pi runtime 和 provider adapters 完成单次无工具摘要，沿用现有 provider/model/route 配置。

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
freecontext --config /secure/path/freecontext.toml --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
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
freecontext --route resilient --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
freecontext --target gpt --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
```

`--route` 与 `--target` 互斥。CLI 选择覆盖 `FREECONTEXT_ROUTE` 或 `FREECONTEXT_TARGET`，后者再覆盖 `default_route`。运行限制遵循 CLI > 环境变量 > `[runtime]` > 内置默认值。摘要 worker 不调用仓库工具；现有 provider 超时与重试配置继续适用。

仅当结构化 HTTP/provider/transport 元数据、Pi 的重试信号或 TokenRhythm 的精确兼容响应判定为短暂故障时，FreeContext 才会重试失败的 assistant turn。默认等待向量为 3/6/12 秒，并带最多 ±20% 抖动；重试复用已提交的 capture。可通过 `provider_retry_delays_ms = [3000, 6000, 12000]`、`FREECONTEXT_PROVIDER_RETRY_DELAYS_MS=3000,6000,12000` 或 `--provider-retry-delays-ms 3000,6000,12000` 配置完整向量；使用空向量即可关闭重试。

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

从文件或 stdin 读取捕获输出并摘要：

```bash
freecontext --intent 'Extract request routing evidence.' --output-file /path/to/captured-output.txt
rg -n timeout src/config.ts | freecontext --intent 'Extract timeout defaults and precedence.'
```

使用 `--format json` 返回结果对象，或 `--verbose` 输出生命周期诊断。CLI 不执行 intent 中提到的命令。

### 外部 system prompt

默认文件是 [`prompts/explorer.md`](prompts/explorer.md)。可通过 TOML、`FREECONTEXT_PROMPT_PATH` 或 `--prompt` 替换：

```toml
[runtime]
prompt_path = "/absolute/path/custom-explorer.md"
```

TOML 中的相对路径以 `config.toml` 所在目录为基准；CLI 与环境变量路径以当前进程为基准解析。

外部 prompt 引导 worker 从提交的 output 中提取证据；摘要 worker 不接收仓库工具或工作区概览。

### 安全边界

FC 不能执行命令或探索文件。Main 控制哪些原生输出被提交给配置的模型 API。配置中的认证材料不会主动加入 prompt 或 capture，但调用方提交的 output 可能包含敏感文本。捕获文本保存在 session 旁；摘要失败返回其引用，避免把大段原始输出带回 Main。

### 测试

```bash
npm test
npm run check
npm run smoke:mcp
```

检查覆盖配置、provider 路由、CLI/MCP 契约、捕获输出保存和摘要交付。

### 与论文方案的对应关系

当前路线由 Main 执行命令，仅委派捕获输出的摘要。历史探索路线的结果不能证明当前路线的收益。

FreeContext 没有复现论文训练过程，因此不能预设达到论文报告的 token/成功率增益。项目提供了可替换模型、固定协议与可观测 usage，后续应通过 repository-level coding benchmark 对主代理基线、FreeContext 不同模型和不同调用阈值做成对评估。
