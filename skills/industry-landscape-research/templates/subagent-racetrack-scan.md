# Subagent Prompt: Racetrack Broad Scan (R1)

> 用于 Step 3 第一轮：广度扫描。下放给并行子代理（按赛道切片）。

## 任务输入

```
赛道名: {RACETRACK_NAME}
赛道定义: {RACETRACK_DEFINITION}
排除范围: {OUT_OF_SCOPE}
地理范围: {GEOS}（如 global / china / us-canada）
时间窗口: 截止 {AS_OF_DATE}
```

## 你的目标

对该赛道做**广度扫描**：建立赛道骨架与头部公司清单。输出一份赛道画像 + 至少 15 家公司的初步清单。

## 你需要抓什么（字段锁定）

### Part A: 赛道画像
按 `schemas/racetrack.schema.json` 输出 1 条记录，必须包含：
- `id`（slug 化）、`name`、`definition`、`out_of_scope`
- `archetype`（从 platform / saas-vertical / deeptech-hardware / marketplace / consumer / infrastructure / content-media 中选）
- `tam_usd_bn`（估算 + 来源）
- `cagr_pct`、`lifecycle_stage`
- `geographies`（每个地理区域市占）
- `structural_drivers`（3-5 个）
- `key_metrics`（archetype 相关 KPI）
- `tier_thresholds`（估值分档阈值）

### Part B: 公司清单（≥ 15 家）
每家公司输出 `schemas/company.schema.json` 的**最小集**：
- `canonical_name`、`aliases`、`ticker`（若上市）
- `country`、`headquarters`、`founded_year`、`status`
- `archetype`
- `product_lines`（核心产品 1-3 个）
- `valuation`（最新估值 + 等级 + 来源）
- `competitive_position.tier`（按 valuation 自动归档）
- `sources`（至少 2 个独立来源）

**完整画像**（含 founders / financials / users / funding_history / bd_assessment）由 R2 深度钻取负责，**本轮不需要**。

## 来源策略

**优先来源（L1-L2）**：
- 行业报告摘要：Gartner / Forrester / IDC / CB Insights / a16z 公开摘要
- 媒体综述：The Information / 36氪 / 量子位 / 品玩 / TechCrunch 综述类文章
- 投研报告：Bessemer / OpenView / 国内券商行业首份报告

**搜索关键词模板**：
- `{赛道名} 行业报告 {YEAR}`
- `{赛道名} market landscape {YEAR}`
- `{赛道名} top companies leaderboard`
- `{赛道名} 融资盘点 {YEAR}`
- `{赛道名} unicorns valuation`

**地理切分**：
- 中国：36氪 / 品玩 / IT桔子 / 投中网
- 全球：The Information / TechCrunch / Tech in Asia (东南亚)
- 美国：a16z / Bessemer / Lightspeed 公开博文

## 反爬策略

按 `references/crawl-strategy.md`：
1. 优先 WebFetch；JS 反爬强（雪球/东方财富/Crunchbase）切浏览器 MCP
2. 港股估值：5位补零，新浪 `hk{5位}/nc.shtml`
3. 单条请求失败 → 重试 1 次 → 切换备用站点
4. 同站点限速：每分钟 ≤ 10 次

## 输出格式

```jsonl
// racetrack.jsonl（1 条）
{"id":"...", "name":"...", "definition":"...", ...}

// companies.jsonl（≥ 15 条）
{"canonical_name":"...", "racetrack_id":"...", ...}
{"canonical_name":"...", "racetrack_id":"...", ...}
```

加一份 `r1-log.md`：
- 关键词清单（实际用过的）
- 来源 URL 清单（去重后）
- 字段覆盖率统计
- 已识别但信息不足的公司清单（留给 R2）

## 质量门槛

- 赛道画像字段覆盖率 ≥ 80%
- 公司清单 ≥ 15 家
- 每家公司至少 2 个独立来源（不同域名）
- 估值字段至少 L2 等级
- **不达门槛 → 明确标注"数据不足"，不要编造**

## 禁止事项

- ❌ 编造未查到的数据
- ❌ 来源写"网络"或"业内"
- ❌ 二手引用不追原始来源
- ❌ 把推算值写成确定值（推算值必须 `derived: true` + 公式）
- ❌ 越界做 R2/R3 的深度抓取（保持本轮范围）

## 一句话总结

广撒网，建骨架，标缺口，等待 R2 钻取。**宁可标"未查"也不要编。**
