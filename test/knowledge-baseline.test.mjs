import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UnrealBridge } from '../src/bridge.mjs';

test('bundled knowledge runtime passes the M0 retrieval corpus', { timeout: 90000 }, () => {
  const result = spawnSync(process.execPath, ['scripts/knowledge-baseline.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
    windowsHide: true, timeout: 75000, maxBuffer: 4 * 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /M0 knowledge baseline: local documents, graph, evidence and known gaps/,
    'nested runner must actually execute the corpus');
});

test('M0 host routing preserves binding, capability and read-only contracts', async t => {
  // Exercise routing independently of transport; bridge.test.mjs covers WebSocket I/O.
  const bridge = new UnrealBridge({ allowWrites: false });
  const calls = [];
  t.mock.method(bridge, 'request', async (editor, method, params) => {
    calls.push({ editor: editor.editorId, method, params });
    return { project: editor.editorId, query: params.arguments.query };
  });
  const args = { tool: 'project_context', arguments: { query: 'STR 唤醒 UDisplayLifecycle' } };
  await assert.rejects(bridge.knowledge('unbound', args), { code: 'NOT_BOUND' });
  for (const editorId of ['A', 'B', 'old']) bridge.editors.set(editorId, {
    editorId, project: editorId, projectPath: `/projects/${editorId}`,
    capabilities: editorId === 'old' ? [] : ['project_knowledge']
  });
  bridge.bind('first', 'A');
  bridge.bind('second', 'B');
  const results = await Promise.all([bridge.knowledge('first', args), bridge.knowledge('second', args)]);
  assert.deepEqual(results, [{ project: 'A', query: args.arguments.query }, { project: 'B', query: args.arguments.query }]);
  assert.deepEqual(calls, [{ editor: 'A', method: 'knowledge_call', params: args }, { editor: 'B', method: 'knowledge_call', params: args }]);
  bridge.editors.delete('B');
  await assert.rejects(bridge.knowledge('second', args), { code: 'DISCONNECTED' });
  bridge.bind('second', 'old');
  await assert.rejects(bridge.knowledge('second', args), { code: 'KNOWLEDGE_UNAVAILABLE' });
  assert.equal(calls.length, 2, 'rejected reads must not dispatch');
  assert.equal((await bridge.knowledge('first', args)).project, 'A');
});
