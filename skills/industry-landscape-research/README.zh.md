# Industry Landscape Research — Agent Skill v2.2（中文）

> 一套将 LLM Agent 转化为系统化行业分析师的结构化方法论  
> 102 个文件 · 85 个源资产 · 8 步框架 · 7 种基础原型 + 1 个修饰器 · 6 个 JSON Schema · 12 个可视化模板 · 5 个领域专用数据源配方

---

## 这是什么？

这是一个 **Agent Skill** —— 一个可移植的知识包，专为加载到 LLM Agent（Claude、GPT、Qwen 等）中而设计，赋予其可重复、可审计、专业级的行业研究能力。

与其每次让 AI 做市场调研时写一篇 50 页的 prompt，不如直接加载这个 skill，它就知道：

- 如何结构化研究（8 步框架）
- 根据行业类型该关注什么（7 种原型）
- 如何验证数据质量（L1-L4 分级 + JSON Schema）
- 如何避免常见陷阱（7 种认知偏差，包括 LLM 训练截止偏差）
- 如何产出一致的交付物（12 个可视化模板，编辑级暗色主题）

---

## 它解决的问题

当你让一个 LLM「调研 MaaS 行业」时，通常会得到：

- 重新包装 Wikipedia 的表面总结
- 过时的模型名称和价格（训练截止偏差）
- 没有数据来源引用或质量分级
- 对「完整」是什么没有框架定义
- 每次输出格式不一致

这个 skill 将其转化为：

- 结构化的 8 步研究，带有显式的覆盖度审计
- 每个数据点携带四元组：`{value, source, as_of_date, grade}`
- 阻塞性关卡，防止 Agent 在数据不完整时继续推进
- 时效性护栏，强制对快速变化的行业进行实时抓取
- 可复现的交付物模板

---

## 架构

```
industry-landscape-research/
├── SKILL.md              # 主入口 — 框架 + 原型选择器 + 快速上手
├── INDEX.md              # 单页文件索引（地图）
├── archetypes/           # 7 种基础行业原型 + 1 个修饰器
│   ├── platform.md       #   双边平台
│   ├── saas-vertical.md  #   垂直 SaaS
│   ├── marketplace.md    #   电商平台
│   ├── consumer.md       #   消费者应用
│   ├── deeptech-hardware.md  # 深科技 / 硬件
│   ├── infrastructure.md #   云 / 基础设施
│   ├── content-media.md  #   内容 / 媒体
│   └── _modifier-rapidly-evolving.md  # ⚡ 快速演变产品目录的叠加层
├── workflows/            # 逐步 SOP
│   ├── 00-execution-plan.md
│   ├── 01-research-charter.md
│   ├── 02-three-round-search.md   # 含 R0 时效性扫描关卡
│   ├── 03-analysis-frameworks.md
│   ├── 04-coverage-audit.md
│   ├── 05-quant-modeling.md
│   ├── 06-thesis-synthesis.md
│   └── 07-deliverable-assembly.md
├── schemas/              # JSON Schema 数据验证
│   ├── company.schema.json
│   ├── event.schema.json
│   ├── racetrack.schema.json
│   ├── sku.schema.json          # v2.2：SKU 级数据
│   ├── source.schema.json
│   └── deliverable.schema.json
├── references/           # 深度参考库
│   ├── bias-checklist.md        # 7 种认知偏差（含训练截止偏差）
│   ├── recency-guardrail.md     # 6 道防止过期数据的护栏
│   ├── refresh-cadence.md       # 数据新鲜度矩阵
│   ├── side-channel-intel.md    # 6 种旁路情报来源
│   ├── source-recipes/          # 领域专用数据源配置
│   │   ├── maas-and-models.md   # MaaS / LLM API
│   │   ├── medical.md
│   │   ├── semiconductor.md
│   │   ├── auto.md
│   │   ├── fintech.md
│   │   └── energy.md
│   └── ...
├── templates/
│   ├── subagent-*.md            # 5 个子 Agent prompt 模板
│   ├── calculators/             # 单位经济学（Python + Excel）
│   └── visualizations/          # 12 个 SVG/HTML 编辑级暗色主题骨架
├── scripts/
│   ├── validate.py              # 纯 stdlib JSON Schema 校验器
│   └── Makefile                 # make validate / unit-economics / all
└── examples/             # 5 个完整示例
    ├── ex-aigc-image/
    ├── ex-saas-legaltech/
    ├── ex-marketplace-crossborder/
    ├── ex-deeptech-autonomous/
    └── ex-maas-llm/             # v2.2：演示时效性护栏
```

