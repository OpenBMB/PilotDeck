---
name: industry-landscape-research
description: |
  通用行业调研方法论：从范围锁定（Research Charter）、赛道分解、三轮搜索 + 多轮迭代、企业画像、估值追踪、覆盖度审计、分析框架（Porter 5 力 / 7 Powers / Wardley / JTBD）、单位经济学量化、Thesis 综合（House view / 三情景 / Pre-mortem）、竞争格局制图到演进叙事，完整 8 步法。
  覆盖上市公司市值获取（港股/A股/美股/科创板/北交所/美股 ADR）、未上市公司估值追踪、财报/招股书/官网一手来源挖掘、推广水文与数据水分鉴别、反爬绕路策略、数据质量分级（L1-L4）、有效资料统计、客户旅程价值链、技术栈分层、利润池分布、利益相关方立场图。
  输出物：Research Charter、行业全景图、演进时间线、估值排行榜、企业深度卡、技术栈分层图、客户旅程图、利润池图、利益相关方立场图、分析框架画布（5 力雷达 + 7 Powers 评分 + Wardley 演化）、三情景预测、Pre-mortem 报告、数据底表、调研日志。
  触发词：行业调研、行业分析、竞争格局、全景图、landscape、行业地图、赛道分析、市场研究、行业报告、产业研究、财报分析、招股书、行业研究、产业链分析、价值链分析、market map、industry map、MaaS 调研、模型对比、SKU 清单、价格对比、catalog、AI 编程工具调研、向量数据库选型、模型市场、pricing 对比。
version: 2.2.0
---

# 行业调研八步法（v2 升级版）

> **核心原则**：调研的目的不是堆事实，而是形成可被反驳的判断。所有数据都为 thesis 服务。
> **质量底线**：每个非常识陈述句必须挂"数字 + 来源 URL + 抓取日期 + 数据等级（L1-L4）"，四件套缺一不可。
> **执行底线**：所有子 Agent 必须按 `schemas/*.json` 输出，schema 不过则拒收。

## 总览

| 步骤 | 名称 | 关键问题 | 主要产出 | 详细 SOP |
|------|------|---------|---------|---------|
| 1 | Charter | 我们到底要回答什么？ | Research Charter（范围/排除/假设/成功标准） | `workflows/01-research-charter.md` |
| 2 | Decompose | 这个行业怎么切？ | 赛道树（2-5 条主轨 + 子生态） | 见 Step 2 |
| 3 | Three-Round Search | 谁在场？数据在哪？ | 公司清单 + 企业画像 + 缺口表 | `workflows/02-three-round-search.md` |
| 4 | Coverage Audit | 我覆盖到了吗？ | 覆盖度审计矩阵（⭐ 评分 + 🔴🟡 缺口分级） | `workflows/04-coverage-audit.md` |
| 5 | Analysis Frameworks | 数据说明了什么？ | 5 力雷达 + 7 Powers 评分 + Wardley 演化 + JTBD | `workflows/03-analysis-frameworks.md` |
| 6 | Quant Modeling | 数据能否撑住判断？ | 单位经济学、TAM/SAM/SOM、利润池、敏感性 | `workflows/05-quant-modeling.md` |
| 7 | Thesis Synthesis | 我的判断是什么？怎么被证伪？ | House view + 三情景 + Pre-mortem + 反方论证 | `workflows/06-thesis-synthesis.md` |
| 8 | Deliverable Assembly | 怎么交付？ | 6+2 章节标准报告 + 全景图 + 时间线 + 深度卡 | `workflows/07-deliverable-assembly.md` |

详细执行计划（Phase 1/2/3 + 并行 Agent 时长估算）见 `workflows/00-execution-plan.md`。

---

## Step 1: Charter（范围锁定）

详见 `workflows/01-research-charter.md`。核心是 **必须 sign-off** 后才能进入采集，否则后续必然漂移。

