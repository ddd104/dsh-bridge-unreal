import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm,cp,symlink} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {KnowledgeService} from '../src/knowledge-service.mjs';
import {UnrealBridge} from '../src/bridge.mjs';
import {EmbeddingService} from '../src/embedding-service.mjs';
import {EmbeddingCredentials,embeddingCredentialId} from '../src/embedding-credentials.mjs';
import {embeddingProfile} from '../src/embedding-profile.mjs';
import {EMBEDDING_DEFAULTS,embeddingEndpoint} from '../src/embedding-spec.mjs';
import {requestEmbeddings,validateVectors,CONNECTION_TEST_TEXT} from '../src/embedding-provider.mjs';
import {runEmbeddingWorker as vectorWorker} from '../src/embedding-jobs.mjs';
import {runKnowledgeWorker as baseWorker} from '../src/knowledge-jobs.mjs';
import {DatabaseSync} from 'node:sqlite';
import {TYPERT} from '../src/remote.mjs';

const secret='test-key-embedding-12345';
// Point this at an extracted release's package directory to exercise the exact
// bundled workers with the same isolation, cancellation and cache assertions.
const workerOptions=(name,options)=>({...options,...(process.env.DSH_EMBEDDING_TEST_PACKAGE?{workerUrl:pathToFileURL(path.resolve(process.env.DSH_EMBEDDING_TEST_PACKAGE,'lib',name))}:{})});
const runEmbeddingWorker=(data,options)=>vectorWorker(data,workerOptions('embedding-worker.js',options));
const runKnowledgeWorker=(data,options)=>baseWorker(data,workerOptions('knowledge-worker.js',options));
const terminal=new Set(['succeeded','failed','cancelled','interrupted']);
async function put(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);}
function hostCredentials(){const records=new Map();return {records,readRecord:async key=>records.get(key),describeRecord:async key=>({configured:records.has(key),writable:true}),modifyRecord:async(key,mutate)=>{const next=await mutate(records.get(key));if(next)records.set(key,next);},deleteRecord:async key=>{records.delete(key);}};}
function localFS(){return {
  async resolve(file){return {displayPath:path.resolve(file),targetKey:`local:${path.resolve(file)}`};},processPath:target=>target.displayPath,processPathFromHostPath:file=>file,
  async stat(target){try{const s=await stat(target.displayPath);return {type:s.isDirectory()?'directory':s.isFile()?'file':'other'};}catch(error){if(error.code==='ENOENT')return;throw error;}},
  async listDir(target){return (await readdir(target.displayPath,{withFileTypes:true})).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':entry.isFile()?'file':'other'}));}
};}
async function fakeProvider(t){
  const calls=[],state={mode:'ok',wait:0,dimensions:4,onRequest:null};
  const server=createServer(async(request,response)=>{
    let raw='';for await(const part of request)raw+=part;
    const body=JSON.parse(raw);calls.push({url:request.url,authorization:request.headers.authorization,body});
    await state.onRequest?.(body);if(state.wait)await delay(state.wait);
    if(state.mode!=='ok'){response.writeHead(Number(state.mode),{'content-type':'application/json'});response.end(JSON.stringify({error:{message:`do not expose ${secret}`}}));return;}
    const dimensions=body.dimensions??state.dimensions;
    const data=body.input.map((input,index)=>{const hash=createHash('sha256').update(input).digest();return {index,embedding:Array.from({length:dimensions},(_,i)=>hash[i%hash.length]/255+0.01)};}).reverse();
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:body.model,data,usage:{prompt_tokens:body.input.length*10,total_tokens:body.input.length*10}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {calls,state,url:`http://127.0.0.1:${server.address().port}/v1`};
}
async function fixture(t,{provider,runVector=runEmbeddingWorker,runBase=runKnowledgeWorker}={}){
  const root=await mkdtemp(path.join(tmpdir(),'DSH M3 中文 ')),stateDir=path.join(root,'state'),fs=localFS(),credentials=hostCredentials(),workspaces=new Map();
  const config={...EMBEDDING_DEFAULTS,embeddingBaseUrl:provider?.url??'',embeddingModel:'test-model',embeddingBatchSize:2,embeddingConcurrency:1};
  const services={fs,credentials,workingDirectory:{ensure:async agent=>workspaces.get(agent.session.id)}};
  const bridge=new UnrealBridge({stateDir,port:0});const knowledge=new KnowledgeService({getService:name=>services[name],bridge,stateDir,runWorker:runKnowledgeWorker});
  const create=()=>new EmbeddingService({knowledge,stateDir,getService:name=>services[name],getConfig:()=>({...config}),runVector,runBase});
  let embedding=create();
  t.after(async()=>{await embedding.dispose();await knowledge.dispose();assert.ok(path.relative(tmpdir(),root)&&!path.relative(tmpdir(),root).startsWith('..'));await rm(root,{recursive:true,force:true});});
  async function project(name='Project'){
    const dir=path.join(root,name),agent={session:{id:randomUUID()}};workspaces.set(agent.session.id,dir);
    await put(path.join(dir,'Example.uproject'),'{}');
    await put(path.join(dir,'ProjectMemory.project.json'),JSON.stringify({schemaVersion:1,projectId:'$project',knowledgeRoots:['ProjectKnowledge'],memoryOutputRoot:'.ai/memory',graph:{enabled:false,mode:'sqlite'},memory:{chunking:{targetChars:120,overlapChars:0,maxChars:240}}}));
    await put(path.join(dir,'ProjectKnowledge/a.md'),'# First\nAlpha stable text.\n\n## Second\nBeta original text.');
    await put(path.join(dir,'ProjectKnowledge/copy-one.md'),'# Shared\nIdentical input text.');await put(path.join(dir,'ProjectKnowledge/copy-two.md'),'# Shared\nIdentical input text.');
    await put(path.join(dir,'Docs/private.md'),'# Excluded\nDoNotUploadSelectedRootMarker');
    const [context]=(await knowledge.projects(agent)).projects;return {dir,agent,context,handle:context.projectHandle};
  }
  async function finish(p,job){for(let i=0;i<500;i++){const status=await embedding.status({projectHandle:p.handle,jobId:job.jobId});if(terminal.has(status.job.status))return status;await delay(20);}assert.fail('embedding job did not finish');}
  const revision=()=>embeddingProfile(config).configFingerprint;
  const configure=async()=>{config.embeddingEnabled=true;await embedding.setCredential({configFingerprint:revision(),apiKey:secret});};
  const start=(p,extra={})=>embedding.build({projectHandle:p.handle,requestId:randomUUID(),configFingerprint:revision(),mode:'update',roots:['ProjectKnowledge'],...extra});
  const build=async(p,extra={})=>{const status=await finish(p,await start(p,extra));assert.equal(status.job.status,'succeeded',JSON.stringify(status));return status;};
  return {root,stateDir,config,credentials,services,knowledge,bridge,project,revision,configure,start,build,finish,get embedding(){return embedding;},async restart(){await embedding.dispose();embedding=create();}};
}

test('M3 endpoint/profile validation separates credentials and model spaces',()=>{
  assert.equal(embeddingEndpoint('https://example.test/v1/'),'https://example.test/v1/embeddings');assert.equal(embeddingEndpoint('https://example.test/v1/embeddings'),'https://example.test/v1/embeddings');
  for(const url of ['http://example.test/v1','https://user:pass@example.test','https://example.test?key=secret','https://example.test/chat/completions'])assert.throws(()=>embeddingEndpoint(url));
  const config={...EMBEDDING_DEFAULTS,embeddingBaseUrl:'https://example.test/v1',embeddingModel:'one'},one=embeddingProfile(config),two=embeddingProfile({...config,embeddingModel:'two'});
  assert.notEqual(one.spaceFingerprint,two.spaceFingerprint);assert.equal(one.spaceFingerprint,embeddingProfile({...config,embeddingBatchSize:1}).spaceFingerprint);assert.notEqual(one.configFingerprint,embeddingProfile({...config,embeddingBatchSize:1}).configFingerprint);
  assert.notEqual(embeddingCredentialId(one),embeddingCredentialId(embeddingProfile({...config,embeddingBaseUrl:'https://other.test/v1'})));
  assert.throws(()=>embeddingProfile({...config,embeddingProfileId:'not valid'}),{code:'EMBEDDING_CONFIG_INVALID'});
});

test('M3 response validation enforces indices, dimensions, finite nonzero vectors and sanitizes provider errors',async()=>{
  const result=validateVectors({data:[{index:1,embedding:[0,2]},{index:0,embedding:[2,0]}]},2,2);assert.deepEqual([...result.vectors[0]],[1,0]);
  for(const data of [[{index:0,embedding:[1]},{index:0,embedding:[1]}],[{index:0,embedding:[NaN,1]}],[{index:0,embedding:[0,0]}],[{index:1,embedding:[1,2]}]])assert.throws(()=>validateVectors({data},data.length,2));
  const profile=embeddingProfile({...EMBEDDING_DEFAULTS,embeddingEnabled:true,embeddingBaseUrl:'https://example.test/v1',embeddingModel:'test'});let attempts=0;
  await assert.rejects(requestEmbeddings(profile,secret,['test'],{onAttempt:()=>attempts++,fetchImpl:async()=>new Response(JSON.stringify({error:{message:secret}}),{status:401})}),error=>error.code==='EMBEDDING_AUTH_FAILED'&&!error.message.includes(secret));assert.equal(attempts,1);
  attempts=0;await assert.rejects(requestEmbeddings(profile,secret,['test'],{onAttempt:()=>attempts++,sleep:async()=>{},fetchImpl:async()=>new Response('{}',{status:429})}),{code:'EMBEDDING_RATE_LIMIT'});assert.equal(attempts,3);
});

test('M3 opening settings, saving configuration/key and base queries never call Embedding; test sends one fixed text',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();
  await f.embedding.status();await f.embedding.status({projectHandle:p.handle});
  await assert.rejects(f.start(p),{code:'EMBEDDING_DISABLED'});await f.configure();await f.embedding.status();
  await f.knowledge.query(p.agent,{tool:'project_context',arguments:{query:'Alpha'}});assert.equal(provider.calls.length,0);
  const args={requestId:randomUUID(),configFingerprint:f.revision()},[a,b]=await Promise.all([f.embedding.test(args),f.embedding.test(args)]);assert.deepEqual(a,b);assert.equal(a.dimensions,4);assert.equal(provider.calls.length,1);assert.deepEqual(provider.calls[0].body.input,[CONNECTION_TEST_TEXT]);
  assert.equal(provider.calls[0].authorization,`Bearer ${secret}`);assert.ok(!JSON.stringify(await f.embedding.status()).includes(secret));
});

test('M3 manual build publishes with scope and deduplicated input cache; unchanged, edited and deleted inputs cost only misses',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();
  const first=await f.build(p);assert.equal(first.index.coverage,1);assert.equal(first.index.chunksIndexed,4);assert.equal(first.index.uniqueInputs,3);assert.equal(first.job.embeddingRequests,2);
  assert.ok(!JSON.stringify(provider.calls).includes('DoNotUploadSelectedRootMarker'));assert.ok(!JSON.stringify(first).includes(secret));
  const before=provider.calls.length,second=await f.build(p);assert.equal(provider.calls.length,before);assert.equal(second.job.embeddingRequests,0);assert.equal(second.job.cachedInputs,3);assert.notEqual(second.index.generation,first.index.generation);
  await put(path.join(p.dir,'ProjectKnowledge/a.md'),'# First\nAlpha stable text.\n\n## Second\nBeta changed text.');
  const third=await f.build(p);assert.equal(third.job.embeddingRequests,1);assert.equal(provider.calls.length,before+1);assert.equal(provider.calls.at(-1).body.input.length,1);
  await rm(path.join(p.dir,'ProjectKnowledge/copy-one.md'));const fourth=await f.build(p);assert.equal(fourth.index.chunksIndexed,3);assert.equal(fourth.job.embeddingRequests,0);
  const current=await f.knowledge.jobs.current(p.context),search=await runEmbeddingWorker({action:'search',project:p.context,cache:current.cache,profile:embeddingProfile(f.config),queryVector:[1,0,0,0]});assert.ok(search.results.length);assert.ok(search.results.every(hit=>hit.sourceStatus==='current'&&hit.documentId&&hit.chunkId));
  assert.equal((await f.knowledge.query(p.agent,{tool:'project_context',arguments:{query:'Alpha'}})).knowledgeBackend,'dsh_local');
  const rebuilt=await f.build(p,{mode:'rebuild'});assert.equal(rebuilt.job.embeddingRequests,0);
});

test('M3 failed and cancelled batches keep old index and resume from durable successes; restart never sends requests',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();const initial=await f.build(p);
  await put(path.join(p.dir,'ProjectKnowledge/new.md'),'# New one\nNew vector A.\n\n## New two\nNew vector B.\n\n## New three\nNew vector C.');f.config.embeddingBatchSize=1;
  let newCalls=0;provider.state.onRequest=()=>{if(++newCalls===2)provider.state.mode='401';};
  const failed=await f.finish(p,await f.start(p));assert.equal(failed.job.status,'failed');assert.equal(failed.job.error.code,'EMBEDDING_AUTH_FAILED');assert.equal(failed.index.generation,initial.index.generation);assert.equal(failed.job.completedInputs,4);
  const count=provider.calls.length;await f.restart();await f.embedding.status({projectHandle:p.handle});assert.equal(provider.calls.length,count);
  provider.state.mode='ok';provider.state.onRequest=null;
  const resumed=await f.finish(p,await f.embedding.resume({projectHandle:p.handle,jobId:failed.job.jobId,requestId:randomUUID(),configFingerprint:f.revision()}));assert.equal(resumed.job.status,'succeeded');assert.equal(resumed.job.embeddingRequests,2);assert.equal(resumed.job.previousRequests,2);
  await put(path.join(p.dir,'ProjectKnowledge/cancel.md'),'# Cancel\nCancellable new input');provider.state.wait=1000;
  const job=await f.start(p);while(provider.calls.length===count+2)await delay(20);
  const cancelled=await f.embedding.cancel({projectHandle:p.handle,jobId:job.jobId});assert.equal(cancelled.status,'cancelled');assert.equal((await f.embedding.status({projectHandle:p.handle})).index.generation,resumed.index.generation);
});

