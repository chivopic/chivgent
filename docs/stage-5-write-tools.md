# Stage 5: 写入工具与 Workspace 拆分

> 本文记录 `0.7.0` 的增量设计，以及 `0.7.1` 对行尾和 BOM 的修正。Stage 4 让对话
> 可以持续，但 Agent 仍然只能读：它能定位问题，不能修改。Stage 5 只解决"可以改
> 文件"这一件事，不引入 Shell、逐次确认或 undo。

## 1. 目标

```text
User
  -> CLI --allow-writes
  -> Agent Loop
       -> read_file            先读
       -> edit_file            再改（唯一匹配）
       -> Workspace（可写）
            -> 临时文件 -> rename
```

完成后：

1. `chivgent --allow-writes "把 X 改成 Y"` 能真正落到磁盘上。
2. 不带 `--allow-writes` 时，写入工具根本不注册，Workspace 也拒绝写。
3. 写入中途崩溃不会留下半个文件。
4. 编辑只改内容，不改文件的编码形态（BOM、行尾）。

## 2. 设计原则

1. **默认只读，写入是显式开关。** 能力由 Workspace 持有，不靠 system prompt 约束。
2. **权限在 Workspace 层判定，不在 Tool 层。** 任何写入路径都要先过
   `assertWritesEnabled()`；即使有人绕过 CLI 直接构造 Tool，也写不进去。
3. **写入必须原子。** 先写同目录的临时文件，再 `rename` 覆盖目标。
4. **编辑先读。** `edit_file` 走读路径拿原文，因此自动继承"存在、是普通文件、
   是合法 UTF-8、不超过大小上限"这四条保证。
5. **一次编辑只允许唯一匹配。** 匹配不到或匹配多处都直接失败，不猜。
6. **编辑改内容，不改编码。** BOM 和 CRLF 必须原样还回去。

## 3. 模块拆分

`workspace.ts` 在 Stage 2 之后已经同时承担路径解析、忽略规则、读、列目录、搜索。
加上写之后它会变成这个项目里最难读的文件，因此本阶段先拆再加：

```text
src/workspace.ts          仅保留 LocalWorkspace：配置、limits、只读默认
src/workspace/
  types.ts                限制常量、WorkspaceError、Workspace 契约
  paths.ts                路径规范化、越界与敏感路径判定、写路径解析
  text.ts                 UTF-8 解码（含 BOM）、分行、参数校验
  read.ts / list.ts / search.ts / write.ts    四类操作各自一个模块
```

每个操作模块都是纯函数，显式接收 `WorkspaceLimits`。`LocalWorkspace` 只负责持有
配置和那句 `assertWritesEnabled()`。

## 4. `write_file`

```jsonc
{ "path": "src/a.ts", "contents": "完整的新内容" }
```

- 整文件替换；缺失的父目录会被创建。
- 返回 `Created` 还是 `Replaced`，附行数和字节数，让模型知道自己做了什么。
- 内容含 NUL 直接拒绝：那不是本工具要写的东西。
- 超过 `maxFileBytes`（256 KiB）拒绝，与读路径同一个上限。

## 5. `edit_file`

```jsonc
{ "path": "src/a.ts", "old_text": "逐字节复制的原文", "new_text": "替换后的文本" }
```

| 情况 | 结果 |
| --- | --- |
| 唯一匹配 | 替换，返回命中行号与新行数 |
| 匹配不到 | `no_match`，提示重新读文件并逐字节复制 |
| 匹配多处 | `ambiguous_match`，提示补充上下文使其唯一 |
| `old_text` 与 `new_text` 相同 | `invalid_range`，拒绝一次不产生变化的编辑 |
| 文件不存在 | `not_found`，不会顺手创建 |

`new_text` 允许为空字符串，那是删除；`old_text` 不允许为空，否则匹配位置没有意义。

为什么不做多处替换或正则：模型对"改哪几处"的判断远不如对"改这一处"可靠，而一次
错误的全局替换在只读工具里没有对应的补救手段。

## 6. 写路径的边界

读可以依赖 `realpath`，因为目标已经存在。写目标通常不存在，所以
`resolveWritePath()` 用另一种方式证明边界：

1. 先做词法规范化，拒绝绝对路径、`..` 越界、敏感路径（`.git`、`.env`、`*.pem` 等，
   规则与读共用）。
