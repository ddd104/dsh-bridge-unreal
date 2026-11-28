import {parentPort,workerData} from 'node:worker_threads';
import path from 'node:path';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createKnowledgeCore} from '../unreal/DSHUnrealBridge/Tools/knowledge-core.mjs';
import defaultConfig from '../unreal/DSHUnrealBridge/Config/Knowledge/ProjectMemory.project.json' with {type:'json'};
import {finalizeRetrieval} from './knowledge-retrieval-worker.mjs';
import {importSnapshot,querySnapshot,associateSnapshot} from './snapshot-store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
try{
  const {project,cache,request,config,contextOptions,snapshot}=workerData;
  if(await realpath(project.projectRoot)!==project.projectRoot||hash(await readFile(project.projectFile))!==project.descriptorHash)
    throw Object.assign(new Error('Project identity changed; rediscover the workspace.'),{code:'PROJECT_CHANGED'});
  if(request.tool==='snapshot_import_internal'||request.tool==='snapshot_query_internal'){
    const result=request.tool==='snapshot_import_internal'?await importSnapshot({project,...request.arguments}):await querySnapshot({project,...request.arguments});
    parentPort.postMessage({response:{isError:false,result}});
  }else{
  const configPath=path.join(cache,'ProjectMemory.project.json');
  if(request.tool==='project_update'){
    const probe=new DatabaseSync(':memory:');
    try{probe.exec('CREATE VIRTUAL TABLE runtime_probe USING fts5(body)');}
    catch{throw Object.assign(Error(`Node ${process.versions.node} lacks SQLite FTS5; use a supported DSH/Node runtime. Existing source and editor tools remain available.`),{code:'KNOWLEDGE_FTS5_UNAVAILABLE'});}
    finally{probe.close();}
    await mkdir(cache,{recursive:true});
    await writeFile(configPath,JSON.stringify(config??defaultConfig,null,2)+'\n',{flag:'wx'});
  }
  const worker=await createKnowledgeCore({
    project:project.projectRoot,plugin:path.join(project.projectRoot,'Plugins','DSHUnrealBridge'),cache,
    descriptor:path.basename(project.projectFile),identity:project.projectId,descriptorHash:project.descriptorHash,configPath,
    hostPaths:{projectId:project.projectId,memoryRoot:path.join(cache,'Memory'),graphRoot:path.join(cache,'Graph'),ueCacheRoot:path.join(cache,'NoUESnapshot')},
    contextOptions,onProgress:progress=>parentPort.postMessage({progress})
  });
  let response=request.tool==='retrieval_finalize'?{isError:false,result:await finalizeRetrieval({project,cache,...request.arguments,core:worker})}:await worker(request);
  if(request.tool==='graph_query'&&snapshot){
    try{
      const assets=await querySnapshot({project,snapshot,tool:'graph_query',args:request.arguments??{}});
      if(!response.isError||assets.candidates.length)response={isError:false,result:{...(response.isError?{}:response.result),...assets,authority:'index_candidates',candidates:[...assets.candidates,...(response.isError?[]:response.result.candidates??[])].slice(0,40)}};
    }catch(error){if(!response.isError)response.result.snapshotStatus={available:false,reason:error.code??'snapshot_unavailable'};}
  }
  if(!response.isError&&['project_context','retrieval_finalize'].includes(request.tool)&&snapshot)response.result=await associateSnapshot({project,snapshot,context:response.result});
  parentPort.postMessage({response});
  }
}catch(error){
  parentPort.postMessage({response:{isError:true,result:{code:error.code??'KNOWLEDGE_WORKER_FAILED',message:error.message}}});
}
