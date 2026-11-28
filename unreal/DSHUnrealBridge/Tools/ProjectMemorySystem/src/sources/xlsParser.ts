import * as XLSX from "@e965/xlsx";
import type { SourceBlock } from "../types/memoryTypes.js";

export function parseXls(content: Buffer): { text: string; sheetNames: string[]; blocks: SourceBlock[] } {
  const workbook = XLSX.read(content, {
    type: "buffer",
    bookVBA: false,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    dense: false,
    WTF: true
  });
  const lines: string[] = [];
  const blocks: SourceBlock[] = [];
  for (const name of workbook.SheetNames) {
    lines.push(`# ${name}`);
    const sheet = workbook.Sheets[name];
    if (!sheet?.["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]!);
    if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 2000000) throw new Error(`Worksheet ${name} exceeds the 2 million cell extraction limit.`);
    let headerText: string | undefined, headerRange: string | undefined;
    for (let row = range.s.r; row <= range.e.r; row++) {
      const values: string[] = [];
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
        values.push(cell ? XLSX.utils.format_cell(cell).replace(/\r\n/g, "\n") : "");
      }
      if (!values.some(value => value.trim())) continue;
      const text = values.join("\t"), startColumn = XLSX.utils.encode_col(range.s.c), endColumn = XLSX.utils.encode_col(range.e.c);
      const address = `${startColumn}${row + 1}:${endColumn}${row + 1}`;
      if (headerText === undefined) { headerText = text; headerRange = address; }
      blocks.push({ text, kind: "table", headingPath: [name], location: { kind: "sheet", sheet: name, startRow: row + 1, endRow: row + 1, startColumn, endColumn, range: address, headerRange, headerText } });
      lines.push(text);
    }
  }
  if (!workbook.SheetNames.length) throw new Error("Excel workbook contains no worksheets.");
  return { text: lines.join("\n"), sheetNames: workbook.SheetNames, blocks };
}
