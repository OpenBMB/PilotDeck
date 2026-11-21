# MaaS & AI Models 取数菜谱

> 适用于 MaaS (Model-as-a-Service)、AI 基础模型、Embedding、ASR/TTS、文生图、文生视频、Coding Assistant 等
> **快速演进目录类** 行业。本菜谱与 [`_modifier-rapidly-evolving.md`](../../archetypes/_modifier-rapidly-evolving.md) 配套。

## 子赛道与高频玩家

| 子赛道 | 中国主要玩家 | 海外主要玩家 |
|--------|-------------|-------------|
| 通用大语言模型 | 通义千问 (Qwen) / DeepSeek / 智谱 GLM / Kimi (月之暗面) / 文心 / 豆包 / MiniMax / 阶跃 (Step) / 百川 / 商汤日日新 | OpenAI GPT / Anthropic Claude / Google Gemini / Meta Llama / Mistral / xAI Grok / Cohere |
| 文生视频 | Wan (通义万相) / Seedance / Hailuo (海螺) / Vidu / Kling (可灵) / Hunyuan / Jimeng (即梦) | Veo / Sora / Runway / Pika / Luma / Hailuo (国际) / Higgsfield |
| 文生图 | Wan / Doubao / Tongyi / Kolors (可图) / Hunyuan-DiT / Jimeng / Liblib | Flux / Midjourney / DALL-E / Imagen / Stable Diffusion / Ideogram / Recraft |
| 图生视频 / R2V | Wan-R2V / Hailuo R2V / HappyHorse | Runway Gen3 / Kling I2V / Pika |
| Embedding | text-embedding-v3/v4 (通义) / DMETA-Embedding / BGE / M3E | OpenAI text-embedding-3 / Voyage / Cohere Embed / Jina |
| 语音 (TTS/ASR) | CosyVoice / SenseVoice / Step-Audio / 字节 Seed-TTS | ElevenLabs / OpenAI TTS / Cartesia / Deepgram / AssemblyAI |
| 数字人 / 3D | EMO / Sonic / DreamTalk | Hedra / Synthesia / D-ID / Heygen |
| Coding | Qwen-Coder / DeepSeek-Coder / CodeLlama | Claude Code / Cursor / Copilot / Windsurf |

