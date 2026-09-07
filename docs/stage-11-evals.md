# Stage 11: Evals

> 目标版本：`0.13.0`
> 状态：已实现（2026-09-06）。本文先于实现写成，偏离之处记在第 11.1 节。

> 到 Stage 10 为止，chivgent 有十个阶段的能力：工具、发现、流式、会话、压缩、写入、
> Shell、扩展、远程。**而没有任何东西在衡量这个 Agent 到底能不能把活干成。**
> 301 个单元测试全部在验证"代码是否按我写的那样运行"，没有一个在回答"它是不是一个
> 好用的 Agent"。Stage 11 只解决这一件事。

## 1. 目标

```text
evals/<task>/
  task.json          prompt、能力要求、判定条件
  fixture/           初始工作区，每次尝试都复制一份新的
       |
       v
  npm run eval  ->  对每个任务跑 N 次
                      每次：新建临时工作区 -> 真实 Provider -> 记录事件
                      -> 判定 -> 通过率、轮数、工具调用、耗时
                    -> 表格 + JSON 报告
```

完成后：

1. `npm run eval` 能回答"这个 Agent 在这批任务上的通过率是多少"。
2. 改了 system prompt 或工具描述之后，能看出**变好还是变坏**，而不是靠感觉。
3. 每个任务的失败有具体原因，不是一个红叉。
4. `npm test` 保持免费、确定、离线——evals 是另一回事。

## 2. Evals 不是测试

这是整个阶段最需要先说清的一条，否则后面每个决定都会走偏。

| | 单元测试 | Eval |
| --- | --- | --- |
| 被测对象 | 我写的代码 | 模型 + 我的 harness 一起 |
| 确定性 | 必须确定 | 天然不确定 |
| 结果 | 通过 / 失败 | **通过率** |
| 花钱 | 不 | 是 |
| 门禁 | 挡合并 | 不挡合并，提供信息 |
| 跑的时机 | 每次改动 | 改 prompt / 换模型 / 加工具时 |

**一次运行说明不了任何事。** 同一个任务同一个模型跑五次可能三次成功，那么"通过"和
"失败"都不是这次运行的属性，而是这个组合的属性。因此 eval 的基本单位是
**N 次尝试的通过率**，不是一次的布尔值。

推论：**evals 绝不进 CI 门禁**。让 CI 花钱、并且以 60% 的概率变红，会在两周内训练所有
人忽略 CI。`npm test` 依然是那个必须全绿的东西。

## 3. 设计原则

1. **判定优先确定性。** 能用文件内容和工具调用记录判定的，绝不用模型判定。
2. **每次尝试都是干净的。** fixture 复制到新的临时目录，不复用、不清理式复用。
3. **通过率而不是通过。** 报告里永远带样本数。
4. **失败要有原因。** "没通过"没有信息量，"没有调用 search_text，直接读了 12 个文件"有。
5. **Runner 自身可测。** 它是代码，必须能用假 Provider 在 `npm test` 里验证，不花钱。
6. **不加依赖。** pi 用了外部的 `vitest-evals`；chivgent 自己写一个小 runner。

## 4. 任务定义

```jsonc
// evals/rename-symbol/task.json
{
  "name": "rename-symbol",
  "prompt": "把 src/greet.ts 里的 sayHi 重命名成 greet，包括调用处。",
  "capabilities": ["writes"],          // 需要 --allow-writes
  "attempts": 5,
  "maxTurns": 12,
  "graders": [
    { "type": "file-contains", "path": "src/greet.ts", "text": "export function greet(" },
    { "type": "file-excludes", "path": "src/greet.ts", "text": "sayHi" },
    { "type": "file-contains", "path": "src/main.ts", "text": "greet(" },
    { "type": "used-tool", "name": "edit_file" },
    { "type": "not-used-tool", "name": "write_file" }
  ]
}
```

`fixture/` 是同目录下的一棵文件树，每次尝试原样复制进临时工作区。

最后两条判定值得单独说：这个任务真正想验证的不只是"改对了"，而是
**"用对了工具"**——整文件重写也能得到正确结果，但那是错误的做法，一个只看结果的
eval 会给它满分。对编码 Agent 来说，工具误用是比答错更常见、也更值得测的失败。

## 5. 判定器

第一批全部是确定性的：

