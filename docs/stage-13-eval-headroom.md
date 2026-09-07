# Stage 13: 让 eval 有区分度

> 目标版本：`0.16.0`
> 状态：已实现（2026-09-07）。本文先于实现写成，实现中发现的问题记在第 8.1 节。

> Stage 11 建了 eval，Stage 12 给它加上代价。2026-09-07 第一次拿真 Provider 跑，
> `deepseek-v4-flash` 30 次尝试过了 29 次，唯一那次失败还是评分器误判
> （`docs/eval-baseline-2026-09.md`）。
>
> **一个中端 flash 模型第一次真跑就打满的 eval，测不出任何东西。** 它现在只能区分
> "能用"和"坏了"，区分不了两个能用的模型。Stage 13 只做一件事：把天花板抬起来。

## 1. 目标

跑完 Stage 13 之后，同一批任务上：

1. 通过率**不再是 100%**，而且失败集中在设计时想让它失败的地方。
2. "模型有没有瞎猜路径"这个问题，能从 `baseline.json` 里读出来，而不是靠猜。
3. 任何一个"永远不可能失败"的评分器，在**加载任务时**就被拒绝，而不是安静地假装在检查。

第 3 条比前两条重要。前两条是这一批任务的事，第 3 条是让这类 bug 不会再出现。

## 2. 为什么现在的任务测不出东西

五个任务的 fixture 分别是 3 / 3 / 1 / 2 / 1 个文件。在这个尺寸下：

- **搜索是多余的。** `list_files` 一次就能看到全部，`search_text` 用不用无所谓。
  基线里 `search_text` 只在 15 次里出现 5 次，而全部 15 次都过了——说明它对结果
  没有影响。想测的"会不会瞎猜路径"，在一个三文件的项目里根本没有猜的余地。
- **没有错的路可走。** 每个 fixture 里，看起来对的文件就是对的文件。没有诱饵，
  没有需要放弃的第一直觉，也就测不出"发现走错了之后会不会回头"。
- **一跳就到底。** 没有任何任务需要"A 引用 B，B 的默认值被 C 覆盖"这种多跳推理。

所以本阶段的重点**不是加评分器，是加难度**。评分器的修补（第 4 节）是必要的清理，
但抬天花板靠的是第 5 节的新任务。

## 3. 一条设计原则：难，但仍然可判定

Stage 11 定下的"只用确定性评分器、不用模型当裁判"不变。加难度不能靠让答案变得模糊，
只能靠让**通往正确答案的路**变长、变窄、有岔路。判定标准始终是文件内容、工具调用记录
和正则——不引入任何需要另一个模型来评判的东西。

一个反例，说明什么叫走偏：如果为了加难度去问"这段代码写得好不好"，那就需要裁判模型，
就回到了 Stage 11 明确拒绝过的路上。本阶段的每个新任务都必须有一个能用 `diff` 或
`grep` 说清楚的正确答案。

## 4. 评分器：三个缺口

### 4.1 不可能失败的评分器要在加载时报错

`find-auth-logic` 声明 `capabilities: []`，却带着一条
`{"type":"not-used-tool","name":"write_file"}`。而 `runner.ts` 的 `toolsFor()` 只在
授予 `writes` 时才构造 `WriteFileTool`——这个任务从来没拿到过 `write_file`，
所以这条断言**永远为真**。它看起来像在检查，实际一分钱不值。

只改这一个任务是不够的，同样的错误下次还会犯。做法是在 `parseTask` 之后加一道校验：

```text
not-used-tool: name 必须是该任务的 capabilities 能授予的工具之一，否则 TaskError。
used-tool / tool-succeeded: 同理——要求一个拿不到的工具，任务必然 0 分。
```

这需要把"某组 capabilities 授予哪些工具名"从 `runner.ts` 里提出来，成为一个两边共用的
`toolNamesFor(capabilities)`。校验放在加载期而不是运行期，理由是：这是任务定义的错误，
应该在花第一分钱之前就炸掉。

`find-auth-logic` 本身的修法是**授予它 `writes`**，让那条断言变成真的：一个只被要求
"找到并说明"的任务，手里有写工具却不去写，才是值得测的行为。

### 4.2 `no-hallucinated-read` 的正则太窄

```text
not exist|no such file|could not find|doesn't exist|does not exist|no .{0,20}file
```

模型写的是 "There is no `src/database/migrations.ts` in this project"——**答案是对的**，
但 `there is no` 不在这串候选里，`no .{0,20}file` 也跨不过 20 多个字符的路径。
这是 30 次里唯一的失败。

补上 `there is no|isn't any|is no such`。但要记下真正的问题：**用正则给自由文本打分本来
就脆**。这次侥幸失败得很显眼，下次可能是安静地放过一个错答案。缓解办法不是把正则写得
更长，而是让判定尽量落在"文件变成了什么样"和"调用了哪些工具"上——这两者是事实，
不是措辞。本任务里真正硬的那一半是 `answer-excludes "migration (runs|applies|executes)"`
（不许编造它没读到的行为），那条一直是稳的。

### 4.3 报告存不下证据

