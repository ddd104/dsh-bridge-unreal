import path from "node:path";
import { summarizeDocument } from "./documentSummarizer.js";
export async function extractPatterns(sourcePath) {
    const id = path.basename(sourcePath, path.extname(sourcePath));
    const summary = await summarizeDocument(sourcePath, id);
    return [
        {
            id,
            title: summary.title,
            status: summary.status,
            summary: summary.bullets
        }
    ];
}