test('M3 duplicate clicks, project lock, profile changes, missing keys and invalid scope cannot create extra paid work',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();provider.state.wait=50;
  const requestId=randomUUID(),[one,two]=await Promise.all([f.start(p,{requestId}),f.start(p,{requestId})]);assert.equal(one.jobId,two.jobId);
  await assert.rejects(f.knowledge.build({projectHandle:p.handle,requestId:randomUUID()}),{code:'KNOWLEDGE_BUSY'});await assert.rejects(f.start(p,{roots:['../outside']}),{code:'EMBEDDING_SCOPE_INVALID'});await f.finish(p,one);const count=provider.calls.length;
  await f.embedding.setCredential({configFingerprint:f.revision(),apiKey:'rotated-test-key'});await f.build(p);assert.equal(provider.calls.length,count);
  f.config.embeddingModel='other-model';f.embedding.configurationChanged();assert.equal((await f.embedding.status({projectHandle:p.handle})).indexCompatible,false);await f.build(p);assert.ok(provider.calls.length>count);
  await f.embedding.removeCredential({configFingerprint:f.revision()});await assert.rejects(f.start(p),{code:'EMBEDDING_KEY_MISSING'});
  await assert.rejects(f.embedding.build({projectHandle:p.handle,requestId:randomUUID(),configFingerprint:'0'.repeat(64),roots:['ProjectKnowledge']}),{code:'EMBEDDING_CONFIG_CHANGED'});
});

