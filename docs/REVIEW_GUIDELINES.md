# 审查指南

实现和审查分开。审查者重新看问题、diff 和测试，不把 PR 描述或实现者的解释当成证据。这份文件约束人怎么审，不自动往 GitHub 发评论。

评论、Approve、Request Changes、Merge 和推送，都先给维护者看过再发。

## 五个阶段

同一条改动走完这些阶段。前三步可以由实现者做。第五步必须换一个人，或换一个没有实现上下文的会话。

1. **理解问题。** 复现当前行为，写清期望行为。复现不了，就不要开始改。
2. **实现。** 修 bug 时先写失败的回归测试，再做最小修改。不顺手重构。
3. **验证。** 跑和改动相关的已有命令。问一句：删掉这次修复，新测试还会失败吗？
4. **Pull Request。** 用 `.github/pull_request_template.md` 写给读 diff 的人。Testing 只记录这次真的跑过的命令和结果。没跑的写明没跑。
5. **独立审查。** 按下面的格式提意见。意见先作为草稿交给维护者，不直接发到 PR 上。

## 严重程度

| 标记 | 含义 | 能否挡合并 |
| --- | --- | --- |
| Blocking | 有证据的正确性、兼容性、安全或测试缺口 | 能 |
| Nit | 可选改进。不修也可以合 | 不能 |
| Question | 需要作者解释。不是已证实的缺陷 | 不能，除非答案暴露出 Blocking |

没有复现、没有 diff 位置、没有命令输出的猜测，写成「未证实」，不要写成 Bug。

## 评论格式

一条意见一件事，挂到具体文件和行。顺序固定，缺的项写「没有」，不要省略。

**Blocking: 一句话说明破坏了什么**

- 问题：
- 复现：命令、输入、起始状态
- 期望：
- 实际：
- 为什么危险：谁会踩到，旧行为怎么变
- 建议修法：方向，不是代写完整补丁
- 要补的测试：删掉修复后，这条测试应该失败

格式示例（不是当前缺陷）：

**Blocking: 无 shell 的运行注册了 SIGTERM，退出码变了**

- 问题：`installShellCleanup` 在没有子进程时也会把 SIGTERM 变成退出码 130。
- 复现：不带 `--allow-shell` 启动，再发送 SIGTERM。
- 期望：退出码与改动前一致。
- 实际：进程以 130 退出。
- 为什么危险：调用方把 130 当成主动中断。普通运行本来没有子进程要清理，注册 SIGTERM 只改变了退出码。`src/cli.ts` 里的注释已经写明这一点。
- 建议修法：只在 shell 启用时安装，不要套到普通运行或 `--serve` 上。
- 要补的测试：shell 关闭时，SIGTERM 不安装该处理；删掉这个条件后测试失败。

Nit 和 Question 用同一结构。Question 的「实际」写成观察到的代码，不写成失败。

## 审查时核对什么

先看 diff 是否比问题大，再看旧行为有没有被顺手改掉。下面这些是本仓库里已经定过的行为，审查时对着代码和测试核对，不要另写一套。

- **权限。** 默认只读。`--permission-mode` 只有 `ask-first`、`workspace`、`unrestricted`，且不能和 `--allow-writes`、`--allow-shell`、`--approve-all-shell`、`--shell-network` 一起用，也不能用于 `--connect` 或 `--serve`。模式只在本进程有效，恢复会话不会恢复一个更宽的模式。见 `src/permissions.ts` 和 `src/cli-options.ts`。
- **沙箱。** 不可用时失败关闭，没有无沙箱回退。无交互时 shell 默认拒绝，除非显式 `--approve-all-shell`。直接写工具拒绝 `.git`、`.agents`、`.codex`、`.aws`、`.ssh`、列出的 `.env*`，以及符号链接逃逸。见 [docs/shell-sandbox.md](shell-sandbox.md)。
- **退出码。** 没启用 shell 时不要为了「清理」去注册 SIGTERM。启用 shell 时，SIGTERM / SIGHUP 走 `installShellCleanup`，退出码 130。`--serve` 单独接 SIGINT 和 SIGTERM，关闭监听后返回 0。两套不要混用。见 `src/cli.ts`。
- **测试是否锁住了行为。** 退出码变了、端口还在、请求被掐断，都可能让一条只断言「进程结束了」的测试保持绿色。删掉声称的修复再跑新测试。仍然通过，就是 Blocking：测试没有覆盖那条行为。

这条「删掉修复、测试仍绿」的检查来自 [yetone/magpie#1258](https://github.com/yetone/magpie/pull/1258)。那里 SIGTERM 的退出码修对了，但测试没有锁住优雅关闭，也没有保住进程继承来的「忽略 SIGINT」。本仓库不照搬 Go 的 `signal.Ignored`。要学的是方法：兼容行为要有反例，通过的测试要能在修复被拿走时失败。

## 复用这些命令

CI（`.github/workflows/ci.yml`）在 Node.js 22 和 24 上跑 `npm ci`、`npm run check`、`npm test`、`npm run build`、评测 dry-run 和 `npm pack --dry-run`。Docker smoke 只在 Node.js 22 上跑。审查时让作者跑和 diff 相关的命令，不要要求每个 PR 把下面全部跑一遍。

| 改了什么 | 命令 | CI 是否覆盖 |
| --- | --- | --- |
| `src/`、`tests/` | `npm run check`，`npm test` | 是，Node.js 22 和 24 |
| 构建或打包入口 | `npm run build`，发布前再加 `npm run release:check` | 构建和 `npm pack --dry-run` 会跑 |
| `apps/desktop/` | `npm run desktop:test` | 否。根目录 `vitest.config.ts` 排除了 `apps/desktop/**` |
| `evals/` | `npm run eval -- --dry-run --allow-writes --allow-shell` | 只覆盖 dry-run，不调用模型 |
| Docker 沙箱 | `node scripts/docker-smoke.mjs` | 只在 Node.js 22 |

## 已知缺口

这些不是这份文档要补的 CI。审查时不要把 CI 绿色当成下面几项的证据。

- 桌面测试和 `apps/desktop` 的打包验证不在 CI 里。改了 `apps/desktop/` 却只贴了根目录 `npm test` 的结果，Testing 里必须写明桌面命令没跑。
- 评测的行为不在 CI 里。dry-run 通过只说明预检能跑，不说明任务做对了。
- Docker smoke 没有在 Node.js 24 上跑。
- 没有原生 Windows shell。不要在 PR 里声称 Windows 上的 shell 已经验证，也不要加无沙箱回退。

## 从一次审查长出一条规则

一次审查如果暴露了本文件没点名的一类问题，就在这里加一条，并链到那个 PR。加的是可核对的行为，不是一段新提示词。本文件变长时，把每天都要用的短规则留在根目录 `AGENTS.md`，细节留在这里。
