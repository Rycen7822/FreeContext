# FreeContext

FreeContext 是面向 Codex 的只读代码仓库探索子代理。它把高噪声的路径发现、符号搜索、调用链追踪和窄范围文件读取放到外置模型会话中，主代理最终仅接收经过本地校验的 `file:line-range` 证据块。

项目采用 **skill + headless CLI** 形态：

- Codex skill 决定何时委派广泛或冷启动仓库探索。
- `freecontext` CLI 通过模型 API 驱动精简的 Pi agent loop。
- 子代理仅暴露结构化 `read`、`rg`、`glob`，以及检测到本机命令后启用的 `jq`、`bat`。
- 没有 TUI、交互会话树、编辑器、任意 shell、写文件、Git、网络浏览、扩展加载或包管理工具。
- system prompt 从独立 Markdown 文件加载，API 配置从 `.env` 加载。

仓库探索协议参考 [FastContext: Training Efficient Repository Explorer for Coding Agents（v3）](https://arxiv.org/pdf/2606.14066v3)。本项目用通用 Anthropic/OpenAI 兼容模型 API 替代论文中的专门训练模型。

## 核心契约

子代理内部保留完整搜索轨迹，CLI 的标准输出仅返回：

```text
<final_answer>
summary: 一句话说明定位结果及关键关系。
evidence:
- src/example.ts:18-47 — 该范围定义核心行为。
- test/example.test.ts:60-91 — 该范围验证边界条件。
gaps:
- none
</final_answer>
```

返回前会在本地验证：

1. 引用路径位于指定工作区内；
2. 路径解析后没有通过符号链接逃逸；
3. 文件真实存在且不属于阻断的敏感路径；
4. 行号为有效升序区间并且没有超过文件总行数；
5. 最终块包含非空 summary 和至少一条有效 evidence。

格式不合格时，FreeContext 会执行一次禁用全部工具的修复回合；修复仍失败则返回非零退出码，不把未验证输出交给主代理。

## 架构

```text
Codex main agent
      │
      │ skill selects a broad/cold exploration task
      ▼
freecontext CLI
      │
      ├── .env + external prompts/explorer.md
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
validated compact evidence block
```

Pi coding-agent 的完整交互层没有进入运行时。FreeContext 复用其底层 `@earendil-works/pi-agent-core` agent loop 与 `@earendil-works/pi-ai` provider adapters，保留并行 tool calling、流式消息协议、Anthropic/OpenAI 兼容转换和工具 schema 校验，删除仓库探索任务无关的功能。具体裁剪见 [`docs/pi-pruning.md`](docs/pi-pruning.md)。

## 环境要求

- Node.js `>= 22.19.0`
- `rg`：必需
- `jq`：可选，存在时自动启用
- `bat` 或 Debian/Ubuntu 上的 `batcat`：可选，存在时自动启用

## 安装

```bash
git clone https://github.com/Rycen7822/FreeContext.git
cd FreeContext
npm install
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

## 配置

默认配置文件：

```text
~/.config/freecontext/.env
```

也可以显式指定：

```bash
freecontext --env /secure/path/freecontext.env --query 'Locate the request routing path.'
```

### Anthropic Messages 兼容接口

```dotenv
FREECONTEXT_API=anthropic
FREECONTEXT_AUTH_MODE=auto
FREECONTEXT_BASE_URL=https://api.anthropic.com
FREECONTEXT_MODEL=claude-model-id
FREECONTEXT_API_KEY=replace-me
```

对于使用 Bearer 认证的 Anthropic 兼容网关：

```dotenv
FREECONTEXT_API=anthropic
FREECONTEXT_AUTH_MODE=bearer
FREECONTEXT_BASE_URL=https://provider.example/v1
FREECONTEXT_MODEL=provider-model-id
FREECONTEXT_API_KEY=replace-me
```

### OpenAI Chat Completions 兼容接口

```dotenv
FREECONTEXT_API=openai
FREECONTEXT_AUTH_MODE=auto
FREECONTEXT_BASE_URL=https://api.openai.com/v1
FREECONTEXT_MODEL=gpt-model-id
FREECONTEXT_API_KEY=replace-me
```

`FREECONTEXT_AUTH_MODE` 支持：

- `auto`：Anthropic 协议使用 SDK API-key 认证，OpenAI 协议使用 Bearer 认证；
- `bearer`：显式发送 `Authorization: Bearer ...`；
- `x-api-key`：Anthropic 协议显式发送 `x-api-key`；
- `both`：同时发送 SDK API key 与 Bearer header，用于少数代理网关。

API key 没有 CLI 参数，避免进入 shell 历史和进程列表。真实 `.env` 已在 `.gitignore` 中阻断；仓库只提供空 key 示例。

### SenseNova

复制专用模板：

```bash
mkdir -p ~/.config/freecontext
cp .env.sensenova.example ~/.config/freecontext/.env
chmod 600 ~/.config/freecontext/.env
```

随后填写 SenseNova 账户文档中给出的 **Anthropic 兼容 base URL** 与 API key：

```dotenv
FREECONTEXT_API=anthropic
FREECONTEXT_AUTH_MODE=bearer
FREECONTEXT_BASE_URL=https://your-account-anthropic-compatible-endpoint
FREECONTEXT_MODEL=sensenova-6.7-flash-lite
FREECONTEXT_API_KEY=replace-me
```

公开文档中的 OpenAI Chat Completions 示例地址不能据此推断 Anthropic 兼容地址；应使用账户控制台或对应接口文档给出的实际 endpoint。详见 [`docs/providers.md`](docs/providers.md)。

## 使用

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

## 外部 system prompt

默认文件是 [`prompts/explorer.md`](prompts/explorer.md)。可通过 `.env` 或命令行替换：

```dotenv
FREECONTEXT_PROMPT_PATH=/absolute/path/custom-explorer.md
```

模板支持三个占位符：

- `{{WORKSPACE}}`：解析后的工作区根目录；
- `{{TOOLS}}`：当前实际启用的工具名；
- `{{OVERVIEW}}`：顶层目录/文件概览。

外部 prompt 负责搜索策略和最终输出契约；安全边界由代码层工具注册、路径解析和进程调用实现，不依赖 prompt 自律。

## 只读安全边界

生产运行时没有任何文件写入 API。外部命令由固定工具实现以 argv 数组调用，并强制：

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

目录级 `rg`/`glob` 会排除全部 `.env*` 与 `*.env`，防止模型提供正向 glob 后重新纳入敏感文件。安全示例文件（例如 `.env.example`）可在顶层概览中被发现，并可通过精确 `read` 或精确文件路径 `rg` 读取。

这些约束阻止子代理修改工作区；它仍会把检索到的代码片段发送给配置的模型 API。私有仓库使用前必须确认相应供应商的数据处理政策。完整威胁模型见 [`docs/security.md`](docs/security.md)。

## 测试

```bash
npm test
npm run check
npm run smoke:mock
```

真实 provider smoke test：

```bash
npm run smoke:live -- 'Locate the CLI entry point and tool registry.'
```

测试覆盖配置合并、认证 header、URL/key 去密、路径越界、符号链接逃逸、敏感文件阻断、glob 重新纳入攻击、命令注入、行号读取、输出校验、预算收敛、CLI 参数和 mock agent loop。

## 与论文方案的对应关系

| FastContext 设计 | FreeContext 实现 |
|---|---|
| 专门训练的 repository explorer | 通用模型 API + 强约束外部 system prompt |
| READ / GLOB / GREP | `read` / `glob` / `rg`，补充受限 `jq` / `bat` |
| 并行首轮检索 | Pi `runAgentLoop` 的 parallel tool execution |
| 主代理只接收最终证据 | CLI stdout 仅返回验证后的 `<final_answer>` |
| 路径与行范围 | 本地存在性、realpath 和文件总行数验证 |
| 失败后改写搜索 | prompt 要求独立假设与失败后 refinement |
| 主代理决定何时委派 | Codex skill 明确 broad/cold/failure trigger 与 exact-file skip |

FreeContext 没有复现论文训练过程，因此不能预设达到论文报告的 token/成功率增益。项目提供了可替换模型、固定协议与可观测 usage，后续应通过 repository-level coding benchmark 对主代理基线、FreeContext 不同模型和不同调用阈值做成对评估。
