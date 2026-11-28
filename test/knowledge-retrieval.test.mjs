import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {fuseDocuments,boundContext,exactTerms} from '../src/knowledge-retrieval.mjs';
import {retrievalFixture,put,until,secret} from './helpers/retrieval-fixture.mjs';

test('M4 RRF protects exact symbols and paths, ignores score scale, deduplicates chunks and bounds each document',()=>{
  const rows=Array.from({length:6},(_,i)=>({id:`chunk-${i}`,documentId:i<3?'duplicate':`doc-${i}`,path:i===5?'Source/ExactThing.h':`Docs/${i}.md`,title:i===5?'UExactThing':'Other',excerpt:'evidence',score:100-i}));
  const fused=fuseDocuments('UExactThing',rows,rows.toReversed().map(row=>({...row,score:-100000})));assert.equal(fused[0].id,'chunk-5');assert.equal(fused[0].exactMatch,true);assert.ok(fused[0].channels.includes('fulltext')&&fused[0].channels.includes('vector'));assert.equal(fused.filter(row=>row.documentId==='duplicate').length,2);
  assert.deepEqual(fused.map(row=>row.id),fuseDocuments('UExactThing',rows.map(row=>({...row,score:1e30})),rows.toReversed()).map(row=>row.id));
  assert.ok(exactTerms('解释 /Game/UI/WBP_Test.WBP_Test 和 UExactThing::Run').includes('/Game/UI/WBP_Test.WBP_Test'));
});

test('M4 total context budgets include the serialized envelope and preserve whole retained citations',()=>{
  const docs=Array.from({length:20},(_,i)=>({documentId:`doc-${i}`,chunkId:`chunk-${i}`,sourceHash:'a'.repeat(64),excerpt:'中文测试'.repeat(200),location:{startLine:1,endLine:20},channels:['vector']}));
  const result=boundContext({query:'测试',memory:{projectCapsule:'x'.repeat(100000),relevantDocs:docs,graphContext:{context:{nodes:[],edges:[]}}},sources:[],warnings:[],retrievalMode:'hybrid'},{maxTokens:6000,maxChars:4000});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=6000);assert.ok(JSON.stringify(result).length<=4000);assert.equal(result.contextBudget.truncated,true);assert.ok(result.memory.relevantDocs.length);assert.equal(result.memory.relevantDocs[0].excerpt,docs[0].excerpt);
});

test('M4 minimum budgets remain hard bounds with oversized warnings, metadata and legacy envelopes',()=>{
  const huge='冗长'.repeat(10000);
  for(const value of [
    {query:huge,instruction:huge,retrieval:{queryEmbedding:{embeddingRequests:1,usage:{provider:huge}},sourceWarnings:[huge]},memory:{relevantDocs:[]}},
    {query:huge,projectHandle:huge,projectId:huge,indexGeneration:huge,profileFingerprint:huge,knowledgeBackend:huge,assetEvidenceBackend:huge,remembered:[huge],memory:{unknownLegacyField:huge,relevantDocs:[]}},
  ]){
    const result=boundContext(value,{maxTokens:2048,maxChars:2048});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=2048);assert.ok(JSON.stringify(result).length<=2048);assert.equal(result.contextBudget.truncated,true);assert.equal(result.retrievalMode,'base');
  }
});

test('M4 enabled indexes answer paraphrases, cache query vectors and associate verified source graph without document rebuilds',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.build(p,{vector:false});
  const base=await f.query(p,'车醒了但屏幕不亮');assert.equal(base.retrievalMode,'base');assert.equal(f.calls.length,0);assert.equal(base.memory.relevantDocs.length,0);
  await f.configure();await f.query(p,'车醒了但屏幕不亮');assert.equal(f.calls.length,0);
  const built=await f.build(p),before=f.calls.length,pointer=await readFile(path.join(f.knowledge.jobs.rootFor(p.context),'current.json'),'utf8');
  const first=await f.query(p,'车醒了但屏幕不亮');assert.equal(first.retrievalMode,'hybrid',JSON.stringify(first));assert.equal(first.indexGeneration,built.index.generation);assert.ok(first.memory.relevantDocs.some(hit=>hit.path==='ProjectKnowledge/systems/power.md'&&hit.sourceStatus==='current'));
  assert.equal(first.retrieval.queryEmbedding.embeddingRequests,1);assert.equal(first.retrieval.documentEmbeddingRequests,0);assert.deepEqual(f.calls.at(-1).input,['车醒了但屏幕不亮']);
  assert.ok(first.graphAssociations.links.some(link=>link.kind==='symbol'&&link.target==='UDisplayLifecycle'&&link.status==='resolved'));
  assert.ok(first.graphAssociations.links.some(link=>link.kind==='asset'&&link.status==='unverified_asset'));
  assert.ok(first.graphAssociations.links.some(link=>link.target==='UDoesNotExist'&&link.status==='missing_or_stale_symbol'));
  assert.ok(first.memory.graphContext.context.nodes.every(node=>node.sourceHash&&node.sourceStatus==='current'));
  const second=await f.query(p,'车醒了但屏幕不亮');assert.equal(second.retrieval.queryEmbedding.cacheHit,true);assert.equal(second.retrieval.queryEmbedding.embeddingRequests,0);assert.equal(f.calls.length,before+1);assert.equal(await readFile(path.join(f.knowledge.jobs.rootFor(p.context),'current.json'),'utf8'),pointer);
  const exact=await f.query(p,'UDisplayLifecycle');assert.equal(exact.memory.relevantDocs[0].exactMatch,true);assert.equal(exact.sourceSearch,'indexed');
  const absent=await f.query(p,'QuantumFluxAbsentMarker');assert.equal(absent.retrievalMode,'base');assert.equal(absent.memory.relevantDocs.length,0);
  assert.equal(JSON.stringify(first).includes(secret),false);
});

