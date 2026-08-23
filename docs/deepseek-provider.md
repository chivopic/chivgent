# DeepSeek Provider

## Usage

```bash
export DEEPSEEK_API_KEY="your-api-key"
chivgent --provider deepseek "Explain src/agent.ts"
```

The model is selected in this order:

1. `--model`
2. `DEEPSEEK_MODEL`
3. `deepseek-v4-flash`

OpenAI remains the default Provider. Select it explicitly with
`--provider openai`; it uses `OPENAI_API_KEY` and `OPENAI_MODEL`.

## Provider boundary

`DeepSeekChatClient` is a configuration wrapper around
`OpenAICompatibleChatClient`. It implements the same Provider-independent
`LLMClient` contract as `OpenAIClient`, but calls DeepSeek's OpenAI-compatible
Chat Completions API at `https://api.deepseek.com`.

```text
Agent Message[]
      |
      v
DeepSeekChatClient
      |
      v
OpenAICompatibleChatClient
      |
      +-- Chat Completion messages
      +-- function tools
      +-- private continuation history
```

The Agent sees only normalized `AssistantMessage` and `ToolCall` values. It does
not import OpenAI SDK types or know how DeepSeek stores conversation state.

## Reasoning continuation

When a DeepSeek thinking model emits tool calls, subsequent requests must replay
the assistant message with its original `reasoning_content`. Dropping that field
can make the Provider reject the next request.

For that reason, the shared compatible client stores a full Provider-private
message history in the opaque `continuation` value. `DeepSeekChatClient` gives
that state a DeepSeek-specific continuation tag. The Agent passes the value back
without inspecting it. Tool results are appended to the stored history before
the next completion:

```text
assistant(tool_calls + reasoning_content)
        -> tool results
        -> next DeepSeek completion
```

`reasoning_content` is deliberately not copied into the internal transcript or
printed by the CLI. This preserves the separation between Agent runtime state
and Provider protocol state.

## Current limits

- Non-streaming requests only.
- No retry or rate-limit policy.
- One CLI request at a time; no persisted conversation.
- Standard DeepSeek endpoint only. Beta-only strict tool mode is not enabled.
- Real API calls are manual smoke tests, not unit tests.
