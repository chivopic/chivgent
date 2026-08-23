# chivgent

[English](README.md) | [简体中文](README.zh-CN.md)

> 一个小巧、易读的 Coding Agent CLI，用来理解 Agent Harness 的真实工作原理。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)
[![CI](https://github.com/chivopic/chivgent/actions/workflows/ci.yml/badge.svg)](https://github.com/chivopic/chivgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-MVP-orange)

`chivgent` 将 Provider 无关的 Agent Loop 与 LLM API、工具和工作区边界连接起来。
当前 MVP 可以通过安全、只读的 `read_file` 工具分析本地项目，并使用 OpenAI、
DeepSeek 或任意兼容 Chat Completions 的 API 回答代码问题。

这个项目刻意保持精简：先让 Tool Calling、Conversation State、Provider Adapter
和循环终止条件容易理解，再逐步加入成熟 Agent Harness 所需的工程复杂度。

## 功能

- 完整的多轮 Agent Loop：模型 -> Tool Call -> Tool Result -> 模型。
- Provider 无关的运行时消息和工具契约。
- 通过 Responses API 支持 OpenAI。
- 通过通用 OpenAI-compatible Chat Completions 客户端支持 DeepSeek。
- 无需修改代码即可配置自定义 OpenAI-compatible API。
- 安全、只读的工作区访问，阻止路径穿越和符号链接逃逸。
- 工具参数验证、明确的工具错误和最多八轮的安全限制。
- 可打包安装的 Node.js CLI，不依赖 Agent 框架。
- 默认测试不调用真实 API，不消耗模型额度。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm
- OpenAI、DeepSeek 或其他兼容供应商的 API Key

### 从源码安装

```bash
git clone https://github.com/chivopic/chivgent.git
cd chivgent
npm install
npm run build
npm install -g .
```

检查安装结果：

```bash
chivgent --version
chivgent --help
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

CLI 只向 stdout 输出最终答案。Provider 错误和诊断信息写入 stderr，并返回非零
退出码。

## CLI 参考

```text
chivgent [--provider openai|deepseek|openai-compatible] [--model MODEL] "问题"

选项：
  --provider NAME  openai、deepseek 或 openai-compatible（默认：openai）
  --model MODEL    覆盖 Provider 模型
  -h, --help       显示帮助
  -v, --version    显示版本
```

### Provider 配置

| Provider | API Key | 模型环境变量 | 默认模型 | API 形式 |
| --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5.6` | Responses API |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-v4-flash` | OpenAI-compatible Chat Completions |
| 自定义兼容供应商 | `OPENAI_API_KEY` | `OPENAI_MODEL` | 必填 | OpenAI-compatible Chat Completions |

显式传入的 `--model` 优先于 Provider 对应的模型环境变量。自定义兼容供应商还必须
配置 `OPENAI_BASE_URL`。

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
                 +-> Tool Registry -> read_file -> Workspace
```

Agent Runtime 拥有自己的消息模型。Provider 特有的数据结构只在 `LLMClient` 边界
进行转换：

```text
Agent Message[] -> Provider Adapter -> Provider Request
                                      <- Provider Response
AssistantMessage <- Normalized Result
```

因此 Agent、工具和 CLI 不会依赖任何单一供应商的消息格式。

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
  llm.ts                         Provider 无关的 LLM 契约
  messages.ts                    运行时消息模型
  workspace.ts                   安全的本地工作区访问
  providers/
    openai.ts                    OpenAI Responses Adapter
    openai-compatible-chat.ts    通用 Chat Completions Adapter
    deepseek.ts                  DeepSeek 配置包装器
  tools/
    tool.ts                      Tool 契约
    read-file.ts                 只读文件工具
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

构建一个可以在本地安装的 tarball：

```bash
npm pack
npm install -g ./chivgent-0.3.0.tgz
```

测试使用脚本化或 Mock LLM Client。真实 API Smoke Test 需要手工执行，因此默认
测试不会消耗 API 额度。

## 安全模型

- API Key 只从环境变量读取，绝不能提交到仓库。
- 自定义 `OPENAI_BASE_URL` 会收到配置的 API Key 和提示词，只能使用可信端点。
- 当前唯一的工具是只读工具。
- 文件路径必须位于当前工作区内。
- Real Path 检查会阻止 `..` 路径穿越和符号链接逃逸。
- 文件大小和二进制内容检查会限制不安全的读取。
- 工具输入是不可信数据，执行前必须验证。
- Agent 会在有限的模型轮数后终止。

这是一个用于学习的 MVP，并不是经过加固的 Sandbox。在为它增加写文件或 Shell
工具，并允许其访问敏感项目之前，请先审查代码和威胁模型。

## 路线图

- [x] 最小 Tool Calling Agent Loop
- [x] 安全的 `read_file` 工具
- [x] OpenAI 和 DeepSeek Provider
- [x] 通用 OpenAI-compatible Chat Completions Adapter
- [x] 自定义 OpenAI-compatible CLI Provider
- [ ] 流式输出和运行时事件
- [ ] 持久化多轮 Session
- [ ] Context Window 管理和压缩
- [ ] 需要权限确认的 `write_file`、`edit_file` 和 Shell 工具
- [ ] Provider Registry 和用户配置文件
- [ ] TUI、Extensions、Telemetry 和 Evals

## 文档

- [Stage 1：Minimal Agent 设计](docs/stage-1-minimal-agent.md)
- [DeepSeek Provider 设计](docs/deepseek-provider.md)

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
