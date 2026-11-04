# 02 — 三轮搜索 SOP

> 三轮是骨架，真实调研经常 5-8 轮。本文件给出每轮的输入、产出、检验门槛和反爬路径。

## R0 — Recency Sweep（rapidly-evolving 修饰符强制）🆕

> **仅当 Charter 命中 `archetypes/_modifier-rapidly-evolving.md` 修饰符时强制执行**。这是为了在三轮搜索之前，先把"训练截止偏差"扎实关掉，避免 R1 广度扫描时漏掉最近 6-12 个月的新玩家、新 SKU、新价格、新 deprecation。

**目标**：用"今天日期"显式锚定时间窗口，逐家厂商抓官方 changelog / pricing page / release notes / 微信公众号"上新"。

**输入**：Charter 第一句的 `Today is YYYY-MM-DD` + in-scope 厂商初步清单 + 第三方聚合器（OpenRouter / ArtificialAnalysis / LMArena / HF / MTEB）。

**6 道闸门**（详见 `references/recency-guardrail.md`）：

1. **Today Date Stamp** — 全程不依赖模型内置日期，所有 SQL/搜索查询带 `as_of >= TODAY - 90d`
2. **Recency Sweep** — `site:{厂商域}/blog after:{TODAY-90d}` + 各厂商 RSS feed
3. **Pricing Page Fresh-Pull** — `curl` / WebFetch 拉取每家 pricing 页 HTML，diff 比 30 天前的 archive.today/Wayback 快照
4. **Changelog Diff** — `site:{厂商域}/changelog` + `site:{厂商域}/release-notes`
5. **第三方聚合器反查** — 让聚合器列出"过去 30/60/90 天新增模型"
6. **Self-Disclosure** — 子 Agent 必须报告自己的训练截止时间，并标注哪些字段可能受影响

**产出**：
- `data/recency-sweep-{date}.md` — 最近 90 天 New / Changed / Deprecated 三类清单
- 初步 SKU 清单（用于 R1 公司清单的种子）
- 训练截止偏差风险地图：哪些字段必须 live fetch、哪些可以走 R1/R2

**门槛**：
- 每家 in-scope 厂商至少 1 个 official 链接（changelog 或 pricing 页）被实际访问且 `as_of` 写回
- 第三方聚合器至少 1 个被查询
- 子 Agent 完成 self-disclosure
- 不达标 → 拒收，禁止进入 R1

---

## R1 — 广度扫描（建立骨架）

**目标**：建立赛道骨架和头部公司清单。

**输入**：Charter 中 Scope + Archetype + Geo/Tier 切分。

**搜索源**（优先级降序）：
1. 头部投研/咨询行业报告摘要：Gartner / IDC / Forrester / 艾瑞 / CB Insights / Pitchbook
2. 行业综述媒体长文：36氪深氪 / 量子位 / 品玩 / Information / TechCrunch / Stratechery
3. 维基百科 + 行业百科类条目（找最早期玩家）
4. 上市公司聚合页：港交所披露易 / SEC EDGAR 行业分类 / 巨潮资讯

**关键词策略**：
- `{行业名} 行业报告 2026`
- `{赛道名} market landscape`
- `{赛道名} 融资盘点`
- `{赛道名} top companies 2026`
- `state of {行业名} report`

**子生态切分（v2 新增）**：建立完清单后立即按"子生态层"打 tag，避免漏掉关键层：
- 平台方 / 工具方 / 制作方 / IP 源 / 出海发行 / 上游基础设施

**产出**：
- 赛道定义和边界确认（补回 Charter Scope）
- 每条赛道头部公司清单 5-8 家（含子生态层 tag）
- 初步估值排行榜草稿（仅头部）
- 历史时间线骨架（仅"行业首个"事件）

**门槛**：每条赛道发现公司数 ≥ 15 家（含 Tier2/Tier3）。不达标 → 追加"新锐 / 黑马 / 黑天鹅"关键词专项搜索。

## R2 — 深度钻取（填充画像）

**目标**：逐公司抓取 `schemas/company.schema.json` 所有字段。

**输入**：R1 公司清单 + Archetype 必填项清单。

**搜索源**（按字段类型选源）：