test('M4 failed providers and corrupt vectors fall back to fulltext; errors are bounded and successful retries require a new query',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);const before=f.calls.length;
  f.serverState.status=401;const failed=await f.query(p,'RenderBudgetMarker');assert.equal(failed.retrievalMode,'base');assert.ok(failed.memory.relevantDocs.length);assert.ok(failed.degradedReasons.includes('EMBEDDING_AUTH_FAILED'));assert.equal(f.calls.length,before+1);assert.equal(JSON.stringify(failed).includes(secret),false);
  await f.query(p,'UDisplayLifecycle');assert.equal(f.calls.length,before+1,'cooldown prevents repeated billed failures');
  f.serverState.status=200;await f.embedding.setCredential({configFingerprint:f.revision(),apiKey:secret});assert.equal((await f.query(p,'RenderBudgetMarker')).retrievalMode,'hybrid');
  const current=await f.knowledge.jobs.current(p.context);await writeFile(path.join(current.cache,'Memory/index/vector.sqlite'),'not sqlite');const count=f.calls.length;
  const corrupt=await f.query(p,'UDisplayLifecycle');assert.equal(corrupt.retrievalMode,'base');assert.ok(corrupt.memory.relevantDocs.length);assert.equal(f.calls.length,count);
});

test('M4 query cache is project-isolated and shared requests survive cancellation of one subscriber',async t=>{
  const f=await retrievalFixture(t),p=await f.project(),other=await f.project('Other');await f.configure();await f.build(p);await f.build(other);
  f.serverState.wait=700;const before=f.calls.length,abort=new AbortController();
  const one=f.query(p,'车醒了但屏幕不亮',{},abort.signal),settled=one.then(()=>null,error=>error),two=f.query(p,'车醒了但屏幕不亮');
  await until(()=>[...f.embedding.queries.pending.values()].some(entry=>entry.users.size===2));abort.abort();const error=await settled;assert.ok(error);assert.equal((await two).retrievalMode,'hybrid');assert.equal(f.calls.length,before+1);
  f.serverState.wait=0;assert.equal((await f.query(p,'车醒了但屏幕不亮')).retrieval.queryEmbedding.cacheHit,true);
  assert.equal((await f.query(other,'车醒了但屏幕不亮')).retrieval.queryEmbedding.embeddingRequests,1);assert.equal(f.calls.length,before+2);
  await f.restart();assert.equal(f.calls.length,before+2);assert.equal((await f.query(p,'车醒了但屏幕不亮')).retrieval.queryEmbedding.embeddingRequests,1);
});

test('M4 disabled profiles, missing keys, mismatched spaces and explicit base queries send no query requests',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);const before=f.calls.length;
  assert.equal((await f.query(p,'UDisplayLifecycle',{retrievalMode:'base'})).retrievalMode,'base');
  f.config.embeddingEnabled=false;f.embedding.configurationChanged();assert.equal((await f.query(p,'UDisplayLifecycle')).retrievalMode,'base');
  f.config.embeddingEnabled=true;f.config.embeddingModel='changed';f.embedding.configurationChanged();assert.ok((await f.query(p,'UDisplayLifecycle')).degradedReasons.includes('vector_space_changed'));
  f.config.embeddingModel='semantic-fixture-v1';await f.embedding.removeCredential({configFingerprint:f.revision()});assert.equal((await f.query(p,'UDisplayLifecycle')).retrievalMode,'base');assert.equal(f.calls.length,before);
});

test('M4 sources and graph nodes changed during a request are filtered; confirmed metadata is never freshness proof',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);
  f.serverState.onQuery=async()=>{await put(path.join(p.dir,'ProjectKnowledge/systems/power.md'),'# Changed\nReplacement document.');await put(path.join(p.dir,'Source/Baseline/DisplayLifecycle.h'),'// Replacement source');};
  const result=await f.query(p,'车醒了但屏幕不亮');assert.equal(result.retrievalMode,'base');assert.equal(result.memory.relevantDocs.length,0);assert.equal(result.memory.graphContext.context.nodes.length,0);assert.ok(result.retrieval.sourceWarnings.some(w=>w.code==='source_changed'));
});

