# 示例：自动驾驶（DeepTech / Hardware 原型）

> 本示例展示 archetype = `deeptech-hardware` 时，如何套用八步法对"L4 自动驾驶"行业做完整调研。
> 关键差异点：技术成熟度（TRL）+ 专利护城河 + 路测里程 + Disengagement Rate 是命脉；融资额/估值 ≠ 价值（DeepTech 长周期高烧钱）；商业模式分层（Robotaxi / 货运 / 量产辅助）。

## Step 1: Charter

| 字段 | 取值 |
|------|------|
| Scope | L4 级自动驾驶系统（Robotaxi、Robotruck、Mining/Port 物流）+ L2++ 量产辅助驾驶提供商 |
| Out-of-Scope | 车企自研内部团队（不开放对外服务者，如蔚来 NAD/小鹏 XNGP 不单列）、L1 ADAS 供应商（Mobileye 早期产品）|
| Audience | 战略投资 + 产业合作部 |
| Decision | 是否投资 Robotaxi 公司 IPO（Pony.ai / WeRide）；是否与 L2++ 量产方案商（Momenta / DeepRoute）做战略合作 |
| Hypotheses | ① 2026-2028 是 Robotaxi 商业化分水岭，行业从 50+ 家收缩到 3-5 家；② 中国 Robotaxi 商业化速度领先美国 12-18 月；③ L2++ 量产业务是大多数自动驾驶公司"现金牛"现实选项 |
| Success Criteria | 全球 TOP 20 玩家融资/估值/路测里程 L1+L2 ≥80%；至少 3 家公司有 disengagement rate 公开数据；专利分布/工程师数量数据齐全 |

## Step 2: Decompose

```
自动驾驶
├── 按等级与场景
│   ├── L4 Robotaxi（Waymo, Cruise, Zoox, Pony.ai, WeRide, AutoX, Baidu Apollo）
│   ├── L4 Robotruck（Aurora, Kodiak, Plus, TuSimple, Inceptio 嬴彻, 主线）
│   ├── L4 限定场景（Gatik 中短途, Bear Robotics 末端配送）
│   └── L2++ 量产（Mobileye, Momenta, DeepRoute, Horizon 地平线, 元戎启行）
├── 按价值链
│   ├── 芯片/算力（NVIDIA Drive, Qualcomm Snapdragon Ride, Horizon, Mobileye EyeQ）
│   ├── 传感器（Luminar/Hesai/RoboSense 激光雷达, Mobileye 摄像头）
│   ├── 系统集成（Tier 1: Bosch, Continental, ZF）
│   ├── 算法/软件栈（Wayve 端到端模型, Tesla FSD）
│   └── 运营/出行平台（Waymo One, Pony.ai PonyPilot）
└── 按地理
    ├── 美国（Waymo, Cruise[暂停], Zoox, Aurora）
    ├── 中国（百度 Apollo, Pony.ai, WeRide, AutoX, Momenta, DeepRoute）
    └── 其他（Wayve UK, Oxbotica UK, Mobileye IL）
```

## Step 3-4: Coverage Audit

R1 公司清单 32 家；R3 后 disengagement 数据覆盖 9/32（仅加州 DMV 强制披露的 + 中国主动披露的）。

### Coverage Audit 矩阵（DeepTech 必填项）

| 维度 | 覆盖 | 等级 |
|------|------|------|
| 累计融资 | 30/32 | ⭐⭐⭐⭐⭐ 🟢 |
| 最新估值 | 26/32 | ⭐⭐⭐⭐ 🟡 |
| 路测里程 | 18/32 | ⭐⭐⭐ 🟡 |
| Disengagement Rate | 9/32 | ⭐⭐ 🔴 |
| 工程师 / R&D 人数 | 22/32 | ⭐⭐⭐⭐ 🟢 |
| 专利数量（USPTO/CNIPA）| 15/32 | ⭐⭐⭐ 🟡 |
| 商业化里程碑 | 28/32 | ⭐⭐⭐⭐⭐ 🟢 |
| TRL 等级评估 | 32/32 | ⭐⭐⭐⭐⭐ 🟢（自评+交叉）|

🔴 处置：disengagement 缺口公司用"开放城市数 × 累计里程"做代理指标，标 L3。

## Step 5: 分析框架

### Wardley Map（DeepTech 必备）

| 价值链环节 | 当前位置 | 演化方向 |
|-----------|---------|---------|
| 高精地图 | Custom-built → Product | 渐 commodity，HD map vendor 减少 |
| 激光雷达 | Custom-built → Product | 价格从 $75K 降到 $500 |
| L4 算法栈 | Genesis → Custom-built | 仍处于黑魔法阶段，端到端范式重构 |
| Robotaxi 运营 | Custom-built | 暂未 commodity，地理扩张是工程问题 |
| 芯片 | Product | NVIDIA/Mobileye 主导，趋向标准化 |