---

## 8 步框架

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Charter        定义范围、签收、终止条件                        │
│ 2. Decompose      拆解为赛道 + 子生态系统                         │
│ 3. Three-Round    R0 时效性扫描 → R1 广度 → R2 深度              │
│    Search         → R3 填补空白 + 交叉验证                        │
│ 4. Coverage       量化完整性关卡（🔴 阻塞）                       │
│    Audit                                                         │
│ 5. Frameworks     Porter 五力 / 7 Powers / Wardley / JTBD         │
│ 6. Quant Model    单位经济学、TAM/SAM/SOM、利润池                  │
│ 7. Thesis         内部观点 + 3 种情景 + 事前验尸                   │
│ 8. Deliverable    6+2 章报告 + 15 个交付物                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 关键设计决策

### 为什么是「原型 + 修饰器」？

SaaS 公司和硬件公司需要截然不同的分析方式。与其一刀切，这个 skill 有 7 种基础原型（每种都有强制分析项）加上正交的**修饰器**来叠加额外要求。

例如：研究 MaaS = `Infrastructure` 原型 + `Rapidly-Evolving Catalog` 修饰器。

### 为什么是「数据四元组」？

输出中的每一个数字都携带：

```json
{
  "value": 2.5,
  "source": "https://openai.com/pricing",
  "as_of": "2026-06-20",
  "grade": "L1"
}
```

这让每一个声明都可审计，并精确告诉你它何时过期。

### 为什么「训练截止偏差」是一等关注点？

LLM 会自信地陈述过时的事实。在快速变化的行业（AI 模型、SaaS 工具、加密货币）中，这会产生看起来完整但实际上已过时 6-18 个月的报告。这个 skill 通过以下方式解决：

- **今日日期戳** —— 强制 Agent 确认当前日期
- **时效性扫描** —— 在一切之前强制搜索「最近 90 天」
- **实时定价抓取** —— 绝不从记忆中引用价格，始终 `curl` 页面
- **第三方聚合器交叉验证** —— OpenRouter、ArtificialAnalysis、LMArena
- **自我披露** —— Agent 必须声明其训练截止日期并标记受影响的字段

---

## 快速上手

### 适用于 Agent 平台（QoderWork、Claude Projects、GPTs）

1. 上传 `.skill` 文件（或指向此仓库）
2. Agent 自动加载 `SKILL.md` 作为系统知识
3. 提问：「帮我做一个 MaaS 行业调研」或「Research the autonomous driving landscape」

### 手动使用

1. 阅读 `workflows/00-execution-plan.md` 了解整体流程
2. 填写 `workflows/01-research-charter.md` 模板
3. 从 `archetypes/` 中选择 1-2 个原型
4. 按顺序执行第 3-8 步

---

## 示例案例

### 案例 1：「对比各大 LLM API 定价」

**触发条件**：`_modifier-rapidly-evolving.md`（月度发布，SKU > 20，价格变化）

**此 skill 的不同之处**：
- 在 R1 之前强制执行 R0 时效性扫描（实时抓取各厂商定价页面）
- 输出包含 13+ 模型的 SKU 矩阵，而非仅仅「知名的那 3 个」
- 通过 OpenRouter/ArtificialAnalysis 交叉验证完整性
- 价格带有 `as_of` 日期和 L 等级；超过 7 天的数据会被标记

**输出**：SKU 定价矩阵（HTML）+ 版本时间线（SVG）+ companies.jsonl + skus.jsonl

---

### 案例 2：「全景分析跨境电商 Marketplace」

