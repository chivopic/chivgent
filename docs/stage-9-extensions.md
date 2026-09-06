# Stage 9: 扩展系统与 Project Trust

> 目标版本：`0.11.0`
> 状态：已实现（2026-09-06）。本文先于实现写成，实现过程中修正的地方标注为
> **实现修正**。

> 到 Stage 8 为止，chivgent 能做的事完全由它自己的代码决定：工具是内置的五个，
> 斜杠命令是写死的五条。想加一个只对某个项目有意义的工具，只能改 chivgent 本身。
> Stage 9 解决"用户可以扩展它"这一件事——而这立刻带来一个前置问题：从项目目录里
> 加载并执行代码，凭什么认为那份代码是可信的。所以扩展系统和 Project Trust 是
> 同一个阶段，不能拆开。

## 1. 目标

```text
启动
  -> 发现扩展
       <CHIVGENT_HOME>/extensions/     用户级，始终加载
       <cwd>/.chivgent/extensions/     项目级，受 trust 门控
  -> ProjectTrustStore.decide(cwd)
       已记录 -> 直接用
       未记录 + TTY -> 询问，记录
       未记录 + 非 TTY -> 不信任，跳过
  -> import() 每个扩展模块
  -> extension(api)
       api.registerTool()
       api.registerCommand()
       api.on(event)
       api.contributeSystemPrompt()
```

完成后：

1. 在项目里放一个 `.chivgent/extensions/x.js` 就能给这个项目加一个工具。
2. 第一次进入带扩展的项目会被问一次是否信任，之后记住。
3. 非交互环境（CI、管道）默认不信任，不会静默执行项目代码。
4. 一个坏扩展不会让 chivgent 起不来。

## 2. 为什么信任的单位是"项目目录"

这是本阶段最需要想清楚的一件事，值得先写下来。

扩展是**在 chivgent 进程内执行的任意 Node 代码**。它不受 Workspace 的路径边界约束，
不需要 `--allow-shell` 就能 `child_process.exec`，也能读到 `process.env` 里的 API Key。
换句话说：

> **信任一个项目 == 允许这个仓库的作者以你的身份在你的机器上执行代码。**

这跟 `--allow-shell` 是同一量级的授权，但触发方式危险得多：`--allow-shell` 要你亲手
敲，而扩展只要你 `cd` 进一个 clone 下来的仓库就会被加载。一个在 README 里写着
"用 chivgent 跑一下试试"的恶意仓库，不需要你运行任何命令。

所以门控必须发生在**加载之前**，且单位是目录而不是单个文件：逐个文件问等于没问。
这也解释了为什么 Stage 8 拒绝逐命令确认、这里却要弹窗——两者的区别不是"要不要打扰
用户"，而是**这次询问是否对应一个用户真的能判断的决定**。"你信任这个仓库吗"用户答得
上来；"你允许执行 `sed -i s/a/b/ x.ts` 吗"第三十次之后没人在读。

用户级扩展（`<CHIVGENT_HOME>/extensions/`）不需要门控：那是用户自己往自己家目录里
放的东西，等同于他自己的配置。

## 3. 设计原则

1. **门控在加载前，不在调用时。** 代码一旦 import 就已经跑了顶层语句。
2. **默认不信任。** 没有明确记录、又问不到人（非 TTY）时，跳过项目扩展。
3. **决定是持久的、按目录记的，可以撤销。** 记在 `<CHIVGENT_HOME>/trust.json`。
4. **一个扩展的失败是它自己的事。** 加载失败、注册冲突、回调抛异常都不能影响运行。
5. **扩展不能覆盖内置能力。** 同名工具一律拒绝注册，保留内置的那个。
6. **扩展 API 面越小越好。** 这一版只开四个入口，宁可以后再加。

## 4. Project Trust

### 4.1 存储

`<CHIVGENT_HOME>/trust.json`：

```jsonc
{
  "/home/me/work/api-server": true,
  "/home/me/downloads/some-clone": false
}
```

键是规范化后的绝对路径（`realpath` 之后），值是 `true` / `false`。

**按最近祖先查找**：判断 `/home/me/work/api-server/packages/core` 时，从它自己开始
逐级向上找，第一个命中的条目说了算。这样"信任 `~/work`"就覆盖了它下面所有仓库，
不必对每个子包都答一次。

### 4.2 何时询问

只有在**项目里确实存在需要信任的东西**时才问——即 `<cwd>/.chivgent/` 下存在
`extensions/`。没有就完全不打扰用户，这一步对绝大多数项目是不可见的。