### Helmer 7 Powers（以 Waymo 为例）

| Power | 评分 | 证据 |
|-------|------|------|
| Cornered Resource | 5 | Google 系算力 + 数据 + 资金，无敌后盾 |
| Scale Economies | 4 | 累计 2,000 万英里实测，数据反馈飞轮 |
| Switching Costs | 3 | B2C 切换成本低，对车队运营商高 |
| Brand | 5 | "自动驾驶 = Waymo" 全球认知 |
| Counter-Positioning | 4 | 传统车企学不来"端到端模型 + 数据飞轮" |
| Network Economies | 3 | 区域型，仅在运营城市内 |
| Process Power | 4 | 验证/安全流程沉淀 10 年 |

### TRL 等级表（Technology Readiness Level）

| 公司 | TRL | 商业化状态 |
|------|-----|----------|
| Waymo | 8-9 | 凤凰城/旧金山/洛杉矶/奥斯汀商业化运营，4 城市 |
| 百度 Apollo | 7-8 | 武汉萝卜快跑商业化，但价格仍补贴 |
| Pony.ai | 7-8 | 北京/广州/深圳，IPO 中 |
| Cruise | 6（事故后回退）| 暂停 |
| Wayve | 5-6 | 仅测试，端到端范式领先但未量产 |

## Step 6: 量化建模

### Robotaxi 单位经济学（推算，2025-Q2）

| 平台 | 单车成本 | 月运营成本 | 月收入（中国） | 月收入（美国）| 单车毛利 |
|------|---------|-----------|---------------|--------------|---------|
| Waymo Jaguar I-PACE | $200K | $9K | - | $18K | $9K（接近盈亏平衡）|
| 百度 Apollo RT6 | RMB 200K | RMB 25K | RMB 30-40K | - | RMB 5-15K |
| Pony.ai 第 7 代 | RMB 250K | RMB 28K | RMB 25-35K | - | -RMB 3 ~ +7K |

> 数据来源：摩根士丹利 2025 自动驾驶白皮书、各公司 SEC/港交所招股书。

### TAM/SAM/SOM

- 自上而下：全球出租车 + 网约车市场 $250B × 自动化渗透率 30%（2035 假设） = $75B TAM
- 自下而上：全球城市 500 × 单城 500 辆 × $50K 年单车收入 = $12.5B
- 类比：UberX 全球营收 $40B (2024) × Robotaxi 替代率 50% = $20B

中位数收敛在 $25-40B（2030-2035 区间）。

## Step 7: Thesis

### House View

> Robotaxi 不是技术问题，是商业化和监管节奏问题；2026-2028 是收缩期，中美 TOP 3 之外的公司大概率被并购或转型；L2++ 量产业务是大多数自动驾驶公司活下去的现实选项；端到端模型（Wayve / Tesla FSD）范式可能在 2027-2028 颠覆现有路线。

### 三情景（5 年）

| 情景 | 触发条件 | 概率 | 全球 Robotaxi 营收 |
|------|----------|------|---------------------|
| Bull | 美 NHTSA 颁布全国统一法规、Waymo 进 20 城、中国 30 城商业化 | 25% | $35B |
| Base | 监管缓慢、Waymo 进 8 城、中国 10 城、Pony/WeRide 上市 | 55% | $14B |
| Bear | 重大事故监管反扑、Cruise 类事件再发、模型瓶颈未突破 | 20% | $4B |

### Pre-mortem

1. 重大事故（Cruise 翻版）导致 NHTSA / 工信部 暂停 Robotaxi 运营
2. 端到端模型在边缘场景（雨雪、施工区）表现远不及预期
3. NVIDIA Drive Thor 量产推迟 18 月，行业算力卡脖子
4. 激光雷达价格降不下，单车成本无法 < $50K
5. 车企收编自动驾驶团队（如通用收回 Cruise），独立公司空间被压缩

### Devil's Advocate（反方）

> "自动驾驶是个永远 5 年后实现的承诺，Robotaxi 永远不会盈利，资本市场已经厌倦。"
> 应对：① Waymo 在凤凰城单车已接近盈亏平衡；② 百度萝卜快跑单车成本从 RMB 60 万降至 RMB 20 万（4 年降幅 67%）；③ 中国 4 大城市政策放开速度超预期；④ 端到端模型 + AI 大模型范式为 disengagement rate 改善带来非线性可能。

## 关键经验沉淀

- DeepTech 调研必须建 TRL 等级表，避免"融资多 = 离商业化近"的错觉
- Disengagement Rate 是核心命脉指标，没有就用代理指标，永远要标
- 监管立场图（NHTSA / 工信部 / 加州 DMV / 北京/上海/广州 智驾办）权重高于其他原型
- 专利/工程师密度比 "AI 模型多大" 更能预测 5 年后位置
- 商业化里程碑表（开放城市/累计里程/事故披露/收费状态）是 DeepTech 行业全景图核心可视化
