# Subagent Prompt: Company Deep Dive (R2)

> 用于 Step 3 第二轮：深度钻取。下放给并行子代理（每个 Agent 负责 2-3 家公司）。

## 任务输入

```
公司列表: [
  {canonical_name, aliases, ticker, racetrack_id, archetype},
  ...
]
赛道画像: {racetrack.jsonl 中本赛道的完整记录}
截止日期: {AS_OF_DATE}
基准汇率: {USD/CNY, HKD/CNY, EUR/CNY}（来自 snapshots/fx-rates.csv）
```

## 你的目标

对每家公司做**深度画像**：把 `schemas/company.schema.json` 的所有字段填到 80% 以上覆盖率。**每个非常识数据点必须有 4 元组**：数值 + 来源 URL + 截止日期 + 数据等级。

## 你需要抓什么

按 `company.schema.json` 完整字段集（每家公司一条记录），重点字段：

### 团队
- founders 数组（姓名 + 履历 + LinkedIn URL，至少 2 位核心人物）
- 关键高管最近 12 月变动

### 产品
- product_lines（核心产品 + 类别 + 上线日期 + URL）
- tech_route（自研 / 开源 fork / 第三方 API / 混合）

### 财务（必须）
- revenue_usd_mn（最近一个完整财年）
- gross_margin / net_margin（如披露）
- rd_ratio（研发占比）
- fiscal_year

### 用户（必须）
- mau / dau / paid
- 注意区分注册数 vs 活跃 vs 付费（按 `references/dirty-work-playbook.md` §7.2）

### 融资（必须）
- 全部融资轮次（轮次 + 日期 + 金额 + 估值 + 领投）
- 来源：Crunchbase / IT桔子 / 36氪 / 公司公告

### 估值（必须，4 元组完整）
- latest_usd_mn + as_of_date + grade + method + source_url
- 上市公司：见 `references/valuation-playbook.md`，港股 5 位补零，必要时总股本 × 近端价格
- 未上市：最近一轮估值 / 媒体报道 / 对标推算（如对标必填 derivation_formula）
- 双值（IPO 首日 + 当前）：用户明确要求时同时给出，含峰值

### 竞争位置
- tier（根据 racetrack.tier_thresholds 归档）
- market_share_pct（如能查到）
- differentiation（一句话）
- main_competitors（3-5 家）

### 立场信号
- regulatory_risk（low / medium / high）
- ip_disputes（已知诉讼/纠纷）
- public_sentiment

### BD 评估（可选，按调研目的）
- priority（P0/P1/P2/P3）
- entry_point（BD 切入点）

## 来源策略

按 `references/source-matrix.md` 优先级：
1. **L1**：公司财报 / 招股书 / 交易所披露 / 公司官方公告
2. **L2**：The Information / Bloomberg / FT / 36氪深氪 / 量子位深度报道
3. **L3**：行业媒体综述 / 公司 PR
4. **L4**：匿名信源、自媒体 → 必须标注 `(传)`，至少有 L1/L2 旁证才采用

**交叉验证**：每个 L1/L2 数据点需至少 2 个独立来源（不同域名，非转载关系）。

## 反爬路径

| 场景 | 路径 |
|------|------|
| 港股市值 | 新浪 `hk{5位}/nc.shtml` → 取 `@fixTotalShare@` × 近端价格 |
| A股市值 | 新浪 `{sz\|sh}{6位}.html` → 同上 |
| 美股市值 | Google Finance / Yahoo Finance |
| 未上市估值 | Crunchbase 浏览器 MCP → 36氪 / IT桔子 兜底 |
| 财报 | 公司 IR 页直链 → 港交所披露易 → SEC EDGAR → 巨潮资讯 |
| 招股书 PDF | Read 工具直接读 |
| 创始人履历 | LinkedIn 浏览器 MCP → 公司官网团队页 → 媒体采访 |

## 输出格式

```jsonl
// companies.jsonl（追加 / 更新已有记录）
{
  "canonical_name": "...",
  "racetrack_id": "...",
  "archetype": "...",
  "founders": [...],
  "product_lines": [...],
  "financials": {...},
  "users": {...},
  "funding_history": [...],
  "valuation": {
    "latest_usd_mn": 150,
    "as_of_date": "2026-06-20",
    "grade": "L2",
    "method": "latest-round",
    "source_url": "https://..."
  },
  ...
  "sources": [
    {"url":"...", "publisher":"...", "publisher_tier":"L2-authoritative-media", "fetched_date":"2026-06-24", "grade":"L2", "quote":"...", "cross_validated_by":["https://..."]}
  ]
}
```

加一份 `r2-{company}-log.md`：
- 字段覆盖率清单（哪些字段填了、哪些空着、为什么空）
- 异常检测结果（按 `dirty-work-playbook.md` §7.2 触发了哪些规则）
- 待 R3 验证的数据点清单

## 质量门槛

- 字段覆盖率 ≥ 80%（关键字段：valuation / financials / users / funding 必填或显式标"未披露"）
- L1+L2 数据占比 ≥ 60%
- 每个 L1/L2 数据点 ≥ 2 个独立来源
- 估值字段不能 L4（如只有匿名传闻 → 标"数据不足"而非编造）

## 禁止事项

- ❌ 把毛利率当净利率
- ❌ 用过期数据外推不标"~"或"derived"
- ❌ 跨期数据混用（不同财年的 ARR 直接比较）
- ❌ 公司名/产品名不归一（先查 `snapshots/aliases.csv`）
- ❌ 汇率不用快照（每个 Agent 必须用同一组汇率）

## 一句话总结

逐公司穷尽，4 元组留痕，标空不编造，等待 R3 验证。
