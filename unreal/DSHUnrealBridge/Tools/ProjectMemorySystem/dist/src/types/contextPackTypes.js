export const DEFAULT_CONTEXT_BUDGET = {
    maxDocs: 8,
    maxSystems: 4,
    maxPatterns: 5,
    maxGraphNodes: 16,
    maxFiles: 12,
    maxBlueprints: 8,
    maxAssets: 8,
    maxImplementations: 5,
    maxReusableSymbols: 12
};
export function resolveContextBudget(budget) {
    return {
        ...DEFAULT_CONTEXT_BUDGET,
        ...budget
    };
}
