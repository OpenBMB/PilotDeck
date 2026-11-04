# 示例：法律科技 SaaS（Vertical SaaS 原型）

> 本示例展示 archetype = `saas-vertical` 时，如何套用八步法对"法律科技"行业做完整调研。
> 关键差异点：客户群高度专业（律所/法务）、单客单价高、续约/扩展（NRR）是命脉、合规要求重、产品矩阵深度优先于广度。

## Step 1: Charter（一句话定锚）

| 字段 | 取值 |
|------|------|
| Scope | 面向律所/企业法务的 SaaS 工具：合同生命周期管理（CLM）、法律研究检索、案件管理、合规自动化、电子取证（eDiscovery）、法律 AI 起草/审阅 |
| Out-of-Scope | C 端法律咨询 App（如离婚咨询）、法律出版物（Westlaw 内容订阅本身）、政府/法院信息化项目（B-to-G）|
| Audience | 战略投资部 / 行业 BD |
| Decision | 是否设立 2 亿元法律科技专项基金；优先押注 CLM 还是 AI 起草 |
| Hypotheses | ① CLM 是法律科技最大市场；② GPT 系模型让"AI 起草"从工具升级为基础设施；③ 中美法律科技市场分化（中国偏律所管理，美国偏跨境合规） |
| Success Criteria | 全球 TOP 25 玩家覆盖 ≥90%；NRR/CAC payback 数据 L1+L2 占比 ≥70%；至少 2 家公司有招股书或财报佐证 |

## Step 2: Decompose（按价值链 + 产品类目）

```
法律科技
├── A. 内容/数据层
│   ├── A1 法律检索数据库（Westlaw, LexisNexis, 法信, iCourt）
│   └── A2 监管/合规数据（Compliance.ai, RegulationOne）
├── B. 工具/工作流层
│   ├── B1 合同生命周期管理 CLM（Ironclad, DocuSign CLM, Icertis, 法大大、e签宝）
│   ├── B2 案件/律所管理（Clio, MyCase, iManage, Aderant）
│   ├── B3 电子取证 eDiscovery（Relativity, Everlaw, DISCO, Logikcull）
│   └── B4 法律 AI 起草/审阅（Harvey, Spellbook, EvenUp, Casetext-CoCounsel）
└── C. 终端服务层
    ├── C1 ALSP 替代法律服务提供方（Axiom, Elevate）
    └── C2 法律市场撮合（Atrium 已关停、UpCounsel）
```

子生态分层（来自 `archetypes/saas-vertical.md` 必填项）：
- 客户分层：Magic Circle 国际所 / AmLaw 100 / 区域所 / 企业法务部 / 中小所
- 渠道：直销 / 经销商 / 律所行业协会（ILTA, ACC）合作
- 集成生态：Microsoft 365 / Salesforce / iManage / NetDocuments 是否原生集成

## Step 3-4: Search + Coverage（执行结果摘要）

R1 公司清单 28 家（北美 18 / 欧洲 5 / 中国 5）；R2 NRR 字段覆盖 19/28；R3 + R4 补齐至 23/28。

### Coverage Audit 矩阵

| 维度 | 覆盖 | 等级 |
|------|------|------|
| 公司数 | 28 / 全球 ~35 | ⭐⭐⭐⭐⭐ 🟢 |
| NRR | 23 / 28 | ⭐⭐⭐⭐ 🟢 |
| ARR | 19 / 28 | ⭐⭐⭐ 🟡 |
| CAC Payback | 11 / 28 | ⭐⭐ 🔴 (大量私有公司未披露) |
| 客户名单 TOP10 | 25 / 28 | ⭐⭐⭐⭐ 🟢 |
| AI 模型/合规策略 | 17 / 28 | ⭐⭐⭐ 🟡 |

🔴 缺口处置：CAC Payback 通过 ARR/客户数估算上下限，标 L3。

## Step 5: 分析框架（节选）

### Porter 五力（法律科技整体）

