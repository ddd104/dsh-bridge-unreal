import DOMMatrix from "@thednp/dommatrix";
import resources from "dsh:pdf-resources";
import type { SourceParseResult } from "./sourceRegistry.js";
import type { SourceBlock } from "../types/memoryTypes.js";

export const PDF_LIMITS = Object.freeze({ pages: 500, pageChars: 1_000_000, totalChars: 8_000_000, timeoutMs: 30_000 });
const fail = (code: string, message: string): never => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };

// The only resources the parser can request are these bundled CMaps/fonts.
// No URL, filesystem path or project-side executable is accepted here.
class BundledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const encoded = resources[`${kind}/${filename}`];
    if (!Object.hasOwn(resources, `${kind}/${filename}`) || !encoded) fail("pdf_resource_unavailable", "Unsupported PDF text resource.");
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
}

export async function parsePdf(_filePath: string, content: Buffer): Promise<SourceParseResult> {
  if (content.length > 64 * 1024 * 1024) fail("pdf_limit_exceeded", "PDF exceeds 64 MiB.");
  // Loaded lazily inside the existing knowledge Worker. No browser or renderer.
  (globalThis as any).DOMMatrix ??= DOMMatrix;
  // PDF.js uses its in-process message handler; the outer knowledge Worker owns
  // cancellation/time limits. Both API and handler are in the same bundle.
  // @ts-expect-error PDF.js publishes no declaration for this internal entry.
  const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as any).pdfjsWorker = { WorkerMessageHandler };
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(content), BinaryDataFactory: BundledBinaryDataFactory,
    useWorkerFetch: false, useWasm: false, useSystemFonts: false, disableFontFace: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, disableWorkerRendering: true,
    enableXfa: false, maxImageSize: 0, stopAtErrors: true, verbosity: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const extraction = async (): Promise<SourceParseResult> => {
      const pdf = await loading.promise;
      if (pdf.numPages > PDF_LIMITS.pages) fail("pdf_limit_exceeded", `PDF has more than ${PDF_LIMITS.pages} pages.`);
      const labels = await pdf.getPageLabels(), blocks: SourceBlock[] = [], noTextPages: number[] = [];
      let total = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber), reader = page.streamTextContent({ disableNormalization: true }).getReader();
        let text = "";
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            for (const item of value.items) {
              if (!("str" in item)) continue;
              // Preserve PDF.js content order and explicit line breaks. These
              // offsets identify extracted page text, never binary PDF bytes.
              const part = item.str + (item.hasEOL ? "\n" : "");
              total += part.length;
              if (text.length + part.length > PDF_LIMITS.pageChars || total > PDF_LIMITS.totalChars) fail("pdf_limit_exceeded", "Extracted PDF text exceeds its character budget.");
              text += part;
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); page.cleanup(); }
        if (!text.trim()) { noTextPages.push(pageNumber); continue; }
        const pageLabel = typeof labels?.[pageNumber - 1] === "string" ? labels[pageNumber - 1].slice(0, 128) : undefined;
        blocks.push({ text, kind: "paragraph", headingPath: [`Page ${pageNumber}`],
          location: { kind: "pdf", page: pageNumber, ...(pageLabel ? { pageLabel } : {}), textStart: 0, textEnd: text.length } });
      }
      return { sourceType: "pdf", text: blocks.map(block => block.text).join("\n"), blocks,
        metadata: { pdf: { parser: "pdfjs-6.5.438-text-v1", pageCount: pdf.numPages, textPageCount: blocks.length,
          noTextPages, ocrStatus: "not_performed", extraction: "text_layer", complete: noTextPages.length === 0,
          ...(noTextPages.length ? { warning: "pdf_needs_ocr_or_blank: Pages without extractable text may be blank; scanned content needs OCR (需要 OCR). Missing text is not proof of absent knowledge." } : {}) } } };
    };
    return await Promise.race([extraction(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("pdf_timeout: PDF text extraction exceeded 30 seconds."), { code: "pdf_timeout" })), PDF_LIMITS.timeoutMs);
    })]);
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") fail("pdf_password_required", "Password-protected PDF was skipped; provide an unlocked copy in the knowledge directory.");
    if (error instanceof Error && "code" in error && String(error.code).startsWith("pdf_")) throw error;
    return fail("pdf_parse_failed", "PDF text could not be decoded; the document was skipped.");
  } finally { clearTimeout(timer); await loading.destroy(); }
}
