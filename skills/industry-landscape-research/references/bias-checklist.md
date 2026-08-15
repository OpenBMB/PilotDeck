# 认知偏差自检清单

> 数据查全了也可能得出错误结论。Thesis 收尾前过一遍。

## 6 类常见偏差

### 1. 确认偏差（Confirmation Bias）

**症状**：只搜支持我观点的证据，对反方证据视而不见。

**自检**：
- 我有没有专门搜过"{我的观点} 反例 / 失败 / 风险"？
- Devil's Advocate Agent 跑过吗？
- 我能想到自己观点最强的 3 个反方论点吗？

**对策**：
- 强制独立 Agent 跑反方论证（见 `workflows/06-thesis-synthesis.md`）
- 调研日志保留所有"被舍弃的证据"，定期回看

### 2. 可得性偏差（Availability Bias）

**症状**：媒体多报道 ≠ 真实规模大。被高声量但小规模的事件牵着走。

**自检**：
- 这家公司"看着大"是因为媒体声量还是营收/用户数？
- 这个趋势是真趋势还是"今年热词"？
- 我引用的 N 篇媒体里，有多少是同一波通稿？

**对策**：
- 用营收/用户数等"硬数据"加权，不要按"提及次数"
- 看公司的"被搜索次数"和"实际营收"对比

### 3. 锚定偏差（Anchoring Bias）

**症状**：第一份报告的数字 anchor 住后续判断。

**自检**：
- 我引用的 TAM 数字最早来自哪？后续都是转引吗？
- 我对"行业规模"的预期是否被第一篇报告固化？
- 如果换一种估算方法，会得到完全不同的数字吗？

**对策**：
- TAM 必须三种算法交叉（top-down / bottom-up / analogy）
- 关键数字必须看至少两个独立来源

### 4. 存活者偏差（Survivorship Bias）

**症状**：我看到的是赢家清单，输家在哪？倒闭的、退市的、转型的、卖掉的。

**自检**：
- 这个行业 5 年前的 TOP 20 现在还活几家？
- 倒闭/退出的公司有哪些？为什么死？
- "赢家共性"是不是把幸存的偶然当必然？

**对策**：
- 维护 Dead Pool 清单（参考 SKILL v1 提到的死亡名单）
- 复盘倒闭原因，常常比赢家共性更有信息量

### 5. 代表性偏差（Representativeness Bias）

**症状**：用 1-2 个明星案例代表整个行业。

**自检**：
- 我的"行业判断"是不是来自 Top 3 公司？
- 长尾公司画像我看过几个？
- Tier 2/3 的运行模式是否真和 Tier 1 一样？

**对策**：
- 每条赛道至少看 15 家公司
- Tier 1/2/3 各做单独分析

### 6. 后视镜偏差（Hindsight Bias）

**症状**：现在看清楚的趋势，假装"我当时就预测到了"。

**自检**：
- 我的 House View 如果放在 2 年前，能不能预测？
- 我有没有错把"已发生的事实"包装成"前瞻判断"？
- 报告里有多少 statements 其实是 retrofit 的？

**对策**：
- Pre-mortem 强制做（详见 `workflows/06-thesis-synthesis.md`）
- 把"已知事实"和"前瞻判断"明确分开标注

### 7. 训练截止偏差（Training Cutoff Bias）🆕

> 由 v2.2 引入。专门针对 LLM 驱动的调研代理。

**症状**：LLM 的知识库截止于 N 个月前（典型 6-18 个月），但仍以"现在时"语气陈述 catalog、SKU、价格、版本号、模型名等"快速演进字段"。典型表现：
- 提到的模型/SKU 全是"上一代"（如调研 2026 年的视频模型，输出却是 wan2.6、sora-1.0）
- 价格用的是已被官方下调或上调的旧值
- 漏掉最近 3-12 个月的新玩家、新版本、deprecation 公告
- 给出的"全景图"看似完整，实则是训练集 snapshot

