import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readFile,readdir,stat,writeFile,rm,cp,symlink} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
import {KnowledgeService} from '../src/knowledge-service.mjs';
import {runKnowledgeWorker} from '../src/knowledge-jobs.mjs';
import {UnrealBridge} from '../src/bridge.mjs';
import {apply} from '../src/index.mjs';
import {TYPERT} from '../src/remote.mjs';
import {hostKnowledgeSchema,hostDocumentToolNames} from '../src/knowledge-protocol.mjs';
import {knowledgeSchema} from '../src/protocol.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['succeeded','failed','cancelled','interrupted']);
async function put(file,text){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
function localFS(){
  return {
    async resolve(file){return {displayPath:path.resolve(file),targetKey:`local:${path.resolve(file)}`};},
    processPath:target=>target.displayPath,processPathFromHostPath:file=>file,
    async stat(target){try{const s=await stat(target.displayPath);return {type:s.isDirectory()?'directory':s.isFile()?'file':'other'};}catch(error){if(error.code==='ENOENT')return;throw error;}},
    async listDir(target){return (await readdir(target.displayPath,{withFileTypes:true})).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':entry.isFile()?'file':'other'}));},
  };
}
async function fixture(t,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'DSH M1 中文 '));
  const stateDir=path.join(root,'state'),fs=localFS(),workspaces=new Map();
  const bridge=new UnrealBridge({stateDir,port:0,allowWrites:false});
  const services={fs,workingDirectory:{ensure:async agent=>workspaces.get(agent.session.id)}};
  const service=new KnowledgeService({getService:name=>services[name],bridge,stateDir,...options});
  t.after(async()=>{await service.dispose();await rm(root,{recursive:true,force:true});});
  async function project(name,marker){
    const dir=path.join(root,name);
    await cp(new URL('../unreal/DSHUnrealBridge/Tools/test/fixtures/knowledge-baseline/project/',import.meta.url),dir,{recursive:true});
    await put(path.join(dir,'Same.uproject'),'{}');
    if(marker)await put(path.join(dir,'ProjectKnowledge','marker.md'),`# ${marker}\n${marker} isolated content\n`);
    const agent={session:{id:randomUUID()}};workspaces.set(agent.session.id,dir);
    const [context]=(await service.projects(agent)).projects;
    return {dir,agent,context,handle:context.projectHandle};
  }
  async function finished(p,job){
    for(let i=0;i<200;i++){
      const status=await service.status({projectHandle:p.handle,jobId:job.jobId});
      if(terminal.has(status.job.status))return status;
      await delay(25);
    }
    assert.fail('Background build did not finish');
  }
  const build=async(p)=>{
    const job=await service.build({projectHandle:p.handle,requestId:randomUUID()});
    const status=await finished(p,job);assert.equal(status.job.status,'succeeded',JSON.stringify(status));return status;
  };
  const query=(p,tool,args={},extra={})=>service.query(p.agent,{tool,arguments:args,...extra});
  const bind=p=>{
    const editorId=randomUUID();bridge.editors.set(editorId,{editorId,project:p.context.name,projectPath:p.context.projectFile,capabilities:['project_knowledge']});
    bridge.bind(p.agent.session.id,editorId);return editorId;
  };
  return {root,stateDir,fs,services,service,bridge,workspaces,project,finished,build,query,bind};
}

