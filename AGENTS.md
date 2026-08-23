# AGENTS.md

给在本仓库工作的 AI agent 的指导说明。

## 项目是什么

`trae-model-bridge` 将本地安装的 **traecli**（TraeCode CLI — OpenAI Codex CLI 的内部 fork）背后的模型暴露为 **兼容 OpenAI** 和 **兼容 Anthropic** 的 HTTP 端点，让 Codex、Claude Code 等 agent 可以调用它。每次 HTTP 请求直接调用 traecli 的底层模型端点（`llm_raw_chat`），作为纯粹的**模型 API**使用：调用方传来的工具会**透传**给模型，当模型请求调用工具时，由调用方执行并回传结果。bridge 本身永远不会执行任何工具。它复用 traecli `auth.json` 中的 JWT 和 base URL。

完整架构、分析结论和客户端配置见 [README.md](./README.md)。

## 运行时与约束

- **Node ≥ 22.6**，通过原生 TypeScript 类型剥离直接运行。
- **零运行时依赖。无构建步骤。** 除非明确要求，否则不要添加 npm 依赖或打包器/编译器——保持无依赖是刻意为之，不是偶然。
- 仅支持 ESM（`"type": "module"`）。相对导入必须包含 `.ts` 扩展名（例如 `import { loadConfig } from "./config.ts"`），这是 Node 类型剥离加载器的要求。

## 布局（`src/`）

- `config.ts` — 由环境变量和 CLI 参数驱动的配置（`BRIDGE_*`、`--log-mode`）。
- `rawchat.ts` — **核心模块。** 读取 `auth.json`，将调用方的工具透传给 `llm_raw_chat`，解析 SSE 流（`reasoning_content` + `response` + `tool_calls`）。
- `traecli.ts` — **遗留** agent 模式（`traecli exec --json`）实现 + 共享类型（`RunResult`、`TraeEvent`、`TraeUsage`）。默认不调用。
- `transcript.ts` — 将 `messages[]` 扁平化为一条 prompt；提取调用方的 cwd。
- `openai.ts` — `/v1/chat/completions` 请求/响应 + SSE 映射。
- `responses.ts` — `/v1/responses`（OpenAI Responses API）请求/响应 + SSE。
- `anthropic.ts` — `/v1/messages` 请求/响应 + SSE 映射。
- `models.ts` — 从 traecli 本地模型缓存提供 `/v1/models`。
- `logger.ts` — 分级日志器（off/info/debug）、请求头脱敏、请求 id。
- `semaphore.ts` — 限制并发上游请求数。
- `server.ts` — HTTP server、路由、认证、入口。

## 约定

- TypeScript 编写，导出函数需显式标注类型；优先使用小的纯函数（如 `classifyEvent`），便于测试。
- 注释保持精简——解释*为什么*，而不是*是什么*。与现有风格保持一致。
- 配置仅来自 `BRIDGE_*` 环境变量；不要硬编码 host、端口、路径或模型名。
- 保持两种协议格式（OpenAI + Anthropic）的兼容性。修改一个适配器时，检查另一个是否也需要同样的修改。

## 运行与测试

```bash
node src/server.ts            # 在 127.0.0.1:8787 启动
node src/server.ts --log-mode debug          # 打印完整请求 + 响应日志
node src/server.ts --log-mode debug --port 9000
```

日志级别由 `--log-mode off|info|debug`（或 `BRIDGE_LOG_MODE`；遗留的 `BRIDGE_VERBOSE=0/1` 仍映射到 off/info）控制。`debug` 模式会打印每个请求的请求头（凭证已脱敏）和请求体、发出的 `llm_raw_chat` 调用（解析后的模型 + `tools=0`）、上游返回的每个原始 SSE 帧、最终解析结果，以及所有响应体/SSE 帧——通过每个请求的 `req_xxxx` id 关联。所有日志输出到 **stderr**。

