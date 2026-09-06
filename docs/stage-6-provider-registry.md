# Stage 6: Provider Registry 与凭证解析链

> 本文记录 `0.8.0` 的增量设计。到 Stage 5 为止，"支持哪些 Provider"和"key 从哪来"
> 都写死在 CLI 的分支里：每加一个 Provider 就要改 `cli-options.ts`、`client.ts` 和
> 帮助文本三处。Stage 6 只解决"加 Provider 是一条声明、拿 key 是一条链"这一件事，
> 不引入配置文件、模型别名或 OAuth。

## 1. 目标

```text
CLI --provider X --api-key K
  -> ProviderRegistry.get("X")     -> ProviderDefinition
  -> CredentialResolver.resolve()  -> runtime -> env -> auth.json
  -> definition.createClient()     -> LLMClient
```

完成后：

1. 新增一个 OpenAI 兼容 Provider 只需要往 `BUILTIN_PROVIDERS` 加一条声明。
2. `--help` 里的 Provider 列表、环境变量和默认模型由注册表生成，不再手写。
3. API key 有一条明确的优先级链，且可以在不改文件的情况下临时覆盖。
4. "缺了什么"的错误信息由声明推导，能准确说出该设哪个变量。

## 2. 设计原则

1. **Provider 是数据，不是分支。** 差异用 `ProviderDefinition` 的字段表达，只有真正
   需要不同协议实现的（Responses、DeepSeek 的 reasoning 续写）才写代码。
2. **注册表不认识 CLI。** 它只回答"有哪些 id、这个 id 的定义是什么"，因此测试可以
   构造一个 CLI 从未听说过的 Provider。
3. **凭证来源是可枚举的链，顺序是约定的一部分。** `--api-key` > 环境变量 > 认证文件。
4. **凭证只带来源标签，不带 key。** `Credential.origin` 用于诊断，任何日志和错误信息
   都不得包含 key 本身。
5. **配置文件不执行任何东西。** 只接受字面量字符串。
6. **错误信息由定义推导。** 缺 key/模型/base URL 时，直接报出该 Provider 声明的变量名。

## 3. ProviderDefinition

```ts
interface ProviderDefinition {
  readonly id: string;
  readonly envKeys: readonly string[];        // 按顺序查找 API key
  readonly modelEnvKeys: readonly string[];   // 按顺序查找默认模型
  readonly defaultModel?: string;
  readonly baseUrlEnvKeys: readonly string[];
  readonly defaultBaseURL?: string;
  readonly requiresModel: boolean;
  readonly requiresBaseURL: boolean;
  createClient(config: ProviderClientConfig): LLMClient;
}
```

模型解析顺序：`--model` → `modelEnvKeys` → `defaultModel`。
base URL 解析顺序：`baseUrlEnvKeys` → `defaultBaseURL`。

绝大多数 Provider 只是"OpenAI 兼容 Chat Completions + 一个 base URL"，所以有
`compatibleProvider()` 这个声明助手，一条记录就是一个 Provider：

```ts
compatibleProvider({
  id: "groq",
  envKeys: ["GROQ_API_KEY"],
  modelEnvKeys: ["GROQ_MODEL"],
  defaultBaseURL: "https://api.groq.com/openai/v1",
})
```

内置七个：`openai`（Responses）、`deepseek`（reasoning 续写）、`openai-compatible`
（必须显式给 base URL 和模型）、`openrouter`、`groq`、`xai`、`moonshot`。
后四个都是声明，没有对应的实现文件。

## 4. ProviderRegistry

```ts
class ProviderRegistry {
  constructor(definitions?: readonly ProviderDefinition[]);
  register(definition: ProviderDefinition): void;  // 重复 id 直接抛错
  has(id: string): boolean;
  get(id: string): ProviderDefinition;             // 未知 id 的错误里列出全部合法 id
  ids(): readonly string[];
}
```

`defaultProviderRegistry` 是内置定义的单例。`parseCliArgs()` 和 `helpText()` 都接受
一个注册表参数，默认用它——这既是依赖注入，也是测试能注册假 Provider 的原因。

`--provider` 的校验因此变成 `registry.has(value)`，`Provider` 类型退化成 `string`：
合法性由注册表在运行时决定，不再由联合类型在编译期枚举。

