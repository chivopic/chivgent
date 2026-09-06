# Stage 7: 上下文预算与压缩

> 本文记录 `0.9.0` 的增量设计。Stage 4 之后会话可以一直谈下去，但每一轮都把完整
> transcript 原样发出去，长会话必然撞上上下文窗口，而撞上的表现是一次失败的请求。
> Stage 7 只解决"发出去的上下文有预算"这一件事，不引入真实 tokenizer、成本统计或 TUI。

## 1. 目标

```text
AgentSession   transcript：发生过什么（完整、只增不减）
      |
      v
ContextManager 上下文：这一次该发什么（受预算约束）
      |
      +-- 估算 -> 超预算？ -> Compactor -> CompactionState -> 一条摘要消息
      v
   LLMClient
```

完成后：

1. 一次长会话不会因为上下文超限而失败。
2. 压缩之后，transcript 仍然是完整的：被换掉的只是"这次发什么"。
3. 摘要里的文件清单来自工具调用本身，不由模型复述。
4. `--context-window` 可调，`--no-compaction` 可关。

## 2. 设计原则

1. **Session 拥有"发生过什么"，ContextManager 拥有"该发什么"。** 两者分开，才可能
   在固定窗口里进行无限长的会话。
2. **压缩不修改 transcript。** 会话日志、`--continue`、`--json` 看到的仍是全量历史。
3. **估算允许有误差，reserve 负责吸收。** 高估只是提前压缩一次，代价是一次摘要调用；
   低估才会导致请求失败。
4. **切分点不能拆散一组工具调用。** tool result 必须和请求它的 assistant 消息在同一侧。
5. **文件清单由工具调用推导，不交给模型。** 摘要会忘会编，调用记录不会。
6. **压缩必须能被 Provider 侧的续写机制感知。** 否则摘要不生效。

## 3. Token 估算

```ts
class HeuristicTokenEstimator implements TokenEstimator {
  constructor(charactersPerToken = 4, messageOverheadTokens = 4);
}
```

按字符数除以 4，每条消息再加固定开销；assistant 消息把 `toolCalls` 的名字和参数
一起计入，tool 消息把工具名计入。

为什么不用真 tokenizer：它是 Provider 和模型特定的，会为了一个"只决定何时压缩"的
数字引入一个大依赖。预留额度（reserve）的存在就是为了吸收这个估算的误差。

## 4. 预算

```text
budget = contextWindow - reserveTokens
```

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `contextWindow` | 128 000 | 总窗口，`--context-window` 可调，下限 1 000 |
| `reserveTokens` | 16 384，且不超过窗口的 1/4 | 留给模型回复和估算误差 |
| `keepRecentTokens` | 20 000，且不超过窗口的 1/2 | 压缩后大致保留多少近期对话 |

两个上限的意义：给一个很小的窗口时，固定的预留额度会把预算吃光，所以按窗口比例封顶。
`reserveTokens >= contextWindow` 直接在构造时抛错。

未配置 `compactor` 时，ContextManager 退化为直通：估算照做，但不压缩。这就是
`--no-compaction` 的实现方式。

## 5. 切分点

`findSplitIndex()` 从最新一条往回累加，直到超过 `keepRecentTokens`，然后做两次修正：

1. **向后越过整组 tool 消息**：切分点若落在 tool result 上，会把它和请求它的 assistant
   消息分到两侧，留下一条没有来处的工具结果。
2. **至少留一条真实消息在摘要之后**：否则模型收到的只有一段摘要，没有当前问题。

切分点为 0 时不压缩——没有可总结的历史，压了也不会变短。

## 6. CompactionState 与 Compactor

```ts
interface CompactionState {
  readonly summary: string;
  readonly readFiles: readonly string[];      // 由 read_file 调用推导
  readonly modifiedFiles: readonly string[];  // 由 write_file / edit_file 调用推导
  readonly decisions: readonly string[];
  readonly pendingTasks: readonly string[];
}
```

两半分别来自两个地方：

