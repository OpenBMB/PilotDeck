# Example: AIGC 图像生成赛道调研（端到端样例）

> 此样例展示**如何运用八步法 + 多文件资产**完成一次行业调研。数据为示意目的，**真实调研时必须重新核实**。

## 0. 总览

- **行业**：AIGC（生成式 AI）
- **赛道切片**：本次只做"图像生成"（image-generation）
- **基准日**：2026-06-20
- **调研目的**：内部 BD 团队识别 TOP 标的与切入点
- **承接 Skill 版本**：industry-landscape-research v2.0.0

## 1. Step 1 — Charter（来自 `workflows/01-research-charter.md`）

```markdown
研究范围: 全球 AIGC 图像生成赛道
包含: 文生图、图生图、图生视频前端、专业图像生成工具
排除: 通用 LLM、视频生成主线、3D 模型生成、音频生成
受众: 阿里云 AIGC 行业 BD（内部汇报）
目标客户: 时代出版、创客贴、开为科技、蓝色光标、万兴科技、即梦/字节
关键假设:
  - H1: 应用层（C 端工具）将出现 ≥ 3 家估值 > $5B 的独立赢家
  - H2: 中国市场份额会从 2024 年 ~15% 升至 2026 年 ~25%
  - H3: 闭源模型（OpenAI/Stability）API 收入 2026 年同比下降
成功标准:
  - 覆盖 ≥ 25 家公司，TOP 10 估值 ≥ L2 数据
  - 包含中美/海外双视图
  - 输出 BD 优先级 P0-P3 标签
止损线: R3 结束后 L1+L2 < 50% → 暂停并升级
赛道 Archetype: content-media（次要：consumer）
地理分层: 全球 / 中国 / 美国 / 东南亚 / 欧洲
汇率快照（2026-06-20）: USD/CNY=7.18, HKD/CNY=0.92, EUR/CNY=7.74
签字: 调研负责人 / BD 负责人 / 日期
```

## 2. Step 2 — Decompose

把"图像生成"赛道再拆 4 个子赛道：

| 子赛道 ID | 名称 | 范围 |
|----------|------|------|
| image-pro | 专业生图工具 | Midjourney / 即梦 / Adobe Firefly / Imagen |
| image-saas | 设计 SaaS 整合 | Canva / 创客贴 / 万兴 / 稿定 |
| image-api | API 服务 | OpenAI Images / Stability API / 通义万相 API |
| image-vertical | 垂直应用 | 电商图（FancyTech）、营销图（蓝色光标）、AI 写真 |

每个子赛道独立 R1。

## 3. Step 3 — 三轮搜索（节选）

### R1 广度（按子赛道并行 4 个 Agent）
- Agent A (image-pro)：发现 18 家公司，含 Midjourney、即梦、Adobe Firefly、Imagen、SD、Leonardo、Recraft、Ideogram 等
- Agent B (image-saas)：发现 15 家，Canva、创客贴、稿定、万兴喵影（图像部分）、Figma AI、Adobe Express
- Agent C (image-api)：发现 12 家，OpenAI Images、Stability、通义万相、Replicate、Runway API
- Agent D (image-vertical)：发现 14 家含 FancyTech、蓝色光标 BlueAI、Photoroom（电商）、Loomly（营销）

**R1 汇总**：59 家公司，去重后 51 家进 R2。

### R2 深度（按公司并行 10 个 Agent，每个负责 5 家）
- 每家公司按 `subagent-company-deepdive.md` 抓 80%+ 字段
- 共耗时 ~3 小时（并行）
- 产出 51 条 `companies.jsonl`

### R3 验证补盲
- 字段覆盖率：85%
- L1+L2 占比：68%
- 交叉验证率：72%
- 异常项修正：3 处（包括"Midjourney 估值 $25B"传闻被降级为 L4 标注"未证实"）
- 新发现公司：2 家（Krea / Tengr.ai）

## 4. Step 4 — Coverage Audit

