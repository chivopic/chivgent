# 更新 chivgent

[English](updating.md)

通过 npm 全局安装的用户可以运行：

```sh
chivgent update --check
chivgent update
```

`--check` 显示当前版本和 npm 最新版本，不安装。直接运行 `update` 会在发现较新版本时
更新；已是最新版本时直接退出，当前版本高于 npm 的 latest 时也不会降级。升级完成后
重新启动 chivgent。命令不需要 API Key，不启动模型会话，也不加载项目扩展。

旧版若没有 `update` 命令，先执行一次：

```sh
npm install -g chivgent@latest
chivgent --version
```

更新功能仅由用户主动触发，平时启动不会检查版本或自动升级。它不是会话内的 `/update`
命令；请在终端 shell 中运行。若想把单词 `update` 当作问题发送给模型，使用
`chivgent -- update`；多词问题仍可整体加引号，如 `chivgent "update this function"`。

## 不同安装方式

| 安装方式 | 行为 |
| --- | --- |
| 当前 npm 全局安装 | 检查并更新同一个全局目录 |
| 源码、`npm link` | 提示在源码目录运行 `git pull --ff-only`、`npm ci`、`npm run build`；需要时重新安装 |
| `npx` 临时运行 | 提示使用 `npx chivgent@latest` |
| 项目本地依赖 | 提示在所属项目执行 `npm install chivgent@latest` |
| 其他包管理器或另一套 Node 环境的安装 | 提示使用对应的包管理器或环境更新 |

源码、临时安装和本地依赖不会由本命令自动更新，`--check` 在这些情况下也只提供指引。
源码更新若遇到本地修改或分支分歧，应先处理 Git 提示；更新命令不会自动修改源码仓库。

## 更新失败

命令失败时返回非零退出码，并显示原因和手动更新命令。缺少 npm 时先修复 Node/npm
安装；网络错误时检查网络及 npm registry 配置；权限错误时检查当前 npm 全局目录是否
可写。程序不会自动使用 sudo，也不会切换到另一个全局目录。

如果新版要求更高的 Node.js 版本，先升级 Node.js，再重试。安装还会启用 npm 的
`engine-strict` 校验，以免装入当前 Node 无法运行的依赖。检查请求有超时限制，安装
最长等待五分钟；失败或超时后，可用 `chivgent --version` 确认实际版本再重试。

Windows 使用 Node 安装目录附带的 npm JS 入口；该入口不存在的自定义安装会提示失败，
可改用手动更新命令。macOS/Linux 使用 PATH 中的 npm。当前环境与原安装使用的 npm
全局目录不一致时，命令只提供指引。

实现沿用 npm 的 [global prefix/root](https://docs.npmjs.com/cli/v11/commands/npm-root/)、
[版本查询](https://docs.npmjs.com/cli/v11/commands/npm-view/)和
[安装命令](https://docs.npmjs.com/cli/v11/commands/npm-install/)，遵循用户的 npm registry
配置，并将安装目标固定为刚检查过的版本。
