# Stage 5: Context 预算与压缩

> 本文记录 `0.7.0` 的增量设计。Stage 4 让对话可以持续，但也带来了一个必然的
> 结局：transcript 只增不减。`read_file` 单次可以返回 48 KiB，几轮之后请求就会
> 超过模型的输入窗口，而失败形态是 Provider 返回一个用户无法处理的 400。
> Stage 5 只解决"对话能一直进行下去"这一件事，不引入写入工具或 TUI。

## 1. 目标

```text
Agent Loop
  每轮请求之前
    -> ContextManager.status()     估算这次请求要花多少 token
    -> 超预算？
         -> compaction_start
         -> 摘要更早的轮次 / 裁剪陈旧的 tool result / 丢弃最老的消息
         -> compaction_end
    -> LLMClient
```

完成后：

1. 长会话不会因为撞上输入窗口而失败。
2. 用户随时能看到上下文占用和真实的 token 消耗。
3. 压缩过程是可观察的事件，不是静默的魔法。

## 2. 设计原则

1. 估算宁可偏大。提前压缩只是多花一次摘要调用；请求超窗则整轮直接失败。
2. 压缩发生在**请求组装之前**，位置在 Agent Loop 里，因此单轮内工具结果撑爆
   上下文和跨轮次累积两种情况都能覆盖。
3. 压缩改写了历史，所以必须丢弃 Provider continuation：下一次请求要从压缩后的
   transcript 重建，而不是让 Provider 接着它自己那份历史继续。
4. 每一步的产物都必须是 Provider 会接受的消息序列：以 user 消息开头，且任何
   tool result 都不与调用它的 assistant 消息分离。
5. 压缩失败不能让运行失败。摘要调用出错就退回确定性摘要（digest）。
6. token 用量只报告 Provider 给的真实数字，绝不把估算值伪装成用量。

## 3. Token 记账

`src/tokens.ts` 不引入 tokenizer 依赖：

- 拉丁文本按约 4 字符 1 token，CJK 等宽字符按 1 字符 1 token。
- 每条消息加固定信封开销，assistant 的 tool call 名称与参数单独计入。
- 工具 schema 每轮都会发送，因此计入请求估算。

`LLMResponse.usage` 是另一条线：来自 Provider 的 `usage` 字段（Responses 的
`input_tokens`/`output_tokens`，Chat Completions 的 `prompt_tokens`/
`completion_tokens`）。Chat Completions 流式必须显式传
`stream_options: { include_usage: true }`，否则最后一个 chunk 不带 usage。

估算用于**决策**（要不要压缩），真实 usage 用于**报告**（`/context` 显示）。
两者不混用。

## 4. 压缩流水线

预算为 `maxInputTokens × compactAtRatio`（默认 0.8）。超出后依次执行，每步之后
重新估算，够了就停：

1. **摘要更早的轮次**。保留最近 N 个 user prompt（默认 2）及其之后的全部内容，
   更早的部分交给模型压成一条消息，前缀 `[earlier conversation summary]`。
   边界一定落在 user 消息上，因此不会把 tool result 与其 assistant 消息切开。
2. **裁剪陈旧的 tool result**，从最老的开始，截断并标注。
3. **丢弃最老的消息**，最后手段。

两条消息被钉住，永远不丢：最后一个 user prompt（否则模型看不到问题），以及
开头的摘要消息（它是 transcript 里信息密度最高的一条，丢掉等于白做第 1 步）。

摘要用同一个 Provider、独立的 system prompt、**不带任何工具**，因此摘要调用不
可能反过来修改它正在摘要的 transcript。摘要 prompt 明确要求把 transcript 当作
待压缩的数据，而不是待执行的指令。

摘要不可用时（Provider 报错、返回空、或根本没配置 summariser）退回 digest：
列出早期问题和用过的工具。事件里 `degraded: true` 会如实标出这一点。

## 5. 事件

```text
compaction_start  turn, estimatedTokens, budgetTokens
compaction_end    turn, beforeTokens, afterTokens,
                  summarisedMessages, shrunkToolResults, droppedMessages,
                  degraded
```

`turn: 0` 表示这次压缩发生在运行之外（REPL 的 `/compact`）。

会话日志会记录这两个事件，因此事后可以看出一次会话在哪里、丢掉了什么。

## 6. 用户界面

- `--context-window N`：输入 token 预算，默认 100000（对小窗口保守，而不是对大
  窗口慷慨）。
- `--no-compact`：完全关闭压缩。
- `/context`：显示估算占用、预算阈值和本次会话的真实 token 用量。
- `/compact`：立即压缩，不管是否超预算。
- stderr 显示压缩过程：`· compacting context (9.8k > 8.0k budget)` 和
  `  ↳ 9.8k → 3.2k, 6 messages summarised, 2 tool results trimmed`。

## 7. 已知边界

单个 prompt 加上一次巨大的 tool result 可能无法压到预算以内：唯一的 prompt 不能
摘要，tool result 裁剪也有下限。这时压缩会尽力而为并如实报告，运行继续，而不是
被阻断——工具输出本身已有 64 KiB 上限，这个组合不会无限膨胀。

`--context-window` 是用户给的数字，不是从模型查到的。Provider 的模型元数据、
按模型自动推断窗口，留给后续的 Provider Registry 阶段。

## 8. 测试策略

新增：

1. token 估算：空串、拉丁、CJK、混排、消息信封、tool call、工具 schema、整个请求。
2. 估算不低估长文本（压缩早比超窗好）。
3. usage 累加，缺失 usage 不影响累计。
4. 预算状态：阈值计算、超预算判定、非法窗口被拒。
5. 压缩：不超预算不动；`force` 强制压缩。
6. 摘要折叠更早轮次，保留最近 prompt，产物以 user 消息开头。
7. 产物序列合法：每个 tool result 之前仍有带 tool call 的 assistant 消息。
8. 裁剪路径、丢弃路径分别被单独触发。
9. 丢弃时摘要被保留。
10. 摘要报错 / 返回空 / 未配置时退回 digest 并标记 degraded。
11. 系统 prompt 与工具 schema 计入预算，不只算消息。
12. Agent Loop 内：超预算触发压缩；压缩后 continuation 被丢弃；未压缩时
    continuation 保留；不超预算不触发。
13. Session：context 状态、跨 prompt 的 usage 累计、`/compact` 事件。
14. REPL：`/context` 的两种形态、`/compact` 交给循环执行、`/help` 覆盖。
15. 渲染：压缩两行输出、degraded 提示、`--quiet` 隐藏、强制压缩不谎称超预算、
    空压缩显示 "nothing to compact"。

全部使用脚本化的假 Provider，不消耗额度。

## 9. 验收标准

- [x] 长会话在小窗口下能持续运行，不会因为超窗失败。
- [x] 压缩后 Provider continuation 被丢弃，请求从压缩后的 transcript 重建。
- [x] 压缩产物始终是 Provider 接受的消息序列。
- [x] 摘要不可用时退回 digest，运行不中断。
- [x] `/context` 显示估算占用与 Provider 真实用量。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）功能、CLI、架构、项目结构和路线图已更新。
- [x] 版本提升到 `0.7.0`，CLI `--version` 与 `package.json` 一致。

## 10. 不在本阶段

`write_file` / `edit_file` / Shell 工具、权限确认与 Diff 预览、TUI、
Provider Registry 与配置文件、按模型自动推断上下文窗口、成本（金额）统计。

下一阶段是写入能力，需要先写威胁模型。