**自检**：
- 我引用的每个 SKU 名是不是"凭印象"写的，还是直接抓自官方 pricing page（今天日期）？
- 我有没有跑过 Recency Sweep（见 `recency-guardrail.md`）来强制搜最近 N 天的 release？
- 我的 catalog 清单与第三方聚合器（OpenRouter / ArtificialAnalysis / LMArena / HF）对账过吗？
- 任意 in-scope 厂商的官方 changelog / blog / 微信公众号最近 30 天的更新我看过吗？
- 我能不能写出"我的训练截止可能在 YYYY-MM-DD"这句话并说明对结论的影响？

**对策**：
- 启动调研第一步：让用户/调用方明确告知"今天日期"（Today Date Stamp）
- 对 rapidly-evolving 行业强制启用 `archetypes/_modifier-rapidly-evolving.md` 修饰符
- 6 道 Recency Guardrail 闸门全开（见 `references/recency-guardrail.md`）
- catalog 字段一律走"周度刷新"档（见 `references/refresh-cadence.md` 超敏感矩阵）
- 子 Agent system prompt 必须包含五句魔法语：
  1. "Do NOT rely on your training knowledge for SKU names, prices, or version numbers."
  2. "Always fetch the official pricing page LIVE before quoting any price."
  3. "Explicitly list any model that was released in the last 6 months."
  4. "If you cannot verify a SKU is still GA, mark it as Status: Unverified."
  5. "Cross-check your catalog against at least one third-party aggregator."

## 推广水文识别

以下特征提示内容可能是付费推广或软文，降级到 L4：

- 同一措辞在多个媒体同时出现（通稿特征）
- 只讲优点不讲缺点/风险
- 引用数据无来源或来源为"公司内部"
- 标题夸张（"颠覆""革命""首个""最大"）
- 发布在行业媒体的"合作""专栏"标签下
- 文章末尾有"了解更多 + 公司联系方式"

## 数据水分识别

- **用户数膨胀**：注册数 vs 活跃数 vs 付费数，差 10-100 倍常见
- **营收口径模糊**：GMV vs 营收 vs 收入 vs ARR，不注明则默认最大口径
- **估值虚高**：最近一轮估值 vs 二级市场隐含估值，差 2-5 倍常见
- **增速选择性披露**：只展示高增速业务，不提整体增速
- **毛利率虚高**：把营销/服务成本剔除算"软件毛利率"

## 交叉验证最低要求

- 每个关键数据点至少 2 个独立来源
- 两个来源不能是转载关系（A 媒体引用 B 媒体不算独立）
- 冲突数据取保守值或标注分歧范围

## 可信度分级使用规则

| 等级 | 来源 | 用法 |
|------|------|------|
| L1 确定值 | 交易所披露、审计财报、招股书 | 直接使用 |
| L2 高置信 | 权威媒体深度报道（36氪/TechCrunch/Information） | 交叉验证后使用 |
| L3 估算值 | 公司官方 PR、行业媒体综述 | 标注 `~` 或 `(公司口径)` |
| L4 传闻 | 匿名信源、自媒体、水文 | 标注 `(传)` `(未证实)`，必要时排除 |

## Sanity Check 反问清单

报告交付前必答：

- [ ] 我的核心 thesis 如果错了，最可能错在哪？
- [ ] 哪些数据是"令人意外的"？为什么意外？
- [ ] 我有没有给"我喜欢的公司"过度好评？
- [ ] 我有没有给"我讨厌的公司"过度差评？
- [ ] 三情景的 Bear case 真的代表了悲观吗？还是只是"温和的 Base"？
- [ ] Pre-mortem 列出的 5 个失败点，我会监控哪 3 个？
- [ ] **catalog / SKU / 价格类字段是不是凭模型记忆写的？有没有今天日期（Today Stamp）+ 官方 pricing page live fetch？**
- [ ] **报告里有没有标注"训练截止偏差"以及对应的 mitigation 路径？**