test('M1 explicit local build and offline query use documents, graph and source; ordinary queries never build',async t=>{
  const f=await fixture(t),p=await f.project('copy A','AlphaOnly');
  const missing=await f.query(p,'project_status');assert.equal(missing.status,'missing');
  const before=await f.query(p,'project_context',{query:'UDisplayLifecycle'});
  assert.equal(before.memory,null);assert.ok(before.sources.length);assert.equal(before.indexGeneration,null);
  await assert.rejects(stat(f.stateDir),{code:'ENOENT'});
  const built=await f.build(p);
  assert.ok(built.index.generation);assert.equal(built.job.embeddingRequests,0);
  const result=await f.query(p,'project_context',{query:'UDisplayLifecycle'});
  assert.equal(result.knowledgeBackend,'dsh_local');assert.ok(result.memory.relevantDocs.length);assert.ok(result.memory.filesToRead.some(file=>file.endsWith('DisplayLifecycle.h')));
  const graph=await f.query(p,'graph_query',{query:'UDisplayLifecycle'});assert.ok(graph.candidates.length);
  const source=await f.query(p,'read_source',{path:'Source/Baseline/DisplayLifecycle.h'});assert.equal(source.hash,sha(await readFile(path.join(p.dir,source.path))));
  const current=path.join(f.service.jobs.rootFor(p.context),'current.json'),bytes=await readFile(current,'utf8');
  await f.query(p,'project_search',{query:'AlphaOnly'});await f.query(p,'project_context',{query:'AlphaOnly'});
  assert.equal(await readFile(current,'utf8'),bytes);
  assert.equal((await f.query(p,'project_status')).status,'ready');
  assert.ok((await stat(path.join(p.dir,'Plugins','DSHUnrealBridge','Cache','Knowledge',p.context.projectId))).isDirectory());
});

test('M1 work copies and sessions remain isolated; same project sessions share a published generation',async t=>{
  const f=await fixture(t),a=await f.project('A','AlphaOnly'),b=await f.project('B','BetaOnly');
  assert.notEqual(a.handle,b.handle);await f.build(a);await f.build(b);
  assert.equal((await f.query(a,'project_search',{query:'BetaOnly'})).totalMatches,0);
  assert.equal((await f.query(b,'project_search',{query:'AlphaOnly'})).totalMatches,0);
  const peer={session:{id:randomUUID()}};f.workspaces.set(peer.session.id,a.dir);
  const result=await f.service.query(peer,{tool:'project_context',arguments:{query:'AlphaOnly'}});
  assert.equal(result.projectId,a.context.projectId);assert.equal(result.indexGeneration,(await f.service.status({projectHandle:a.handle})).index.generation);
  await assert.rejects(f.query(a,'project_context',{query:'BetaOnly'},{projectHandle:b.handle}),{code:'PROJECT_ACCESS_DENIED'});
});

test('M1 ambiguous workspace or descriptors require explicit handles; nearest child project wins',async t=>{
  const f=await fixture(t),a=await f.project('Workspace/A'),b=await f.project('Workspace/B');
  const agent={session:{id:randomUUID()}};f.workspaces.set(agent.session.id,path.join(f.root,'Workspace'));
  const projects=await f.service.projects(agent);assert.equal(projects.projects.length,2);assert.equal(projects.requiresSelection,true);
  await assert.rejects(f.service.query(agent,{tool:'project_search',arguments:{query:'display'}}),{code:'PROJECT_SELECTION_REQUIRED'});
  assert.equal((await f.service.query(agent,{projectHandle:b.handle,tool:'project_search',arguments:{query:'display'}})).projectId,b.context.projectId);
  await put(path.join(a.dir,'Second.uproject'),'{}');
  assert.equal((await f.service.projects(a.agent)).projects.length,2);
  await assert.rejects(f.query(a,'project_status'),{code:'PROJECT_SELECTION_REQUIRED'});
  const nested=await f.project('Workspace/A/Nested');
  await mkdir(path.join(nested.dir,'Source','Child'),{recursive:true});f.workspaces.set(nested.agent.session.id,path.join(nested.dir,'Source','Child'));
  assert.equal((await f.service.projects(nested.agent)).projects[0].projectHandle,nested.handle);
});