对运行中的 server 做冒烟测试（需要已登录的 `traecli`）：

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
```

目前还没有自动化测试套件。如果你修改了解析或协议映射，请手动验证所有端点：`/health`、`/v1/models`、`/v1/chat/completions`（流式 + 非流式）、`/v1/responses`（流式 + 非流式）、`/v1/messages`（流式 + 非流式）。务必杀掉你启动的后台 server（`pkill -f "node src/server.ts"`）。

## 关键事实（不要重复踩坑）

- bridge 直接调用 `POST <api_base_url>/api/ide/v2/llm_raw_chat`，认证头为 `authorization: Cloud-IDE-JWT <access_token>`。`api_base_url` 和 token 来自 `~/.trae/cli/auth.json`（`trae.endpoints.api_base_url`、`trae.access_token`）。如果 token 过期，`rawchat.ts` 会抛出错误提示执行 `traecli login`。
- 请求体：`{ config_name, model_name, user_input:"", messages:[{role, content:[{type:"text",text}], tool_calls?, tool_call_id?}], tools, session_id, conversation_id, access_type:4 }`。工具从调用方透传；bridge 永远不会执行它们——客户端运行工具并将结果作为 `role:"tool"` 轮次回传。
- **`function.parameters` 必须是 JSON *字符串*，不能是对象**——传对象会导致 HTTP 500。`rawchat.ts` 中的 `stringifySchema` 负责序列化它。（已验证。）
- 工具结果往返（已验证的上游格式）：assistant 轮次保留 `tool_calls`，使用 **`function_call`**（而不是 OpenAI 标准的 `function`）键；结果轮次为 `{role:"tool", tool_call_id, content:[{type:"text",text}]}`——content 必须是**块数组**，裸字符串会导致 500。
- `model_name` 是变体 key（`business_metadata.variants.standard_key`，例如 `DeepSeek-V4-Flash__v2`），`config_name` 是 slug。`resolveModelIds` 在 `models_cache.json` 中查找它们；当缓存缺失时回退到 `<slug>__v2` 约定。
- 响应是一个 SSE 流。`reasoning_content` 帧承载思考过程，`response` 帧承载回答，`tool_calls` 帧承载工具调用请求（`function_call.name` + `arguments` 字符串，可能跨帧——按 `index` 累积），最后一帧携带 token 用量。
- **思考内容因模型而异。** `openrouter-3o`（通过中继的 Claude 家族）通常不输出；`DeepSeek-V4-*` 和 `GPT-5.6-*` 会稳定输出。bridge 将思考内容映射为 Anthropic `thinking` 块、OpenAI `reasoning_content` delta 和 Responses `reasoning` 项（由 `BRIDGE_REASONING` 控制）。
- **Anthropic thinking 必须匹配真实的线上格式，否则 Claude Code 不会渲染它。** 已通过 `https://api.deepseek.com/anthropic` 验证：流式 `content_block_start` 必须包含 `signature` 字段（`{"type":"thinking", "thinking":"","signature":""}`），`ping` 在第一个 `content_block_start` *之后*触发（不是之前），thinking 块以 `signature_delta`（非空）结尾然后 `content_block_stop`，**并且思考文本必须拆分为多个小的 `thinking_delta` 帧**——Claude Code 的 TUI 从增量 delta 渲染思考，会静默跳过单个大 delta（块仍会被接受进入消息，但永远不会显示）。bridge 使用 `chunkText` 将思考/消息文本分块，像真实端点一样流式输出。任何一点做错都会导致 Claude Code 只显示占位符（"Noodling…"）而没有思考正文；此时 Ctrl+O 也不起作用。已通过交互式 TUI（expect）验证，而不仅仅是 `--output-format stream-json`——stream-json 路径能正常接受单个 delta，因此**不会**暴露这个 bug。
- 来自 `llm_raw_chat` 的 `prompt_tokens` 只反映请求消息（不注入 agent 上下文）——这与遗留的 `exec` 路径不同，后者会注入 traecli 的完整系统提示。

### 遗留 `exec` agent 模式（`traecli.ts`，默认不使用）

- 出厂的 traecli 是一个**完整 agent**，不是裸聊天端点：它有自己的系统提示、工具循环（shell、apply_patch、MCP）和沙箱。工具门控标志（`--allowed-tool` / `--disallowed-tool`）**不会**禁用其内置 shell；安全边界是沙箱（默认 `read-only`）。
- `traecli exec --json` 只发射**块级**事件（没有 token delta）：`thread.started` → `turn.started` → `item.completed` → `turn.completed`。只有 `agent_message` 项是面向用户的回答。这就是为什么 bridge 转向 `llm_raw_chat`：`exec` 运行的是 agent，不是模型。

## CLAUDE.md

`CLAUDE.md` 是指向本文件的软链。请编辑 `AGENTS.md`；永远不要用真实文件替换这个软链。
