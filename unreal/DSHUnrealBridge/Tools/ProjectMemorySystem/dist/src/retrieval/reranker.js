function evidenceBoost(sourcePaths, sourceHash) {
    return (sourcePaths && sourcePaths.length > 0 ? 2 : 0) + (sourceHash ? 1 : 0);
}
function pathPriority(pathValue) {
    if (/ProjectKnowledge\/systems\//i.test(pathValue))
        return 8;
    if (/ProjectKnowledge\/patterns\//i.test(pathValue))
        return 7;
    if (/ProjectKnowledge\/architecture\//i.test(pathValue))
        return 6;
    if (/ProjectKnowledge\/overview\//i.test(pathValue))
        return 5;
    return 0;
}
export function rerankSearchResults(results) {
    return [...results].sort((a, b) => {
        const aScore = a.score;
        const bScore = b.score;
        return bScore - aScore || a.path.localeCompare(b.path);
    });
}
export function rerankEvidenceItems(items) {
    return [...items].sort((a, b) => {
        const aPath = a.sourcePaths[0] ?? "";
        const bPath = b.sourcePaths[0] ?? "";
        const aScore = (a.score ?? 0) + pathPriority(aPath) + evidenceBoost(a.sourcePaths, a.sourceHash);
        const bScore = (b.score ?? 0) + pathPriority(bPath) + evidenceBoost(b.sourcePaths, b.sourceHash);
        return bScore - aScore || a.title.localeCompare(b.title);
    });
}
export function rerankResults(results) {
    return rerankSearchResults(results);
}
