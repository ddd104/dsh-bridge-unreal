# Project knowledge worker

`knowledge-core.mjs` contains the shared, explicitly scoped index/query core. DSH packages it into its own isolated worker and uses a separate state-directory cache; the legacy UE entry keeps its original project/plugin validation and cache ownership. See the repository `docs/knowledge-m1.md` for the migration boundary.

M2 adds Wiki frontmatter/links, stable document IDs, structured chunks, Chinese substring retrieval and verified document readers. `read_document` and `read_chunk` are host-only additions, separate from the native worker catalog. See `docs/knowledge-m2.md` for citation locations and upgrade behavior. `wikiParser`, `xlsParser` and `protoParser` are bundled into prepared dist files; keep their dependency licenses under `ThirdParty/ProjectKnowledge` when distributing the plugin.

The subsequent PDF phase adds the self-contained `pdfParser` with PDF.js 6.5.438, its internal message handler, Adobe CMaps, standard fonts and DOMMatrix. `Tools/build.mjs` embeds these resources and removes the optional native-canvas initialization probe; extraction needs neither a browser nor canvas binaries nor network access. Keep all PDF/font licenses in `ThirdParty/ProjectKnowledge`. Citations use one-based physical pages and offsets in extracted page text; empty text pages report OCR/blank-page uncertainty. See `docs/knowledge-pdf.md` for limits and the required explicit index upgrade.

`knowledge-worker.mjs` is the private worker for the `DSHUnrealBridgeKnowledge` editor module. DSH exposes its read-only queries through `unreal_knowledge` on the already bound editor connection. No separate Graph or Memory MCP process or HTTP port is needed.

The worker combines the ProjectGraph source and UE snapshot index with ProjectMemorySystem document memory. `scripts/prepare-knowledge.ps1` in the repository pins and verifies Node.js 24.15.0, installs build dependencies, and compiles the TypeScript tools. It then removes the build dependencies, checks that the worker can import its dependencies, and runs the knowledge tests. Building requires npm; running the prepared plugin does not.

The repository's ignore rules allow `Runtime/Win64/node.exe` and both tool `dist` directories to be committed. Rebuild and commit the generated files whenever their sources or pinned runtime change. Keep `node_modules`, runtime download temporary files, and project caches out of Git.

The preparation script only updates the repository plugin. Copy its prepared `Runtime` and `Tools` directories into the matching project plugin. Validate either copy with `scripts/check-knowledge.ps1 -PluginRoot <plugin-directory>`; add `-RunTests` when the tool test sources and fixtures are included. This validates the runtime hash and worker imports, but project indexing still needs to be verified through the editor's update action and `project_status`.

Author project information under `ProjectKnowledge/` or another configured knowledge root in the UE project. The plugin's `Config/Knowledge/ProjectMemory.project.json` defines indexed roots and formats. Generated identity, graph, memory, evidence, and UE snapshots live under `Plugins/DSHUnrealBridge/Cache/` and should not be treated as authored documentation.

For development, run `Runtime/Win64/node.exe Tools/test.mjs` from this plugin directory after preparing the tools.