test('M1 validates editor identity for local, live and retained record requests',async t=>{
  const f=await fixture(t),a=await f.project('A'),b=await f.project('B');let calls=0;
  f.bridge.request=async()=>{calls++;return {legacy:true};};f.bridge.knowledgeRecord=async()=>{calls++;return {saved:true};};
  f.bind(b);f.bridge.bind(a.agent.session.id,f.bridge.sessions.get(b.agent.session.id));
  for(const tool of ['project_context','read_source','inspect_asset','experience_lookup'])await assert.rejects(f.query(a,tool,{query:'test'},{projectHandle:a.handle}),{code:'PROJECT_EDITOR_MISMATCH'});
  assert.equal((await f.service.resolver.resolve(a.agent)).projectHandle,b.handle);
  assert.equal(calls,0);
  f.bind(a);assert.equal((await f.query(a,'project_context',{query:'test'})).knowledgeBackend,'ue_legacy');
  assert.equal((await f.query(a,'asset_snapshot')).legacy,true);assert.equal(calls,2);
  await f.build(a);
  assert.equal((await f.query(a,'project_context',{query:'UDisplayLifecycle'},{backend:'local'})).knowledgeBackend,'dsh_local');
  assert.equal((await f.query(a,'graph_query',{query:'/Game/UI/WBP_PowerStatus'},{backend:'editor'})).legacy,true);
  assert.equal(calls,3);
});

test('M1 missing host mapping keeps legacy contracts; missing local runtime degrades to matching UE',async t=>{
  const f=await fixture(t,{runWorker:async()=>{throw Object.assign(Error('SQLite unavailable'),{code:'KNOWLEDGE_RUNTIME_UNAVAILABLE'});}}),p=await f.project('A');
  f.bind(p);f.bridge.request=async()=>({legacy:true});
  const fallback=await f.query(p,'project_search',{query:'test'});assert.equal(fallback.knowledgeBackend,'ue_legacy');assert.deepEqual(fallback.degradedReasons,['KNOWLEDGE_RUNTIME_UNAVAILABLE']);
  delete f.services.fs;
  assert.equal((await f.query(p,'project_context',{query:'test'})).legacy,true);
  f.bridge.bind(p.agent.session.id,null);await assert.rejects(f.query(p,'project_status'),{code:'NOT_BOUND'});
  f.services.fs=f.fs;f.fs.processPathFromHostPath=()=>'/unverified';
  await assert.rejects(f.service.projects(p.agent),{code:'PROJECT_LOCAL_UNAVAILABLE'});
});

test('M1 duplicate clicks share one task; cancellation preserves old generation and restart never starts work',async t=>{
  const f=await fixture(t),p=await f.project('A');await f.build(p);
  const old=(await f.service.status({projectHandle:p.handle})).index.generation;
  let starts=0;
  f.service.jobs.runWorker=(_data,{signal})=>new Promise((_resolve,reject)=>{starts++;signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'CANCELLED'})),{once:true});});
  const args={projectHandle:p.handle,requestId:randomUUID()};
  const [first,second]=await Promise.all([f.service.build(args),f.service.build(args)]);assert.equal(first.jobId,second.jobId);
  while(!starts)await delay(10);
  await assert.rejects(f.service.build({...args,requestId:randomUUID()}),{code:'KNOWLEDGE_BUSY'});
  assert.equal((await f.query(p,'graph_query',{query:'UDisplayLifecycle'})).indexGeneration,old);
  assert.equal((await f.service.cancel({projectHandle:p.handle,jobId:first.jobId})).status,'cancelled');
  assert.equal((await f.service.status({projectHandle:p.handle})).index.generation,old);assert.equal(starts,1);
  assert.equal((await f.service.build(args)).status,'cancelled');assert.equal(starts,1);
  await f.service.dispose();
  const fresh=new KnowledgeService({getService:name=>f.services[name],bridge:f.bridge,stateDir:f.stateDir,runWorker:async()=>{starts++;throw Error('unexpected');}});t.after(()=>fresh.dispose());
  await fresh.projects(p.agent);assert.equal((await fresh.status({projectHandle:p.handle,jobId:first.jobId})).job.status,'cancelled');assert.equal(starts,1);
});

