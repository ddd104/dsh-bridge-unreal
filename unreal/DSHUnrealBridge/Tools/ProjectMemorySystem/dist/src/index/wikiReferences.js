import path from "node:path";
import { realpath, stat } from "node:fs/promises";
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
function anchors(document) {
    const counts = new Map(), result = new Set();
    for (const title of (document.metadata.headings ?? [])) {
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s/g, "-");
        const count = counts.get(slug) ?? 0;
        counts.set(slug, count + 1);
        result.add(count ? `${slug}-${count}` : slug);
    }
    return result;
}
export async function resolveWikiReferences(projectRoot, documents) {
    const ids = new Map(), paths = new Map(documents.map(doc => [pathKey(doc.path), doc]));
    const warnings = [];
    for (const document of documents) {
        const old = ids.get(document.id);
        if (old)
            throw Object.assign(new Error(`Duplicate Wiki document identity: ${old.path} and ${document.path}. Give pages distinct explicit ids.`), { code: "duplicate_document_id" });
        ids.set(document.id, document);
    }
    const wikiIds = new Map(documents.filter(doc => typeof doc.metadata.id === "string").map(doc => [String(doc.metadata.id), doc]));
    for (const document of documents) {
        if (document.sourceType !== "markdown")
            continue;
        const references = [];
        for (const [kind, entries] of [
            ["link", (document.metadata.links ?? []).map(link => link.target)],
            ["source", document.metadata.sources ?? []], ["page", document.metadata.relatedPages ?? []],
            ["symbol", document.metadata.symbols ?? []], ["asset", document.metadata.assets ?? []]
        ])
            for (const target of entries) {
                const result = { kind, target };
                references.push(result);
                if (kind === "symbol" || kind === "asset") {
                    result.status = "unverified";
                    result.reason = kind === "asset" ? "requires_ue_snapshot" : "requires_symbol_lookup";
                    continue;
                }
                if (/^https?:\/\//i.test(target)) {
                    result.status = "external";
                    continue;
                }
                let decoded;
                try {
                    decoded = decodeURIComponent(target);
                }
                catch {
                    result.status = "invalid";
                    continue;
                }
                const [file, anchor] = decoded.split("#", 2);
                let page = kind === "page" ? wikiIds.get(file) : undefined;
                if ((!page && /^[a-z][a-z0-9+.-]*:/i.test(decoded)) || decoded.includes("\0")) {
                    result.status = "invalid";
                    continue;
                }
                const absolute = page ? path.join(projectRoot, page.path) : file ? path.resolve(kind === "source" ? projectRoot : path.dirname(path.join(projectRoot, document.path)), file) : path.join(projectRoot, document.path);
                if (!inside(projectRoot, absolute)) {
                    result.status = "outside_project";
                    continue;
                }
                try {
                    const resolved = await realpath(absolute);
                    if (!inside(projectRoot, resolved) || !((await stat(resolved)).isFile())) {
                        result.status = "invalid";
                        continue;
                    }
                    const relative = path.relative(projectRoot, resolved).replaceAll("\\", "/");
                    page ??= paths.get(pathKey(relative));
                    result.path = relative;
                    result.status = "resolved";
                    if (page)
                        result.documentId = page.id;
                    if (anchor && page && !anchors(page).has(anchor))
                        result.status = "missing_anchor";
                    if (anchor && !page)
                        result.status = "unverified";
                    if (kind === "page" && !page)
                        result.status = "unindexed_page";
                }
                catch {
                    result.status = "missing";
                }
            }
        document.metadata.references = references;
        const invalid = references.filter(ref => !["resolved", "external", "unverified"].includes(String(ref.status)));
        if (invalid.length)
            warnings.push(`${document.path}: ${invalid.length} unresolved Wiki reference(s); see metadata.references.`);
    }
    return warnings;
}