**触发条件**：`marketplace.md` 原型（GMV、抽佣率、流动性、双边动态）

**此 skill 的不同之处**：
- 强制执行 Marketplace 特有指标：GMV ≠ 收入，抽佣率拆解，供给端 vs 需求端单位经济学
- 要求每个赛道至少 15+ 家公司（不仅仅是 Shein/Temu/Amazon）
- 追踪失败跨境尝试的「死亡池」
- 监管格局（关税变化、实体清单、增值税规则）

**输出**：格局网格（SVG）+ 估值排行榜（HTML）+ 单位经济学表 + 三情景研判

---

### 案例 3：「Legal Tech SaaS 竞争格局」

**触发条件**：`saas-vertical.md` 原型（NRR、CAC 回收期、垂直领域知识深度）

**此 skill 的不同之处**：
- NRR / GRR / Magic Number / Rule of 40 / Burn Multiple 为强制指标
- 数据来源包括法院备案数据库、律师协会出版物、法律科技会议演讲
- 区分「水平法律工具」与「真正具有领域嵌入 AI 的垂直 SaaS」
- 覆盖度审计在 Tier 2/3 公司也被覆盖之前阻止交付

**输出**：公司深度分析卡片（HTML）+ 单位经济学计算器输出 + Porter 五力雷达图（SVG）

---

## 迭代历史

| 版本 | 日期 | 主题 |
|------|------|------|
| v1.0 | 2026-06 | 单文件 prompt（约 4K tokens） |
| v2.0 | 2026-06-24 | 多文件包：8 步、7 原型、SSOT、Schema、覆盖度审计 |
| v2.1 | 2026-06-24 | +3 示例、+校验器、+计算器、+10 可视化、+5 数据源配方、+术语表 |
| v2.2 | 2026-06-24 | 训练截止偏差修复：修饰器系统、时效性护栏、SKU Schema、旁路情报、MaaS 示例 |

### 每次迭代背后的设计哲学

**v1 → v2**：单个 prompt 无法强制执行流程。拆分为多个文件 = 每一步变成一个关卡而非建议。Agent 可以被命令「在覆盖度审计通过之前不得推进到第 4 步之后」。

**v2.0 → v2.1**：没有工具的方法论只是建议。添加校验器、计算器和可视化模板意味着 Agent 可以真正*运行*方法论（而不仅仅是描述它）。

**v2.1 → v2.2**：现实世界的失败模式暴露：LLM 对快速变化的行业自信地输出过时的产品目录。修复 = 将「时效性」作为一等架构关注点（修饰器 + 护栏 + 实时抓取强制），而非事后补救。

### 下一步（路线图）

- **v2.3**（计划中）：`tests/` 目录，包含 validate.py 的金标回归测试；`data/` 目录，包含实时状态示例；自动化新鲜度检查的 CI 流水线
- **v2.4**（计划中）：额外的修饰器（监管密集型、B2G/政府、创作者经济）；多语言 Charter 模板（EN/CN/JP）
- **v3.0**（探索中）：MCP 服务器封装 —— 将 skill 暴露为任何 MCP 兼容 Agent 可直接调用的工具服务器

---

## 如何贡献

1. **新原型？** 复制 `archetypes/` 中的任意文件，遵循结构（触发条件 → 强制输出 → 指标 → 陷阱）
2. **新数据源配方？** 以 `references/source-recipes/medical.md` 为模板复制，填写 6 个部分
3. **新可视化？** 遵循 `templates/visualizations/README.md` 中的编辑级暗色主题规范（#0F1115 + #C9A87C + #4A90E2）
4. **发现偏差模式？** 添加到 `references/bias-checklist.md`，遵循 症状 → 自检 → 对策 格式

提交前运行 `make validate` 确保 0 错误。

---

## 许可证

MIT

---

## 致谢

通过真实世界的迭代测试构建：AIGC 图像生成格局、法律科技 SaaS、跨境电商、自动驾驶和 MaaS/LLM API 研究。每次迭代都修复了在真实 Agent 驱动的研究会话中发现的失败模式。