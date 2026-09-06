# Stage 8: Shell 工具与流式子进程

> 目标版本：`0.10.0`
> 状态：已实现（2026-09-06）。本文先于实现写成，实现过程中修正的地方标注为
> **实现修正**。

> Stage 5 让 Agent 能改文件，但它改完之后无法验证：跑不了测试、跑不了 git、装不了
> 依赖。一个只会写代码不会运行代码的 Agent，每一次修改都是盲改。Stage 8 只解决
> "能执行命令并看到输出"这一件事，不引入扩展系统、TUI 或远程会话。

## 1. 目标

```text
Agent Loop
  -> bash ToolCall
       -> ShellOperations.exec()        可插拔：本地 spawn / 容器 / SSH
            -> spawn(detached)          独立进程组
            -> stdout/stderr chunk
                 -> OutputAccumulator   有界内存 + 超量落临时文件
                      -> tool_execution_update 事件（节流）
       -> ToolResult：尾部输出 + 退出码 + 完整输出路径
```

完成后：

1. `chivgent --allow-shell "跑一下测试，修掉失败的用例"` 能真正闭环。
2. 命令输出边跑边显示，不是跑完才出现。
3. Ctrl+C 能杀掉整棵进程树，不留下孤儿 `node`。
4. 超大输出不会撑爆内存，也不会淹没上下文；完整内容留在临时文件里供按需读取。

## 2. 权限模型：本阶段的路线调整

原路线图上排着「每次编辑的确认提示 + undo log」和「权限受控的 shell 工具」。本阶段
**放弃这两项**，改为对齐 pi 的模型，理由记录如下。

pi 明确不做内置权限系统：它以启动它的用户权限运行，需要边界就整体容器化
（micro-VM / Docker / 沙箱）。它真正设了闸门的地方是 **project trust**——按项目目录
记录一个信任决定，门控的是"这个仓库能不能把配置、扩展、skills、system prompt 注入
进 Agent"。也就是说，它认为需要用户确认的不是"你要改这个文件吗"，而是"你信任这个
仓库往你的 Agent 里塞代码吗"。

这个判断是对的，原因很直接：**一旦有了 shell，逐次确认和命令白名单都是纸糊的。**
`bash` 能做的事是 `write_file` 的超集，任何白名单都能被一行 `sh -c` 绕开；而对每条
命令都弹确认，实际使用中只会训练用户无脑按 y。把复杂度花在一个挡不住任何人的闸门
上，不如诚实地说明边界在哪。

因此 chivgent 的立场变成：

- **能力开关是会话级的粗粒度开关，不是逐次确认。** `--allow-shell` 与已有的
  `--allow-writes` 同级，默认关闭。
- **不做命令白名单、不做黑名单、不做逐条确认。**
- **真正的边界是容器。** README 的安全模型章节要照实改写。

有一条必须写清楚、不能含糊的推论：**`--allow-shell` 事实上蕴含写权限。**
`bash` 可以 `rm -rf`，Workspace 那套只读保证、路径越界检查、敏感文件屏蔽在它面前
全部失效。所以两个开关不能合并成一个，`--allow-shell` 也不能被 `--allow-writes`
顺带打开——它们是两个数量级的授权，必须让用户分别做出决定。

至于 project trust：它要门控的东西（项目级配置与扩展）在 Stage 9 才出现，所以推迟到
那一阶段和扩展系统一起做。

## 3. 设计原则

1. **执行后端可插拔。** 本地 `spawn` 只是 `ShellOperations` 的一个实现；容器和 SSH
   是后面的另一个。这一层抽象现在不用，但必须现在留。
2. **子进程独立成组，取消时杀整棵树。** 杀首进程会留下孙进程继续跑。
3. **输出是流，不是返回值。** 内存占用不能随输出长度线性增长。
4. **截断要有去处。** 被截掉的部分写进临时文件，把路径交给模型自己决定要不要读。
5. **失败也要带输出。** 非零退出码是错误，但错误信息里必须包含命令实际打印了什么——
   那才是模型修问题需要的东西。
6. **不做命令语义分析。** 不解析命令、不猜它想干什么、不拦截。

## 4. 工具契约

```jsonc
{ "command": "npm test", "timeout": 120 }
```

- `command`：交给 shell 的完整命令行，不做任何解析。
- `timeout`：可选，秒。**不设默认超时**——`npm ci` 和 `cargo build` 的合理耗时差两个
  数量级，猜一个默认值只会在长命令上误杀。取消由用户的 Ctrl+C 负责。

返回给模型的文本：

```text
<尾部输出>

[Showing lines 1841-2000 of 5537. Full output: /tmp/chivgent-bash-9f3a.log]
```

非零退出码作为 `isError: true` 返回，内容是`<输出>\n\nCommand exited with code 1`。