Charter 5 要素：
1. **Scope** — 包含什么（技术/产品/场景的边界），一句话定义
2. **Out-of-Scope** — 排除什么（看似相关但不在范围内）
3. **Audience & Decision** — 给谁看？要支撑什么决策（投资 / BD / 战略 / 立项）
4. **Hypotheses** — 进入前的 3-5 个先验假设（结束时逐条 confirm/refute）
5. **Success Criteria** — 什么算"做完"（覆盖率 / 数据等级 / 章节齐全 / 反方论证）+ Stop-loss

---

## Step 2: Decompose（赛道分解）

将行业拆为 2-5 条主轨道，每条轨道内部逻辑自洽。常用分解维度：

| 维度 | 适用场景 | 示例 |
|------|---------|------|
| 技术类型 | 技术驱动型 | 图像 / 视频 / 音频 / 多模态 |
| 价值链环节 | 制造 / 供应链 | 上游 → 中游 → 下游 |
| 客户群体 | ToB/ToC/ToG 混合 | 企业 / 消费者 / 开发者 / 政府 |
| 地理市场 | 全球化 | 北美 / 中国 / 欧洲 / 东南亚 / 中东 |
| 商业模式 | 平台型 | SaaS / Marketplace / 广告 / 交易 |

**子生态分层（v2 新增，来自 AIGC review）**：每条主轨内部还要切子生态，避免漏掉关键玩家。以"内容/媒体型"行业为例：

| 子生态层 | 角色 | 例（短剧赛道） |
|---------|------|--------------|
| 平台方 | 分发与流量 | 红果短剧、番茄短剧、ReelShort |
| 制作方 | 内容生产 | 古麦嘉禾、OST 传媒 |
| IP 源 | 内容授权 | 阅文集团、晋江文学城 |
| 出海发行 | 海外渠道 | ShortMax、DramaBox、FlexTV |
| 工具方 | AI 生产工具 | 万兴剧厂、FlareFlow |

不同行业原型的子生态切法见 `archetypes/`。

每条赛道再按 **地理（全球 vs 中国）** 和 **规模（Tier1/2/3）** 二维展开。

---

## Step 3: Three-Round Search（三轮搜索 + 多轮迭代）

详见 `workflows/02-three-round-search.md`。

| 轮次 | 目标 | 产出 | 门槛 |
|------|------|------|------|
| R1 广度扫描 | 建立赛道骨架 | 每赛道 ≥15 家公司清单 | 公司数门槛 |
| R2 深度钻取 | 填充企业画像 | 字段覆盖率 ≥80% | 覆盖率门槛 |
| R3 验证补盲 | 交叉验证 + 发现新锐 | L1+L2 数据占比 ≥60% | 信度门槛 |
| R4-R8 迭代 | 缺口补、反向验证、时序追溯、边缘扫尾、客户视角 | 收敛信号：连续两轮新增 < 5% | 收敛门槛 |

**海内外双轨**：全球化行业必须分中国/海外两个排行榜，禁止混排——商业模式、监管、客户都不一样。

---

## Step 4: Coverage Audit（覆盖度审计）

v2 新增，详见 `workflows/04-coverage-audit.md`。在 R3 结束后强制做一次审计，矩阵格式：

| 维度 | 覆盖度 | 已覆盖 | 缺口分级 |
|------|--------|--------|---------|
| 赛道公司数 | ⭐⭐⭐⭐⭐ 95% | 64 家 | 🟢 |
| 估值/融资 | ⭐⭐⭐⭐ 80% | TOP 30 | 🟡 Tier 3 缺精确估值 |
| ARR/营收 | ⭐⭐⭐ 70% | 头部 30 家 | 🟡 中腰部缺财务 |
| 技术架构 | ⭐⭐ 30% | 仅"自研/开源/第三方" | 🔴 缺模型/服务/应用层架构 |
| 子生态完整性 | ⭐⭐ 40% | 仅平台方 | 🔴 缺制作/IP/出海发行 |
| 客户旅程 | ⭐⭐ 30% | 单点 | 🔴 缺完整旅程 |
| 利益相关方立场 | ⭐⭐⭐ 60% | 部分 | 🟡 缺监管/版权方态度 |
| 利润池分布 | ⭐ 20% | 未做 | 🔴 必补 |

