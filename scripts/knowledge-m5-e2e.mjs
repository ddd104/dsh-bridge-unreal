// Real UE/DSH-host collaboration in a new disposable project. No user project,
// installed plugin or cloud provider is touched.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,cp,writeFile,readFile,readdir,stat,realpath} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {UnrealBridge} from '../src/bridge.mjs';
import {KnowledgeService} from '../src/knowledge-service.mjs';

const [engine,packagedPlugin]=process.argv.slice(2);if(!engine||!packagedPlugin)throw Error('Usage: node scripts/knowledge-m5-e2e.mjs <engine-root> <packaged-plugin>');
const workspace=fileURLToPath(new URL('../',import.meta.url)),root=await mkdtemp(path.join(workspace,'.test-state','M5 UE 中文 ')),projectFile=path.join(root,'M5.uproject'),stateDir=path.join(root,'host-state');
const pluginSource=await realpath(packagedPlugin);
await mkdir(path.join(root,'Plugins'),{recursive:true});await cp(pluginSource,path.join(root,'Plugins/DSHUnrealBridge'),{recursive:true,filter:file=>!['HostProject','Intermediate'].includes(path.relative(pluginSource,file).split(path.sep)[0])});
await writeFile(projectFile,JSON.stringify({FileVersion:3,Plugins:[{Name:'DSHUnrealBridge',Enabled:true}]}));
await writeFile(path.join(root,'ProjectMemory.project.json'),JSON.stringify({schemaVersion:1,projectId:'$project',knowledgeRoots:['ProjectKnowledge'],memoryOutputRoot:'.ai/memory',graph:{enabled:false,mode:'sqlite'}}));
await mkdir(path.join(root,'ProjectKnowledge/systems'),{recursive:true});
await writeFile(path.join(root,'ProjectKnowledge/systems/m5.md'),'---\nid: m5-real\nassets: [/Game/M5/BP_Saved.BP_Saved]\n---\n# SnapshotCollaborationMarker\nSaved Blueprint snapshot integration.');
// Installed policy precedes the project root policy, so configure only this new
// disposable plugin's copy to keep the fixture scope explicit.
await cp(path.join(root,'ProjectMemory.project.json'),path.join(root,'Plugins/DSHUnrealBridge/Config/Knowledge/ProjectMemory.project.json'));
const services={fs:{resolve:async file=>({displayPath:path.resolve(file),targetKey:`local:${path.resolve(file)}`}),processPath:t=>t.displayPath,processPathFromHostPath:file=>file,
  stat:async target=>{try{const info=await stat(target.displayPath);return {type:info.isDirectory()?'directory':info.isFile()?'file':'other'};}catch(error){if(error.code==='ENOENT')return;throw error;}},listDir:async target=>(await readdir(target.displayPath,{withFileTypes:true})).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':entry.isFile()?'file':'other'}))},workingDirectory:{ensure:async()=>root}};
const bridge=await new UnrealBridge({stateDir,port:0,requestTimeoutMs:120000,knowledgeTimeoutMs:120000}).start();
let knowledge=new KnowledgeService({bridge,stateDir,getService:name=>services[name]}),child,processError,exited;
const agent={session:{id:'m5-real-e2e'}},report={status:'running',projectFile,checks:[]};
const call=(tool,args={},backend='auto')=>knowledge.query(agent,{tool,arguments:args,backend});
const wait=async check=>{const end=Date.now()+180000;while(!await check()){if(processError)throw processError;if(exited!==undefined)throw Error(`UE exited: ${exited}`);if(Date.now()>end)throw Error('Timed out waiting for UE test');await delay(200);}};
const check=label=>{report.checks.push(label);console.log(`PASS: ${label}`);};
try{
  child=spawn(path.join(engine,'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[projectFile,'/Engine/Maps/Entry','-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound','-NoAutoSave',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${path.join(root,'editor.log')}`],{windowsHide:true,stdio:'ignore'});
  child.once('error',error=>{processError=error;});child.once('exit',(code,signal)=>{exited=code??signal;});await wait(()=>bridge.list().length);
  const editor=bridge.list()[0];assert.equal(editor.pid,child.pid);assert.equal((await realpath(editor.projectPath)).toLowerCase(),projectFile.toLowerCase());assert.ok(editor.capabilities.includes('ue_snapshot_export_v1'));bridge.bind(agent.session.id,editor.editorId);report.engine=editor.engineVersion;
  const [project]=(await knowledge.projects(agent)).projects;check('packaged native plugin connects from a clean project with Chinese and space paths');
  for(const name of ['BP_Saved','BP_Unsaved']){
    const assetPath=`/Game/M5/${name}`,preview=await bridge.preview(agent.session.id,'create',{assetPath,parent:'Actor'});await bridge.apply(agent.session.id,preview.previewId,randomUUID());
    if(name==='BP_Saved'){const read=await bridge.read(agent.session.id,{assetPath});await bridge.mutate(agent.session.id,'save',{assetPath,baseRevision:read.revision},randomUUID());}
  }
  const job=await knowledge.build({projectHandle:project.projectHandle,requestId:randomUUID()});let build;
  await wait(async()=>{build=await knowledge.status({projectHandle:project.projectHandle,jobId:job.jobId});return ['succeeded','failed'].includes(build.job.status);});assert.equal(build.job.status,'succeeded',JSON.stringify(build));
  const requestId=randomUUID(),started=await call('snapshot_export_start',{requestId});assert.equal((await call('snapshot_export_start',{requestId})).jobId,started.jobId);let exported;
  await wait(async()=>{exported=await call('snapshot_export_status',{jobId:started.jobId});return exported.status!=='running';});assert.equal(exported.status,'succeeded',JSON.stringify(exported));
  await assert.rejects(stat(path.join(root,'Plugins/DSHUnrealBridge/Cache/identity.json')),{code:'ENOENT'});check('independent export publishes a complete generation without legacy graph rebuild; request ID is idempotent');
  const imported=await call('snapshot_import',{jobId:started.jobId});assert.equal(imported.generation,exported.generation);
  const saved=await call('read_asset_snapshot',{assetPath:'/Game/M5/BP_Saved',section:'blueprint'});assert.equal(saved.sourceStatus,'current_on_disk');assert.equal(saved.liveState,'not_verified');assert.ok(saved.items.length);assert.ok(imported.excludedCount>=1);
  await assert.rejects(call('read_asset_snapshot',{assetPath:'/Game/M5/BP_Unsaved'},'local'),{code:'SNAPSHOT_ASSET_MISSING'});check('real saved Blueprint imports and paginates; unsaved asset is excluded from persistent evidence');
  const context=await call('project_context',{query:'SnapshotCollaborationMarker'});assert.ok(context.graphAssociations.links.some(link=>link.status==='resolved_snapshot'));check('Wiki asset link resolves against the pinned imported generation');
  // Explicit cancel is independent of transport request cancellation.
  const cancelId=randomUUID();
  const [,cancelled]=await Promise.all([bridge.knowledge(agent.session.id,{tool:'snapshot_export_start',arguments:{requestId:cancelId}}),bridge.knowledge(agent.session.id,{tool:'snapshot_export_cancel',arguments:{jobId:cancelId}})]);
  assert.equal(cancelled.status,'cancelled');assert.equal((await knowledge.snapshots.current(project)).generation,imported.generation);report.cancelStatus=cancelled.status;check('explicit cancellation stops an active native export and preserves the imported generation');
  child.kill();await delay(1000);bridge.sessions.delete(agent.session.id);await knowledge.dispose();knowledge=new KnowledgeService({bridge,stateDir,getService:name=>services[name]});await knowledge.projects(agent);
  const offline=await call('read_asset_snapshot',{assetPath:'/Game/M5/BP_Saved'},'local');assert.equal(offline.snapshotGeneration,imported.generation);check('UE disconnected and host restarted: persisted asset snapshot remains readable');
  const packageFile=path.join(root,'Content/M5/BP_Saved.uasset'),bytes=await readFile(packageFile);await writeFile(packageFile,Buffer.concat([bytes,Buffer.from('changed-test-package')]));
  await assert.rejects(call('read_asset_snapshot',{assetPath:'/Game/M5/BP_Saved'},'local'),{code:'SNAPSHOT_STALE'});await writeFile(packageFile,bytes);check('disk package change invalidates imported evidence without breaking base queries');
  report.status='passed';
}catch(error){report.status='failed';report.error={message:error.message,code:error.code,stack:error.stack};throw error;}
finally{child?.kill();await knowledge.dispose();await bridge.close();await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(`M5 report: ${path.join(root,'report.json')}`);}