- **散文部分**（summary / decisions / pendingTasks）由一次 LLM 调用产生，要求返回
  固定形状的 JSON。`parseSummary()` 容忍 JSON 前后的多余文字，完全解析不出来时
  退回到把原文当作 summary——压缩不能因为模型不听话就失败。
- **文件清单**由 `collectFiles()` 扫描 assistant 消息里的 `toolCalls` 得到，哪个工具
  算读、哪个算写由 `FileEffectMap` 声明。对编码 Agent 来说，"碰过哪些文件"是最不能
  在压缩中失真的信息，而这恰恰是模型总结时最容易出错的部分。同时出现在两边的文件
  只算"改过"。

`renderCompactionState()` 把它渲染成一条 user 消息，空的段落不出现。

## 7. 与 Provider 续写的交互

有些 Provider（如 DeepSeek 的 reasoning 续写）在服务端保留自己的历史：带 continuation
的请求会回放它们自己存的那份，而忽略请求里带的 messages。

如果压缩之后继续沿用 continuation，服务端会把刚刚被摘要替换掉的那段历史原样带回来，
压缩等于没做。因此：

```ts
if (context.compacted) {
  delete state.continuation;   // 一次压缩必须让续写作废
}
```

`BuiltContext.compacted` 这个字段存在的唯一理由就是它。

## 8. 复用已有摘要

压缩过一次之后，不应该每一轮都重新总结。`AppliedCompaction` 记下摘要本身和
`splitIndex`（在**完整 transcript** 中逐字历史重新开始的位置），下一轮直接拼：

```text
[摘要消息] + transcript.slice(splitIndex)
```

再次超预算时才会重新压缩，此时新的切分点要映射回完整 transcript：新的 `splitIndex`
是 `previous.splitIndex + (cut - 1)`，其中 `-1` 扣掉的是上一次注入在最前面的那条摘要
消息。这个映射是这一阶段最容易写错的地方，也是测试里"压缩后 transcript 仍然完整"
那条用例存在的原因。

## 9. CLI 与可观察性

| 选项 | 行为 |
| --- | --- |
| `--context-window N` | 设置总窗口（默认 128 000，最小 1 000） |
| `--no-compaction` | 不构造 Compactor，整份 transcript 原样发送 |

压缩发生时，通过 `onCompaction` 回调在 stderr 打印一行：

```text
Compacted 12 earlier messages (~131002 -> ~24518 tokens).
```

`--quiet` 时不打印。

## 10. 测试策略

`tests/context.test.ts`：

- 估算：随内容增长、计入工具调用参数、拒绝非法比例。
- 切分点：不拆散工具调用组、至少留一条消息、全部装得下时不切。
- ContextManager：装得下就直通、没有 compactor 就直通、超预算时用摘要替换旧历史、
  复用已有摘要而不重复总结、报告丢弃了多少、预留额度大于窗口时构造失败。
- Compactor：文件清单来自工具调用而非散文、读写皆有的文件算"改过"。
- `parseSummary`：标准 JSON、JSON 外有多余文字、完全没有 JSON 时的回退、忽略非字符串项。
- `renderCompactionState`：空段落不渲染。
- Agent 集成：压缩时丢弃 continuation、未压缩时保留 continuation、压缩后完整
  transcript 不受影响。

## 11. 验收标准

- [x] 超出预算的会话被自动压缩，而不是让请求失败。
- [x] 压缩不改动 transcript，`--continue` 恢复出来的仍是全量历史。
- [x] 摘要中的文件清单来自工具调用记录。
- [x] 一次压缩会使 Provider 续写作废。
- [x] 已有摘要在后续轮次被复用，不重复总结。
- [x] `--no-compaction` 与 `--context-window` 生效。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）的上下文管理章节与路线图已更新。

## 12. 不在本阶段

真实 tokenizer 与精确计费、Provider 上报的 usage 统计、按重要性而非时间的选择性
保留、把摘要写进会话文件以便跨进程复用、TUI 里的上下文占用指示。

下一阶段建议做 **写入的逐次确认与 undo 日志**：写入能力已经在了，但目前只有
"全开"和"全关"两档，缺少介于两者之间的、真正可用于日常的形态。