| 维度 | ⭐ 评分 | 缺口等级 |
|------|--------|---------|
| 头部玩家覆盖 | ⭐⭐⭐⭐⭐ | 🟢 |
| 长尾/腰部覆盖 | ⭐⭐⭐⭐ | 🟢 |
| 中国市场 | ⭐⭐⭐⭐⭐ | 🟢 |
| 海外市场 | ⭐⭐⭐⭐ | 🟢 |
| 财务数据 | ⭐⭐⭐ | 🟡 |
| 用户规模 | ⭐⭐⭐ | 🟡 (未上市公司多用 PR 数字) |
| 监管/版权立场 | ⭐⭐⭐⭐ | 🟢 |
| 技术路线 | ⭐⭐⭐⭐ | 🟢 |

无 🔴，可进 Step 5。

## 5. Step 5 — Analysis Frameworks

### Porter 5 Forces (image-pro 子赛道)
- 新进入威胁：高（开源 SD 降低门槛）
- 替代品威胁：中（视频生成会蚕食部分需求）
- 供应商议价：高（NVIDIA + 云算力）
- 客户议价：中（消费者迁移成本低）
- 行业内竞争：极高（红海）

### 7 Powers (Midjourney 评分，0-5)
- Scale Economies: 2（消费应用规模效应一般）
- Network Effects: 3（社区/Discord 双边网络）
- Counter-Positioning: 4（订阅制 + 不做免费层 vs OpenAI）
- Switching Costs: 1（用户切换成本低）
- Branding: 4（品牌强）
- Cornered Resource: 2（无独占数据）
- Process Power: 3（迭代速度快）

### Wardley Map（节选）
- 算力 → Commodity 区
- 基础模型 → Product 区（向 Commodity 移动）
- 风格化模型 → Custom Built / Product 边界
- 应用层 → Genesis / Custom Built 区

### JTBD
"用户雇用 Midjourney 来：在 60 秒内得到一张高于自己设计能力的图，以便在社交/工作中展示创意。"

### S-curve 位置
2024 → "Scaling"阶段；2025-2026 → 进入"Shaking-out"早期。

## 6. Step 6 — Quant Modeling

### Unit Economics（节选，content-media archetype）
| 指标 | Midjourney | 即梦 | Canva | 行业基准 |
|------|-----------|------|-------|---------|
| 付费用户 (mn) | 2 (估) | 未披露 | 21 | - |
| ARPU ($/年) | 100 | 未披露 | 100+ | 50-150 |
| 毛利率 | ~80% (估) | 未披露 | 70-80% | 70%+ |
| 月增速 | 8% (估) | 未披露 | 5% | ≥5% 健康 |

### TAM (三方法)
- Top-down: 全球 AIGC 市场 ~$50B × 图像份额 30% = $15B
- Bottom-up: 全球设计/创意工作者 50mn × ARPU $120 × 渗透率 30% = $1.8B (狭义)
- Comparable: 对标 Adobe Creative Cloud（$200亿/年）的图像生成增量份额 5-15% = $10-30B

**取保守中位数：$12-15B**（2026 口径）

### Profit Pool（节选）
| 段 | 营收 $B | 净利率 | 净利润 $B |
|----|---------|--------|----------|
| L1 GPU (NVIDIA 份额) | ~80 | 55% | ~44 |
| L2 模型 (OpenAI Images / SD) | ~3 | -50% | -1.5 |
| L3 平台 (Replicate 等) | ~0.5 | 5% | 0.025 |
| L4 应用 (Midjourney 等) | ~1.5 | 30% | 0.45 |
| L5 SaaS 集成 (Canva 图像部分) | ~2 | 25% | 0.5 |

**洞察**：图像生成赛道 95% 利润在 L1 算力；应用层利润快速上升但仍小。

## 7. Step 7 — Thesis Synthesis

