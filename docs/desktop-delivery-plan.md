# Desktop 近期交付安排

日期：2026-10-18。检查基线：`653a1dc`。本页记录任务排序与验收安排；现有行为和接口以 [Desktop 契约](desktop-architecture.md)为准，Agent 的责任以[内核架构](architecture.md)为准。

## 先完成一个真实任务

第一项交付是：打开自己的项目，选择模型，要求“解释这个项目的入口和执行流程”，看到真实文件读取、流式回答，并能停止和继续追问。

检查基线中的 Desktop 已有 Electron 窗口、utilityProcess host、消息时间线、工具展开与取消；host 使用离线 Provider。首页视觉不代表真实 Agent 已接通。先交付这条路径，才有依据改进任务管理与编码工作流。

## 功能顺序

| 顺序 | 用户能完成什么 | 工作内容 | 过关条件 |
| --- | --- | --- | --- |
| 1 · 真实只读任务 | 在选定项目里提问并继续追问 | 原生目录选择、真实 Provider、AgentSession、只读工具、配置与错误展示、停止 | 临时项目文件内容进入工具结果；追问带上下文；缺凭证可重试；停止后可继续；越界读取失败；无写入和 Shell 工具 |
| 2 · 任务保存与恢复 | 单项目会话刷新与重启后继续（首批已交付）；完整任务导航后续 | 已有版本化历史、当前项目恢复、host 快照、模型上下文检查点、运行/工具状态；后续补项目/任务列表、草稿、标题和归档 | 刷新恢复当前运行；重启恢复对话供用户主动续聊；不重放工具；损坏记录明确提示；权限不随历史恢复；保存失败可见；完整 UI 与 CLI 导入另验 |
| 3 · 受控编码 | 请求修改、回应审批、运行验证 | 有效权限、写工具、Shell broker、逐动作审批、取消与退出清理 | 先持久记录再执行副作用；拒绝无副作用；过期回复无效；取消清理进程；新配置只影响后续运行 |
| 4 · 检查结果 | 理解改了什么、确认验证结果 | 工作区 diff、已暂存/未暂存分组、文件预览、编辑器打开、测试结果与用量 | 工作区已有改动不冒充本轮改动；非 Git、二进制、大文件有状态；预览遵守项目边界 |
| 5 · 日常使用与安装 | 安装后稳定完成整个修复流程 | 配置与凭证界面、主题、键盘导航、通知、面板、安装验证 | 从安装到修复、检查 diff、重启继续全程可操作；包在源码目录外运行；签名与平台支持分别验收 |
| 6 · 多任务工作台 | 隔离推进多个任务并执行中介入 | worktree 生命周期、按目录调度、持久终端、queue/steering、结构化提问与 review | 每项先有内核语义和测试，再提供对应 UI；隔离任务可并行且工作可恢复 |

第 2 项的最小可恢复记录已完成，第 3 项依赖它。完整历史界面与旧 CLI 导入仍未实现；执行副作用前的记录和保存失败门控仍是第 3 项的前置条件。diff 与预览可在只读阶段提前开发，但不替代第 3 项的执行约束。

## Agent 如何接入

```text
React 界面（配置、输入、时间线）
  ↕ 窄 preload API / Electron IPC
Main（原生目录选择与发送者校验）
  ↕ utilityProcess 协议
HostService（运行关联、单活动运行、取消）
  → 中立 runtime（配置、凭证解析、会话组装）
  → AgentSession（当前项目的多轮上下文）
  → 现有 Agent → Provider / 只读工具 → LocalWorkspace
```

复用已有内核和事件，不把 CLI 终端输出当桌面协议，也不在 React 内实现第二套 Agent 循环。目录来自用户的原生选择；模型配置仅传递必要的非敏感字段。凭证在 Node 侧解析，Renderer 不接收密钥。

