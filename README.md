# trae-model-bridge

将本地安装的 **traecli**（TraeCode CLI）背后的模型暴露为 **兼容 OpenAI** 和 **兼容 Anthropic** 的 HTTP 端点，让 **Codex**、**Claude Code** 等其他 agent 也能调用它。

零运行时依赖。利用 Node 内置的 TypeScript 支持直接运行（Node ≥ 22.6）。

---

## traecli 如何与模型通信（本 bridge 的基础）

`traecli`（又名 `trae-cli`，二进制名为 `traex`）是 **OpenAI Codex CLI 的内部 fork**。对本地安装版本（`v0.201.4`）的分析发现：

- 它**不会**直接调用 OpenAI/Anthropic，而是调用 **Trae 云端中继**（内部称为 `trae_chat` / "SuperRelay"）。base URL 按安装保存在 `~/.trae/cli/auth.json` 的 `trae.endpoints.api_base_url` 字段中。
- 配置文件位于 `~/.trae/traecli.toml`（`model`、`model_provider = "trae"`）。
- 认证使用 `~/.trae/cli/auth.json` 中的 JWT bearer token，由其中的 `refresh_token` 通过 `trae.endpoints.sso_api_host` 刷新（公网版为 `https://console.enterprise.trae.cn`；具体域名随安装/区域而定，以 `auth.json` 为准）。
- 中继前端挂载了许多模型（缓存在 `~/.trae/model-provider/trae/models_cache.json`）：`Seed-Evolving`、`GPT-5.6-*`、`DeepSeek-V4-*`、`Gemini-3.1-Pro`、`doubao-seed-2.1-pro/2o/1o`（Claude Opus 的别名）等。

出厂时，`traecli` 是一个完整的**编码 agent**，而非裸聊天端点：它自带系统提示、工具循环（shell、apply_patch、MCP），并在沙箱中运行。**本 bridge 有意绕过这一切**，直接调用中继的底层模型端点（`llm_raw_chat`），作为纯粹的**模型 API** 使用：调用方传来的工具会透传给模型，当模型请求调用工具时，由调用方（例如 Claude Code）执行工具并在下一次请求中把结果回传。bridge 本身永远不会执行任何工具。它复用 `traecli login` 已写入 `auth.json` 的 JWT 和 base URL。

### 为什么直接调用 `llm_raw_chat` 而不是 `traecli exec`

`traecli` 提供了内置的集成接口（非交互式 `exec --json`、MCP server、ACP server），但它们都会运行**完整的 agent**：基于沙箱的工具循环，外加数万 token 的自带注入上下文。本 bridge 的早期版本包装了 `exec --json`；得到的是"模型 API 背后的 traecli agent"——它会自己读文件、自己跑 shell 命令。为了只暴露模型本身，bridge 现在直接与 `traecli` 相同的后端通信。工具被**透传**给模型（不在此处执行）：agent 循环完全存在于调用方客户端中。遗留的 `exec` 路径仍保留在 [`src/traecli.ts`](src/traecli.ts) 中供参考，但不再接入路由。

### `llm_raw_chat` 请求/响应

```
POST <api_base_url>/api/ide/v2/llm_raw_chat
authorization: Cloud-IDE-JWT <access_token>
{ config_name, model_name, user_input:"", messages:[...],
  tools:[{type:"function",function:{name,description,parameters:"<json-string>"}}], ... }
```

注意 `function.parameters` 必须是 **JSON 字符串**，不能是对象——传对象会返回 HTTP 500。响应是一个 `data:` 帧的 SSE 流：`reasoning_content` 承载模型思考过程，`response` 承载回答内容，`tool_calls`（`function_call.name` + `arguments` 字符串）承载工具调用请求，最后一帧报告 token 用量。bridge 将这些内容映射为调用方所用协议的对应格式。

---

## 架构

bridge **直接调用** traecli 的底层模型端点（`llm_raw_chat`），行为就是一个模型 API：工具透传，由客户端执行。它复用 traecli `auth.json` 中的 JWT 和 base URL。

```
Codex  ─┐  POST /v1/chat/completions (OpenAI)
        │  POST /v1/responses        (OpenAI)
        ├───────────────────────────────────►  trae-model-bridge  ──► POST <base>/api/ide/v2/llm_raw_chat
Claude ─┘  POST /v1/messages         (Anthropic) (Node HTTP)        (Cloud-IDE-JWT, tools passed through)
                                                                          │
                                                    parse SSE   ◄─────────┘
                                                    reasoning_content + response + tool_calls
                                                    → OpenAI / Anthropic response
```

