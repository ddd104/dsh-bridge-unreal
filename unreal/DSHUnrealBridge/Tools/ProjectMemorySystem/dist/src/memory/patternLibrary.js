import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceEvidence } from "../summarizers/documentSummarizer.js";
import { extractPatterns } from "../summarizers/patternExtractor.js";
async function markdownFiles(dir) {
    if (!existsSync(dir))
        return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
        .filter((entry) => {
        const name = entry.name.toLowerCase();
        return entry.isFile() && name.endsWith(".md") && name !== "readme.md";
    })
        .map((entry) => path.join(dir, entry.name))
        .sort();
}
export async function writePatternLibrary(loaded) {
    const patternsDir = path.join(loaded.projectRoot, "ProjectKnowledge", "patterns");
    const files = await markdownFiles(patternsDir);
    if (files.length === 0)
        return undefined;
    const patterns = [];
    for (const file of files) {
        const evidence = await sourceEvidence(loaded.projectRoot, [file]);
        const extracted = await extractPatterns(file);
        for (const pattern of extracted) {
            patterns.push({
                ...pattern,
                sourcePaths: evidence.sourcePaths,
                sourceHash: evidence.sourceHash
            });
        }
    }
    const outputPath = path.join(loaded.resolvedMemoryOutputRoot, "patterns", "patterns.jsonl");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${patterns.map((pattern) => JSON.stringify(pattern)).join("\n")}\n`, "utf8");
    const allEvidence = await sourceEvidence(loaded.projectRoot, files);
    return {
        output: {
            path: outputPath,
            sourcePaths: allEvidence.sourcePaths,
            sourceHash: allEvidence.sourceHash
        },
        patterns
    };
}
export function emptyPatternLibrary() {
    return [];
}
