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
- Provider 注册表：新增 Provider 只是一条声明，不需要改 CLI。
- API Key 依次从 `--api-key`、环境变量、可选文件解析。
- 通过 Responses API 支持 OpenAI。
- 通过通用 OpenAI-compatible Chat Completions 客户端支持 DeepSeek。
- 无需修改代码即可配置自定义 OpenAI-compatible API。
- 既可以进入带斜杠命令的交互式会话，也可以单次提问后退出。
- Session 以 JSON Lines 持久化，可以在之后的进程中恢复。
- 提供 `--json` 事件流，便于脚本和其他前端消费。
- 基于类型化运行时事件流的流式输出。
- 上下文管理器：压缩较早的轮次以待在窗口内。
- 可中断的运行：Ctrl+C 结束当前运行，且不会丢失已产生的 transcript。
- Provider 调用具备单次超时和有上限的指数退避重试。
- 通过 `list_files` 和字面量 `search_text` 确定性地发现项目内容。
- 支持带续读提示的分段 `read_file`，所有工具结果都有容量上限。
- 默认只读；`--allow-writes` 才会启用 `write_file` 和 `edit_file`。
- 通过 `--allow-shell` 选择性开启的 `bash` 工具，输出边跑边显示。
- 远程会话：一个进程持有会话，其他进程通过本地 socket 接上来。
- 多个客户端可以同时观察同一个会话，其中任何一个都能中断当前运行。
- 扩展系统：可以添加工具、斜杠命令、事件订阅和 system prompt 片段。
- 项目扩展受按目录记录的信任决定门控；判定发生在任何模块被 import 之前，
  没有终端可问时一律拒绝。
- 命令运行在独立进程组中，取消一次运行会杀掉整棵进程树。
- 命令输出从尾部截断，完整内容写入临时文件供按需读取。
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
  --provider NAME  openai、deepseek、openai-compatible、openrouter、groq、xai、
                   moonshot（默认：openai）
  --model MODEL    覆盖 Provider 模型
  --max-turns N    工具调用轮次上限（默认：8，加 --allow-writes 或 --allow-shell
                   时为 16）
  --no-stream      关闭流式输出，等待完整答案
  -q, --quiet      不在 stderr 打印工具活动
  --json           以 JSON Lines 输出整次运行，而不是渲染文本
  -c, --continue   恢复当前工作区最近的一次 Session
  --resume ID      恢复指定 Session
  --api-key KEY    本次运行使用的 API Key；更推荐用环境变量
  --sessions       列出已记录的 Session 并退出
  --allow-writes   允许 Agent 创建和修改文件（默认只读）
  --allow-shell    允许 Agent 执行 Shell 命令。它蕴含写权限：Shell 不受工作区
                   边界约束。仅支持 Unix。
  --serve          把当前会话暴露在本地 socket 上并常驻
  --connect TARGET 接上一个已服务的会话，可用 id 或 socket 路径
  --servers        列出仍在响应的服务端后退出
  --no-extensions  不加载任何扩展，也不询问信任
  --extensions     列出已加载的扩展及其注册内容后退出
  --forget-trust   忘记覆盖当前工作区的信任决定后退出
  --context-window N  上下文的 Token 预算（默认：128000）
  --no-compaction  发送完整 transcript，不压缩较早的轮次
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
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | 必填 | OpenAI-compatible Chat Completions |
| Groq | `GROQ_API_KEY` | `GROQ_MODEL` | 必填 | OpenAI-compatible Chat Completions |
| xAI | `XAI_API_KEY` | `XAI_MODEL` | 必填 | OpenAI-compatible Chat Completions |
| Moonshot | `MOONSHOT_API_KEY` | `MOONSHOT_MODEL` | 必填 | OpenAI-compatible Chat Completions |

显式传入的 `--model` 优先于 Provider 对应的模型环境变量。自定义兼容供应商还必须
配置 `OPENAI_BASE_URL`。Session 记录在 `CHIVGENT_HOME`（默认 `~/.chivgent`）下。

Provider 通过注册表声明，而不是在 CLI 里分支判断，因此 `--help` 的内容、
`--provider` 的校验和实际创建 Client 用的是同一份清单。

#### API Key 解析顺序

按以下顺序解析，命中即停：

1. `--api-key`（仅本次运行）
2. Provider 对应的环境变量
3. `<CHIVGENT_HOME>/auth.json`

环境变量刻意排在文件之前，与其他 CLI 的惯例一致，这样已存储的 Key 可以被
一次性的环境变量临时覆盖，而不必改文件。

