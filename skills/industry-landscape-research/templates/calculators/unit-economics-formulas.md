# 单位经济学公式速查与解读

## 核心定义口径（禁止混用）

| 指标 | 严格定义 | 常见误用 |
|------|---------|---------|
| ARR | 年化经常性收入（合同/订阅口径，不含一次性） | 把 GMV 当 ARR |
| GMV | 平台总交易额（marketplace） | 把 GMV 当营收 |
| Revenue | GAAP 营收（已确认） | 与 bookings 混用 |
| ARPU | 单用户月均收入 | 把活跃用户与付费用户混 |
| Churn | 月流失 = 流失数 / 期初活跃 | 与 retention 混淆 |
| NRR | 净留存 = (期末 - 流失 - 降级 + 扩展) / 期初 | 不含扩展则是 GRR |
| GRR | 总留存 = (期末 - 流失) / 期初 | 与 NRR 混淆 |

## 完整公式集

### 客户层面

```
LTV (客户终身价值) = ARPU × Gross Margin% / Monthly Churn%
                  ≈ ARPU × Margin × (1 / 月流失率)

CAC (获客成本) = 季度销售营销费用 / 季度新增客户数
              = （Sales + Marketing Spend）/ New Customers
              注：含人头/广告/工具/活动；不含 R&D
```

### 效率层面

```
LTV/CAC = LTV / CAC
        健康：≥ 3 ；优秀：≥ 5；危险：< 2

CAC Payback = CAC / (ARPU × Gross Margin%)
            健康：< 18 个月；危险：> 24 个月

Magic Number = (本季度 ARR - 上季度 ARR) × 4 / 上季度 S&M
             健康：≥ 1.0；优秀：≥ 1.5
```

### 留存层面

```
NRR = (期末 ARR - 流失 ARR - 降级 ARR + 扩展 ARR) / 期初 ARR × 100%
    强健：≥ 110%；优秀：≥ 130%；危险：< 100%

GRR = (期末 ARR - 流失 ARR - 降级 ARR) / 期初 ARR × 100%
    上限即 NRR 减去扩展贡献；健康：≥ 90%
```

### 综合层面

```
Rule of 40 = Revenue Growth YoY% + EBITDA Margin%
           健康：≥ 40；优秀：≥ 50；衰退：< 30

Burn Multiple = 季度净亏损 / 季度净新增 ARR
              健康：< 1.5；危险：> 2.5

Contribution Margin = (Revenue - Variable Cost) / Revenue
                    必须为正才能规模化；负值意味着每多卖一单亏更多
```

## Marketplace 特别口径

```
Take Rate = Revenue / GMV
          注：M2C 模式（SHEIN/Temu）口径不同，是毛利率而非佣金，禁止与平台型 take rate 直接比较

Frequency = Annual Orders / Active Users

AOV (Average Order Value) = GMV / Total Orders

Net Revenue per Customer = AOV × Frequency × Take Rate

Liquidity = (订单匹配时间) ↓ 或 （供给端响应时间）↓
```

## Consumer App 特别口径

```
ARPDAU = 日营收 / DAU
ARPPU = 付费用户 ARPU

DAU/MAU Ratio (粘性) = DAU / MAU
                    Twitter ≈ 0.50；Snapchat ≈ 0.70；Slack ≈ 0.85

D1/D7/D30 Retention = 注册后 1/7/30 天仍活跃的比例
                   Casual game D30 < 5%；社交 D30 > 30%；工具 D30 > 50%
```

## DeepTech 特别口径

```
Capital Efficiency = 累计营收 / 累计融资
                  早期 0.1×；成熟 1.0×；明星 > 2×

Runway (生存期) = 现金余额 / 月烧钱
              健康：≥ 18 个月

Time to Revenue = 公司创立到第一笔商业化营收的月数
                DeepTech 中位数 36-60 月
```

## 健康度评分卡（综合）

| 维度 | A 级 (≥) | B 级 | C 级 | D 级 |
|------|---------|------|------|------|
| LTV/CAC | 5 | 3 | 2 | < 2 |
| CAC Payback (月) | < 12 | < 18 | < 24 | ≥ 24 |
| NRR | ≥ 130% | ≥ 110% | ≥ 100% | < 100% |
| Rule of 40 | ≥ 60 | ≥ 40 | ≥ 30 | < 30 |
| Magic Number | ≥ 1.5 | ≥ 1.0 | ≥ 0.7 | < 0.5 |
| Burn Multiple | < 1.0 | < 1.5 | < 2.5 | ≥ 2.5 |

## 数据获取困难时的代理指标

| 缺失 | 代理 | 来源 |
|------|------|------|
| LTV | Revenue / Customer Count × 平均合同年限 | 招股书或访谈估算 |
| CAC | S&M Expense / New Customers (从年报披露的"新增客户" + S&M 费用栏目推算) | 10-K 季报 |
| NRR | "Top 10 客户营收占比" 变化 + 收入 YoY | 招股书 MD&A |
| Churn | (1 - Renewal Rate) | 公司管理层访谈 |

代理指标必须挂 L3 等级，与一手 NRR/Churn 区别开。
