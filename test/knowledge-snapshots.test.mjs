import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {retrievalFixture,put,until} from './helpers/retrieval-fixture.mjs';

const sha=value=>createHash('sha1').update(value).digest('hex');
const asset='/Game/UI/WBP_PowerStatus.WBP_PowerStatus';
async function exported(t){
  const f=await retrievalFixture(t),p=await f.project(),editorId=randomUUID(),jobId=randomUUID();
  const root=path.join(p.dir,'Plugins/DSHUnrealBridge/Cache/UE/published');
  const editor={editorId,projectPath:p.context.projectFile,capabilities:['project_knowledge','ue_snapshot_export_v1']};f.bridge.editors.set(editorId,editor);f.bridge.sessions.set(p.agent.session.id,editorId);
  let latest;
  async function publish({dirty=false,excluded=[],source='saved package',after}={}){
    const generation=randomUUID(),cache=path.join(root,'generations',generation),file='assets/'+'a'.repeat(32)+'.json';
    await put(path.join(p.dir,'Content/UI/WBP_PowerStatus.uasset'),source);
    const snapshot={schemaVersion:1,projectId:p.context.projectFile,assetPath:asset,assetClass:'/Script/UMG.WidgetBlueprint',packageName:'/Game/UI/WBP_PowerStatus',packageDirty:dirty,stale:false,fingerprint:'fixture-fingerprint',coverage:{status:'full'},dependencies:[],properties:Array.from({length:4},(_,i)=>({name:`property-${i}`,value:i}))};
    const bytes=JSON.stringify(snapshot);await put(path.join(cache,file),bytes);
    const manifest={schemaVersion:1,capability:'ue_snapshot_export_v1',generation,editorId,projectFile:p.context.projectFile,projectId:p.context.projectFile,descriptorSha1:sha(await readFile(p.context.projectFile)),evidenceKind:'saved_package_snapshot',capturedAt:new Date().toISOString(),scanComplete:true,complete:!excluded.length,excluded,assets:[{assetPath:asset,assetClass:snapshot.assetClass,packageName:snapshot.packageName,packageFile:'Content/UI/WBP_PowerStatus.uasset',file,sha1:sha(bytes),fingerprint:snapshot.fingerprint,coverage:snapshot.coverage,dependencies:[],sourceFiles:[{path:'Content/UI/WBP_PowerStatus.uasset',exists:true,sha1:sha(source)},{path:'Content/UI/WBP_PowerStatus.ubulk',exists:false,sha1:''}]}]};
    await after?.({manifest,cache});await put(path.join(cache,'manifest.json'),JSON.stringify(manifest));await put(path.join(root,'editors',`${editorId}.json`),JSON.stringify({generation,editorId,manifestSha1:sha(JSON.stringify(manifest))}));
    latest={jobId,status:'succeeded',generation,editorId,projectFile:p.context.projectFile,snapshotRoot:root};return {generation,cache,manifest};
  }
  const calls=[];f.bridge.knowledge=async(_session,request)=>{calls.push(request);assert.equal(request.tool,'snapshot_export_status');return latest;};
  const call=(tool,args={},backend='local',signal)=>f.knowledge.query(p.agent,{tool,arguments:args,backend},signal);
  const ingest=()=>call('snapshot_import',{jobId});
  return {f,p,editor,editorId,root,publish,call,ingest,calls};
}

test('M5 completed exports import idempotently, remain readable offline, paginate and resolve Wiki asset links',async t=>{
  const {f,p,publish,call,ingest,editorId}=await exported(t);const first=await publish();await f.build(p,{vector:false});
  assert.equal((await ingest()).generation,first.generation);assert.equal((await ingest()).generation,first.generation);f.bridge.editors.delete(editorId);
  const page=await call('read_asset_snapshot',{assetPath:asset,section:'properties',offset:1,limit:2});assert.deepEqual(page.items.map(row=>row.value),[1,2]);assert.equal(page.sourceStatus,'current_on_disk');assert.equal(page.liveState,'not_verified');assert.equal(page.snapshotGeneration,first.generation);
  const search=await call('search_asset_snapshots',{query:'PowerStatus'});assert.equal(search.assets.length,1);
  const graph=await call('graph_query',{query:'WBP_PowerStatus'});assert.ok(graph.candidates.some(hit=>hit.node.path===asset&&hit.node.sourceStatus==='current_on_disk'));assert.equal(graph.snapshotGeneration,first.generation);
  const context=await f.query(p,'UDisplayLifecycle');assert.ok(context.graphAssociations.links.some(link=>link.kind==='asset'&&link.status==='resolved_snapshot'));assert.ok(context.graphAssociations.assetNodes.some(node=>node.assetPath===asset));assert.equal(context.snapshotStatus.snapshotGeneration,first.generation);
  assert.equal(f.calls.length,0);assert.equal((await f.knowledge.status({projectHandle:p.handle})).snapshot.available,true);
});

test('M5 changed/deleted package and newly created sidecar are stale; local evidence does not claim live freshness',async t=>{
  const {p,publish,call,ingest}=await exported(t);await publish();await ingest();
  await put(path.join(p.dir,'Content/UI/WBP_PowerStatus.ubulk'),'new bulk');
  assert.equal((await call('search_asset_snapshots')).assets[0].sourceStatus,'package_changed');await assert.rejects(call('read_asset_snapshot',{assetPath:asset}),{code:'SNAPSHOT_STALE'});
  await rm(path.join(p.dir,'Content/UI/WBP_PowerStatus.ubulk'));await rm(path.join(p.dir,'Content/UI/WBP_PowerStatus.uasset'));
  assert.equal((await call('search_asset_snapshots')).assets[0].sourceStatus,'package_missing');
});

