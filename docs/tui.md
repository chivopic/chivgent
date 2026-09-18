# 滚动式 TUI

启动实际会话：

```sh
npm run build
node dist/cli.js --tui
```

没有 API Key 时可在会话内使用 `/login`，或直接运行离线演示：

```sh
npm run demo:tui
```

演示使用相同的 AgentSession、REPL 和实时区域，模拟流式回答和工具进度，不联网、不写工作区。

## 操作

| 操作 | 行为 |
| --- | --- |
| 输入问题，Enter | 发起一轮对话 |
| `/he` 后 Tab | 补全 `/help`，也支持扩展命令 |
| 上下键 | readline 输入历史 |
| Ctrl+C（运行中） | 取消当前运行，保留已收到的文字，回到提示符 |
| Ctrl+C（空闲） | 提示退出方式，保持会话 |
| Ctrl+D、`/exit` | 退出并恢复终端输入模式 |
| `/session` | 会话、工作目录、消息数量与累计 token |
| `/tools`、`/help` | 工具列表与命令帮助 |
| `/clear` | 清空模型会话内容，保留终端滚动历史 |

欢迎面板显示供应商、模型、工作目录和会话。运行区显示回答尾部、最多三个工具的最新进度、
轮次、耗时及 token。运行完成、取消、失败或达到轮次上限时会留下结果；`tokens+` 表示有一轮
未报告用量。普通按键在运行中被丢弃，不回显，也不排队发送为下一条问题。

TUI 保留正常屏幕与终端原生滚动历史。提示符、进度和结果摘要写入 stderr，最终回答写入
stdout，支持 `node dist/cli.js --tui > answers.txt`。非 TTY 或非交互式调用仍明确拒绝
`--tui`；默认 CLI 和 JSON 模式继续使用原有渲染器。

## 终端适配

使用 `string-width` 与 `Intl.Segmenter` 按显示列和完整字符簇截断中文、组合字符及 Emoji。
运行区预留末列以避免自动换行；矮窗口优先保留状态。缩放时根据旧内容重排后的行数清除
原区域，再重画。不同终端对 Emoji 宽度和历史重排的实现仍可能存在差异。

输入由 readline 编辑，TUI 输入适配层在运行中仅转发 Ctrl+C。原始 stdin 不暂停，因此
取消不会被吞掉。退出或异常时会移除输入监听并恢复终端模式。

## 验证

```sh
npm run check
TMPDIR=/private/tmp npm test  # macOS 使用短路径，远程测试需要本地 socket 权限
npm run build
npm run demo:tui
```

自动测试覆盖显示列宽、字符簇、控制字符、欢迎面板、命令补全、输入隔离、取消后继续提问、
退出恢复、输出分流、失败提示和缩放清除旧行。真实 PTY 另验证 80→32→80 列缩放、流式工具、
Ctrl+C、再次提问、会话命令、Ctrl+D 和重定向 stdout。
