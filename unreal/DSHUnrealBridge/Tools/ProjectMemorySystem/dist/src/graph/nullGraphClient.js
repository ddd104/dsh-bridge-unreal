export class NullGraphClient {
    reason;
    constructor(reason = "Project graph integration is not available.") {
        this.reason = reason;
    }
    async isAvailable() {
        return false;
    }
    async status() {
        return {
            mode: "none",
            available: false,
            message: this.reason,
            warnings: [this.reason]
        };
    }
    async findFeatureContext(query, _options) {
        return {
            query,
            nodes: [],
            filesToRead: [],
            blueprintsToRead: [],
            assetsToInspect: [],
            warnings: [this.reason]
        };
    }
    async queryGraph(query) {
        return {
            query,
            nodes: [],
            edges: [],
            warnings: [this.reason]
        };
    }
    async expandContext(seedNodes, _options) {
        return {
            seedNodes,
            nodes: [],
            edges: [],
            filesToRead: [],
            blueprintsToRead: [],
            assetsToInspect: [],
            warnings: [this.reason]
        };
    }
    async impactAnalysis(nodeIds, _options) {
        return {
            nodeIds,
            nodes: [],
            edges: [],
            impactedSystems: [],
            risk: "none",
            warnings: [this.reason]
        };
    }
}