| 情况 | 行为 |
| --- | --- |
| 已记录 `true` | 加载项目扩展 |
| 已记录 `false` | 跳过，不再询问 |
| 未记录 + stdin 是 TTY | 询问，记录答案 |
| 未记录 + 非 TTY | 跳过，stderr 一行说明 |
| `--no-extensions` | 跳过一切扩展，连问都不问 |

询问的文案必须说清后果，而不是问"是否信任"就完事：

```text
This project has chivgent extensions:
  .chivgent/extensions/lint-tool.js

Extensions run as code inside chivgent, with your permissions. They are not
limited by the workspace boundary and do not need --allow-shell.

  [t] trust this project        [p] trust /home/me/work (parent)
  [n] do not trust              [o] not now (ask again next time)
```

"trust parent" 这一项来自 pi，很实用：monorepo 里逐个子目录回答很烦。

### 4.3 撤销

新增 `--forget-trust` 清除当前工作区对应的条目（含命中的祖先条目），下次重新询问。
文件本身是给人读和手改的，格式保持简单。

## 5. 扩展的形状

```js
// .chivgent/extensions/word-count.js
export default function (api) {
  api.registerTool({
    name: "word_count",
    description: "Count words in a workspace file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context) {
      const file = await context.workspace.readTextFile(args.path);
      return { content: `${file.content.split(/\s+/).length} words`, isError: false };
    },
  });

  api.registerCommand("wc", {
    description: "Show how many messages this session holds",
    run: (context) => context.write(`${context.session.messages.length}\n`),
  });

  api.on("tool_execution_end", (event) => {
    if (event.isError) process.stderr.write(`(${event.toolName} failed)\n`);
  });

  api.contributeSystemPrompt("Prefer word_count over reading a whole file to count words.");
}
```

默认导出一个函数，接收 `api`，同步注册。这与 pi 的
`export default function (pi: ExtensionAPI)` 是同一形状——扩展作者的直觉可以迁移。

### 5.1 只加载 JavaScript，不加载 TypeScript

pi 用 jiti 在运行时编译 `.ts` 扩展。chivgent 现在只有两个运行时依赖
（`ignore`、`openai`），为了扩展再引入一个 TS 运行时加载器不划算：动态 `import()`
一个 `.js` 是零依赖的。用 TypeScript 写扩展的人自己编译成 `.js` 即可。

这是一个明确的取舍，不是遗漏。如果以后扩展生态真的起来了，再引入加载器也不迟。

### 5.2 发现规则

```text
extensions/x.js            -> 加载
extensions/x/index.js      -> 加载
extensions/x/other.js      -> 不加载（不递归）
```

只下探一层。比这更复杂的包结构不是这一阶段要解决的问题。

用户级目录先于项目级加载，因此项目扩展注册的名字撞车时，先到的（用户的）保留。

## 6. ExtensionAPI（v1）

```ts
interface ExtensionAPI {
  /** 注册一个模型可调用的工具。名字与内置工具或已注册工具冲突时拒绝。 */
  registerTool(tool: Tool): void;
  /** 注册一条 REPL 斜杠命令。名字不带斜杠。 */
  registerCommand(name: string, command: ExtensionCommand): void;
  /** 订阅运行时事件。只读：返回值被忽略，异常被隔离。 */
  on(type: AgentEvent["type"], handler: (event: AgentEvent) => void): void;
  /** 追加一段 system prompt。按扩展加载顺序拼接在内置提示词之后。 */
  contributeSystemPrompt(text: string): void;
}
```

四个入口，刻意的下限。pi 的 `ExtensionAPI` 有近 1800 行类型定义（UI 覆盖层、键位、
Provider 注册、渲染器、编辑器组件……），那是一个成熟 TUI 产品的表面积。chivgent
现在没有 TUI，注册键位没有意义；等 Stage 10 有了 TUI 再谈。

**没有 `off()`**：扩展的生命周期就是进程的生命周期，取消订阅没有使用场景，加了反而
要处理"注册到一半被移除"的状态。

## 7. 失败隔离

| 失败 | 行为 |
| --- | --- |
| 模块 import 抛异常 | stderr 一行（扩展路径 + 消息），跳过它，继续 |
| 默认导出不是函数 | 同上 |
| 注册函数抛异常 | 同上；它此前成功注册的东西保留 |
| 工具重名 | 拒绝这一次注册，stderr 说明是哪个扩展撞了哪个名字 |
| 命令重名 | 同上 |
| 事件回调抛异常 | 静默隔离，与 session 订阅者一致 |
| 工具 `execute` 抛异常 | 走既有路径，变成一条 `isError` 的 ToolResult |

