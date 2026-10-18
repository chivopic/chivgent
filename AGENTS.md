# 在本仓库里改代码

这是给编码代理的仓库约定。它低于用户当次的指令，也不能代替权限开关：默认只读，写和 shell 仍要标志或权限模式。chivgent 读取本文件时上限 8 KiB，超出会被截断，所以长规定放在 [docs/REVIEW_GUIDELINES.md](docs/REVIEW_GUIDELINES.md)。审查之前先读那份文件。

## 先复现，再改

- 先写清期望行为，并复现当前行为。修 bug 时，先写一条现在会失败的回归测试，再改实现。
- 改动限于问题本身。不顺手重构，不改无关代码。
- 权限、沙箱、退出码、会话恢复都有故意保留的旧行为。没读到对应实现和测试之前，不要改。

## 用现有命令验证

不要另起一套测试。只跑和改动相关的命令。没跑的写明没跑和原因。不要编造通过记录。

- 类型：`npm run check`
- 单元测试：`npm test`（不含 `apps/desktop`，见 `vitest.config.ts`）
- 构建：`npm run build`
- 桌面：`npm run desktop:test`。CI 不跑它。
- 评测预检：`npm run eval -- --dry-run --allow-writes --allow-shell`。这不调用模型。CI 也只做到这一步。
- Docker 沙箱：`node scripts/docker-smoke.mjs`。CI 只在 Node.js 22 上跑。
- 发布前：`npm run release:check`

测试通过不等于那条行为被锁住。修 bug 时问：删掉这次修复，新测试还会失败吗？不会，就还没测到声称修好的行为。

## 提交

从最新的 `main` 切分支。PR 按 `.github/pull_request_template.md` 写给读 diff 的人，不复述提交列表。Testing 里写实际跑过的命令和结果。界面改动附截图，图片不要提交进仓库。

往 GitHub 发评论、Approve、Request Changes、Merge，或推送，都先等维护者确认。

## 审查和实现分开

审查者不采信 PR 描述，也不采信实现者的解释。重新看 diff、调用链和测试。每条意见要有证据、影响和建议修法。严重程度只用 Blocking、Nit、Question。没有证据的猜测标明未证实。格式见审查指南。

## 不要改坏的行为

- 默认只读。写文件要 `--allow-writes`，或 `workspace` / `unrestricted`。`ask-first` 在没有确认时拒绝写入。
- `--permission-mode` 不能和 `--allow-writes`、`--allow-shell`、`--approve-all-shell`、`--shell-network` 一起用，也不能用于 `--connect` 或 `--serve`。模式只在本进程有效，不会从已保存的会话恢复。
- 沙箱不可用时失败关闭，没有无沙箱回退。无交互时 shell 默认拒绝，除非显式 `--approve-all-shell`。
- 直接写工具拒绝 `.git`、`.agents`、`.codex`、`.aws`、`.ssh` 和列出的 `.env*`，也拒绝符号链接逃逸。见 [docs/shell-sandbox.md](docs/shell-sandbox.md)。
- 没启用 shell 时不要注册 SIGTERM 处理。`installShellCleanup`（`src/cli.ts`）只在启用 shell 时安装，并把 SIGTERM / SIGHUP 的退出码改成 130。普通运行保持原退出码。`--serve` 才同时接 SIGINT 和 SIGTERM，关闭后返回 0。不要把这两套处理混用。
