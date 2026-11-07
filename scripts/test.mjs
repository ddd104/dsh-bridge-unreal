import {mkdir, realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const temporary = join(root, '.test-state', 'tmp');
await mkdir(temporary, {recursive: true});
// Windows can expose TEMP as an 8.3 alias while fs.promises.realpath expands it.
// Use a canonical test directory without weakening the product's link checks.
const canonical = await realpath(temporary);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'test/*.test.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: {...process.env, TEMP: canonical, TMP: canonical, TMPDIR: canonical},
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
