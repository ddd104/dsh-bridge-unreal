import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,open,readFile,writeFile,rename,rm,realpath,stat} from 'node:fs/promises';
import {insidePath,samePath} from './project-context.mjs';
import {fail} from './protocol.mjs';
import {projectCacheRoot,ProjectCacheMigration,checkCachePath} from './project-cache.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const active=new Set(['queued','running','publishing']);
export async function readJson(file,fallback=null){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export async function atomicJson(file,value){
  const temporary=`${file}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n');
  try{
    // Windows readers/virus scanners can briefly deny replacement of an open JSON file.
    for(let attempt=0;;attempt++){
      try{await rename(temporary,file);break;}
      catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;await delay(15*(attempt+1));}
    }
  }finally{await rm(temporary,{force:true});}
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};

/** Heavy parsers and SQLite are only imported by this isolated worker. */
export function runKnowledgeWorker(data,{signal,onProgress=()=>{},timeoutMs=120000,workerUrl}={}){
  signal?.throwIfAborted();
  const url=workerUrl??new URL(import.meta.url.endsWith('.mjs')?'./knowledge-worker.mjs':'./knowledge-worker.js',import.meta.url);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(fileURLToPath(url),{workerData:data,execArgv:[]});
    let settled=false;
    const finish=async(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      await worker.terminate();error?reject(error):resolve(value);
    };
    const cancel=()=>void finish(Object.assign(new Error('Knowledge operation cancelled'),{code:'CANCELLED'}));
    const timer=setTimeout(()=>void finish(Object.assign(new Error('Knowledge worker timed out'),{code:'KNOWLEDGE_TIMEOUT'})),timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    worker.on('message',message=>{
      if(settled)return;
      if(message.progress){onProgress(message.progress);return;}
      if(message.response){const response=message.response;void finish(response.isError?Object.assign(new Error(response.result.message),{code:response.result.code}):null,response.result);}
    });
    worker.on('error',error=>void finish(Object.assign(error,{code:error.code??'KNOWLEDGE_RUNTIME_UNAVAILABLE'})));
    worker.on('exit',code=>{if(!settled)void finish(Object.assign(new Error(`Knowledge worker exited before returning a result (${code}).`),{code:'KNOWLEDGE_WORKER_EXIT'}));});
  });
}

export class IndexJobManager {
  constructor({stateDir,runWorker=runKnowledgeWorker,onChange=()=>{}}){
    this.migration=new ProjectCacheMigration(stateDir);this.runWorker=runWorker;this.onChange=onChange;this.jobs=new Map();this.starts=new Map();this.buildSlots=0;this.closed=false;
  }
  rootFor(project){
    if(!/^[a-f0-9]{64}$/.test(project.projectId))fail('PROJECT_ACCESS_DENIED','Invalid project identity.');
    return projectCacheRoot(project);
  }
  async safeRoot(project){
    const root=this.rootFor(project);
    await this.migration.ensure(project);await checkCachePath(root);
    await mkdir(root,{recursive:true});
    const real=await realpath(root),base=await realpath(path.dirname(root));
    if(!samePath(base,path.dirname(root))||!insidePath(base,real)||path.relative(base,real)!==project.projectId)fail('KNOWLEDGE_CACHE_BOUNDARY','Project cache follows an external link.');
    return root;
  }
  async checkPath(file){
    let current=file;
    while(true){
      try{if(!samePath(await realpath(current),path.resolve(current)))fail('KNOWLEDGE_CACHE_BOUNDARY','Knowledge cache follows a link.');return;}
      catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(current);if(parent===current)throw error;current=parent;}
    }
  }
  async current(project){
    await this.migration.ensure(project);
    const root=this.rootFor(project);await this.checkPath(path.join(root,'current.json'));
    const pointer=await readJson(path.join(root,'current.json'));
    if(!pointer)return null;
    if(pointer.projectId!==project.projectId||!uuid.test(pointer.generation))fail('KNOWLEDGE_INDEX_INVALID','Published index pointer is invalid; rebuild the base index.');
    const cache=path.join(root,'generations',pointer.generation);
    await this.checkPath(cache);
    const manifest=await readJson(path.join(cache,'identity.json'));
    if(manifest?.identity!==project.projectId||manifest.generation!==pointer.generation)fail('KNOWLEDGE_INDEX_INVALID','Published index is incomplete; rebuild the base index.');
    const policy=await readJson(path.join(cache,'ProjectMemory.project.json'));
    const scopeCurrent=policy?.knowledgeRoots?.length===1&&policy.knowledgeRoots[0]==='ProjectKnowledge';
    return {...pointer,cache,compatible:manifest.descriptorHash===project.descriptorHash&&scopeCurrent};
  }
  async status(project,jobId){
    await this.migration.ensure(project);
    if(jobId&&!uuid.test(jobId))fail('INVALID_JOB','Invalid job ID.');
    const root=this.rootFor(project);
    await this.checkPath(path.join(root,'jobs'));await this.checkPath(path.join(root,'latest-job.json'));
    let job=jobId?this.jobs.get(`${project.projectId}:${jobId}`)?.record??await readJson(path.join(root,'jobs',`${jobId}.json`)):await readJson(path.join(root,'latest-job.json'));
    if(job){
      job=this.jobs.get(`${project.projectId}:${job.jobId}`)?.record??job;
      if(job.projectId!==project.projectId)fail('INVALID_JOB','Job belongs to a different project.');
      if(active.has(job.status)&&!this.jobs.has(`${project.projectId}:${job.jobId}`)&&!alive(job.pid))job={...job,status:'interrupted',phase:'interrupted',error:{code:'HOST_EXITED',message:'The previous host stopped. Start a new explicit base-index build.'}};
    }
    if(jobId&&!job)fail('JOB_NOT_FOUND','No such job for this project.');
    let index,indexError;
    try{index=await this.current(project);}catch(error){indexError={code:error.code,message:error.message};}
    return {projectHandle:project.projectHandle,projectId:project.projectId,retrievalMode:'base',embeddingRequests:0,index:index?{generation:index.generation,updatedAt:index.updatedAt,compatible:index.compatible}:null,...(indexError?{indexError}:{}),job:job?structuredClone(job):null};
  }
  async start(project,requestId,config){
    if(!uuid.test(requestId))fail('INVALID_REQUEST_ID','A UUID requestId is required.');
    if(this.closed)fail('KNOWLEDGE_CLOSED','Knowledge service is shutting down.');
    const key=`${project.projectId}:${requestId}`;
    if(this.starts.has(key))return this.starts.get(key);
    const pending=this.startOnce(structuredClone(project),requestId,config);
    this.starts.set(key,pending);
    try{return await pending;}finally{this.starts.delete(key);}
  }
  async startOnce(project,requestId,config){
    const root=await this.safeRoot(project),jobFile=path.join(root,'jobs',`${requestId}.json`);
    await this.checkPath(jobFile);await this.checkPath(path.join(root,'generations'));
    await this.checkPath(path.join(root,'latest-job.json'));await this.checkPath(path.join(root,'current.json'));await this.checkPath(path.join(root,'build.lock'));
    const existing=await readJson(jobFile);
    if(existing)return (await this.status(project,requestId)).job;
    if(this.buildSlots>=2)fail('KNOWLEDGE_BUSY','Two base-index builds are already active; retry after completion.');
    this.buildSlots++;
    try{return await this.launch(project,requestId,config,root,jobFile);}catch(error){this.buildSlots--;throw error;}
  }
  async launch(project,requestId,config,root,jobFile){
    const lockFile=path.join(root,'build.lock');
    let lock;
    try{lock=await open(lockFile,'wx');}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const held=await readJson(lockFile).catch(()=>null);
      if(held?.pid?alive(held.pid):Date.now()-(await stat(lockFile)).mtimeMs<30000)fail('KNOWLEDGE_BUSY','This project already has an active base-index build.');
      await rm(lockFile);lock=await open(lockFile,'wx');
    }
    try{await lock.writeFile(JSON.stringify({pid:process.pid,requestId}));}catch(error){await lock.close();await rm(lockFile,{force:true});throw error;}
    const record={jobId:requestId,requestId,projectId:project.projectId,projectHandle:project.projectHandle,projectFile:project.projectFile,descriptorHash:project.descriptorHash,configFingerprint:createHash('sha256').update(JSON.stringify(config??'bundled-default-v1')).digest('hex'),pid:process.pid,status:'queued',phase:'queued',createdAt:new Date().toISOString(),embeddingRequests:0};
    const control=new AbortController(),entry={record,control,persist:Promise.resolve()};
    const save=()=>{
      const snapshot=structuredClone(record);
      entry.persist=entry.persist.then(async()=>{await atomicJson(jobFile,snapshot);await atomicJson(path.join(root,'latest-job.json'),snapshot);this.onChange();});
      return entry.persist;
    };
    try{
      await mkdir(path.join(root,'jobs'),{recursive:true});await save();
    }catch(error){await lock.close();await rm(lockFile,{force:true});throw error;}
    this.jobs.set(`${project.projectId}:${requestId}`,entry);
    const generation=randomUUID(),cache=path.join(root,'generations',generation);
    entry.done=(async()=>{
      try{
        record.status='running';await save();
        control.signal.throwIfAborted();
        const result=await this.runWorker({project,cache,config,request:{id:requestId,tool:'project_update',arguments:{}}},{signal:control.signal,timeoutMs:300000,onProgress:progress=>{if(record.status==='running'){Object.assign(record,progress);void save().catch(()=>control.abort());}}});
        control.signal.throwIfAborted();
        if(createHash('sha256').update(await readFile(project.projectFile)).digest('hex')!==project.descriptorHash)fail('PROJECT_CHANGED','The project descriptor changed before publication.');
        record.status='publishing';record.phase='publishing';await save();
        await atomicJson(path.join(root,'current.json'),{projectId:project.projectId,generation,updatedAt:result.updatedAt});
        record.status='succeeded';record.phase='complete';record.result=result;
      }catch(error){
        record.status=control.signal.aborted?'cancelled':'failed';record.phase=record.status;
        record.error={code:error.code??'KNOWLEDGE_BUILD_FAILED',message:error.message};
      }finally{
        record.finishedAt=new Date().toISOString();
        try{await save();}finally{this.buildSlots--;await lock.close();await rm(lockFile,{force:true});}
      }
    })();
    // Always observe background failures, including a full/unwritable state volume.
    void entry.done.catch(error=>{record.status='failed';record.error={code:'KNOWLEDGE_STATE_WRITE_FAILED',message:error.message};this.onChange();});
    return structuredClone(record);
  }
  async cancel(project,jobId){
    const status=await this.status(project,jobId);
    const entry=this.jobs.get(`${project.projectId}:${jobId}`);
    if(!entry){if(active.has(status.job.status))fail('JOB_OWNED_BY_OTHER_HOST','Cancel this task in the DSH process that started it.');return status.job;}
    if(entry.record.status==='queued'||entry.record.status==='running')entry.control.abort();
    await entry.done;return structuredClone(entry.record);
  }
  async dispose(){
    this.closed=true;
    await Promise.allSettled([...this.starts.values()]);
    for(const entry of this.jobs.values())if(entry.record.status!=='publishing')entry.control.abort();
    await Promise.allSettled([...this.jobs.values()].map(entry=>entry.done));
  }
}
