# Example: MaaS / 大模型服务（Catalog 类）

> 这是 v2.2 新增样本，演示 **Infrastructure archetype + Rapidly-Evolving Catalog modifier** 叠加使用。
> 重点示范：SKU 穷尽、定价对比、版本时间线、recency sweep、训练截止护栏。

## Charter（节选）

| 字段 | 内容 |
|------|------|
| Scope | 中国 + 全球 MaaS（LLM/VLM/T2V/T2I）市场，主流玩家 SKU/定价/版本演进 |
| Out-of-Scope | 私有部署 / 开源权重的训练成本，仅看 API 调用市场 |
| Audience | AIGC 行业解决方案团队 |
| Decision | 选哪家做客户的"通用底座 + 视频垂类"组合 |
| Hypotheses | H1: 视频生成赛道已从 wan2.6 时代换代；H2: 头部 LLM 价格年降 ≥40%；H3: Reasoning 模型 GA 化加速 |
| Success Criteria | 头部 12 家 + 80+ SKU + 全量当前价 + 近 90 天 SKU 变更覆盖 ≥95% |

## Modifier 触发

✅ 月度发版（多家周更）  
✅ SKU 数 >> 20（头部一家 LLM/VLM/Embedding/TTS/Image/Video 加起来常 20+ SKU）  
✅ 价格是核心变量  
✅ 官方 Pricing Page 完备  
✅ 训练截止后已有多个 GA 重大版本  

→ 启用 `_modifier-rapidly-evolving.md`

## Recency Sweep 实操

### Gate 1: Today Date Stamp
- 调研启动 2026-06-24
- 强敏感窗口 2026-03-24 ~ 2026-06-24（近 90 天）

### Gate 2: Recency Sweep 检索词样例

```
"Qwen3-Max release"
"Doubao 2026 new model"
"DeepSeek latest version"
"Seedance 2.5 launch"
"OpenAI o3 release date"
"Claude 4 release"
"video generation model 2026"
site:siliconflow.cn new model 2026
site:bailian.console.aliyun.com 模型广场
```

### Gate 5: 第三方反查
- openrouter.ai/models → 排序按 "Newest" → 抓近 90 天新模型
- artificialanalysis.ai/models → 抓性价比矩阵
- lmarena.ai/leaderboard → 抓 ELO 榜单
- huggingface.co/models → trending 7 天 + 30 天

## SKU Matrix（示意，部分字段）

| 公司 | SKU | 发布 | 状态 | 输入价 (CNY/Mtok) | 输出价 (CNY/Mtok) | 上下文 | 备注 |
|------|-----|------|------|------|------|------|------|
| 阿里通义 | qwen3-max | 2026-Q1 | GA | 2.4 | 24 | 256K | reasoning 可选 |
| 阿里通义 | qwen3-turbo | 2026-Q2 | GA | 0.3 | 6 | 1M | 1M 长上下文 |
| 字节豆包 | doubao-1.5-pro-256k | 2026-Q1 | GA | 5 | 9 | 256K | |
| DeepSeek | deepseek-v3.1 | 2026-Q1 | GA | 1 | 2 | 128K | cache 0.1 |
| DeepSeek | deepseek-r1 | 2026-Q1 | GA | 1 | 16 | 128K | reasoning |
| MoonShot | kimi-k2 | 2026-Q2 | GA | 4 | 16 | 256K | agent 强 |
| OpenAI | gpt-4.1 | 2026-Q2 | GA | 14 | 56 | 1M | |
| OpenAI | gpt-4.1-mini | 2026-Q2 | GA | 2.8 | 11.2 | 1M | |
| OpenAI | o3 | 2026-Q1 | GA | 70 | 280 | 200K | reasoning |
| Anthropic | claude-opus-4 | 2026-Q1 | GA | 105 | 525 | 200K | |
| Anthropic | claude-sonnet-4 | 2026-Q1 | GA | 21 | 105 | 200K | |
| Google | gemini-2.5-pro | 2026-Q1 | GA | 8.75 | 70 | 2M | |
| Google | gemini-2.5-flash | 2026-Q1 | GA | 2.1 | 17.5 | 1M | |

⚠️ 上表所有价格为占位示例，实操**必须 live 抓 pricing page**。本示例只示范 SKU Matrix 的列结构。

## 视频生成赛道 SKU 横评（示意）

