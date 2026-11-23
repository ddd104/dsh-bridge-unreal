import path from "node:path";
import { GraphStore } from "../graph/graphStore.js";
import { buildContextPack } from "../graph/contextPack.js";
export async function getContextPack(nodeId, options) {
    const graphDir = path.resolve(options.projectRoot, options.graphDir ?? "Plugins/DSHUnrealBridge/Cache/Graph");
    const store = await GraphStore.loadJsonl(graphDir);
    return buildContextPack(store, nodeId, {
        projectRoot: options.projectRoot,
        depth: options.depth ?? 1
    });
}
