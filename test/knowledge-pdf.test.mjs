import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {cp,readFile,writeFile} from 'node:fs/promises';
import {retrievalFixture,put} from './helpers/retrieval-fixture.mjs';
import {runKnowledgeWorker} from '../src/knowledge-jobs.mjs';

const fixtureRoot=new URL('../unreal/DSHUnrealBridge/Tools/test/fixtures/pdf/',import.meta.url);
const call=(f,p,tool,args)=>f.knowledge.query(p.agent,{tool,arguments:args,backend:'local'});

test('PDF isolated packaged Worker indexes, retrieves and reads physical-page citations with zero network attempts',async t=>{
  const f=await retrievalFixture(t),p=await f.project();
  for(const name of ['pages.pdf','scan.pdf','password.pdf','damaged.pdf'])await cp(new URL(name,fixtureRoot),path.join(p.dir,'ProjectKnowledge',name));
  const source=process.env.DSH_EMBEDDING_TEST_PACKAGE?path.join(process.env.DSH_EMBEDDING_TEST_PACKAGE,'lib/knowledge-worker.js'):new URL('../lib/knowledge-worker.js',import.meta.url);
  const bundle=path.join(f.root,'standalone-worker.mjs'),wrapper=path.join(f.root,'offline.mjs');await cp(source,bundle);
  await put(wrapper,`import http from 'node:http';import https from 'node:https';import net from 'node:net';import {parentPort} from 'node:worker_threads';
let attempts=0;const denied=()=>{attempts++;throw Error('Network forbidden');};globalThis.fetch=denied;http.request=denied;http.get=denied;https.request=denied;https.get=denied;net.Socket.prototype.connect=denied;
const post=parentPort.postMessage.bind(parentPort);parentPort.postMessage=m=>{if(m.response)m.response.result.networkAttempts=attempts;post(m);};await import(${JSON.stringify(pathToFileURL(bundle).href)});`);
  const run=(data,options)=>runKnowledgeWorker(data,{...options,workerUrl:pathToFileURL(wrapper)});f.knowledge.runWorker=run;f.knowledge.jobs.runWorker=run;
  const built=await f.build(p,{vector:false});assert.equal(built.job.result.networkAttempts,0);
  for(const code of ['pdf_needs_ocr_or_blank','pdf_password_required','pdf_parse_failed'])assert.ok(built.job.result.warnings.some(w=>w.includes(code)),code);
  for(const [query,page] of [['FirstPageMarker',1],['LaterPageMarker',4],['RotatedPageMarker',5]]){
    const context=await f.query(p,query),hit=context.memory.relevantDocs.find(d=>d.path==='ProjectKnowledge/pages.pdf');assert.ok(hit,query);
    assert.equal(context.networkAttempts,0);assert.equal(context.retrievalMode,'base');assert.equal(hit.location.kind,'pdf');assert.equal(hit.location.page,page);assert.equal(hit.metadata.pdf.pageCount,5);
    const read=await call(f,p,'read_chunk',{chunkId:hit.chunkId,expectedHash:hit.sourceHash});assert.equal(read.networkAttempts,0);assert.ok(read.content.includes(query));assert.equal(read.location.page,page);
    const document=await call(f,p,'read_document',{documentId:hit.documentId,maxChunks:1});assert.equal(document.networkAttempts,0);assert.equal(document.chunks[0].location.page,1);assert.ok(document.nextOffset>0);
  }
  const absent=await f.query(p,'ScannedOnlyMarker');assert.equal(absent.memory.relevantDocs.length,0);assert.ok(absent.warnings.some(w=>w.includes('需要 OCR')));assert.equal(f.calls.length,0);
  const hit=(await f.query(p,'FirstPageMarker')).memory.relevantDocs[0];await writeFile(path.join(p.dir,'ProjectKnowledge/pages.pdf'),await readFile(new URL('scan.pdf',fixtureRoot)));
  await assert.rejects(call(f,p,'read_chunk',{chunkId:hit.chunkId}),{code:'source_changed'});
});

test('PDF text joins explicitly requested vector indexing and keeps page citations through hybrid retrieval',async t=>{
  const f=await retrievalFixture(t),p=await f.project();await cp(new URL('pages.pdf',fixtureRoot),path.join(p.dir,'ProjectKnowledge/pages.pdf'));
  await f.configure();await f.build(p);
  assert.ok(f.calls.some(call=>call.input.some(text=>text.includes('LaterPageMarker'))));assert.ok(f.calls.every(call=>call.input.every(text=>!text.includes('%PDF-')&&!text.includes('ScannedOnlyMarker'))));
  const context=await f.query(p,'LaterPageMarker'),hit=context.memory.relevantDocs.find(d=>d.path==='ProjectKnowledge/pages.pdf');assert.ok(hit);assert.equal(hit.location.page,4);assert.equal(hit.location.pageLabel,'2');assert.equal(hit.metadata.pdf.ocrStatus,'not_performed');
  const read=await call(f,p,'read_chunk',{chunkId:hit.chunkId,expectedHash:hit.sourceHash});assert.match(read.content,/LaterPageMarker/);
  const before=f.calls.length;await f.build(p);assert.equal(f.calls.length,before);
});