test('M3 sources changed during cloud requests never publish and retained vectors are not current evidence',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();const initial=await f.build(p);
  await put(path.join(p.dir,'ProjectKnowledge/new.md'),'# New\nNewVector');provider.state.onRequest=async()=>{await put(path.join(p.dir,'ProjectKnowledge/a.md'),'# Changed while calculating');};
  const failed=await f.finish(p,await f.start(p));assert.equal(failed.job.status,'failed');assert.equal(failed.index.generation,initial.index.generation);
  const current=await f.knowledge.jobs.current(p.context),search=await runEmbeddingWorker({action:'search',project:p.context,cache:current.cache,profile:embeddingProfile(f.config),queryVector:[1,0,0,0]});assert.ok(!search.results.some(hit=>hit.path==='ProjectKnowledge/a.md'));assert.ok(search.warnings.some(w=>w.path==='ProjectKnowledge/a.md'));
});

test('M3 encrypted Windows fallback round-trips without plaintext files; host credential failures do not echo secrets',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'DSH M3 credentials '));t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=embeddingProfile({...EMBEDDING_DEFAULTS,embeddingBaseUrl:'https://example.test/v1'});
  if(process.platform==='win32'){
    const credentials=new EmbeddingCredentials({stateDir:root,getService:()=>undefined});await credentials.set(profile,secret);assert.equal(await credentials.read(profile),secret);assert.equal((await credentials.describe(profile)).credentialBackend,'windows_dpapi');assert.ok(!(await readFile(credentials.file(profile),'utf8')).includes(secret));await credentials.remove(profile);assert.equal((await credentials.describe(profile)).credentialConfigured,false);
  }
  const service=hostCredentials();service.modifyRecord=async()=>{throw Error(secret);};const credentials=new EmbeddingCredentials({stateDir:root,getService:()=>service});await assert.rejects(credentials.set(profile,secret),error=>!error.message.includes(secret));
});

