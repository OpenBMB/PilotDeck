# Glossary — 行业调研术语词典

行业研究高频术语精校释义。表里术语都是 Skill 包内部出现过的，定义采用业界共识口径，避免同名不同义。

> ⚠️ 任何看到"我以为我懂"的词，先回这里查一遍。术语错位是行业报告 80% 错误的源头。

## 用户 / 客户类指标

| 术语 | 缩写 | 定义 | 易混点 |
|------|------|------|-------|
| Monthly Active Users | MAU | 30 天内有过 1 次以上活跃行为的用户数 | "活跃"定义因产品不同（登录 / 操作 / 留存） |
| Daily Active Users | DAU | 24 小时内活跃 1 次以上 | DAU/MAU = 粘性指标 |
| Quarterly Active Users | QAU | 90 天内活跃 1 次以上 | 低频应用常用（如银行 App） |
| Average Revenue Per User | ARPU | 营收 ÷ 活跃用户数 | 分子用 Revenue 还是 Net Revenue？分母用 MAU/DAU/付费用户？须明确 |
| Customer Acquisition Cost | CAC | 获新客成本 = 营销费用 ÷ 新增客户数 | Blended CAC（全渠道平均） vs Paid CAC（仅付费渠道） |
| Lifetime Value | LTV | 客户全生命周期为公司创造的毛利贡献 | 简化公式：ARPU × Gross Margin × (1/Churn) |
| LTV/CAC | — | 客户终身价值与获客成本之比 | >3 健康，<1 模型不成立 |
| Churn Rate | — | 一定时间窗内流失客户占比 | 月 Churn 还是年 Churn？逻辑客户 vs 收入留存？须分清 |
| Net Revenue Retention | NRR | 同一批客户在一年后的留存收入 ÷ 起始收入 | 包含 expand / upgrade，>120% = 顶级 SaaS |
| Gross Revenue Retention | GRR | 同上但不含 upsell | 仅看流失 + downgrade，反映底线 |
| CAC Payback Period | — | 收回 CAC 所需月数 = CAC ÷（ARPU × Gross Margin / 12） | <12 月顶级，<24 月健康 |
| Magic Number | — | (本季 ARR 增量 × 4) ÷ 上季销售营销费用 | >1 = 销售效率高 |

## SaaS / B 端指标

| 术语 | 缩写 | 定义 | 易混点 |
|------|------|------|-------|
| Annual Recurring Revenue | ARR | 年化经常性收入（不含一次性） | ARR ≠ Revenue ≠ Booking ≠ Cash |
| Monthly Recurring Revenue | MRR | 月度经常性收入，ARR = MRR × 12 | 仅适用 SaaS 订阅制 |
| Total Contract Value | TCV | 合同总额（含一次性服务费 + 多年金额） | 多年合同 TCV > ARR |
| Annual Contract Value | ACV | 年化合同价值 | 平摊多年合同到单年口径 |
| Rule of 40 | — | 增长率 + 营运利润率（或 FCF 率） ≥ 40% | SaaS 健康基线 |
| Burn Multiple | — | Net Burn ÷ Net New ARR | <1 优秀，>3 危险 |
| Net Burn | — | 现金消耗（不含融资活动）| 不等于会计亏损（含非现金项目） |

## 平台 / Marketplace 指标

| 术语 | 缩写 | 定义 | 易混点 |
|------|------|------|-------|
| Gross Merchandise Value | GMV | 平台撮合的商品交易总额 | GMV ≠ Revenue（取费率才是营收） |
| Total Payment Volume | TPV | 支付平台总支付流水 | 支付公司常用，含双方进出 |
| Take Rate | — | 平台抽佣率 = Revenue ÷ GMV | 0.5%-10% 不等，与品类强相关 |
| Contribution Margin | CM | 单笔订单/单客户层面的净贡献（去除变动成本） | 不等同毛利率 |
| Liquidity / Match Rate | — | 平台撮合成功率（供需两侧） | 双边网络效应核心指标 |
| Cross-side Network Effect | — | 一边用户增加提升另一边价值 | Marketplace 核心护城河 |