| 字段 | 首选 | 备用 |
|------|------|------|
| 创始团队 | LinkedIn / 公司官网 About 页 | 36氪人物专访 |
| 产品矩阵 | 官网产品页 / Product Hunt | App Store / 客户案例页 |
| 技术路线 | 技术博客 / GitHub / 论文 | 招聘 JD（看技术栈） |
| 财务数据 | 财报 / 招股书 | Crunchbase 估算 |
| 用户规模 | 公司披露 / 招股书 | QuestMobile / data.ai / Sensor Tower |
| 融资历程 | Crunchbase / IT桔子 | 媒体报道交叉验证 |
| 当前估值/市值 | 见 `references/valuation-playbook.md` | — |
| 竞争关系 | 综合分析 | 财报"竞争对手"章节 |
| 高管背景 | LinkedIn / 学术主页 / 脉脉 | 媒体采访 |
| 客户集中度 | 财报"前五大客户" | 招股书风险章节 |

**关键词策略**（每公司一组）：
- `{公司名} 融资 估值`
- `{公司名} 财报 2025`
- `{公司名} 创始人 背景`
- `{公司名} 客户 案例`
- `{公司名} 技术路线 自研`
- `{股票代码} 市值`（已上市）

**产出**：
- 每家公司的 `companies.jsonl` 完整记录
- 估值数据标注 L1-L4
- 数据覆盖缺口清单（哪些字段仍是空白或 L3/L4）

**门槛**：企业画像字段覆盖率 ≥ 80%。

## R3 — 验证补盲（交叉确认）

**目标**：补搜缺口数据、交叉验证、发现遗漏新锐公司。

**输入**：R2 缺口清单 + 整体覆盖率统计。

**三类任务并行**：

### 3a. 缺口字段补搜
针对 L3/L4 数据或缺失字段做定向搜索：
- 单字段 × 单公司 = 1 个 micro-task
- 子 Agent 模板 `templates/subagent-cross-validate.md`

### 3b. 交叉验证（每个 L1/L2 数据至少 2 个独立来源）
- 两个来源不能是转载关系（A 引用 B 不算独立）
- 冲突数据取保守值或标注分歧范围

### 3c. 新锐公司专项发现
- 关键词：`{赛道名} 新锐 融资 2026`、`{赛道名} 黑马`、`{赛道名} unicorn 2026`
- 重点查：最近 12 个月融资爆发的公司、近 6 个月发布产品的新公司
- 工具：Crunchbase 按时间倒序、Product Hunt 月度 Top、GitHub Trending（开源类）

**产出**：
- 数据覆盖率统计（有值字段 / 总字段）
- 交叉验证结果记录
- 补充发现的新锐公司

**门槛**：L1+L2 级数据占比 ≥ 60%。

## R4-R8 — 迭代补强（视需要触发）

| 轮次 | 重点 | 触发条件 | 关键动作 |
|------|------|---------|---------|
| R4 缺口补搜 | 字段覆盖率 < 80% | R3 统计 | 派 Agent 定向搜单字段 |
| R5 反向验证 | 数据"太好"或与常识矛盾 | 人工 review | 找证伪证据，搜 `{公司名} 质疑 / 风险 / 争议` |
| R6 时序追溯 | 演进图缺早期里程碑 | Step 7 时发现 | 搜 `{公司名} 成立 / 创立`、Wayback Machine |
| R7 边缘扫尾 | 主流来源已穷尽 | 仍有缺口 | 知乎 / Reddit / V2EX / 脉脉 / 小道消息 |
| R8 客户视角 | 需要判断产品真实竞争力 | Thesis 阶段 | G2 / Capterra / Trustpilot / App Store 评论 |

**收敛信号**：连续两轮新增信息 < 5% → 停止迭代。

## 海内外双轨原则

全球化行业必须分中国 / 海外两个排行榜，禁止混排。原因：
- 商业模式不同（订阅 vs 广告 vs 交易）
- 监管环境不同（GDPR vs 网信办 vs 出海合规）
- 客户决策链不同（CIO 集中采购 vs 业务部门分散采购）
- 估值口径不同（PE/PS 估值倍数差 2-3x）

## 子生态分层（来自 AIGC review 沉淀）

内容/媒体型行业必须切子生态：

```
{行业}
├── 平台方（分发与流量）
├── 制作方（内容生产）
├── 工具方（生产工具/AI）
├── IP 源（内容授权）
├── 出海发行（海外渠道）
└── 上游基础设施（云/算力/CDN）
```

每个子生态层至少覆盖 TOP 3 玩家，否则 Coverage Audit 该维度判 ⭐⭐ 以下。

## 反爬绕路（入口）

详见 `references/crawl-strategy.md` 和 `references/source-matrix.md`。

通用规则：
1. 先试 WebFetch / curl，拿到空数据再切浏览器 MCP
2. JS 动态字段（如 `@now@`、`@fixTotalShare@`）→ 用"总股本×近端价格"绕路
3. 付费墙优先找公开摘要 / 二手引用
4. 高频反爬站点用慢速节流（每 20 条 pause 1s）
