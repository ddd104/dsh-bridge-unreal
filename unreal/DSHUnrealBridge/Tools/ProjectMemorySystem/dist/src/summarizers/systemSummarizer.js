import path from "node:path";
import { summarizeDocument } from "./documentSummarizer.js";
export async function summarizeSystem(sourcePath) {
    const systemId = path.basename(sourcePath, path.extname(sourcePath));
    return {
        systemId,
        ...(await summarizeDocument(sourcePath, systemId))
    };
}