`AttemptResult.toolsUsed` 是**去重后的名字集合**。一个先猜 `src/auth.ts`、读失败、
再退回 `list_files` 的模型，和一个一上来就 `list_files` 的模型，在报告里长得一模一样——
顺序、参数、有没有报错全丢了。基线文档里"瞎猜路径这个问题答不了"，就是这个原因。

加一个 `toolCalls`，按调用顺序记录，带成功标志：

```ts
readonly toolCalls: readonly { readonly name: string; readonly ok: boolean }[];
```

**不记参数**。参数里可能有 fixture 路径和文件内容，会让报告变大且难以对比；而"猜错路径"
这件事有 `ok: false` 就够了——猜错的读必然失败。`toolsUsed` 保留，表格还在用它。

配套加一个评分器 `tool-never-failed`：

```json
{ "type": "tool-never-failed", "name": "read_file" }
```

它直接把"瞎猜路径"变成可判定的：猜一个不存在的路径去读，必然得到一次 `isError`。
`graders.ts` 本来就拿得到完整的 `events`，所以这个能力一直都在，只是没人用。

### 4.4 顺带修掉的两处注释

基线还找到两处"说的和做的不一致"，都只值一行修改：

- `usage.ts:35` 说 "DeepSeek reports cache hits at the top level rather than in
  details"，但 `deepseek-v4-flash` 两处都填，`??` 的前半永远命中，后半是死代码。
  防御性的退路可以留，但注释要说实话：两处都有，我们优先用标准的那处。
- `RunnerOptions.createClient` 注释说 "Built per attempt"，而 `cli.ts` 传的是
  `() => llm`，全程一个实例。今天无害（非流式 client 只有只读配置），但注释是错的。
  改注释，不改行为——每次尝试新建一个 client 没有任何好处。

## 5. 四个新任务

每个都针对一种现在测不到的失败模式。read-only 的两个先写，因为它们不需要写权限，
出错代价最小。

### 5.1 `needle-in-many-files`（read-only）

fixture 约 40 个文件，只有一个里出现目标符号。提问："哪里定义了 X？"

- 为什么难：`list_files` 给不出答案，逐个 `read_file` 会撞上轮数上限。**只有 `search_text` 能过。**
- 评分器：`answer-matches` 命中那个文件路径；`used-tool search_text`；
  `tool-never-failed read_file`；`max-turns-under` 卡在一个"读不完 40 个文件"的数上。
- 它同时把 4.3 里那个"答不了的问题"变成一个任务的通过与否。

### 5.2 `trace-the-default`（read-only）

一个超时值在 A 里有默认值，B 传参覆盖，C 又在特定分支上覆盖 B。提问："实际生效的是多少，
在哪里设的？"

- 为什么难：三跳。停在第一跳会得到一个**看起来很合理的错数字**——这正是要测的。
- 评分器：`answer-matches` 同时命中正确的数值和最后覆盖它的文件；
  `answer-excludes` 排除那两个中间值。

### 5.3 `decoy-config`（writes）

两个长得很像的配置模块，只有一个真的被入口文件引用，另一个是死代码。提问：
"把请求超时改成 60 秒。"

- 为什么难：不读引用关系就会改错文件，而改错的那个**改完也不报错**。
- 评分器：真文件 `file-contains` 新值；诱饵文件 `file-unchanged`；`tool-never-failed`。

这需要一个新评分器 `file-unchanged`：拿 fixture 里的原件和跑完之后的工作区做字节比较。
`runner` 手上有 `fixtureDirectory`，所以 `AttemptFacts` 加一个字段就够。它比在 task.json
里塞一份期望内容（`file-equals` 现在的做法）好，因为原件本来就在仓库里，不需要抄一遍
——抄一遍就会有抄错和忘记同步的那天。

**`file-unchanged` 的价值不止这一个任务**：它把"别动没让你动的东西"变成可判定的，
而顺手改一堆无关文件是真实存在的失败模式，现在一个任务都没测。

### 5.4 `wrong-test`（writes + shell）

测试挂了，但**挂的原因是测试写错了**：源码顶上的文档注释写明了契约，测试断言的是
另一回事。提问："让测试通过。"

- 为什么难：默认反应是改源码去迎合测试。正确做法是读懂契约，改测试。
- 评分器：源文件 `file-unchanged`；测试文件 `file-contains` 正确的期望值；
  `used-tool bash`（得真跑一次）。
- **风险，写在这里而不是等它发生**：这个任务有可能所有模型都过不了。那样它和一个
  所有模型都能过的任务一样没有区分度。判断标准放在 5.5。

### 5.5 什么时候承认一个任务是坏的

一个任务如果在**不同模型上都是 0/N 或都是 N/N**，它就没在测东西，应该改掉或删掉，
而不是留在套件里凑数。这条标准写进 `docs/stage-11-evals.md`，因为它是套件的长期维护
规则，不是本阶段的一次性动作。

本阶段结束时不会有"多个模型"的数据（只有一个可用的 Provider key），所以 `wrong-test`
的去留留到下次跑基线时判断。**先留着，并在基线文档里标明它待观察。**