test('M3 all charged and credential actions use explicit global remote contracts, never ordinary model tools',()=>{
  for(const method of ['embeddingStatus','embeddingTest','embeddingSetCredential','embeddingRemoveCredential','embeddingBuild','embeddingCancel','embeddingResume']){
    const descriptor=TYPERT.invocations.find(item=>item.method===method);assert.ok(descriptor);assert.equal(descriptor.scope,undefined);assert.ok(descriptor.parameters.every(parameter=>parameter.source!=='lookup'));
  }
});

test('M3 config disable and credential removal stop active batches and never publish the in-flight generation',async t=>{
  for(const action of ['disable','remove']){
    const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();const old=await f.build(p);
    await put(path.join(p.dir,'ProjectKnowledge/new.md'),'# One\nChanged first.\n\n## Two\nChanged second.');f.config.embeddingBatchSize=1;
    let received;const request=new Promise(resolve=>{received=resolve;});provider.state.wait=1500;provider.state.onRequest=()=>received();
    const before=provider.calls.length,job=await f.start(p);await request;
    if(action==='disable'){f.config.embeddingEnabled=false;f.embedding.configurationChanged();}else await f.embedding.removeCredential({configFingerprint:f.revision()});
    const stopped=await f.finish(p,job);assert.equal(stopped.job.status,'failed');assert.equal(stopped.index.generation,old.index.generation);assert.equal(provider.calls.length,before+1);
    assert.ok(['EMBEDDING_CONFIG_CHANGED','EMBEDDING_CREDENTIAL_CHANGED'].includes(stopped.job.error.code));
  }
});