test('M1 worker failure does not publish; descriptor revisions keep identity but invalidate an old index',async t=>{
  const f=await fixture(t),p=await f.project('A');await f.build(p);
  const old=(await f.service.status({projectHandle:p.handle})).index.generation;
  f.service.jobs.runWorker=async()=>{throw Error('synthetic build failure');};
  const job=await f.service.build({projectHandle:p.handle,requestId:randomUUID()});const status=await f.finished(p,job);
  assert.equal(status.job.status,'failed');assert.equal(status.index.generation,old);
  await put(p.context.projectFile,'{"revision":2}');
  assert.equal((await f.service.projects(p.agent)).projects[0].projectHandle,p.handle);
  const result=await f.query(p,'project_context',{query:'UDisplayLifecycle'});assert.equal(result.memory,null);assert.equal(result.indexGeneration,null);assert.ok(result.degradedReasons.includes('project_descriptor_changed'));
});

test('M1 in-flight reads reject workspace and editor switches; background builds stay with their original project',async t=>{
  let release,entered;
  const f=await fixture(t,{runWorker:async()=>{entered=true;return new Promise(resolve=>{release=resolve;});}}),a=await f.project('A'),b=await f.project('B');
  const pending=f.query(a,'project_search',{query:'test'});while(!entered)await delay(5);
  f.workspaces.set(a.agent.session.id,b.dir);release({results:[{path:'A'}]});await assert.rejects(pending,{code:'PROJECT_ACCESS_DENIED'});
  f.workspaces.set(a.agent.session.id,a.dir);entered=false;
  const pendingBinding=f.query(a,'project_search',{query:'test'});while(!entered)await delay(5);
  f.bind(a);release({results:[]});await assert.rejects(pendingBinding,{code:'INSTANCE_CHANGED'});
  f.service.jobs.runWorker=runKnowledgeWorker;
  const job=await f.service.build({projectHandle:a.handle,requestId:randomUUID()});f.workspaces.set(a.agent.session.id,b.dir);
  const status=await f.finished(a,job);assert.equal(status.job.status,'succeeded');assert.equal(status.job.projectId,a.context.projectId);
  assert.equal((await f.service.status({projectHandle:b.handle})).index,null);
});

test('M1 unknown or revoked global handles are rejected and global endpoints never guess a session',async t=>{
  const f=await fixture(t),p=await f.project('A');
  await assert.rejects(f.service.build({projectHandle:`project-${'0'.repeat(64)}`,requestId:randomUUID()}),{code:'PROJECT_ACCESS_DENIED'});
  const original=f.fs.stat;f.fs.stat=async()=>undefined;
  await assert.rejects(f.service.status({projectHandle:p.handle}),{code:'PROJECT_ACCESS_DENIED'});
  f.fs.stat=original;
  for(const method of ['knowledgeProjects','knowledgeStatus','knowledgeBuild','knowledgeCancel']){
    const descriptor=TYPERT.invocations.find(item=>item.method===method);assert.ok(descriptor);assert.equal(descriptor.scope,undefined);assert.ok(descriptor.parameters.every(p=>p.source!=='lookup'));
  }
});

