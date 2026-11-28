import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/knowledge-baseline/', import.meta.url));
const tempRoot = path.join(pluginRoot, 'Cache/TestRuns/Temp');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, createWorker) {
  await mkdir(tempRoot, { recursive: true });
  const project = await realpath(await mkdtemp(path.join(tempRoot, 'M0 中文 project-')));
  t.after(async () => {
    const relative = path.relative(await realpath(tempRoot), project);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(project, { recursive: true, force: true });
  });
  await cp(path.join(fixtures, 'project'), project, { recursive: true });
  await writeFile(path.join(project, 'Baseline.uproject'), '{"FileVersion":3}\n');
  const plugin = path.join(project, 'Plugins/DSHUnrealBridge');
  const configPath = path.join(plugin, 'Config/Knowledge/ProjectMemory.project.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await copyFile(path.join(pluginRoot, 'Config/Knowledge/ProjectMemory.project.json'), configPath);
  const assets = JSON.parse(await readFile(path.join(fixtures, 'assets.json'), 'utf8'));
  assets.projectRoot = project;
  const registryPath = path.join(plugin, 'Cache/UE/asset_registry/assets.json');
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(assets));
  const worker = await createWorker(project, plugin);
  let sequence = 0;
  const rawCall = (tool, args = {}) => worker({ id: `baseline-${++sequence}`, tool, arguments: args });
  const call = async (tool, args = {}) => {
    const response = await rawCall(tool, args);
    assert.equal(response.isError, false, `${tool}: ${JSON.stringify(response.result)}`);
    return response.result;
  };
  return { project, plugin, configPath, call, rawCall };
}

