# Stage 1: Minimal Agent 设计

> 本文保留最初的单 Provider Stage 1 设计。当前 `0.2.0` 已在不改变
> Agent Runtime 抽象的前提下增加 DeepSeek；增量设计见
> [DeepSeek Provider](deepseek-provider.md)。

## 1. 目标

Stage 1 只实现一条完整链路：

```text
User
  -> CLI
  -> Agent Loop
  -> LLMClient
  -> read_file ToolCall
  -> Workspace
  -> ToolResult
  -> LLMClient
  -> Final Answer
```

完成后，用户可以在一个项目目录中提问：

```text
chivgent "src/main.ts 在做什么？"
```

Agent 必须先调用 `read_file`，再根据文件内容回答。

Stage 1 不包含 streaming、长期会话、多 Provider、TUI、写文件、Shell、配置文件、插件、MCP、Telemetry、重试和并行工具执行。

## 2. 设计原则

1. Agent Runtime 使用自己的消息模型，OpenAI 类型只能存在于 Provider 实现内部。
2. Agent Loop 是唯一可以修改本次运行 transcript 的组件。
3. LLMClient 无状态：输入完整上下文，返回一条 AssistantMessage。
4. Tool 不知道 LLM、CLI 或 transcript，只处理经过验证的参数和 ToolContext。
5. 每个 ToolCall 必须产生且只产生一个 ToolResultMessage，包括失败情况。
6. 每次运行必须受 `maxTurns` 限制，保证循环一定可以结束。

## 3. 模块边界

```text
src/
  cli.ts                 参数、环境变量、输出和退出码
  agent.ts               Agent Loop 与单次运行状态
  messages.ts            Provider 无关的消息模型
  llm.ts                 LLMClient 契约
  workspace.ts           工作区路径和读取边界
  tools/
    tool.ts              Tool 契约与 Registry
    read-file.ts         唯一的 Stage 1 工具

  providers/
    openai.ts             内部消息与 OpenAI 消息的双向转换

tests/
  agent.test.ts           使用 FakeLLMClient 测试循环
  read-file.test.ts       测试工作区和文件读取边界
```

依赖方向：

```text
CLI -> Agent -> LLMClient
             -> Tool Registry -> Workspace

OpenAIClient -> LLMClient
ReadFileTool -> Tool
```

`agent.ts` 不得导入 OpenAI SDK，`tools/` 不得导入 `agent.ts` 或 Provider。

## 4. 内部消息模型

不要用一个包含大量可选字段的通用 Message。使用判别联合，让非法状态尽量无法表达。

```ts
export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}
```

这里的 `AssistantMessage` 同时允许文本和 Tool Call，因为模型可能在调用工具前输出简短文本。

`arguments` 故意是 `unknown`。LLM 输出是不可信输入，必须由具体 Tool 验证后才能执行。

### Transcript 不变量

- 第一条消息必须是 UserMessage。
- AssistantMessage 必须先加入 transcript，再执行其中的 Tool Call。
- 如果 AssistantMessage 有 N 个 Tool Call，下一次 LLM 调用前必须追加 N 个对应的 ToolResultMessage。
- Tool Result 的顺序与 Tool Call 顺序一致。
- Tool Call ID 在一次运行内必须唯一。
- 没有 Tool Call 的 AssistantMessage 表示正常完成。
- 没有文本也没有 Tool Call 的 AssistantMessage 是无效 Provider 响应。

## 5. Tool 抽象

Stage 1 只需要一个被类型擦除后的运行时接口，不需要复杂的泛型 Registry。

```ts
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolContext {
  readonly workspace: Workspace;
}

export interface ToolOutput {
  readonly content: string;
  readonly isError: boolean;
}

export interface Tool extends ToolDefinition {
  execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput>;
}
```

Tool 的职责包括：

1. 验证 `argumentsValue`。
2. 调用 Workspace 能力。
3. 把预期内错误转为可供模型理解的 `ToolOutput`。

Agent 仍会在 Tool 外层捕获意外异常，并生成 `isError: true` 的 Tool Result，确保每个 Tool Call 都有对应结果。

### Tool Registry

Registry 可以先用：

```ts
ReadonlyMap<string, Tool>
```

重复 Tool 名称在 Agent 构造阶段报错。模型调用未知工具时，不终止循环，而是返回错误 Tool Result。

## 6. read_file

输入 Schema：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path relative to the workspace root"
    }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

Stage 1 约束：

- 只接受相对路径。
- 路径必须位于 workspace root 内。
- 使用真实路径检查阻止 `..` 和符号链接逃逸。
- 只读取普通文件。
- 默认最大读取 256 KiB。
- 拒绝包含 NUL 字节的疑似二进制文件。
- 使用 UTF-8 解码；无法解码时返回 Tool Error。

Workspace 负责文件系统边界，ReadFileTool 负责参数验证和面向模型的错误信息。

概念接口：

```ts
export interface Workspace {
  readonly root: string;
  readTextFile(relativePath: string): Promise<string>;
}
```

## 7. LLMClient 抽象

```ts
export interface LLMRequest {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly continuation?: unknown;
}

export interface LLMResponse {
  readonly message: AssistantMessage;
  readonly continuation?: unknown;
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
```

`LLMClient` 不保存 conversation state，也不修改传入的 messages。某些 Provider
需要保留无法安全转换成内部 Message 的状态，因此它可以返回一个不透明的
`continuation`。Agent 不读取其内容，只在下一次 LLM 调用时原样返回。