test('M3 overlapping projects have isolated caches and a two-job limit; conflicting concurrent request IDs are rejected',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const provider=await fakeProvider(t),f=await fixture(t,{provider,runBase:async(data,options)=>{if(data.request.tool==='project_update')await gate;return runKnowledgeWorker(data,options);}});
  t.after(()=>release());const a=await f.project('A'),b=await f.project('B'),c=await f.project('C');await f.configure();
  const requestId=randomUUID(),requests=await Promise.allSettled([f.start(a,{requestId}),f.start(a,{requestId,mode:'rebuild'})]);assert.equal(requests.filter(r=>r.status==='fulfilled').length,1);assert.equal(requests.find(r=>r.status==='rejected').reason.code,'EMBEDDING_REQUEST_CONFLICT');
  const jobA=requests.find(r=>r.status==='fulfilled').value,jobB=await f.start(b);await assert.rejects(f.start(c),{code:'KNOWLEDGE_BUSY'});
  release();const [one,two]=await Promise.all([f.finish(a,jobA),f.finish(b,jobB)]);assert.equal(one.job.status,'succeeded');assert.equal(two.job.status,'succeeded');assert.notEqual(one.index.projectId,two.index.projectId);assert.equal(provider.calls.length,4);
  await assert.rejects(f.embedding.status({projectHandle:c.handle,jobId:jobA.jobId}),{code:'JOB_NOT_FOUND'});
});

