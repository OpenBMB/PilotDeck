# Source Recipes — 行业专属取数地图

每个行业有自己一套权威数据源、监管口径、行话和披露惯例。通用的 Crunchbase + 财报抓取拿不到深水区。
本目录给 5 个高频深水行业写"取数菜谱"——告诉你**该去哪、用什么搜索词、怎么避免被错口径骗到**。

## 索引

| 文件 | 行业 | 适用 archetype | 核心难点 |
|------|------|---------------|---------|
| [medical.md](medical.md) | 医疗 / 医药 / 医疗器械 | DeepTech / Platform | 监管批准 vs 真实使用，FDA/NMPA 不同口径 |
| [semiconductor.md](semiconductor.md) | 半导体 / 芯片 / EDA | DeepTech / Infrastructure | 产能 ≠ 出货 ≠ 营收，封测/晶圆/IP 分层 |
| [auto.md](auto.md) | 汽车 / 新能源 / 出行 | DeepTech / Marketplace / Consumer | 交付量 vs 注册量 vs 上险量，OEM/Tier1/Tier2 |
| [fintech.md](fintech.md) | 金融科技 / 支付 / 数字银行 | Platform / SaaS-Vertical | GMV vs TPV vs Revenue，受牌照地理限制 |
| [energy.md](energy.md) | 新能源 / 储能 / 光伏 | Infrastructure / DeepTech | 装机 vs 发电 vs 上网，IRR 受补贴影响极大 |
| [maas-and-models.md](maas-and-models.md) 🆕 | MaaS / 大模型 API / 多模态 | Infrastructure + Rapidly-Evolving 修饰符 | catalog 月度上新，价格陷阱 9 类，必须 live fetch |

## 通用建议

凡是涉及"政策强敏感行业"（医疗、能源、金融、汽车、半导体），**监管原始文件（招股书 / 上市公司年报 / 行业协会白皮书）永远优先于二手新闻**。
中文资料：东方财富 / 同花顺 iFinD / Wind / 钛媒体 / 36 氪 / 第一财经 / 21 世纪经济报道。
英文资料：SEC EDGAR / FT / WSJ / Bloomberg / Reuters / 行业 trade press (eg. EE Times、FierceBiotech)。
监管原文：CFDA/NMPA（中）、FDA（美）、EMA（欧）、CSRC（中证监）、SEC（美证监）、各国央行/银监会。

## 如何加新行业

复制 [_TEMPLATE.md](_TEMPLATE.md)（若无则参考 medical.md），按 6 节填：
1. 行业别名与子赛道
2. 权威数据库（中外各 3+）
3. 监管批件/牌照原文获取路径
4. 财务披露口径陷阱（XX ≠ YY）
5. 上市公司年报关键科目导航
6. 一手验证（专家访谈、调研报告、展会）