OpenAI Responses API 使用 `previous_response_id` 作为 continuation。这样推理模型
产生的 reasoning items 仍由 Provider 管理，不需要泄漏进 Agent 的内部 transcript。

OpenAIClient 在边界内完成：

```text
Message[]
  -> OpenAI request messages
  -> OpenAI API
  -> OpenAI response
  -> AssistantMessage
```

API Key、模型名和 OpenAI SDK Client 属于 OpenAIClient 的构造配置，不属于 AgentState。

Stage 1 使用非流式请求，不实现重试。

## 8. Agent 与运行状态

Agent 保存依赖和配置，不保存跨请求的 conversation。单次 `run()` 独占其 RunState。

```ts
export interface AgentOptions {
  readonly systemPrompt: string;
  readonly maxTurns: number;
  readonly llm: LLMClient;
  readonly tools: readonly Tool[];
  readonly workspace: Workspace;
}

interface RunState {
  readonly messages: Message[];
  turnCount: number;
  continuation?: unknown;
}

export type AgentRunResult =
  | {
      readonly status: "completed";
      readonly finalMessage: AssistantMessage;
      readonly messages: readonly Message[];
      readonly turnCount: number;
    }
  | {
      readonly status: "max_turns";
      readonly messages: readonly Message[];
      readonly turnCount: number;
    };

export interface Agent {
  run(userInput: string): Promise<AgentRunResult>;
}
```

这里的一个 turn 定义为一次 LLM 调用，而不是一次工具执行。

Agent 对 transcript 拥有唯一写权限。返回结果中的 messages 必须是快照，调用方不能借此修改内部状态。

### Loop 伪代码

```text
state.messages = [UserMessage(userInput)]
state.turnCount = 0

while state.turnCount < maxTurns:
    state.turnCount += 1

    response = llm.complete(
        snapshot(state.messages),
        toolDefinitions,
        state.continuation,
    )
    assistant = validate(response.message)
    state.continuation = response.continuation
    append assistant to state.messages

    if assistant.toolCalls is empty:
        return completed(assistant, snapshot(state))

    assert tool call ids are unique

    for toolCall in assistant.toolCalls, sequentially:
        tool = registry.get(toolCall.name)

        if tool does not exist:
            output = error("Unknown tool")
        else:
            try:
                output = tool.execute(toolCall.arguments, context)
            catch error:
                output = error("Tool execution failed")

        append ToolResultMessage to state.messages

return max_turns(snapshot(state))
```

即使 Stage 1 只有一个工具，也支持同一条 AssistantMessage 中出现多个 Tool Call；它们按顺序执行，不实现并行。

## 9. 错误边界

不同错误采用不同处理方式：

| 错误 | 行为 |
| --- | --- |
| Tool 参数错误 | 追加错误 Tool Result，继续循环 |
| 文件不存在、越界或过大 | 追加错误 Tool Result，继续循环 |
| 未知 Tool | 追加错误 Tool Result，继续循环 |
| Tool 意外抛错 | 脱敏后追加错误 Tool Result，继续循环 |
| Provider 网络或鉴权错误 | `run()` 抛出异常，由 CLI 输出并设置非零退出码 |
| Provider 返回非法消息 | `run()` 抛出协议错误 |
| 达到最大轮数 | 返回 `status: "max_turns"` |

Tool Result 不得包含堆栈、API Key、环境变量或 workspace 外的绝对路径。

## 10. CLI 边界

CLI 只负责：

- 读取用户问题。
- 从 `process.cwd()` 创建 Workspace。
- 从环境变量读取 API Key。
- 构造 OpenAIClient 和 Agent。
- completed 时向 stdout 输出最终文本。
- 错误和诊断信息写入 stderr。
- 为失败、鉴权错误和 max turns 设置非零退出码。

CLI 不实现 Agent Loop，也不自行执行 Tool。

## 11. 测试策略

先使用脚本化 FakeLLMClient，不依赖真实 API：

```ts
new FakeLLMClient([
  assistant({
    toolCalls: [call("read_file", { path: "fixture.ts" })],
  }),
  assistant({ content: "fixture.ts exports add()." }),
]);
```

必须覆盖：

1. 第一次 LLM 响应直接给出答案。
2. read_file 成功，Tool Result 回填后产生答案。
3. 文件不存在时，错误回填给 LLM。
4. 参数类型错误时不执行文件读取。
5. 未知 Tool 产生错误 Tool Result。
6. 一条消息内的多个 Tool Call 按顺序执行并全部回填。
7. 重复 Tool Call ID 被拒绝。
8. 达到 `maxTurns` 后确定性结束。
9. `../` 与符号链接不能逃出 workspace。
10. 超大文件和二进制文件被拒绝。

真实 OpenAI API 只做一个手工 smoke test，不作为默认单元测试的一部分。

## 12. Stage 1 完成定义

只有同时满足以下条件，才进入 Pi 源码对照：

- FakeLLMClient 的 Agent Loop 测试全部通过。
- read_file 的边界测试全部通过。
- Agent、Tool、CLI 中没有 OpenAI SDK 类型泄漏。
- CLI 能针对当前 workspace 完成一次真实的 read_file 问答。
- 核心 Agent Loop 可以在一屏左右读完。
- README 能用一张图说明完整请求链。

完成后，只对照 Pi 的消息类型、Agent Loop 和 LLM 边界，记录：

```text
Pi 多出的机制 | 它解决的问题 | Stage 1 是否需要 | 推迟到哪个版本
```

没有当前需求支撑的机制不迁入 mini-Pi。
