import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,symlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {IndexJobManager} from '../src/knowledge-jobs.mjs';
import {projectCacheRoot} from '../src/project-cache.mjs';
import {retrievalFixture,put} from './helpers/retrieval-fixture.mjs';
import {KnowledgeService} from '../src/knowledge-service.mjs';

async function legacyFixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'dsh-cache-migration-')),projectRoot=path.join(root,'UE'),stateDir=path.join(root,'old-host');
  await mkdir(projectRoot);const projectFile=path.join(projectRoot,'Game.uproject');await writeFile(projectFile,'{}');
  const project={projectRoot,projectFile,projectId:createHash('sha256').update(projectFile).digest('hex'),descriptorHash:createHash('sha256').update('{}').digest('hex')};
  const source=path.join(stateDir,'Knowledge',project.projectId),generation=randomUUID(),cache=path.join(source,'generations',generation);
  await mkdir(cache,{recursive:true});await put(path.join(cache,'identity.json'),JSON.stringify({identity:project.projectId,descriptorHash:project.descriptorHash,generation}));
  await put(path.join(cache,'ProjectMemory.project.json'),JSON.stringify({knowledgeRoots:['ProjectKnowledge']}));
  await put(path.join(source,'current.json'),JSON.stringify({projectId:project.projectId,generation}));
  await put(path.join(source,'embedding/vectors.sqlite'),Buffer.from('successful-paid-vector-cache'));
  const jobs=new IndexJobManager({stateDir});t.after(async()=>{await jobs.dispose();await rm(root,{recursive:true,force:true});});
  return {root,project,stateDir,source,jobs,generation};
}
test('legacy cache migration preserves paid vectors and source backup, publishes once inside the UE plugin',async t=>{
  const f=await legacyFixture(t),before=await readFile(path.join(f.source,'embedding/vectors.sqlite'));
  const [a,b]=await Promise.all([f.jobs.current(f.project),f.jobs.current(f.project)]);
  assert.equal(a.generation,b.generation);assert.equal(a.compatible,true);assert.ok(a.cache.startsWith(path.join(f.project.projectRoot,'Plugins/DSHUnrealBridge/Cache')));
  assert.deepEqual(await readFile(path.join(f.jobs.rootFor(f.project),'embedding/vectors.sqlite')),before);
  assert.deepEqual(await readFile(path.join(f.source,'embedding/vectors.sqlite')),before);
  const otherHost=new IndexJobManager({stateDir:path.join(f.root,'new-host')});assert.equal(otherHost.rootFor(f.project),f.jobs.rootFor(f.project));
  await put(path.join(f.source,'embedding/vectors.sqlite'),'stale-source');await f.jobs.current(f.project);
  assert.deepEqual(await readFile(path.join(f.jobs.rootFor(f.project),'embedding/vectors.sqlite')),before);
  assert.ok(!(await readdir(path.dirname(f.jobs.rootFor(f.project)))).some(name=>name.startsWith('.migration-')));
});
test('migrated indexes with old document roots require a rebuild, while their reusable vectors are preserved',async t=>{
  const f=await legacyFixture(t);await put(path.join(f.source,'generations',f.generation,'ProjectMemory.project.json'),JSON.stringify({knowledgeRoots:['Docs','ProjectKnowledge']}));
  assert.equal((await f.jobs.current(f.project)).compatible,false);
  assert.ok((await stat(path.join(f.jobs.rootFor(f.project),'embedding/vectors.sqlite'))).isFile());
});
test('active legacy writers and linked cache directories cannot be copied into a project',async t=>{
  const f=await legacyFixture(t);await put(path.join(f.source,'build.lock'),JSON.stringify({pid:process.pid}));
  await assert.rejects(f.jobs.current(f.project),{code:'KNOWLEDGE_BUSY'});await assert.rejects(stat(f.jobs.rootFor(f.project)),{code:'ENOENT'});
  await rm(path.join(f.source,'build.lock'));const foreign=path.join(f.root,'foreign');await mkdir(foreign);await symlink(foreign,path.join(f.source,'external'),'junction');
  await assert.rejects(f.jobs.current(f.project),{code:'KNOWLEDGE_CACHE_BOUNDARY'});assert.deepEqual(await readdir(foreign),[]);
});
test('cache parent junctions are rejected before creating or migrating project files',async t=>{
  const f=await legacyFixture(t),foreign=path.join(f.root,'foreign');await mkdir(foreign);await symlink(foreign,path.join(f.project.projectRoot,'Plugins'),'junction');
  await assert.rejects(f.jobs.safeRoot(f.project),{code:'KNOWLEDGE_CACHE_BOUNDARY'});assert.deepEqual(await readdir(foreign),[]);
});
test('bound UE owns knowledge even when the DSH workspace belongs to another project; stale UI actions fail',async t=>{
  const f=await retrievalFixture(t),a=await f.project('DSHWorkspace'),b=await f.project('BoundUE');
  const editorId=randomUUID();f.bridge.editors.set(editorId,{editorId,projectPath:b.context.projectFile,project:'BoundUE',capabilities:[]});f.bridge.bind(a.agent.session.id,editorId);
  const context=await f.knowledge.boundContext(a.agent);assert.equal(context.project.projectHandle,b.handle);assert.equal(context.project.knowledgeRoot,path.join(b.dir,'ProjectKnowledge'));assert.equal(context.project.cacheRoot,projectCacheRoot(b.context));assert.equal(f.calls.length,0);
  await assert.rejects(f.knowledge.boundAction(a.agent,{action:'baseBuild',projectHandle:a.handle,bindingVersion:context.project.bindingVersion,requestId:randomUUID()}),{code:'PROJECT_EDITOR_MISMATCH'});
  f.bridge.bind(a.agent.session.id,null);f.bridge.bind(a.agent.session.id,editorId);
  await assert.rejects(f.knowledge.boundAction(a.agent,{action:'baseBuild',projectHandle:b.handle,bindingVersion:context.project.bindingVersion,requestId:randomUUID()}),{code:'INSTANCE_CHANGED'});
  const current=await f.knowledge.boundContext(a.agent);f.bridge.editors.delete(editorId);
  const offline=await f.knowledge.boundContext(a.agent);assert.equal(offline.project.projectHandle,b.handle);assert.equal(offline.project.connected,false);assert.equal(offline.project.bindingVersion,current.project.bindingVersion);
});
test('unbound settings do not infer a project from DSH workspaces, and knowledge indexes exclude external document folders',async t=>{
  const f=await retrievalFixture(t),p=await f.project();assert.equal((await f.knowledge.boundContext(p.agent)).project,null);
  await put(path.join(p.dir,'Docs/outside.md'),'OutsideKnowledgeMarker');await f.build(p,{vector:false});
  const current=await f.knowledge.jobs.current(p.context),config=JSON.parse(await readFile(path.join(current.cache,'ProjectMemory.project.json'),'utf8'));
  assert.deepEqual(config.knowledgeRoots,['ProjectKnowledge']);
  const result=await f.query(p,'OutsideKnowledgeMarker');assert.equal(result.memory?.relevantDocs?.length??0,0);assert.equal(f.calls.length,0);
  const other=new KnowledgeService({getService:name=>f.services?.[name],bridge:f.bridge,stateDir:path.join(f.root,'other-state')});
  assert.equal(other.jobs.rootFor(p.context),f.knowledge.jobs.rootFor(p.context));await other.dispose();
});
