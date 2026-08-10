export default async function build({ inputPath, createWorkbook, loadWorkbook, helpers }) {
  const workbook = inputPath
    ? await loadWorkbook(inputPath)
    : createWorkbook();

  // Replace this example sheet with the structure required by the current task.
  if (!inputPath) {
    const sheet = workbook.addWorksheet("Sheet1", {
      views: [{ state: "frozen", ySplit: 1, showGridLines: true }],
    });
    sheet.addRows([
      ["字段", "值"],
      ["示例", 1],
    ]);
    helpers.styleHeader(sheet, "A1:B1");
    helpers.autoFitColumns(sheet, { min: 10, max: 28 });
  }

  return workbook;
}