🔴 = 必补；🟡 = 建议补；🟢 = 可接受。审计未过禁止进入 Step 5。

---

## Step 5: Analysis Frameworks（分析框架）

v2 关键升级。把"采集型方法论"升级为"分析型方法论"。详见 `workflows/03-analysis-frameworks.md`。

强制至少套用：

1. **Porter 五力** — 替代/进入/客户/供应商/竞争 五维各打 1-5 分，雷达图呈现
2. **Helmer 7 Powers** — 规模/网络/反向定位/转换成本/品牌/资源垄断/流程力量 七维评分卡，每家头部公司一张
3. **Wardley Map** — 创世/定制/产品/商品化 × 价值链可见性，预测下一步往哪走
4. **JTBD** — 用户雇佣这个产品来做什么任务（替代纯"产品矩阵"描述）
5. **S-curve / Gartner Hype Cycle** — 标定行业整体在哪个阶段

按需启用：Crossing the Chasm、技术采纳生命周期、BCG 矩阵、Ansoff 矩阵。

---

## Step 6: Quant Modeling（量化建模）

详见 `workflows/05-quant-modeling.md`。

| 模型 | 必填行业原型 | 关键指标 |
|------|------------|---------|
| 单位经济学 | SaaS / Marketplace / Consumer | CAC、LTV、Payback、Rule of 40、Magic Number、NRR |
| TAM/SAM/SOM | 全部 | 三种算法交叉（自上而下 / 自下而上 / 类比） |
| 利润池图（Profit Pool） | 全部 | 价值链各环节 margin × 营收占比 |
| 敏感性分析 | 投资类调研 | 三情景下关键变量的弹性 |

利润池模板见 `references/profit-pool.md`。

---

## Step 7: Thesis Synthesis（Thesis 综合）

v2 新增章节，详见 `workflows/06-thesis-synthesis.md`。

强制产出：

1. **House View** — 一句话核心判断 + 3 条支撑论据
2. **三情景预测** — Bull / Base / Bear，各含触发条件、领先指标、概率权重
3. **Pre-mortem** — "假如这份报告 12 个月后被证伪，最可能错在哪 5 个点"
4. **Devil's Advocate** — 针对核心判断列出 3 个最强反方论点 + 我方应对
5. **置信度标注** — 每个判断标 H/M/L confidence + 关键不确定性

认知偏差自检清单见 `references/bias-checklist.md`。

---

## Step 8: Deliverable Assembly（交付物组装）

详见 `workflows/07-deliverable-assembly.md`。

### 标准报告结构（6+2 章节，来自 AIGC review 沉淀）

| 章节 | 内容 | 张数 |
|------|------|------|
| 1. 行业全景 | 矩阵布局，行=赛道、列=地理、卡片大小=Tier | 1 |
| 2. 演进趋势 | 时间线 + 阶段主题 + S-curve 定位 | 1-2 |
| 3. 客户旅程 | 价值链 N 环节 × （现状/AI 介入/代表工具/解决方案） | 1-2 |
| 4. 企业深度卡 | 每家头部 1 页 | 10-15 |
| 5. 解决方案/产品矩阵 | 自家产品 × 场景映射 | 1-2 |
| 6. 重点发力场景 | TOP 3-5 高优先级场景 | 1-2 |
| +1. M&A / IPO 动态 | 并购、上市、退出 | 1 |
| +2. 成本/利润池对比 | 价值链 margin 分布 + 同类对比 | 1 |

### 必须交付的物料清单