test('M3 request cap checkpoints, dead-host status and explicit resume reuse successful vectors without restart calls',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();f.config.embeddingMaxRequests=1;f.config.embeddingBatchSize=2;
  const failed=await f.finish(p,await f.start(p));assert.equal(failed.job.error.code,'EMBEDDING_REQUEST_LIMIT');assert.equal(provider.calls.length,1);assert.equal(failed.job.completedInputs,2);
  const root=f.embedding.jobs.root(p.context),record={...failed.job,pid:2147483647,status:'running',phase:'embedding'};await f.restart();
  await writeFile(path.join(root,'jobs',record.jobId+'.json'),JSON.stringify(record));await writeFile(path.join(root,'latest-job.json'),JSON.stringify(record));
  assert.equal((await f.embedding.status({projectHandle:p.handle})).job.status,'interrupted');assert.equal(provider.calls.length,1);
  const resumed=await f.finish(p,await f.embedding.resume({projectHandle:p.handle,jobId:record.jobId,requestId:randomUUID(),configFingerprint:f.revision()}));assert.equal(resumed.job.status,'succeeded');assert.equal(provider.calls.length,2);assert.equal(resumed.job.cachedInputs,2);
  for(const file of [path.join(root,'latest-job.json'),path.join(root,'vectors.sqlite'),path.join((await f.knowledge.jobs.current(p.context)).cache,'vector-manifest.json')])assert.equal((await readFile(file)).includes(Buffer.from(secret)),false);
});

