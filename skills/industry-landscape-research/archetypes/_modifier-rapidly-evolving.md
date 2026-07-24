# Modifier: Rapidly-Evolving Catalog 快速演进目录型行业

> 这是一个 **modifier**（修饰符），不是独立 archetype。
> 叠加到任意基础 archetype（platform / infrastructure / saas-vertical / deeptech 等）之上。

## 触发条件

满足以下任意 **2 项**即启用本 modifier：

1. **发版频率**：行业头部玩家每月/每季度发新版本或新 SKU（如 MaaS 模型周更、显卡季度迭代、云数据库实例规格月增）
2. **SKU 数量**：单一公司产品目录 SKU 数 > 20 且参数差异显著（不是简单的尺寸/颜色 SKU）
3. **价格敏感**：价格 / Token 计费 / 实例单价是客户决策核心变量
4. **官方 changelog**：公司维护可公开访问的 Release Notes / Changelog / Pricing Page
5. **训练截止偏置高发**：LLM 训练数据截止后已有 ≥1 个重要新版本/新玩家进入

## 高发行业清单（非穷尽）

| 行业 | 典型 catalog 节奏 | 价格变量 |
|------|------------------|---------|
| MaaS / 大模型服务 | 周-月 | Token 单价 + 上下文长度 + 模态 |
| AI 编码助手 | 月-季度 | 用户/座位/月 + Token 计费 |
| 视频/图像生成 SaaS | 月 | 分辨率 × 时长 × 模型 |
| 显卡/AI 芯片 | 季度-半年 | TFlops × 显存 × 互联 × 制程 |
| 云计算实例 | 持续 | vCPU × 内存 × 网络 × 区域 × 预留/按需 |
| 向量数据库 | 月 | 容量 × QPS × 索引算法 |
| Embedding 模型 | 周-月 | 维度 × 上下文 × 单价 |
| 加密协议 / DeFi | 周 | TVL × 手续费 × Gas |
| 浏览器 / 操作系统 | 季度 | 内核版本 × 特性 flag |

## 启用本 modifier 后必填项（在基础 archetype 之上叠加）

### A. SKU Matrix 画布（必填）

每家公司必须输出：

| 列 | 数据点 | 来源优先级 |
|----|--------|----------|
| SKU/版本名 | 完整模型名/规格名 | L1 官方 |
| 发布日期 | YYYY-MM-DD 或 YYYY-Q | L1 官方 Release Notes |
| 核心参数 | 关键技术规格（参数量/上下文/分辨率/显存）| L1 官方 |
| 价格 | 完整定价（单价 + 阶梯 + 折扣 + 免费额度）| L1 官方 Pricing Page |
| QPS/Rate Limit | 速率限制 | L1 官方 |
| 状态 | GA / Beta / Preview / Deprecated | L1 官方 |
| 上一版本 | 上一代型号名 | 官方 changelog |
| 升级要点 | 相比上一代变化 1-2 句 | 官方 / 第三方测评 |

模板见 [`templates/visualizations/sku-pricing-matrix.html`](../templates/visualizations/sku-pricing-matrix.html)。

### B. Version Timeline（必填）

横向时间轴，标出每家头部公司近 24 个月的版本里程碑：
- 普通版本：圆点 + 版本号
- 重大版本：方块 + 简短描述
- Deprecated：✕ 标记 + 终止日期

模板见 [`templates/visualizations/version-timeline.svg`](../templates/visualizations/version-timeline.svg)。

### C. Pricing Comparison（必填）

横向定价对比表，同一任务（如"1M token 中文生成"）跑下来各家的真实成本：

| 模型/SKU | 输入单价 | 输出单价 | 1M token 总成本 | 折算成本因子 |
|---------|---------|---------|----------------|-------------|
| ... | ... | ... | ... | 标 1.0× / 0.5× / 2.3× |

### D. 版本敏感的 Coverage Audit（必填）

在 Step 4 Coverage Audit 矩阵新增 3 行强制项：

| 维度 | 覆盖度 | 缺口分级 |
|------|--------|---------|
| 近 90 天发布版本/SKU 覆盖 | ⭐⭐⭐⭐⭐ 需 ≥ 95% | 缺则 🔴 |
| 官方 Pricing Page 抓取完整度 | ⭐⭐⭐⭐⭐ 需 100% | 缺则 🔴 |
| 第三方 benchmark 验证 | ⭐⭐⭐ 需 ≥ 50% | 缺则 🟡 |

## 检索词增强清单（启用 modifier 必加）

基础检索词（公司名/产品名）之外，必须额外跑：

| 检索词模板 | 用途 |
|-----------|------|
| `<公司> latest release 2026` | 找最近新版本 |
| `<公司> changelog` / `release notes` | 完整版本史 |
| `<公司> pricing` / `<公司> API price` | 拿原始定价 |
| `<产品名> v? OR version` | 新版本号扫描 |
| `<产品名> deprecated` | 旧版本退役 |
| `<行业> 2026 new model` / `latest <category>` | 行业级新品扫描 |
| `<公司> roadmap` | 未发布预告 |
| `site:<官方域名>` 限定搜索 | 绕开二手转引 |

## SKU 穷尽方法（防漏召回）

1. **官方 pricing 页**起步：列出所有可见 SKU
2. **API 文档** model_list 接口：实际可调用模型清单（常比 pricing 页全）
3. **官方公众号 / 博客 / Twitter**：beta / preview 阶段先在这里曝光
4. **第三方聚合平台**：OpenRouter / Artificial Analysis / LMArena / Hugging Face leaderboard 反向看
5. **客户群 / Discord / 知乎**：求"全模型支持"的问答帖
6. **竞品对比**：每家"vs 友商"页面常列出友商最新 SKU

## 红线

- ❌ 禁止用 LLM 训练数据直接答"某家有什么模型"——必须查 live page
- ❌ 禁止只看 marketing slogan，必须拿 SKU 列表 + 价格 + 发布日期
- ❌ 禁止跨版本混用价格（如把 wan2.5 的价格当 wan2.7 用）
- ❌ 禁止把 Pricing Page 截图替代结构化数据（必须落到 SKU Matrix）

## 配套机制

- 数据保鲜：见 [`refresh-cadence.md`](../references/refresh-cadence.md) 中"catalog/SKU/价格"档（周度刷新）
- 反偏置：见 [`recency-guardrail.md`](../references/recency-guardrail.md) 防 LLM 训练截止盲区
- 行业菜谱：见 [`source-recipes/maas-and-models.md`](../references/source-recipes/maas-and-models.md)
- 检查清单：见 [`bias-checklist.md`](../references/bias-checklist.md) "Training Cutoff Bias" 一节