### House View（H/M/L 信心）
1. (H) Midjourney 仍是消费图像生成头部，但 ARR 增速会从 100%+ 降至 50% 区间，2025 Q4 估值约 $10B
2. (M) 中国市场 2026 末出现 1-2 家估值 $3B+ 独立赢家（即梦最可能）
3. (L) 闭源 API 收入下降假设需要观察 OpenAI/Stability 2025 财报后再校准
4. (H) 利润仍主要落 L1，应用层 SaaS 嵌入比独立工具更易盈利

### 三情景预测
- 乐观 (30%)：开源模型质量持平闭源，应用层百花齐放，TAM 2027 达 $25B
- 基准 (50%)：头部 3-5 家集中度提升，应用层洗牌，TAM 2027 达 $18B
- 悲观 (20%)：视频生成快速替代图像需求，TAM 2027 仅 $12B

### Pre-mortem 早期预警
- 警钟 1：NVIDIA 降价超 30% → 利润池迁移加速
- 警钟 2：Adobe Firefly 价格战 → 独立应用挤压
- 警钟 3：版权诉讼出现 $1B+ 判决 → 海外应用合规成本暴涨

### Devil's Advocate 反方报告关键发现
- 数据质疑：Midjourney "200 万付费用户"为 PR 口径（L3），未交叉验证 → 降级为"约 100-300 万区间"
- 偏差：报告过度引用近 6 月事件（可得性偏误）→ 加入 2022-2024 历史趋势校准
- 反向假设：苹果/谷歌操作系统级集成 → 第三方应用消失（概率 15%）

## 8. Step 8 — Deliverable Assembly（15 项产出）

```
outputs/aigc-image-research/
├── 01-executive-summary.md
├── 02-landscape-overview.pptx (单页全景)
├── 03-timeline.pptx (2020-2026 演进)
├── 04-valuation-leaderboard.pptx (TOP 15)
├── 05-company-cards/ (12 张深度卡 PPTX)
├── 06-stack-map.pptx (5 层全景)
├── 07-value-chain-journey.pptx (创作者旅程)
├── 08-profit-pool.pptx (含趋势)
├── 09-stakeholder-stance.pptx (立场矩阵)
├── 10-porter-five-canvas.pptx
├── 11-seven-powers-canvas.pptx (Midjourney 个案)
├── 12-tam-sam-som.pptx
├── 13-unit-economics.xlsx
├── 14-scenario-forecast.pptx (三情景)
├── 15-house-view.md (核心结论)
├── methodology-appendix.md
├── research-log.md (R1-R3 日志)
├── snapshots/ (aliases / fx-rates / time-anchors)
├── data/
│   ├── companies.jsonl (51 条)
│   ├── racetracks.jsonl (4 子赛道)
│   ├── events.jsonl (43 事件)
│   ├── sources.csv (218 来源去重后)
│   └── deliverable.json (manifest)
└── devil-advocate-report.md
```

## 9. 调研回顾 (Retrospective)

**做得好的地方**：
- 4 子赛道并行 R1 节省 ~60% 时间
- Coverage Audit 在 Step 4 提前发现财务数据缺口
- Devil's Advocate 真的发现了 Midjourney 数字的 L3 等级问题

**做得不好的地方**：
- R2 阶段汇率切换过一次（中途用了 7.20 vs 调研开始的 7.18）→ 修正成本 ~30 分钟
- 漏掉日本一家公司（HuLab）直到 R3
- Bottom-up TAM 估算因渗透率假设主观，与 Top-down 差 8x → 取了保守值但未来需建立更稳的基础

**沉淀到 Skill 的改进**：
- 在 `dirty-work-playbook.md` §4.1 强化"汇率快照全程不可变"
- 在 `subagent-racetrack-scan.md` 加入"日韩/东南亚专项扫描清单"
- 在 `subagent-quant-model.md` 加入"TAM 三法差异 > 30% 触发详细写明分歧"规则

---

> 此样例只是骨架与流程演示。真实调研产出每个 PPTX/XLSX/JSON 必须**严格按 schemas/ 校验**、按 references/ 规则核实。
