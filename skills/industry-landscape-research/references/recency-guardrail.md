# Recency Guardrail — 时效性护栏

> **专治"提老不提新"**——LLM 训练数据截止后的新版本/新玩家/新价格，本能不会主动出现。
> 本文件给所有调研流程加一道**强制时效闸门**。

## 问题诊断

LLM 训练数据有截止日。截止日后的事件（新模型、新公司、新价格、新政策）即使在网上人尽皆知，LLM 也**不会主动召回**，因为权重里就没有。常见症状：

1. **品牌锚定偏置**：调研 MaaS 只提 wan2.6、不提 seedance 2.5 / 2.0-4k
2. **价格刻舟求剑**：把半年前的价格当现价
3. **新玩家盲区**：新创公司、未广泛报道的产品被无声跳过
4. **官方 SKU 不完整**：只覆盖明星模型，长尾 SKU 遗漏
5. **过期排行榜**：用 1 年前的市占率数据
6. **版本号错位**：把 v1.x 描述套到 v2.x 上

## 6 道闸门（必跑）

### Gate 1：Today Date Stamp

每次调研开始时，第一段就**写明今天日期**：

```
本次调研启动时间：YYYY-MM-DD
数据有效期约束：YYYY-MM-DD ~ YYYY-MM-DD（前 90 天为强敏感窗口）
```

这是给 LLM 自己一个时间锚，强制对照训练截止。

### Gate 2：Recency Sweep（近 N 天扫描）

在 Step 3 三轮搜索后，强制再跑一轮"recency sweep"：

```
检索词：
- "<行业关键词> 2026"
- "<行业关键词> latest" / "newest" / "新发布"
- "<头部公司> launch 2026"
- "<头部公司> release notes"
- site:<官方域名> + 日期范围 limit
```

如果新返回结果包含本次调研未提及的公司/产品/版本，**回滚到 R1 重做**。

### Gate 3：Pricing Page Fresh-Pull

任何涉及定价的章节，**必须现场抓取**最新 pricing page 截图 + URL + 抓取时间戳。
禁止凭印象或训练数据写价格。

### Gate 4：Changelog Diff

对每家头部公司，到官方 changelog/release notes 提取最近 90 天的版本日志，对照已写章节是否覆盖到。

### Gate 5：Third-Party Aggregator Reverse-Lookup

到第三方聚合平台**反向查**最新 SKU，对照自己的清单是否漏：

| 类目 | 反查平台 |
|------|---------|
| LLM | OpenRouter / Artificial Analysis / LMArena / HF Leaderboard / livebench.ai |
| 图像/视频 | Replicate / FAL / artificialanalysis.ai/image |
| Embedding | MTEB Leaderboard |
| GPU | TechPowerUp / Tom's Hardware / NVIDIA spec sheet |
| 云实例 | Vantage.sh / instances.vantage.sh |
| 加密 | DeFiLlama / CoinGecko / DexScreener |

### Gate 6：训练截止自陈

LLM 在 thesis 章节必须自陈：

> "本报告由 LLM 起草，其训练数据截止日约为 YYYY-MM。截止日后至 <今日> 期间事件依赖 live web search，存在召回不全风险。已跑 recency sweep 验证。"

## 5 句魔法咒语（写进子 Agent prompt）

直接复制到任何调研子 Agent 的 system prompt：

```
1. 你的训练数据有截止日，不要凭记忆答任何具体型号、价格、版本号。
2. 涉及具体模型/产品/SKU 必须给出 URL 来源 + 抓取日期。
3. 涉及价格必须现场抓 pricing page，禁止套用历史价。
4. 涉及"行业 TOP N"必须用 live search 而非记忆排名。
5. 列举完竞品后强制再问一次"近 6 个月有没有新玩家进场"，并 live 检索验证。
```

## 反偏置检查清单（自我审查）

调研收尾前过一遍：

- [ ] 报告里出现的所有模型/产品都跑过 live search 验证仍在售？
- [ ] 价格章节都有 < 7 天的 pricing page 截图来源？
- [ ] 版本号都和官方 changelog 最新一致？
- [ ] Top N 排行榜按今日数据重排过？
- [ ] 至少跑过 3 个第三方聚合平台反查？
- [ ] 自陈了训练截止日 + recency sweep 已执行？

## 与 refresh-cadence 的关系

[`refresh-cadence.md`](refresh-cadence.md) 定义的是**长期维护**节奏（季度/月度/周度）。
本文件管的是**单次调研内**的"召回完整性"——即使在 day 1 也必须开闸门。
两者协同：refresh 防数据过期，guardrail 防一开始就漏。
