# Side-Channel Intelligence 侧面情报手册

> "正面"调研用财报、官网、招股书。"侧面"情报从间接信号反推真相。
> 在快速演进 / 信息不透明 / 未上市公司众多的行业，侧面情报往往是唯一活水。

## 6 大侧面情报来源

| 来源 | 反推什么 | 适用场景 |
|------|---------|---------|
| 招聘 JD | 团队规模/技术栈/方向/扩张节奏 | 全行业 |
| 专利地图 | 技术路线/研发深度/竞争壁垒 | DeepTech / 硬件 / 制药 |
| 投资联盟图 | 资本绑定/站队/生态影响 | VC 重投行业 |
| GitHub 活跃度 | 开源策略/团队规模/技术真实度 | 开源/工具/AI infra |
| App 商店监测 | 产品热度/迭代节奏/区域热度 | C 端 / 移动互联网 |
| Wayback Machine | 产品演进/定价变化/叙事变化 | 全行业 |

## 1. 招聘 JD 侦察 (Recruiting Intelligence)

### 数据源

| 平台 | 强项 |
|------|------|
| LinkedIn Jobs | 全球，可按公司精确筛 |
| BOSS 直聘 | 中国，能看到团队规模/JD 详情 |
| 拉勾 / 猎聘 | 中国 IT，技术栈关键词丰富 |
| 看准网 | 隐含薪资范围 + 员工评论 |
| Levels.fyi | 全球，薪资分布 + 职级 |
| H1B Visa Database | 美国，工资单 + 职位 |
| The Org | 公司组织架构图 |
| Glassdoor / Indeed | 海外评论 + JD |

### 反推方法论

| 信号 | 解读 |
|------|------|
| 在招总数突增 50%+ | 融资到账 / 战略扩张 |
| 在招总数骤降 70% | 现金紧张 / 战略收缩 / 裁员 |
| "大模型 + 推理优化"岗位激增 | 自研推理框架 |
| 高级架构师 + 多国家招聘 | 出海或本地化部署 |
| 中国 + Singapore JD 同时上 | 出海东南亚 |
| 学历从硕优变成博必 | 切深科技 / 切学术合作 |
| 销售/BD 在招 > 研发 在招 | 从产研主导转商业化 |
| HR 大量"AI 应用"招聘 | 内部组建 AI 应用团队 |

### 实操脚本

```bash
# 监控某公司 LinkedIn 月度 JD 数量
linkedin.com/jobs/search/?f_C=<company_id>&f_TPR=r2592000

# BOSS 直聘公司主页
www.zhipin.com/gongsi/?query=<company_name>

# Levels.fyi 公司薪资曲线
levels.fyi/company/<company_slug>
```

## 2. 专利地图 (Patent Map)

### 数据源

| 平台 | 覆盖 |
|------|------|
| **CNIPA 中国专利公布**：cnipa.gov.cn / pss-system.cponline.cnipa.gov.cn | 中国 |
| **USPTO Patent Full-Text**：patft.uspto.gov | 美国 |
| **EPO Espacenet**：worldwide.espacenet.com | 欧洲 + 全球 |
| **WIPO PatentScope**：patentscope.wipo.int | 全球 (PCT) |
| **Google Patents**：patents.google.com | 全球聚合，免费易用 |
| **智慧芽 PatSnap**：patsnap.com | 商业版，地图可视化最强 |
| **incoPat**：incopat.com | 中文友好商业版 |

### 反推方法论

| 信号 | 解读 |
|------|------|
| 近 24 个月专利数 5× 增长 | 技术储备激增（值钱赛道） |
| 专利集中在 X 子领域 | 技术路线选择 |
| 与高校/研究院联名专利多 | 学术合作型 |
| 海外专利数 > 中国 | 出海布局 |
| 引用次数 > N | 基础专利 / 卡位核心 |
| 专利诉讼 | 行业竞争白热化（注意 NDA 风险） |

### 输出物

| 图 | 用途 |
|----|------|
| 专利数量增长曲线 | 头部公司 vs 时间 |
| 技术分类热力图 | IPC 大类 × 公司 |
| 引用关系图 | 谁引谁，定位 anchor 专利 |
| 地理布局图 | 中/美/欧/日韩布局 |

## 3. 投资联盟图 (Investment Map)

### 数据源

| 平台 | 强项 |
|------|------|
| **Crunchbase** | 全球融资事件，免费等级有限 |
| **PitchBook** | 全球深度，付费 |
| **CB Insights** | 全球 + 行业图谱，付费 |
| **天眼查 / 企查查 / 启信宝** | 中国，股权穿透 |
| **IT 桔子** | 中国创投数据库 |
| **36 氪融资数据库** | 中国 |
| **SEC EDGAR** | 美国上市/Form D 备案 |

### 反推方法论

