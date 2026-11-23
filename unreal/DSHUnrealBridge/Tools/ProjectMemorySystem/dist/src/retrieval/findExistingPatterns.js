import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { rerankEvidenceItems } from "./reranker.js";
function scoreText(query, text) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = text.toLowerCase();
    return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}
export async function findExistingPatterns(query, loaded, maxPatterns) {
    const patternsPath = path.join(loaded.resolvedMemoryOutputRoot, "patterns", "patterns.jsonl");
    if (!existsSync(patternsPath))
        return [];
    const lines = (await readFile(patternsPath, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const items = lines.map((line) => {
        const parsed = JSON.parse(line);
        const excerpt = (parsed.summary ?? []).join("\n");
        return {
            id: parsed.id,
            title: parsed.title,
            sourcePaths: parsed.sourcePaths ?? [],
            sourceHash: parsed.sourceHash,
            excerpt,
            score: scoreText(query, `${parsed.title} ${excerpt}`),
            status: parsed.status
        };
    });
    return rerankEvidenceItems(items.filter((item) => (item.score ?? 0) > 0 || item.sourcePaths.length > 0)).slice(0, maxPatterns);
}