`auth.json` 是可选的，只接受字面量 Key：

```json
{
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": "sk-..."
}
```

不支持 `$VAR` 展开，也不支持 `!command` 替换：让配置文件能够启动进程，
是用很小的便利换很大的攻击面。当该文件可被其他用户读取时 chivgent 会告警，
请保持 `chmod 600`。

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
                 |                    bash（--allow-shell）-> ShellOperations
```

Agent Runtime 拥有自己的消息模型。Provider 特有的数据结构只在 `LLMClient` 边界
进行转换：

```text
Agent Message[] -> Provider Adapter -> Provider Request
                                      <- Provider Response
AssistantMessage <- Normalized Result
```

因此 Agent、工具和 CLI 不会依赖任何单一供应商的消息格式。

### 上下文管理

Session 记录发生过的一切；Context Manager 决定这一次请求值得发送什么。把两者
分开，才能让长会话待在固定的上下文窗口内。

```text
完整 transcript ──────────────→ Session Store（发生了什么）
       │
       ↓
ContextManager
       │  token 估算 vs. contextWindow - reserveTokens
       ↓
摘要 + 最近消息 ──────────────→ Provider（模型看到什么）
```

当估算超出预算时，较早的消息会被压缩成一条摘要消息，最近若干轮原样保留。
有三个细节值得注意：

- **文件清单从工具调用推导，而不是从摘要里提取。** 摘要可能遗漏或者编造路径。
  对 Coding Agent 来说，「我读过和改过哪些文件」是最需要完整存活的信息，因此
  它直接从 `read_file`、`write_file`、`edit_file` 的调用参数收集。
- **工具调用永远不会和它的结果被切开。** 会把 tool result 孤立的切点会向前
  移动，越过整组消息。
- **压缩会丢弃 Provider continuation。** 在服务端串联历史的 Provider 会重放
  它自己那份历史、忽略请求里带的消息，保留 continuation 等于把刚压缩掉的历史
  又送了回去。

Token 数量按字符长度估算，而不是用真正的 tokenizer：后者与模型强相关，为一个
只用来决定「何时压缩」的数字引入大依赖并不划算，估算误差由 reserve 预算吸收。

单条超过整个预算的工具结果无法被压缩掉，这种情况应该去限制工具输出本身。
用 `--no-compaction` 可以关闭压缩。

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
  auth/
    credentials.ts               凭据契约与解析顺序
    runtime-credentials.ts       --api-key 覆盖层
    env-credentials.ts           环境变量查找
    file-credentials.ts          可选的 auth.json 存储
  agent.ts                       Agent Loop 与运行状态
  events.ts                      运行时事件模型
  render.ts                      运行时事件的终端渲染
  llm.ts                         Provider 无关的 LLM 契约
  retry.ts                       Provider 超时与重试装饰器
  messages.ts                    运行时消息模型
  session.ts                     会话状态与事件分发
  session-store.ts               JSONL 会话日志与恢复
  repl.ts                        交互式输入与斜杠命令
  context/
    context-manager.ts           构造单次请求的消息
    compaction.ts                压缩历史并跟踪文件
    token-estimator.ts           基于字符的 Token 估算
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
    registry.ts                  Provider 注册表
    definitions.ts               内置 Provider 声明
    client.ts                    凭据解析并构造 LLM Client
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
    bash.ts                      Shell 命令执行
  remote/
    protocol.ts                  消息形状与版本协商
    framing.ts                   有界缓冲的 JSON Lines 分帧
    server.ts                    在 Unix socket 上服务一个会话
    client.ts                    接入一个已服务的会话
    repl.ts                      接入端的交互循环
    socket-path.ts               socket 路径、陈旧检测与发现
  extensions/
    trust.ts                     按目录记录的信任存储
    decide-trust.ts              询问流程，以及无人可问时的拒绝
    discover.ts                  扩展的位置与文件识别规则
    api.ts                       扩展可以注册什么
    registry.ts                  收集注册项并拒绝冲突
    loader.ts                    import 模块并隔离其失败
  shell/
    types.ts                     执行契约与 Shell 错误类型
    config.ts                    Shell 解析与 Windows 拦截
    local.ts                     本地 spawn 后端
    process.ts                   进程组终止与退出处理
    output.ts                    有界的流式输出累积器
    truncate.ts                  命令输出的尾部截断
    sanitize.ts                  控制字符过滤
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

## 远程会话

会话通常和启动它的那个终端同生共死。`--serve` 让它留在一个进程里，其他进程可以接上来：

```bash
# 终端 A
chivgent --serve --allow-writes
# chivgent 0.12.0 serving session 2026-09-06T...
# socket:       ~/.chivgent/sockets/2026-09-06T....sock
# capabilities: --allow-writes

