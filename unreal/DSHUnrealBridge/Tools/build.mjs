import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renameSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
// 编译两个原有工具，始终复用当前插件的 Node 运行环境。
const root = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['ProjectGraph', 'ProjectMemorySystem']) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, name, 'tsconfig.json')], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Keep document readers self-contained after installation removes node_modules.
for (const name of ['protoParser', 'xlsParser', 'wikiParser', 'pdfParser']) {
  const output = path.join(root, 'ProjectMemorySystem/dist/src/sources', `${name}.js`);
  const temporary = `${output}.bundle.js`;
  await build({
    entryPoints: [output], outfile: temporary, bundle: true, platform: 'node',
    // YAML's ESM distribution has no CommonJS require('process') at runtime.
    ...(name === 'wikiParser' ? { alias: { yaml: path.join(root, 'node_modules/yaml/browser/index.js') } } : {}),
    ...(name === 'pdfParser' ? { plugins: [{ name: 'offline-text-pdf', setup(builder) {
      builder.onResolve({filter: /^dsh:pdf-resources$/}, () => ({path: 'pdf-resources', namespace: 'pdf'}));
      builder.onLoad({filter: /.*/, namespace: 'pdf'}, () => {
        const resources = {};
        for (const [kind, directory, extension] of [['cMapUrl','cmaps',/\.bcmap$/], ['standardFontDataUrl','standard_fonts',/\.(pfb|ttf)$/]]) {
          const folder = path.join(root, 'node_modules/pdfjs-dist', directory);
          for (const file of readdirSync(folder).filter(file => extension.test(file)).sort()) resources[`${kind}/${file}`] = readFileSync(path.join(folder, file)).toString('base64');
        }
        return {contents: `export default ${JSON.stringify(resources)};`, loader: 'js'};
      });
      builder.onLoad({filter: /pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs$/}, ({path: file}) => {
        let text = readFileSync(file, 'utf8');
        const start = text.indexOf('if (isNodeJS) {\n  let canvas;'), end = text.indexOf('async function node_utils_fetchData', start);
        if (start < 0 || end < 0) throw Error('Pinned PDF.js text-only adapter needs review.');
        // Text extraction supplies DOMMatrix and never renders. Remove the
        // optional native-canvas probe so released Workers need no canvas DLL.
        text = text.slice(0, start) + '// DSH text-only build: optional canvas initialization removed.\n' + text.slice(end);
        return {contents: text, loader: 'js'};
      });
    }}] } : {}),
    format: 'esm', target: 'node24', mainFields: ['module', 'main'], legalComments: 'inline'
  });
  renameSync(temporary, output);
}
for (const [source, name] of [['pdfjs-dist/LICENSE','pdfjs.LICENSE'], ['pdfjs-dist/cmaps/LICENSE','pdfjs-CMaps.LICENSE'], ['pdfjs-dist/standard_fonts/LICENSE_FOXIT','pdfjs-Foxit.LICENSE'], ['pdfjs-dist/standard_fonts/LICENSE_LIBERATION','pdfjs-Liberation.LICENSE'], ['@thednp/dommatrix/LICENSE','dommatrix.LICENSE']]) {
  writeFileSync(path.join(root,'../ThirdParty/ProjectKnowledge',name),readFileSync(path.join(root,'node_modules',source),'utf8').replace(/[ \t]+$/gm,''));
}
