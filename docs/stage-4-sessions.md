# Stage 4: Session、交互模式与 JSON 事件流

> 本文记录 `0.6.0` 的增量设计。Stage 3 让一次运行变得可观察、可中断，但每次运行
> 仍然是一次性的：问完即忘，追问要重复上下文。Stage 4 只解决"对话可以持续"这一
> 件事，不引入写入工具、上下文压缩或 TUI。

## 1. 目标

```text
User
  -> CLI（单次 / 交互 / JSON）
  -> AgentSession        transcript + 订阅者 + 会话日志
       -> Agent.run(prompt, { history, signal })
       -> AgentEvent -> Renderer / JSON Writer / SessionStore
```

完成后：

1. `chivgent` 不带问题时进入交互式会话，追问不需要重复上下文。
2. 会话以 JSON Lines 落盘，可以用 `--continue` 或 `--resume` 在新进程中恢复。
3. `--json` 输出机器可读的事件流，供脚本或其他前端消费。
4. 单次问答、管道输入和交互模式共用同一条 Agent 链路。

## 2. 设计原则

1. Agent 保持无状态：它接受 `history`，不持有跨轮次的对话。
2. Session 拥有三样东西：transcript、订阅者、可选的持久化日志。三者都不影响
   Agent Loop 的语义。
3. 持久化是便利设施，不是正确性依赖。写日志失败不会让一次运行失败。
4. 会话文件必须能从"写到一半"的状态恢复。
5. Session id 会变成文件路径，因此必须先校验再拼接。
6. CLI 的三种模式只是事件流的三种消费方式，不是三条独立链路。

## 3. AgentSession

```ts
class AgentSession {
  readonly id: string;
  readonly cwd: string;
  get messages(): readonly Message[];
  get turns(): number;
  get toolNames(): readonly string[];
  subscribe(listener: AgentEventListener): () => void;
  clear(): void;
  prompt(text: string, options?: { signal?: AbortSignal }): Promise<AgentRunResult>;
  header(): SessionHeader;
}
```

- `prompt()` 把当前 transcript 作为 `history` 传给 `Agent.run()`，运行结束后用
  返回的 `messages` 替换 transcript。中断和超限同样会更新 transcript。
- Session 是事件的唯一分发点：它构造 Agent 时占用 `onEvent`，再把事件转发给全部
  订阅者。某个订阅者抛异常不影响其他订阅者和这次运行。
- `clear()` 只清空 transcript，保留 id 和日志，对应 REPL 的 `/clear`。

## 4. 会话文件格式

`<CHIVGENT_HOME>/sessions/<id>.jsonl`，默认 `~/.chivgent`。每行一个 JSON 对象：

```text
{"type":"session","version":1,"id":"...","timestamp":"...","cwd":"..."}
{"type":"agent_start","prompt":"...","maxTurns":8}
{"type":"turn_start","turn":1}
...
{"type":"agent_end","status":"completed","turnCount":2,"messages":[...]}
```

设计选择：

- **不落 `message_update`**：增量可以从 `message_end` 还原，落盘会让文件随 token
  数量增长。
- **以最后一条 `agent_end` 的 `messages` 为准**：恢复逻辑因此天然容错，文件被
  截断只会退回到上一次完整运行。
- **无法解析的行被跳过**：进程被杀导致的半行不会毁掉整个会话。
- 写入按 session 串行排队，事件顺序与产生顺序一致；`prompt()` 返回前会 flush。

## 5. CLI 模式

| 调用 | 行为 |
| --- | --- |
| `chivgent "问题"` | 单次问答，记录为新 Session |
| `echo "问题" \| chivgent` | 同上，问题来自 stdin |
| `chivgent` | 交互式会话（stdin 必须是 TTY） |
| `chivgent --continue` | 恢复当前工作区最近的一次 Session |
| `chivgent --resume ID` | 恢复指定 Session |
| `chivgent --sessions` | 列出当前工作区的 Session |
| `chivgent --json` | 输出 JSON 事件流（首行为 session header） |
| `chivgent --no-session` | 不落盘 |

`--continue` 只匹配同一个 `cwd` 的会话：换项目不应该继承上一个项目的上下文。

## 6. 交互式 REPL

- 提示符 `› `，空行忽略。
- 斜杠命令：`/help`、`/session`、`/tools`、`/clear`、`/exit`（`/quit`）。
- Ctrl+C：正在回答时中断这次回答，会话继续；空闲时提示如何退出。
- Ctrl+D：离开。
- 一次只跑一个 prompt，避免并发运行共享同一份 transcript。

命令解析（`handleSlashCommand`）与 readline 循环分离，因此命令行为可以直接测试，
不需要伪造终端。

## 7. Provider 边界的必要修改

多轮会话让"首次请求"不再只包含 user 消息：第二次 prompt 的 `history` 里已经有
assistant 消息和 tool result。因此两个 Adapter 的初始请求构造都要能回放完整
transcript：

- Chat Completions：assistant 消息带 `tool_calls`，tool result 变成 `tool` 消息。
- Responses：assistant 文本、`function_call` 项和 `function_call_output` 项按
  transcript 顺序展开。

这是 Stage 1 "初始请求只允许 user 消息"这条简化的正式退场。

## 8. 测试策略

新增：

1. transcript 跨 prompt 传递，第二次请求包含前一轮的问答。
2. `clear()` 清空 transcript 但保留 id。
3. 多订阅者分发、订阅者抛异常隔离、取消订阅。
4. 日志包含 header 与运行事件，且不含 `message_update`。
5. 从日志恢复后继续提问，且不会写入第二个 header。
6. 列表按工作区过滤、按时间倒序。
7. 未知 Session、空目录、不可解析文件、非会话文件。
8. Session id 校验阻止路径逃逸。
9. 截断文件退回到上一次完整运行。
10. 斜杠命令的全部分支。
11. JSON 事件流首行是 header，末行是 `agent_end`。

## 9. 验收标准

- [x] 交互式会话可以连续追问，上下文不丢失。
- [x] `--continue` / `--resume` 能在新进程中恢复会话。
- [x] 会话文件可从截断状态恢复，且不包含增量事件。
- [x] `--json` 输出可被逐行解析，首行是 session header。
- [x] 管道输入、单次问答、交互模式共用同一条链路。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）功能、CLI、项目结构、安全模型和路线图已更新。
- [x] 版本提升到 `0.6.0`，CLI `--version` 与 `package.json` 一致。

## 10. 不在本阶段

Token / 成本统计、上下文预算与压缩、`write_file` / `edit_file` / Shell 工具、
权限确认与 Diff 预览、TUI、Provider Registry 与配置文件。

下一阶段建议先做 **上下文预算与压缩**：会话变长之后，最先撞到的是上下文窗口，
而不是工具能力。之后再进入需要威胁模型的写入阶段。