| 图谱 | 揭示 |
|------|------|
| 投资方—被投方矩阵 | 站队 / 联盟 |
| LP—GP—被投三层穿透 | 资本最终来源 |
| 历轮估值跃迁 | 资本对赛道判断 |
| 同基金多轮跟投 | 重仓信号 |
| 战略投资方背景 | 渠道/技术/客户绑定 |
| 二级市场 IPO 前股东 | 锁定期与解禁压力 |

### 实操：抓 CB Insights AI 50 / Forbes AI 50 / 福布斯 AI 中国 50 等头部榜单的"投资方—被投"关系，画 force-directed graph。

## 4. GitHub 活跃度 (Open Source Intelligence)

### 数据源

| 数据 | API |
|------|-----|
| Star 增长曲线 | star-history.com |
| Commit 频率 + 贡献者 | github.com/<org>/<repo>/graphs/contributors |
| Issue / PR 响应速度 | GitHub API |
| Release 频率 | GitHub Releases |
| 依赖图 (Dependents) | GitHub Insights / libraries.io |

### 反推方法论

| 信号 | 解读 |
|------|------|
| Star 7 天 +5000 | 病毒级传播 |
| Star 增长但 commit 萎缩 | 收割流量 / 团队解散 |
| Contributor 突变 | 核心人员变动 |
| Issue 响应 > 7 天 | 维护力度下降 |
| Release 月频 → 季频 | 产品成熟或换重心 |
| Dependents 数大 | 已成基础设施 |
| Fork > Star 异常高 | 可能是模板 / 学习项目，非真实采用 |

### 工具

- **OSS Insight**：ossinsight.io — 整合 GitHub Archive，可视化最强
- **GitHub Archive**：githubarchive.org — 原始数据 BigQuery 查询
- **star-history.com** — 一键画 star 曲线
- **libraries.io** — 跨包管理器依赖图

## 5. App 商店监测 (Mobile Intelligence)

### 数据源

| 平台 | 覆盖 |
|------|------|
| **App Annie / data.ai** | 全球，付费 |
| **Sensor Tower** | 全球，付费 |
| **七麦数据** | 中国 App Store + 国内安卓商店 |
| **酷传** | 中国安卓多渠道 |
| **AppFigures** | 全球，中等价 |
| **SimilarWeb** | 网站 + App 流量 |
| **dataeye** | 中国海外投放素材 |

### 反推方法论

| 信号 | 解读 |
|------|------|
| 下载榜单排名变化 | 用户热度 / 投放力度 |
| 收入榜变化 | 商业化进展 |
| 评分骤降 | 产品事故 / 差评水军 |
| 投放素材数 | 营销预算 |
| 区域分布 | 出海地理 |
| 版本更新频率 | 迭代速度 |
| 关键词排名 (ASO) | 内容/获客策略 |

## 6. Wayback Machine 历史追踪 (Web Archaeology)

### 数据源

| 平台 | URL |
|------|-----|
| **Internet Archive Wayback Machine** | web.archive.org |
| **archive.today** | archive.ph / archive.today |
| **Google Cache (deprecated)** | 已基本失效 |
| **Common Crawl** | commoncrawl.org — 大规模历史快照 |

### 反推方法论

| 比对维度 | 揭示 |
|---------|------|
| 首页 hero slogan 变化 | 战略叙事漂移 |
| 产品列表/SKU 变化 | 产品线进退 |
| Pricing Page 历史 | 价格演变 / 商业模式调整 |
| About Us 团队页 | 人员变动 |
| Logo / Brand 变更 | 品牌重塑节点 |
| Job Page 招聘历史 | 团队规模时序 |
| Customer Logo 客户案例 | 客户迁出/迁入 |

### 实操工作流

```
1. 给目标公司官网，去 Wayback 拉 12-24 个月历史快照（每月 1 张）
2. 重点比对 Pricing / Customer / Roadmap / Career 4 个页面
3. 用 diff 工具看文本变化
4. 关键转折时间点 + 截图存档为附录材料
5. 与公开融资事件/媒体报道对照
```

## 用法

- 任何调研启动时，从本清单选 **2-3 种**叠加进入 Step 3 三轮搜索后的补盲阶段
- 不同 archetype 推荐：
  - Platform / Infrastructure → JD + Wayback + GitHub
  - SaaS-Vertical → JD + 投资联盟 + Wayback
  - DeepTech / Hardware → 专利 + JD
  - Consumer → App 商店 + Wayback + 投资联盟
  - Marketplace → JD + App 商店 + GitHub (if 开源 SDK)
  - Content-Media → App 商店 + Wayback

## 红线

- ❌ 不要把"侧面情报"当主证据，仍以财报/招股书 (L1) 为锚，侧面用于交叉验证
- ❌ 招聘 JD / 专利数都有 lag（半年级），不能用作"实时"指标
- ❌ Wayback 历史快照不全（小网站可能 0 张），不存在不等于"没存在过"
- ❌ GitHub Star 可水军，必须结合 commit/issue 真实度