## 5. Shell 解析

| 顺序 | 条件 |
| --- | --- |
| 1 | `/bin/bash` 存在 |
| 2 | `which bash` 命中 |
| 3 | 回落 `sh` |

参数固定 `-c`。

**Windows 不在本阶段范围内。** pi 为此写了 Git Bash 路径探测、WSL 的
`bash.exe -s`（命令走 stdin 而非 argv）、外加一个独立的 `powershell` 工具，接近 200 行
只处理平台差异。chivgent 现在把它挡在门外：Windows 上 `--allow-shell` 直接报错并说明
用 WSL。这是一个明确的缺口，不是遗漏。

## 6. 进程生命周期

三件容易写错、必须照抄 pi 结论的事：

### 6.1 杀进程树

`spawn(..., { detached: true })` 让子进程成为新进程组的组长，取消时：

```ts
process.kill(-pid, "SIGKILL");   // 负 pid = 整个进程组
```

失败再回落到 `process.kill(pid)`。不这么做的后果很具体：`npm test` 的 node 主进程被
杀掉，vitest 的 worker 进程继续占着 CPU 和端口。

### 6.2 追踪 detached 子进程

detached 的子进程不会随父进程退出而死。因此每个 spawn 出来的 pid 都要登记进一个
集合，chivgent 自己收到 SIGINT/SIGTERM 时逐个杀掉，退出后不留残留。

### 6.3 不能在 `exit` 事件上直接收工

这是 pi 踩过的一个真实 bug（`earendil-works/pi#5303`）：短命的子进程可以先 `exit`，
而它 detach 出去的后代仍然持有 stdout 管道继续写。如果在 `exit` 之后按固定时限
destroy 掉流，这段输出就被静默丢掉了。

正确做法是 `exit` 之后**等管道安静下来**：起一个 grace 计时器（100ms 量级），
每收到一个 chunk 就重新计时。还在写的后代能一直把我们留住，而一个永远不会 `close`
的僵持句柄也能在 grace 之后放行。

## 7. 输出处理

### 7.1 OutputAccumulator

- 用**流式 UTF-8 解码器**（`decoder.decode(chunk, { stream: true })`）。多字节字符会
  跨 chunk 边界断开，逐块独立解码会产生乱码。
- 内存里只保留一段滚动尾巴（上限约 `maxBytes * 2`），不保留全量。
- 一旦判定会被截断，就开一个临时文件，把**原始字节**继续写进去。
- 提供 `snapshot()`，供流式事件和最终结果共用同一套截断逻辑。

### 7.2 截断策略

两个独立上限，先撞到哪个算哪个：**2000 行**或 **50 KB**。

方向和 `read_file` 相反：**shell 输出保留尾部**。测试失败的摘要、编译器的最后一条
错误、命令的退出信息都在末尾；读文件才是要开头。

**实现修正**：原计划让 `truncate` 模块同时提供 `truncateHead` 和 `truncateTail` 供
两边共用，实际只实现了 `truncateTail`。`read_file` 的截断是按行区间做的（`startLine`
+ `lineCount` + 续读提示），语义和字节/行数双上限不同，硬套过去只会让两边都变别扭。
`truncateHead` 会是没有调用者的死代码，等真有第二个消费者时再加。

### 7.3 二进制与控制字符清洗

命令可能吐出 ANSI 序列、控制字符、孤立代理项。落进 transcript 之前要过滤：保留
`\t` `\n` `\r`，去掉其余 `0x00-0x1F`、Unicode format 字符和孤立代理项。否则会话
JSONL 会被写坏，终端也会被控制序列搞乱。

## 8. 事件模型的扩展

chivgent 现在有 `message_update` 承载 LLM 的增量文本，但工具执行只有
`tool_execution_start` / `tool_execution_end` 两端，中间是黑盒。本阶段新增：

```ts
export interface ToolExecutionUpdateEvent {
  readonly type: "tool_execution_update";
  readonly turn: number;
  readonly toolCallId: string;
  readonly toolName: string;
  /** 当前的输出快照（已截断），不是增量。 */
  readonly content: string;
}
```

用快照而不是增量，是因为输出会被尾部截断——增量在截断语义下无法还原成正确的显示。
代价是事件体积，因此**必须节流**（100ms 量级），且与 `message_update` 一样不落盘：
会话文件只记录 `tool_execution_end`。

`ToolContext` 相应增加一个可选回调：

```ts
export interface ToolContext {
  readonly workspace: Workspace;
  readonly signal?: AbortSignal;
  /** 长时间运行的工具用它汇报进度；忽略它是合法的。 */
  readonly onUpdate?: (content: string) => void;
}
```

现有五个工具全部不受影响。

## 9. 对既有模块的影响

