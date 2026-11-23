import { hybridSearch } from "./hybridSearch.js";
export async function findRelevantDocs(query, loaded, maxDocs) {
    const result = await hybridSearch(query, loaded, maxDocs * 3);
    return {
        docs: result.results.slice(0, maxDocs),
        warnings: result.warnings
    };
}
