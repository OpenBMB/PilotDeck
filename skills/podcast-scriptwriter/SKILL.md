---
name: podcast-scriptwriter
description: Convert a list of news items or technical topics into a natural two-host Chinese podcast script with speaker labels and tone/emotion annotations. Use when the user asks for 播客脚本, podcast script, dialogue script for TTS, 双人对谈脚本, or wants to produce audio content from written articles. Outputs 3-minute scripts by default (500-800 Chinese chars); pairs naturally with voxcpm-tts for audio synthesis.
---

# Podcast Scriptwriter (Chinese Two-Host)

Turn a list of news / tech items into a natural Chinese two-host podcast script — speaker labels, tone annotations, opening & closing segments, ready to feed into a TTS engine (see `voxcpm-tts`).

**Verified 2026-07-04**: A 3-item news input produced 731 Chinese chars, 16 dialogue turns, 18 tone annotations, ~3-minute duration. Single-item input produced ~1-minute content — for full 3 minutes, request extended discussion.

## Input Contract

Accept either:

**Format A — News list** (preferred):
```json
{
  "topic": "本周 AI 圈动态",
  "target_duration_seconds": 180,
  "hosts": [
    { "id": "A", "voice": "female", "persona": "科技评论员，语气理性带一点犀利" },
    { "id": "B", "voice": "male", "persona": "工程师，务实、爱举例" }
  ],
  "items": [
    { "title": "OpenAI 发布 GPT-5.5", "summary": "MoE 架构，编码能力 SWE-bench 82%..." },
    { "title": "Anthropic 融资 25 亿", "summary": "..." },
    { "title": "国产模型开源浪潮", "summary": "..." }
  ]
}
```

**Format B — Free-form prompt**: user gives a topic and a few bullet points; skill fills in the rest.

## Output Structure

The script must contain these zones:

```
[节目名称：{title}]
[主持人 A：{persona A}]
[主持人 B：{persona B}]
[预计时长：{duration}]

## 开场（15-25 秒）
A（{tone}）：欢迎语 + 今日主题预告
B（{tone}）：呼应 + 引入第一条

## 主体（每条 40-60 秒）
[Item 1: {title}]
A（{tone}）：抛出话题 + 关键数据
B（{tone}）：技术拆解 / 举例 / 提问
A（{tone}）：延伸讨论 / 观点
B（{tone}）：过渡到下一条

[Item 2: ...]
（同上格式）

## 收尾（15-20 秒）
A（{tone}）：总结要点
B（{tone}）：互动引导 + 下期预告
A / B（{tone}）：告别语
```

## Style Rules

1. **Every line must have a tone annotation** in `（）` before the content, e.g. `A（轻松、带笑）：...`.
2. **Common tone tags**: 平稳 / 轻松 / 认真 / 兴奋 / 若有所思 / 严肃 / 带笑 / 微沉重 / 打断 / 好奇。
3. **A and B alternate**; avoid three consecutive turns from one speaker.
4. **Numbers are readable aloud**: "82%" → "百分之八十二" or "约八成"; "$25 亿" → "二十五亿美元"; "SWE-bench" → keep as English (TTS handles it).
5. **Technical terms**: keep English acronyms in original form (LLM, API, MoE), but add a short Chinese explanation the first time — "MoE 架构，也就是混合专家模型".
6. **No paragraphs longer than 3 sentences per line** — TTS pacing depends on it.
7. **Density guideline**: for 3 minutes ≈ 500-800 Chinese chars ≈ 5-8 turns per news item.
8. **Sound-effect / SFX cues**: put in `[方括号]`, e.g. `[短暂间奏音乐]`. Optional but improves listenability.
9. **No hashtags, emoji, or Markdown syntax** in the spoken content — this is a script for TTS, not text-to-read.
10. **Ending signature**: last line always includes a call-to-action (subscribe / like / comment).

## Full Example (compact)

```
[节目：三分钟 AI 快报]
[主持人 A：科技评论员小明，语气理性犀利]
[主持人 B：工程师老王，务实爱举例]
[预计时长：3 分钟]

## 开场
A（轻松、带笑）：欢迎收听《三分钟 AI 快报》，我是小明。这周 AI 圈动作不小啊。
B（呼应、微兴奋）：老王来了。看点儿硬货，先说 OpenAI 那个 GPT-5.5 吧。

## 主体
[Item 1: OpenAI 发布 GPT-5.5]
A（认真）：MoE 架构，编码能力 SWE-bench 直接干到百分之八十二。
B（若有所思）：MoE 就是混合专家模型嘛。这分数意味着，中等复杂度的软件工程任务，一半以上能一次性搞定。
A（补充）：而且推理成本据说砍了六成。
B（挑眉）：这就有意思了——性能升还降价，Anthropic 得压力山大。

[Item 2: Anthropic 融资 25 亿]
...

## 收尾
A（总结）：这周三条主线，总结起来就是——性能加速追赶、资本继续加注、开源持续扩张。
B（互动）：想听哪个话题的深度拆解，评论区告诉我们。
A / B（一起）：我们下期见。
```

## Common Workflows

### End-to-end: news → script → audio

```
arxiv-cn-daily / hackernews-ai-trending
        ↓ (list of items)
podcast-scriptwriter → script.txt
        ↓
voxcpm-tts (per turn) → episode-YYYY-MM-DD.wav
```

### Batch: generate 5 episodes (one per weekday)

Feed 5 different date-scoped news bundles → 5 scripts → 5 audio files. Consistent host personas keep the show recognizable.

### Multi-language variants

Once the Chinese master is done, ask the skill to translate host lines to English/Japanese/Korean while **keeping the same tone annotations**. VoxCPM handles all three.

## Limitations

- **Single-item input yields ~1 minute** of content, not 3 minutes. To pad: request extended discussion, related-context stories, or add a Q&A segment.
- **No auto-fact-check**: script uses whatever info is in the input. If the input is wrong, the script echoes it. Verify facts upstream.
- **Dialogue naturalness depends on the LLM** — smaller models produce stiffer conversation. Use main-tier models (Sonnet 4+, GPT-4+, Qwen 3.5+) for best output.
- **Tone annotations are TTS-engine hints, not guarantees**. VoxCPM interprets `（严肃）`, `（带笑）` etc. reasonably; other engines may ignore them.
- **Never use asterisks for stage directions** — use square brackets. Some TTS engines read asterisks aloud.
- **Character count includes spaces & punctuation** but the target 500-800 refers to Chinese content excluding annotations.

## Failure Modes

| Symptom | Cause | Action |
|---------|-------|--------|
| Script only 300 chars | Input too thin, or duration guidance missing | Ask for longer format or provide more items |
| Robotic dialogue | Weak LLM tier | Retry with a stronger model |
| Speaker imbalance (A speaks 2× as much as B) | Prompt bias | Request explicit balance in follow-up |
| Numbers read as digits ("eighty-two percent") | TTS engine limitation | Pre-convert to Chinese "百分之八十二" in script |
| Emoji or Markdown leaked into output | Prompt escaped from constraints | Regenerate; strictly enforce no-Markdown rule |

## References

- Pairs with: `voxcpm-tts` (audio synthesis)
- Chinese oral text conventions: 数字口语化, 术语首次出现要解释
- No external dependencies — pure prompt engineering.