本轮只接 API key；桌面订阅登录另列任务，避免普通项目查询隐式触发 OAuth 刷新与凭证写回。演示 Provider 保留为显式离线验证路径。第一项不承诺重启恢复、Shell、文件修改或多任务。

## Luna 的本轮工单

Luna 负责第 1 项实现及行为测试；主代理负责检查边界、复核改动、补充端到端验收并汇总证据。首批按独立分支和 PR 交付；发布与合并由维护者决定。

范围包括 runtime、Desktop 协议与 host、目录选择、最小模型配置、时间线和契约文档。沿用已有依赖、Provider 地址及只读默认。测试使用临时项目、临时凭证目录与 fake Provider。

验收记录至少包含：

1. 输入至真实文件读取再到时间线结果的完整路径，以及多轮上下文。
2. 无凭证、非法协议、重复请求、初始化失败后重试、运行中切项目与取消。
3. 新测试移除对应实现后确实失败的反证。
4. `npm run check`、`npm test`、`npm run build`、`npm run desktop:test`、`npm run desktop:build` 的实际结果。
5. Electron 实际交互、打包应用和真实供应商调用分别记录；没执行的不能写成通过。

按[代码规范](code-standards.md)检查；桌面测试不在根 `npm test` 中；CI 通过独立 Desktop job 运行桌面测试、构建、只读 Electron 验证和历史恢复验证，并在失败时上传限期诊断产物。首批第 1 项完成后，已按计划交付第 2 项最小闭环；完整任务界面及导入继续作为后续工作。

## 本轮交付与验证记录

首批已完成，本次提交包含基于 `653a1dc` 实现并验证的改动；PR 基于合并代码规范后的 `main`，两者源文件树相同。Luna 完成实现与内核回归，主代理补充桌面行为测试、凭证边界修正要求、布局、Electron 验收及打包检查。应用尚未公开发布。

| 检查 | 实际结果 |
| --- | --- |
| `npm run check`、`npm run build` | 通过 |
| `TMPDIR=/private/tmp npm test` | 获批在原生环境运行后：59 个文件，712 passed、1 skipped。普通沙箱运行受 Unix socket/Seatbelt 限制失败，不能当作通过 |
| `npm run desktop:build`、`npm run desktop:test` | 通过；桌面 2 个文件、15 项测试通过 |
| `node apps/desktop/scripts/verify-readonly.mjs` | 9 项断言通过；5 次请求全部发往临时 localhost 模拟模型。验证真实 adapter、实际项目文件读取、工具结果展示、多轮、缺凭证恢复、停止后继续、无项目/凭证写入与最小窗口布局 |
| macOS arm64 本地打包 | 默认 `npm run desktop:pack` 在下载 Electron 时因 GitHub 不可达失败。使用现有构建，改以 Desktop 目录中的 `CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --mac dir --publish never --config.electronDist=./node_modules/electron/dist` 成功打包 |
| `node apps/desktop/scripts/verify-packaged.mjs apps/desktop/release/mac-arm64/chivgent.app` | 将最终应用复制到源码目录外，显式使用 demo；12 项断言通过。首次运行因新增路径文本在两处出现而触发定位歧义，已收窄定位并重新通过 |
| `git diff --check` | 通过 |

测试反证在临时源码副本执行，不修改开发中的源文件：移除模型切换时的 transcript 传递，`keeps context when changing model and clears it when selecting a different project` 在“保留最初提问”的断言失败；移除项目切换时的 session 清空，同一测试在“新项目不含旧提问”的断言失败。正常实现的完整桌面测试通过。

兼容端点的凭证隔离另有先红后绿证据：新增测试先捕获 OpenAI 的启动 key 被错误继承；修正后，只有明确以 compatible 启动时继承共享环境 key，普通切换使用 compatible 自己的 auth 条目。测试全部使用假 key 和临时文件。

GUI 运行和打包均在本机 macOS arm64 完成。真实供应商账号调用、签名、公证、其他平台、CLI tarball 仓库外安装、live eval 与 Docker smoke 未执行。模型接入的自动化证据来自实际 adapter 与本地模拟服务，不代表实号模型质量已验收。