## 5. 凭证解析链

```ts
interface CredentialSource {
  readonly name: string;
  read(provider: ProviderDefinition): Promise<Credential | undefined>;
}
```

三个实现，按此顺序放进 `CredentialResolver`：

| 顺序 | 来源 | 取值 | origin |
| --- | --- | --- | --- |
| 1 | `RuntimeCredentialSource` | `--api-key` | `--api-key` |
| 2 | `EnvCredentialSource` | `provider.envKeys` 按声明顺序 | 命中的变量名 |
| 3 | `FileCredentialSource` | `<CHIVGENT_HOME>/auth.json` | 文件路径 |

第一个非空命中即返回。这个顺序符合其他 CLI 的惯例，也让"临时用另一个 key 跑一次"
不需要编辑文件。

都没有命中时，`describeExpectations()` 生成的信息里包含该 Provider 声明的变量名：

```text
No API key for groq. Set GROQ_API_KEY, pass --api-key, or add "groq" to the auth file.
```

## 6. auth.json

```jsonc
{
  "openai": "sk-...",
  "deepseek": { "type": "api_key", "key": "sk-..." }
}
```

- 顶层是以 Provider id 为键的对象；值可以是字符串，或 `{"type":"api_key","key":"..."}`。
- **不支持 `$VAR` 展开，也不支持 `!command` 取值。** 让配置文件能启动进程，是用很大的
  攻击面换很小的便利：任何能写到这个文件的东西都会变成任意代码执行。
- 文件不存在返回 `undefined`（不是错误）；文件存在但 JSON 非法、或某个条目形状不对，
  则抛 `AuthFileError`——写错了要被告知，而不是被静默跳过。
- 非 Windows 平台上，如果权限位允许同组或其他用户读取，会在 stderr 提示
  `chmod 600`。只是警告，不阻断。

## 7. CLI 影响

- 新增 `--api-key KEY`，用于这一次运行。
- `--help` 的 Provider 段落由 `describeProviders(registry)` 生成，列出 id、环境变量、
  默认模型或"model required"。
- 帮助文本里写明解析顺序：`--api-key -> environment variable -> <CHIVGENT_HOME>/auth.json`。
- `createConfiguredClient()` 返回 `LLMClient | string`：缺东西时返回给用户看的那句话，
  而不是抛异常。CLI 打印它并以 1 退出。

检查顺序是模型 → base URL → 凭证，因为前两者不需要读磁盘，先报更省事的问题。

## 8. 测试策略

`tests/providers.test.ts`：未知 id 的错误里列出全部 id / 重复 id 拒绝注册 /
注册表接受 CLI 从未听说的 Provider / 定义声明的模型与 base URL 变量被读取 /
回落到声明的默认 base URL / 命令行拒绝未注册的 Provider；
`createConfiguredClient` 的四条错误路径（缺 key、缺 base URL、缺模型、认证文件不可读）
与一条成功路径。

`tests/credentials.test.ts`：环境变量按声明顺序读取、优先第一个、忽略空值；
认证文件的两种条目形式、缺文件、缺条目、JSON 非法、条目形状非法、权限警告与静默；
解析链的三层优先级与"全都没有"。

## 9. 验收标准

- [x] 新增一个 OpenAI 兼容 Provider 只需要一条声明，无需改动 CLI。
- [x] `--help` 的 Provider 列表与内置定义始终一致。
- [x] `--api-key` 覆盖环境变量，环境变量覆盖认证文件。
- [x] 错误信息准确指出该 Provider 需要哪个变量，且从不包含 key 本身。
- [x] 认证文件不做任何形式的展开或命令执行。
- [x] `npm run check`、`npm test`、`npm run build` 全部通过。
- [x] README（中英）的 Provider 表、CLI 与安全模型已更新。

## 10. 不在本阶段

用户级配置文件（默认 Provider、默认模型、per-project 覆盖）、OAuth 与刷新令牌、
模型别名与能力表、按 Provider 的重试与限流策略、凭证的加密存储。

下一阶段建议做 **上下文预算与压缩**：Session 已经能一直谈下去，而目前每一轮都把
完整 transcript 原样发出去，长会话必然撞上上下文窗口。