| 公司 | SKU | 发布 | 最大分辨率 | 最大时长 | 单价 (CNY/s) | R2V 支持 | 备注 |
|------|-----|------|----------|---------|----------|---------|------|
| 阿里通义 | wan2.7-t2v-pro | 2026-Q2 | 1080p | 10s | TBD | ✅ wan2.7-r2v | |
| 阿里通义 | wan2.7-image-pro | 2026-Q2 | 2K | n/a | TBD | n/a | |
| 字节 | seedance-2.5-pro | 2026-Q1 | 1080p | 12s | TBD | ✅ | hypothetical |
| 字节 | seedance-2.0-4k | 2026-Q2 | 4K | 8s | TBD | ❌ | hypothetical |
| 快手 | kling-2.0 | 2026-Q1 | 1080p | 10s | TBD | ✅ | |
| MiniMax | hailuo-1.0-r2v | 2026-Q1 | 720p | 6s | TBD | ✅ 仅 R2V 支持音色替换 | 见 memory |
| 腾讯 | hunyuan-video-2 | 2026-Q2 | 1080p | 8s | TBD | partial | |
| Runway | gen-4 | 2026-Q1 | 1080p | 10s | TBD | ✅ | |
| Pika | pika-2.0 | 2026-Q1 | 720p | 10s | TBD | ✅ | |
| Luma | dream-machine-2 | 2026-Q1 | 1080p | 10s | TBD | ✅ | |
| Google | veo-3 | 2026-Q2 | 4K | 8s | TBD | ✅ | 含音频 |
| OpenAI | sora-2 | 2026-Q2 | 1080p | 20s | TBD | ❌ | API limited |

⚠️ 同上，价格必须 live 抓。注意：本表故意覆盖了 **wan2.7 / seedance 2.5 / 2.0-4k / sora-2 / veo-3 / hailuo R2V** —— 这些都是 v2.1 时易漏的"训练截止后玩家/版本"。

## 三个不可写错的口径

1. **wan2.6 ≠ wan2.7** — 不同版本价格/分辨率/支持模态都不一样
2. **seedance 2.5 ≠ 2.0-4k** — 同代不同 SKU，前者优化 motion，后者主打分辨率
3. **R2V/I2V/T2V 价格不同口径** — 同公司不同模态 SKU 不能裸比

## Version Timeline 输出

按 `templates/visualizations/version-timeline.svg` 模板填 8 家公司近 24 个月节点。
重大里程碑（架构跃迁）用方块，普通发布用圆点，弃用用 ×。

## Pricing Comparison（任务级横评）

任务：1M 输入 + 0.5M 输出 token，中文为主，无 cache。

| 模型 | 总成本 (CNY) | 倍数 | 备注 |
|------|------------|------|------|
| deepseek-v3.1 | 2.0 | 0.04× (基准) | 含 cache 可压到 0.5 元 |
| qwen3-turbo | 3.3 | 0.07× | 1M 长上下文 |
| qwen3-max | 14.4 | 0.3× | reasoning 可选 |
| gemini-2.5-flash | 10.85 | 0.22× | |
| gpt-4.1-mini | 8.4 | 0.17× | |
| claude-sonnet-4 | 73.5 | 1.5× | |
| gpt-4.1 | 42 | 0.85× | |
| o3 | 210 | 4.3× | reasoning |
| claude-opus-4 | 367.5 | 7.5× | |

→ 单位经济解读：deepseek-v3.1 在中文长尾任务上**性价比一档**；claude-opus-4 在需要长 reasoning 的复杂任务上**质量一档**；中间档大同小异，选型主要看延迟/上下文/工具调用支持。

## Pre-mortem（catalog 特化版）

12 个月后这份报告若失效，最可能错在：

1. 价格全线下降 50%+，本表"成本倍数"序列保留但绝对值需全量重抓
2. Reasoning Token 计费规则统一化（OpenAI/Anthropic 趋同），表格列需重设计
3. 视频生成赛道又出 2-3 个本表未列玩家（持续监控 OpenRouter / FAL）
4. 训练数据涉版权诉讼影响价格（高质量数据进入成本提升）
5. 中国生成式 AI 备案收紧或扩松，海外公司中国可用性变化

## 用法

1. 实际调研时复制本目录为新 examples
2. 把 placeholder 价格全部用 live 检索替换
3. 复刻 SKU Matrix 时按 `schemas/sku.schema.json` 填 jsonl
4. 输出物：sku-pricing-matrix.html + version-timeline.svg + 完整数据底表
