import { createSourceProvider } from "./sourceRegistry.js";
import { parseWiki } from "./wikiParser.js";
export const markdownSource = {
    ...createSourceProvider("markdown", "Markdown", [".md", ".markdown"]),
    parse: async (_filePath, content) => parseWiki(content.toString("utf8"))
};