test('M4 publishing another generation during a query cannot mix generations; changed policy prevents cloud queries',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();const original=await f.build(p);
  f.serverState.onQuery=async()=>{await f.build(p,{vector:false});f.serverState.onQuery=null;};
  const result=await f.query(p,'车醒了但屏幕不亮');assert.equal(result.indexGeneration,original.index.generation);assert.equal(result.graphAssociations.generation,original.index.generation);
  assert.notEqual((await f.knowledge.jobs.current(p.context)).generation,original.index.generation);const before=f.calls.length;assert.ok((await f.query(p,'UDisplayLifecycle')).degradedReasons.includes('vector_index_missing'));assert.equal(f.calls.length,before);
  p.policy.sourcePolicy={excludePatterns:['**/power.md']};await writeFile(path.join(p.dir,'ProjectMemory.project.json'),JSON.stringify(p.policy));const changed=await f.query(p,'UDisplayLifecycle');assert.equal(changed.memory,null);assert.ok(changed.degradedReasons.includes('project_policy_changed'));assert.equal(f.calls.length,before);
});

test('M4 binding changes cannot deliver a pending query into another conversation target',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);
  f.serverState.onQuery=()=>{f.bridge.bindingVersions.set(p.agent.session.id,1);};
  await assert.rejects(f.query(p,'车醒了但屏幕不亮'),{code:'INSTANCE_CHANGED'});
});

test('M4 key revocation during preflight prevents requests and disabling during HTTP discards the semantic result',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);const before=f.calls.length;
  const run=f.embedding.jobs.runVector;let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
  f.embedding.jobs.runVector=async(data,options)=>{const result=await run(data,options);if(data.action==='inspect'){entered=true;await gate;}return result;};
  const query=f.query(p,'UDisplayLifecycle');await until(()=>entered);await f.embedding.removeCredential({configFingerprint:f.revision()});release();
  const revoked=await query;assert.equal(revoked.retrievalMode,'base');assert.ok(revoked.memory.relevantDocs.length);assert.equal(f.calls.length,before);
  f.embedding.jobs.runVector=run;await f.configure();
  f.serverState.onQuery=()=>{f.config.embeddingEnabled=false;f.embedding.configurationChanged();};
  const disabled=await f.query(p,'UDisplayLifecycle');assert.equal(disabled.retrievalMode,'base');assert.ok(disabled.memory.relevantDocs.length);assert.equal(f.calls.length,before+1);assert.equal(f.embedding.queries.cache.size,0);
});

test('M4 rate limits, provider dimension changes and timeouts preserve lexical evidence with a single bounded attempt',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);
  const original=f.serverState.vector;
  for(const failure of ['rate','dimension','timeout']){
    f.serverState.status=failure==='rate'?429:200;f.serverState.vector=failure==='dimension'?()=>[1]:original;f.serverState.wait=failure==='timeout'?1600:0;f.config.embeddingTimeoutMs=1000;f.embedding.configurationChanged();
    const count=f.calls.length,result=await f.query(p,'UDisplayLifecycle');assert.equal(result.retrievalMode,'base');assert.ok(result.memory.relevantDocs.length);assert.equal(f.calls.length,count+1);assert.ok(result.degradedReasons.some(code=>/^EMBEDDING_/.test(code)));
  }
});

test('M4 per-project semantic switch preserves the base index; changed source scope during a request rejects old evidence',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await f.configure();await f.build(p);const before=f.calls.length;
  p.policy.memory.semanticRetrieval=false;await writeFile(path.join(p.dir,'ProjectMemory.project.json'),JSON.stringify(p.policy));
  const result=await f.query(p,'UDisplayLifecycle');assert.equal(result.retrievalMode,'base');assert.ok(result.memory.relevantDocs.length);assert.equal(f.calls.length,before);assert.equal((await f.embedding.status({projectHandle:p.handle})).retrievalMode,'base');
  delete p.policy.memory.semanticRetrieval;await writeFile(path.join(p.dir,'ProjectMemory.project.json'),JSON.stringify(p.policy));
  f.serverState.onQuery=async()=>{p.policy.memory.semanticRetrieval=false;await writeFile(path.join(p.dir,'ProjectMemory.project.json'),JSON.stringify(p.policy));};
  const disabled=await f.query(p,'UDisplayLifecycle');assert.equal(disabled.retrievalMode,'base');assert.ok(disabled.memory.relevantDocs.length);assert.ok(disabled.degradedReasons.includes('SEMANTIC_RETRIEVAL_DISABLED'));assert.equal(f.calls.length,before+1);
  delete p.policy.memory.semanticRetrieval;await writeFile(path.join(p.dir,'ProjectMemory.project.json'),JSON.stringify(p.policy));
  f.serverState.onQuery=async()=>{p.policy.sourcePolicy={excludePatterns:['**/power.md']};await writeFile(path.join(p.dir,'ProjectMemory.project.json'),JSON.stringify(p.policy));};
  await assert.rejects(f.query(p,'车醒了但屏幕不亮'),{code:'PROJECT_POLICY_CHANGED'});
});
