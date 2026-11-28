import zlib from "node:zlib";
import { parseProto } from "./protoParser.js";
import { parseXls } from "./xlsParser.js";
import type { SourceBlock } from "../types/memoryTypes.js";

export interface SourceParseResult {
  sourceType: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
  blocks?: SourceBlock[];
}

export interface SourceProvider {
  id: string;
  label: string;
  extensions: string[];
  phase: "docs-index";
  describe(): string;
  parse(filePath: string, content: Buffer): Promise<SourceParseResult>;
}

export class SourceRegistry {
  private readonly providers = new Map<string, SourceProvider>();

  register(provider: SourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Source provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  list(): SourceProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): SourceProvider | undefined {
    return this.providers.get(id);
  }

  findByExtension(extension: string): SourceProvider | undefined {
    const normalized = extension.toLowerCase();
    return this.list().find((provider) => provider.extensions.includes(normalized));
  }
}

export function createSourceProvider(id: string, label: string, extensions: string[]): SourceProvider {
  return {
    id,
    label,
    extensions,
    phase: "docs-index",
    describe: () => `${label} source provider.`,
    parse: async (_filePath, content) => ({
      sourceType: id,
      text: content.toString("utf8"),
      metadata: {}
    })
  };
}

function decodeXml(value: string): string {
  const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  return value.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, (_match, code: string) =>
    code[0] === "#" ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)) : entities[code]);
}

function inflateZipEntry(buffer: Buffer, fileName: string, compressionMethod: number, dataStart: number, compressedSize: number): Buffer | undefined {
  if (fileName !== "word/document.xml") return undefined;
  const dataEnd = dataStart + compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) return undefined;
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (compressionMethod === 0) {
    if (compressedSize > 32 * 1024 * 1024) throw new Error("DOCX document part exceeds 32 MiB.");
    return Buffer.from(compressed);
  }
  if (compressionMethod === 8) {
    try {
      return zlib.inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to inflate ${fileName}: ${reason}`);
    }
  }
  return undefined;
}

function readZipEntriesFromCentralDirectory(buffer: Buffer): Map<string, Buffer> | undefined {
  const entries = new Map<string, Buffer>();
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return undefined;

  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8").replace(/\\/g, "/");

    if (localHeaderOffset + 30 <= buffer.length && buffer.readUInt32LE(localHeaderOffset) === 0x04034b50) {
      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const data = inflateZipEntry(buffer, fileName, compressionMethod, dataStart, compressedSize);
      if (data) entries.set(fileName, data);
    }

    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  return entries.size > 0 ? entries : undefined;
}

function readZipEntriesFromLocalHeaders(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const dataStart = fileNameStart + fileNameLength + extraLength;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8");
    const data = inflateZipEntry(buffer, fileName, compressionMethod, dataStart, compressedSize);

    if (data) entries.set(fileName.replace(/\\/g, "/"), data);
    offset = dataStart + compressedSize;
  }

  return entries;
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  return readZipEntriesFromCentralDirectory(buffer) ?? readZipEntriesFromLocalHeaders(buffer);
}

function parseDocx(content: Buffer): SourceParseResult {
  const entries = readZipEntries(content), documentXml = entries.get("word/document.xml");
  if (!documentXml) throw new Error("DOCX has no word/document.xml.");
  const blocks: SourceBlock[] = [], headingPath: string[] = [];
  let paragraph = 0;
  for (const match of documentXml.toString("utf8").matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    paragraph++;
    const xml = match[0];
    const parts = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/?>/g)].map(part => part[1] !== undefined ? decodeXml(part[1]) : part[2] === "tab" ? "\t" : "\n");
    const text = parts.join("");
    const style = /<w:pStyle\b[^>]*w:val=["']([^"']+)/.exec(xml)?.[1];
    const outline = /<w:outlineLvl\b[^>]*w:val=["']([0-8])/.exec(xml)?.[1];
    const heading = style ? /^(?:Heading|标题)\s*([1-9])$/i.exec(style) : null;
    const level = heading ? Number(heading[1]) : outline !== undefined ? Number(outline) + 1 : 0;
    if (!text.trim()) continue;
    if (level) { headingPath.length = level - 1; headingPath[level - 1] = text; }
    blocks.push({ text, kind: level ? "heading" : "paragraph", headingPath: headingPath.filter(Boolean), location: { kind: "docx", part: "word/document.xml", startParagraph: paragraph, endParagraph: paragraph, textStart: 0, textEnd: text.length } });
  }
  return { sourceType: "docx", text: blocks.map(block => block.text).join("\n"), metadata: { paragraphCount: paragraph }, blocks };
}

export function createDefaultSourceRegistry(): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register({ id: "pdf", label: "Text PDF", extensions: [".pdf"], phase: "docs-index",
    describe: () => "PDF text with physical page citations; image-only pages need OCR.",
    parse: async (filePath, content) => (await import("./pdfParser.js")).parsePdf(filePath, content) });
  registry.register({
    id: "proto",
    label: "Protocol Buffers schema",
    extensions: [".proto"],
    phase: "docs-index",
    describe: () => "Protocol Buffers declarations, fields, enums, services and original source.",
    parse: async (filePath, content) => ({ sourceType: "proto", ...parseProto(filePath, content) })
  });
  registry.register({
    id: "xls",
    label: "Legacy Excel workbook",
    extensions: [".xls"],
    phase: "docs-index",
    describe: () => "Legacy Excel worksheets and cell values.",
    parse: async (_filePath, content) => {
      const parsed = parseXls(content);
      return { sourceType: "xls", text: parsed.text, metadata: { sheetNames: parsed.sheetNames }, blocks: parsed.blocks };
    }
  });
  registry.register({
    id: "docx",
    label: "Word document",
    extensions: [".docx"],
    phase: "docs-index",
    describe: () => "Word document source provider.",
    parse: async (_filePath, content) => parseDocx(content)
  });
  registry.register({
    id: "xlsx",
    label: "Excel workbook",
    extensions: [".xlsx"],
    phase: "docs-index",
    describe: () => "Excel workbook source provider.",
    parse: async (_filePath, content) => {
      const parsed = parseXls(content);
      return { sourceType: "xlsx", text: parsed.text, metadata: { sheetNames: parsed.sheetNames }, blocks: parsed.blocks };
    }
  });
  return registry;
}