test('M0 knowledge baseline: local documents, graph, evidence and known gaps', { timeout: 60000 }, async t => {
  // No API key or provider is configured. Fail even if a future network branch
  // swallows its own error; the final attempt counter must also remain zero.
  const networkAttempts = [];
  const denyNetwork = name => () => {
    networkAttempts.push(name);
    throw new Error(`M0 baseline forbids network access: ${name}`);
  };
  for (const [object, method, name] of [
    [globalThis, 'fetch', 'fetch'], [http, 'request', 'http.request'],
    [http, 'get', 'http.get'], [https, 'request', 'https.request'],
    [https, 'get', 'https.get'], [net.Socket.prototype, 'connect', 'socket.connect']
  ]) t.mock.method(object, method, denyNetwork(name));
  const { createWorker } = await import('../knowledge-worker.mjs');
  const { queryMemory } = await import('../ProjectMemorySystem/dist/src/commands/queryMemory.js');
  const { loadProjectConfig } = await import('../ProjectMemorySystem/dist/src/config/loadProjectConfig.js');
  const { collectDocuments } = await import('../ProjectMemorySystem/dist/src/index/documentIndexer.js');
  const { FullTextIndex } = await import('../ProjectMemorySystem/dist/src/index/fullTextIndex.js');
  const corpus = JSON.parse(await readFile(path.join(fixtures, 'questions.json'), 'utf8'));
  assert.equal(new Set(corpus.questions.map(item => item.id)).size, corpus.questions.length);
  const f = await fixture(t, createWorker);
  const report = { schemaVersion: 1, corpusVersion: corpus.version, stage: 'M2', node: process.version,
    evaluatedAt: new Date().toISOString(), networkAttempts, results: [], knownGaps: [],
    scope: 'Synthetic local worker/index tests; no live UE editor or DeepSeek answer evaluation.' };
  const options = { projectRoot: f.project, configPath: f.configPath };

  await t.test('missing index retains source evidence and requests an explicit update', async () => {
    const status = await f.call('project_status');
    assert.equal(status.status, 'missing');
    assert.equal(status.needsUpdate, true);
    const context = await f.call('project_context', { query: 'UDisplayLifecycle' });
    assert.equal(context.memory, null);
    assert.ok(context.sources.some(source => source.path === 'Source/Baseline/DisplayLifecycle.h'));
    assert.ok(context.warnings.some(warning => warning.includes('project_update')));
    assert.equal((await f.call('project_status')).status, 'missing', 'query must not build an index');
    const graph = await f.rawCall('graph_query', { query: 'UDisplayLifecycle' });
    assert.equal(graph.result.code, 'cache_identity_mismatch');
  });

  const updated = await f.call('project_update');
  assert.equal(updated.status, 'ready');
  assert.equal(updated.ueCacheVerified, true);
  const beforeQueries = await readFile(path.join(f.plugin, 'Cache/identity.json'), 'utf8');
  const ftsPath = path.join(f.plugin, 'Cache/Memory/index/fts.sqlite');
  const ftsBefore = { hash: sha(await readFile(ftsPath)), mtime: (await stat(ftsPath)).mtimeMs };

  for (const item of corpus.questions) await t.test(`${item.id}${item.knownGap ? ' [known gap]' : ''}`, async () => {
    const start = performance.now();
    const result = item.route === 'fulltext'
      ? (await queryMemory(item.query, options)).data
      : await f.call(item.route, { query: item.query, maxResults: 10, limit: 10 });
    const paths = item.route === 'graph_query' ? result.candidates.map(hit => hit.node.path)
      : item.route === 'project_context' ? result.sources.map(hit => hit.path)
      : result.results.map(hit => hit.path);
    const top10 = [...new Set(paths.slice(0, 10))];
    const relevant = item.relevantPaths;
    const recallAt10 = relevant.length ? relevant.filter(p => top10.includes(p)).length / relevant.length : null;
    const matchesBaseline = item.knownGap ? JSON.stringify(top10) === JSON.stringify(item.baselinePaths)
      : relevant.length ? recallAt10 === 1 : top10.length === 0;
    report.results.push({ id: item.id, category: item.category, route: item.route, query: item.query,
      returnedPaths: top10, relevantPaths: relevant, recallAt10,
      status: matchesBaseline ? (item.knownGap ? 'known-gap' : 'pass') : 'regression',
      elapsedMs: Math.round((performance.now() - start) * 100) / 100 });
    if (item.knownGap) {
      assert.deepEqual(top10, item.baselinePaths, 'baseline changed: reassess the known gap and update the corpus');
      report.knownGaps.push({ id: item.id, reason: item.knownGap });
    } else if (relevant.length) {
      assert.equal(recallAt10, 1, `Expected ${relevant.join(', ')}; got ${top10.join(', ')}`);
    } else assert.deepEqual(top10, []);
    if (item.route === 'project_context') {
      assert.equal(result.authority, 'navigation_and_evidence_only');
      assert.match(result.instruction, /Missing indexed knowledge is not proof/);
      assert.ok(result.memory, 'built memory must participate in project_context');
      if (item.id === 'mixed-context') {
        assert.ok(result.memory.relevantDocs.some(doc => JSON.stringify(doc).includes('ProjectKnowledge/systems/power.md')));
        assert.ok(result.memory.filesToRead.includes('Source/Baseline/DisplayLifecycle.h'));
      }
    }
  });

  await t.test('queries preserve the published generation and full-text index', async () => {
    assert.equal(await readFile(path.join(f.plugin, 'Cache/identity.json'), 'utf8'), beforeQueries);
    assert.equal(sha(await readFile(ftsPath)), ftsBefore.hash);
    assert.equal((await stat(ftsPath)).mtimeMs, ftsBefore.mtime);
  });

  await t.test('separate working copies keep independent identities and document results', async sub => {
    const other = await fixture(sub, createWorker);
    await writeFile(path.join(other.project, 'ProjectKnowledge/Docs/rendering.md'), '# Other project\n\nOtherProjectOnlyMarker\n');
    await other.call('project_update');
    const otherIdentity = JSON.parse(await readFile(path.join(other.plugin, 'Cache/identity.json'), 'utf8'));
    assert.notEqual(otherIdentity.identity, JSON.parse(beforeQueries).identity);
    const otherOptions = { projectRoot: other.project, configPath: other.configPath };
    assert.deepEqual((await queryMemory('RenderBudgetMarker', otherOptions)).data.results, []);
    assert.equal((await queryMemory('OtherProjectOnlyMarker', otherOptions)).data.results[0].path, 'ProjectKnowledge/Docs/rendering.md');
    assert.deepEqual((await queryMemory('OtherProjectOnlyMarker', options)).data.results, []);
    assert.equal((await queryMemory('RenderBudgetMarker', options)).data.results[0].path, 'ProjectKnowledge/Docs/rendering.md');
  });

  await t.test('source citations round-trip with original line numbers and reject stale hashes', async () => {
    const hits = await f.call('project_search', { query: 'UDisplayLifecycle' });
    for (const hit of hits.results) {
      const original = await readFile(path.join(f.project, hit.path), 'utf8');
      const citation = await f.call('read_source', { path: hit.path, startLine: hit.line, maxLines: 1, expectedHash: hit.hash });
      assert.equal(citation.hash, sha(Buffer.from(original)));
      assert.equal(citation.startLine, hit.line);
      assert.equal(citation.endLine, hit.line);
      assert.equal(citation.content, original.split(/\r?\n/)[hit.line - 1]);
      assert.equal(citation.authority, 'source_evidence');
    }
    report.citations = { checked: hits.results.length, matched: hits.results.length, accuracy: 1 };
    const source = hits.results.find(hit => hit.path.endsWith('.h'));
    assert.equal((await f.call('validate_evidence', { sources: [source] })).fresh, true);
    await writeFile(path.join(f.project, source.path), '// Changed after indexing\n');
    assert.equal((await f.call('validate_evidence', { sources: [source] })).fresh, false);
    assert.equal((await f.rawCall('read_source', { path: source.path, expectedHash: source.hash })).result.code, 'source_changed');
    assert.equal((await f.call('project_status')).status, 'stale_sources');
    // Current source search must not resurrect the stale class declaration.
    assert.ok(!(await f.call('project_search', { query: 'UDisplayLifecycle' })).results.some(hit => hit.path === source.path));
  });

  await t.test('duplicate-content files have independent citations without changing the published index', async () => {
    await copyFile(path.join(f.project, 'ProjectKnowledge/Docs/rendering.md'), path.join(f.project, 'ProjectKnowledge/Docs/rendering-copy.md'));
    const { documents } = await collectDocuments(await loadProjectConfig(options));
    const duplicates = documents.filter(doc => doc.path === 'ProjectKnowledge/Docs/rendering.md' || doc.path === 'ProjectKnowledge/Docs/rendering-copy.md');
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0].id, duplicates[1].id);
    assert.equal(duplicates[0].hash, duplicates[1].hash);
    const index = FullTextIndex.create(':memory:');
    try {
      index.replaceAll(duplicates);
      assert.equal(index.search('RenderBudgetMarker').length, 2);
      for (const document of duplicates) assert.equal(index.document(document.id).path, document.path);
    } finally { index.close(); }
    assert.equal(sha(await readFile(ftsPath)), ftsBefore.hash);
  });

  await t.test('unconfigured baseline makes zero network requests', () => assert.deepEqual(networkAttempts, []));
  const scored = report.results.filter(item => item.recallAt10 !== null);
  report.metrics = { queryCount: report.results.length, knownGapCount: report.knownGaps.length,
    meanRecallAt10: scored.reduce((sum, item) => sum + item.recallAt10, 0) / scored.length,
    noAnswerQueries: report.results.filter(item => item.category === 'no-answer').length };
  if (process.env.DSH_KNOWLEDGE_BASELINE_REPORT) {
    const target = path.resolve(process.env.DSH_KNOWLEDGE_BASELINE_REPORT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + '\n');
  }
});
