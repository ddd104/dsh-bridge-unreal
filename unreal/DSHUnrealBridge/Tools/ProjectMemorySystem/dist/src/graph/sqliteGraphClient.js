import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
function parseMetadata(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function rowToNode(row, score) {
    return {
        id: row.id,
        type: row.type,
        name: row.name,
        path: row.path,
        system: row.system,
        language: row.language,
        summary: row.summary,
        metadata: parseMetadata(row.metadata),
        score
    };
}
function rowToEdge(row) {
    return {
        from: row.from_id,
        to: row.to_id,
        type: row.type,
        metadata: parseMetadata(row.metadata)
    };
}
function classifyNodePaths(nodes) {
    return {
        filesToRead: [...new Set(nodes.filter((node) => node.type === "File").map((node) => node.path).filter(Boolean))],
        blueprintsToRead: [...new Set(nodes.filter((node) => node.type === "Blueprint").map((node) => node.path).filter(Boolean))],
        assetsToInspect: [
            ...new Set(nodes
                .filter((node) => ["Asset", "Material", "DataAsset", "Widget", "Level"].includes(node.type))
                .map((node) => node.path)
                .filter(Boolean))
        ]
    };
}
export class SqliteGraphClient {
    sqlitePath;
    constructor(sqlitePath) {
        this.sqlitePath = sqlitePath;
    }
    async isAvailable() {
        if (!existsSync(this.sqlitePath))
            return false;
        try {
            const db = this.open();
            db.prepare("SELECT count(*) AS count FROM nodes").get();
            db.close();
            return true;
        }
        catch {
            return false;
        }
    }
    async status() {
        if (!existsSync(this.sqlitePath)) {
            return {
                mode: "sqlite",
                available: false,
                source: this.sqlitePath,
                message: `Project graph sqlite database not found: ${this.sqlitePath}`,
                warnings: [`Project graph sqlite database not found: ${this.sqlitePath}`]
            };
        }
        try {
            const db = this.open();
            const nodeCount = db.prepare("SELECT count(*) AS count FROM nodes").get().count;
            const edgeCount = db.prepare("SELECT count(*) AS count FROM edges").get().count;
            db.close();
            return {
                mode: "sqlite",
                available: true,
                source: this.sqlitePath,
                nodeCount,
                edgeCount,
                message: "Project graph sqlite database is available.",
                warnings: []
            };
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                mode: "sqlite",
                available: false,
                source: this.sqlitePath,
                message: `Project graph sqlite database could not be read: ${reason}`,
                warnings: [reason]
            };
        }
    }
    async findFeatureContext(query, options = {}) {
        const result = await this.queryGraph({ text: query, limit: options.limit ?? 8 });
        const owningSystem = result.nodes[0]?.system;
        const paths = classifyNodePaths(result.nodes);
        return {
            query,
            owningSystem,
            nodes: result.nodes,
            ...paths,
            warnings: result.warnings
        };
    }
    async queryGraph(query) {
        const db = this.open();
        try {
            const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
            const nodes = query.nodeIds && query.nodeIds.length > 0
                ? this.nodesById(db, query.nodeIds, limit)
                : this.searchNodes(db, query.text ?? "", limit);
            const nodeIds = nodes.map((node) => node.id);
            const edges = this.edgesFor(db, nodeIds, "both", limit * 4);
            return {
                query,
                nodes,
                edges,
                warnings: []
            };
        }
        finally {
            db.close();
        }
    }
    async expandContext(seedNodes, options = {}) {
        const db = this.open();
        try {
            const limit = Math.max(1, Math.min(options.limit ?? 80, 500));
            const depth = Math.max(0, Math.min(options.depth ?? 1, 3));
            const visited = new Set();
            let frontier = [...seedNodes];
            const edges = [];
            for (let level = 0; level <= depth; level += 1) {
                for (const id of frontier)
                    visited.add(id);
                if (level === depth)
                    break;
                const frontierEdges = this.edgesFor(db, frontier, "both", limit);
                edges.push(...frontierEdges);
                frontier = frontierEdges
                    .flatMap((edge) => [edge.from, edge.to])
                    .filter((id) => !visited.has(id))
                    .slice(0, limit);
            }
            const nodes = this.nodesById(db, [...visited], limit);
            const paths = classifyNodePaths(nodes);
            return {
                seedNodes,
                nodes,
                edges,
                ...paths,
                warnings: []
            };
        }
        finally {
            db.close();
        }
    }
    async impactAnalysis(nodeIds, options = {}) {
        const db = this.open();
        try {
            const limit = Math.max(1, Math.min(options.limit ?? 80, 500));
            const direction = options.direction ?? "both";
            const edges = this.edgesFor(db, nodeIds, direction, limit);
            const ids = [...new Set([...nodeIds, ...edges.flatMap((edge) => [edge.from, edge.to])])];
            const nodes = this.nodesById(db, ids, limit);
            const impactedSystems = [...new Set(nodes.map((node) => node.system).filter(Boolean))].sort();
            return {
                nodeIds,
                nodes,
                edges,
                impactedSystems,
                risk: edges.length === 0 ? "none" : edges.length < 10 ? "low" : edges.length < 50 ? "medium" : "high",
                warnings: []
            };
        }
        finally {
            db.close();
        }
    }
    open() {
        return new DatabaseSync(this.sqlitePath, { readOnly: true });
    }
    nodesById(db, ids, limit) {
        if (ids.length === 0)
            return [];
        const statement = db.prepare("SELECT * FROM nodes WHERE id = ?");
        const nodes = [];
        for (const id of ids.slice(0, limit)) {
            const row = statement.get(id);
            if (row)
                nodes.push(rowToNode(row));
        }
        return nodes;
    }
    searchNodes(db, text, limit) {
        const tokens = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
        if (tokens.length === 0)
            return [];
        const rows = db.prepare("SELECT * FROM nodes").all();
        return rows
            .map((row) => {
            const haystack = `${row.name} ${row.path} ${row.system} ${row.summary}`.toLowerCase();
            const score = tokens.reduce((value, token) => value + (haystack.includes(token) ? 1 : 0), 0);
            return { row, score };
        })
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path))
            .slice(0, limit)
            .map((item) => rowToNode(item.row, item.score));
    }
    edgesFor(db, nodeIds, direction, limit) {
        if (nodeIds.length === 0)
            return [];
        const edges = [];
        const incoming = db.prepare("SELECT from_id, to_id, type, metadata FROM edges WHERE to_id = ? LIMIT ?");
        const outgoing = db.prepare("SELECT from_id, to_id, type, metadata FROM edges WHERE from_id = ? LIMIT ?");
        for (const nodeId of nodeIds) {
            if (direction === "in" || direction === "both") {
                edges.push(...(incoming.all(nodeId, limit).map(rowToEdge)));
            }
            if (direction === "out" || direction === "both") {
                edges.push(...(outgoing.all(nodeId, limit).map(rowToEdge)));
            }
        }
        const seen = new Set();
        return edges.filter((edge) => {
            const key = `${edge.from}\0${edge.type}\0${edge.to}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        }).slice(0, limit);
    }
}
