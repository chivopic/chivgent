# OpenCode Desktop 源码对照与 chivgent 交付决策

日期：2026-10-23。chivgent 检查基线：`a4199bb19f1d7bd0403156528b4c824b5f0665a0`。OpenCode 检查快照：[`02671e66454260d77fe04d63cf5eb94e76921dee`](https://github.com/anomalyco/opencode/commit/02671e66454260d77fe04d63cf5eb94e76921dee)，该快照 Desktop 包版本为 2.1.4。

本页是源码调研与实施建议，不声明下面的待办已实现。桌面运行契约仍由 [desktop-architecture.md](desktop-architecture.md) 维护，交付顺序由 [desktop-delivery-plan.md](desktop-delivery-plan.md) 维护。本次没有复制上游代码，也没有更改运行权限、凭证存储或桌面功能。

## 结论

继续使用现有 Electron + React + utilityProcess + chivgent 内核。官方 OpenCode 当前的 `packages/desktop` 已经是 Electron；不能再用早期 Tauri 桌面版的文章判断当前实现。其 [package.json](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/package.json) 与本项目已使用相同类别的 electron-vite / electron-builder 构建链。

最值得复用的是工程边界、状态恢复和交付校验的方法。OpenCode 的共享界面依赖 Solid、Effect、`@opencode/app`、`@opencode/client` 和自身服务协议；它们不是可以直接导入现有 React 界面的独立控件。整包搬入会把界面迁移、运行时迁移和产品交付绑在一起。

当前可以构建只读桌面原型，但还不能称为可日常使用的编程桌面版。验收主线应收敛到：**配置模型 → 打开项目 → 提交修复 → 批准修改/命令 → 看到测试结果 → 检查工作区 diff → 重启后继续任务**。完整 CLI 历史导入、worktree、并行 Agent 和持久终端不应阻塞第一条编码主线。

## 上游哪些实现可以借鉴

以下全部来自上述固定提交；“采用方式”是针对 chivgent 的判断。

| 上游实现与源码 | 实际作用 | chivgent 采用方式 |
| --- | --- | --- |
| [desktop-app.tsx](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/renderer/desktop-app.tsx) | 通过 PlatformProvider 装配共享应用；等待服务、语言、路由和主题就绪；提供启动覆盖层 | 保留 React App；将现有重复的 DesktopApi 类型收敛到浏览器可用协议文件，分别提供 AgentClient 与 DesktopPlatform。按实际新增功能拆分，不先造通用 RPC 框架 |
| [platform/index.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/renderer/platform/index.ts)、[files.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/renderer/platform/files.ts) | 把目录选择、打开文件、剪贴板、外部编辑器等平台能力组合为接口；附件读取有选择令牌及释放步骤 | 复用接口拆分思路。原生选择和编辑器打开留 main；工作区读取留 host。不给 renderer 暴露通用 fs、任意命令或原始 ipcRenderer |
| [background-service.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/main/service/background-service.ts)、[background-service-state.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/main/service/background-service-state.ts) | 异步连接并可重新连接后台服务；连接结果可供多个消费者读取；校验服务认证信息 | 学习显式就绪与重连状态。首版继续使用已有本机 IPC host；窗口重建读取快照，host 重建产生新 instanceId，不自动重发任务。无需为本地桌面新增 HTTP 服务、端口、密码文件或服务发现 |
| [lifecycle/configure.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/main/lifecycle/configure.ts) | 在 Chromium ready 前配置 userData、测试隔离目录和应用单实例锁 | 可小范围适配单实例与隔离配置。当前历史已有单写入者锁，但第二个应用进程仍可能启动；增加前台唤回，避免用户看见历史锁错误。不要复制开发调试端口或上游环境变量 |
| [onboarding/index.tsx](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/renderer/onboarding/index.tsx) | 首次启动判断后打开项目，先同步 Provider/model，再进入草稿 | 借鉴“先准备好可用模型，再进入任务”的路径。chivgent 最先支持 API key 与兼容端点的桌面配置；OAuth 单独交付。不能要求 Finder 启动的应用继承终端 export |
| [session-permission-dock.tsx](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/app/src/session/requests/session-permission-dock.tsx)、[requests/model.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/app/src/session/requests/model.ts) | 展示动作与资源；提交指定 session/request 的审批；等待响应时防重复点击；重连时同步未决请求 | 重写为 React 审批卡片，复用本项目 PermissionPolicy。首版只有“本次允许/拒绝”；上游的 always 和项目 auto-approve 不能直接映射到本项目的进程级权限契约 |
| [shell/tabs/schema.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/app/src/shell/tabs/schema.ts) | 将草稿和实际 session 分开持久化，保存最近标签、标题及面板状态 | 借鉴数据模型，保留自己的 JSONL。项目路径、任务 ID、Run ID 必须分开；草稿和滚动位置按任务保存。无需先迁移 SQLite 或复制其路由体系 |
| [platform/notifications.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/src/renderer/platform/notifications.ts) | 窗口在前台时不弹通知；点击通知唤回窗口 | 采用行为，使用本地品牌资源，只在完成、失败和待审批时通知。上游远程图标 URL 不应原样引入 |
| [electron-builder.config.ts](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/packages/desktop/electron-builder.config.ts) | 架构匹配检查、验证捆绑 CLI 非空、分离原生资源、裁剪分发文件、分平台签名配置 | 适配 afterPack 校验思路：host/preload/renderer 均存在，host 在 asar 外且非空，无源码或全局 Node 依赖。chivgent 使用捆绑 Node host，不需要额外引入上游 Bun CLI、PTY 或专用 entitlement |

OpenCode 的 [MIT License](https://github.com/anomalyco/opencode/blob/02671e66454260d77fe04d63cf5eb94e76921dee/LICENSE) 允许代码复用，但复制实质性代码时必须保留许可证及版权声明，记录固定提交、原文件和适配修改。上表目前是方法复用；不把上游品牌、遥测、更新服务、安装脚本或网络地址带入本项目。

## 本项目最应该直接复用的代码

| 现有代码 | 如何接入下一批 | 不能省略的边界 |
| --- | --- | --- |
| [desktop-runtime.ts](../src/runtime/desktop-runtime.ts)、[cli-runtime.ts](../src/cli-runtime.ts) | 在现有 session 工厂中增加明确的桌面运行配置与审批回调 | 不 fork 第二套 Agent 循环；不把 UI 参数直接当 CliOptions；未明确启用时继续只读 |
| [permissions.ts](../src/permissions.ts)、[shell/approval.ts](../src/shell/approval.ts)、[shell/factory.ts](../src/shell/factory.ts) | host broker 连接既有 PermissionPolicy / ShellApprovalGate 和沙箱 | 按既有契约授权；无审批通道、拒绝、取消均不执行；权限不从历史恢复；沙箱不可用不降级 |
| [write.ts](../src/workspace/write.ts)、[patch.ts](../src/workspace/patch.ts) 与现有 write/edit/apply_patch 工具 | 由受控 runtime 注册，保持路径检查与原子修改 | 项目边界、保护路径、symlink 约束保持；UI 按钮本身不能成为写权限 |
| [credentials.ts](../src/auth/credentials.ts)、[file-credentials.ts](../src/auth/file-credentials.ts)、[providers/registry.ts](../src/providers/registry.ts) | 继续复用解析、Provider 定义及模型默认值；由 Node 侧保存新增设置 | 运行状态只返回是否可用；密钥不进入事件、历史、错误或回显；已有配置不能被默认值覆盖。新增持久存储位置须先明确，再实现；不默认改写 CLI auth.json |
| [service.ts](../apps/desktop/src/host/service.ts)、[history.ts](../apps/desktop/src/host/history.ts) | 扩展运行状态、审批快照及独立任务存储 | 复用 requestId 去重与保存失败门控；损坏历史不覆盖；恢复只读，不重放副作用 |
| [tui/git-diff.ts](../src/tui/git-diff.ts) | 提取只读 Git 数据读取部分，桌面和 TUI 共用 | 禁止 hooks/external diff/textconv；用 execFile。终端清理留 TUI；当前 /dev/null 参数不是 Windows 实现。diff 不含未跟踪文件，必须另查 status 与边界内文本预览 |
| [events.ts](../src/events.ts)、[reduce.ts](../apps/desktop/src/app/reduce.ts) | 保持权威终态、工具输出、计划、用量的投影 | assistant 文本目前按纯文本展示；plan_update/usage 需要实际 UI。不要从 token 停止推断完成，也不把 update_plan 当 Plan Mode |

## 阻塞交付的实际缺口

1. **普通用户不能在桌面内完成模型配置。** 现有设置只有 Provider/model；兼容 endpoint 只读，API key 依赖环境变量或现成 CLI auth.json。缺凭证错误能显示，但没有桌面内修复入口。
2. **无法完成修改及测试。** runtime 固定 `allowWrites: false`、`allowShell: false`；协议没有 approval 请求/响应。仅打开这些开关不是实现审批。
3. **历史恢复已有，任务管理未完成。** 历史 session ID 由项目路径 hash 决定；侧栏只有当前会话，不能在同一项目新建独立任务。多会话需要版本化迁移，不能通过清空当前 JSONL 伪装“新建”。
4. **缺少结果检查界面。** 没有工作区文件/diff 请求，也没有 Markdown/代码块、计划和用量的完整展示。工具输出卡片不能替代工作区 diff。
5. **后台故障只能展示，不能在应用内恢复。** host 退出后没有明确的恢复入口；没有单实例唤回或完成/待审批通知。现有宿主退出等待是基础，接入命令后还必须验证后代清理。
6. **分发只验证到本地包。** 现有 macOS arm64 dir 产物未签名；完整安装、真实供应商、Finder 冷启动和签名/公证需分别留证。Linux Xvfb 的只读 E2E 不等于 macOS 安装验收。

还有两个接入 Shell 前必须修正的具体路径：

- [RuntimeSession](../apps/desktop/src/host/service.ts) 当前没有 `close()`，但 [AgentSession.close](../src/session.ts) 已有资源清理。模型切换、项目切换和 host shutdown 必须关闭旧 session；异步工厂在取消后才返回的 session 也必须关闭，不能留下输出存储或进程资源。
- host 写历史失败目前会发送错误消息；开始运行前失败已拒绝受理，但执行中的日志失败仍需建立明确的终止/拒绝后续副作用门控。新增审批的允许结果必须先可靠记录，记录失败时不能继续执行。测试覆盖“开始记录成功，工具执行前磁盘写失败”，不能只测 run/start 的保存失败。

## 建议拆成五个可审查批次

每个批次都包含主路径、故障路径、先红后绿测试及契约更新；一个批次完成并验证后再推进依赖它的批次。下面是工作包，不是已创建的远程 Issue 或 PR。

### A. 桌面内完成首次配置

输入场景：全新应用目录、无环境 Key、无 CLI 配置，从 Finder 打开应用。现状是只能看到缺凭证错误；完成后可以在桌面内配置 Provider、模型与 endpoint，保存后发起第一条请求。

- 修改落点：main/preload 的窄配置接口、host 的脱敏状态、runtime 配置解析、App 设置入口。
- 先确定桌面凭证持久化方案及保存范围；Node 侧保存，读取接口永不返回 Key。输入控件提交后清空，不进入草稿/历史。
- 保持已有环境/CLI 凭证的兼容及端点隔离；切换 Provider 不携带另一个目标的 Key。
- 失败测试：使用隔离 home、临时配置和 localhost fake Provider，确认请求确实使用所选目标配置；保存失败能重试、已有条目不丢失、renderer 响应与历史不含假 Key。
- 契约：Desktop 第 6/9 节与 README。仅支持 API key 即可形成首条交付路径，订阅 OAuth 后续独立验收。

### B. 受控编码与可靠审批

输入场景：用户明确开启本次进程的可编辑模式，请求修复一个临时项目。完成后可以允许/拒绝指定修改和命令，看到执行输出，并可停止。

- 修改落点：runtime、PermissionPolicy 接入、协议、host 审批 broker、main/preload、React 审批卡片和 host/session 清理。
- 审批携带 hostInstanceId/sessionId/runId/approvalId，展示动作、目录与权限上下文；只消费一次；审批属于某次具体动作，不能用通用“继续”按钮批准。
- 待审批随快照恢复；正常隐藏窗口维持等待，renderer 崩溃拒绝未决审批，退出与停止取消等待。旧 host、过期或重复回复无效。
- 把执行前的可靠记录和执行中保存失败门控一起交付。不是给文件工具和 Shell 注册一个始终返回 true 的回调。
- 失败测试：假模型请求真实临时文件修改；批准后字节改变，拒绝/无通道/取消字节不变；匹配审批只执行一次；历史写失败不执行；旧权限不随重启恢复；晚到 session 被关闭；沙箱不可用无命令副作用。
- 命令实际运行另在 macOS Seatbelt 验证；审批 broker 的纯单元测试不冒充沙箱验收。
- 契约：Desktop 第 7/9 节；复用 Shell 契约，CLI/TUI/remote 权限行为保持。

### C. 用户能够检查结果

输入场景：在含已有改动的 Git 项目完成一次修复。完成后能分别检查未暂存、已暂存和未跟踪文本文件，并在编辑器打开目标文件。

- 修改落点：共享 Git 读取层、host 的 workspace 查询、main 编辑器打开、React 文件/diff 面板。
- 面板名为“工作区改动”；先不提供“本轮改动”归因，也不增加暂存、撤销、commit 或 PR 写操作。
- 路径、容量及二进制检查发生在 Node 边界；请求绑定项目/任务，迟到的旧项目 diff 不覆盖当前面板。
- 失败测试：临时 Git 仓库同时含 staged/unstaged/untracked 变化；非 Git、缺 Git、空 diff、大文件、二进制、越界/symlink 分别有可观察结果；不执行外部 diff/hook/textconv。
- 回答中的代码块可以选中复制；若引入 Markdown 库，单独核对锁文件、渲染边界和链接处理。
- 契约：Desktop 第 10 节，TUI 共用部分保留回归。

### D. 项目与任务可持续使用

输入场景：同一项目创建两个任务，切换、关闭应用并重启。完成后两份上下文、标题、草稿和历史互不混合，归档可恢复。

- 修改落点：版本化 session 元数据、host 的 session/create/list/read/update、协议、侧栏和 UI 状态。
- 先保留全应用单活动运行；运行中可以查看其他任务，不能偷偷启动第二个任务或换掉执行 cwd。
- 为当前按项目 hash 存储的历史定义迁移；旧文件保留，迁移失败不覆盖；权限及未决授权不迁移。完整 CLI 会话导入可后置。
- 失败测试：两个独立上下文、草稿和滚动状态；切换中的迟到响应；重启续聊没有重复请求；损坏/只读/锁占用不被当空历史。
- 契约：Desktop 第 6/8 节。运行记录、UI 草稿和模型上下文分别建模。

### E. 故障恢复与实际安装交付

- 单实例唤回、启动失败/host 退出后的显式恢复、完成与待审批通知；恢复只同步状态，绝不自动重跑。
- afterPack 检查所有入口和架构；把产物复制到源码树外，干净 userData、无全局 Node/CLI 条件下执行 A–D 的完整路径。
- 准备与产物一致的安装说明、已知限制、构建版本及校验值；本地未签名试用与公开签名、公证、发布分别验收。
- GUI 自动化使用 Linux CI Xvfb；当前本地默认不弹窗。macOS 安装与 Seatbelt 的真实验收需用户明确允许可见窗口后单独运行。
- 契约：Desktop 第 9/11 节与 releasing。按真实变更复核 `.github/` 和分发脚本，不把上游发布服务直接搬入。

首个本地编程试用版必须串通 A+B+C+已有重启恢复；它仍不等于完成全部 M1。D/E 及既有 M1 的主题、键盘导航、面板和安装要求全部验收后，才把 M1 状态改为完成。不用上游功能清单拉大首批范围。

## 本次实际验证

环境：本地 macOS arm64，Node.js 26.9.0；测试源码为上述 chivgent 基线。本次仅新增调研/计划文档，未新增运行时功能。

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test`（普通执行沙箱） | 失败：18 failed、934 passed、1 skipped；本地 fixture 监听被拒绝，部分 Unix socket 临时路径为 108 bytes，超过 macOS 103-byte 限制 |
| `TMPDIR=/private/tmp npm test`（获批原生执行） | 通过：68 个文件，952 passed、1 skipped。没有跳过前述失败文件 |
| `npm run build` | 通过 |
| `npm run desktop:test` | 通过：9 个文件、100 项测试；不启动 GUI |
| `npm run desktop:build` | 通过，包含 main/preload/renderer 与独立 host bundle |
| `npm run desktop:pack` | 首次下载 Electron 时 DNS 失败；获批允许下载锁定版本后，重新完整打包成功。macOS arm64 `.app`，日志明确跳过代码签名 |
| 产物静态检查 | Info.plist 版本为 0.1.0；可执行文件为 Mach-O arm64；asar 外的 `out/host/index.mjs` 存在且非空 |
| 文档检查 | `git diff --check` 通过；本次三个文档中的本地 Markdown 文件链接全部存在 |

本地产物：`apps/desktop/release/mac-arm64/chivgent.app`。这是当前只读原型的构建产物，不包含 A–E 待办。本次没有启动它，也没有沿用历史 GUI 记录作为本次通过证据。

未执行：本次可见 Electron E2E、源码树外启动、Finder 冷启动、真实供应商调用、签名/公证、其他平台、Node.js 22/24、Docker smoke、live eval、CLI tarball 独立安装和 release candidate 检查。现有 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 已包含独立 desktop 测试、构建与只读 Xvfb E2E；没有本轮 CI 运行结果，且该 job 不覆盖上述未来编码闭环。

当前代码测试和打包可通过，是继续实施的基础；A–E 与完整场景未通过之前，不能把本次调研或 `.app` 生成标为可用编程桌面版已交付。
