import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm,cp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {KnowledgeService} from '../../src/knowledge-service.mjs';
import {UnrealBridge} from '../../src/bridge.mjs';
import {EmbeddingService} from '../../src/embedding-service.mjs';
import {embeddingProfile} from '../../src/embedding-profile.mjs';
import {EMBEDDING_DEFAULTS} from '../../src/embedding-spec.mjs';
import {runKnowledgeWorker} from '../../src/knowledge-jobs.mjs';
import {runEmbeddingWorker} from '../../src/embedding-jobs.mjs';

export const secret='fake-M4-provider-key';
export async function put(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);}
export async function until(check){for(let i=0;i<500;i++){if(await check())return;await delay(20);}throw Error('Timed out waiting for test condition');}
function vector(input){
  if(/车醒了但屏幕不亮|唤醒|UDisplayLifecycle|显示输出/.test(input))return [1,0,0,0];
  if(/画面卡顿|RenderBudgetMarker|rendering/.test(input))return [0,1,0,0];
  if(/VehicleSpeedMarker|ParkingConfigMarker|tables|settings/.test(input))return [0,0,1,0];
  return [0,0,0,1];
}
export async function retrievalFixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'DSH M4 中文 ')),stateDir=path.join(root,'state'),workspaces=new Map(),records=new Map(),calls=[],serverState={status:200,wait:0,onQuery:null,vector};
  const server=createServer(async(request,response)=>{
    let text='';for await(const chunk of request)text+=chunk;const body=JSON.parse(text);calls.push(body);
    if(!body.input[0].startsWith('Title:'))await serverState.onQuery?.(body);
    if(serverState.wait)await delay(serverState.wait);
    response.writeHead(serverState.status,{'content-type':'application/json'});
    response.end(JSON.stringify(serverState.status===200?{data:body.input.map((input,index)=>({index,embedding:serverState.vector(input)})),usage:{prompt_tokens:body.input.length*8,total_tokens:body.input.length*8}}:{error:{message:secret}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={...EMBEDDING_DEFAULTS,embeddingBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,embeddingModel:'semantic-fixture-v1',embeddingBatchSize:16,embeddingConcurrency:1};
  const services={fs:{resolve:async file=>({displayPath:path.resolve(file),targetKey:`local:${path.resolve(file)}`}),processPath:target=>target.displayPath,processPathFromHostPath:file=>file,
    stat:async target=>{try{const value=await stat(target.displayPath);return {type:value.isDirectory()?'directory':value.isFile()?'file':'other'};}catch(error){if(error.code==='ENOENT')return;throw error;}},
    listDir:async target=>(await readdir(target.displayPath,{withFileTypes:true})).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':entry.isFile()?'file':'other'}))},
    workingDirectory:{ensure:async agent=>workspaces.get(agent.session.id)},credentials:{readRecord:async key=>records.get(key),describeRecord:async key=>({configured:records.has(key),writable:true}),modifyRecord:async(key,change)=>records.set(key,await change(records.get(key))),deleteRecord:async key=>records.delete(key)}};
  const packaged=process.env.DSH_EMBEDDING_TEST_PACKAGE;
  const options=(name,options)=>({...options,...(packaged?{workerUrl:pathToFileURL(path.resolve(packaged,'lib',name))}:{})});
  const base=(data,opts)=>runKnowledgeWorker(data,options('knowledge-worker.js',opts)),vectors=(data,opts)=>runEmbeddingWorker(data,options('embedding-worker.js',opts));
  const bridge=new UnrealBridge({stateDir,port:0}),knowledge=new KnowledgeService({bridge,stateDir,getService:name=>services[name],runWorker:base});
  const makeEmbedding=()=>new EmbeddingService({knowledge,stateDir,getService:name=>services[name],getConfig:()=>({...config}),runBase:base,runVector:vectors});let embedding=makeEmbedding();
  t.after(async()=>{await embedding.dispose();await knowledge.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!path.relative(tmpdir(),root).startsWith('..'))await rm(root,{recursive:true,force:true});});
  async function project(name='Project'){
    const dir=path.join(root,name);await cp(new URL('../../unreal/DSHUnrealBridge/Tools/test/fixtures/knowledge-baseline/project/',import.meta.url),dir,{recursive:true});
    await put(path.join(dir,'Example.uproject'),'{}');
    const policy={schemaVersion:1,projectId:'$project',knowledgeRoots:['ProjectKnowledge'],memoryOutputRoot:'.ai/memory',graph:{enabled:true,mode:'sqlite'},memory:{chunking:{targetChars:1200,overlapChars:0,maxChars:2400}}};
    await put(path.join(dir,'ProjectMemory.project.json'),JSON.stringify(policy));
    await put(path.join(dir,'ProjectKnowledge/systems/power.md'),'---\nid: display-wake\ntitle: 显示恢复\nstatus: confirmed\nsources: [Source/Baseline/DisplayLifecycle.h, Source/Missing.cpp]\nsymbols: [UDisplayLifecycle, UDoesNotExist]\nassets: [/Game/UI/WBP_PowerStatus.WBP_PowerStatus]\n---\n# 供电流程\n车辆休眠唤醒后恢复显示输出，调用 UDisplayLifecycle 重新连接显示窗口。');
    const agent={session:{id:randomUUID()}};workspaces.set(agent.session.id,dir);const [context]=(await knowledge.projects(agent)).projects;return {dir,agent,context,handle:context.projectHandle,policy};
  }
  async function build(p,{vector=true}={}){
    const job=vector?await embedding.build({projectHandle:p.handle,requestId:randomUUID(),configFingerprint:embeddingProfile(config).configFingerprint,roots:['ProjectKnowledge'],mode:'update'}):await knowledge.build({projectHandle:p.handle,requestId:randomUUID()});
    let status;await until(async()=>{status=vector?await embedding.status({projectHandle:p.handle,jobId:job.jobId}):await knowledge.status({projectHandle:p.handle,jobId:job.jobId});return ['succeeded','failed','cancelled'].includes(status.job.status);});
    if(status.job.status!=='succeeded')throw Error(JSON.stringify(status));return status;
  }
  const configure=async()=>{config.embeddingEnabled=true;embedding.configurationChanged();await embedding.setCredential({configFingerprint:embeddingProfile(config).configFingerprint,apiKey:secret});};
  const query=(p,text,extra={},signal)=>knowledge.query(p.agent,{tool:'project_context',arguments:{query:text,...extra}},signal);
  return {root,stateDir,calls,serverState,config,services,workspaces,bridge,knowledge,project,configure,build,query,get embedding(){return embedding;},async restart(){await embedding.dispose();embedding=makeEmbedding();},revision:()=>embeddingProfile(config).configFingerprint};
}