| type | 判定 |
| --- | --- |
| `file-contains` / `file-excludes` | 结束时工作区里某文件的内容 |
| `file-exists` / `file-absent` | 文件是否存在 |
| `used-tool` / `not-used-tool` | 运行中是否调用过某工具 |
| `tool-succeeded` | 某工具至少有一次非错误结果 |
| `answer-matches` | 最终回答匹配某个正则 |
| `max-turns-under` | 轮数不超过 N |

**LLM-judge 推迟到本阶段之后。** 理由：判定器本身是测量仪器，用一个不确定的仪器去测量
不确定的对象，两个误差会叠加，而你无法分辨"Agent 变差了"和"判官今天心情不同"。
先把能确定判定的任务做扎实；等真的遇到"只能由人判断好坏"的任务时再引入，并且要在
报告里标成低置信度。

## 6. 报告

```text
task                 pass   attempts  turns  tools                        p50 time
rename-symbol        4/5    5         6.2    read_file,edit_file          8.4s
find-auth-logic      5/5    5         3.0    list_files,search_text       4.1s
fix-failing-test     2/5    5         11.8   read_file,edit_file,bash     31.2s

overall              11/15 (73%)
```

失败的尝试另起一段列出原因：

```text
rename-symbol attempt 3: file-excludes src/greet.ts "sayHi" — still present at line 14
fix-failing-test attempt 1,4,5: max_turns reached without a final answer
```

同时写一份 JSON（`--json` 或固定落到 `.eval/`），便于跨版本对比——**这才是 eval 的价值
所在**：不是某一次的绝对数字，而是改了 prompt 之后 73% 变成了 61% 还是 84%。

## 7. Runner 的结构

```text
src/evals/
  task.ts        任务定义的解析与校验
  fixture.ts     fixture 复制到临时工作区
  graders.ts     判定器实现与注册表
  runner.ts      跑一个任务 N 次，聚合结果
  report.ts      表格与 JSON 输出
bin/
  eval.ts        CLI 入口（npm run eval）
```

Runner 复用现有的一切：`Agent`、`LocalWorkspace`、Provider 注册表、事件流。判定"用过哪些
工具"直接读 `tool_execution_end` 事件——这是 Stage 3 事件模型的又一次兑现，
不需要为了 eval 在 Agent 里加任何钩子。

**Provider 可注入**：runner 接受一个 `LLMClient`。真实运行用注册表构造，
runner 自身的单元测试传 `FakeLLMClient`——所以 runner 有测试，且不花钱。

## 8. CLI

```bash
npm run eval                      # 跑 evals/ 下全部任务
npm run eval -- --task rename-symbol
npm run eval -- --attempts 10     # 覆盖任务里的 attempts
npm run eval -- --json report.json
npm run eval -- --provider deepseek --model deepseek-v4-flash
DEEPSEEK_API_KEY=sk-... npm run eval -- --provider deepseek
```

需要凭证，走既有的凭证解析链。没有凭证时报出和 CLI 一致的那条消息，而不是跑出一堆
0 分。

实现修正：`--provider` / `--model` / `--api-key` 都原样转发给主 CLI 的 parser。
`--api-key` 最初被漏掉了 —— 凭证链把它列为优先级最高的来源，缺凭证的报错也让用户
"传 --api-key"，但 eval 入口会直接以 `Unknown option` 拒掉它。在一台临时机器上，
key 正是以参数形式送进来的，那台机器上 eval 根本跑不起来。

## 9. 第一批任务

刻意少而有代表性，每一个对应一种已知的失败模式：

1. **find-auth-logic**（只读）——不给路径，问"认证逻辑在哪"。测发现链路：应该
   `list_files` → `search_text` → `read_file`，而不是猜路径。
2. **rename-symbol**（写入）——测 `edit_file` 而不是整文件重写。
3. **fix-failing-test**（写入 + Shell）——给一个失败的测试，要求修好。测完整闭环：
   跑测试 → 读错误 → 改代码 → 再跑。这是唯一需要 `--allow-shell` 的任务。
4. **respect-line-endings**（写入）——fixture 用 CRLF，改一行，验证其他行的行尾没被
   改动。这是 0.7.1 修过的 bug，把它变成一个持续的回归 eval。
5. **no-hallucinated-read**（只读）——问一个工作区里不存在的文件。正确行为是说不存在，
   而不是编造内容。

