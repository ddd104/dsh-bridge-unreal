import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatedMarkdownHeader, sourceEvidence } from "../summarizers/documentSummarizer.js";
import { summarizeProject } from "../summarizers/projectSummarizer.js";
export async function writeProjectCapsule(loaded) {
    const sourcePath = path.join(loaded.projectRoot, "ProjectKnowledge", "overview", "project_purpose.md");
    if (!existsSync(sourcePath)) {
        return {
            projectId: loaded.config.projectId,
            status: "missing",
            sourcePaths: [],
            sourceHash: undefined
        };
    }
    const evidence = await sourceEvidence(loaded.projectRoot, [sourcePath]);
    const summary = await summarizeProject(loaded, sourcePath);
    const outputPath = path.join(loaded.resolvedMemoryOutputRoot, "project_capsule.md");
    const body = [
        generatedMarkdownHeader(evidence),
        `# Project Capsule: ${summary.title}`,
        "",
        `Project ID: ${loaded.config.projectId}`,
        `Status: ${summary.status}`,
        `Indexed documents considered: ${summary.indexedDocumentCount}`,
        "",
        "## Summary",
        "",
        ...summary.bullets.map((bullet) => `- ${bullet}`),
        ""
    ].join("\n");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, body, "utf8");
    return {
        projectId: loaded.config.projectId,
        status: summary.status,
        outputPath,
        sourcePaths: evidence.sourcePaths,
        sourceHash: evidence.sourceHash
    };
}
export function createProjectCapsule(projectId) {
    return {
        projectId,
        status: "missing_evidence",
        sourcePaths: []
    };
}
