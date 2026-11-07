import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
// DSH/pnpm may disable lifecycle scripts. The Git checkout must be ready as-is.
for (const key of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
  assert.equal(manifest.scripts?.[key], undefined, `${key} must not be needed to install this plugin`);
}
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run with npm run check:package');
const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'], {cwd: root, encoding: 'utf8'});
if (packed.error) throw packed.error;
assert.equal(packed.status, 0, packed.stderr);
const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
const entries = [manifest.main, ...Object.values(manifest.exports), manifest.dsh.bundle.patch].map(path => path.replace(/^\.\//, ''));
for (const path of entries) assert.ok(files.includes(path), `Missing install entry: ${path}`);
assert.ok(!files.some(path => /^(src|test|unreal|editors|node_modules)\/|\.map$/.test(path)), 'Development files leaked into the package');
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
assert.match(patch, new RegExp(`name: ${manifest.name}\\s`));
let client;
runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: {__ModuleLoader__: {load: value => {client = value;}}},
});
assert.equal(client.id, manifest.name, 'Browser module and package identities must agree');
assert.equal(typeof client.factory(createRequire(import.meta.url)).apply, 'function');
const host = await import('../lib/index.js');
assert.equal(typeof host.apply, 'function');
assert.equal(typeof host.Config, 'function');
const remote = await import('../lib/remote.js');
assert.equal(remote.TYPERT.package, manifest.name);
console.log(`Installable bundle verified: ${manifest.name}@${manifest.version}, ${files.length} files, host/client/remote entry points ready without install scripts.`);