原则：**chivgent 必须能在任何扩展坏掉的情况下启动并工作。** 扩展是加分项，不是依赖。

## 8. 对既有模块的影响

- `src/extensions/`：新目录，含 trust store、发现、加载、API 实现。
- `cli.ts`：启动时解析 trust、加载扩展，把注册到的工具并入工具列表、把
  system prompt 贡献拼接进去。
- `repl.ts`：`handleSlashCommand` 增加一个"扩展命令表"参数；`/help` 与 `/tools`
  要显示扩展来的命令和工具，并标出来源，否则用户无法分辨哪些是内置的。
- `cli-options.ts`：新增 `--no-extensions`、`--forget-trust`。
- 新增 `--extensions` 列出已加载的扩展及其注册内容后退出，方便排查。

**不受影响**：Agent、Workspace、Provider、Context 全都不需要知道扩展的存在。工具就是
工具，事件就是事件——这正是前八个阶段划清边界的回报。

## 9. 测试策略

1. Trust store：读写、最近祖先命中、`false` 不再询问、非法 JSON 报错而非静默忽略。
2. 路径规范化：符号链接与 `..` 在写入前解析，两条等价路径不产生两条记录。
3. 决策矩阵：上表六种情况各一条。
4. 发现：单文件、`x/index.js`、不递归、空目录、目录不存在。
5. 加载：正常注册；import 抛异常被跳过且不影响其他扩展；默认导出不是函数。
6. 冲突：扩展工具与内置工具重名被拒绝，内置的仍然可用。
7. API：四个入口各自生效——工具进入模型的工具列表、命令能在 REPL 触发、事件收得到、
   system prompt 出现在请求里。
8. 隔离：事件回调抛异常不影响运行结果。
9. 端到端：带 `.chivgent/extensions/` 的临时工作区 + 已记录信任，模型能调到扩展工具。

第 6 项要断言的是"内置工具仍然可用"，而不只是"注册失败"——否则一个撞名的扩展
可能悄悄让 `read_file` 消失。

## 10. 验收标准

- [x] 项目扩展在没有信任记录且非 TTY 时不被加载。
      （端到端验证：非 TTY 下即使模型硬调扩展工具，也只拿到 `Unknown tool`。
      这条断言做了反向验证——把无终端时的默认改成信任，测试立刻失败。）
- [x] 信任决定持久化，按最近祖先命中，可用 `--forget-trust` 撤销。
- [x] 询问文案说明后果（进程内执行、不受工作区限制、不需要 `--allow-shell`）。
- [x] 用户级扩展始终加载，不受项目信任影响。
- [x] 四个 API 入口都生效。
- [x] 任何单个扩展的失败都不影响启动和其他扩展。
- [x] 扩展无法覆盖内置工具，且内置工具仍然可用。
- [x] `/help` 区分内置与扩展来源；另有 `--extensions` 列出全部注册内容。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过（268 个测试）。
- [x] README（中英）新增扩展章节，安全模型说明信任的含义。
- [x] 版本提升到 `0.11.0`。

## 10.1 实现修正

1. **`/tools` 没有改成区分来源。** 它列的是 `session.toolNames`，也就是 Agent 实际
   持有的工具名，扩展来的工具本来就在里面。要在那里标注来源，得把注册表一路传进
   Session，为一行显示改动模块边界并不值得——`--extensions` 已经把来源、路径、
   注册内容都列全了。`/help` 仍然把扩展命令单独分组，因为命令表本来就分两处。
2. **多了一个"not now"选项。** 设计里只有信任 / 信任父目录 / 拒绝三项，实现时加了
   第四项：本次不加载、也不记录，下次再问。用户第一次看到这个提示时未必想当场做
   永久决定，而把"没想好"记成"永不信任"是把犹豫误读成拒绝。无法识别的输入也走这一支。
3. **信任文件读取失败不阻断启动。** 设计只说了"非法 JSON 报错而非静默忽略"。实现里
   错误会打印，但随后按"未信任"继续运行——一个坏掉的 `trust.json` 不该让 chivgent
   完全不能用。

## 11. 不在本阶段

TypeScript 扩展加载、扩展注册 Provider、扩展注册键位与 UI 组件（等 TUI）、
扩展间依赖与加载顺序声明、npm 分发的扩展包、扩展的权限细分（本阶段是全有或全无）、
skills / prompts 等其他项目级资源（trust 已经为它们准备好了，但本阶段只接扩展）。

下一阶段建议做 **TUI**：扩展 API 里被砍掉的那一半（覆盖层、键位、渲染器）都在等它，
而 TUI 也是 chivgent 与 pi 之间剩下的最大差距。
