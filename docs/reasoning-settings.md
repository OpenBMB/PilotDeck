# Model reasoning settings

Reasoning controls are configured per model in **Settings → Model pool → Model settings**.
Image input is independent. Thinking mode and Disable thinking are mutually exclusive;
leaving both unchecked uses the server default without adding any thinking controls.

```yaml
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: ${CUSTOM_API_KEY}
      models:
        qwen3.8-27b:
          thinking:
            state: enabled # default | enabled | disabled
            efforts: [low, medium, xhigh]
            format: qwen-local
```

`efforts` is a manually configured subset of `low`, `medium`, `high`, `xhigh`, `max`.
The composer shows Default plus this subset only while thinking is enabled. An empty
subset shows only Default. Default omits effort; it is not an alias for medium.
Disabling thinking omits any selected effort and requests off using the selected format.
Unsupported settings report a configuration/provider error, without silently changing effort.
Historical selections that are no longer configured reset to Default in the composer.
The server also drops obsolete reasoning values when restoring saved session selections,
including legacy Off/Minimal values, so CLI/API clients can resume without sending a new
selection. Newly submitted invalid efforts still fail validation.

## Parameter formats

| Format | Effort | Switch |
| --- | --- | --- |
| `provider` | Inherit the provider preset below | Inherit the provider preset |
| `openai` | Chat: `reasoning_effort`; Responses: `reasoning.effort` | `none` requests off; enabling + Default omits effort |
| `thinking-type` | `reasoning_effort` | `thinking.type: enabled / disabled` |
| `qwen-cloud` | `reasoning_effort` | `enable_thinking: true / false` |
| `qwen-local` | `reasoning_effort` | `chat_template_kwargs.enable_thinking: true / false` |
| `anthropic` | `output_config.effort` | `thinking.type: adaptive / disabled` |
| `google` | `generationConfig.thinkingConfig.thinkingLevel` | No budget-free off implementation; enabled requests include thoughts |
| `openrouter` | `reasoning.effort` | `reasoning.enabled: true / false` |
| `server-default` | Omitted | Omitted; explicit off/effort is an error |

Native Anthropic and Google formats require their respective request protocols.
OpenAI Responses supports only OpenAI/default formats. Custom Chat endpoints default
to OpenAI, regardless of the model name; choose a model-level override if the proxy
expects another format. No arbitrary field-name or JSON mapping is provided.

Provider presets: OpenAI → OpenAI; DashScope → Qwen cloud; DeepSeek, Moonshot and Zhipu
→ thinking-type; OpenRouter → OpenRouter. Ollama, MiniMax and Volcano Ark keep the
server default unless explicitly overridden. Native protocols use their native formats.

Model versions still differ. Official Kimi K3 and GLM 5.3 use effort without a switch
and reject off locally. Gemini 3 passes only low/medium/high without remapping;
unsupported levels fail explicitly. Older budget-only Claude/Gemini models keep the
server default and reject explicit effort. Other invalid choices may be rejected upstream.

## Migration

Missing `model.thinking` is equivalent to `state: default`. Legacy request `off`,
`minimal`, `enabled`, and token budgets do not override model state. PilotDeck no
longer generates `thinking_budget`, `budget_tokens`, or `thinkingBudget`, or converts
strength into a token limit. Provider-side interpretation of effort is independent.
Existing context/output token limits and reasoning-history replay remain separate.

## References

- [OpenAI Chat](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [DashScope compatible API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
- [Qwen3.8 self-hosted examples](https://huggingface.co/Qwen/Qwen3.8-27B)
- [GLM API](https://docs.z.ai/api-reference/llm/chat-completion)
