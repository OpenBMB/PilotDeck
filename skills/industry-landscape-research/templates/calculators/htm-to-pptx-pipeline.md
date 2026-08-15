# HTML → 原生可编辑 PPTX 流水线

> 用户偏好：**必须输出原生可编辑 PPTX（addText/addShape，非 PNG/截图式）**；HTML/SVG 仅作为中间预览和数据载体。

## 流水线总览

```
data/companies.jsonl
        │
        ▼
 [Step A] 派生交付物 JSON（renderable layout）
        │
        ▼
 [Step B] 用 pptxgenjs 直接生成原生 PPTX（不经过 HTML）
        │
        ▼
 outputs/industry-deck.pptx
```

或对于复杂可视化（如 Wardley/利润池）：

```
templates/visualizations/*.svg + data
        │
        ▼
 [Step C] SVG 解析为元素列表（位置 + 类型 + 文本）
        │
        ▼
 [Step D] 元素逐个映射为 pptxgenjs addShape/addText
        │
        ▼
 outputs/industry-deck.pptx
```

## Step A：派生 renderable layout

```javascript
// 从 jsonl 生成可渲染对象
const layout = {
  type: "landscape-grid",
  title: "AIGC 图像生成行业全景图",
  asOfDate: "2025-06-24",
  rows: [
    {racetrack: "图像生成", cards: [
      {geo: "NA", companies: [{name: "Midjourney", tier: "T1"}, ...]},
      {geo: "CN", companies: [{name: "即梦", tier: "T1"}, ...]}
    ]}
  ]
};
```

## Step B：pptxgenjs 直接生成

```javascript
const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 inch

const slide = pptx.addSlide();

// 标题（原生文本）
slide.addText(layout.title, {
  x: 0.4, y: 0.3, w: 12, h: 0.6,
  fontSize: 24, fontFace: "Playfair Display",
  color: "E5E0D8"
});

// 卡片（原生圆角矩形 + 文本）
layout.rows.forEach((row, rIdx) => {
  row.cards.forEach((col, cIdx) => {
    col.companies.forEach((c, ciIdx) => {
      slide.addShape("roundRect", {
        x: 1 + cIdx * 2.4,
        y: 1.5 + rIdx * 1.2 + ciIdx * 0.4,
        w: 1.8, h: 0.32,
        fill: { color: c.tier === "T1" ? "C9A87C" : "FFFFFF" },
        line: { color: "C9A87C", width: 1 }
      });
      slide.addText(c.name, {
        x: 1 + cIdx * 2.4, y: 1.5 + rIdx * 1.2 + ciIdx * 0.4,
        w: 1.8, h: 0.32, fontSize: 10, align: "center",
        color: c.tier === "T1" ? "0F1115" : "C9A87C"
      });
    });
  });
});

await pptx.writeFile({ fileName: "outputs/landscape.pptx" });
```

## 关键坑（来自实战）

1. **形状名 `rightTriangle` 非法** → 用 `rtTriangle`
2. **pptxgenjs 4.0.1 `addSlide()` 会生成 phantom slideMaster Override**，PowerPoint 打开会弹"修复"框 → 用 `adm-zip` 后处理剔除不存在 PartName 的 Override：

```javascript
const AdmZip = require("adm-zip");
const zip = new AdmZip("outputs/landscape.pptx");
const ct = zip.readAsText("[Content_Types].xml");
const cleaned = ct.replace(
  /<Override PartName="\/ppt\/slideMasters\/slideMaster\d+\.xml"[^>]*\/>/g,
  match => zip.getEntry(match.match(/PartName="([^"]+)"/)[1].slice(1)) ? match : ""
);
zip.updateFile("[Content_Types].xml", Buffer.from(cleaned));
zip.writeZip("outputs/landscape-fixed.pptx");
```

3. **中文字体兼容性**：客户端没有 "Playfair Display" 时会回退，配色仍生效。建议 PPT 中文字段统一用 `Noto Sans SC` / `Microsoft YaHei`。

4. **大量 addText 性能**：>500 个 shape 时 pptxgenjs 卡顿，可考虑用 OOXML 直接拼 `<p:sp>`。

## SVG 元素 → pptxgenjs 映射表

| SVG 元素 | pptxgenjs API | 备注 |
|---------|--------------|------|
| `<rect>` | `addShape("rect"...)` 或 `addShape("roundRect"...)` | rx 转 rectRadius |
| `<circle>` | `addShape("ellipse"...)` | x = cx - r |
| `<line>` | `addShape("line"...)` | 起止点 |
| `<polygon>` | `addShape("custGeom"...)` | freeform 路径 |
| `<text>` | `addText(...)` | 单独 textBox |
| `<path>` | `addShape("custGeom"...)` | SVG path 解析后转 EMU |
| `<g transform=>` | 偏移所有子元素 | 不支持 group 嵌套 |

## 推荐路径优先级

| 复杂度 | 推荐路径 |
|--------|---------|
| 简单（卡片网格、表格、文本） | Step A + Step B（直接 pptxgenjs） |
| 中等（雷达图、时间线、漏斗） | Step C + Step D（SVG 解析） |
| 复杂（Wardley、利润池） | OOXML 直接拼，控制力最强 |

## 验证清单

- [ ] PowerPoint 打开无"修复"弹窗
- [ ] 所有形状可单独选中并编辑
- [ ] 所有文本可双击修改
- [ ] 中文字体在客户机器上正常显示
- [ ] 配色与 HTML 一致（容差 < 5）
- [ ] 数据点（卡片/标注）数量与 jsonl 一致
- [ ] 文件大小合理（< 2MB 优秀，< 5MB 可接受）
