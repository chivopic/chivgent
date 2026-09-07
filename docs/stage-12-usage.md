# Stage 12: Token 用量

> 目标版本：`0.15.0`
> 状态：已实现（2026-09-07）。本文先于实现写成，实现中发现的问题记在第 8.1 节。

> Stage 11 让"这个 Agent 能不能把活干成"变成一个能回答的问题，但报告里只有通过率、
> 轮数和墙钟时间——**没有代价**。一个把通过率从 70% 提到 75%、token 却翻三倍的
> prompt 改动，在现在的报告里看起来是纯赚。Provider 每次都在响应里返回 `usage`，
> chivgent 一直把它丢掉。Stage 12 只解决这一件事。

## 1. 目标

```text
Provider response.usage
  -> LLMResponse.usage
  -> message_end 事件（这一轮的用量）
  -> agent_end 事件 / AgentRunResult（整次运行的合计）
  -> eval 报告：每个任务的 token 中位数
  -> REPL /session：这次会话累计
```

完成后：

1. `npm run eval` 的表格里有 token 列，JSON 报告里有每次尝试的用量。
2. 改了 prompt 之后能同时看到"通过率变化"和"代价变化"。
3. 交互式会话里能查这次会话花了多少。

## 2. 只报 token，不报钱

这是本阶段唯一需要辩护的决定。

把 token 换算成金额需要一张"模型 → 单价"的表。那张表会**悄悄过期**：Provider 调价、
改计费口径、出新模型，而代码里的数字不会跟着变。结果是一个看起来精确、实际错误的
金额——比没有数字更糟，因为没人会去质疑一个带小数点的美元数。

token 数是 Provider 自己报的事实，不会过期。谁要算钱，拿着 token 数和当天的价目表
自己算，那一步的责任归属是清楚的。

## 3. Usage 的形状

```ts
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Provider 报告的缓存命中部分，没有就不填。 */
  readonly cachedInputTokens?: number;
  /** 推理模型单独计费的思考 token。 */
  readonly reasoningTokens?: number;
}
```

`LLMResponse.usage` 是**可选的**。理由：不是每个 Provider、每种调用方式都会报。缺失
必须是合法状态，不能是错误——把"没报"当成"零"会让合计悄悄偏小，比没有数字更危险。

## 4. 各 Provider 怎么取

| Provider | 非流式 | 流式 |
| --- | --- | --- |
| OpenAI Responses | `response.usage` | `response.completed` 事件里的完整 response |
| Chat Completions | `response.usage` | **需要 `stream_options: { include_usage: true }`** |

Chat Completions 的流式默认**不返回** usage，必须显式要。要了之后，最后会多来一个
`choices` 为空、只带 `usage` 的 chunk——累加器已经能安全跳过没有 choice 的 chunk，
但这条要在测试里钉住。

**兼容性风险**：`stream_options` 是较新的字段，某个自建的 OpenAI 兼容端点可能不认识
而返回 400。这是本阶段唯一可能影响既有用户的改动，所以要在文档里写明：真遇到了，
`--no-stream` 是可用的退路。

## 5. 合计的语义

一次运行有多个轮次，每轮一次 Provider 调用。合计是**逐轮相加**。

三件容易搞错的事：

1. **压缩会额外调一次模型。** Stage 7 的 Compactor 自己发请求做摘要，那也是花掉的
   token。它必须计入合计，否则"压缩省了多少"这个问题永远问不清楚——压缩省下的是
   后续轮次的输入，代价是一次额外的输出。
2. **重试不重复计数。** `RetryingLLMClient` 失败重试时，失败的那次调用可能没有 usage
   （请求根本没成功），成功的那次才有。透传即可，不要自己造。
3. **缺失不是零。** 若某一轮没有 usage，合计里要能看出"这次的数字不完整"，而不是
   悄悄少加。用一个 `complete: boolean` 标记合计是否覆盖了每一轮。

## 6. 呈现

**eval 表格**新增一列（token 中位数）：

```text
task                  pass  turns  tokens   tools                p50
find-auth-logic       4/5   2.0    3.4k     list_files,read_file  6.1s
rename-symbol         3/5   5.4    12.1k    read_file,edit_file   9.8s

overall  7/10 (70%)   58.3k tokens
```

**JSON 报告**里每次尝试带完整的 usage，便于跨版本比对。

**REPL** 的 `/session` 增加一行累计。不在每次回答后自动打印——那是噪音，问的时候再说。

## 7. 测试策略

1. 三个 adapter 各自从响应里取出 usage（用假响应，不发网络请求）。
2. Provider 没报 usage 时，`LLMResponse.usage` 是 `undefined` 而不是零。
3. 流式：Chat Completions 的最后一个空 `choices` chunk 只贡献 usage，不破坏消息重建。
4. Agent 逐轮累加；某一轮缺失时合计标记为不完整。
5. 压缩产生的那次调用计入合计。
6. eval 报告里的 token 列与 JSON 字段。
7. 数字全部来自假 Provider——本阶段不需要也不应该发真实请求。

## 8. 验收标准

- [x] 两个 adapter 都能取到 usage，非流式与流式皆可（端到端验证，含 `cachedInputTokens`）。
- [x] 缺失的 usage 保持 `undefined`，合计能标出不完整。
- [x] 压缩调用计入运行合计（反向验证过：去掉那行累加，测试立刻失败）。
- [x] eval 表格与 JSON 报告包含 token。
- [x] `/session` 显示本次会话累计；没有任何 Provider 报过用量时不显示这一行。
- [x] 不出现任何金额。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过（378 个测试）。
- [x] README（中英）说明用量从哪来、为什么不报钱、`stream_options` 的兼容性退路。
- [x] 版本提升到 `0.15.0`。

## 8.1 实现中发现的问题

**"没有压缩"被误记成了"有一次调用没报用量"。** `buildContext` 每一轮都把
`context.usage` 累加进去，而不需要压缩的轮次那个值是 `undefined`——于是
`addUsage` 把合计标成了 `complete: false`。后果是**每一次真实的 CLI 运行都会被标成
不完整**，因为 CLI 总是带着 ContextManager。

这个 bug 单元测试没抓到：`complete: true` 的那条用例用的 Agent 没有配 ContextManager，
`buildContext` 提前返回，根本走不到那行。是端到端拿真实 stub 跑了一次、盯着
`agent_end` 里的 `complete` 字段才看出来的。

修法是只在真的有压缩调用时才累加——**没花钱和没报账是两回事**，只有后者才是缺口。
补了一条专门的测试：配了 ContextManager 但没触发压缩的运行，合计必须是完整的。

## 9. 不在本阶段

金额换算、按 Provider 的价目表、预算上限与限流、OpenTelemetry 之类的导出、
跨会话的用量历史库、把用量写进会话日志（那会让日志随每轮增长，且合计可以从
`agent_end` 还原）。
