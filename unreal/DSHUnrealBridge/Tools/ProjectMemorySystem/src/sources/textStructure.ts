import type { SourceBlock, SourceLocation } from "../types/memoryTypes.js";

export function sourceLines(raw: string): Array<{ text: string; start: number; end: number; number: number }> {
  const result = []; const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of raw.matchAll(re)) {
    if (!match[0]) continue;
    result.push({ text: match[0].replace(/[\r\n]+$/, ""), start: match.index!, end: match.index! + match[0].length, number: result.length + 1 });
  }
  return result;
}

export function createLineLocator(raw: string): (start: number, end: number) => SourceLocation {
  const starts = [0];
  for (const match of raw.matchAll(/\r\n|\r|\n/g)) starts.push(match.index! + match[0].length);
  const lineAt = (offset: number) => {
    let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid + 1; else high = mid; }
    return low;
  };
  return (startOffset, endOffset) => ({ kind: "lines", startOffset, endOffset, startLine: lineAt(startOffset), endLine: lineAt(Math.max(startOffset, endOffset - 1)) });
}

/** Offsets refer to the decoded original, including BOM and CRLF; no cleaned-text line numbers. */
export function textBlocks(raw: string, startOffset = 0, markdown = false): SourceBlock[] {
  const lines = sourceLines(raw).filter(line => line.start >= startOffset), blocks: SourceBlock[] = [];
  const locate = createLineLocator(raw);
  const headings: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].text.trim()) { i++; continue; }
    const start = i, line = lines[i].text;
    const heading = markdown ? /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.replace(/^\uFEFF/, "")) : null;
    const setext = markdown && i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1].text);
    let kind: SourceBlock["kind"] = "paragraph";
    if (heading || setext) {
      const level = heading ? heading[1].length : lines[i + 1].text.trim()[0] === "=" ? 1 : 2;
      headings.length = level - 1; headings[level - 1] = heading ? heading[2] : line.trim();
      kind = "heading"; i += heading ? 1 : 2;
    } else {
      const fence = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(line) : null;
      if (fence) {
        kind = "code"; i++;
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
        while (i < lines.length) { const done = close.test(lines[i++].text); if (done) break; }
      } else {
        kind = markdown && /^\s*(?:[-+*]|\d+[.)])\s/.test(line) ? "list" : markdown && line.includes("|") ? "table" : "paragraph";
        i++;
        while (i < lines.length && lines[i].text.trim()) {
          if (markdown && (/^ {0,3}(?:#{1,6}\s|`{3,}|~{3,})/.test(lines[i].text) || i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1].text))) break;
          i++;
        }
      }
    }
    const begin = lines[start].start, end = lines[i - 1].end;
    blocks.push({ text: raw.slice(begin, end), kind, headingPath: headings.filter(Boolean), location: locate(begin, end) });
  }
  return blocks;
}
