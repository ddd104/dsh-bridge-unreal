import { readFile } from "node:fs/promises";
import { readIndexedDocuments, summarizeMarkdown } from "./documentSummarizer.js";
export async function summarizeProject(loaded, sourcePath) {
    const text = await readFile(sourcePath, "utf8");
    const indexedDocumentCount = (await readIndexedDocuments(loaded)).length;
    return {
        ...summarizeMarkdown(text, loaded.config.projectId),
        indexedDocumentCount
    };
}