# 终端 B
chivgent --servers                 # 列出正在运行的服务端
chivgent --connect <id>            # 交互式接入
chivgent --connect <id> "问题"      # 问一次就走
```

客户端不持有任何状态：它只负责发 prompt、渲染服务端广播的事件流。可以同时接入多个
客户端——多出来的那些实时观察同一次运行，并且**任何一个都能中断它**，因为运行属于会话，
不属于"谁发起的"。运行期间再来一个 prompt 会被拒绝而不是排队；客户端中途断开也不会
取消正在跑的运行。

接入时**不重放历史**——那是会话日志的职责。协议是 Unix socket 上的 JSON Lines，
一行一个对象，和 `--json` 输出同一种形状。

**能连上这个 socket 的人，拥有服务端启动时的全部能力。** 如果它是带 `--allow-shell`
起来的，那么任何能连上的人都能让模型执行命令——这正是服务端启动时会打印本次能力的原因：
接入的人看不到你敲了什么参数。边界是文件系统权限（socket 位于 `CHIVGENT_HOME` 下仅
所有者可访问的目录），并且**不监听 TCP**。要跨机器访问请用 SSH 转发，让认证由 SSH 负责。

## 扩展系统

一个扩展就是默认导出一个函数的 ES 模块。启动时它会被调用一次，拿到的 API 可以注册
工具、注册斜杠命令、订阅运行时事件、追加 system prompt。

```js
// .chivgent/extensions/word-count.js
export default function (api) {
  api.registerTool({
    name: "word_count",
    description: "统计工作区某个文件的词数。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context) {
      const file = await context.workspace.readTextFile(args.path);
      return {
        content: `${file.content.split(/\s+/).filter(Boolean).length} words`,
        isError: false,
      };
    },
  });

  api.contributeSystemPrompt("需要数词数时用 word_count，不要整篇读文件。");
}
```

扩展从两个位置加载：

| 位置 | 何时加载 |
| --- | --- |
| `<CHIVGENT_HOME>/extensions/` | 始终加载——那是你自己机器上的配置 |
| `<工作区>/.chivgent/extensions/` | 只有在你信任该项目之后 |

两处都接受 `name.js` 和 `name/index.js`，不再往下递归。**只支持纯 JavaScript**：
用 TypeScript 写的话自己编译成 `.js` 即可，为此让 chivgent 背上一个 TS 运行时加载器
不划算。与内置工具或命令重名的注册会被拒绝，所以扩展无法顶替 `read_file` 或
`/clear`；某个扩展坏掉只会被报告并跳过，不会把 chivgent 一起带走。

`chivgent --extensions` 可以列出加载了哪些扩展、各自注册了什么。

### Project Trust

第一次在带扩展的项目里运行 chivgent 时，它会说明这些扩展是什么并询问一次。答案记在
`<CHIVGENT_HOME>/trust.json` 里，键是解析后的目录路径，**按最近祖先匹配**——信任
`~/work` 就覆盖它下面所有仓库。`--forget-trust` 可以删掉覆盖当前工作区的那条决定。

**信任一个项目，等于允许这个仓库的作者以你的身份执行代码。** 扩展在 chivgent 进程内
运行：不受工作区边界约束，不需要 `--allow-shell` 就能执行命令，也能读到你环境变量里的
API Key。这正是询问必须发生在 import 之前的原因，也是"没人可问时一律拒绝"的原因——
CI 任务或管道运行永远不会自作主张去执行一个 clone 里的代码。

## 安全模型

- API Key 依次从 `--api-key`、环境变量、可选的 `auth.json` 解析，绝不能提交到仓库。
- `auth.json` 以明文保存 Key，因此它是可选的；当文件权限允许其他用户读取时会告警。
- 该文件只接受字面量 Key，无法展开环境变量或执行 Shell 命令。
- 自定义 `OPENAI_BASE_URL` 会收到配置的 API Key 和提示词，只能使用可信端点。
- 不传 `--allow-writes` 时工作区工具全部只读，`write_file` 和 `edit_file` 根本
  不会被注册。
- `bash` 工具需要 `--allow-shell`，它与 `--allow-writes` 相互独立，永远不会被后者
  顺带打开。授予它意味着授予大得多的权限：Shell 能改动或删除运行 chivgent 的用户
  能碰的任何东西，无论是否在工作区内，下面这些工作区限制对它一律不适用。
- 命令运行在独立进程组中并按组杀死，取消一次运行不会留下孤儿后代进程。
- 命令会继承 chivgent 的环境变量，其中包含它正在使用的 API Key。开了
  `--allow-shell` 的模型可以读到这个 Key 以及环境里的其他内容。请只带上这次任务
  真正需要的环境变量。
- 被截断的命令输出会写入临时文件供模型按需读取。该文件仅所有者可读，但运行结束后
  **不会自动删除**，其中可能包含命令打印的任何内容。处理敏感数据后请清理临时目录。
- 开启 `--allow-shell` 后，会话日志除文件片段外还会记录命令输出。
- 项目扩展只有在存在明确的、已记录的信任决定之后才会加载，且没有终端可问时绝不加载。
  扩展以你的权限在进程内运行，上面那些工作区限制对它一概不适用——因此"信任一个项目"
  与 `--allow-shell` 是同一量级的授权，区别只在于前者由 clone 一个仓库触发，
  后者要你亲手敲一个参数。
- `<CHIVGENT_HOME>/extensions/` 下的用户级扩展始终加载，那是你自己的配置。
- 扩展无法占用内置工具或内置命令的名字。
- `trust.json` 与会话日志、认证文件一样，以仅所有者可读的权限写入。
- 被服务的会话对任何能打开其 socket 的人可达，且他们获得服务端启动时的全部能力。
  socket 位于仅所有者可访问的目录中；**真正起作用的是目录权限**，因为 socket 文件在
  能被收紧权限之前会短暂地以默认权限存在。
- chivgent 从不监听 TCP。跨机器访问请使用 SSH 转发。
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

这是一个用于学习的 MVP，并不是经过加固的 Sandbox。它**没有权限系统**：能力开关
都是会话级的粗粒度开关，`--allow-writes` 和 `--allow-shell` 都不会对每次操作逐一
确认。这是有意为之：有了 Shell 之后，命令白名单能被一行 `sh -c` 绕开，而逐次弹确认
只会训练用户无脑确认，所以 chivgent 选择把边界说清楚，而不是假装能拦住什么。

请在已提交的代码上使用这些开关。如果需要真正的边界，请把整个进程放进容器，并只给
容器这次任务真正需要的东西。在允许它访问敏感项目之前，请先审查代码和威胁模型。

## 路线图

- [x] 最小 Tool Calling Agent Loop
- [x] 安全的 `read_file` 工具
- [x] OpenAI 和 DeepSeek Provider
- [x] 通用 OpenAI-compatible Chat Completions Adapter
- [x] 自定义 OpenAI-compatible CLI Provider
- [x] 项目发现工具：`list_files`、`search_text` 和分段 `read_file`
- [x] 流式输出和运行时事件
- [x] 持久化多轮 Session
- [x] Context Window 管理和压缩
- [x] 通过 `--allow-writes` 选择性开启的 `write_file` 和 `edit_file`
- [x] Provider Registry 与凭据解析链
- [x] 通过 `--allow-shell` 开启的 `bash` 工具，带流式输出
- [x] 扩展系统与 Project Trust
- [x] 基于本地 socket 的远程会话
- [ ] TUI、Telemetry 和 Evals

逐条命令确认和命令白名单是**主动放弃**的方向。有了 Shell 工具之后，`bash` 能做的
事是 `write_file` 的超集，任何白名单都能被一行 `sh -c` 绕开，而逐条弹确认只会训练
用户无脑确认。能力开关一律是会话级的粗粒度开关，真正的边界是容器。

## 文档

- [Stage 1：Minimal Agent 设计](docs/stage-1-minimal-agent.md)
- [DeepSeek Provider 设计](docs/deepseek-provider.md)
- [Stage 2：Project Discovery 实现设计](docs/stage-2-project-discovery.md)
- [Stage 3：Runtime Events 与流式输出设计](docs/stage-3-runtime-events.md)
- [Stage 4：Session 与交互模式设计](docs/stage-4-sessions.md)
- [Stage 5：写入工具与 Workspace 拆分](docs/stage-5-write-tools.md)
- [Stage 6：Provider Registry 与凭证解析链](docs/stage-6-provider-registry.md)
- [Stage 7：上下文预算与压缩](docs/stage-7-context-management.md)
- [Stage 8：Shell 工具与流式子进程](docs/stage-8-shell-tool.md)
- [Stage 9：扩展系统与 Project Trust](docs/stage-9-extensions.md)
- [Stage 10：远程会话](docs/stage-10-remote-sessions.md)
- [Stage 11：Evals](docs/stage-11-evals.md)
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
