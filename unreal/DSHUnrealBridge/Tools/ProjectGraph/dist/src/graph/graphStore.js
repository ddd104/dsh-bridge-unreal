import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertEdgeRecord, assertNodeRecord } from "./schema.js";
export function toProjectPath(value) {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
export function makeSafeId(value) {
    return toProjectPath(value).replace(/[^A-Za-z0-9_:/.-]+/g, "_");
}
export function fileNodeId(relativePath) {
    return `file:${makeSafeId(relativePath)}`;
}
export function symbolNodeId(type, name, scope) {
    return `${type.toLowerCase()}:${makeSafeId(scope)}:${makeSafeId(name)}`;
}
export function createFileNode(relativePath, system, language, summary) {
    const normalizedPath = toProjectPath(relativePath);
    return {
        id: fileNodeId(normalizedPath),
        type: "File",
        name: path.posix.basename(normalizedPath),
        path: normalizedPath,
        system,
        language,
        summary: summary ?? `${language} file ${normalizedPath}`,
        metadata: {}
    };
}
function normalizeNode(node) {
    return {
        ...node,
        path: toProjectPath(node.path),
        metadata: node.metadata ?? {}
    };
}
function edgeKey(edge) {
    return `${edge.from}\u0000${edge.type}\u0000${edge.to}\u0000${JSON.stringify(edge.metadata ?? {})}`;
}
export class GraphStore {
    nodeMap = new Map();
    edgeMap = new Map();
    addNode(node) {
        const normalized = normalizeNode(node);
        assertNodeRecord(normalized);
        const existing = this.nodeMap.get(normalized.id);
        if (!existing) {
            this.nodeMap.set(normalized.id, normalized);
            return normalized;
        }
        const merged = {
            ...existing,
            ...normalized,
            summary: normalized.summary || existing.summary,
            metadata: {
                ...existing.metadata,
                ...normalized.metadata
            }
        };
        this.nodeMap.set(merged.id, merged);
        return merged;
    }
    addEdge(edge) {
        const normalized = {
            ...edge,
            metadata: edge.metadata ?? {}
        };
        assertEdgeRecord(normalized);
        this.edgeMap.set(edgeKey(normalized), normalized);
        return normalized;
    }
    getNode(id) {
        return this.nodeMap.get(id);
    }
    nodes() {
        return [...this.nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    edges() {
        return [...this.edgeMap.values()].sort((a, b) => {
            const from = a.from.localeCompare(b.from);
            if (from !== 0)
                return from;
            const type = a.type.localeCompare(b.type);
            if (type !== 0)
                return type;
            return a.to.localeCompare(b.to);
        });
    }
    outgoing(nodeId) {
        return this.edges().filter((edge) => edge.from === nodeId);
    }
    incoming(nodeId) {
        return this.edges().filter((edge) => edge.to === nodeId);
    }
    adjacent(nodeId) {
        return this.edges().filter((edge) => edge.from === nodeId || edge.to === nodeId);
    }
    findNodesByPath(relativePath) {
        const normalized = toProjectPath(relativePath);
        return this.nodes().filter((node) => node.path === normalized);
    }
    async writeJsonl(outputDir) {
        await mkdir(outputDir, { recursive: true });
        const nodesPath = path.join(outputDir, "nodes.jsonl");
        const edgesPath = path.join(outputDir, "edges.jsonl");
        await writeFile(nodesPath, this.nodes().map((node) => JSON.stringify(node)).join("\n") + "\n", "utf8");
        await writeFile(edgesPath, this.edges().map((edge) => JSON.stringify(edge)).join("\n") + "\n", "utf8");
        return { nodesPath, edgesPath };
    }
    static async loadJsonl(inputDir) {
        const store = new GraphStore();
        const nodesPath = path.join(inputDir, "nodes.jsonl");
        const edgesPath = path.join(inputDir, "edges.jsonl");
        const nodesText = await readFile(nodesPath, "utf8");
        for (const line of nodesText.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const node = JSON.parse(line);
            store.addNode(node);
        }
        const edgesText = await readFile(edgesPath, "utf8");
        for (const line of edgesText.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const edge = JSON.parse(line);
            store.addEdge(edge);
        }
        return store;
    }
}
