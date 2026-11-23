import { createSourceProvider } from "./sourceRegistry.js";
export const yamlSource = {
    ...createSourceProvider("yaml", "YAML", [".yaml", ".yml"]),
    parse: async (_filePath, content) => ({
        sourceType: "yaml",
        text: content.toString("utf8"),
        metadata: {}
    })
};