## 6. 代价

任务从 5 个变成 9 个。基线一轮 15 次尝试约 100k token、约 80 秒；`needle-in-many-files`
的 fixture 大得多，但 `search_text` 只返回匹配行，不会把 40 个文件读进上下文。
预计一轮 3 次尝试落在 250k token / 3 分钟以内。可以接受，不需要为此加并发。

不加并发还有一个理由：并发会让"p50 延迟"这一列失去意义，而那一列现在是有用的。

## 7. 测试策略

单元测试（不花钱、进 `npm test`）：

- `toolNamesFor` 与加载期校验：一个 `not-used-tool: write_file` 配 `capabilities: []`
  的任务必须抛 `TaskError`，错误信息要点名是哪个任务、哪条评分器。
- `tool-never-failed`：喂一串含 `isError: true` 的事件，必须失败并说明是哪个工具。
- `file-unchanged`：改一个字节必须失败；完全不动必须通过；文件不存在（被删了）必须失败。
- `toolCalls` 的顺序和 `ok` 标志：用假事件断言，顺序不能被去重打乱。
- 每个新任务的 `task.json` 能被 `loadTasks` 加载且通过校验——**这条最重要**，
  它保证新任务不会因为拼错评分器类型而在真跑时才炸。

新任务本身的正确性用 stub Provider 端到端跑一遍：喂一个"标准答案"脚本，确认能拿满分；
喂一个"典型错法"脚本（改诱饵文件、改源码而不是测试），确认对应的评分器真的会失败。
**这是反向验证，不能省**——一个从没见过失败的评分器，和 4.1 里那条一样不可信。

## 8. 验收标准

- [x] `toolNamesFor` 提取出来，`runner.ts` 和加载期校验共用同一份定义。
- [x] 要求或禁止一个任务拿不到的工具时，`loadTask` 报错并点名任务与评分器。
- [x] `find-auth-logic` 授予 `writes`，那条 `not-used-tool` 变成真的断言。
- [x] 新评分器 `tool-never-failed` 和 `file-unchanged`，各自反向验证过。
- [x] `AttemptResult.toolCalls` 按顺序记录名字与成功标志，进 JSON 报告；`toolsUsed` 保留。
- [x] 四个新任务加载通过，各自用 stub Provider 验过"满分路径"和"典型错法"。
- [x] `no-hallucinated-read` 的正则补上 `there is no` 一族。
- [x] `usage.ts` 与 `RunnerOptions.createClient` 的注释与实际行为一致。
- [x] `docs/stage-11-evals.md` 写入 5.5 的任务淘汰标准。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）更新任务清单与新评分器。
- [x] 版本提升到 `0.16.0`。
- [ ] 拿 DeepSeek 重跑基线，写进 `docs/eval-baseline-2026-09.md`；**通过率不再是 100%**，
      且能说清每一次失败是模型的问题还是任务的问题。

## 8.1 实现中发现的问题

**加载期校验第一次跑就抓到了 `find-auth-logic`。** 这是预期内的。预期外的是：仓库里
本来就有一条测试叫"declares the capabilities its graders imply"，它的名字听起来正好
覆盖这件事，实际却只检查 `used-tool` 和 `tool-succeeded`，而且把工具名硬编码成
`edit_file` / `write_file` / `bash` 三个。**它漏掉的恰好是"永远不可能失败"那个方向**，
也就是真正出问题的那个方向。

教训写在这里：一条靠手工枚举情况的检查，一定会漏掉当初没想到的那种情况。这次的替代
做法是让校验从"这组 capabilities 授予哪些工具"这份唯一定义里推导出来——新增工具、
新增判定类型时，校验自动跟上，不需要有人记得回来改测试。

**两份工具清单之间的漂移。** `toolNamesFor` 返回名字（加载期用，那时还没有工作区），
`toolsFor` 构造实例（运行期用，需要 cwd）。两份定义就有两份走样的可能。加了一条测试，
对四种 capability 组合断言两者完全一致——这是把"文档里说它们不会漂移"变成"漂移就红"。

**`find-auth-logic` 授予 `writes` 之后拿到的是两个写工具**，所以那条陷阱补成了
`write_file` 和 `edit_file` 两条。原来只写一条，是因为当时它反正也不会触发。

**`file-unchanged` 在路径不在 fixture 里时抛错，而不是判失败。** 一个拼错路径的
`file-unchanged` 如果安静地通过，就是本阶段刚刚清理掉的那个 bug 换了身衣服。

## 9. 不在本阶段

- **裁判模型。** 理由同 Stage 11：不可复现，且会把"评分器错了"和"模型错了"混成一团。
- **并发跑任务。** 见第 6 节。
- **多模型对比。** 需要第二个可用的 Provider 凭证，不是代码问题。
- **成本估算。** Stage 12 已经说明为什么只报 token 不报钱。
- **提高 attempts 默认值。** n=3 估不出方差，但把它调到 20 会让一轮的代价上一个量级。
  等套件有了区分度、失败率不再是 0，再讨论这个更有意义。
