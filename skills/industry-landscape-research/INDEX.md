# INDEX — industry-landscape-research v2.2.0

> 一页式快速索引。完整说明读 [SKILL.md](SKILL.md)。共 70+ 文件，按用途分类。
> **新手路径**：SKILL.md → workflows/00 → workflows/01 → archetypes/* (+ modifier) → 数据 + 校验 + 可视化 → 交付。

## 0. 包根

| 文件 | 用途 |
|------|------|
| [SKILL.md](SKILL.md) | 主入口：8 步法 + Archetype + Modifier + Changelog |
| [INDEX.md](INDEX.md) | 你正在看的文件 |
| [assets/showcase.html](assets/showcase.html) | Editorial 暗色展示页 |

## 1. workflows/ — 步骤 SOP

| 文件 | 步骤 | 用途 |
|------|------|------|
| [00-execution-plan.md](workflows/00-execution-plan.md) | 0 | Phase 1/2/3 + 并行 Agent 时长估算 |
| [01-research-charter.md](workflows/01-research-charter.md) | 1 | Charter sign-off 模板（含 Today Date Stamp） |
| [02-three-round-search.md](workflows/02-three-round-search.md) | 3 | R1/R2/R3 + 多轮迭代 + Recency Sweep |
| [03-analysis-frameworks.md](workflows/03-analysis-frameworks.md) | 5 | Porter / 7 Powers / Wardley / JTBD |
| [04-coverage-audit.md](workflows/04-coverage-audit.md) | 4 | 覆盖度矩阵 + 🔴🟡 缺口阻断 |
| [05-quant-modeling.md](workflows/05-quant-modeling.md) | 6 | 单位经济、TAM/SAM/SOM、利润池、敏感性 |
| [06-thesis-synthesis.md](workflows/06-thesis-synthesis.md) | 7 | House View / 三情景 / Pre-mortem / Devil's Advocate |
| [07-deliverable-assembly.md](workflows/07-deliverable-assembly.md) | 8 | 6+2 章节标准报告 + 15 项物料清单 |

## 2. archetypes/ — 行业原型

| 文件 | 类型 | 适用 |
|------|------|------|
| [_modifier-rapidly-evolving.md](archetypes/_modifier-rapidly-evolving.md) 🆕 | Modifier | MaaS / AI 编程 / 向量库 / 视频图像生成 |
| [platform.md](archetypes/platform.md) | Base | 双边平台（take rate、liquidity） |
| [saas-vertical.md](archetypes/saas-vertical.md) | Base | 垂直 SaaS（NRR、CAC payback） |
| [marketplace.md](archetypes/marketplace.md) | Base | Marketplace（GMV、take rate） |
| [consumer.md](archetypes/consumer.md) | Base | 消费 App（DAU/MAU、ARPU） |
| [deeptech-hardware.md](archetypes/deeptech-hardware.md) | Base | DeepTech（TRL、专利、BOM） |
| [infrastructure.md](archetypes/infrastructure.md) | Base | 云/基础设施（单位算力成本） |
| [content-media.md](archetypes/content-media.md) | Base | 内容/媒体（子生态、版权） |

## 3. references/ — 资源库

### 通用

| 文件 | 用途 |
|------|------|
| [bias-checklist.md](references/bias-checklist.md) | 7 类偏差（含训练截止偏差🆕）+ 推广水文 + 水分识别 |
| [crawl-strategy.md](references/crawl-strategy.md) | 反爬绕路、Wayback、archive.today |
| [dirty-work-playbook.md](references/dirty-work-playbook.md) | 公司名归一、单位换算、汇率快照 |
| [glossary.md](references/glossary.md) | 40+ 行业研究术语词典 |
| [profit-pool.md](references/profit-pool.md) | 利润池图方法 |
| [recency-guardrail.md](references/recency-guardrail.md) 🆕 | 6 道闸门防训练截止偏差 + 5 句魔法 |
| [refresh-cadence.md](references/refresh-cadence.md) | 数据保鲜矩阵 + Catalog 周度档🆕 |
| [rules-of-thumb.md](references/rules-of-thumb.md) | SaaS / 平台 / 硬件 / AI 行业 ratio 红线 |
| [side-channel-intel.md](references/side-channel-intel.md) 🆕 | JD / 专利 / 投资 / GitHub / 应用商店 / Wayback |
| [source-matrix.md](references/source-matrix.md) | 来源等级 + 反爬策略入口 |
| [stack-map.md](references/stack-map.md) | 技术栈分层（模型/服务/应用/基建） |
| [stakeholder-stance.md](references/stakeholder-stance.md) | 利益相关方立场图 |
| [valuation-playbook.md](references/valuation-playbook.md) | 股票代码速查 + 未上市估值法 |
| [value-chain-journey.md](references/value-chain-journey.md) | 客户旅程价值链 |

### source-recipes/ — 深水行业取数菜谱

| 文件 | 行业 |
|------|------|
| [README.md](references/source-recipes/README.md) | 总索引 |
| [maas-and-models.md](references/source-recipes/maas-and-models.md) 🆕 | MaaS / 大模型 API / 多模态 |
| [medical.md](references/source-recipes/medical.md) | 医疗 / 医药 / 器械 |
| [semiconductor.md](references/source-recipes/semiconductor.md) | 半导体 / EDA / IP |
| [auto.md](references/source-recipes/auto.md) | 汽车 / 新能源 / 自驾 |
| [fintech.md](references/source-recipes/fintech.md) | 支付 / 消金 / 数字银行 |
| [energy.md](references/source-recipes/energy.md) | 光伏 / 储能 / 氢能 |

## 4. schemas/ — JSON Schema

| 文件 | 用途 |
|------|------|
| [company.schema.json](schemas/company.schema.json) | companies.jsonl 主表 |
| [event.schema.json](schemas/event.schema.json) | events.jsonl 事件流 |
| [source.schema.json](schemas/source.schema.json) | sources.csv 来源表 |
| [racetrack.schema.json](schemas/racetrack.schema.json) | 赛道树 |
| [deliverable.schema.json](schemas/deliverable.schema.json) | 交付物清单 |
| [sku.schema.json](schemas/sku.schema.json) 🆕 | SKU/版本/价格底表 |

## 5. templates/ — 子 Agent + 计算器 + 可视化

### subagent 模板

| 文件 | 切片 |
|------|------|
| [subagent-racetrack-scan.md](templates/subagent-racetrack-scan.md) | 按赛道并行 |
| [subagent-company-deepdive.md](templates/subagent-company-deepdive.md) | 按公司深挖 |
| [subagent-cross-validate.md](templates/subagent-cross-validate.md) | 多源验证 |
| [subagent-devil-advocate.md](templates/subagent-devil-advocate.md) | 反方论证 |
| [subagent-quant-model.md](templates/subagent-quant-model.md) | 量化建模 |

### calculators/

| 文件 | 用途 |
|------|------|
| [README.md](templates/calculators/README.md) | 总索引 |
| [unit-economics-calculator.py](templates/calculators/unit-economics-calculator.py) | Python 批处理 LTV/CAC/Payback |
| [unit-economics-calculator.csv](templates/calculators/unit-economics-calculator.csv) | Excel 版 |
| [unit-economics-formulas.md](templates/calculators/unit-economics-formulas.md) | 公式严格定义 + A-D 评分卡 |
| [htm-to-pptx-pipeline.md](templates/calculators/htm-to-pptx-pipeline.md) | pptxgenjs 原生 PPTX 流水线 |

### visualizations/

| 文件 | 类型 | 用途 |
|------|------|------|
| [README.md](templates/visualizations/README.md) | — | 总索引 |
| [landscape-grid.svg](templates/visualizations/landscape-grid.svg) | SVG | 行业全景矩阵 |
| [evolution-timeline.svg](templates/visualizations/evolution-timeline.svg) | SVG | 演进时间线 + S 曲线 |
| [porter-5forces-radar.svg](templates/visualizations/porter-5forces-radar.svg) | SVG | Porter 五力雷达 |
| [wardley-map.svg](templates/visualizations/wardley-map.svg) | SVG | Wardley 演化地图 |
| [value-chain-journey.svg](templates/visualizations/value-chain-journey.svg) | SVG | 客户旅程价值链 |
| [profit-pool.svg](templates/visualizations/profit-pool.svg) | SVG | 利润池图 |
| [tam-sam-som-funnel.svg](templates/visualizations/tam-sam-som-funnel.svg) | SVG | TAM/SAM/SOM 漏斗 |
| [stakeholder-stance.html](templates/visualizations/stakeholder-stance.html) | HTML | 利益相关方 + 散点 |
| [company-deepdive-card.html](templates/visualizations/company-deepdive-card.html) | HTML | 公司深度卡 |
| [valuation-leaderboard.html](templates/visualizations/valuation-leaderboard.html) | HTML | 估值排行榜（IPO 首日 vs 当前） |
| [sku-pricing-matrix.html](templates/visualizations/sku-pricing-matrix.html) 🆕 | HTML | SKU 矩阵 + 跨厂商价格对比 |
| [version-timeline.svg](templates/visualizations/version-timeline.svg) 🆕 | SVG | 8 行 × 24 月版本演进 |

## 6. scripts/ — 校验与建模

| 文件 | 用途 |
|------|------|
| [validate.py](scripts/validate.py) | 纯标准库 JSON Schema 校验器（L1-L4 等级核对） |
| [Makefile](scripts/Makefile) | make validate / validate-strict / unit-economics / all |

## 7. examples/ — 完整案例

| 目录 | 原型 | 修饰符 |
|------|------|--------|
| [ex-aigc-image/](examples/ex-aigc-image/) | Platform + SaaS | — |
| [ex-saas-legaltech/](examples/ex-saas-legaltech/) | Vertical SaaS | — |
| [ex-marketplace-crossborder/](examples/ex-marketplace-crossborder/) | Marketplace | — |
| [ex-deeptech-autonomous/](examples/ex-deeptech-autonomous/) | DeepTech / Hardware | — |
| [ex-maas-llm/](examples/ex-maas-llm/) 🆕 | Infrastructure | 🚨 Rapidly-Evolving Catalog |

## 触发词速查

通用：行业调研 / 行业分析 / 竞争格局 / 全景图 / landscape / 赛道分析 / 市场研究 / 行业报告 / 财报分析 / 招股书 / 价值链分析 / market map

v2.2 新增（catalog 类）：MaaS 调研 / 模型对比 / SKU 清单 / 价格对比 / catalog / AI 编程工具调研 / 向量数据库选型 / 模型市场 / pricing 对比

## 触发 Rapidly-Evolving 修饰符的提问范式

- "我想做一个 XXX 模型/工具/平台 的对比调研"
- "帮我列一下市面上所有的 XXX SKU"
- "对比一下各家 XXX 的价格"
- "最新的 XXX 有哪些"
- "XXX 产品矩阵 / 选型 / 替代品"

→ 加载 `archetypes/_modifier-rapidly-evolving.md` + `references/recency-guardrail.md`，必须主动跑 Recency Sweep + Live Pricing Fetch。
