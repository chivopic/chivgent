# Stage 3: Runtime Events、Streaming 与可中断运行

> 本文记录 `0.5.0` 的增量设计。Stage 2 让 Agent 能发现并读取项目内容，但整个运行
> 过程对外仍然是一个黑盒：只有跑完之后才有输出，无法中断，Provider 抖动会直接
> 让一次运行失败。Stage 3 只解决"可观察、可控制"这一件事，不引入写入工具、
> Session 或 TUI。

## 1. 目标

```text
User
  -> CLI
  -> Agent Loop --(AgentEvent)--> Renderer -> 终端
       |
       +-> LLMClient.stream() --(text delta)--> AgentEvent
       |
       +-> Tool --(start / end)--> AgentEvent
```

完成后：

1. 答案在模型生成的同时输出，而不是等整轮结束。
2. 工具调用过程可见：调用了什么、参数是什么、结果是否出错。
3. Ctrl+C 能确定性地结束当前运行，并且不丢失已经产生的 transcript。
4. Provider 超时和临时故障由一层装饰器处理，Agent Loop 不感知重试。

## 2. 设计原则

1. Agent Loop 不做任何 I/O。它只发事件，由外部决定如何呈现。
2. 事件是数据，不是回调协议：每个事件都可被 `structuredClone`，可以直接写成
   JSON 一行，供日志、RPC 模式或未来的 TUI 使用。
3. 增量事件只携带 delta，不携带累计快照，事件流体积与答案长度成线性关系。
4. 监听者拿到的是副本。渲染层崩溃或修改事件，都不能影响这次运行的结果。
5. Streaming 是 Provider 的可选能力，不是 Agent Loop 的分支条件。
6. 中断是一种正常结果（`aborted`），不是异常。
7. 重试对 Agent Loop 不可见：一次 `complete()` 要么返回消息，要么失败。

## 3. 事件模型

`src/events.ts`：

```text
agent_start          prompt, maxTurns
  turn_start         turn
  message_start      turn
  message_update     turn, delta          （0..n 次，仅 streaming）
  message_end        turn, message
  tool_execution_start  turn, toolCallId, toolName, arguments
  tool_execution_end    turn, toolCallId, toolName, content, isError
  turn_end           turn, message, toolResults
agent_end            status, turnCount, messages, error?
```

`status` 取值为 `completed | max_turns | aborted | error`。

约束：

- 每个 `turn_start` 必须有配对的 `turn_end`，除非运行在这一轮被中断或失败。
- 每个 `tool_execution_start` 必须有配对的 `tool_execution_end`，包括工具失败。
- `agent_end` 是最后一个事件，无论运行是完成、超限、被中断还是抛错。
- 抛错时先发 `agent_end(status: "error")` 再向上抛，调用方不会丢失事件流。

## 4. LLMClient 边界

```ts
interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest, handlers: LLMStreamHandlers): Promise<LLMResponse>;
}
```

`stream()` 必须返回与 `complete()` 相同的 `LLMResponse`，包括 continuation。
Agent 只判断 `stream` 是否存在，不判断 Provider 是谁。

`LLMRequest` 增加 `signal?: AbortSignal`，由 Provider 传给底层 SDK。

### Provider 实现

- OpenAI Responses：消费 `response.output_text.delta`，在 `response.completed`
  时拿到完整 Response，再走与非流式相同的转换函数。流结束却没有 completed
  事件视为协议错误。
- OpenAI-compatible Chat Completions：`ChatCompletionAccumulator` 按 chunk 累计
  `content`、`reasoning_content` 和按 `index` 分片的 `tool_calls`，重建出一条与
  非流式响应等价的 assistant 消息，再复用既有的 continuation 逻辑。缺少 `id` 或
  `name` 的 tool call 视为协议错误，不静默丢弃。

## 5. 中断

`agent.run(prompt, { signal })` 在三个位置检查取消：

1. 每一轮开始前。
2. Provider 调用期间（通过 `signal` 传到 SDK）。
3. 每次工具执行之前。

被中断时返回 `{ status: "aborted", messages, turnCount }`，不抛异常；CLI 以 `130`
退出。工具抛出的中断错误向上传递，不会被"工具失败"的兜底逻辑吞掉。

## 6. 超时与重试

`RetryingLLMClient` 是一层装饰器，不修改任何 Provider：

- 单次尝试有独立 deadline，超时后转成可重试的 `LLMTimeoutError`。
- 可重试：`408/409/425/429`、`5xx`、常见网络错误码、连接类错误。
- 不可重试：其他 4xx、调用方主动中断。
- 退避为有上限的指数退避，`sleep` 可注入，测试不依赖真实时间。
- **已经输出过 delta 的 stream 不重试**：重放会让用户看到重复文本。

## 7. 渲染边界

`src/render.ts` 把事件翻译成终端输出：

- 答案写 stdout，保持可管道。
- 工具活动、重试和运行状态写 stderr。
- `--no-stream` 时不消费 delta，改为在 `message_end` 一次性输出。
- `--quiet` 时不输出工具活动。

渲染器是纯函数式的事件消费者，测试中用字符串缓冲替代 `process.stdout`。

## 8. 测试策略

新增：

1. 一次工具调用运行的完整事件顺序。
2. 工具事件携带的参数与结果（含错误分支）。
3. streaming 产生 delta，`--no-stream` 不产生 delta。
4. `max_turns` 与 `error` 状态出现在最后一个事件上。
5. 监听者抛异常不影响运行结果。
6. 监听者修改事件不影响 transcript。
7. 中断：运行中取消、开始前已取消。
8. 重试：可重试状态码、退避序列、不可重试错误、尝试次数上限、网络错误、超时。
9. 重试：已输出文本的 stream 不重放。
10. Provider streaming：delta 累计、tool call 分片重组、reasoning 保留、协议错误。

全部使用脚本化的假 Provider，不消耗额度。

## 9. 验收标准

- [x] Agent Loop 通过事件对外汇报，自身不做 I/O。
- [x] 两类 Provider 都实现 `stream()`，且与 `complete()` 返回同构结果。
- [x] Ctrl+C 返回 `aborted` 并以 `130` 退出。
- [x] 超时与重试对 Agent Loop 不可见，且不会重放已输出的文本。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）功能、CLI、架构、项目结构和路线图已更新。
- [x] 版本提升到 `0.5.0`，CLI `--version` 与 `package.json` 一致。

## 10. 不在本阶段

Token / 成本统计、上下文压缩、持久化 Session、写入工具、权限确认、TUI。

`agent.run()` 已经接受 `history`，为下一阶段的 Session 留好接口，但本阶段的 CLI
仍然是单次问答。
