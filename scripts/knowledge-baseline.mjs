import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.platform === 'win32'
  ? path.join(root, 'unreal/DSHUnrealBridge/Runtime/Win64/node.exe') : process.execPath;
const report = path.join(root, '.test-state/knowledge-baseline/results.json');
const env = { ...process.env, DSH_KNOWLEDGE_BASELINE_REPORT: report };
// A nested node --test must start its own runner, not inherit the outer
// runner's child protocol (which can silently skip this test file).
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(runtime, ['--test', 'unreal/DSHUnrealBridge/Tools/test/knowledge-baseline.test.mjs'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env
});
if (result.error) console.error(`Cannot run knowledge baseline: ${result.error.message}`);
if (result.status === 0) console.log(`Knowledge baseline report: ${report}`);
process.exitCode = result.status ?? 1;