1. **Research Charter** — 1 页，研究开始时签发
2. **行业全景图** — 单页矩阵
3. **演进时间线** — 单页水平时间轴
4. **估值排行榜** — TOP 15-20，国内/海外分轨
5. **企业深度卡** — 头部公司每家 1 页
6. **技术栈分层图** — 模型 / 服务 / 应用 / 基础设施（见 `references/stack-map.md`）
7. **客户旅程图** — IP/需求 → 生产 → 分发 → 变现（见 `references/value-chain-journey.md`）
8. **利润池图** — 价值链 margin 分布（见 `references/profit-pool.md`）
9. **利益相关方立场图** — 监管/版权方/渠道方/客户的态度（见 `references/stakeholder-stance.md`）
10. **分析框架画布** — 5 力雷达 + 7 Powers 评分 + Wardley 演化
11. **三情景预测** — Bull / Base / Bear 各 1 页
12. **Pre-mortem 报告** — 1 页
13. **数据底表** — Excel/CSV，所有公司结构化数据
14. **方法论附录** — 数据来源、假设、局限性、汇率/时间快照
15. **调研日志** — 每轮搜索的关键词、来源、覆盖率统计

---

## 行业原型选择器（Archetype Selector）

不同行业原型有不同必填项，避免"一套模板打天下"。详见 `archetypes/`：

| 原型 | 必填分析项 | 文件 |
|------|----------|------|
| Platform（双边平台） | 网络效应、take rate、liquidity、补贴策略 | `archetypes/platform.md` |
| Vertical SaaS | NRR、CAC payback、TAM 深度、垂直 know-how | `archetypes/saas-vertical.md` |
| DeepTech / Hardware | 技术成熟度（TRL）、专利护城河、研发管线、BOM | `archetypes/deeptech-hardware.md` |
| Marketplace | GMV、take rate、用户两端拉新成本、liquidity | `archetypes/marketplace.md` |
| Consumer App | DAU/MAU、留存曲线、ARPU、获客渠道集中度 | `archetypes/consumer.md` |
| Infrastructure / Cloud | 单位算力成本、客户集中度、产品矩阵 attach | `archetypes/infrastructure.md` |
| Content / Media | 子生态分层、IP/制作/分发、版权立场 | `archetypes/content-media.md` |

调研启动时必须先选定 1-2 个原型，对应的必填项纳入 Coverage Audit。

### 行业修饰符（Modifiers，v2.2 新增）

修饰符是**正交于基础原型**的额外特征标。当行业命中某修饰符时，叠加额外的必填分析项、刷新节奏与质量门控。

| 修饰符 | 触发条件 | 叠加要求 | 文件 |
|--------|---------|---------|------|
| 🚨 Rapidly-Evolving Catalog | 月度新版本 / SKU>20 / 价格波动 / 训练截止偏差敏感 | SKU Matrix、Version Timeline、Pricing 对比、Recency Sweep、周度刷新 | `archetypes/_modifier-rapidly-evolving.md` |

适用行业示例：MaaS / 大模型 API / AI 编程工具 / 向量数据库 / 浏览器自动化框架 / 视频生成 / 图像生成 / 多模态模型 / OSS GenAI 仓库。

**调用规则**：基础原型（如 Infrastructure / Cloud）+ 修饰符（如 Rapidly-Evolving Catalog）= 完整必填项集合。Coverage Audit 必须同时检查两份清单。

---

## Single Source of Truth（数据底表三件套 / 四件套）

所有 PPT / Excel / Markdown / HTML 交付物的数字都从下面主表派生，禁止在交付物里直接写数字。

```
data/
├── companies.jsonl     # 一行一家公司，遵循 schemas/company.schema.json
├── events.jsonl        # 一行一个事件（融资/上市/发布/并购），遵循 schemas/event.schema.json
├── sources.csv         # 来源 URL × 抓取日期 × 数据等级，遵循 schemas/source.schema.json
└── skus.jsonl          # 🆕 v2.2 (rapidly-evolving 修饰符必备): 一行一个 SKU/版本/型号，遵循 schemas/sku.schema.json
```

派生关系：
- 估值排行榜 ← `companies.jsonl` 按 `valuation.value_cny_yi` 降序
- 时间线 ← `events.jsonl` 按 `as_of` 升序
- 全景图 ← `companies.jsonl` 按 `racetrack_id × geo × tier` 聚合
- 深度卡 ← `companies.jsonl` 单条记录展开
- 数据底表（Excel）← `companies.jsonl` 直接 flatten 导出