| 维度 | 分（1-5） | 解读 |
|------|-----------|------|
| 现有竞争 | 4 | CLM 赛道头部 3 家 + 中尾 30+ 家，价格战已出现 |
| 替代品威胁 | 4 | GPT-4/Claude 让律所自建工具门槛骤降，且 ALSP 蚕食律所外包 |
| 新进入威胁 | 3 | 数据/合规壁垒高，但 AI Native 厂商（Harvey、Spellbook）2023 后大量出现 |
| 客户议价力 | 2 | 律所采购集中度低，单客议价弱；但 AmLaw 100 集体合规标准提升话语权 |
| 供应商议价 | 3 | 依赖 OpenAI/Anthropic 模型，模型涨价直接吃毛利 |

### Helmer 7 Powers（以 Harvey 为例）

| Power | 评分 | 证据 |
|-------|------|------|
| Scale Economies | 2 | 早期，规模优势未显现 |
| Network Economies | 3 | 律所之间案例库共享存在但弱 |
| Counter-Positioning | 4 | 律所自建 AI 不如 SaaS 专精，结构性优势 |
| Switching Costs | 4 | 集成进律所工作流后切换成本高 |
| Branding | 4 | OpenAI 联合背书 + 顶级所站台 |
| Cornered Resource | 3 | 早期数据（PwC、A&O 合作）+ 客户 logo |
| Process Power | 2 | 流程沉淀尚浅 |

## Step 6: 量化建模

### 单位经济学（北美 CLM 中位数，2025-Q2）

| 指标 | 中位数 | 边界 |
|------|--------|------|
| ARR per customer | $85K | $30K - $400K |
| Gross Margin | 76% | 70% - 82% |
| NRR | 115% | 105% - 130% |
| CAC Payback | 18 月 | 12 - 30 月 |
| Rule of 40 | 28% | 12% - 52% |

### TAM/SAM/SOM 三种算法

- 自上而下：全球律所市场 $850B × 法律科技渗透率 4% = $34B TAM
- 自下而上：全球律所 17 万家 × 平均年费 $30K × 适用率 60% = $30.6B TAM
- 类比：HR Tech / Sales Tech 渗透率成熟后 8-12%，可达 $68-102B

中位数收敛在 $32-35B TAM。

## Step 7: Thesis 综合

### House View（一句话）

> 法律科技正从"工作流工具"向"AI 起草助理 + 工作流"双层结构演进；CLM 仍是金矿但成熟，2025-2027 真正的 alpha 在 AI 起草层；中美市场分化是结构性的，押注须区分赛道。

### 三情景

| 情景 | 触发条件 | 概率 | 5 年市场规模 |
|------|----------|------|-------------|
| Bull | LLM 通过律考、保险公司接受 AI 起草、Big 4 大规模 ALSP 替代 | 25% | $80B |
| Base | LLM 仅辅助、律所采用率 50%、CLM/AI 各占半壁江山 | 55% | $50B |
| Bear | 监管反扑（律协禁 AI 起草）、模型成本不下降 | 20% | $25B |

### Pre-mortem（被证伪的 5 种可能）

1. 律所协会 ABA / 中国律协 出台"AI 不得起草"禁令
2. OpenAI/Anthropic API 涨价 3 倍，法律 AI 厂商集体亏损
3. Microsoft Copilot for Legal 内嵌进 Word，独立厂商被绞杀
4. 大型律所自建团队（A&O Harvey 2.0）足以替代外购
5. 客户/合伙人接受度低于预期，AI 起草沦为律师助理玩具

## Step 8: 交付（节选自标准 6+2 章节）

详见 outputs/legaltech-deck.pptx（标准 25 页结构）：全景图、演进时间线、CLM/AI 起草双子赛道深度卡、Harvey/Ironclad/Clio 三家 1 页 deepdive、TAM 推演、三情景、Pre-mortem、参考来源。

## 关键经验沉淀

- Vertical SaaS 调研必须把 NRR 抠到底，没有 NRR 就没法判断"是不是好生意"
- 合规/监管立场比单纯的产品对比更影响 thesis（参考 `references/stakeholder-stance.md`）
- 国际所 vs 区域所 vs 企业法务的购买逻辑完全不同，禁止平均化处理