test('M1 packaged core runs outside the source checkout and reads binary formats without project tools',async t=>{
  const f=await fixture(t),p=await f.project('A');
  const output=path.join(f.root,'isolated-package');await mkdir(output);
  await cp(process.env.DSH_M1_WORKER_BUNDLE??new URL('../lib/knowledge-worker.js',import.meta.url),path.join(output,'knowledge-worker.mjs'));
  const workerUrl=pathToFileURL(path.join(output,'knowledge-worker.mjs'));
  const cache=path.join(f.service.jobs.rootFor(p.context),'generations',randomUUID());
  await cp(new URL('../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/test/fixtures/docs/ProjectKnowledge/sample.xls',import.meta.url),path.join(p.dir,'ProjectKnowledge','sample.xls'));
  await put(path.join(p.dir,'ProjectKnowledge','signal.proto'),'syntax = "proto3"; message VehicleSignal { string name = 1; }');
  await put(path.join(p.dir,'ProjectKnowledge','wiki.md'),'---\nid: wiki:offline\naliases: [离线唤醒]\nstatus: confirmed\n---\n# Wiki\nOfflineWikiMarker');
  const result=await runKnowledgeWorker({project:p.context,cache,request:{tool:'project_update'}},{workerUrl});
  assert.ok(result.documentsIndexed>=6);assert.ok(!result.warnings.some(w=>w.includes('Skipped')));
  const query=await runKnowledgeWorker({project:p.context,cache,request:{tool:'project_context',arguments:{query:'VehicleSignal'}}},{workerUrl});
  assert.ok(query.memory.relevantDocs.some(doc=>doc.path.endsWith('signal.proto')));
  const wiki=await runKnowledgeWorker({project:p.context,cache,request:{tool:'project_context',arguments:{query:'离线唤醒'}}},{workerUrl});
  const citation=wiki.memory.relevantDocs.find(doc=>doc.path==='ProjectKnowledge/wiki.md');assert.ok(citation);
  const chunk=await runKnowledgeWorker({project:p.context,cache,request:{tool:'read_chunk',arguments:{chunkId:citation.chunkId,expectedHash:citation.sourceHash}}},{workerUrl});assert.match(chunk.content,/OfflineWikiMarker/);assert.equal(chunk.metadata.id,'wiki:offline');
});

test('M1 actual worker build, queries and status make zero network attempts',async t=>{
  const f=await fixture(t),p=await f.project('Offline');
  const wrapper=path.join(f.root,'offline-worker.mjs');
  await put(wrapper,`import http from 'node:http';\nimport https from 'node:https';\nimport net from 'node:net';\nimport {parentPort} from 'node:worker_threads';\nlet attempts=0;const denied=()=>{attempts++;throw Error('Network forbidden in baseline');};\nglobalThis.fetch=denied;http.request=denied;http.get=denied;https.request=denied;https.get=denied;net.Socket.prototype.connect=denied;\nconst post=parentPort.postMessage.bind(parentPort);parentPort.postMessage=message=>{if(message.response)message.response.result.networkAttempts=attempts;post(message);};\nawait import(${JSON.stringify(new URL('../src/knowledge-worker.mjs',import.meta.url).href)});`);
  const workerUrl=pathToFileURL(wrapper),run=(data,options)=>runKnowledgeWorker(data,{...options,workerUrl});
  f.service.runWorker=run;f.service.jobs.runWorker=run;
  assert.equal((await f.build(p)).job.result.networkAttempts,0);
  for(const tool of ['project_context','project_search','project_status','graph_query'])assert.equal((await f.query(p,tool,{query:'UDisplayLifecycle'})).networkAttempts,0);
  const context=await f.query(p,'project_context',{query:'唤醒'}),citation=context.memory.relevantDocs[0];assert.ok(citation);
  for(const tool of ['read_document','read_chunk'])assert.equal((await f.query(p,tool,{documentId:citation.documentId,chunkId:citation.chunkId})).networkAttempts,0);
});

test('M2 host-only document tools round-trip citations offline and reject foreign or changed sources',async t=>{
  const f=await fixture(t),p=await f.project('M2'),other=await f.project('Other');
  for(const tool of hostDocumentToolNames){assert.equal(hostKnowledgeSchema.parse({tool}).tool,tool);assert.equal(knowledgeSchema.safeParse({tool}).success,false);}
  await f.build(p);await f.build(other);
  assert.equal((await f.service.projects(p.agent)).documentCapability,'dsh_document_chunks_v2');
  const context=await f.query(p,'project_context',{query:'唤醒'}),hit=context.memory.relevantDocs.find(d=>d.path.endsWith('power.md'));assert.ok(hit);
  const chunk=await f.query(p,'read_chunk',{chunkId:hit.chunkId,expectedHash:hit.sourceHash});assert.equal(chunk.knowledgeBackend,'dsh_local');assert.equal(chunk.sourceStatus,'current');assert.match(chunk.content,/唤醒/);
  const doc=await f.query(p,'read_document',{documentId:hit.documentId,maxChunks:1});assert.equal(doc.documentId,hit.documentId);assert.equal(doc.chunks[0].chunkId,hit.chunkId);
  await assert.rejects(f.query(other,'read_chunk',{chunkId:hit.chunkId}),{code:'chunk_not_found'});
  await put(path.join(p.dir,hit.path),'# Changed document');await assert.rejects(f.query(p,'read_chunk',{chunkId:hit.chunkId}),{code:'source_changed'});
  const refreshed=await f.query(p,'project_context',{query:'唤醒'});assert.ok(!refreshed.memory.relevantDocs.some(d=>d.path===hit.path));assert.ok(refreshed.warnings.some(w=>w.includes('changed')));
});