任何交付物里的数字找不到在三张表的源头 → 拒收。

---

## 数据质量四件套（强制约束）

每个非常识数据点必须挂：

1. **数字 + 单位**（口径明确：GMV vs 营收 vs ARR 永不混用）
2. **来源 URL**（可访问原始链接，禁止"网络/业内"）
3. **抓取日期**（YYYY-MM-DD）
4. **数据等级**（L1 交易所/招股书 / L2 权威媒体 / L3 估算 / L4 传闻）

L3/L4 数据必须标注 `~` 或 `(估)` `(传)`。

---

## 并行 Agent 编排（入口）

详见 `workflows/00-execution-plan.md` 和 `templates/`。

| 切片维度 | 适用场景 | 子 Agent 模板 |
|---------|---------|-------------|
| 按赛道并行 | 跨赛道行业 | `templates/subagent-racetrack-scan.md` |
| 按公司并行 | TOP N 深挖 | `templates/subagent-company-deepdive.md` |
| 按数据源并行 | 同公司多源验证 | `templates/subagent-cross-validate.md` |
| 按地理并行 | 全球化行业 | `templates/subagent-racetrack-scan.md`（带 geo 参数） |
| 反方视角 | Thesis 阶段 | `templates/subagent-devil-advocate.md` |
| 量化建模 | Step 6 | `templates/subagent-quant-model.md` |

主 Agent 仅做汇总和质量门槛检查，不下场抓取。

---

## 反爬与数据源（入口）

详见 `references/source-matrix.md` 和 `references/crawl-strategy.md`。
估值追踪股票代码速查表、双值展示、未上市公司估值方法详见 `references/valuation-playbook.md`。

---

## 来源可信度与数据水分（入口）

详见 `references/bias-checklist.md`。
推广水文识别、数据水分识别、交叉验证最低要求都在那里。

---

## Dirty Work 清单（入口）

详见 `references/dirty-work-playbook.md`（公司名归一、单位换算、时间归一化、缺失值标注、引用溯源、汇率快照）。

---

## 行业经验法则（Rules of Thumb）

详见 `references/rules-of-thumb.md`。包含 SaaS / 平台 / 硬件 / 内容 / AI 等行业常用 ratio 与红线值。

---

## 工具脚本与可视化模板（v2.1 新增）

### scripts/ — 一键校验与建模

| 命令 | 作用 |
|------|------|
| `make validate` | 扫描 `data/*.jsonl` 与 `examples/*/*.jsonl`，校验 schema + datum 4 元组 |
| `make validate-strict` | 严格模式：缺 source / as_of / grade 直接 fail |
| `make unit-economics` | 跑 `templates/calculators/unit-economics-calculator.py`，从 companies 算 LTV/CAC/Payback/NRR/Magic/Rule of 40 |
| `make ue-md` | 同上但输出 Markdown 表 |
| `make all` | validate + unit-economics 全跑 |

实现：`scripts/validate.py`（纯标准库 JSON Schema 验证 + L1-L4 等级核对）+ `scripts/Makefile`。

### templates/calculators/ — 单位经济与 HTML→PPTX 流水线

| 文件 | 用途 |
|------|------|
| `unit-economics-calculator.csv` | Excel 版输入/输出表，SaaS / Marketplace / Consumer / DeepTech 预设 |
| `unit-economics-calculator.py` | Python 批处理，吃 jsonl 吐 CSV + Markdown，含 LTV/CAC、Payback、Magic Number、Rule of 40、Burn Multiple |
| `unit-economics-formulas.md` | 公式严格定义（ARR ≠ GMV ≠ Revenue）+ A/B/C/D 健康度评分卡 + 代理指标 |
| `htm-to-pptx-pipeline.md` | pptxgenjs 原生 PPTX 生成范式（addShape/addText，避免截图），含 phantom slideMaster Override 修复 |

### templates/visualizations/ — 10 个分析图骨架

每张图都是 Editorial 暗色风格的 SVG 内联骨架（或 HTML），数据点带 `<title>` 源标注：

