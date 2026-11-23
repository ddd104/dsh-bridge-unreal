import { createSourceProvider } from "./sourceRegistry.js";
export const iniSource = {
    ...createSourceProvider("ini", "INI", [".ini"]),
    parse: async (_filePath, content) => ({
        sourceType: "ini",
        text: content.toString("utf8"),
        metadata: {}
    })
};
