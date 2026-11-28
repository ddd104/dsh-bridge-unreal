import { DatabaseSync } from "node:sqlite";
import { chunkDocument, chunkPolicy } from "./documentChunks.js";
import { textBlocks } from "../sources/textStructure.js";
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const han = /[\p{Script=Han}]+/gu;
const term = (value) => `h${[...value].map(char => char.codePointAt(0).toString(16)).join("x")}`;
function pairs(value) { const chars = [...value]; return chars.slice(1).map((_char, i) => term(chars[i] + chars[i + 1])); }
function hanTerms(value) {
    return [...value.matchAll(han)].map(match => [...pairs(match[0]), ...[...match[0]].map(term)].join(" ")).join(" boundary ");
}
function queryTerms(query) {
    return (query.normalize("NFC").match(/[\p{Script=Han}]+|[^\p{Script=Han}\s]+/gu) ?? []).filter(value => /[\p{L}\p{N}]/u.test(value)).map(value => /^[\p{Script=Han}]+$/u.test(value) ? `terms:${quote([...value].length > 1 ? pairs(value).join(" ") : term(value))}` : `{title text metadataText}: ${quote(value)}`).join(" AND ");
}
function searchMetadata(document) {
    return [document.path, ...["aliases", "tags", "sources", "symbols", "assets", "relatedPages", "messages", "enums", "services"].flatMap(key => Array.isArray(document.metadata[key]) ? document.metadata[key] : [])].join(" ");
}
export class FullTextIndex {
    db;
    constructor(db) {
        this.db = db;
    }
    static create(databasePath) {
        const index = new FullTextIndex(new DatabaseSync(databasePath));
        index.initialize();
        return index;
    }
    static open(databasePath) { return new FullTextIndex(new DatabaseSync(databasePath, { readOnly: true })); }
    get supportsChunks() { return !!this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'knowledge_chunks'").get(); }
    initialize() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT NOT NULL, sourceType TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, modifiedAt TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_records (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_chunks (id TEXT PRIMARY KEY, documentId TEXT NOT NULL, ordinal INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_by_document ON knowledge_chunks(documentId, ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, title, text, metadataText, terms, tokenize='unicode61');
    `);
    }
    replaceAll(documents) {
        this.db.exec("BEGIN");
        try {
            this.db.exec("DELETE FROM documents; DELETE FROM document_records; DELETE FROM knowledge_chunks; DELETE FROM chunks_fts;");
            const docInsert = this.db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)"), recordInsert = this.db.prepare("INSERT INTO document_records VALUES (?, ?)");
            const chunkInsert = this.db.prepare("INSERT INTO knowledge_chunks VALUES (?, ?, ?, ?)"), ftsInsert = this.db.prepare("INSERT INTO chunks_fts VALUES (?, ?, ?, ?, ?)");
            for (const document of documents) {
                const { chunks: _chunks, ...record } = document;
                docInsert.run(document.id, document.path, document.sourceType, document.title, document.hash, document.modifiedAt, JSON.stringify(document.metadata));
                recordInsert.run(document.id, JSON.stringify(record));
                const chunks = document.chunks ?? chunkDocument(document.id, textBlocks(document.text), chunkPolicy(), document.text);
                const metadata = searchMetadata(document);
                for (const chunk of chunks) {
                    chunkInsert.run(chunk.chunkId, document.id, chunk.ordinal, JSON.stringify(chunk));
                    const title = [document.title, ...chunk.headingPath].join(" / ");
                    ftsInsert.run(chunk.chunkId, title, chunk.text, metadata, hanTerms([title, chunk.text, metadata].join("\n").normalize("NFC")));
                }
            }
            this.db.exec("PRAGMA user_version = 2; COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    document(id) {
        if (!this.supportsChunks)
            throw Object.assign(new Error("This index predates document/chunk citations; explicitly update the base index."), { code: "index_upgrade_required" });
        const row = this.db.prepare("SELECT record FROM document_records WHERE id = ?").get(id);
        return row ? JSON.parse(row.record) : undefined;
    }
    chunk(id) {
        if (!this.supportsChunks)
            throw Object.assign(new Error("This index predates chunk citations; explicitly update the base index."), { code: "index_upgrade_required" });
        const row = this.db.prepare("SELECT record FROM knowledge_chunks WHERE id = ?").get(id);
        return row ? JSON.parse(row.record) : undefined;
    }
    chunks(documentId, offset = 0, limit = 20) {
        return this.db.prepare("SELECT record FROM knowledge_chunks WHERE documentId = ? ORDER BY ordinal LIMIT ? OFFSET ?").all(documentId, limit, offset).map(row => JSON.parse(row.record));
    }
    chunkCount(documentId) { return Number(this.db.prepare("SELECT count(*) AS count FROM knowledge_chunks WHERE documentId = ?").get(documentId)?.count ?? 0); }
    search(query, limit = 10) {
        limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 10;
        if (!this.supportsChunks)
            return this.legacySearch(query, limit);
        const match = queryTerms(query);
        if (!match)
            return [];
        const rows = this.db.prepare(`SELECT c.record AS chunk, d.record AS document, bm25(chunks_fts, 0, 3, 1, 2, 1) AS score
      FROM chunks_fts JOIN knowledge_chunks c ON c.id = chunks_fts.id JOIN document_records d ON d.id = c.documentId
      WHERE chunks_fts MATCH ? ORDER BY score, c.id LIMIT ?`).all(match, limit);
        return rows.map(row => {
            const chunk = JSON.parse(row.chunk), document = JSON.parse(row.document);
            const needle = (query.match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []).find(word => chunk.text.toLowerCase().includes(word.toLowerCase()));
            const start = needle ? Math.max(0, chunk.text.toLowerCase().indexOf(needle.toLowerCase()) - 120) : 0;
            return { id: chunk.chunkId, chunkId: chunk.chunkId, documentId: document.id, path: document.path, title: document.title, sourceType: document.sourceType, score: -row.score,
                excerpt: chunk.text.slice(start, start + 900), sourceHash: document.hash, chunkHash: chunk.chunkHash, parserVersion: chunk.parserVersion, headingPath: chunk.headingPath, location: chunk.location, metadata: document.metadata };
        });
    }
    legacySearch(query, limit) {
        const match = query.split(/\s+/).filter(Boolean).map(quote).join(" ");
        if (!match)
            return [];
        return this.db.prepare(`SELECT id, path, sourceType, title, snippet(documents_fts, 4, '[', ']', '...', 24) AS excerpt, -bm25(documents_fts) AS score FROM documents_fts WHERE documents_fts MATCH ? ORDER BY score DESC LIMIT ?`).all(match, limit);
    }
    close() { this.db.close(); }
}