源码布局（`src/`）：

- `config.ts` — 由环境变量和 CLI 参数驱动的配置。
- `rawchat.ts` — **核心模块**。读取 auth.json，POST `llm_raw_chat`，透传工具，解析 SSE（含 `tool_calls`）。
- `transcript.ts` — 将 `messages[]` 扁平化为一条 prompt；提取调用方的 cwd。
- `openai.ts` — `/v1/chat/completions` 请求/响应 + SSE 映射。
- `responses.ts` — `/v1/responses` 请求/响应 + SSE 映射。
- `anthropic.ts` — `/v1/messages` 请求/响应 + SSE 映射。
- `models.ts` — 从 traecli 的本地模型缓存中提供 `/v1/models`。
- `logger.ts` — 分级日志器（off/info/debug）、请求头脱敏、请求 id。
- `semaphore.ts` — 限制并发上游请求数。
- `traecli.ts` — 遗留 agent 模式（`traecli exec`）实现 + 共享类型；默认不使用。
- `server.ts` — HTTP server、路由、认证、入口。

---

## 搭建

需要 Node ≥ 22.6 和一个已登录可用的 `traecli`（执行过 `traecli login`）。

```bash
# 在仓库根目录下
node src/server.ts
# 或者
npm start
```

server 默认监听 `http://127.0.0.1:8787`。

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

### 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | 绑定地址。 |
| `BRIDGE_PORT` | `8787` | 端口。 |
| `BRIDGE_DEFAULT_MODEL` | `doubao-seed-2.1-pro` | 请求未指定模型时使用的默认模型。 |
| `BRIDGE_AUTH_PATH` | `~/.trae/cli/auth.json` | traecli 的 JWT + 中继 base URL 路径。 |
| `BRIDGE_MODELS_CACHE_PATH` | `~/.trae/model-provider/trae/models_cache.json` | 用于解析 `config_name` / `model_name` 的模型缓存路径。 |
| `BRIDGE_MAX_CONCURRENCY` | `2` | 最大并发上游请求数。 |
| `BRIDGE_API_KEY` | _未设置_ | 若设置，则要求请求携带 `Authorization: Bearer <key>`（或 `x-api-key`）。 |
| `BRIDGE_REASONING` | `true` | 是否透出模型的思考过程（Anthropic `thinking` 块、OpenAI `reasoning_content` / `reasoning` 项）。设为 `0` 可隐藏。 |
| `BRIDGE_LOG_MODE` | `info` | 日志详细程度：`off` \| `info` \| `debug`。 |
| `BRIDGE_LOG_MAX_CHARS` | `100000` | `debug` 模式下打印请求体/SSE 负载的最大字符数（`<=0` 表示无限制）。 |
| `BRIDGE_VERBOSE` | `true` | 遗留变量：`0`→`off`，`1`→`info`。推荐使用 `BRIDGE_LOG_MODE`。 |

以下变量仅被**遗留 agent 模式路径**（`src/traecli.ts`）读取，对默认的直接 `llm_raw_chat` 调用没有影响：
`BRIDGE_TRAECLI_BIN`、`BRIDGE_SANDBOX`、`BRIDGE_CWD`、`BRIDGE_TIMEOUT_MS`、`BRIDGE_EPHEMERAL`、`BRIDGE_SKIP_GIT_CHECK`。

### CLI 参数

参数会覆盖对应的环境变量：

| 参数 | 说明 |
| --- | --- |
| `--log-mode <off\|info\|debug>` | 设置日志详细程度（也可用 `--log <mode>`，或直接 `--debug`）。 |
| `--port <n>` | 绑定端口。 |
| `--host <addr>` | 绑定地址。 |

```bash
node src/server.ts --log-mode debug --port 9000
```

### 日志

- **off** — 不输出任何日志。
- **info**（默认）— 每个请求一行：id、method、path、model、耗时。
- **debug** — 输出全部内容，通过每个请求的 `req_xxxx` id 关联四个阶段：(1) 收到的请求——请求头（凭证已脱敏）和请求体；(2) 发出的 `llm_raw_chat` 调用——解析后的模型、消息数、`tools=0`；(3) 上游响应——每个原始 SSE `data:` 帧和最终解析结果（用量 + 文本）；(4) bridge 返回的响应——JSON 响应体，或流式响应的每个 SSE 帧。

