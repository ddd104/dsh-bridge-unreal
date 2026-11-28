import { createHash } from "node:crypto";
import { createLineLocator } from "../sources/textStructure.js";
export const DOCUMENT_INDEX_VERSION = 2;
export const PARSER_VERSION = "wiki-documents-3-pdf";
export const CHUNKER_VERSION = "structure-1";
export const hashText = (text) => createHash("sha256").update(text).digest("hex");
export function chunkPolicy(config) {
    const value = config?.memory?.chunking;
    const targetChars = value?.targetChars ?? 1800, overlapChars = value?.overlapChars ?? 180, maxChars = value?.maxChars ?? targetChars * 2;
    if (!Number.isInteger(targetChars) || targetChars < 32 || targetChars > 32000 || !Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= targetChars || !Number.isInteger(maxChars) || maxChars < targetChars || maxChars > 64000)
        throw new Error("Invalid memory.chunking: targetChars 32..32000, overlapChars 0..<targetChars, maxChars targetChars..64000 required.");
    return { targetChars, overlapChars, maxChars };
}
export const policyFingerprint = (policy) => hashText(JSON.stringify([PARSER_VERSION, CHUNKER_VERSION, policy]));
export function documentIdentity(projectRoot, relativePath, wikiId) {
    const root = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
    const file = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    return `doc-${hashText(`${root.replaceAll("\\", "/")}\n${wikiId ? `wiki:${wikiId}` : `path:${file}`}`).slice(0, 32)}`;
}
function mergeLocation(first, last) {
    if (first.kind === "pdf" && last.kind === "pdf" && first.page === last.page)
        return { ...first, textEnd: last.textEnd };
    if (first.kind === "lines" && last.kind === "lines")
        return { ...first, endLine: last.endLine, endOffset: last.endOffset };
    if (first.kind === "docx" && last.kind === "docx")
        return { ...first, endParagraph: last.endParagraph, textEnd: last.textEnd };
    if (first.kind === "sheet" && last.kind === "sheet")
        return { ...first, endRow: last.endRow, range: `${first.startColumn}${first.startRow}:${last.endColumn}${last.endRow}`, textEnd: last.textEnd };
    throw new Error("Cannot merge different document location types.");
}
function joinText(blocks, raw) {
    const first = blocks[0], last = blocks.at(-1);
    if (first.location.kind === "lines" && last.location.kind === "lines" && raw !== undefined)
        return raw.slice(first.location.startOffset, last.location.endOffset);
    const text = blocks.map(block => block.text).join("\n");
    const loc = first.location;
    return loc.kind === "sheet" && loc.headerText && loc.headerRange !== loc.range ? `${loc.headerText}\n${text}` : text;
}
function splitBlock(block, policy, locate) {
    const header = block.location.kind === "sheet" ? block.location.headerText?.length ?? 0 : 0;
    if (block.text.length + header + 1 <= policy.maxChars)
        return [block];
    const width = Math.max(16, Math.floor(policy.targetChars - Math.min(header + 1, policy.targetChars / 2))), result = [];
    for (let start = 0; start < block.text.length;) {
        let end = Math.min(block.text.length, start + width);
        const newline = block.text.lastIndexOf("\n", end - 1);
        if (newline > start + width / 2)
            end = newline + 1;
        if (end < block.text.length && /[\uD800-\uDBFF]/.test(block.text[end - 1]))
            end--;
        if (block.text[end - 1] === "\r" && block.text[end] === "\n")
            end--;
        let location = { ...block.location };
        if (location.kind === "lines" && locate)
            location = locate(location.startOffset + start, location.startOffset + end);
        else if (location.kind === "pdf")
            location = { ...location, textStart: location.textStart + start, textEnd: location.textStart + end };
        else if (location.kind === "docx" || location.kind === "sheet")
            location = { ...location, textStart: start, textEnd: end };
        // Very wide headers are represented by headerRange, not copied without bound.
        if (location.kind === "sheet" && header > policy.targetChars / 2)
            delete location.headerText;
        result.push({ ...block, text: block.text.slice(start, end), location });
        const overlap = Math.min(policy.overlapChars, Math.floor((end - start) / 2));
        let next = end === block.text.length ? end : end - overlap;
        if (next > 0 && /[\uDC00-\uDFFF]/.test(block.text[next]))
            next++;
        if (block.text[next - 1] === "\r" && block.text[next] === "\n")
            next++;
        start = next;
    }
    return result;
}
export function chunkDocument(documentId, blocks, policy, raw) {
    const chunks = [], occurrences = new Map();
    const locate = raw === undefined ? undefined : createLineLocator(raw);
    let group = [];
    const emit = () => {
        if (!group.length)
            return;
        const text = joinText(group, raw), chunkHash = hashText(text), headingPath = group[0].headingPath;
        const identity = JSON.stringify([documentId, PARSER_VERSION, CHUNKER_VERSION, headingPath, chunkHash]);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        chunks.push({ chunkId: `chunk-${hashText(`${identity}:${occurrence}`).slice(0, 40)}`, documentId, ordinal: chunks.length, text, chunkHash, headingPath, location: mergeLocation(group[0].location, group.at(-1).location), parserVersion: PARSER_VERSION });
    };
    for (const block of blocks.flatMap(block => splitBlock(block, policy, locate))) {
        const previous = group.at(-1);
        const sameSection = previous && JSON.stringify(previous.headingPath) === JSON.stringify(block.headingPath) && previous.location.kind === block.location.kind && (previous.location.kind !== "pdf" || block.location.kind === "pdf" && previous.location.page === block.location.page);
        const a = previous?.location, b = block.location;
        const overlappingSplit = a?.kind === "lines" && b.kind === "lines" ? b.startOffset < a.endOffset
            : a?.kind === "pdf" && b.kind === "pdf" ? a.page === b.page
                : a?.kind === "docx" && b.kind === "docx" ? b.startParagraph === a.endParagraph
                    : a?.kind === "sheet" && b.kind === "sheet" && a.sheet === b.sheet && b.startRow === a.endRow;
        if (group.length && (!sameSection || overlappingSplit || joinText([...group, block], raw).length > policy.targetChars)) {
            emit();
            const overlap = [];
            if (sameSection && !overlappingSplit)
                for (const prior of [...group].reverse()) {
                    if (joinText([prior, ...overlap], raw).length > policy.overlapChars)
                        break;
                    overlap.unshift(prior);
                }
            group = overlap;
            if (group.length && joinText([...group, block], raw).length > policy.maxChars)
                group = [];
        }
        group.push(block);
    }
    emit();
    return chunks;
}
