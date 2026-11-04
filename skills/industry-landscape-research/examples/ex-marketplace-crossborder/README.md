# 示例：跨境电商 Marketplace（Marketplace 原型）

> 本示例展示 archetype = `marketplace` 时，如何套用八步法对"跨境电商平台"行业做完整调研。
> 关键差异点：双边/三边网络效应、take rate、liquidity（两端供需匹配）、GMV ≠ 营收（强制区分）、补贴策略与单位经济学的微妙博弈。

## Step 1: Charter

| 字段 | 取值 |
|------|------|
| Scope | 面向终端消费者的跨境 B2C/B2B2C 电商平台：全品类（Amazon Global、AliExpress、SHEIN、Temu、TikTok Shop）+ 垂类（Wayfair 家具、Farfetch 奢侈品、Fanatics 体育） |
| Out-of-Scope | 跨境物流单独环节（菜鸟/燕文）、跨境支付（PingPong/Payoneer）、B2B 批发平台（Alibaba.com） |
| Audience | 战略部 + 海外业务部 |
| Decision | 是否在 2026 立项推 SHEIN/Temu 模式的"全托管"型新平台；要不要押宝东南亚/拉美/中东中的某一个 |
| Hypotheses | ① 全托管（M2C）模式比 marketplace 模式 take rate 高 60-80%；② TikTok Shop 在东南亚 24 月达 SHEIN 同期 5 倍；③ 拉美/中东比东南亚利润率更高 |
| Success Criteria | 全球 TOP 12 平台 GMV/营收/take rate 全部 L1+L2 覆盖；至少 2 家披露 contribution margin；区域细分（NA/EU/SEA/LATAM/MENA）数据齐全 |

## Step 2: Decompose（按业务模式 × 地理）

```
跨境电商
├── 按模式
│   ├── 全托管 M2C（SHEIN, Temu, TikTok Shop 半托管, Alibaba International）
│   ├── 半托管/平台型（AliExpress, Lazada, Shopee）
│   ├── 自营 B2C（Amazon Global, JD International）
│   └── 垂类（Farfetch 奢侈、Wayfair 家具）
└── 按地理（GMV 体量降序）
    ├── 北美：Amazon, SHEIN, Temu, eBay International
    ├── 欧洲：Amazon EU, Zalando, AliExpress, About You
    ├── 东南亚：Shopee, Lazada, TikTok Shop, Tokopedia
    ├── 拉美：Mercado Libre, SHEIN, Amazon Mexico
    └── 中东：Noon, Amazon ME, SHEIN, Namshi
```

子生态分层（来自 `archetypes/marketplace.md` 必填项）：
- 供给侧：商家（中国白牌 / 全球品牌 / 工厂直供 M2C）
- 需求侧：消费者画像（Z 世代 / 价格敏感 / 高频复购）
- 撮合层：算法/搜索/推荐
- 履约层：物流（自建 vs 第三方）、支付、客服、退货

## Step 3-4: 数据采集 + Coverage

R1 公司清单 18 家；R2 GMV/营收/take rate 三件套覆盖 15/18。

### Coverage Audit 矩阵

| 维度 | 覆盖 | 等级 |
|------|------|------|
| GMV | 16 / 18 | ⭐⭐⭐⭐⭐ 🟢 |
| Take Rate | 14 / 18 | ⭐⭐⭐⭐ 🟢 |
| 月活用户 MAU | 17 / 18 | ⭐⭐⭐⭐⭐ 🟢 |
| 区域细分 | 12 / 18 | ⭐⭐⭐ 🟡 |
| Contribution Margin | 6 / 18 | ⭐⭐ 🔴 |
| Logistics 自建率 | 10 / 18 | ⭐⭐⭐ 🟡 |

🔴 Contribution Margin 缺口：从上市公司 10-K 抠到 5 家，私有公司 1 家披露过；其他用 take rate × (1-退货率-fulfillment cost) 估算。

## Step 5: 框架分析

### Marketplace 三度量金三角（必填）