test('M2 document readers never fall back to unsupported UE handlers',async t=>{
  const f=await fixture(t),p=await f.project('M2');let calls=0;f.bind(p);f.bridge.request=async()=>{calls++;return {};};
  await assert.rejects(f.query(p,'read_document',{documentId:'doc-'+'0'.repeat(32)}),{code:'KNOWLEDGE_INDEX_REQUIRED'});
  await assert.rejects(f.query(p,'read_chunk',{}, {backend:'editor'}),{code:'KNOWLEDGE_LOCAL_REQUIRED'});
  await f.build(p);f.service.runWorker=async()=>{throw Object.assign(Error('unavailable'),{code:'KNOWLEDGE_RUNTIME_UNAVAILABLE'});};
  await assert.rejects(f.query(p,'read_chunk',{}),{code:'KNOWLEDGE_RUNTIME_UNAVAILABLE'});
  delete f.services.fs;await assert.rejects(f.query(p,'read_document',{}),{code:'KNOWLEDGE_LOCAL_REQUIRED'});assert.equal(calls,0);
});

test('M1 core excludes sources that change during a build and never follows another project Wiki junction',async t=>{
  const f=await fixture(t),p=await f.project('A'),b=await f.project('B');
  const {createKnowledgeCore}=await import('../unreal/DSHUnrealBridge/Tools/knowledge-core.mjs');
  const cache=path.join(f.root,'unpublished',randomUUID());await mkdir(cache,{recursive:true});
  const configPath=path.join(cache,'config.json');await cp(new URL('../unreal/DSHUnrealBridge/Config/Knowledge/ProjectMemory.project.json',import.meta.url),configPath);
  const core=await createKnowledgeCore({project:p.dir,plugin:path.join(p.dir,'Plugins','DSHUnrealBridge'),cache,descriptor:'Same.uproject',identity:p.context.projectId,descriptorHash:p.context.descriptorHash,configPath,
    hostPaths:{projectId:p.context.projectId,memoryRoot:path.join(cache,'Memory'),graphRoot:path.join(cache,'Graph'),ueCacheRoot:path.join(cache,'NoUE')},
    onProgress:progress=>{if(progress.phase==='documents')writeFileSync(path.join(p.dir,'Source','Baseline','DisplayLifecycle.h'),'class UChangedDuringBuild {};');}});
  const response=await core({tool:'project_update'});assert.equal(response.isError,true);assert.equal(response.result.code,'source_changed');
  await assert.rejects(stat(path.join(cache,'identity.json')),{code:'ENOENT'});
  await mkdir(path.join(b.dir,'ProjectKnowledge','overview'),{recursive:true});
  await put(path.join(b.dir,'ProjectKnowledge','overview','project_purpose.md'),'Foreign project private purpose');
  await symlink(path.join(b.dir,'ProjectKnowledge','overview'),path.join(p.dir,'ProjectKnowledge','overview'),'junction');
  const job=await f.service.build({projectHandle:p.handle,requestId:randomUUID()});const status=await f.finished(p,job);
  assert.equal(status.job.status,'failed');assert.equal(status.job.error.code,'source_link_unsupported');assert.equal(status.index,null);
});