所有日志输出到 **stderr**，不会污染通过管道传递的 stdout。

---

## 从其他 agent 中使用

### Codex（兼容 OpenAI）

将 Codex 指向 bridge 作为自定义 OpenAI provider。在 `~/.codex/config.toml` 中：

```toml
model = "doubao-seed-2.1-pro"
model_provider = "traebridge"

[model_providers.traebridge]
name = "trae-model-bridge"
base_url = "http://127.0.0.1:8787/v1"
# 如果设置了 BRIDGE_API_KEY，还需要设置 env_key 并 export 它。
```

或者任何 OpenAI SDK / 工具（Chat Completions 和 Responses API 均可）：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=dummy   # 或你的 BRIDGE_API_KEY
```

### Claude Code（兼容 Anthropic）

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=dummy   # 或你的 BRIDGE_API_KEY
claude
```

Claude Code 调用 `POST /v1/messages`；bridge 以标准的 Messages 响应 + SSE 事件序列应答。

---

## 端点

- `GET  /health` — 存活检查 + 当前生效配置。
- `GET  /v1/models` — 来自 traecli 本地缓存的模型列表（OpenAI list 格式）。
- `POST /v1/chat/completions` — OpenAI Chat Completions（支持 `stream`）。
- `POST /v1/responses` — OpenAI Responses（支持 `stream`）。
- `POST /v1/messages` — Anthropic Messages（支持 `stream`）。

### 示例

```bash
# OpenAI Chat Completions，非流式
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2.1-pro","messages":[{"role":"user","content":"What is a mutex?"}]}'

# OpenAI Chat Completions，流式
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2.1-pro","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses，非流式（input 可以是字符串或 items 数组）
curl http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2.1-pro","input":"What is a mutex?"}'

# OpenAI Responses，流式
curl -N http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2.1-pro","stream":true,"input":"hi"}'

# Anthropic Messages，非流式
curl http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2.1-pro","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

---

## 限制与注意事项

- **是模型 API，不是 agent。** bridge 直接调用 `llm_raw_chat`，自身永远不会执行工具——没有 shell、apply_patch、MCP 或沙箱。你传来的工具会透传给模型；当模型请求调用工具时，由*你的客户端*执行并将结果回传。agent 循环在调用方一侧。（遗留的基于 exec 的 agent 模式路径保留在 `traecli.ts` 中，但未接入路由。）
- **未文档化的内部端点 + JWT。** bridge 复用 traecli 的 `Cloud-IDE-JWT` 和 `~/.trae/cli/auth.json` 中的 base URL。如果 token 过期，请运行 `traecli login` 刷新。直接调用此端点属于非官方支持的用法，可能违反服务方条款——请自行斟酌使用。
- **工具 schema 需要序列化为字符串。** `llm_raw_chat` 要求 `function.parameters` 是 JSON 字符串；bridge 在发送前会序列化调用方的 schema（传对象 schema 上游会返回 HTTP 500）。
- **粗粒度流式。** `llm_raw_chat` 以块的形式流式输出 `reasoning_content`/`response`；bridge 将其重新分块为小的 delta 发送给客户端。工具调用会在其参数完整到达后作为一个完整块发出。
- **思考内容因模型而异。** 当模型输出 `reasoning_content` 时才会透出思考过程（Anthropic `thinking` 块、OpenAI `reasoning_content` / `reasoning` 项）。`DeepSeek-V4-*` 和 `GPT-5.6-*` 会稳定输出；部分模型不输出。可通过 `BRIDGE_REASONING=0` 禁用。
- **Anthropic `thinking` 块必须匹配真实的线上格式**，Claude Code 才能正确渲染：`content_block_start` 必须带 `signature` 字段，`ping` 在第一个块启动后立即触发，块结束前用 `signature_delta` 封口，**并且思考文本必须拆分为多个小的 `thinking_delta` 帧**——Claude Code 的 TUI 从增量 delta 渲染思考，单个大 delta 会被静默跳过。思考内容会显示在 "✻ Thinking…" 部分下。
- **无状态。** 每次请求都是独立调用；HTTP 请求之间不会复用 session。

## 许可证

MIT
