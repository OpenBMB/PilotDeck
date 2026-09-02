# 可视化骨架库

> 所有交付物的"原生可编辑"画布。SVG/HTML 全部内联，无外部依赖；用户只需要把 jsonl 数据塞进对应占位符即可。

## 使用方式

1. 调研结束后，根据 `data/companies.jsonl` 派生对应的可视化输入
2. 复制本目录下骨架文件，把数据塞进占位符（`{{...}}`）
3. 用浏览器打开 .html 预览；或者用 `references/htm-to-pptx.md` 转 PPTX

## 骨架清单

| 文件 | 用途 | 适用步骤 |
|------|------|---------|
| `landscape-grid.svg` | 行业全景图（行=赛道、列=地理） | Step 8 |
| `evolution-timeline.svg` | 演进时间线（水平时间轴 + 阶段标签） | Step 8 |
| `porter-5forces-radar.svg` | Porter 5 力雷达图 | Step 5 |
| `wardley-map.svg` | Wardley 演化图（价值链 × 可见性） | Step 5 |
| `value-chain-journey.svg` | 客户旅程（N 段 × 4 层覆盖） | Step 8 |
| `profit-pool.svg` | 利润池（环节宽度=营收，高度=margin） | Step 6 |
| `stakeholder-stance.html` | 利益相关方立场（HTML+表格+SVG 散点）| Step 5 |
| `company-deepdive-card.html` | 单家公司深度卡 1 页 | Step 8 |
| `valuation-leaderboard.html` | 估值排行榜（带双值：IPO首日 vs 当前）| Step 8 |
| `tam-sam-som-funnel.svg` | TAM/SAM/SOM 漏斗（三算法交叉） | Step 6 |
| `sku-pricing-matrix.html` 🆕 | SKU 矩阵 + 跨厂商价格对比（catalog 类） | Step 5/8（rapidly-evolving 修饰符） |
| `version-timeline.svg` 🆕 | 8 行 × 24 月版本演进时间线 | Step 8（rapidly-evolving 修饰符） |

## 设计规范

- 视觉风格：Editorial 暗色，参考 `assets/showcase.html` 配色（#0F1115 底 + #C9A87C 主色 + #4A90E2 强调）
- 字体：标题 Playfair Display Serif，正文 Noto Sans / Inter，数据 JetBrains Mono
- SVG 必须用 viewBox（响应式），禁止固定 px 宽高
- 数据点必须挂 `<title>` 元素，鼠标悬停显示来源 + 抓取日期 + L 等级
- 配色编码：T1 = 主色实心、T2 = 主色描边、T3 = 灰色描边、非常规公司 = 红边框警示

## PPT 原生重建说明

用户偏好"原生可编辑 PPTX"（addText/addShape，非截图）。HTML/SVG 是中间产物，PPTX 必须重建为原生元素：
- 矩形 → `pptxgenjs.addShape('roundRect', ...)`
- 文本 → `pptxgenjs.addText(...)`
- 折线 → `pptxgenjs.addShape('line', ...)`
- 雷达图 → `pptxgenjs.addChart('radar', ...)`
- 时间线箭头 → `pptxgenjs.addShape('rtTriangle', ...)`（注意：rightTriangle 名称非法）

详细 PPT 重建流水线见 `templates/calculators/htm-to-pptx-pipeline.md`。