第 4 项说明了 eval 相对单元测试的独特价值：单元测试能验证 `edit_file` 保留 CRLF，
但**不能验证模型会不会用一种绕开这个保护的方式去改文件**。

## 10. 测试策略

Runner 自身的单元测试（在 `npm test` 里，用假 Provider）：

1. 任务解析：合法任务、缺字段、未知 grader 类型、非法 attempts。
2. fixture 隔离：两次尝试互不影响；一次尝试写坏了文件不影响下一次。
3. 每个判定器各自的通过与失败分支。
4. 聚合：5 次里 3 次通过 → 通过率 3/5，且失败原因都在。
5. 能力门控：任务要求 `writes` 而运行时没开，报错而不是静默跑一个必然失败的任务。
6. `max_turns` 结束被计为失败并给出原因。
7. 报告：表格与 JSON 的形状稳定。

**不测**：真实模型的通过率。那是 eval 要输出的数据，不是要断言的东西。

## 11. 验收标准

- [x] `npm run eval` 能跑完任务并输出通过率表格（端到端用 stub Provider 验证过）。
- [x] 每次尝试在独立的临时工作区中运行，互不影响。
- [x] 失败带具体原因，包含实际答案或实际调用的工具。
- [x] 工具使用作为判定条件生效——端到端验证过：让 stub 用 `write_file` 写出**完全正确**
      的文件内容，任务依然判为失败，并指出"called write_file 2 time(s)"。
- [x] Runner 自身有单元测试（37 条），不需要凭证、不花钱。
- [x] evals 不进 CI 门禁，`npm test` 依然免费且确定。
- [x] JSON 报告含 passRate、meanTurns、每次尝试的明细。
- [x] 缺凭证时报出与主 CLI 一致的配置错误。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过（338 个测试）。
- [x] README（中英）新增 evals 章节，说明它与测试的区别。
- [x] 版本提升到 `0.13.0`。

## 11.1 实现修正

1. **提示词从 `cli.ts` 抽到了 `src/prompts.ts`。** 实现时才发现：`cli.ts` 在被 import
   时就会执行 `main()`，所以 eval runner 根本无法从它那里取到 system prompt。而 runner
   **必须**用和真实 CLI 一模一样的提示词——否则测的是另一个 Agent，数字没有意义。
   这是一个由本阶段暴露出来的既有结构问题。
2. **eval CLI 的参数解析也单独拆成了 `parse-args.ts`**，同样因为入口文件有 import 副作用，
   否则测试参数解析会顺带启动一次 eval。
3. **多了两条判定器**：`file-equals`（逐字节相等，`respect-line-endings` 需要它来验证
   未被修改的行）和 `answer-excludes`（`no-hallucinated-read` 需要它来禁止编造行为）。
4. **多了一条"任务自检"测试**：shipped 的 `evals/*/task.json` 全部要能解析，且每个判定器
   都能构造。task.json 里的拼写错误应该在 `npm test` 里暴露，而不是在花钱跑完一轮之后。
5. **崩溃的尝试算作一次失败，而不是让整轮 eval 中止。** 设计里没写清楚这一点；
   实现时的判断是：一次运行崩溃本身就是要测量的现象之一。

## 11.2 任务淘汰标准（Stage 13 加入）

一个任务如果在**不同模型上都是 0/N 或都是 N/N**，它就没在测东西，应该改掉或删掉，而不是
留在套件里凑数。全过和全挂一样没有信息量——前者说明太简单，后者说明要么太难，要么评分器
写错了，而这两种情况从分数上分辨不出来，必须去读失败原因。

对应的动作：把任务改难 / 改对，或者删掉。**不要**因为"它一直过"就当作质量证据——
2026-09 的第一次真实基线里五个任务全过，实际说明的是套件没有区分度
（见 `docs/eval-baseline-2026-09.md` 和 `docs/stage-13-eval-headroom.md`）。

## 12. 不在本阶段

LLM-judge、多模型对比表与配对统计（pi 的 `summary.ts` 做了 438 行的配对指标与
correctness lift）、并发执行、结果的历史数据库与趋势图、把 evals 接进 CI、
按成本预算限流、评测 Shell 之外的副作用。

下一阶段：**TUI 或到此为止**。Roadmap 上只剩它。等这批 evals 有了数据再决定值不值得——
如果数据显示 Agent 的失败集中在工具选择而不是交互体验上，那 18 000 行的差分渲染器
就不是下一个该做的东西。