| 文件 | 用途 |
|------|------|
| `landscape-grid.svg` | 行业全景矩阵：行=赛道、列=地理、卡片大小=Tier |
| `evolution-timeline.svg` | 演进时间线 + S 曲线 + 事件标记（普通/重大） |
| `porter-5forces-radar.svg` | Porter 五力雷达 |
| `wardley-map.svg` | Wardley 演化地图（Genesis→Custom→Product→Commodity × 用户可见度） |
| `value-chain-journey.svg` | 客户旅程价值链 N×4 矩阵（现状/AI 介入/工具/方案） |
| `profit-pool.svg` | 利润池图（X=营收占比累积 / Y=毛利率） |
| `stakeholder-stance.html` | 10 类利益相关方表格 + 影响力×态度散点图 |
| `company-deepdive-card.html` | 头部公司单页深度卡 |
| `valuation-leaderboard.html` | 估值排行榜，IPO 首日 vs 当前双值 + L1-L4 等级标 |
| `tam-sam-som-funnel.svg` | TAM/SAM/SOM 漏斗 + 三种算法交叉收敛 |

### references/source-recipes/ — 5 个深水行业取数菜谱

通用 Crunchbase / 财报抓取不够。本目录给监管/政策强敏感行业写专用菜谱：

| 文件 | 行业 | 核心难点 |
|------|------|---------|
| `medical.md` | 医疗 / 医药 / 器械 | NMPA/FDA 批件 vs 真实销售，集采价 ≠ 院内价 |
| `semiconductor.md` | 半导体 / EDA / IP | 产能 ≠ 出货 ≠ 营收，出口管制清单 |
| `auto.md` | 汽车 / 新能源 / 自驾 | 批发 ≠ 零售 ≠ 上险，L2+ ≠ L4，NEDC ≠ EPA |
| `fintech.md` | 支付 / 消金 / 数字银行 | GMV ≠ TPV ≠ Revenue，牌照地理限制 |
| `energy.md` | 光伏 / 储能 / 氢能 | 装机 ≠ 发电，VCM ≠ ETS 价 |

### references/refresh-cadence.md — 数据保鲜矩阵

按字段类别定义刷新频率：政策周度 / 融资月度 / 财报季度 / 年度。给每个 datum 的 `as_of` 字段配套了 🟢 Fresh / 🟡 Verify / 🔴 Refresh / ⚫ Discard 4 档动作矩阵。`validate.py --strict` 会按此矩阵报警。

### references/glossary.md — 行业研究术语词典

40+ 高频术语精校：用户类（MAU/ARPU/CAC/LTV/NRR/GRR/Magic/Payback）、SaaS 类（ARR/TCV/Rule of 40/Burn Multiple）、平台类（GMV/TPV/Take Rate/CM/Liquidity）、财务类（IRR/NPV/DCF/CAGR/TAM/SAM/SOM）、技术类（TRL/MVP/PMF）、框架类（Porter 5/7 Powers/Wardley/JTBD/Disruption）、数据等级（L1-L4）、不可写红线词。

---

## 训练截止偏差应对（v2.2 新增）

> 这是为了解决 LLM 驱动调研代理的最高危盲点：**catalog / SKU / 价格 / 版本号** 类字段被训练截止时间锚定，导致输出"老模型 + 老价格"的失败案例。

### 适用判定（4 选 1 即触发）

- 行业有月度新版本（如 MaaS、AI 编程工具、向量数据库、视频/图像生成模型）
- SKU > 20 个，且持续增长
- 价格在过去 12 个月内发生 ≥1 次重大调整
- 用户/客户对"最新"敏感（投标、采购、技术选型场景）

任一命中 → 加载 `archetypes/_modifier-rapidly-evolving.md`，按修饰符叠加要求执行。

### 必备资产

