# Subagent Prompt: Quantitative Modeling

> 用于 Step 6 量化建模。下放给独立子代理，专注算账。

## 任务输入

```
companies.jsonl: 全部公司画像
racetrack.jsonl: 全部赛道画像
archetype: {target_archetype}（决定算什么 KPI）
基准汇率: {USD/CNY, HKD/CNY, EUR/CNY}（从 snapshots/fx-rates.csv）
```

## 你的目标

按 `workflows/05-quant-modeling.md` 输出四类模型：

### 1. 单位经济 (Unit Economics)

按 archetype 选 KPI 集（参见 `references/rules-of-thumb.md`）：
- SaaS: NRR / GRR / CAC Payback / LTV/CAC / Magic Number / Rule of 40 / Burn Multiple
- Marketplace: Take Rate / Liquidity / Disintermediation Rate / Repeat Buyer
- Consumer: D1/D7/D30 Retention / ARPU / Payment Conversion
- DeepTech: R&D Ratio / Gross Margin / Customer Concentration / TRL
- Infra: Capex/Revenue / Utilization / TOP3 Customer Concentration

每家公司一列，每个 KPI 一行；填不到的标"未披露"或"不适用"。

### 2. TAM / SAM / SOM

按**三方法交叉**：
- **Top-down**：从全球总市场拆赛道占比（来源：Gartner / IDC / Statista）
- **Bottom-up**：客户数 × 客单价 × 渗透率（来源：行业普查 / 同业基准）
- **Comparable**：对标成熟市场（如新兴市场 / 历史可比阶段）

**当 3 个估算差异 < 30%** → 取中位数 + 标注三源
**当差异 > 30%** → 报告分歧、解释根因、取最保守值

### 3. Profit Pool

按 `references/profit-pool.md`：
- 沿 Stack Map 分 5-10 段
- 每段填：营收 ($B) / 净利率 (%) / 净利润 ($B) / 来源
- 输出 2-5 年趋势（如有数据）
- 计算利润集中度（前 3 段占比）

### 4. 敏感性分析

对 House View 的关键假设做 ±20% 扰动测试：
- 关键变量：增速 / 毛利率 / 市占率 / Capex 强度
- 输出：变量 × 影响幅度 矩阵
- 标记"高敏感"（结论翻转的变量）

## 输入数据要求

- 所有金额必须经过单位归一（统一亿元或亿美元 + 标注原币和汇率）
- 所有日期统一 ISO 格式
- 所有数据带 4 元组（数值 + 来源 + 日期 + 等级）
- 缺失值不能填 0（用 "未披露" 字符串）

## 输出格式

```
outputs/
├── unit-economics.csv (公司 × KPI 矩阵)
├── tam-sam-som.json (三方法明细 + 中位数)
├── profit-pool.csv (环节 × {营收, 利润率, 净利润, 来源})
├── sensitivity-analysis.csv (变量 × 影响)
└── quant-model-log.md (假设清单 + 公式 + 数据来源)
```

## 计算规则

### 增速对齐
- 同比 vs 环比要明示（用 YoY / QoQ 后缀）
- 累计增速 vs 年化增速要明示

### 折现率（如需 DCF）
- 默认 WACC = 10% (DM) / 12% (EM China) / 15% (early stage)
- 用户明确指定 → 用用户值

### 估值倍数
- 看 archetype 选 EV/ARR / EV/EBITDA / EV/GMV / EV/MAU
- 倍数来源：可比公司均值 + 行业研报基准（标注来源）

### 货币
- 主货币：人民币（统一）
- 副货币：美元（国际可比）
- 汇率：用快照，不混用

## 输出物示例（节选）

### unit-economics.csv (SaaS 行业示例)
```
Metric, Company-A, Company-B, Company-C, Benchmark
NRR, 115%, 108%, 92%, ≥110%
CAC Payback (months), 14, 24, 38, ≤18
LTV/CAC, 4.2, 2.8, 1.5, ≥3
Rule of 40, 52, 28, -5, ≥40
```

### profit-pool.csv (示例)
```
Segment, Revenue_USD_BN, Net_Margin_PCT, Net_Profit_USD_BN, Source
Layer 1 - Infra, 150, 55, 82.5, NVIDIA FY25 10-K
Layer 2 - Model, 20, -100, -20, The Information 2025-04
Layer 3 - Platform, 15, 15, 2.25, Industry estimate
Layer 4 - App, 8, 20, 1.6, SaaS median
Layer 5 - Surface, 25, 5, 1.25, Consumer median
```

## 禁止事项

- ❌ 把毛利率当净利率
- ❌ 缺失值填 0 或编估算（必须显式标"未披露"）
- ❌ 不同财年数据直接对比
- ❌ TAM 用单一来源（必须 3 法交叉）
- ❌ 不做敏感性分析直接给点估值

## 一句话总结

按 archetype 算账，三法交叉 TAM，画出利润池，做敏感性分析。**所有数都有 4 元组。**