test('M1 public tools and global remotes are wired to the service and disposal stops real background work',async t=>{
  const f=await fixture(t),p=await f.project('App');
  const tools=new Map(),services=new Map(),disposers=[];
  const ctx={get:name=>f.services[name],tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},provide:(name,value)=>services.set(name,value),effect:factory=>disposers.push(factory())};
  await apply(ctx,{stateDir:f.stateDir,port:0,allowWrites:false});
  t.after(async()=>{for(const dispose of disposers.reverse())await dispose?.();});
  const remote=services.get('unrealBridge');const editorId=randomUUID();remote.bridge.editors.set(editorId,{editorId,project:p.context.name,projectPath:p.context.projectFile,capabilities:['project_knowledge']});remote.bridge.bind(p.agent.session.id,editorId);
  const exec=(name,args={})=>tools.get(name).execute(args,{name,arguments:args,agent:p.agent,callId:randomUUID(),signal:new AbortController().signal});
  assert.equal((await exec('unreal_knowledge_projects')).projects[0].projectHandle,p.handle);
  assert.equal((await remote.knowledgeProjects()).projects[0].projectHandle,p.handle);
  assert.equal(remote.state(p.agent).knowledge.capability,'dsh_local_knowledge_v1');
  assert.equal((await exec('unreal_knowledge',{tool:'project_search',arguments:{query:'UDisplayLifecycle'}})).knowledgeBackend,'dsh_local');
  await f.build(p);
  const citation=(await exec('unreal_knowledge',{tool:'project_context',arguments:{query:'唤醒'}})).memory.relevantDocs[0];
  for(const tool of hostDocumentToolNames){const read=await exec('unreal_knowledge',{tool,arguments:{documentId:citation.documentId,chunkId:citation.chunkId,expectedHash:citation.sourceHash}});assert.equal(read.sourceStatus,'current');assert.equal(read.documentId,citation.documentId);}
  const response=await exec('unreal_knowledge_build',{projectHandle:p.handle,requestId:randomUUID()});assert.equal(response.ok,true);
  const job=await remote.knowledgeCancel({projectHandle:p.handle,jobId:response.job.jobId});assert.equal(job.status,'cancelled');
  assert.equal((await exec('unreal_knowledge_status',{projectHandle:p.handle,jobId:job.jobId})).job.status,'cancelled');
  const again=await remote.knowledgeBuild({projectHandle:p.handle,requestId:randomUUID()});
  for(const dispose of disposers.reverse())await dispose?.();disposers.length=0;
  const status=await remote.knowledgeStatus({projectHandle:p.handle,jobId:again.jobId});assert.equal(status.job.status,'cancelled');
});

test('M1 concurrent projects respect the global build limit and cache junctions cannot redirect writes',async t=>{
  const runWorker=(_data,{signal})=>{signal.throwIfAborted();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
  const f=await fixture(t,{runWorker}),projects=await Promise.all(['A','B','C'].map(name=>f.project(name)));
  const outcomes=await Promise.allSettled(projects.map(p=>f.service.build({projectHandle:p.handle,requestId:randomUUID()})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'KNOWLEDGE_BUSY');
  await f.service.dispose();
  const fresh=new KnowledgeService({getService:name=>f.services[name],bridge:f.bridge,stateDir:path.join(f.root,'redirect-test')});t.after(()=>fresh.dispose());
  const p=projects[0];await fresh.projects(p.agent);
  const root=fresh.jobs.rootFor(p.context),foreign=path.join(f.root,'foreign-cache');
  await mkdir(root,{recursive:true});await mkdir(foreign);await symlink(foreign,path.join(root,'generations'),'junction');
  await assert.rejects(fresh.build({projectHandle:p.handle,requestId:randomUUID()}),{code:'KNOWLEDGE_CACHE_BOUNDARY'});
  assert.deepEqual(await readdir(foreign),[]);
});
