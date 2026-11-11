import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { knowledgeSchema, knowledgeRecordSchema } from '../src/protocol.mjs';
import {resolve, join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

// Verify the UE implementation shipped in this repository unless explicitly overridden.
const ueRoot = process.env.DSH_UE_PLUGIN_ROOT || fileURLToPath(new URL('../unreal/DSHUnrealBridge/', import.meta.url));

test('knowledge host schemas and worker admission match the native routing catalog', async () => {
  const {workerToolNames} = await import(pathToFileURL(resolve(ueRoot, 'Tools/knowledge-tools.mjs')).href);
  const source = await readFile(join(ueRoot, 'Source/DSHUnrealBridgeKnowledge/Private/ProjectKnowledgeTools.inl'), 'utf8');
  const declarations = source.split(/\r?\n/).filter(line => line.startsWith('DSH_KNOWLEDGE_TOOL('));
  const entries = declarations.map(line => {
    const match = /^DSH_KNOWLEDGE_TOOL\("([^"]+)", (Worker|Snapshot|Editor), (true|false), (true|false)\)$/.exec(line);
    assert.ok(match, `Unrecognized native tool declaration: ${line}`);
    return { name: match[1], backend: match[2], write: match[3] === 'true', bridge: match[4] === 'true' };
  });
  assert.ok(entries.length > 0, 'native catalog must not be empty');
  assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length, 'tool names must be unique');
  const names = predicate => entries.filter(predicate).map(entry => entry.name).sort();
  assert.deepEqual([...knowledgeSchema.shape.tool.options].sort(), names(entry => entry.bridge && !entry.write));
  assert.deepEqual([...knowledgeRecordSchema.shape.tool.options].sort(), names(entry => entry.bridge && entry.write));
  assert.deepEqual([...workerToolNames].sort(), names(entry => entry.backend === 'Worker'));
  assert.equal(new Set(workerToolNames).size, workerToolNames.length, 'worker names must be unique');
});