## 财务 / 资本类

| 术语 | 缩写 | 定义 | 易混点 |
|------|------|------|-------|
| Internal Rate of Return | IRR | 项目内部收益率，使 NPV=0 的折现率 | 与 CapEx 周期强相关 |
| Net Present Value | NPV | 现金流折现总和 | 折现率假设影响巨大 |
| Discounted Cash Flow | DCF | 现金流折现估值法 | 长期假设敏感性极强 |
| Compound Annual Growth Rate | CAGR | 复合年增长率 | 端点选择会扭曲结论（注意"窗口选择偏差"） |
| Total Addressable Market | TAM | 理论市场总规模 | 通常被高估 |
| Serviceable Addressable Market | SAM | 公司可达成市场 | TAM × 地理/品类约束 |
| Serviceable Obtainable Market | SOM | 公司 N 年内现实可拿份额 | 通常 SAM × 5-25% |

## 技术 / 产品成熟度

| 术语 | 缩写 | 定义 | 易混点 |
|------|------|------|-------|
| Technology Readiness Level | TRL | NASA 起源，1-9 级技术成熟度 | TRL 6+ 才有商业化潜力 |
| Minimum Viable Product | MVP | 最小可行产品 | 验证假设而非完整产品 |
| Product-Market Fit | PMF | 产品满足真实市场需求的状态 | 难量化，常用"40% 用户失去会非常失望" |
| Software-as-a-Service | SaaS | 订阅 + 多租户 + 云交付 | 区别 On-prem、PaaS、IaaS |
| Software-Defined X | SDV/SDN/SDS | 用软件定义传统硬件功能 | 汽车 / 网络 / 存储 三大方向 |

## 分析框架

| 术语 | 来源 | 含义 |
|------|------|------|
| **Porter 5 Forces** | Michael Porter, 1979 | 五力分析：现有竞争 / 进入者 / 替代品 / 客户议价 / 供应商议价 |
| **7 Powers** | Hamilton Helmer, 2016 | 7 种持续竞争优势：Scale Economies / Network Economies / Counter-Positioning / Switching Costs / Branding / Cornered Resource / Process Power |
| **Wardley Map** | Simon Wardley, 2005 | 横轴 evolution (Genesis→Custom→Product→Commodity)，纵轴 user-visibility |
| **Jobs-to-be-Done** | Christensen, 2003 | 客户"雇佣"产品来完成的 job |
| **S-curve** | Tech adoption curve | 早期慢-中期爆发-后期饱和的 S 形 |
| **Disruption Theory** | Christensen, 1997 | 低端切入 → 性能改进 → 颠覆在位者 |
| **Value Chain** | Porter, 1985 | 价值链：从原材料到终端用户的活动序列 |
| **Profit Pool** | Bain, 1998 | 价值链各环节的利润集中度图谱 |

## 数据 / 来源等级

| 等级 | 来源类型 | 例子 |
|------|---------|------|
| **L1** | 一手官方/原始材料 | 10-K / NMPA 批件 / 央行公告 |
| **L2** | 知名第三方独立机构 | Gartner / IDC / IEA / IQVIA / BNEF |
| **L3** | 行业 trade press / 协会 | EE Times / 36氪 / 中汽协 |
| **L4** | 二手转引 / 自媒体 / 估算 | 公众号 / 知乎 / 推断值 |

## 不可写 / 红线词

| 不要用 | 改用 | 原因 |
|--------|------|------|
| "市场规模 1000 亿元" | "TAM 1000 亿元 (源: XX, as_of YYYY)" | 须标注口径 + 来源 + 日期 |
| "行业领先" | "市占率 35% (排名第 2)" | 主观词换可比指标 |
| "据传 / 业内人士" | "暂未查证" + 引用窗口 | 不接受口头转述 |
| "VS 同行" | 指名道姓的具体公司 | 避免模糊比较 |

---

如发现术语缺漏 / 定义有误，请在 SKILL.md 记录 changelog 后补充至本表。
