import { parseDocument } from "yaml";
import { sourceLines, textBlocks } from "./textStructure.js";
import type { SourceParseResult } from "./sourceRegistry.js";

const listFields = ["aliases", "tags", "sources", "symbols", "assets", "relatedPages"];
export function parseWiki(raw: string): SourceParseResult {
  const lines = sourceLines(raw), metadata: Record<string, unknown> = {};
  let bodyStart = 0;
  if (lines[0]?.text.replace(/^\uFEFF/, "").trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line.text));
    if (end < 0 || lines[end].start > 65536) throw new Error("Wiki frontmatter must close within 64 KiB.");
    const document = parseDocument(raw.slice(lines[0].end, lines[end].start), { uniqueKeys: true, schema: "core" });
    if (document.errors.length) throw new Error(`Invalid Wiki frontmatter: ${document.errors[0].message.split("\n")[0]}`);
    const value = document.toJS({ maxAliasCount: 0 });
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("Wiki frontmatter must be a mapping.");
    for (const key of ["id", "title", "type", "status"]) if (value?.[key] !== undefined) {
      if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 2048) throw new Error(`Wiki ${key} must be a non-empty string up to 2048 characters.`);
      metadata[key] = value[key].trim();
    }
    if (metadata.id && !/^[\p{L}\p{N}_.:/-]{1,160}$/u.test(String(metadata.id))) throw new Error("Wiki id contains unsupported characters or exceeds 160 characters.");
    if (metadata.status && !["draft", "confirmed", "deprecated"].includes(String(metadata.status))) throw new Error("Wiki status must be draft, confirmed or deprecated.");
    for (const key of listFields) if (value?.[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length > 128 || value[key].some((item: unknown) => typeof item !== "string" || !item.trim() || item.length > 2048)) throw new Error(`Wiki ${key} must be an array of at most 128 non-empty strings.`);
      metadata[key] = [...new Set((value[key] as string[]).map(item => item.trim()))];
    }
    bodyStart = lines[end].end;
  }
  metadata.status ??= "draft";
  for (const key of listFields) metadata[key] ??= [];
  const blocks = textBlocks(raw, bodyStart, true), links: Array<{ target: string; label: string }> = [];
  const definitions = new Map<string, string>();
  for (const block of blocks.filter(block => block.kind !== "code")) {
    for (const match of block.text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) definitions.set(match[1].toLowerCase(), match[2]);
    for (const match of block.text.matchAll(/(?<!!)\[([^\]]+)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) links.push({ label: match[1], target: match[2] ?? match[3] });
  }
  for (const block of blocks.filter(block => block.kind !== "code")) for (const match of block.text.matchAll(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const key = (match[2] || match[1]).toLowerCase();links.push({ label: match[1], target: definitions.get(key) ?? `unresolved-reference:${key}` });
  }
  metadata.links = links;
  metadata.headings = blocks.filter(block => block.kind === "heading").map(block => block.headingPath.at(-1));
  metadata.bodyStart = bodyStart;
  return { sourceType: "markdown", title: typeof metadata.title === "string" ? metadata.title : blocks.find(block => block.kind === "heading")?.headingPath.at(-1), text: raw.slice(bodyStart), metadata, blocks };
}
