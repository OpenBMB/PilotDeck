# 07 — 交付物组装（Deliverable Assembly）

> 来自 AIGC review 沉淀的 6+2 章节标准报告结构，加上 v2 新增分析层产物。

## 标准章节结构（6+2）

| # | 章节 | 内容 | 张数 | 数据源 |
|---|------|------|------|--------|
| 1 | 行业全景 | 矩阵：行=赛道 / 列=地理 / 卡片大小=Tier | 1 | `companies.jsonl` |
| 2 | 演进趋势 | 时间线 + 阶段主题 + S-curve 定位 | 1-2 | `events.jsonl` + Step 5 |
| 3 | 客户旅程 | 价值链 N 环节 × (现状/AI 介入/工具/方案) | 1-2 | `references/value-chain-journey.md` |
| 4 | 企业深度卡 | 每家头部 1 页 | 10-15 | `companies.jsonl` |
| 5 | 解决方案矩阵 | 自家产品 × 场景映射 | 1-2 | 自定义 |
| 6 | 重点发力场景 | TOP 3-5 高优先级场景 | 1-2 | Thesis 输出 |
| +1 | M&A / IPO 动态 | 并购、上市、退出 | 1 | `events.jsonl` 过滤 |
| +2 | 成本/利润池对比 | 价值链 margin 分布 + 横向对比 | 1 | `references/profit-pool.md` |

## v2 新增章节

在标准 6+2 基础上新增（按需启用）：

| # | 章节 | 触发条件 |
|---|------|---------|
| +3 | 技术栈分层图 | 技术驱动型行业必出 |
| +4 | 利益相关方立场图 | 强监管/版权敏感行业必出 |
| +5 | 分析框架画布 | Step 5 输出汇总 |
| +6 | Thesis 一页纸 + 三情景 + Pre-mortem | 投资/战略决策类必出 |

## 完整交付物清单

| # | 物料 | 格式 | 来源 |
|---|------|------|------|
| 1 | Research Charter | MD / 1 页 PPT | Step 1 |
| 2 | 行业全景图 | 1 页 PPT/HTML | Step 2 + Step 3 |
| 3 | 演进时间线 | 1 页 PPT/HTML | `events.jsonl` |
| 4 | 估值排行榜（国内/海外分轨） | 1-2 页 PPT | `companies.jsonl` |
| 5 | 企业深度卡 | 10-15 页 PPT | `companies.jsonl` |
| 6 | 技术栈分层图 | 1 页 PPT | `references/stack-map.md` |
| 7 | 客户旅程图 | 1-2 页 PPT | `references/value-chain-journey.md` |
| 8 | 利润池图 | 1 页 PPT | `references/profit-pool.md` |
| 9 | 利益相关方立场图 | 1 页 PPT | `references/stakeholder-stance.md` |
| 10 | 分析框架画布 | 1 页 PPT | Step 5 |
| 11 | 三情景预测 | 1-3 页 PPT | Step 7 |
| 12 | Pre-mortem 报告 | 1 页 PPT | Step 7 |
| 13 | 数据底表 | Excel/CSV | `companies.jsonl` flatten |
| 14 | 方法论附录 | MD | Charter + 汇率快照 + 局限性 |
| 15 | 调研日志 | MD | 每轮搜索关键词 + 覆盖率 |

## 视觉规范

### 配色（推荐三选一）

| 风格 | 主色 | 辅色 | 适用 |
|------|------|------|------|
| Cobalt Brief | #1E2BFA + #FDFAE7 | 黑/灰 | 投资人/CEO 向 |
| Editorial 暗色 | #0A0A0A + #E5E5E5 | 红/橙重点 | 深度研究/媒体向 |
| 阿里云亮色 | #1166FE + #FFFFFF | 灰阶 | 内部汇报 |

### 字号

| 元素 | 字号 |
|------|------|
| 一级标题 | 32-40pt |
| 二级标题 | 20-24pt |
| 正文 | 14-16pt |
| 数据标注 | 10-12pt |

### 图表规范

- 卡片高度统一（同章节内）
- 颜色按赛道编码（每条赛道独立色系）
- 数据点必须标注来源（脚注或角标）
- 估值数字必须标截止日期

## 从数据底表派生（强制）

所有交付物的数字都从 `data/` 三件套派生，禁止在 PPT 里硬编码数字。

```bash
# 派生流程示例
python derive.py --source data/companies.jsonl --output deliverables/ranking.json
python build_pptx.py --input deliverables/ranking.json --template templates/ranking.pptx
```

数据改 → 重新派生 → 重新生成 PPT。禁止"PPT 改一下数字"。

## 多轮迭代节奏

| 轮次 | 重点 | Done 标准 |
|------|------|---------|
| 第 1 轮 | 内容完整性 | 所有章节有初稿 + 数据来源链接 |
| 第 2 轮 | 数据准确性 | 关键数字交叉验证 + 反方论证补强 |
| 第 3 轮 | 视觉呈现 | 配色、图表、排版定稿 |

## 反模式

- ❌ PPT 上数字找不到在 `data/` 中的源头 → 拒收
- ❌ 全景图把中国/海外混排 → 拒收（必须分轨）
- ❌ 排行榜不标截止日期 → 半年后没法复用
- ❌ 深度卡只有"产品好/团队强"等定性描述 → 缺数据
- ❌ M&A 章节只罗列事件，不提炼趋势 → 浪费一页
- ❌ 利润池图只画环节大小，不标 margin → 失去核心信息