| 平台 | Take Rate | Liquidity（订单匹配时间） | NPS / 复购率 |
|------|-----------|---------------------------|--------------|
| Amazon Global | 15-20% | <1 day | 73% 复购 |
| SHEIN | 80%+ (M2C 模式) | 3-7 days | 60% 复购 |
| Temu | 90%+ (M2C 模式) | 7-15 days | 45% 复购 |
| Shopee | 6-10% | <1 day | 55% 复购 |
| TikTok Shop | 5-8% | <2 day | 待披露 |

> M2C 模式的 "take rate" 在会计上是毛利率口径，与 marketplace take rate 不可直接比较——本审计严格区分两类口径。

### Wardley Map 演化（核心三轴：撮合 → 履约 → 内容）

- 撮合（搜索/推荐）：已 commodity 化，靠算法迭代差异
- 履约（仓配/海外仓）：从 custom-built 走向 product/commodity（SHEIN 自建 → 行业基础设施）
- 内容/视频化（直播/短视频带货）：从 genesis 走向 custom-built（TikTok Shop 领跑）

## Step 6: 量化建模

### 单位经济学（按平台）

| 平台 | AOV | Take Rate / Margin | CAC | Payback | Contribution Margin |
|------|-----|---------------------|-----|---------|---------------------|
| SHEIN | $75 | 80% (M2C 毛利率) | $14 | 3 单 | 18% |
| Temu | $25 | 90% (M2C 毛利率) | $50 | 12-18 单 | -3%（仍补贴期）|
| Shopee | $12 | 8% | $4 | 4 单 | 5% |
| Amazon Global | $40 | 15% | $25 | 8 单 | 11% |

> 数据来源：摩根大通行研报告 2024-Q4；Marketplace Pulse；Temu 数据为推算。

### TAM/SAM/SOM

- 自上而下：全球电商市场 $6.3T × 跨境占比 22% = $1.4T TAM
- 自下而上：30 亿全球网购用户 × ARPU $450 = $1.35T TAM
- 类比：中国电商成熟后渗透率 40%，按全球电商 $6.3T → 跨境潜在 $1.5-2T

## Step 7: Thesis

### House View

> 跨境电商主战场正在从"商品差异"切换到"履约+内容+供应链速度"三轴竞争；M2C 全托管模式 2024-2026 仍是收割期，但 contribution margin 在补贴退潮后会暴露真实问题；TikTok Shop 的崛起重构了"流量入口"的定义；东南亚是 take rate 提升空间最大的市场，拉美/中东是 GMV 增长最快的。

### 三情景

| 情景 | 触发条件 | 概率 | 全球 GMV 5 年规模 |
|------|----------|------|-------------------|
| Bull | 美国不出新关税、Temu 实现盈利、TikTok Shop 不被禁 | 25% | $2.4T |
| Base | 关税温和上调、SHEIN 上市成功、Temu 减速但盈利 | 55% | $1.8T |
| Bear | 美对 SHEIN/Temu de minimis 全面关闭、TikTok 被强制剥离 | 20% | $1.0T |

### Pre-mortem

1. 美国关闭 $800 de minimis 关税豁免（已经在 2025 通过部分）
2. TikTok Shop 在美被强制剥离或关停
3. SHEIN/Temu 价格战伤及行业利润池
4. Z 世代消费力衰退（美国信用卡债创历史新高）
5. 欧盟 / 印尼 / 印度 出台禁令性数字关税

## 关键经验沉淀

- Marketplace 调研禁止把 GMV 当营收，必须强制三栏分列（GMV / Take Rate / Revenue）
- M2C 模式（SHEIN/Temu）与传统 marketplace 是两种生意，单位经济学口径不可直接比较——审计要标注
- 区域细分（NA/EU/SEA/LATAM/MENA）的 take rate 差异巨大，平均化处理 = 误判
- 必查 stakeholder：美国 USTR、欧盟 DSA、印尼/印度禁令，立场图（见 `references/stakeholder-stance.md`）
