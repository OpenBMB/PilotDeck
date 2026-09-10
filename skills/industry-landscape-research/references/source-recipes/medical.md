# Medical / 医疗 取数菜谱

适用：创新药、生物制品、医疗器械、IVD、医疗 SaaS、CRO、AI 制药。

## 子赛道与别名

| 中文别名 | 英文 | 核心监管 |
|---------|------|---------|
| 创新药 / 1 类新药 | Innovative drug / NCE (New Chemical Entity) | NMPA (中) / FDA (美) / EMA (欧) |
| 生物制品 / 大分子 | Biologics / mAb / ADC | 同上 |
| 医疗器械 II/III 类 | Medical device Class II/III | NMPA / FDA 510(k) or PMA |
| 体外诊断 | IVD / In-Vitro Diagnostics | NMPA / FDA CDRH |
| AI 医学影像 | AI-CAD / AI for Radiology | NMPA 三类证 / FDA SaMD |
| 真实世界研究 | RWE / Real-World Evidence | 各地药监局 |

## 权威数据库

**中国（首选）：**
- NMPA 药品/器械数据查询：https://www.nmpa.gov.cn/datasearch/home-index.html — 已批准品种最权威
- 药智数据：https://www.yaozh.com/ — 商业版需付费，含临床试验/审评进度
- 丁香园 Insight：https://db.dxy.cn/ — 医药数据 + 行业数据
- CDE 临床试验登记：http://www.chinadrugtrials.org.cn/

**全球：**
- ClinicalTrials.gov — 临床试验金标准（试验阶段/入组数/PI）
- FDA Orange Book — 已批准药物 + 专利信息
- FDA 510(k) Database — 器械批准
- EMA EPAR — 欧盟批准报告
- PubMed + Cochrane — 学术 + Meta 分析
- IQVIA / Evaluate Pharma / GlobalData — 销售数据（商业版）

## 监管批件原文路径

- **NMPA 批件号**：国药准字 H/S/Z (Hxxxxx 化药、Sxxxxx 生物制品、Zxxxxx 中药) → 在 NMPA 官网"国产药品"查
- **FDA NDA/BLA No.**：5-6 位数字，到 Drugs@FDA 检索全套审评文件（含 Medical Review、Stats Review，含金量极高）
- **CE 标识**：欧盟器械标志，但 2026 年 MDR 后真实有效性需查 EUDAMED

## 财务披露口径陷阱

| 容易混的口径 | 含义 | 不能等同 |
|-------------|------|---------|
| 销售收入 vs 渠道入库 | 药企报表 "Revenue" 含返利/折让；渠道商进货 ≠ 终端使用 | 同期"医院 PDB 数据"会差 30-50% |
| 已批准适应症 vs 销售主力 | 拓展适应症可能 5 年都不放量 | 看年报"按产品/按适应症"明细 |
| 入组数 vs 完成数 | Phase III 入组完成 ≠ 数据读出 | 看 ClinicalTrials.gov primary completion date |
| 集采中标价 vs 院内实际价 | 集采价是新基准，但院外/省外可能更高 | 区分"集采品种"与"非集采品种" |

## 上市公司年报关键科目

- **研发费用率**：行业基准 8-15%；创新药 Biotech 30-80% 都正常
- **管线披露**：年报"研发进展"必看，临床阶段 + 适应症 + 预计上市年份
- **集采影响**：受集采品种披露"中标价格变化对收入影响"，未受披露反向 + 自费市场策略
- **海外授权 (license-out)**：首付款一次性 / 里程碑分期 / 销售分成，需看"无形资产"和"递延收入"

## 一手验证

- **行业会议**：CMEF（中国国际医疗器械博览会，每年春秋两展）、PHARMCHINA、ASCO（肿瘤）、AHA（心脑血管）
- **专家访谈**：找三甲医院临床科室主任（KOL）问"实际开方逻辑"，找药代问渠道库存
- **第三方报告**：弗若斯特沙利文（IPO 招股书 60% 引用）、艾昆纬 IQVIA、米内网（中国院内销售）

## 房屋查询小工具

- 查 NMPA 是否批准：`site:nmpa.gov.cn 国药准字 [品种名]`
- 查 FDA 审评全文：`site:accessdata.fda.gov [NDA号]`
- 查临床试验状态：`ClinicalTrials.gov + NCT编号`
- 查 PubMed 综述：`[indication] systematic review`（限定 5 年内）

## 红线 / 不可写

- ❌ 不要把"已获批"等同于"已商业化"（部分品种获批后 2-3 年才放量）
- ❌ 不要用单一渠道数据（PDB 只覆盖等级医院、医保覆盖只在医保目录、零售只在药店）
- ❌ 不要混 RWE / RCT 数据（真实世界 vs 严格随机对照，结论可能反向）
