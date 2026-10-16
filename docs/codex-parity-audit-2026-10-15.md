# Codex CLI 设计对照与复刻路线

审查日期：2026-10-15。目标：以 Codex CLI 的真实工作能力为参照，演进 chivgent 的 agent runtime、工具、会话和交互。

## 对照基线与结论

- chivgent：`4d34a88b3bfe760e8c4b3f78c184931ee45e751c`，package 版本 `1.0.1`。
- OpenAI 官方 `openai/codex`：`3ee47c10513f1bb57d869ea650aba28638e3d11c`，提交时间 2026-10-15 12:56:39 UTC。对照的是 main 的固定源码快照，不代表所有能力都已稳定发布、默认启用或对每种模型可用。
- 方法：阅读两端关键实现、检查本地工具/参数/协议注册点、核对官方 CLI 文档、运行本地离线测试。没有运行付费模型 A/B，因此不提供“达到 Codex 百分之多少”的数字。
- 官方能力入口：[Codex CLI](https://developers.openai.com/codex/cli/features)。以下上游链接固定到提交，避免 main 漂移。

**结论：已有小型 coding agent 的主要骨架，但距离 Codex 的持续工作能力还有明显差距。优先补执行环境、可交互的运行生命周期和可恢复的上下文，再扩大工具生态。继续仅优化 TUI 或增加提示词，无法跨过这些运行时限制。**

当前 README 仍将产品定位为“小而可读的参考实现”，并明确不追求最强日常 agent、细粒度权限和原生 Windows shell。新的复刻目标应调整这一取舍，但不需要因此重写成 Rust 或照搬所有产品模块。

## 已有基础：应保留、扩展

| 能力 | 现有实现 | 评价 |
| --- | --- | --- |
| Agent / Session / Provider 分层 | `src/agent.ts`、`session.ts`、`providers/` | 可继续演进；无需推倒重来 |
| 流式输出、取消、工具错误反馈、调用配对修复 | `agent.ts`、`events.ts`、Provider adapters | 已有实质能力 |
| 文件发现、搜索、读取、精确编辑、多文件 patch | `src/workspace/`、`src/tools/` | 已有；工具协议与 Codex 不完全一致 |
| Scoped AGENTS.md 与 override | `context/project-instructions.ts` | 已有目录范围与写前发现；还缺完整全局/配置层衔接 |
| 长上下文摘要与读写文件状态 | `context/context-manager.ts`、`compaction.ts` | 已有；生命周期与预算仍有限 |
| 并行只读工具 | `tools/parallel.ts`、`agent.ts` | 已有最多 4 路及写操作屏障；Provider 配置仍限制实际触发 |
| JSONL 会话、resume、continue、JSON 事件 | `session-store.ts`、`cli-options.ts` | 已有，不能列成“没有持久化/没有 headless” |
| 计划、TUI 编辑器、diff 浏览、模型切换 | `tools/update-plan.ts`、`tui/`、`repl.ts` | 已有；计划展示不等于 Plan Mode |
| 扩展与远程连接 | `extensions/`、`remote/` | 已有自定义协议与进程内 JS 扩展；不等同 MCP 或 app-server |
| 自动测试与模型评测框架 | `tests/`、`evals/`、`src/evals/` | 应作为后续复刻的回归基础 |

## 差距与优先级

P0：影响真实项目任务的完成闭环。P1：影响长任务、扩展与协作。P2：进一步完善产品和部署覆盖。排序是本次工程判断，不是 Codex 官方建议。

| 优先级 | 能力 | chivgent 当前状态 | 建议复刻的机制与验收 |
| --- | --- | --- | --- |
| P0 | 本机工具链与权限系统 | shell 固定使用离线 Docker、新容器、默认 Alpine；权限是开关和逐条确认 | 拆分文件权限、网络策略、审批策略、执行后端。先实现 macOS 原生隔离后端，保留 Docker。验收：能使用项目所需工具链，越界请求经过审批，拒绝后无副作用 |
| P0 | 持久进程与交互终端 | `bash` 无 stdin，等待退出才返回，提示词禁止后台服务 | `exec_command` / `write_stdin`、process ID、yield、PTY、增量输出、退出和取消管理。验收：启动服务后能继续读取/编辑，再查询日志、输入并停止进程 |
| P0 | 运行中 steering / queue | Session 拒绝并发 prompt；remote 返回 busy；TUI 执行时置 busy | 显式 turn 状态、输入队列、当前 turn 注入与下轮排队，处理 interrupt 竞态。验收：运行中“先别改数据库”能在下一个安全边界生效 |
| P0 | 压缩状态跨 prompt / resume 保留 | **本批已完成核心项**：Session 持有并恢复 checkpoint；仍未实现进行中 item 事件回放 | Session 持有有效上下文、压缩检查点和预算，持久化恢复；审计日志和发给模型的窗口分离。验收：压缩后多次追问与重启，不重复总结同一历史，不丢约束 |
| P0 | 完整请求预算 | **本批已完成核心项**：计入 system prompt、tool schemas、项目指导与历史；字符数估算并对不可容纳请求报错 | 为 Provider 构造完整请求预算、保留输出空间、处理 context overflow；模型窗口参数可配置。验收：中文、大工具 schema 和大输出场景仍能继续 |
| P0 | 崩溃后的进行中恢复 | 日志有中间事件，但恢复只采用最后 `agent_end.messages`；保存错误被吞掉 | 可回放 item/turn、稳定 ID、检查点、保存异常可见；中断工具结果显式未知，禁止自动重放副作用。验收：工具改文件后进程崩溃，恢复能知道已发生的修改 |
| P1 | 类型化消息与模型能力 | user/assistant/tool 的 content 都是 string；流式回调只有 text delta | 增加 text/image/tool result 等内容项、commentary/final phase、模型能力声明和 reasoning 参数；保留 Provider 所需不透明状态。验收：截图输入和文字输入可共存，进度与最终答案可区分 |
| P1 | 模型协议与并行能力 | OpenAI `parallel_tool_calls: false`；核心却支持并行读取 | 按模型能力启用并行，并保留调度器的写屏障；不应直接全局打开。验收：实际 Responses 请求支持同轮多读取，写调用不与读产生竞态 |
| P1 | Skills | 有 AGENTS.md 和 JS extensions，无 SKILL.md 系统 | 元数据发现、作用域/优先级、显式调用、按需正文加载和相关资源访问。验收：可用一个本地 skill 完成重复工作，未调用技能不占完整上下文 |
| P1 | MCP 与工具按需加载 | 工具来自内置和进程内扩展；每次发送完整工具定义 | MCP stdio / streamable HTTP、能力发现、认证、超时取消、资源、结构化结果；再加 tool search/deferred loading。验收：服务掉线可恢复，海量工具不全塞进 prompt |
| P1 | Plan Mode 与结构化提问 | `update_plan` 只更新清单；没有澄清工具 | 单独模式、模式提示词、提问请求/响应、取消与等待语义；授权由权限层决定。验收：计划阶段可读库调研、提出选项，接受计划后继续实现 |
| P1 | 真正的代码 review | `/review` 展示 patch；`/gitdiff` 展示 Git diff | 专用审查任务、base/commit/dirty target、review prompt、文件行号和严重级别的 findings。验收：植入回归能被定位，审查不改工作树 |
| P1 | 可供多个客户端使用的服务协议 | Unix socket，只有 hello / prompt / interrupt | thread/turn/item 模型、请求 ID、双向审批/提问、历史读取、订阅恢复、版本协商；可选 JSON-RPC 与 schema 生成。验收：客户端重连后重建状态，审批不丢失 |
| P1 | 子 agent | 只有读工具并行，无独立子会话调度 | spawn/send/wait/interrupt、隔离上下文、预算和并发限制、父子权限继承、结果回流。验收：两个研究子任务独立进行，父任务取消后清理完整 |
| P1 | 分层配置和可解释配置 | 主要 CLI flags + env；auth/trust 等独立文件 | 全局/项目/运行参数优先级、profile、schema 校验、来源展示；统一持久设置。验收：能解释某条权限/模型设置来自哪里 |
| P2 | 会话管理与索引 | list 扫描解析日志；没有显式 fork / archive / search | fork、搜索、归档、索引、迁移；历史回退与工作树回滚必须分开定义 |
| P2 | Web 与视觉工具 | 无内置 web search / view_image；消息模型也限制视觉输入 | 在类型化内容和工具扩展后实现；搜索通过有权限的后端，不能假设任意 Provider 都支持内置搜索 |
| P2 | Headless 输出契约 | 已有一次性运行、stdin、JSONL、退出码 | JSON Schema 约束最终答案、稳定事件版本、最后答案文件、可自动化 review |
| P2 | Hooks / 插件分发 / 凭据 | 扩展只有工具、命令、事件订阅、system prompt；API key 文件 | 增加可等待的生命周期 hook、超时/失败语义、插件清单和安装更新；按需要支持 OAuth / keychain |
| P2 | 跨平台与诊断 | 原生 Windows shell 不在现有支持目标内 | Linux/Windows 隔离后端、诊断命令、可控遥测、TUI 可访问性与兼容性 |

## 需要先修正的实现细节

1. **并行读取“已支持”不代表 OpenAI 路径已使用。** `src/providers/openai.ts:97` 显式关闭并行。`src/tools/parallel.ts` 仅接受三个精确内置类，扩展工具不能加入；后者是当前保守安全设计，不能仅按工具名放开。
2. **压缩状态生命期过短。** 本批已让 Session 传递和保存 compaction checkpoint；checkpoint 以 transcript SHA-256 绑定，损坏或不匹配时忽略 checkpoint 并保留完整 transcript。进行中事件回放仍未实现。
3. **请求预算漏项。** 本批已将 system prompt、tool schemas、项目指导和历史纳入近似预算；tokenizer 仍是字符估算，估算不等同 Provider 精确计数。
4. **崩溃恢复与磁盘状态可能脱节。** `src/session-store.ts:187` 明确以最后 agent_end 为准；已落盘的 tool_execution_end 没参与 transcript 重建。正常 Abort 有结束事件与配对修复，强制结束进程则是另一个场景。
5. **恢复没有恢复全部会话语义。** 本批已恢复 usageTotal、promptCount 和压缩 checkpoint；不透明 Provider continuation 不持久化，进行中工具 item 回放也未实现。
6. **开 shell 同时给予挂载目录写能力。** Docker 根文件系统 read-only，但 workspace bind mount 是可写的；因此 `--allow-writes` 不是 shell 写入的统一开关。README 已说明这点，但要复刻 Codex 权限语义就必须收敛到同一策略层。
7. **名称相似的功能必须重新定义验收。** `/review` 是浏览器；update_plan 是进度工具；remote 是单会话广播协议；extensions 是可信 JS。不能把这些分别计为模型 review、Plan Mode、app-server 或 MCP/Skills 完成。

## 上游源码阅读地图

以下链接指向本次实际核对的官方快照。读取模块存在与接口只能证明该快照含有实现，不能证明默认启用或性能。

| 机制 | Codex 源码 |
| --- | --- |
| 交互进程与输出预算 | [core/src/unified_exec/mod.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/unified_exec/mod.rs) |
| 审批、隔离后端与重试编排 | [core/src/tools/orchestrator.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/tools/orchestrator.rs) |
| 运行中输入与竞态测试 | [session/turn_input.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/session/turn_input.rs)、[turn_input_tests.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/session/turn_input_tests.rs) |
| 结构化内容与消息阶段 | [protocol/src/models.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/protocol/src/models.rs) |
| 服务协议与双向审批 | [app-server-protocol/src/protocol/common.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/app-server-protocol/src/protocol/common.rs) |
| 子 agent 生命周期 | [core/src/agent/control.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/agent/control.rs) |
| Skills 加载 | [skills/src/loading.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/skills/src/loading.rs) |
| 工具按需发现 | [handlers/tool_search.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/tools/handlers/tool_search.rs) |
| 澄清与 Plan Mode | [handlers/request_user_input.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/core/src/tools/handlers/request_user_input.rs) |
| Headless 参数与 review | [exec/src/cli.rs](https://github.com/openai/codex/blob/3ee47c10513f1bb57d869ea650aba28638e3d11c/codex-rs/exec/src/cli.rs) |

## 实施顺序与验收关卡

**第一阶段：补运行内核。** 先定义 SessionState / TurnState / Item，以及权限决策接口；随后实现进程管理器和 macOS 执行后端。接入 steering、持久压缩与事件回放。第一批可以拆成：上下文状态修复、进程 API、权限策略、运行中输入四组独立变更，避免一次大重构。

**2026-10-16 第一批交付：** 已完成持久 compaction checkpoint、完整请求预算、resume 时恢复 usage 与 prompt count，以及 clear 清理这些状态。长 prompt 的压缩保留真实用户指令和成对工具调用；不可容纳的请求返回预算错误。崩溃后进行中 item / 工具事件回放仍未实现，本批不标记该项完成。

关卡：在同一会话里启动测试或服务、继续编辑、接受追加约束、观察运行结果、停止进程；长会话压缩后重启继续；对已发生的文件修改不重复执行。

**第二阶段：扩展模型与工具边界。** 类型化消息、能力矩阵、配置层、Skills、MCP、动态工具；增加 Plan Mode、结构化提问和真正的代码 review。小型 Skills loader 可以较早独立交付。

关卡：用户提供截图，agent 加载指定 skill、调用一个本地 MCP 工具完成任务，随后产生可定位的 review findings；断连和拒绝都有确定结果。

**第三阶段：多会话和协作。** 在前两阶段的生命周期和协议基础上实现子 agent、fork、索引和完整服务接口，再覆盖更多平台、插件分发与诊断。

关卡：多个客户端订阅同一会话、断线重连恢复、子任务并发且可取消；写操作和权限决策仍可解释。

**贯穿各阶段：行为对照评测。** 保留当前十个 eval，另建真实 repo 任务：安装依赖并测试、跨模块修复、运行中纠正、服务启动与日志轮询、超长会话恢复、审查回归、MCP 故障、子 agent 取消。比较成功率、用户干预次数、token、耗时和意外修改。尽可能控制模型、仓库初态与权限；若 Codex 和 chivgent 使用不同模型，应分别报告产品整体差异和 harness 差异，不能归因于框架一项。

## 复刻边界

- 工程目标是兼容行为和设计机制。公开 CLI 源码可直接研究，模型权重、训练方式和专有托管后端不能从 CLI 推导出来；换提示词无法保证模型能力等价。
- 本次不把桌面应用的 sidebar、宠物、云托管或完整商业连接器目录列为 CLI 第一阶段交付项。
- 代码模式、持久记忆、自动审批 reviewer 等高级机制可继续跟踪，但先让基础执行、审批、事件和恢复可测试；不为追逐上游所有实验功能而打散主线。
- 本批修改 runtime、测试和中文说明；未修改依赖或默认权限，也未运行付费模型评测。

## 验证记录

- `npm run check`：通过。
- 默认环境 `npm test`：634/648 通过。失败涉及 macOS 临时目录 canonical path 断言、Unix socket 路径长度和受限监听环境。
- 使用 `TMPDIR=/private/tmp` 后：635/648 通过，剩余 13 个 remote 测试受 `listen EPERM` 影响；不是已确认的 agent 功能回归。
- 沙箱外执行 `TMPDIR=/private/tmp npm test -- --reporter=dot`：53 个测试文件、648 个测试全部通过。默认临时路径下的测试可移植性问题仍应单独修正，当前没有改测试代码来隐藏失败。
- 未执行付费模型评测，也未构建/运行 Codex 上游。
- 2026-10-16 本批定向验证：`npm run check` 通过；`TMPDIR=/private/tmp npm test -- --run tests/agent.test.ts tests/context.test.ts tests/session.test.ts tests/cli-runtime.test.ts tests/events.test.ts` 通过。最终验收：`npm run build` 通过；允许本地 socket 的环境下，`TMPDIR=/private/tmp npm test -- --reporter=dot` 全部通过（53 个文件、658 项测试）。
