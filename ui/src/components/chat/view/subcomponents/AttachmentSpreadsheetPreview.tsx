import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Sheet = { name: string; rows: string[][]; truncated: boolean };

/** A bounded, read-only view: attachments are not editable workspace files. */
export default function AttachmentSpreadsheetPreview({ file, onError }: { file: File; onError: () => void }) {
  const { t } = useTranslation('chat');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { default: ExcelJS } = await import('exceljs');
        if (cancelled) return;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await file.arrayBuffer());
        if (cancelled) return;
        const result = workbook.worksheets.map(sheet => ({
          name: sheet.name,
          truncated: sheet.rowCount > 200 || sheet.columnCount > 50,
          rows: Array.from({ length: Math.min(sheet.rowCount, 200) }, (_, row) =>
            Array.from({ length: Math.min(sheet.columnCount, 50) }, (_, column) => sheet.getCell(row + 1, column + 1).text)),
        }));
        if (!cancelled) setSheets(result);
      } catch { if (!cancelled) onError(); }
    })();
    return () => { cancelled = true; };
  }, [file, onError]);
  const sheet = sheets[active];
  return <div className="flex h-full w-full min-w-0 flex-col">
    <div className="flex shrink-0 gap-2 overflow-x-auto border-b p-2">{sheets.map((item, index) => <button type="button" key={index}
      aria-pressed={index === active} onClick={() => setActive(index)} className="whitespace-nowrap rounded border px-3 py-1 text-sm aria-pressed:bg-violet-100 dark:aria-pressed:bg-violet-950">{item.name}</button>)}</div>
    {sheet?.truncated && <p className="p-2 text-xs text-amber-600">{t('attachmentPreview.sheetTruncated')}</p>}
    <div className="flex-1 overflow-auto"><table className="border-collapse text-xs"><tbody>{sheet?.rows.map((row, index) => <tr key={index}>
      <th className="sticky left-0 border bg-neutral-100 px-2 dark:bg-neutral-800">{index + 1}</th>
      {row.map((cell, column) => <td key={column} className="min-w-24 max-w-80 whitespace-pre-wrap break-words border p-2 align-top">{cell}</td>)}
    </tr>)}</tbody></table></div>
  </div>;
}
