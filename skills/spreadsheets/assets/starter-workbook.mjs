export default async function build({ createWorkbook, helpers }) {
  const workbook = createWorkbook();
  const sheet = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 3, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = "Workbook title";
  sheet.getCell("A1").font = { name: "Arial", size: 18, bold: true, color: { argb: "FF0F172A" } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 30;

  sheet.addRows([
    [],
    ["Month", "Revenue", "Cost", "Margin"],
    ["Jan", 100000, 70000],
    ["Feb", 120000, 78000],
    ["Mar", 135000, 85000],
  ]);
  helpers.styleHeader(sheet, "A3:D3");

  for (let row = 4; row <= 6; row += 1) {
    sheet.getCell(`D${row}`).value = { formula: `IFERROR((B${row}-C${row})/B${row},0)`, result: 0 };
  }
  helpers.forEachCellInRange(sheet, "B4:B6", (cell) => { cell.numFmt = '"$"#,##0'; });
  helpers.forEachCellInRange(sheet, "C4:C6", (cell) => { cell.numFmt = '"$"#,##0'; });
  helpers.forEachCellInRange(sheet, "D4:D6", (cell) => { cell.numFmt = "0.0%"; });
  sheet.autoFilter = "A3:D6";
  helpers.autoFitColumns(sheet, { min: 11, max: 24 });

  return workbook;
}