## #68 首批历史与恢复

本次按 `Refs #68` 交付第 2 项的单项目最小闭环：新版本化 JSONL 历史、当前项目恢复、初始化时 host 原子快照、Renderer 水位去重/缺口重新同步、多轮模型上下文恢复、损坏与写失败提示，以及异常运行/工具结果未知状态。新记录在应用 userData 的 `desktop-history-v1`；自动化与 Electron 验收使用显式临时目录和 localhost fake Provider。历史不会恢复权限，也不会自动调用模型或重放工具。

完整任务导航、旧 CLI 历史导入、标题/归档界面和跨 host 的 requestId 日志留在 #68 后续。当前仅验证本地 macOS Electron 路径，不表示签名、公证或其他平台支持。该批检查在 Node.js 26.9.0 上运行；Node.js 22/24 的结果待 CI/维护者验证。

### #68 最终验收记录

执行环境为本地 macOS arm64、Node.js 26.9.0；历史目录和测试项目均使用 `/private/tmp` 下的临时路径。检查结果如下：

| 命令或检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `env TMPDIR=/private/tmp npm test` | 通过：63 个测试文件，787 passed、1 skipped。普通沙箱运行曾因 沙箱拒绝 Unix socket 与 Seatbelt 运行而失败；在临时目录获批运行后通过 |
| `npm run build` | 通过 |
| `npm run desktop:test` | 通过：4 个文件、55 项测试 |
| `npm run desktop:build` | 通过 |
| `npm run eval -- --dry-run --allow-writes --allow-shell` | 通过：10 项任务，无跳过项 |
| `git diff --check` | 通过 |
| Electron `verify-history.mjs` | 通过：`final-history-e2e.log` 为 11 项断言、4 次 localhost fake 请求；覆盖刷新、重启续聊、Provider 选择保留、崩溃后 unknown 状态及不自动重放 |
| Electron `verify-readonly.mjs` | 通过：`final-readonly-e2e.log` 为 9 项断言、5 次 localhost fake 请求；覆盖缺凭证、取消及最小窗口路径 |

先红证据均针对可观察行为，而非编译失败：原 main 的 Electron 刷新会丢失流式文本（`/private/tmp/chivgent-issue68-evidence/refresh-red.log`）；重新同步曾把显式 DeepSeek Provider 覆盖为 `openai-compatible`（`provider-resync-red.log`）；损坏的模型上下文结构曾被接受为有效恢复点（`malformed-context-red.log`）；非法负数 snapshot 水位曾被协议校验接受（`snapshot-schema-red.log`）。另外，达到 requestId 保留上限后旧 ID 曾被静默淘汰；对应测试确认旧代码对该 ID 返回 `replayed: false`，新实现改为到限拒绝。最终上述 Electron 与测试检查均通过。证据日志位于 `/private/tmp/chivgent-issue68-evidence/`。

未执行 Node.js 22/24、本机真实供应商账号调用、签名/公证、其他平台验收、CLI 历史导入、完整任务导航和跨 host requestId 日志；它们不属于本批首发闭环。没有使用真实凭证或写入真实 `~/.chivgent`，没有调用外部真实模型。

主代理还在最终构建副本上分别移除初始化快照和模型上下文保存：前者使 `verify-history.mjs` 在刷新后找不到原流式文本（`snapshot-removed.log`），后者使重启后的模型请求缺少最初用户输入（`checkpoint-removed.log` 中 `resumed conversation must contain the original prompt once` 断言失败）。两项均退出 1；随后恢复原构建并重跑同一 Electron 脚本通过。

本批未重新执行 Desktop `.app` 打包及仓库外 packaged 验收、CLI tarball 安装验收、Docker smoke、live eval 或 release candidate 检查；沿用历史记录不能替代本批验证。

