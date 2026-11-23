import path from "node:path";
import { McpGraphClient } from "./mcpGraphClient.js";
import { NullGraphClient } from "./nullGraphClient.js";
import { SqliteGraphClient } from "./sqliteGraphClient.js";
function graphConfigValue(config, key) {
    const graph = config.graph;
    const value = graph[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}
export function createProjectGraphClient(loaded) {
    if (!loaded.config.graph.enabled) {
        return new NullGraphClient("Project graph is disabled in ProjectMemory.project.json.");
    }
    if (loaded.config.graph.mode === "sqlite") {
        const sqlitePath = graphConfigValue(loaded.config, "sqlitePath") ??
            loaded.config.graph.sqlite?.databasePath ??
            "Plugins/DSHUnrealBridge/Cache/Graph/project_graph.sqlite";
        return new SqliteGraphClient(path.resolve(loaded.projectRoot, sqlitePath));
    }
    if (loaded.config.graph.mode === "mcp") {
        const serverName = graphConfigValue(loaded.config, "mcpServerName") ??
            loaded.config.graph.mcp?.serverName ??
            "ue_project_graph";
        const url = graphConfigValue(loaded.config, "url") ?? graphConfigValue(loaded.config, "mcpUrl");
        return new McpGraphClient({ serverName, url });
    }
    return new NullGraphClient("Unsupported project graph mode.");
}
