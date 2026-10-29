# Codex 框架研究与 chivgent 改进路线

研究日期：2026-10-29。chivgent 基线：`806f6c6fbc4de654a59011a0f35f24a104771257`。这是一份基于该固定提交的研究与实施建议，不是实时功能清单，也不是对模型效果的测量报告。

## 研究后的桌面进展

以下研究保留 `806f6c6` 的状态；准备本文时另对照主分支 `1c68b148f2c68d0302854a18e1c5589f1805bf83`。相对研究基线，桌面已有几项进展：

- [#150](https://github.com/chivopic/chivgent/pull/150) 接入文件写入的逐项审批及工作区写入模式，默认仍为只读；Shell 尚未接入。审批请求和决定须先保存，保存失败会拒绝文件变更；其他日志写入失败会中止当前运行，避免后续副作用。[桌面架构：审批与历史](desktop-architecture.md#8-历史恢复与-cli-兼容)
- [#148](https://github.com/chivopic/chivgent/pull/148) 提供工作区改动面板，展示已暂存、未暂存 diff 和受限的未跟踪文件预览，并过滤受保护路径；已有改动不归因为当前任务。[桌面架构：变更检查](desktop-architecture.md#10-变更检查与后续内核依赖)
- [#149](https://github.com/chivopic/chivgent/pull/149) 支持用户显式重新连接并恢复 host；恢复不自动重发运行或工具请求，也不恢复写权限或审批状态。[桌面架构：恢复规则](desktop-architecture.md#8-历史恢复与-cli-兼容)

这些进展不等于完整的桌面受控编码闭环已验证：Shell、实际测试执行和完整任务恢复仍需单独交付和验收。研究基线中的“当前”指 `806f6c6`，下列建议应先与上述进展核对，避免重复实现。

## 结论

Codex 值得学习的核心是完整的执行闭环：模型在有界工具和权限内行动；用户能看见、介入或取消；执行结果、会话与异常状态可恢复；最后能检查工作区和验证结果。这些机制必须穿过模型适配器、工具、持久化和界面一起成立，不能只复制提示词或界面。

chivgent 已有相当多的基础。当前最有价值的顺序是：先补持久化失败的可见性和中断结果语义，再为桌面打通受控修改与检查；并行设计运行中输入及受管长进程；随后按需求接入 Skills、MCP 和子 agent。以可复现评测贯穿全过程，避免凭功能数量或外观判断追平程度。具体优先级是工程判断，不是官方建议。

## 研究对象和证据边界

- [OpenAI Agents API 架构](https://developers.openai.com/api/docs/guides/agents-api/architecture) 将托管 Codex harness、执行环境、应用服务分开；harness 负责模型/工具循环和会话，环境负责命令与文件，应用负责发起任务、接收事件以及管理自托管环境。它描述的是 Agents API 的托管架构，不可直接推断桌面或 CLI 的所有内部实现。
- [Agents API 概览](https://developers.openai.com/api/docs/guides/agents-api/overview) 公开列出压缩、运行中 steering、MCP、Skills、子 agent 与恢复等能力；各入口的配置和可用性可能不同。
- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security) 将沙箱限制与审批策略分成两层。把网络、工作区和外部服务副作用都视为同一种开关，会丢失关键的授权边界。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) 用 thread、turn、item 与双向请求/事件组织客户端交互；其 WebSocket 传输标为实验性。借鉴状态语义不意味着照搬其协议或保证兼容。
- [Build skills](https://learn.chatgpt.com/docs/build-skills) 说明初始只暴露名称、描述和路径，选择后才读取正文；初始清单有上下文预算。 [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) 则描述隔离委派、收敛结果和并行写冲突，具体支持随客户端而异。
- 之前的 [2026-10-15 差距审计](codex-parity-audit-2026-10-15.md) 有固定提交的上游源码阅读地图。那份审计是历史快照；本报告核对所列研究基线，不把其中的功能状态自动当成今天的状态。公开文档及代码不能证明模型权重、训练方式或托管服务的全部内部细节。

## 研究基线的基础：不要重复建设

| 能力 | 当前证据 | 具体边界 |
| --- | --- | --- |
| agent 循环与事件 | [agent.ts](../src/agent.ts)、[architecture.md](architecture.md#runtime-events) | 有流式事件、取消、工具调用与配对修复；只读工具并发有写入屏障。OpenAI adapter 仍设置 `parallel_tool_calls: false`，不能因此宣称其真实请求会并发读取。 |
| 权限和执行 | [shell-sandbox.md](shell-sandbox.md)、[permissions.ts](../src/permissions.ts) | macOS Seatbelt / Docker、无不安全回退、网络/host 范围和审批已存在；权限模式不随会话恢复。用户启动入口的默认值有区别，应以文档及实际启动路径为准。 |
| 上下文和恢复 | [architecture.md](architecture.md#context-management)、[session-store.ts](../src/session-store.ts) | 已有预算、保留工具调用配对、持久压缩检查点与完整 transcript；估算按字符而非模型 tokenizer。最后一次 `agent_end` 是恢复的消息快照，进行中事件不构成完整恢复。 |
| 计划与提问 | [architecture.md](architecture.md#structured-questions)、[agent.ts](../src/agent.ts) | Plan Mode 限制工具；本地 REPL/TUI 能收集结构化回答。Desktop、remote 和 headless 当前没有对应的提问呈现通道。 |
| 终端结果与审查 | [shell-sandbox.md](shell-sandbox.md)、[tui/review.ts](../src/tui/review.ts) | 截断 shell 输出有会话内受限读取；TUI review 是 diff 浏览，不等于模型审查。shell 命令没有 stdin，等待执行结束才返回。 |
| 桌面与远程 | [desktop-architecture.md](desktop-architecture.md)、[extensions-and-remote.md](extensions-and-remote.md) | 在研究基线时 Desktop 已有真实只读运行和单项目历史恢复；写入/Shell 审批与检查闭环仍待做。主分支后续进展见上文。remote 协议已有版本号，但客户端消息仅 hello、prompt、interrupt。 |
| 扩展与评测 | [extensions-and-remote.md](extensions-and-remote.md)、[eval-baseline-guide.md](eval-baseline-guide.md) | 进程内 JS 扩展是受信任代码，不等于 MCP 或声明式 Skills；已有十个任务的 eval、隔离 fixture 和 suite 指纹，但没有 Codex 对照执行器。 |

## 值得复刻的机制与工作项

### 1. 有副作用时的可恢复性和可见性：优先

**触发与现状。** 一轮工具执行完成以前进程异常退出，恢复采用最后一次 `agent_end` 的消息快照；文件可能已经改变，但恢复上下文不一定记录这次行动。[session-store.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/session-store.ts#L204) 写明该策略；[session.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/session.ts#L282) 现有普通事件记录与 flush 会吞掉持久化错误。正常取消与进程强制退出是不同路径。Desktop 已有未完成工具显示 unknown 的独立历史语义，但不能据此宣称 CLI 也能回放进行中的工具。

**建议拆分。** 首先独立交付保存失败可见性：在保持当前运行结果与安全策略的前提下，向用户明确指出历史可能不完整；故障解除后的状态和重复提示规则需定义。随后再设计版本化 run/item 记录、开始和结果的稳定关联及恢复投影。出现“执行已开始但无可信结果”时展示 unknown，提示检查工作区；绝不自动重放写入或 shell。权限始终按本次进程配置重新建立。

**验收。** 使用临时会话目录和故障注入，覆盖 append/flush 失败、截断尾行、写成功后结果尚未持久化时的中断、重复恢复和旧格式兼容；旧代码必须使针对可见性的测试失败。历史缺失不能伪装成工具失败或成功。详细故障点、事件落盘时序及是否需要写前门控属于后续设计，不应由一条泛化重构直接决定。

### 2. Desktop 受控编码闭环

在 `806f6c6` 研究基线时 Desktop 的真实运行是只读；目标用户旅程是“选择项目 → 发起修改 → 审批 → 执行/测试 → 查看工作区 diff → 重启后理解结果”。文件审批、保存失败门控和工作区检查已有上文所列进展，后续依照 [Desktop 架构第 8–11 节](desktop-architecture.md#8-历史恢复与-cli-兼容) 补足 Shell 和端到端验证；已有用户改动不可误标为本轮 agent 改动。取消、拒绝、断开及过期审批都不能执行。Renderer 只在密码输入框中短暂持有新输入，host 保存桌面 Provider 配置，状态读取不返回已保存的 key。

验收应包含 fake provider、临时项目与无 GUI 单元/集成测试，并在适当的 CI 环境测试真实 UI。项目约束禁止默认在共享桌面启动可见 GUI；现有 [LESSONS.md](../LESSONS.md) 记录了原因。该路径是现有桌面路线的延续，不应一次混入 worktree、云服务和插件市场。

桌面结构化提问也是可独立交付的小切片：复用 [questions.ts](../src/questions.ts) 的请求绑定和验证，增加 host 到 UI 的请求/回复，验证过期回复、取消及断线，回答只表达需求，不授予权限。

### 3. 运行中纠偏与交互协议

[session.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/session.ts#L214) 在运行时拒绝另一条 prompt；[remote/protocol.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/remote/protocol.ts#L27) 目前没有 steering 或回复请求。用户在运行中追加“不要改数据库”时，应该能区分**尽快交给当前运行**和**排队下一轮**，而不是静默丢弃。

先定义接受时点、顺序与安全边界：已启动的工具不能被事后撤销；在后续模型请求和下一次工具调度前纳入已确认的输入；取消与最终输出竞态必须有确定结果。客户端应显示已接收、已应用或未应用。先以单会话与 fake provider 验证，再考虑扩展 remote 的请求 ID、事件游标、快照和审批/提问的唯一应答；不要把注入文本当作权限提升或审批。

### 4. 受管长进程和交互

[ShellOperations](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/shell/types.ts#L28) 是一次调用返回退出状态；[BashTool](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/tools/bash.ts#L19) 明确无 stdin。服务启动、日志观察和交互式测试因此无法形成稳定闭环。

建议设计会话拥有的进程管理器：有界并发、不可猜测的句柄、初次等待后返回、增量读取、按需 stdin、退出码、超时、取消和退出清理。是否支持 PTY 是独立能力，应按平台测试；不要假设所有后端都支持。每个进程继承其启动时批准的范围，后续读/写操作不能借句柄扩大权限；不把句柄当成文件路径，也不跨重启假装继续存在。先用本地 fake 进程测试长输出、竞态、子进程清理和权限拒绝，再覆盖 macOS / Docker 对应真实后端。

### 5. Skills、MCP 与工具规模

Skills 首批可限定为本地声明式指令：发现元数据、明确作用域与优先级、显式调用、按需读取正文，记录来源及取消行为；skill 文本和资源不会自动获得 shell 或文件写权限。MCP 是独立协议与生命周期问题，不应通过执行任意项目 JS 扩展来冒充。初期选择一种传输并定义工具发现、超时、取消、断连和结果大小限制；涉及外部副作用时走明确的授权策略。之后再根据工具数与 token 数据评估按需发现，不先假设复杂的工具搜索一定更快。

验收需使用本地临时 skill 和 fake MCP server；覆盖名称冲突、恶意/超大内容、取消、断连与不可信工具输出，禁止未经授权执行 skill 中的脚本。是否支持远程访问、认证、资源和提示模板应分别标明，而不是宣称完整 MCP 支持。

### 6. 多 agent 与真正的代码 review

多 agent 依赖前面的生命周期、取消和事件模型，建议先交付只读研究子任务：独立上下文、父子关系、并发/预算上限、结果回流及父任务取消清理；权限不得超过父任务，失败和超时有明确状态。共享工作区的并发写入及 worktree 是后续独立设计，不能把消息隔离误认为文件隔离。

模型 review 单独实现：用户指定工作区、base 或 commit 等目标，使用只读运行，输出可定位的发现及证据；review 结果是模型判断而非测试证明。用已植入回归的固定 fixture 测定位、漏报和误报，并测审查不改工作树。现有 diff 浏览仍作为独立能力保留。

### 7. 搜索把未知结果报告成无匹配：先复现的小修候选

[workspace/search.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/workspace/search.ts#L159) 捕获目录 `readdir` 的错误后直接继续，没有标记该目录未被搜索；[search-text.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/tools/search-text.ts#L65) 在无匹配时显示 `No matches found`，只展示文件跳过数。因此，当某个目录无法读取且其他已扫描位置没有匹配时，输出可能让模型把部分搜索误当成完整搜索。这是静态路径分析，尚未做失败注入复现。

单独工作项可先写四行行为说明，并用临时目录和可控读取失败复现：一处目录报错、另一处仍可搜索时，应保留已有匹配，同时显式表明结果不完整；起始目录失败和子目录失败也须分别定义。不改变忽略规则、工作区边界和输出上限。新测试先在旧实现上因缺少不完整提示而失败；再确定错误计数或结构化状态的兼容方式，并更新拥有搜索行为的契约。该问题对应 [code standards](code-standards.md) 的“失败读取是未知”，无需为它先实现 Codex 的复杂功能。

### 8. 按证据优化现有路径

- **并发读取：** [openai.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/providers/openai.ts#L105) 当前关闭 provider 并发，而 [agent.ts](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/src/agent.ts#L430) 有保守调度器。仅在能力声明和供应商请求契约确认后实验，保留精确内建只读工具名单和写入屏障；不能全局允许未知扩展并发。
- **上下文预算：** 按中文、代码、工具 schema、长结果和多轮压缩构造任务，测估算误差、溢出及保留约束；再比较模型感知估算或自适应余量。当前尚无证据证明某种 tokenizer 改动会提升任务成功率。
- **搜索和会话规模：** 有界字面搜索可针对真实大仓库测检索成功率、耗时、返回量，再决定是否增加安全的正则/文件过滤。会话保存快照与列表读取可能随历史增长产生额外成本，这是代码结构推断，需要基准后再决定索引和格式迁移。

Desktop 还有一个具体的长会话限制：[host service](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/apps/desktop/src/host/service.ts#L154) 为请求去重保留已接受 ID，达到 [100 个](https://github.com/chivopic/chivgent/blob/806f6c6fbc4de654a59011a0f35f24a104771257/apps/desktop/src/protocol/messages.ts#L16) 后拒绝新请求并要求重启。后续处理须同时定义去重生命周期和崩溃后副作用未知；简单淘汰旧 ID 可能让重复请求再次执行。

## 实施依赖与可交付顺序

| 批次 | 最小独立交付 | 出口条件 |
| --- | --- | --- |
| 0 | 搜索不完整提示、保存失败可见、评测基线说明，各自独立交付 | 错误注入能观测；既有恢复/权限语义不变；无真实账号或网络测试 |
| 1 | 中断状态与桌面受控修改分步交付 | 已开始但结果未知的操作不会自动重放；审批拒绝无副作用；可检查工作区改动 |
| 2 | 运行中输入；受管进程分开实现 | 纠偏在定义的边界生效；长进程可观察、输入、取消和清理；后端权限保持一致 |
| 3 | 本地 Skills、最小 MCP 各自交付 | 按需加载和隔离故障可测；外部调用权限清晰 |
| 4 | 只读子 agent、模型 review、协议扩展分别交付 | 父取消有界清理；审查不写入；客户端重连能识别状态与过期请求 |

这是一组候选独立变更，不是一项大 PR。各项动手前按 [issue workflow](issue-workflow.md) 写明触发、当前行为、目标、可失败测试、完整运行路径及受影响契约。保留只读默认、失败关闭、进程本地权限和信号处理等现有产品决策；如确需改变，交由维护者决定。

## 对照评测：先建立事实，再谈收益

现有 [baseline guide](eval-baseline-guide.md) 提供 suite 和 prompt 指纹、fresh fixture、次数、用量及缺失值语义。它还明确：当前 eval 的 `--allow-shell` 在评测阶段是宿主机执行，必须在一次性隔离环境运行；CI 的 dry-run 不调用模型，不能代表任务通过率。

新增独立基准集，保留旧十题便于纵向比较：跨文件修复及真实测试、长会话约束与压缩、服务启动/日志/终止、运行中纠偏、异常退出恢复、已有未提交修改、拒绝审批、MCP 断连、子任务取消、审查定位。每题定义初始仓库、输入、允许能力、终态 grader 和副作用检查；将 deterministic 回归与付费模型 eval 分开。报告任务成功及分母、每题轨迹、未经授权的副作用、人工干预次数、token（未知保持未知）、耗时与失败类型。

Codex 对照需要独立执行适配器和等价权限/环境：固定仓库初态、任务、模型与版本、允许网络/文件/命令、尝试次数，并记录每方不可统一的工具、系统提示和沙箱差异。使用 fresh fixture，至少 5–10 次作探索性信号；小样本不支持显著性结论。若模型不同，报告的是产品组合差异，不能归因于 harness。保留原始报告和失败轨迹；不要拿不同任务集或权限配置的结果比较。

## 本次验证与未覆盖范围

本研究检查了所列研究基线的仓库源码、契约文档与 OpenAI 官方文档，未修改运行时代码，未运行完整构建/测试、Codex 上游或真实模型评测，也未测 GUI、跨平台沙箱或实际性能。建议是基于静态证据的设计方向，收益和默认行为必须在实现及验证中重新确认。
