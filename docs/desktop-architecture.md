# chivgent Desktop 产品与实施规划书

更新：2026-10-19。状态：P1 首批真实只读运行已实现；#68 的单项目历史与最小恢复首批已实现，完整任务导航、旧 CLI 导入及 M1 后续能力仍未实现。

默认运行真实 Agent。用户通过 main process 原生目录对话框选择项目；host 解析规范路径并为其创建只读 `AgentSession`，复用 CLI Provider、凭证解析、流式事件与 `list_files`、`search_text`、`read_file`、`update_plan` 工具。Provider、模型、兼容 endpoint 与 API key 可从会话设置配置。Renderer 只在密码输入框中短暂持有新输入；Node host 将 Provider 配置保存到应用 userData 的 `desktop-config-v1/provider-profiles.json`，目录权限为 0700、文件为 0600，状态读取不返回 key。配置不写入 CLI `auth.json`。环境 key 优先，其次 CLI `auth.json`，最后是该 Provider 的桌面 key。OAuth 刷新、项目写入、Shell 均未接入。

每个项目当前提供一个最小会话，支持多轮上下文；切换到有历史的项目会恢复其会话，首次打开才开始新上下文，运行期间不能切换。Provider/model 改变时用旧 transcript 重建 session。真实运行现在把当前项目及版本化运行记录保存在应用 userData 下的 `desktop-history-v1`；可用 `CHIVGENT_DESKTOP_HISTORY_DIR` 为验证指定隔离目录。host 初始化时恢复所选项目的原子快照；Renderer 刷新不重新提交任务，重启只读取历史和上下文，不自动运行模型或工具。未结束运行显示 interrupted/unknown；未完成工具提示检查工作区。运行期间 host 退出、host 失败或当前 run 报错时，仍为 running 的工具立即显示“结果未知”，保留已有工具输出和部分回答；已完成或已报错的工具保持原状态。历史损坏和写入失败会显示错误，损坏日志保持只读。记录不含凭证配置字段，序列化内容会对常见 token/key 形态脱敏。离线演示仅在显式设置 `CHIVGENT_DESKTOP_DEMO=1` 时启用，当前 demo 路径不持久化。macOS arm64 `.app` 本地打包未签名；这不代表公开发布或签名/安装包已通过 CI；当前桌面 CI 范围以 [workflow](../.github/workflows/ci.yml) 为准。完整恢复与 CLI 兼容仍见 [#68](https://github.com/chivopic/chivgent/issues/68)，UI 后续见 [#69](https://github.com/chivopic/chivgent/issues/69)。

## 1. 产品目标与参考关系

chivgent Desktop 的目标是形成接近 Codex Desktop 的本地编程工作台：围绕项目组织任务，持续观察 Agent 工作，在执行中介入，在结果产生后检查代码与验证结果，并能跨会话、跨应用重启继续工作。CLI 和 Desktop 使用同一个 chivgent 内核。

三者的定位：

- **Codex Desktop 是产品目标**：参考项目/任务组织、任务时间线、输入与介入、审批、变更检查、终端、worktree 和并行任务的工作流。
- **Codex 开源运行时与 App Server 是行为和协议参考**：研究 Thread/Turn/Item、运行事件、双向审批、恢复和取消；chivgent 保持自己的协议与 Provider 适配。
- **OpenCode Desktop 是工程参考**：学习桌面宿主、共享界面、后台服务、平台适配和打包；具体库和目录取舍服从 chivgent。

桌面版直接运行自己的 Agent，继续支持现有模型供应商。产品对标不意味着模型能力、OpenAI 账号体系、托管服务或全部 Codex 功能已经等价。保留 chivgent 的名称与视觉标识。本规划聚焦 coding 工作台主线。

## 2. 依据与当前基础

官方资料核对于 2026-10-16；链接可能随上游更新。这里描述的是参考行为，不是对 Codex 私有 Desktop 源码结构的推断。

- [Codex 项目与会话](https://developers.openai.com/codex/projects/)：项目组织与会话管理。
- [Codex 代码审查](https://developers.openai.com/codex/app/review/)：变更范围、行级反馈与 Git 操作。
- [Codex worktree](https://developers.openai.com/codex/app/worktrees/)：隔离工作目录与任务交接。
- [Codex App Server](https://developers.openai.com/codex/app-server/)：会话、运行、事件、审批接口。
- [OpenCode Desktop](https://github.com/anomalyco/opencode/tree/dev/packages/desktop)。
- [OpenCode 共享界面](https://github.com/anomalyco/opencode/blob/dev/packages/desktop/src/renderer/desktop-app.tsx)。
- [OpenCode 后台服务](https://github.com/anomalyco/opencode/blob/dev/packages/desktop/src/main/service/background-service.ts)。
- [OpenCode 打包配置](https://github.com/anomalyco/opencode/blob/dev/packages/desktop/electron-builder.config.ts)。

实际复用上游代码时固定提交，记录来源和修改，并保留相应许可证与版权声明。

本项目可复用 Agent、Session、Provider、工具、事件流、上下文、JSONL 历史与 Shell 沙箱。`cli-runtime.ts` 已集中组装会话，但配置和诊断仍有终端耦合。`remote/*` 是已有单会话协议，保留兼容；Desktop 增加多会话服务契约。

内核仍在持续演进，实施每个里程碑前核对当前代码，避免重复实现近期已完成的功能。[Codex CLI 对照路线](codex-parity-audit-2026-10-15.md)作为内核依赖清单使用，其中历史状态不能直接当作今天的代码状态。

## 3. 交付分层与能力对照

**M0 是可安装的技术原型，M1 是可日常试用的本地桌面版，M2 是接近目标的 Codex 式工作台。** M1 的范围限制不代表最终产品范围。

| 工作流 | M1 本地桌面版 | M2 工作台 | 后续 |
| --- | --- | --- | --- |
| 项目/任务组织 | 打开目录、项目列表、新建/重命名/归档任务、恢复历史 | 搜索、置顶、任务分支 | 多目录项目 |
| 任务时间线 | 用户输入、流式回答、工具活动、计划进度、用量、结束状态 | 明确 commentary/final、结构化提问 | 更丰富附件与产物 |
| 执行中介入 | 停止、保留草稿、结束后继续发送 | queue 与 steering，分别定义语义 | 更复杂协作 |
| 模型与权限 | 会话模型、端点、有效权限展示、Shell 审批 | 分层配置、能力驱动选项、权限规则 | 组织配置 |
| 变更检查 | 文件列表、未暂存/已暂存 diff、文本预览、外部编辑器打开 | 行级反馈、模型 review、分支 diff、经过验证的本轮改动范围 | 暂存/撤销/提交/PR 集成 |
| 执行环境 | 已有本地工具与沙箱；命令输出卡片 | 持久命令会话、stdin/PTY、内置终端 | 远程主机 |
| 多任务 | 多会话切换，全应用一个活动运行 | 不同工作目录并行、worktree 隔离与生命周期管理 | 子 Agent 编排 |
| 窗口生命周期 | 关窗继续运行、完成/审批通知、退出应用停止 | 更完善后台体验 | 独立常驻服务、跨客户端实时接续 |
| 扩展 | 保留现有扩展信任边界 | 根据内核进度接入 Skills/MCP 设置与状态 | 插件目录、自动化、浏览器等 |

运行控制只有内核实际支持时才展示。`update_plan` 进度清单、Plan Mode、Git diff 浏览和模型代码审查分别验收，不能互相替代。

## 4. 用户旅程与界面结构

主要旅程：选择项目 → 新建任务 → 选择模型与权限 → 提交需求 → 观察执行 → 回应审批或停止 → 检查文件改动与测试结果 → 继续修改 → 归档任务。

```text
┌──────────────┬───────────────────────────┬────────────────────┐
│ 项目 / 任务   │ 项目、任务标题、运行状态     │ 文件 / 变更检查     │
│              ├───────────────────────────┤                    │
│ 最近任务      │ 用户消息                   │ 文件列表           │
│ 项目分组      │ Agent 文本                 │ diff / 文本预览    │
│ 运行/待审批   │ 工具活动 / 计划 / 审批       │ 在编辑器中打开     │
│ 历史任务      │ 最终结果                   │                    │
│              ├───────────────────────────┤                    │
│ 设置          │ 多行输入、模型、权限、发送   │ 可折叠             │
└──────────────┴───────────────────────────┴────────────────────┘
```

首版交互要求：

- 多行输入、中文输入法组合态、粘贴、草稿保留；组合输入时 Enter 不误提交。
- 运行中按钮切为停止，保留可编辑草稿；M1 不把草稿暗中当作 steering。
- 工具默认显示动作与状态，可展开参数、输出和错误；最终回答可清楚辨认。
- 向上读历史时不强制滚到底部，提供回到最新；切换任务恢复各自草稿和滚动位置。
- 无凭证、空 diff、非 Git 目录、运行失败和保存失败都有具体状态。
- 侧栏展示后台任务与待审批；完成和需要操作时通知，持续 token 输出不触发通知。
- 深浅主题、键盘导航、可选择复制文本、可调整面板宽度纳入 M1。

视觉参考 Codex 的信息层级、任务中心布局和低干扰活动展示；所有按钮对应实际能力。

## 5. 技术栈与模块边界

| 层 | 选择 |
| --- | --- |
| 桌面 | Electron、electron-vite、electron-builder |
| 界面 | React、TypeScript、Vite、Tailwind CSS、shadcn/ui |
| 前端状态 | Zustand 保存界面状态及服务状态投影 |
| 执行内核 | 现有 Node.js/TypeScript Agent、Provider、工具、沙箱 |
| 历史 | JSONL + 少量原子写入的项目/会话元数据；索引随规模再引入 |
| 验证 | Vitest；桌面关键路径使用 Playwright/Electron |

```text
React App
  ↕ AgentClient / DesktopPlatform
preload（窄接口）
  ↕ Electron IPC
Electron Main（窗口、通知、凭证、host 管理）
  ↕ utilityProcess 消息端口
Agent Host（任务调度、事件投影、审批、持久化）
  → 共享 Runtime → AgentSession → Agent / Provider / Tools

CLI / TUI → 同一个共享 Runtime
```

M0 验证 `utilityProcess.fork`、ESM、资源定位、实际 Node 版本以及沙箱执行能在打包应用中工作。该机制自带 Node 与消息端口，不要求用户安装全局 Node 或 CLI。[Electron 接口依据](https://www.electronjs.org/docs/latest/api/utility-process)

Renderer 不导入 Node/Electron/工具实现。主进程不持有模型循环。host 是任务状态的唯一权威，前端不独立推断任务完成。平台接口只包括文件选择、通知、外部链接、编辑器打开等能力；AgentClient 负责任务请求与订阅。

首版使用本机 IPC，不开网络端口。后续 stdio/HTTP 适配器复用分发器；不要求完整兼容 Codex 协议，也不把相同方法名等同于能力已实现。

### 目录与发布依赖

先采用单仓库、一个私有 Desktop 包，保持依赖方向清楚：

```text
src/runtime/                  # 中立会话工厂、配置、诊断
src/protocol/                 # 纯数据契约、运行时校验；浏览器可用
src/client/                   # Transport 与类型化客户端；浏览器可用
src/service/                  # host 服务实现；Node 环境
apps/desktop/
  package.json                # private；独立 tsconfig 与桌面依赖
  src/main/
  src/preload/
  src/host/                   # utilityProcess 入口，调用共享 service
  src/app/                    # React UI，不依赖 Electron
  src/renderer/               # 装配 App、client 和 platform
```

根 CLI 的 `rootDir: src` 和发布 `dist` 继续成立。CLI 运行依赖保持在根包中，不依赖未发布的私有 workspace 包。Desktop 构建通过显式源码别名打包共享模块；浏览器构建仅引用 protocol/client，禁止反向导入 service/runtime。

Desktop 与根包分别锁定依赖和构建，根脚本通过 `npm --prefix apps/desktop` 调用。真实 Web 客户端出现时，再将 app/client 提取为独立 workspace 包。

每次共享层改动保留 CLI 类型检查和相关测试；发布关卡执行 `npm pack`，在仓库外临时目录安装 tarball 并运行 CLI，验证没有隐式依赖本地源码或软链接。

## 6. 项目、会话与配置契约

| 对象 | 职责与关键字段 |
| --- | --- |
| Project | id、名称、规范化目录、仓库信息；M1 每项目一个目录 |
| Session | id、projectId、cwd、标题、归档状态、会话配置、历史 |
| Run | id、sessionId、用户输入、有效配置快照、状态、时间、用量 |
| Item | 稳定 id、runId、类型、内容和状态；关联消息/工具/审批 |
| Approval | id、runId、具体动作和权限上下文、状态；只能消费一次 |

UI 叫“任务/会话”；内部沿用 Session 和 Run，对应 Thread/Turn 的产品概念。现有 `AgentEvent.turn` 是单次请求内部的模型循环编号，不能直接充当 Run ID。

配置优先级：应用默认值 → 用户设置的项目默认值 → 会话覆盖 → 本次运行显式覆盖。项目默认值来自用户配置，仓库文本不能自行扩大权限；所有覆盖受宿主策略限制。

桌面首次配置保存每个 Provider 的模型、key 与兼容 endpoint（仅 `openai-compatible` 可设置 endpoint）。已有 profile 更新模型或 endpoint 时可以留空 key，Node 侧保留原 key。key 位于应用 userData 的独立 profile 文件中，不写入会话历史或 CLI `auth.json`；运行时 key 解析仍是 Provider 环境变量 → CLI `auth.json` → 桌面 profile。Renderer 可写入 key，但只读取 Provider/model/endpoint/是否已配置的脱敏状态。配置文件损坏时，host 保持可启动并报告不含密钥的修复提示；首次恢复保存到独立 recovery 文件，原损坏文件保留，其他不可读取的 profile 需要重新录入。

每次运行冻结有效配置：Provider、model、endpoint、cwd、工具写权限、Shell 启用/后端/网络策略、审批策略与上下文预算。快照只记录凭证引用，不保存密钥。

界面将下一轮 Provider/model 选择与最近一次实际运行的有效配置分开展示：会话设置入口允许选择 Provider 和模型覆盖，切换 Provider 会清除模型覆盖；运行期间仍可打开设置查看当前有效配置，但不能修改选择。endpoint 与完整配置仅在设置详情中可见。项目名称是项目详情入口，详情显示 host 解析后的完整规范路径并提供复制；侧栏和对话标题不铺开重复路径。正常 Agent host 连接仅显示为可访问的状态点，连接详情按需打开；连接失败和其他需要用户处理的提示持续显示。

修改模型或权限只影响下一次运行。要立即生效先停止再开始；审批回复只授权该次动作。M1 不在已有会话中切换 cwd，改用新建任务。恢复历史不能静默扩大权限，界面展示本次继续执行的有效设置。

M1 同一 host 只执行一个 Run，其他会话可查看、编辑草稿或等待；不自动排队。这只约束本应用，不声称阻止外部编辑器或其他 CLI 修改同一目录。M2 按规范化工作目录调度；不同目录可并行，同目录写任务串行或使用独立 worktree。

## 7. 协议、订阅和请求重试

初期实现最小接口，随里程碑增加，不预先搭建通用 RPC 框架：

| 接口组 | 功能 |
| --- | --- |
| initialize | protocolVersion、hostInstanceId、能力列表 |
| project/list、project/add | 已选择项目与目录注册 |
| session/create、list、read、update、resume | 创建、历史、标题/归档/配置、继续工作 |
| session/subscribe、unsubscribe | 原子快照与后续事件 |
| run/start、read、interrupt | 提交、查询、取消 |
| approval/respond | 回答指定动作 |
| provider/list、status | 模型能力与脱敏配置状态 |
| workspace/diff、file/read | 有权限边界与容量限制的只读检查 |
| host/shutdown | 受控停止与刷新 |

请求/响应使用 requestId，事件使用 hostInstanceId/sessionId/runId/sequence；工具条目另有 toolCallId。边界做运行时校验，未知版本拒绝连接。没有密钥也能创建项目和浏览历史，开始真实运行才要求模型可用。

同一 host 保存已受理 run/start 的 requestId 与参数摘要，重复请求返回原 runId，同 ID 不同参数拒绝。记录至少保留到 host 退出；容量到限时拒绝新请求，不能静默淘汰仍可能重试的记录。窗口重建先查询状态，不自动重新提交草稿。

Renderer 等待 `run/start` 确认期间保留 Composer 草稿。Host 明确拒绝且尚未受理时（包括请求校验、host 忙、请求记录已满或运行开始前的历史保存失败），界面撤回时间线中的乐观用户消息并保留草稿供编辑重试。与待处理请求 ID 匹配的 `started` 广播也证明 Host 已受理；此时只清空本次提交的文本，等待期间输入的新草稿继续保留。之后到达的 invoke 错误或拒绝不能撤销已受理的运行，后续事件仍正常收束运行；项目切换使旧请求失效，迟到响应不影响新会话。Host 在受理后报告运行错误时不把原请求恢复为未受理草稿。没有匹配的受理广播且响应超时或 IPC 断开时，受理结果未知，界面保留文本并提示先检查会话状态；应用不会自动重发。Prompt 长度上限为 32,000，Model 名称去除首尾空白后的长度上限为 160；超限时发送控件提示并禁用，内容不会被截断，也不会放宽协议校验。

hostInstanceId 改变后原请求结果视为未知，不跨 host 自动重试有副作用的任务。

订阅在同一状态边界取得快照水位，再发送后续事件。快照包含进行中的文本、工具输出和待审批项。sequence 按 host 内每个 Session 单调递增，重建 host 后以新实例 ID 区分。界面按序去重；增量批量合并，过载明确要求重新取快照。

持久化成功/失败独立于模型是否完成，不把流结束误当作历史已保存。

## 8. 历史、恢复与 CLI 兼容

### 已实现的 #68 首批范围

真实 Desktop host 使用 `apps/desktop/src/host/history.ts` 在 `desktop-history-v1` 下为规范项目路径建立稳定 Session ID 和 version-1 JSONL 日志。日志以单写入者锁保护；仅在锁内记录的 PID 已失效且回收过程独占时移除旧锁。初始化原子读取历史并带 `hostInstanceId`、`sessionId`、sequence 水位、运行事件与终态返回快照。Renderer 先订阅事件，再请求初始化；按 host/session/sequence 去重，发现缺口后重新请求快照。

记录运行受理、工具事件、完成事件和 Agent 可恢复的模型上下文；流式文本只保留在 host 内存快照，不逐 token 同步写入。保存运行受理失败会拒绝该次运行；日志写失败、损坏尾行或中间记录损坏会显示恢复状态，损坏日志不继续追加。启动时从最后可靠上下文恢复后续用户主动运行；重启时将无终态运行显示为 interrupted/unknown，未完成工具结果标注需检查工作区，绝不自动重放。日志不储存 Provider 凭证配置或权限，历史恢复也不设置运行权限。项目切换、多个已完成 Run 的最小时间线可恢复；完整任务列表、重命名/归档 UI、旧 CLI 导入及跨进程幂等请求记录不在本批范围。

继续使用 JSONL，但分开两种读取结果：供模型恢复的上下文，与供界面展示的运行/消息/工具活动时间线。现有 `FileSessionStore.read()` 主要围绕最终消息快照，需要增加历史投影读取器。

新记录明确保存 session/run/item ID、运行开始和终态、最终消息、工具开始/结果、审批决策和有效配置引用。文本 delta 不逐 token 落盘；工具进度只保留有界快照或最终输出。

运行受理记录持久化后再执行有副作用的工具；保存失败时阻止新的副作用，显示恢复/诊断操作。已经发生的修改不能标记成“未执行”，也不能声称日志与文件系统形成原子事务。

恢复规则：

- Renderer 刷新：host 内存快照恢复当前任务，不重启任务。
- 正常退出再打开：加载已保存历史，用户主动发起下一次运行。
- host 异常退出或运行中断：无终态运行标为 interrupted/unknown；运行终态到达时，仍无工具结果的工具显示“执行结果未知，需要检查工作区”，保留运行成功/失败状态和已有输出，不自动重新运行命令。
- 审批不在重启后自动生效；用户明确重新发起后才能产生新审批。
- 损坏尾行允许恢复前面的有效记录，并显示历史不完整；中间记录损坏不能隐瞒。

格式演进使用显式版本。Desktop 新格式先放在独立的版本化历史目录；旧 CLI 日志只读展示，继续旧任务时从最后可靠检查点导入为新 ID，记录来源并保留原文件。正在运行或包含未完成动作的旧日志先显示状态，不能当作完整恢复点。

这不依赖旧版 CLI 遵守新锁协议。升级后的 CLI 支持同一格式和锁协议后，再提供同一会话实时接续；单独设置兼容性验收，不在 M1 宣称已实现。

新格式每个 Session 同时只有一个写入者，锁记录持有者并原子获取；回收前确认持有者失效。项目与任务标题/归档等元数据使用原子写入，索引可以从日志重建。

## 9. 审批、凭证与应用生命周期

ShellApprovalGate 通过 host 的审批 broker 接入。审批显示命令、目录、所需权限及沙箱上下文，关联唯一 Run 与 Approval。重复/过期/跨运行回复不能执行。项目扩展仍在 import 前完成信任判定；CLI 提问和桌面审批共用判定逻辑。

BrowserWindow 开启 contextIsolation/sandbox，关闭 nodeIntegration。preload 暴露明确方法，主进程校验发送者与参数；Markdown 和链接按不可信内容处理。文件预览、diff、编辑器打开同样校验项目边界，不能成为任意文件读取通道。

Desktop 设置支持各 Provider 独立的桌面 API key；兼容 endpoint 只属于 `openai-compatible` profile。凭证按环境变量、CLI `auth.json`、桌面 profile 的顺序解析。`openai` 和 `openai-compatible` 共用环境变量名 `OPENAI_API_KEY`，但面向不同的目标端点。桌面端只允许进程启动时选中的 Provider 使用该共享环境 Key；切换到另一个 Provider 时，不会把启动 Provider 的环境 key 转给目标 Provider。桌面 profile 按 Provider 分开保存，Renderer 从不读取已保存的 key，提交后输入框清空，协议状态和历史都不含 key。配置位于应用 userData，不写入 CLI `auth.json`；文件是 owner-only 权限的明文 JSON，具备本机账户文件访问权的进程仍可读取。Desktop 不调用 OAuth refresh。

首版不承诺新凭证自动写回 CLI 的明文 auth.json；界面说明保存范围。

macOS 生命周期：

- 关闭窗口：隐藏窗口，主进程与 host 继续运行；Dock 可重新打开。
- 正常关窗待审批：保持等待，发出可回到任务的通知；绝不自动批准。
- Renderer 崩溃：未决审批失效并拒绝，其他任务按 host 状态恢复；与正常隐藏区分。
- 明确退出应用：停止任务、取消审批、清理受管命令/Docker、刷新日志，再退出。主进程等待 Agent host 的 utility process 退出后再完成应用退出；优雅关闭超时会终止 host 并有界等待其退出，仍未退出则报告清理失败并继续退出。
- 超时退出：有界等待后记录异常结果，使用跟踪信息清理；不承诺强杀后所有状态均已落盘。

host 异常和主进程异常分别验证，包含父进程失联检测与后代清理。utilityProcess 隔离不等于 Shell 沙箱，也不自动保证其所有后代随它退出。

## 10. 变更检查与后续内核依赖

M1 diff 面板标为“工作区改动”，包含用户或其他程序已有的改动。未暂存、已暂存分别展示；未跟踪文本文件、二进制/大文件、非 Git 目录单独处理。复用 `tui/git-diff.ts` 的查询约束，提取原始数据层，终端文本清理留在 TUI。

“本轮改动”在 M2 有执行前后基线、工具修改记录和外部变化检测后提供。Shell 或并发编辑导致无法确定归属时，显示范围与不确定性，不冒充精确 Agent 归因。行级反馈绑定文件、diff 版本与位置，重新生成 diff 后核对是否过期。

M2 内核工作与 CLI 路线合并交付：

| 能力 | 先完成的内核条件 | Desktop 验收 |
| --- | --- | --- |
| queue / steering | 分别定义下轮排队和当前运行安全边界注入；取消竞态 | 追加约束有接收及生效状态 |
| PTY / 终端 | 持久 process ID、stdin、输出、resize、退出和权限语义 | 启动服务后继续任务，可查询日志并停止 |
| Plan / 结构化提问 | 复核已有模式；明确模式约束与请求/响应 | 可选择答案、取消和继续，不是仅显示清单 |
| 模型 review | 独立审查目标、只读运行、结构化 findings | 文件/行号/严重级别定位，用户决定后续修改 |
| worktree / 并行 | checkout 管理、环境准备、权限与任务绑定、冲突处理 | 两个隔离任务并行，清理前保留可恢复工作 |
| Skills / MCP | 发现、作用域、连接、取消和错误恢复 | 配置与运行状态可见，实际工具调用有效 |

worktree 首批只做创建、选择、任务绑定与可恢复清理；搬移未提交改动的 Handoff 单独实现与测试。用户终端与 Agent 工具执行的权限来源分别可见，不能把终端直接等同于已批准工具。

## 11. 实施顺序与交付关卡

每阶段都产出可运行结果；需要的共享抽象随真实路径提取。M0 桌面原型已完成；P1 首批真实只读路径已实现，后续历史与恢复依次推进。详见本轮 [交付顺序与验收记录](desktop-delivery-plan.md)。

| 阶段 | 状态 | 交付内容 | 验收 / 证据 |
| --- | --- | --- | --- |
| P0 桌面底座 / M0 | 已实现并通过本地验证 | 单窗口、utility host、stub Agent、流式显示、停止、macOS arm64 `.app` | `npm run desktop:pack` 成功；复制到源码树外运行 [verify-packaged.mjs](../apps/desktop/scripts/verify-packaged.mjs)，12 项断言全通过：重复 initialize、IME、流式文本、文本出现后取消及光标收起、工具活动/展开、完成、host 退出与启动失败提示、关窗隐藏、退出清理。CLI `npm run check`、`npm run build` 通过；获批原生权限并设置 `TMPDIR=/private/tmp` 后 `npm test`：56 个文件，679 passed、1 skipped。Desktop `npm run desktop:test`：9 passed。产物未签名；上述验收结果来自本地；当前 CI 另有桌面单元/集成测试、构建和只读 Electron 验证。 |
| P1 真实任务 | 首批已实现 | 最小 runtime、Provider/model 选择、目录授权、只读工具与流式会话 | `verify-readonly.mjs` 验证默认信息层级、路径详情/复制、设置与状态详情、真实 fake Provider 请求、read_file、多轮、取消、缺凭证恢复及窄窗布局；`verify-history.mjs` 验证刷新/重启/崩溃恢复、用户 Provider 选择、上下文与不自动重放；完整命令见下文 |
| P2 执行控制 | 待实现 | 写入/网络/Shell 设置、审批、取消、关窗/退出、通知 | 允许命令能执行、拒绝无副作用；关窗任务继续；退出清理；新设置只作用下一轮 |
| P3 历史与会话 | 单项目记录与恢复首批已实现；后续仍跟踪 [#68](https://github.com/chivopic/chivgent/issues/68) | 版本化历史、host 快照、模型上下文和运行/工具恢复已实现；完整任务导航、旧 CLI 导入、标题/归档和跨 host 幂等记录待实现 | 刷新不断任务；重启恢复且不重放工具；损坏/写失败可见；后续再验收 CLI 导入与任务导航 |
| P4 本地可用版 / M1 | Provider 首次配置已实现；其他能力仍待实现 | 侧栏、diff、预览、草稿、主题、安装完善 | 完成修复→审批→测试→检查 diff→重启继续；无源码依赖；CLI 回归通过 |
| P5 工作台 / M2 | 待实现 | 运行中介入、持久终端、review、worktree、并行任务 | 按上一节逐项关卡交付；共用能力进入 CLI 回归 |

桌面配置使用应用 userData 下独立的 `desktop-config-v1`，不写 `~/.chivgent`；同一个只读 Agent 和 Provider runtime 继续负责请求。切换 Provider 会清空手工填写的模型覆盖；切换模型或 Provider 时复用当前对话和 ContextManager 压缩检查点，避免长对话重新压缩丢失摘要。与运行关联的终态事件必须匹配当前 runId，迟到的确认不得重新打开已完成运行。localhost fake Provider 测试使用临时项目和桌面 profile，不使用外部服务或模型额度。本地的 `verify-readonly.mjs`、`verify-history.mjs` 和 `verify-packaged.mjs` 会启动可见 Electron 窗口，默认拒绝运行；用户主动在本机验收时须显式传入 `--allow-ui`，例如 `node apps/desktop/scripts/verify-readonly.mjs --allow-ui [normal.png] [narrow.png]`。CI 只在 Linux Xvfb job 中自动运行，其他 `CI` 或 `DISPLAY` 环境不会单独解除拒绝。CI 的只读 E2E 连续运行 20 次以覆盖 teardown 稳定性。先 `npm run desktop:build`，再执行相应验收脚本；`npm run desktop:test` 使用临时目录与 fake Provider，不启动 Electron 窗口。单项目历史恢复首批已实现；完整项目/任务导航和旧 CLI 历史导入仍未实现。

有副作用的 P2 依赖最小持久运行记录与保存失败门控，随 P2 先落地；P3 再完成历史界面、CLI 导入与剩余恢复能力。不能等到 P3 才知道 P2 的工具执行是否留有记录。

桌面端到端重点覆盖：中文输入、流式状态、审批拒绝、取消、快照重连、host 故障、关窗继续、退出清理、旧历史导入、目录含空格及离开源码树启动。故障注入验证“工具修改成功但结果尚未记录”的恢复状态。

本地 .app 验证与公开发布分开记录；签名、公证和安装包发布需要实际凭证。M0/M1 优先当前 macOS 架构，其他 CPU 架构及 Linux/Windows 分别验证后声明支持。Git、Shell、Docker 和项目工具链缺失需明确诊断，自带 Node 不代表自带所有工具。

## 12. 首批变更与完成标准

P0 Desktop 原型与 P1 首批只读闭环已实现；P1 的具体实现位于 [desktop-runtime.ts](../src/runtime/desktop-runtime.ts)、[HostService](../apps/desktop/src/host/service.ts)、[host entry](../apps/desktop/src/host/index.ts)、[native project picker](../apps/desktop/src/main/index.ts)、[desktop protocol](../apps/desktop/src/protocol/messages.ts) 与 [runtime behavior tests](../apps/desktop/tests/runtime.test.ts)。

1. 已创建私有 Desktop 包、独立构建配置与开发/打包脚本。
2. 已完成 main、preload、host 与 initialize/start/event/interrupt 最小协议。
3. 已通过现有 Agent 和 stub Provider 验证事件流、停止和 host 故障展示。
4. 已实现任务主界面、多行输入、中文输入法处理、工具活动与停止；对话状态更新和 host failure 时收束流式指示。
5. 已生成 macOS arm64 未签名 `.app`，复制到源码树外运行并通过上述 12 项验收。`npm run desktop:pack` 的 `identity: null` 明确跳过代码签名；未执行公证或发布。
6. CLI 检查、构建、完整测试通过；本轮未将 CLI tarball 安装到独立目录做发布验证。当前 CI 另运行桌面测试、构建与只读 Electron 验证，未执行 Desktop 安装包验收或本批历史恢复脚本。

M1 完成标准：用户可以安装应用，在自己的项目中完成一次受控代码修改，看到执行过程和验证结果，检查改动，并在重启后继续同一任务。

M2 完成标准：进一步在隔离工作区推进多个任务、运行中介入、操作持久终端并审查结果。

下一项实现任务：**#68 完整历史界面与旧 CLI 导入**。P2 有副作用的工具仍须先建立运行记录与保存失败门控。任务排序与本轮验收详见 [desktop-delivery-plan.md](desktop-delivery-plan.md)。