test('M5 dirty, unpublished, mismatched, corrupt and linked exports cannot replace a valid local version',async t=>{
  const {f,p,publish,ingest,root,editorId}=await exported(t);const original=await publish();await ingest();
  const failures=[
    [{dirty:true},'SNAPSHOT_INVALID'],
    [{after:({manifest})=>{manifest.assets[0].dependencies=[null];}},'SNAPSHOT_INVALID'],
    [{after:({manifest})=>{manifest.projectFile='F:/Other/Other.uproject';}},'SNAPSHOT_PROJECT_MISMATCH'],
    [{after:({manifest})=>{manifest.assets[0].sourceFiles[0].path='../Secret.uasset';}},'SNAPSHOT_INVALID'],
    [{after:async({cache})=>writeFile(path.join(cache,'assets','a'.repeat(32)+'.json'),'corrupt')},'SNAPSHOT_CORRUPT'],
  ];
  for(const [options,code] of failures){await publish(options);await assert.rejects(ingest(),{code});assert.equal((await f.knowledge.snapshots.current(p.context)).generation,original.generation);}
  const next=await publish();await writeFile(path.join(root,'editors',`${editorId}.json`),JSON.stringify({generation:randomUUID()}));await assert.rejects(ingest(),{code:'SNAPSHOT_NOT_PUBLISHED'});
  await t.test('file symlink exports cannot cross the project boundary',async t=>{
    await publish();const entry=path.join(p.dir,'Content/UI/WBP_PowerStatus.uasset');await rm(entry);await put(path.join(f.root,'foreign.uasset'),'saved package');
    try{await symlink(path.join(f.root,'foreign.uasset'),entry,'file');}
    catch(error){
      if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows file symlinks require Developer Mode or the symlink privilege');return;}
      throw error;
    }
    await assert.rejects(ingest(),{code:'SNAPSHOT_BOUNDARY'});
  });
});

test('M5 legacy editors retain asset reads but cannot receive new export calls; project and binding changes are rejected',async t=>{
  const {f,p,editor,publish,call,ingest,calls}=await exported(t);editor.capabilities=['project_knowledge'];
  await assert.rejects(call('snapshot_export_start',{requestId:randomUUID()}),{code:'SNAPSHOT_CAPABILITY_UNAVAILABLE'});assert.equal(calls.length,0);
  f.bridge.knowledge=async()=>({legacy:true});assert.equal((await call('read_asset_snapshot',{assetPath:asset},'auto')).legacy,true);
  editor.projectPath=path.join(f.root,'Other.uproject');await assert.rejects(call('snapshot_export_start',{requestId:randomUUID()}),{code:'PROJECT_NOT_FOUND'});
  editor.projectPath=p.context.projectFile;editor.capabilities.push('ue_snapshot_export_v1');const generation=await publish();
  f.bridge.knowledge=async()=>{f.bridge.bindingVersions.set(p.agent.session.id,1);return {status:'succeeded',generation:generation.generation};};await assert.rejects(ingest(),{code:'INSTANCE_CHANGED'});
});

test('M5 imports cancelled or rebound before publication retain the old generation; queries pin their imported version',async t=>{
  const {f,p,publish,ingest,call}=await exported(t);const old=await publish();await ingest();const next=await publish();
  const run=f.knowledge.runWorker;let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
  f.knowledge.runWorker=async(data,options)=>{const result=await run(data,options);if(data.request.tool==='snapshot_import_internal'){entered=true;await gate;}return result;};
  const pending=ingest();await until(()=>entered);assert.equal((await call('read_asset_snapshot',{assetPath:asset})).snapshotGeneration,old.generation);
  f.bridge.bindingVersions.set(p.agent.session.id,1);release();await assert.rejects(pending,{code:'INSTANCE_CHANGED'});assert.equal((await f.knowledge.snapshots.current(p.context)).generation,old.generation);
  f.knowledge.runWorker=run;assert.equal((await ingest()).generation,next.generation);
  let checks=0;
  await assert.rejects(f.knowledge.snapshots.publish(p.context,{...old,projectId:p.context.projectId},async()=>{if(++checks===2)throw Object.assign(Error('cancelled at publication'),{code:'CANCELLED'});}),{code:'CANCELLED'});
  assert.equal((await f.knowledge.snapshots.current(p.context)).generation,next.generation);
});

test('M5 corrupt imported details degrade context while keeping document evidence; descriptor changes invalidate imports',async t=>{
  const {f,p,publish,ingest,call}=await exported(t);await publish();await ingest();await f.build(p,{vector:false});
  const snapshot=await f.knowledge.snapshots.current(p.context);await writeFile(path.join(snapshot.cache,'assets','a'.repeat(32)+'.json'),'broken');
  const context=await f.query(p,'UDisplayLifecycle');assert.ok(context.memory.relevantDocs.length);assert.equal(context.snapshotStatus.available,false);assert.equal(context.snapshotStatus.reason,'SNAPSHOT_CORRUPT');assert.ok(context.graphAssociations.links.every(link=>link.status!=='resolved_snapshot'));
  await assert.rejects(call('read_asset_snapshot',{assetPath:asset}),{code:'SNAPSHOT_CORRUPT'});await writeFile(p.context.projectFile,'{"FileVersion":3}');
  await assert.rejects(call('read_asset_snapshot',{assetPath:asset}),{code:'SNAPSHOT_STALE'});
});
