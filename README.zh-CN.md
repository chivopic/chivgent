# chivgent

[English](README.md) | [简体中文](README.zh-CN.md)

> 一个小巧、易读的 Coding Agent CLI，用来理解 Agent Harness 的真实工作原理。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)
[![CI](https://github.com/chivopic/chivgent/actions/workflows/ci.yml/badge.svg)](https://github.com/chivopic/chivgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-MVP-orange)

`chivgent` 将 Provider 无关的 Agent Loop 与 LLM API、工具和工作区边界连接起来。
当前 MVP 可以先发现文件、搜索源码并分段读取内容，再使用 OpenAI、DeepSeek 或
任意兼容 Chat Completions 的 API 回答代码问题。

这个项目刻意保持精简：先让 Tool Calling、Conversation State、Provider Adapter
和循环终止条件容易理解，再逐步加入成熟 Agent Harness 所需的工程复杂度。

## 功能

- 完整的多轮 Agent Loop：模型 -> Tool Call -> Tool Result -> 模型。
- Provider 无关的运行时消息和工具契约。
- 通过 Responses API 支持 OpenAI。
- 通过通用 OpenAI-compatible Chat Completions 客户端支持 DeepSeek。
- 无需修改代码即可配置自定义 OpenAI-compatible API。
- 既可以进入带斜杠命令的交互式会话，也可以单次提问后退出。
- Session 以 JSON Lines 持久化，可以在之后的进程中恢复。
- 提供 `--json` 事件流，便于脚本和其他前端消费。
- 基于类型化运行时事件流的流式输出。
- 可中断的运行：Ctrl+C 结束当前运行，且不会丢失已产生的 transcript。
- Provider 调用具备单次超时和有上限的指数退避重试。
- 通过 `list_files` 和字面量 `search_text` 确定性地发现项目内容。
- 支持带续读提示的分段 `read_file`，所有工具结果都有容量上限。
- 默认只读；`--allow-writes` 才会启用 `write_file` 和 `edit_file`。
- 精确匹配的 `edit_file`，命中缺失或不唯一时拒绝执行。
- 编辑会保留文件原有的 BOM 和 CRLF 换行符。
- 原子写入：写入中途崩溃不会损坏原文件。
- 安全的工作区访问，阻止路径穿越和符号链接逃逸。
- 支持根 `.gitignore`、生成目录和敏感路径过滤。
- 工具参数验证、明确的工具错误和有上限的轮次限制。
- 可打包安装的 Node.js CLI，不依赖 Agent 框架。
- 默认测试不调用真实 API，不消耗模型额度。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm
- OpenAI、DeepSeek 或其他兼容供应商的 API Key

### 从 npm 安装

```bash
npm install -g chivgent
chivgent --version
```

如果希望安装当前源码版本：

```bash
git clone https://github.com/chivopic/chivgent.git
cd chivgent
npm install
npm run build
npm install -g .
```

### 分析一个项目

进入你希望 Agent 分析的项目目录，然后运行 `chivgent`。

使用 OpenAI：

```bash
export OPENAI_API_KEY="your-api-key"
chivgent "src/agent.ts 是做什么的？"
```

使用 DeepSeek：

```bash
export DEEPSEEK_API_KEY="your-api-key"
chivgent --provider deepseek "解释 src/ 目录的架构"
```

使用任意 OpenAI-compatible Chat Completions API：

```bash
export OPENAI_API_KEY="your-provider-api-key"
export OPENAI_BASE_URL="https://api.vendor.example/v1"
export OPENAI_MODEL="vendor-model"

chivgent --provider openai-compatible "解释 src/ 目录的架构"
```

不带问题直接运行 `chivgent` 会进入交互式会话：

```bash
chivgent
› src/agent.ts 在做什么？
› 这个循环在哪里测试？
› /exit
```

会话会跨多轮保留上下文，因此追问不需要重复之前的信息。之后可以用
`chivgent --continue`（或 `chivgent --resume <id>`）恢复；`chivgent --sessions`
可以列出已记录的会话。

答案会随模型生成实时写入 stdout，因此 stdout 仍然可以直接管道使用。工具活动、
重试和运行状态写入 stderr；Provider 错误会返回非零退出码。使用 `--no-stream`
可改为一次性输出完整答案，`--quiet` 可隐藏工具活动。

## CLI 参考

```text
chivgent [选项] "问题"            回答一次后退出
chivgent [选项]                   进入交互式会话

选项：
  --provider NAME  openai、deepseek 或 openai-compatible（默认：openai）
  --model MODEL    覆盖 Provider 模型
  --max-turns N    工具调用轮次上限（默认：8，加 --allow-writes 时为 16）
  --no-stream      关闭流式输出，等待完整答案
  -q, --quiet      不在 stderr 打印工具活动
  --json           以 JSON Lines 输出整次运行，而不是渲染文本
  -c, --continue   恢复当前工作区最近的一次 Session
  --resume ID      恢复指定 Session
  --sessions       列出已记录的 Session 并退出
  --allow-writes   允许 Agent 创建和修改文件（默认只读）
  --no-session     不记录本次运行
  -h, --help       显示帮助
  -v, --version    显示版本
```

交互式会话中 `/help` 会列出全部斜杠命令：`/session`、`/tools`、`/clear` 和
`/exit`。Ctrl+C 只中断当前回答，不会退出会话；Ctrl+D 才会离开。

退出码：`0` 正常回答，`1` 配置或 Provider 失败，`2` 达到轮次上限，`130` 被
Ctrl+C 中断。

### Provider 配置

| Provider | API Key | 模型环境变量 | 默认模型 | API 形式 |
| --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5.6` | Responses API |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-v4-flash` | OpenAI-compatible Chat Completions |
| 自定义兼容供应商 | `OPENAI_API_KEY` | `OPENAI_MODEL` | 必填 | OpenAI-compatible Chat Completions |

显式传入的 `--model` 优先于 Provider 对应的模型环境变量。自定义兼容供应商还必须
配置 `OPENAI_BASE_URL`。Session 记录在 `CHIVGENT_HOME`（默认 `~/.chivgent`）下。

```bash
chivgent --provider openai --model gpt-5.6 "解释 package.json"
chivgent --provider deepseek --model deepseek-v4-pro "解释 package.json"
chivgent --provider openai-compatible --model vendor-model "解释 package.json"
```

## 架构

```text
                                  +-> OpenAI Responses API
用户 -> CLI -> Agent -> LLMClient |
                 |                +-> OpenAI-compatible Chat -> DeepSeek / 自定义
                 |
                 +-> Tool Registry -> list_files / search_text / read_file -> Workspace
                                      write_file / edit_file（--allow-writes）
```

Agent Runtime 拥有自己的消息模型。Provider 特有的数据结构只在 `LLMClient` 边界
进行转换：

```text
Agent Message[] -> Provider Adapter -> Provider Request
                                      <- Provider Response
AssistantMessage <- Normalized Result
```

因此 Agent、工具和 CLI 不会依赖任何单一供应商的消息格式。

### 运行时事件

Agent Loop 自己不打印任何内容，而是通过类型化的事件流对外汇报。一次运行会产生：

```text
agent_start
  turn_start -> message_start -> message_update* -> message_end
    tool_execution_start -> tool_execution_end   (每个 Tool Call 一次)
  turn_end
  ...
agent_end (completed | max_turns | aborted | error)
```

`message_update` 只携带增量，不携带累计快照，因此事件流的体积与答案长度保持线性
关系。事件都是可结构化克隆的，且每个监听者拿到的是副本，渲染层无法修改
transcript。`src/render.ts` 中的 CLI 渲染器只是其中一个消费者，日志、JSON 流或
TUI 同样可以消费。

`LLMClient.stream` 是可选的。Provider 未实现时，Agent 会退回 `complete`，事件序列
不变，只是没有增量事件。

### OpenAI-compatible 供应商

兼容供应商可以通过修改 `baseURL`、凭据和模型名称，复用官方 `openai` npm 包。
CLI 用户无需修改代码：

```bash
export OPENAI_API_KEY="your-provider-api-key"
export OPENAI_BASE_URL="https://api.vendor.example/v1"
export OPENAI_MODEL="vendor-model"

chivgent --provider openai-compatible "src/agent.ts 是做什么的？"
```

`OPENAI_BASE_URL` 必须指向供应商的 OpenAI-compatible API 根地址。供应商至少需要
实现 `POST /chat/completions` 和 Function Tool Calling。

如果要在源码中增加一个具名 Provider，可以复用相同的 Adapter：

```ts
const client = new OpenAICompatibleChatClient({
  apiKey: process.env.VENDOR_API_KEY!,
  baseURL: "https://api.vendor.example/v1",
  model: "vendor-model",
  continuationTag: "vendor-chat",
});
```

`DeepSeekChatClient` 就是共享客户端之上的轻量配置包装器。兼容层还会把 DeepSeek
的 `reasoning_content` 等 Provider 私有字段保存在不透明的 continuation state 中。

修改 `baseURL` 不代表所有能力都能完全兼容。不同供应商的模型名称、鉴权方式、
工具 Schema、Strict Mode、推理字段、流式事件和错误结构都可能不同。供应商差异
应保留在轻量 Provider Adapter 内，而不是泄漏到 Agent Loop。

## 项目结构

```text
src/
  cli.ts                         CLI 入口与进程边界
  cli-options.ts                 参数和 Provider 配置
  agent.ts                       Agent Loop 与运行状态
  events.ts                      运行时事件模型
  render.ts                      运行时事件的终端渲染
  llm.ts                         Provider 无关的 LLM 契约
  retry.ts                       Provider 超时与重试装饰器
  messages.ts                    运行时消息模型
  session.ts                     会话状态与事件分发
  session-store.ts               JSONL 会话日志与恢复
  repl.ts                        交互式输入与斜杠命令
  workspace.ts                   工作区配置与只读默认值
  workspace/
    types.ts                     上限、错误类型与 Workspace 契约
    paths.ts                     路径归一化与逃逸防护
    ignore.ts                    .gitignore 与生成目录过滤
    text.ts                      UTF-8 解码、行切分与预览
    read.ts                      分段读取
    list.ts                      目录遍历
    search.ts                    字面量文本搜索
    write.ts                     原子整文件写入与精确编辑
  providers/
    openai.ts                    OpenAI Responses Adapter
    openai-compatible-chat.ts    通用 Chat Completions Adapter
    deepseek.ts                  DeepSeek 配置包装器
  tools/
    tool.ts                      Tool 契约
    output.ts                    共享的 64 KiB 工具输出边界
    list-files.ts                确定性的项目树发现工具
    search-text.ts               有界的源码字面量搜索工具
    read-file.ts                 分段文本读取工具
    write-file.ts                整文件创建与替换
    edit-file.ts                 精确唯一匹配编辑
tests/                           Provider、Agent Loop 和 Workspace 测试
docs/                            架构与学习文档
```

## 开发

```bash
npm install
npm run check
npm test
npm run build
```

运行完整的发布检查（包含 npm tarball dry run）：

```bash
npm run release:check
```

构建一个可以在本地安装的 tarball：

```bash
npm pack
npm install -g ./chivgent-0.6.0.tgz
```

测试使用脚本化或 Mock LLM Client。真实 API Smoke Test 需要手工执行，因此默认
测试不会消耗 API 额度。

## 安全模型

- API Key 只从环境变量读取，绝不能提交到仓库。
- 自定义 `OPENAI_BASE_URL` 会收到配置的 API Key 和提示词，只能使用可信端点。
- 不传 `--allow-writes` 时工作区工具全部只读，`write_file` 和 `edit_file` 根本
  不会被注册。
- 写入会解析到最深层已存在的祖先目录，路径上任何一段是符号链接都会被拒绝，
  因此预先植入的链接无法把写入重定向到工作区之外。
- 写入先落到同目录的临时文件再 rename 就位，中断的写入不会截断已有文件。
- `edit_file` 在 `old_text` 找不到或命中多处时拒绝执行，宁可失败也不改错行。
- 文件路径必须位于当前工作区内。
- Real Path 检查会阻止 `..` 路径穿越和符号链接逃逸。
- 文件大小和二进制内容检查会限制不安全的读取。
- 自动发现遵循根 `.gitignore` 和固定的生成目录忽略规则。
- 所有工具统一禁止常见凭据、私钥和敏感配置路径。
- 工具结果限制为 64 KiB，读取、扫描、深度和结果数量都有硬上限。
- 工具输入是不可信数据，执行前必须验证。
- Agent 会在有限的模型轮数后终止。
- `~/.chivgent/sessions` 下的会话日志包含提问、回答和工具结果（含文件片段）。
  在敏感项目中请使用 `--no-session`，并像对待项目本身一样对待该目录。
- Session id 在拼接成文件路径前会先做校验。

这是一个用于学习的 MVP，并不是经过加固的 Sandbox。`--allow-writes` 不会对每次
修改逐一确认，因此请在已提交的代码上使用；在允许它访问敏感项目之前，请先审查
代码和威胁模型。

## 路线图

- [x] 最小 Tool Calling Agent Loop
- [x] 安全的 `read_file` 工具
- [x] OpenAI 和 DeepSeek Provider
- [x] 通用 OpenAI-compatible Chat Completions Adapter
- [x] 自定义 OpenAI-compatible CLI Provider
- [x] 项目发现工具：`list_files`、`search_text` 和分段 `read_file`
- [x] 流式输出和运行时事件
- [x] 持久化多轮 Session
- [ ] Context Window 管理和压缩
- [x] 通过 `--allow-writes` 选择性开启的 `write_file` 和 `edit_file`
- [ ] 逐次修改确认与撤销日志
- [ ] 需要权限确认的 Shell 工具
- [ ] Provider Registry 和用户配置文件
- [ ] TUI、Extensions、Telemetry 和 Evals

## 文档

- [Stage 1：Minimal Agent 设计](docs/stage-1-minimal-agent.md)
- [DeepSeek Provider 设计](docs/deepseek-provider.md)
- [Stage 2：Project Discovery 实现设计](docs/stage-2-project-discovery.md)
- [Stage 3：Runtime Events 与流式输出设计](docs/stage-3-runtime-events.md)
- [Stage 4：Session 与交互模式设计](docs/stage-4-sessions.md)
- [发布流程](docs/releasing.md)

## 参与贡献

欢迎提交 Issue 和范围明确的 Pull Request。提交修改前请运行：

```bash
npm run check
npm test
npm run build
```

请将 Provider 特有的类型保留在 `src/providers/` 中，并确保核心 Agent Runtime
不依赖供应商 SDK 的数据结构。

## 许可证

本项目使用 [MIT License](LICENSE)。