- **CLI**：新增 `--allow-shell`；`--help` 与 README 需说明它蕴含写权限。
- **system prompt**：追加 shell 守则——优先用专用工具（`list_files` / `search_text` /
  `read_file`）而不是 `ls` / `grep` / `cat`，长命令自己带 `timeout`，不要交互式命令
  （没有 stdin），不要后台任务。
- **maxTurns**：与写入同档，默认 16。
- **压缩（Stage 7）的一处已知失真**：`FileEffectMap` 只认识 `read_file` /
  `write_file` / `edit_file`，`sed -i` 改的文件不会进 `modifiedFiles`。本阶段不修，
  但要在文档里记下来——把 bash 命令解析成文件影响是猜测，比不记更糟。
- **上下文预算**：一条 50 KB 的输出约合 12 000 token，几条就能触发压缩。这是
  截断上限定在 50 KB 而不是更大的直接原因。

## 10. 测试策略

子进程测试必须用真实进程，`sh -c` 在 CI 上可用即可：

1. 命令成功：输出与退出码 0。
2. 非零退出：`isError` 为真，且内容里同时有输出和退出码。
3. 流式：`tool_execution_update` 在 `tool_execution_end` 之前至少到达一次，且节流生效。
4. 取消：abort 之后进程组被杀，工具抛出 `AbortError`，整次运行以 `aborted` 结束。
5. 超时：`timeout: 1` 配合 `sleep 5`，报超时且带已有输出。
6. 截断：输出超过行数上限时保留**尾部**，提示行里的路径确实存在且内容完整。
7. 多字节字符跨 chunk 边界不产生乱码。
8. 控制字符被清洗，`\t` `\n` 保留。
9. `--allow-shell` 未开时工具未注册。
10. Windows 平台上给出明确错误而不是静默失败。

第 4 项要验证的是"孙进程也死了"，用 `sh -c 'sleep 30 & echo $! > pidfile; wait'`
把孙进程的 pid 写出来，abort 之后轮询 `process.kill(pid, 0)` 直到它消失——只检查工具
返回是测不出这个 bug 的。

**实现修正**：这条测试被反向验证过。把 `killProcessTree` 改成只杀直接子进程
（`process.kill(pid)` 而不是 `process.kill(-pid)`）之后它确实失败，说明它测的是
进程组语义本身，而不是"工具有没有返回"。

## 11. 验收标准

- [x] `--allow-shell` 关闭时 `bash` 工具不存在；开启时命令可执行。
      （端到端验证过：不带开关时工具列表里没有 `bash`，system prompt 不提它，
      即使模型硬调也只会拿到 `Unknown tool: bash`。）
- [x] 取消一次运行会杀掉整棵进程树，不留孤儿进程。
- [x] chivgent 自身收到 SIGTERM/SIGHUP 或退出时清理所有 detached 子进程。
      （SIGINT 走既有的 abort 路径，由它触发进程组终止。）
- [x] 输出边跑边通过 `tool_execution_update` 呈现，且有节流。
- [x] 超量输出被尾部截断，完整内容落在临时文件且路径可用。
- [x] 内存占用不随输出长度线性增长。
- [x] 非零退出码返回错误但保留输出。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过（234 个测试）。
- [x] README（中英）的安全模型改写为"粗粒度开关 + 容器化"，路线图同步。
- [x] 版本提升到 `0.10.0`。

## 11.1 已知限制

实现之后仍然存在、并且是**有意接受**的几件事，记在这里以免下次当成 bug 重新发现：

1. **命令继承完整环境变量**，包括当前 Provider 的 API Key。模型可以
   `echo $OPENAI_API_KEY`。剥掉它是半个措施：其他 Provider 的 Key、以及环境里的
   任何别的凭据仍然在。与其给一个挡不住的假保证，不如照实说明——这与本阶段第 2 节
   的立场一致：边界是容器，不是过滤器。
2. **临时溢出文件不会自动删除。** 删了模型就读不到完整输出，而这正是它存在的理由。
   文件权限已收紧到 `0600`，但内容会一直留在临时目录里。
3. **压缩看不见 bash 改过的文件**（第 9 节已述），`sed -i` 不会进 `modifiedFiles`。
4. **Windows 不支持**，直接报错。
5. **没有后台任务**：命令跑完才返回，长命令要靠 `timeout` 或 Ctrl+C。

## 12. 不在本阶段

Windows / PowerShell 支持、容器与 SSH 后端的具体实现（只留接口）、project trust、
命令白名单与逐次确认（已明确放弃）、后台任务与作业控制、交互式命令的 stdin 转发、
把 bash 的文件影响并入压缩的文件清单。

下一阶段建议做 **扩展系统 + project trust**：pi 的立身之本是"self extensible"，
而扩展意味着从项目目录加载并执行代码——那正是 project trust 唯一真正需要它的地方。