2. 从根开始逐段 `lstat`：**任何一段是符号链接就拒绝**，任何已存在的中间段必须是目录。
3. 每个已存在的段都要 `realpath` 后仍在工作区内。
4. 遇到第一个不存在的段就停止——它下面不可能有东西，也就无需再查。

因此"在工作区里放一个指向 `/etc` 的软链再往里写"这条路径在写入任何字节之前就被切断。
工作区根目录本身不是可写的文件路径。

## 7. 行尾与 BOM（0.7.1）

`0.7.0` 的 `edit_file` 做严格字节匹配，结果在真实项目里立刻撞墙：模型把文件内容
读进上下文后，回写 `old_text` 时几乎总是把 CRLF 规范成 LF，于是每次编辑都
`no_match`。BOM 则相反——读路径用 `TextDecoder` 默认吞掉 BOM，写回去时就被静默删掉了。

修正分三步：

- `readUtf8FileWithBom()` 用 `ignoreBOM: true` 解码，把"有没有 BOM"作为信息返回给
  调用方，读工具照旧剥掉，写路径负责还原。
- 只有**整份文件统一使用 CRLF** 时，才在 LF 空间里做匹配、写回前转回 CRLF。
- **混合行尾的文件保持严格字节匹配**：把它统一成任一种风格，都会改动这次编辑没有
  提到的行。宁可让模型重读一次，也不要顺手"整理"文件。

## 8. 对 CLI 与 Agent 的影响

- `--allow-writes` 同时决定三件事：注册哪些工具、Workspace 是否可写、system prompt
  是否追加写入守则。
- 默认 `maxTurns` 从 8 提到 16（`DEFAULT_WRITE_MAX_TURNS`）：读→改→复核这条链路比
  纯问答多花轮次，8 轮会在改到一半时耗尽。显式传 `--max-turns` 时不覆盖。
- 追加的 system prompt 只讲四件事：先读再改、已有文件优先 `edit_file`、只做被要求的
  最小改动、明确说出改了哪些文件。

## 9. 错误语义

写入新增三个 `WorkspaceErrorCode`：`writes_disabled`、`no_match`、`ambiguous_match`；
复用既有的 `invalid_path`、`outside_workspace`、`forbidden_path`、`not_a_file`、
`not_a_directory`、`too_large`、`binary_file`、`invalid_range`。

全部错误都以 `isError: true` 的 ToolResult 返回给模型，而不是抛给 CLI：一次失败的
编辑应该让模型换个方式再试，而不是终止整次运行。

## 10. 测试策略

`tests/write-file.test.ts`：创建 / 替换 / 建父目录 / 只读工作区拒绝 / 越界拒绝 /
经软链目录写入拒绝 / 敏感路径拒绝 / NUL 拒绝且不碰目标文件 / 未知参数拒绝。

`tests/edit-file.test.ts`：唯一匹配并报行号 / 空 `new_text` 即删除 / 歧义匹配保持
文件不变 / 无匹配保持文件不变 / no-op 编辑拒绝 / 缺失文件不创建 / 只读工作区拒绝 /
LF `old_text` 匹配 CRLF 文件并保持 CRLF / CRLF `old_text` 同样可用 / 保留 BOM /
混合行尾文件不动无关行 / 仅 CRLF 差异视为 no-op / 空 `old_text` 拒绝。

## 11. 验收标准

- [x] 不带 `--allow-writes` 时写入工具未注册，且 Workspace 层同样拒绝。
- [x] 写入通过临时文件 + `rename` 落盘。
- [x] 失败的编辑不会留下被改了一半的文件。
- [x] BOM 与统一 CRLF 在编辑后保持不变，混合行尾文件不被规范化。
- [x] 符号链接在写入任何字节之前被拒绝。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）的功能、CLI、安全模型和路线图已更新。

## 12. 不在本阶段

每次编辑前的确认提示、diff 预览、undo 日志、Shell 工具、多处替换与正则编辑、
基于 git 的回滚。

下一阶段建议先做 **Provider Registry 与凭证链**：写入能力让"这次跑在哪个模型上、
用谁的 key"变成一个需要说清楚的问题，而当时它还散落在 CLI 的分支里。
