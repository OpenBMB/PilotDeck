# Archetype: Marketplace

> 适用：纯交易撮合的平台。例：淘宝、Airbnb、Uber、Etsy、Fiverr。与 Platform 重叠但更聚焦交易撮合。

## 核心特征

- 撮合买卖双方完成交易
- 平台不持有库存（多数情况）
- GMV 是核心北极星指标
- Liquidity 决定生死

## 必填分析项

| # | 维度 | 数据要求 |
|---|------|---------|
| 1 | GMV + 增速 | 总交易额 + YoY |
| 2 | Take Rate | 平台收入 / GMV |
| 3 | 买家数 / 卖家数 / 比例 | 两侧规模 |
| 4 | 单笔均价 | GMV / 订单数 |
| 5 | 复购率 | L+12 月复购 |
| 6 | 两侧拉新成本 | CAC（买家） + CAC（卖家） |
| 7 | Liquidity 指标 | 平均匹配时间 / 搜索 zero-result 率 |
| 8 | 头部集中度 | Top 1% 商家 GMV 占比 |
| 9 | 跨边费用 | 谁付费？多少？ |
| 10 | 反 disintermediation 措施 | 防止双方绕过平台 |

## 关键问题

1. GMV 是真实交易还是被刷量？
2. 两侧 liquidity 是否实现？
3. Take rate 还能涨吗？涨了商家会不会逃？
4. 复购率结构：买家 vs 卖家分别如何？
5. 头部商家是不是已经在搞独立站？

## 行业经验法则

| 指标 | 健康值 | 红线 |
|------|--------|------|
| Take Rate | 10-25% | < 5% (无利) 或 > 30% (商家逃) |
| 月活买家 / 月活卖家 | > 50（高频品类）或 > 10（低频） | < 5 |
| 头部 1% 商家 GMV 占比 | < 30% | > 50% |
| Disintermediation 率 | < 10% | > 30% |
| 现金转化（GMV→Revenue→Net Income） | Revenue/GMV: 10-25%；Net/Revenue: 5-20% | — |

## 常见 Thesis Template

> "{Marketplace} 已在 {场景} 实现 liquidity，take rate 仍有上升空间。
> 主要风险：{大型卖家独立 / 监管反垄断 / 物流断裂 / 跨平台比价}。"

## 知名案例

- 强 marketplace：Taobao、Amazon Marketplace、Etsy、Airbnb
- 服务型：Uber、Fiverr、TaskRabbit
- 失败：Quibi、各种 P2P 借贷（合规问题）

## 反模式

- ❌ 只看 GMV 不看 take rate → 可能是补贴跑量
- ❌ 不看 disintermediation → 服务类 marketplace 常死于此
- ❌ 把 1P 当作 marketplace → 京东自营和淘宝不是一回事