⚠️ **本表本身会过期**。每次启用 skill 时必须跑 [Recency Sweep](../recency-guardrail.md#gate-2recency-sweep近-n-天扫描) 重建清单。

## 权威数据库与一手源

### 中国 MaaS

| 平台 | 用途 | URL |
|------|------|-----|
| 阿里云百炼 | 通义 + 第三方模型聚合，含 pricing/quota/API | bailian.console.aliyun.com / dashscope.aliyuncs.com |
| 火山引擎方舟 | 字节豆包/Seed 系列模型 | console.volcengine.com/ark |
| 腾讯混元 | 混元系列 | cloud.tencent.com/product/hunyuan |
| 百度千帆 | 文心 + 第三方 | console.bce.baidu.com/qianfan |
| 智谱开放平台 | GLM 系列 | open.bigmodel.cn |
| Moonshot 开放平台 | Kimi | platform.moonshot.cn |
| DeepSeek 开放平台 | DeepSeek 系列 | platform.deepseek.com |
| MiniMax 开放平台 | MiniMax + 海螺 | platform.minimaxi.com |
| SiliconFlow 硅基流动 | 多家聚合，平价 | siliconflow.cn |

### 海外 MaaS

| 平台 | 用途 |
|------|------|
| OpenAI Platform | platform.openai.com/docs/pricing |
| Anthropic Console | console.anthropic.com / anthropic.com/pricing |
| Google AI Studio / Vertex AI | ai.google.dev / cloud.google.com/vertex-ai/pricing |
| AWS Bedrock | aws.amazon.com/bedrock/pricing |
| Azure OpenAI / AI Foundry | azure.microsoft.com/en-us/pricing/details/cognitive-services |
| Replicate | replicate.com/pricing |
| FAL.ai | fal.ai/models |
| Together AI | together.ai/pricing |
| Fireworks AI | fireworks.ai/pricing |

### 第三方聚合/榜单（反向查漏）

| 平台 | 强项 |
|------|------|
| **OpenRouter** | openrouter.ai — 全网 LLM 价格 + 路由测速，最全 |
| **Artificial Analysis** | artificialanalysis.ai — 中立评测 + 价格 + tps |
| **LMArena** | lmarena.ai — 人类盲评榜（Chatbot Arena） |
| **livebench.ai** | 防训练泄漏的高难度评测 |
| **MTEB** | huggingface.co/spaces/mteb/leaderboard — Embedding 唯一权威榜 |
| **Hugging Face** | huggingface.co — 开源模型聚合 |
| **OpenCompass** | opencompass.org.cn — 中文榜 |
| **CompassArena** | compass.smartedu.cn/dnArena — 中文盲评 |
| **SuperCLUE** | superclueai.com — 中文 LLM 测评 |

### 行业资讯/changelog

- **公司公众号 + 官方 Twitter**：beta/preview 阶段唯一首发
- **TechCrunch / The Information / 量子位 / 机器之心 / 36 氪 AI**
- **AI 工具集 / FutureTools / Theresanaiforthat** —— 工具型聚合
- **GitHub Trending Top** —— 开源动态
- **arxiv-sanity / paperswithcode** —— 学术前沿

## 监管批件 / 备案

- **中国生成式 AI 备案**：网信办《生成式人工智能服务管理暂行办法》备案企业名单（每月更新）
- **中国深度合成算法备案**：网信办深度合成服务算法备案
- **EU AI Act**：2026 起生效，GPAI 模型需注册
- **美国行政令 14110**：原 Biden EO 14110，2025-01 已被特朗普政府部分撤销，需查最新状态
- **出口管制**：BIS Entity List 对算力/模型出口限制

## 财务披露口径陷阱（模型经济学专属）

| 容易混 | 含义差异 |
|-------|---------|
| **输入 token 价 vs 输出 token 价** | 多数模型输出价 2-5× 输入价；估总成本需按真实 in/out 比 |
| **Token vs Character vs Word** | 中文 1 字符 ≈ 0.6-1 token；OpenAI/Anthropic/Google 分词器不同，价格不可裸比 |
| **Cache 命中价 vs 全价** | 缓存命中价低 50-90%，但需满足 prefix match 条件 |
| **Batch API vs Real-time** | Batch 半价但 24h 延迟，不能算实时成本 |
| **Tiered Pricing** | 按月用量阶梯，需算加权 |
| **Context Cache 折扣** | Claude/Gemini 多模型有 cache 优惠，须读 fine print |
| **Free quota vs Paid** | 免费额度有 RPS 上限、可能限制商用 |
| **Reasoning Token 单独计费** | o1 / Claude 3.7 Thinking / DeepSeek-R1 思考过程也算 output |
| **Multi-modal pricing** | 图像/视频/音频按"等价 token"计费，公式各家不同 |
| **GA vs Beta 价** | Beta 免费/低价不代表 GA 价（OpenAI Realtime 涨过 2-3 倍） |

## SKU 穷尽流程（必跑）

按顺序执行，确保不漏 SKU：

1. **官方 Pricing 页**：抓所有可见 SKU 名 + 价格
2. **API model_list 接口**：实际可调列表（如 `GET /v1/models`），常多于 pricing 页
3. **官方文档/Cookbook**：找到隐藏的 preview / private beta 模型
4. **官方 Twitter / 公众号 / 博客**：近 90 天发布预告
5. **第三方聚合**：OpenRouter / Artificial Analysis 反查
6. **开发者社区**：Discord / 微信群 / 知乎"X 平台支持哪些模型"问答
7. **竞品对比页**：自家"vs 友商"页面常列友商最新 SKU

每一步抓到的 SKU 都进 [`templates/visualizations/sku-pricing-matrix.html`](../../templates/visualizations/sku-pricing-matrix.html)。

## 一手验证

- **API 实测**：免费额度跑 hello-world 验证 SKU 存在 + 拿真实延迟
- **微信群 / Discord**：找产品经理 / 销售确认 roadmap
- **开发者大会**：阿里云栖、火山 Force、百度 Wave、AWS re:Invent、Google I/O、OpenAI DevDay、Anthropic 大会

## 红线 / 不可写

- ❌ 不要凭记忆答"X 公司有什么模型"——必须 live 检索
- ❌ 不要把训练数据里的旧 SKU 当现状
- ❌ 不要忽略 Deprecated 列表（OpenAI / Anthropic 季度淘汰旧模型）
- ❌ 不要把"开源权重"等同"商用免费"（多数有 acceptable use policy 限制）
- ❌ 不要用 benchmark 分数替代真实业务效果（榜单专门刷 vs 实战常差距大）
- ❌ 不要把 Beta 价当 GA 价
- ❌ 不要把"中国市场份额"和"全球份额"混用（中国市场前 3 在全球可能 Top 20 外）

## 周度刷新清单（必跑）

每周 Monday 跑：

1. OpenRouter / Artificial Analysis 价格变化 diff
2. 头部 12 家官方 Twitter + 公众号近 7 天发布
3. HuggingFace Trending 近 7 天新模型
4. 官方 changelog（OpenAI / Anthropic / Google / Qwen / DeepSeek / Volcano）

输出到 `data/maas-weekly-diff-{YYYY-Www}.md`。