## #96 历史存储故障与离线回归

此增量基于 #68 首批恢复实现，专注于真实临时文件 I/O 故障、共享离线 Electron fixture 与 CI 诊断，不扩展完整任务导航或 CLI 导入。执行环境为 macOS arm64、Node.js 26.9.0。当前本地验收如下：

| 命令或检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `env TMPDIR=/private/tmp npm test` | 通过：63 个文件，787 passed、1 skipped |
| `npm run build` | 通过 |
| `npm run desktop:test` | 通过：6 个文件、73 项测试 |
| `npm run desktop:build` | 通过 |
| `npm run eval -- --dry-run --allow-writes --allow-shell` | 通过：10 项任务，无跳过；不调用模型 |
| `node apps/desktop/scripts/verify-readonly.mjs` | 通过：9 项断言、5 次 localhost fake Provider 请求；覆盖真实工具、多轮、缺凭证、取消与最小窗口 |
| `node apps/desktop/scripts/verify-history.mjs` | 通过：11 项断言、4 次 localhost fake Provider 请求；覆盖刷新、重启、主动续聊、Host 崩溃 unknown 和不重放 |
| `git diff --check` | 通过 |

新 I/O 测试先对依赖 PR 的旧源运行，产生实际行为红证据：短写导致 Unicode 历史尾行不完整、锁 fsync 失败遗留 `.lock`、partial append 后伪称成功并继续追加、fsync 失败后写入内容发生变化、metadata 短写不能解析，以及 `agent_end completed` 后 checkpoint 落盘失败被误报为 `run_error`。最后一项覆盖事件 fsync 失败后 writer 进入停写状态的相邻路径；旧代码继续发 `run_error` 而非 `history_write_failed/checkpoint`，红日志为 `/private/tmp/chivgent-issue96-evidence/event-fsync-classification-red.log`。基础 I/O 红摘要保存在 `/private/tmp/chivgent-issue96-evidence/checkpoint-save-red.log`；独立 I/O 边界 red 在 `/private/tmp/chivgent-issue96-evidence/independent-io-red.log`。独立审阅在隔离源码副本做反证：移除 short-write 循环令两项断言失败，移除锁清理令锁测试失败，恢复后独立边界测试通过，日志见同目录 `short-write-loop-removed.log`、`lock-cleanup-removed.log` 和 `independent-io-restored.log`。

共享 fixture 运行时每次使用独立临时项目、profile、auth、history、localhost 动态端口及 Host PID/log 路径；成功清除临时资源。受控执行 `CHIVGENT_DESKTOP_ARTIFACT_DIR=/private/tmp/luna-issue96-final-artifacts CHIVGENT_DESKTOP_E2E_FAIL_AT=after-project-selected node apps/desktop/scripts/verify-history.mjs` 按预期退出 1，并生成 trace、截图、失败阶段、脱敏请求与 Host stderr/no-output 诊断；扫描生成的 trace 未发现 `fixture-key`、`Bearer fixture-key` 或 `OPENAI_API_KEY`。独立审阅另在运行中请求阶段和正常重启场景注入失败，确认两个 Electron 主进程及两个 Host PID 全部退出、临时根目录删除，重启前的诊断请求摘要脱敏；检查摘要见 `/private/tmp/chivgent-issue96-evidence/parent-final-restart-artifacts-review.json`。最终恢复流程截图保存为 `/private/tmp/chivgent-issue96-evidence/final-history.png`。

GitHub Actions Desktop job 现会在 Node.js 22 下运行两条离线 Electron E2E，并在 job 失败时将共同 artifact 目录上传、保留 7 天；工作流原有触发器、`contents: read` 权限与其他 job 保持不变。此次本地未运行 Node.js 22/24 CI 环境、Desktop 打包/签名、公证、其他平台、真实账号模型调用、live eval、Docker smoke 或 release candidate 验收。Synthetic SSE 样本为手写兼容协议片段，不是供应商抓包。
