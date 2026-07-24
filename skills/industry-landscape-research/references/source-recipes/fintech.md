# Fintech / 金融科技 取数菜谱

适用：支付、消费金融、数字银行、财富管理、SaaS for Bank、保险科技、加密资产。

## 子赛道与别名

| 层 | 别名 | 代表玩家 |
|----|------|---------|
| 第三方支付 | Third-party Payment / Acquirer | 支付宝/微信支付/Stripe/Adyen/PayPal |
| 消费金融 | BNPL / Consumer Credit | Affirm/Klarna/Afterpay/蚂蚁花呗/京东白条 |
| 数字银行 | Neobank / Challenger Bank | Revolut/Nubank/SoFi/Monzo/微众/网商 |
| 财富管理 | Wealth Tech / Robo-advisor | Wealthfront/Betterment/Robinhood/雪盈/同花顺 |
| 保险科技 | Insurtech | Lemonade/Root/众安/水滴 |
| SaaS for Bank | Core Banking / RegTech | Mambu/nCino/Temenos/恒生电子/金证 |
| 加密 / Web3 | Crypto / DeFi | Coinbase/Binance/OKX/Circle USDC |

## 权威数据库

**全球：**
- CB Insights State of Fintech — 季度白皮书 + 估值/融资榜
- Statista / Statistic.com — 用户/渗透率（基础数据）
- McKinsey Global Payments Report — 年度（含支付走廊矩阵）
- BIS（国际清算银行）：跨境支付 + CBDC 进展
- World Bank Global Findex — 银行账户普及度（每 3 年）
- IDC FinTech Rankings / Forrester — 厂商榜单

**中国：**
- 中国人民银行：支付体系运行报告（季度）
- 中国支付清算协会
- 易观 Analysys / iResearch 艾瑞 — 第三方支付市场份额
- 网联清算、银联：跨行交易数据

## 监管批件 / 牌照

- **中国央行支付牌照**：第三方支付业务许可证，分预付卡 / 互联网支付 / 银行卡收单
- **小贷牌照 / 消费金融牌照**：银保监会发，杠杆率限制不同
- **证券基金牌照**：基金销售 / 投顾业务资格
- **跨境业务**：外管局 / 港金管局 / MAS / FCA / FINRA 等多地牌照
- **支付服务指令 (PSD2 / Open Banking)**：欧盟开放银行
- **加密合规**：MiCA（欧盟）、纽约 BitLicense、香港 VATP

## 财务披露口径陷阱

| 容易混 | 含义差异 |
|-------|---------|
| **GMV vs TPV vs Revenue** | GMV 商品交易额 / TPV 总支付额（含支付公司自身）/ Revenue 真实收入（费率净额） |
| **Take Rate** | 支付公司：0.3-1%；BNPL：5-8%；交易费率非毛利率 |
| Loan Origination vs Loan Balance | 当期发放 vs 期末余额 vs 平均生息余额，影响利息收入 |
| NPL 不良率 vs M3+ Vintage | 静态时点 vs 同期发放贷款 N 个月后违约率（vintage 更真实） |
| ARPU 月活/年活 | 平台口径混乱，须明确 MAU/DAU/QAU |
| 总规模 (AUM) vs 营收 | 财富管理"AUM 千亿"≠ 高营收，看费率 |
| 加密交易量 | 现货 vs 衍生品 vs 杠杆 vs 永续，不能加总 |

## 上市公司年报关键科目

- **风险拨备**：贷款类业务"贷款减值损失"占新发放比例
- **运营效率**：Cost-to-Income 比率（成熟数字银行 30-50%）
- **资本充足率**：CAR / Tier 1 / LCR，监管硬指标
- **客户结构**：C 端 vs B 端 vs 机构占比
- **跨境结构**：营收按地理拆分 + 监管风险评估
- **加密钱包余额 vs 客户资产**：FTX 教训，须区分公司资产 vs 客户托管

## 一手验证

- **行业会议**：Money 20/20（拉斯维加斯/欧洲/亚洲）、Singapore Fintech Festival、上海外滩金融峰会
- **专家**：商业银行零售总监、信用卡部、支付公司风控总监、券商互联网产品经理
- **App Annie / Sensor Tower**：金融 App 下载/MAU 全球榜
- **链上数据**：Dune Analytics / Glassnode / Nansen（加密 + Stablecoin）

## 红线 / 不可写

- ❌ 不要把 **GMV 当 Revenue**（差几十倍），尤其支付/电商联营
- ❌ 不要混"消费金融"和"小贷"（牌照不同、杠杆/利率上限不同）
- ❌ 不要无视"高利贷红线"（中国 24% / 36%，超部分不受法律保护）
- ❌ 不要把"数字钱包余额"等同于"公司可用资金"（客户资产隔离监管要求）
- ❌ 加密交易所"自我审计"的储备金不可信，须看 Merkle Tree PoR
