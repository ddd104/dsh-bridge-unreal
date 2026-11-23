export class McpGraphClient {
    options;
    constructor(options) {
        this.options = options;
    }
    async isAvailable() {
        return false;
    }
    async status() {
        return {
            mode: "mcp",
            available: false,
            source: this.options.url ?? this.options.serverName,
            message: "Project Graph MCP adapter is configured, but direct MCP invocation is not implemented in Phase 5.",
            warnings: [
                "Use a host-provided MCP bridge in a later phase, or switch graph.mode to sqlite for local read-only graph context."
            ]
        };
    }
    async findFeatureContext(query, _options) {
        return {
            query,
            nodes: [],
            filesToRead: [],
            blueprintsToRead: [],
            assetsToInspect: [],
            warnings: [this.unavailableMessage()]
        };
    }
    async queryGraph(query) {
        return {
            query,
            nodes: [],
            edges: [],
            warnings: [this.unavailableMessage()]
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
            warnings: [this.unavailableMessage()]
        };
    }
    async impactAnalysis(nodeIds, _options) {
        return {
            nodeIds,
            nodes: [],
            edges: [],
            impactedSystems: [],
            risk: "none",
            warnings: [this.unavailableMessage()]
        };
    }
    unavailableMessage() {
        return `Project Graph MCP adapter (${this.options.url ?? this.options.serverName}) is not callable from this Phase 5 implementation.`;
    }
}
