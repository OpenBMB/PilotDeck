# Refresh Cadence — 数据刷新节奏

行业研究报告的"数据保鲜期"按字段类别差异巨大。同一个 Skill 包要长期可用，必须明确**哪些字段过期了就报废、哪些可以容忍**。

## 三档刷新策略

| 字段 | 推荐刷新频率 | 过期判定 | 触发器 |
|------|-------------|---------|--------|
| **政策 / 监管批件** | 即时 / 周度 | 政策出台 24h 内 | 新法规公告 / 关税变化 / 牌照吊销 |
| **融资 / 估值事件** | 月度 | 30 天 | Crunchbase / 36 氪 新融资公告 |
| **季度财报 / KPI** | 季度 | 95 天（财报日 + 90） | 上市公司财报披露 |
| **年度营收 / 市占率** | 半年度 | 365 天 | 年报 + 行业协会白皮书 |
| **产业链格局 / 玩家清单** | 半年度 | 180 天 | 大型并购 / 新玩家入局 |
| **TAM/SAM/SOM 测算** | 年度 | 365 天 | 假设变量重大变化（如增长率） |
| **History / 行业演进时间线** | 极少更新 | 重大转折点 | 范式切换（如 AlphaGo / ChatGPT） |
| **方法论 / Frameworks** | 一次成型 | 不过期 | 学界新框架（罕见） |
| **🚨 Catalog / SKU / 价格（rapidly-evolving 行业）** | **周度** | **7 天** | **官方 changelog / 模型卡上新 / pricing page diff** |

> ⚠️ **训练截止偏差警告**：MaaS / 大模型 / AI 编程工具 / 向量数据库等 catalog 演进极快的行业，LLM 知识库通常滞后 6-18 个月。Skill 调用方必须主动跑 **Recency Sweep**（见 `recency-guardrail.md`）并直接抓取官方 pricing page，禁止依赖模型记忆里的 SKU 名单与价格。详见 `archetypes/_modifier-rapidly-evolving.md`。

## 4 元组打分规则

每个数据点 (datum) 都带 4 元组：`{value, source, as_of, grade}`。

`as_of` 是判断保鲜的核心字段，写法：`YYYY-MM-DD` 或 `YYYY-Q[1-4]` 或 `YYYY-H[1-2]` 或 `YYYY`（年度）。

**刷新动作矩阵：**

| 距 `as_of` 时长 | 强敏感字段（估值/财报） | 中敏感（市占率/产能） | 低敏感（行业历史） |
|---------------|----------------------|-------------------|------------------|
| ≤ 30 天 | 🟢 Fresh | 🟢 Fresh | 🟢 Fresh |
| 30 - 90 天 | 🟡 Verify | 🟢 Fresh | 🟢 Fresh |
| 90 - 180 天 | 🔴 Refresh | 🟡 Verify | 🟢 Fresh |
| 180 - 365 天 | 🔴 Refresh | 🔴 Refresh | 🟡 Verify |
| > 365 天 | ⚫ Discard | 🔴 Refresh | 🟡 Verify |

**🚨 超敏感字段（Catalog / SKU / 价格）单独刷新矩阵：**

| 距 `as_of` 时长 | 动作 |
|---------------|------|
| ≤ 7 天 | 🟢 Fresh |
| 7 - 14 天 | 🟡 Verify（对每个 SKU 抽 1 个抓取 pricing page 反验） |
| 14 - 30 天 | 🔴 Refresh（全量重抓 pricing page + changelog） |
| > 30 天 | ⚫ Discard（视为陈旧，不得引用） |

**动作含义：**
- 🟢 Fresh — 数据当下可直接复用
- 🟡 Verify — 抽 3-5 个高影响字段做 spot check，OK 即继续用
- 🔴 Refresh — 全量重新抓取该字段，回填 `as_of` 与新 `source`
- ⚫ Discard — 数据已无参考价值，从 SSOT 中删除或标记 `deprecated: true`

## 实操流程

### 0. 每周 Monday: Catalog / SKU / 价格巡检（rapidly-evolving 行业必跑，30 分钟）

适用：MaaS / 大模型 / AI 编程工具 / 向量数据库 / 浏览器自动化框架等"目录式产品"。

```bash
# 巡检脚本（伪代码，实操按厂商目录写 wrapper）
make sku-sweep    # 抓所有 in-scope 厂商 pricing/models pages，diff 比对昨日
```

巡检清单：
- 各家 pricing page 文本 diff（curl + diff），有变动即标 🔴
- 各家 changelog / release notes RSS（如 OpenAI / Anthropic / 百炼 / 火山 / Replicate / FAL）
- 第三方聚合器周报（OpenRouter / ArtificialAnalysis / LMArena 月榜更新）
- 国内官号（微信公众号、知乎专栏）"上新"关键词搜索

输出：`data/sku-changelog-WEEK-NN.md`，标注 New / Changed / Deprecated 三类，回写 `companies.jsonl` 和 `data/skus.jsonl`。详见 `references/recency-guardrail.md` 与 `references/source-recipes/maas-and-models.md`。

### 1. 每周 Monday: 政策/监管巡检（15 分钟）

```bash
make policy-check    # 跑预定义政策源 changelog（如 NMPA / BIS / 央行）
```

输出 changelog 差异，标记可能影响本报告假设的条目。

### 2. 每月首日: 融资事件刷新（30 分钟）

```bash
make funding-refresh
```

跑 Crunchbase / 36 氪 / Bloomberg 关键玩家最新融资 + 估值，更新 companies.jsonl 中的 latest_funding 字段。

### 3. 季报披露后 1 周内: 财报口径校验（2 小时）

按上市公司财报日历，重新跑 unit-economics-calculator，更新 ARR / NRR / 毛利率字段。

```bash
make ue-refresh
```

### 4. 年报披露后 1 月内: 年度大刷新（半天 - 1 天）

- 重新跑 8 步法第 3 轮（三轮搜索）
- 全量重算 TAM/SAM/SOM
- 复查 House View 是否需要调整
- 更新 evolution-timeline 与 racetracks.jsonl

### 5. 重大事件触发: 即时刷新（不限时）

任一以下事件出现 → 立即触发对应章节重写：
- 行业龙头并购 / 上市 / 退市
- 监管定性变化（如 BIS Entity List）
- 重大技术突破或失败（如 NHTSA 召回）
- 经济周期切换（衰退/复苏）

## 元数据约定

在 `data/_meta.json` 维护刷新时间戳：

```json
{
  "last_refresh": "2026-06-24",
  "refresh_history": [
    {"date": "2026-06-24", "scope": "full", "duration_min": 480},
    {"date": "2026-05-01", "scope": "funding", "duration_min": 30}
  ],
  "next_scheduled": "2026-07-01",
  "warnings": ["{datum_path} as_of older than 365d"]
}
```

`scripts/validate.py --strict` 会扫描所有 datum 的 `as_of` 并按上述矩阵报警。

## 已知局限

- 同一字段在不同来源 `as_of` 不一致时，取**最新**且**权威等级 ≥ L2**的版本
- 季度财报的"准则切换"（如新收入准则 ASC 606）会让历史数据不可比，需在 `notes` 字段标注
- 行业研报（沙利文/艾瑞）数据多为厂家送审，需用上市公司 10-K 反向校准
