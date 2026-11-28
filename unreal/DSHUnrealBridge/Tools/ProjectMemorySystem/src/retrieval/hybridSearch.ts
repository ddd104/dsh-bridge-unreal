import { existsSync } from "node:fs";
import path from "node:path";
import { readFile, stat, realpath } from "node:fs/promises";
import { FullTextIndex } from "../index/fullTextIndex.js";
import { rerankSearchResults } from "./reranker.js";
import { verifyDocumentSource } from "../commands/readDocument.js";
import { PARSER_VERSION } from "../index/documentChunks.js";
import type { LoadedProjectConfig, MemorySearchResult } from "../types/memoryTypes.js";

export interface HybridSearchResult {
  query: string;
  results: MemorySearchResult[];
  warnings: string[];
}

export async function hybridSearch(query: string, loaded: LoadedProjectConfig, limit = 12): Promise<HybridSearchResult> {
  const ftsPath = path.join(loaded.resolvedMemoryOutputRoot, "index", "fts.sqlite");
  if (!existsSync(ftsPath)) {
    return {
      query,
      results: [],
      warnings: [`Project Memory full-text index not found at ${ftsPath}. Run memory build --docs-only.`]
    };
  }

  const index = FullTextIndex.open(ftsPath);
  try {
    limit = Number.isFinite(limit) ? Math.min(40, Math.max(1, Math.floor(limit))) : 12;
    const candidates = Math.min(100, limit * 8);
    const exact = index.search(query, candidates);
    const resultMap = new Map<string, MemorySearchResult>(exact.map(result => [result.id, result]));
    const exactIds = new Set(resultMap.keys());
    const tokens = [...new Set(query.split(/\s+/).map(token => token.trim()).filter(token => token.length > 1))].slice(0, 16);
    for (const token of tokens) {
      for (const result of index.search(token, candidates)) {
        const existing = resultMap.get(result.id);
        if (!existing || !exactIds.has(result.id) && result.score > existing.score) resultMap.set(result.id, result);
      }
    }
    const warnings: string[] = [], results: MemorySearchResult[] = [];
    // Persist extraction gaps even if an image-only document has no FTS hit.
    const diagnostics = path.join(loaded.resolvedMemoryOutputRoot, "index", "document-warnings.json");
    try {
      const resolved = await realpath(diagnostics);
      if ((process.platform === "win32" ? resolved.toLowerCase() === diagnostics.toLowerCase() : resolved === diagnostics) && (await stat(diagnostics)).size <= 256 * 1024) {
        const saved: unknown = JSON.parse(await readFile(diagnostics, "utf8"));
        if (Array.isArray(saved)) warnings.push(...saved.filter((item): item is string => typeof item === "string").slice(0, 12).map(item => `At index build: ${item.slice(0, 2000)}`));
      }
    } catch { /* Older indexes have no persisted extraction diagnostics. */ }
    const verified = new Map<string, boolean>(), counts = new Map<string, number>();
    if (!index.supportsChunks) warnings.push("index_upgrade_required: Legacy document index remains searchable; explicitly update the base index for chunk citations and source verification.");
    // Full-query matches precede partial matches; do not add unrelated BM25 scores.
    const ordered = rerankSearchResults([...resultMap.values()]).sort((a, b) => Number(exactIds.has(b.id)) - Number(exactIds.has(a.id)));
    for (const result of ordered) {
      const id = result.documentId ?? result.id;
      if ((counts.get(id) ?? 0) >= 2) continue;
      if (index.supportsChunks) {
        if (!verified.has(id)) {
          try {
            const document = index.document(id);
            if (!document || document.parserVersion !== PARSER_VERSION) throw new Error("index_upgrade_required");
            await verifyDocumentSource(loaded, document);
            verified.set(id, true);
          } catch (error) {
            verified.set(id, false);
            warnings.push(`${result.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!verified.get(id)) continue;
        result.sourceStatus = "current";
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
      results.push(result);
      if (results.length >= limit) break;
    }
    return { query, results, warnings };
  } finally {
    index.close();
  }
}
