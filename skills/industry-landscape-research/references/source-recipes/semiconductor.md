# Semiconductor / 半导体 取数菜谱

适用：IC 设计、Foundry、封测、设备、材料、EDA、IP、CIM、半导体出海。

## 子赛道与别名

| 层 | 别名 | 代表玩家 |
|----|------|---------|
| IC 设计 (Fabless) | Fabless | NVIDIA / AMD / 海思 / 联发科 / 紫光展锐 |
| 晶圆代工 (Foundry) | Pure-play foundry / IDM | TSMC / Samsung / SMIC / 中芯国际 |
| 封测 (OSAT) | OSAT (Outsourced Semi Assembly & Test) | ASE / Amkor / 长电 / 通富 |
| 设备 (Equipment) | Litho / ETCH / CVD / CMP | ASML / Applied / LAM / KLA / 北方华创 / 中微 |
| 材料 (Materials) | Photoresist / Wafer / Gas | 信越 / SUMCO / 沪硅产业 |
| EDA | Electronic Design Automation | Synopsys / Cadence / Siemens EDA / 华大九天 / 概伦电子 |
| IP | Silicon IP / Soft/Hard IP | ARM / RISC-V / Imagination / 芯原 |

## 权威数据库

**全球：**
- SEMI（国际半导体产业协会）：https://www.semi.org/ — 全球出货量、设备 Book-to-Bill
- WSTS（World Semiconductor Trade Statistics）：每月 +季度报告，按区域/品类
- Gartner / IDC / Yole Développement — 设计/设备/封测细分（商业版）
- TrendForce 集邦：内存 + 面板 + 半导体细分（中文易得）
- IC Insights / Omdia — 高质量市场份额

**中国：**
- 中国半导体行业协会（CSIA）：年度白皮书
- 中国半导体投资联盟、芯思想（XinSiXiang.com）
- 集微网 / 半导体行业观察 / 芯榜 / EEFOCUS

## 监管批件 / 出口管制

- **美国 BIS Entity List**：https://www.bis.doc.gov/index.php/policy-guidance/lists-of-parties-of-concern — 被列名企业出口受限（华为、SMIC 等）
- **EAR ECCN 编码**：每颗芯片有出口分类编码（如 GAA 工艺受 3A090 管制）
- **中国大基金一/二/三期投资名单**：受资本支持名单
- **荷兰 / 日本对华出口管制清单**：2026 年起对 DUV 设备升级管制

## 财务披露口径陷阱

| 容易混 | 含义差异 |
|-------|---------|
| 产能 (Capacity) vs 产量 (Output) vs 出货 (Shipment) | 设计产能 ≠ 实际开稼产量 ≠ 销给客户的出货 ≠ 客户已用 |
| 8 寸折算 vs 12 寸折算 | Foundry 产能要折算等价晶圆口径，对应不同制程 |
| 制程节点 (Process node) vs 等价节点 | "7nm" 各家定义不同（TSMC N7 vs Samsung 7LPP vs Intel 7） |
| EDA seat count vs revenue | EDA 卖席位 + 维护费 + IP 授权，三块账不能加总 |
| Backlog vs Booking vs Revenue | 设备类有 6-18 个月交付滞后 |

## 上市公司年报关键科目

- **资本支出 (CapEx)**：Foundry/IDM 看 CapEx 占营收比，>30% = 扩产期
- **毛利率结构**：制程组合（先进制程占比）决定毛利率，年报披露 "Advanced Process Revenue %"
- **库存周转**：芯片周期性强，库存月数 >3 个月 = 周期下行信号
- **客户集中度**：Apple 占 TSMC 25%、NVIDIA 占 11% 都正常，但 IC 设计公司前 5 大客户 >50% = 风险
- **WIP（在制品）+ 已签订单 (Backlog)**：年报附注/MD&A 一定要找

## 一手验证

- **会议**：SEMICON（每年全球 6 站）、IEDM/ISSCC（学术）、Hot Chips（设计）、SNUG/CDNLive（EDA）
- **专家**：Foundry 工艺 PE、设计公司 SoC 架构师、设备公司 AE
- **拆机报告**：TechInsights / Chipworks / SystemPlus — 解剖芯片晒物料清单
- **EE Times、AnandTech、Semianalysis（Dylan Patel）**

## 红线 / 不可写

- ❌ 不要把"流片成功"等同"量产"（流片到量产 1-2 年）
- ❌ 不要把"封装良率"等同"系统良率"（封装 99% × 测试 95% × 终端通过 90% = 85% 系统）
- ❌ 不要把"设备订单 (Booking)"算作当年营收（设备一笔订单跨多年确认）
- ❌ 不要无视出口管制版本差异（同一颗芯片"中国特供版" vs "原版"性能差 20-40%）