| 资产 | 文件 | 用途 |
|------|------|------|
| 修饰符定义 | `archetypes/_modifier-rapidly-evolving.md` | 触发条件、必填产物、SKU 穷举法、搜索词模板 |
| Recency 闸门 | `references/recency-guardrail.md` | 6 道防训练截止偏差闸门 + 子 Agent system prompt 五句魔法 |
| MaaS 取数菜谱 | `references/source-recipes/maas-and-models.md` | 国内/国外/聚合器 26 源 + 价格陷阱 9 类 + 7 步 SKU 穷举 |
| 旁证情报 | `references/side-channel-intel.md` | JD / 专利 / 投资 / GitHub / 应用商店 / Wayback 6 源 |
| 偏差识别 | `references/bias-checklist.md` 第 7 节 | 训练截止偏差自检 + 对策 |
| SKU Schema | `schemas/sku.schema.json` | SKU 级数据底表（params、pricing、benchmarks、deprecation 等） |
| SKU 矩阵骨架 | `templates/visualizations/sku-pricing-matrix.html` | 跨公司 SKU 对比与价格汇总 |
| 版本时间线骨架 | `templates/visualizations/version-timeline.svg` | 8 行 × 24 月版本演进 |
| 完整示例 | `examples/ex-maas-llm/` | MaaS 大模型目录 Charter + SKU 样本（13 LLM + 12 视频） |
| 周度刷新 | `references/refresh-cadence.md` 第 0 节 | catalog/SKU/价格 单独 7/14/30 天刷新矩阵 + Monday SKU Sweep |

### 五句魔法（写进 system prompt）

```
1. Do NOT rely on your training knowledge for SKU names, prices, or version numbers.
2. Always fetch the official pricing page LIVE before quoting any price.
3. Explicitly list any model that was released in the last 6 months.
4. If you cannot verify a SKU is still GA, mark it as Status: Unverified.
5. Cross-check your catalog against at least one third-party aggregator
   (OpenRouter / ArtificialAnalysis / LMArena / HuggingFace / MTEB).
```

---

## 快速上手

1. 第一次用：读 `workflows/00-execution-plan.md` 了解整体流程
2. 启动调研：先填 `workflows/01-research-charter.md` 模板拿 sign-off，**第一句必须是"Today is YYYY-MM-DD"（Today Date Stamp，见 recency-guardrail.md）**
3. 选定 1-2 个 `archetypes/*.md` 作为必填项基线
4. **🆕 判断是否触发 Rapidly-Evolving 修饰符**：若行业满足"月度更新 / SKU>20 / 价格波动 / 训练截止敏感"任一条，启用 `archetypes/_modifier-rapidly-evolving.md` 并跑 6 道 Recency Guardrail
5. 按 Step 3-8 执行，每一步参考对应 `workflows/*.md`
6. 子 Agent 任务从 `templates/*.md` 复制改造（**catalog 类必须把 recency-guardrail 5 句魔法语写入 system prompt**）
7. 数据校验：每填一批数据跑 `make validate`，发布前 `make validate-strict`
8. 可视化：从 `templates/visualizations/` 复制对应 SVG/HTML 骨架，按 SSOT 数据填值
9. 单位经济：把候选公司丢到 `templates/calculators/unit-economics-calculator.py`，输出表用于深度卡
10. 完整案例参考 `examples/`：
    - `ex-aigc-image/` — AIGC 图像（Platform + Vertical SaaS 混合）
    - `ex-saas-legaltech/` — 法律科技 SaaS（Vertical SaaS 原型）
    - `ex-marketplace-crossborder/` — 跨境电商 Marketplace
    - `ex-deeptech-autonomous/` — L4 自动驾驶（DeepTech / Hardware）
    - `ex-maas-llm/` — 🆕 MaaS 大模型目录（Infrastructure + Rapidly-Evolving 修饰符）

---

## Changelog

### v2.2.0 (2026-06-24)

针对"LLM 训练截止偏差"主题升级，重点解决 rapidly-evolving 行业（MaaS / 大模型 / AI 编程工具 / 向量库等）调研中的"老模型/老 SKU/老价格"通病：