test('M3 policy changes before cloud work stop upload; corrupted cache entries recompute while damaged published vectors leave base queries usable',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();await f.build(p);
  const cache=path.join(f.embedding.jobs.root(p.context),'vectors.sqlite'),db=new DatabaseSync(cache);db.exec("UPDATE vectors SET hash='corrupt' WHERE inputHash=(SELECT inputHash FROM vectors LIMIT 1)");db.close();
  assert.equal((await f.build(p)).job.embeddingRequests,1);
  await writeFile(cache,'invalid cache sqlite');const repaired=await f.build(p);assert.equal(repaired.job.embeddingRequests,2);assert.equal(repaired.job.cacheRecovered,true);assert.ok((await readdir(path.dirname(cache))).some(file=>file.startsWith('vectors.sqlite.corrupt-')));
  const current=await f.knowledge.jobs.current(p.context);await writeFile(path.join(current.cache,'Memory/index/vector.sqlite'),'invalid sqlite');
  await assert.rejects(runEmbeddingWorker({action:'search',project:p.context,cache:current.cache,profile:embeddingProfile(f.config),queryVector:[1,0,0,0]}));assert.equal((await f.knowledge.query(p.agent,{tool:'project_context',arguments:{query:'Alpha'}})).knowledgeBackend,'dsh_local');
  let done;const entered=new Promise(resolve=>{done=resolve;});let release;const gate=new Promise(resolve=>{release=resolve;});
  f.embedding.jobs.runBase=async(data,options)=>{const result=await runKnowledgeWorker(data,options);if(data.request.tool==='project_update'){done();await gate;}return result;};
  const before=provider.calls.length,job=await f.start(p);await entered;
  const file=path.join(p.dir,'ProjectMemory.project.json'),policy=JSON.parse(await readFile(file,'utf8'));policy.sourcePolicy={excludePatterns:['**/a.md']};await writeFile(file,JSON.stringify(policy));release();
  const stopped=await f.finish(p,job);assert.equal(stopped.job.error.code,'EMBEDDING_SCOPE_CHANGED');assert.equal(provider.calls.length,before);
});

test('M3 provider bounds malformed JSON, redirects, timeouts and retry success without exposing upstream text',async()=>{
  const profile=embeddingProfile({...EMBEDDING_DEFAULTS,embeddingEnabled:true,embeddingBaseUrl:'https://example.test/v1',embeddingModel:'test'});
  for(const body of ['not-json',JSON.stringify({data:[]}),JSON.stringify({data:[{index:0,embedding:[1]},{index:1,embedding:[1]}]})])await assert.rejects(requestEmbeddings(profile,secret,['test'],{fetchImpl:async()=>new Response(body)}),{code:'EMBEDDING_RESPONSE_INVALID'});
  let calls=0;const result=await requestEmbeddings(profile,secret,['test'],{sleep:async()=>{},fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');calls++;return calls===1?new Response('{}',{status:429}):new Response(JSON.stringify({data:[{index:0,embedding:[1,0]}]}));}});assert.equal(result.dimensions,2);assert.equal(calls,2);
  await assert.rejects(requestEmbeddings({...profile,timeoutMs:15},secret,['test'],{maxRetries:0,fetchImpl:async(_url,{signal})=>delay(1000,undefined,{signal})}),{code:'EMBEDDING_TIMEOUT'});
});

test('real fetch timeout survives worker cancellation, preserves earlier vectors and resumes only missing inputs',async t=>{
  const provider=await fakeProvider(t),f=await fixture(t,{provider}),p=await f.project();await f.configure();
  f.config.embeddingBatchSize=1;f.config.embeddingConcurrency=2;f.config.embeddingTimeoutMs=1000;
  provider.state.onRequest=async()=>{if(provider.calls.length>=3)await delay(1500);};
  const stopped=await f.finish(p,await f.start(p));
  assert.equal(stopped.job.status,'failed');assert.equal(stopped.job.error.code,'EMBEDDING_TIMEOUT');assert.equal(stopped.job.failureStage,'embedding');
  assert.equal(stopped.job.error.details.attempts,3);assert.equal(stopped.job.error.details.timeoutMs,1000);assert.equal(stopped.job.completedInputs,2);
  assert.match(stopped.job.error.message,/1 秒.*3 次/);assert.equal(stopped.index,null);
  provider.state.onRequest=null;const before=provider.calls.length;
  const resumed=await f.finish(p,await f.embedding.resume({projectHandle:p.handle,jobId:stopped.job.jobId,requestId:randomUUID(),configFingerprint:f.revision()}));
  assert.equal(resumed.job.status,'succeeded');assert.equal(resumed.job.cachedInputs,2);assert.equal(provider.calls.length-before,1);
});
