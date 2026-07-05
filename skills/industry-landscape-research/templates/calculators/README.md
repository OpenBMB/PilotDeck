# 单位经济学计算器

## 使用方式

1. 复制 `unit-economics-calculator.csv` 为新文件
2. 填入"输入"列的灰底单元格（黄色单元格自动计算）
3. 黄底单元格会按公式自动算出 LTV/CAC/Rule of 40 等
4. 也可以用 `unit-economics-calculator.py` 跑批量计算（多家公司对比）

## 文件清单

- `unit-economics-calculator.csv` — Excel/Numbers 可直接打开，含 SaaS / Marketplace / Consumer / DeepTech 四套预设
- `unit-economics-calculator.py` — Python 脚本（标准库 only），可对 `companies.jsonl` 批量算
- `unit-economics-formulas.md` — 公式与解读
- `htm-to-pptx-pipeline.md` — 把 HTML/SVG 可视化重建为原生可编辑 PPTX 的流水线

## 公式速查

| 指标 | 公式 | 健康阈值（中位数）|
|------|------|------|
| LTV | ARPU × 毛利率 / 月流失率 | 至少 3× CAC |
| CAC | 销售费用 / 新增客户数 | 行业相关 |
| CAC Payback | CAC / (ARPU × 毛利率) | <18 个月（SaaS）|
| Rule of 40 | 营收增速 + EBITDA margin | ≥40% |
| Magic Number | 增量 ARR / 增量销售费用 | ≥1.0 |
| NRR | (期末 ARR - 流失 - 降级) / 期初 ARR | ≥110% 强健 |
| GRR | (期末 ARR - 流失) / 期初 ARR | ≥90% |
| Burn Multiple | 净亏 / 净增 ARR | <1.5× 健康 |
| Contribution Margin | (收入 - 变动成本) / 收入 | >0 为正 |