1. **archetypes/_modifier-rapidly-evolving.md** — 新增"修饰符"概念（正交于基础原型），含触发条件、必填产物（SKU Matrix / Version Timeline / Pricing 对比）、SKU 穷举六步法、搜索词模板增强
2. **references/recency-guardrail.md** — 6 道闸门防训练截止偏差：Today Date Stamp / Recency Sweep / Pricing Page Fresh-Pull / Changelog Diff / 第三方聚合器反查 / Self-Disclosure，含 5 句魔法 system prompt + 自审清单
3. **references/source-recipes/maas-and-models.md** — MaaS 专用菜谱：国内 8 家平台 + 国外 9 家平台 + 第三方聚合器 9 个；价格陷阱 9 类（input/output、cache hit、batch、reasoning token、multi-modal、GA vs Beta）；7 步 SKU 穷举；周度刷新清单
4. **references/side-channel-intel.md** — 6 个旁证情报源（招聘 JD / 专利地图 / 投资联盟 / GitHub / 应用商店 / Wayback Machine），每个含工具、产出、方法、陷阱
5. **schemas/sku.schema.json** — SKU 级 JSON Schema：id、release_date、status (GA/Beta/Preview/Deprecated/Private/Sunset)、params (context/modality/分辨率/时长)、pricing (input/output/cache/reasoning/image/video/audio/free/batch/tiered)、rate_limits、predecessor/successor、benchmarks、deprecation、sources
6. **templates/visualizations/sku-pricing-matrix.html + version-timeline.svg** — 2 张 catalog 类专用骨架：SKU 矩阵 + 跨公司价格对比；24 个月 × 8 行版本时间线
7. **examples/ex-maas-llm/** — MaaS 完整 Charter 示例：13 行 LLM SKU Matrix + 12 行视频生成 SKU Matrix，显式覆盖训练截止盲点（wan2.7 / seedance-2.5 / seedance-2.0-4k / sora-2 / veo-3 / hailuo-r2v / claude-opus-4 / o3 / qwen3-max 等）
8. **references/bias-checklist.md** — 新增第 7 类偏差"训练截止偏差"，含症状、自检、对策与 5 句魔法语
9. **references/refresh-cadence.md** — 新增"Catalog / SKU / 价格"超敏感字段单独刷新矩阵（7/14/30 天三档）+ 每周一 SKU Sweep 实操流程
10. **INDEX.md（包根）** — 一页式快速索引，对齐推荐目录结构

### v2.1.0 (2026-06-24)

新增 7 项能力，全部围绕"从方法论到可执行工程"：

1. **3 个新 examples** — 法律科技 SaaS、跨境电商 Marketplace、L4 自动驾驶 DeepTech，每个含 README 8 步全过程 + companies-sample.jsonl 真实数据 + racetracks.jsonl 赛道树
2. **scripts/validate.py + Makefile** — 纯标准库 JSON Schema 校验器，按 schemas/ 自动推断，扫描 datum 4 元组完整性，0/1/2 退出码
3. **templates/calculators/** — Excel + Python 双版单位经济计算器，公式严格定义（ARR≠GMV≠Revenue），含 HTML→PPTX 原生流水线模板
4. **templates/visualizations/** — 10 张 SVG/HTML 可视化骨架（Editorial 暗色），覆盖全景图/时间线/Porter/Wardley/价值链/利润池/利益相关方/深度卡/估值榜/漏斗
5. **references/source-recipes/** — 5 个深水行业取数菜谱（医疗/半导体/汽车/金融/能源），各含权威库 + 监管批件 + 口径陷阱 + 红线
6. **references/refresh-cadence.md** — 数据保鲜矩阵 + 4 档动作（Fresh/Verify/Refresh/Discard）+ 季度/月度/周度刷新流程
7. **references/glossary.md** — 40+ 行业研究术语精校词典，含不可写红线词表

### v2.0.0 (2026-06-24 早些时候)

从单文件 v1 升级为多文件分包：8 步法、7 archetypes、4 通用画布、SSOT 三件套、Coverage Audit 阻断闸门、Devil's Advocate 子 Agent。
