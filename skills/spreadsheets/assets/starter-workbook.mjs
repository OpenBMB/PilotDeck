export default async function build({ createWorkbook, helpers }) {
  const workbook = createWorkbook();
  const sheet = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 3, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.mergeCells("A1:E1");
  sheet.getCell("A1").value = "工作簿标题 / Workbook title";
  sheet.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF0F172A" } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.addRows([
    [],
    ["月份", "收入", "成本", "利润率", "状态"],
    ["1月", 100000, 70000, null, "正常"],
    ["2月", 120000, 78000, null, "正常"],
    ["3月", 135000, 85000, null, "关注"],
  ]);
  helpers.styleHeader(sheet, "A3:E3");

  for (let row = 4; row <= 6; row += 1) {
    sheet.getCell(`D${row}`).value = { formula: `IFERROR((B${row}-C${row})/B${row},0)`, result: 0 };
  }
  helpers.addTableFromRange(sheet, { name: "SummaryData", range: "A3:E6" });
  helpers.setNumberFormat(sheet, "B4:C6", '¥#,##0');
  helpers.setNumberFormat(sheet, "D4:D6", "0.0%");
  helpers.addListValidation(sheet, "E4:E6", ["正常", "关注", "风险"]);
  helpers.addConditionalFormatting(sheet, {
    range: "D4:D6",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.25], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  helpers.autoFitColumns(sheet, { min: 11, max: 24 });
  helpers.applyChineseTypography(sheet, { platform: "cross-platform", titleRanges: ["A1:E1"] });
  helpers.addNativeChart(workbook, {
    sheet: "Summary",
    type: "line",
    title: "收入与成本趋势",
    minPoints: 3,
    categories: "A4:A6",
    series: [
      { name: "收入", values: "B4:B6", color: "4472C4" },
      { name: "成本", values: "C4:C6", color: "ED7D31" },
    ],
    anchor: { from: "G2", to: "N17" },
    valueFormat: "¥#,##0",
  });

  return {
    workbook,
    requirements: {
      requiredSheets: ["Summary"],
      minFormulaCount: 3,
      requiredFormulaRanges: [{ sheet: "Summary", range: "D4:D6" }],
      expectedRanges: [{
        sheet: "Summary",
        range: "A4:C6",
        values: [["1月", 100000, 70000], ["2月", 120000, 78000], ["3月", 135000, 85000]],
      }],
      requiredNativeCharts: [{ sheet: "Summary", type: "line", minCount: 1, minPoints: 3, sourceRanges: ["A4:A6", "B4:B6", "C4:C6"] }],
      requiredTables: [{ sheet: "Summary", minCount: 1 }],
      requiredConditionalFormatting: [{ sheet: "Summary", range: "D4:D6" }],
      requiredDataValidations: [{ sheet: "Summary", cell: "E4" }],
      requiredCellTypes: [
        { sheet: "Summary", range: "A4:A6", type: "string" },
        { sheet: "Summary", range: "B4:D6", type: "number" },
      ],
    },
  };
}
