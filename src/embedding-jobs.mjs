import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rm,stat} from 'node:fs/promises';
import {atomicJson,readJson,runKnowledgeWorker} from './knowledge-jobs.mjs';
import {embeddingError,hashEmbedding} from './embedding-profile.mjs';
import {embeddingFailure} from './embedding-failures.mjs';

const active=new Set(['queued','scanning','running','publishing']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export function runEmbeddingWorker(data,{signal,onProgress=()=>{},workerUrl}={}){
  signal?.throwIfAborted();
  const url=workerUrl??new URL(import.meta.url.endsWith('.mjs')?'./embedding-worker.mjs':'./embedding-worker.js',import.meta.url);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(fileURLToPath(url),{workerData:data,execArgv:[]});let settled=false,timer;
    const finish=async(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);await worker.terminate();error?reject(error):resolve(result);};
    const cancel=()=>{worker.postMessage({cancel:true});timer=setTimeout(()=>void finish(signal.reason??embeddingError('CANCELLED','向量任务已取消。')),3000);};
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    worker.on('message',message=>{if(settled)return;if(message.progress){onProgress(message.progress);return;}if(message.response){const {isError,result}=message.response;void finish(isError?embeddingError(result.code,result.message,result.details):null,result);}});
    worker.on('error',()=>void finish(embeddingError('EMBEDDING_RUNTIME_UNAVAILABLE','向量 Worker 或 SQLite 不可用；基础检索仍可使用。')));
    worker.on('exit',()=>{if(!settled)void finish(embeddingError('EMBEDDING_WORKER_EXIT','向量 Worker 已退出，成功缓存可在手动继续时复用。'));});
  });
}

export class EmbeddingJobs {
  constructor({baseJobs,runBase=runKnowledgeWorker,runVector=runEmbeddingWorker,onChange=()=>{},validate=async()=>{}}){Object.assign(this,{base:baseJobs,runBase,runVector,onChange,validate});this.entries=new Map();this.starts=new Map();this.slots=0;this.closed=false;}
  root(project){return path.join(this.base.rootFor(project),'embedding');}
  async current(project,published){
    const base=published??await this.base.current(project);if(!base||!base.compatible)return null;
    const file=path.join(base.cache,'vector-manifest.json');await this.base.checkPath(file);const manifest=await readJson(file);
    if(!manifest)return null;
    if(manifest.projectId!==project.projectId||manifest.generation!==base.generation||manifest.descriptorHash!==project.descriptorHash)throw embeddingError('EMBEDDING_INDEX_INVALID','向量索引不属于当前项目版本。');
    const vector=path.join(base.cache,'Memory/index/vector.sqlite');await this.base.checkPath(vector);if(!(await stat(vector)).isFile())throw embeddingError('EMBEDDING_INDEX_INVALID','向量文件缺失。');
    return {base,manifest};
  }
  async status(project,jobId){
    await this.base.migration.ensure(project);
    if(jobId&&!uuid.test(jobId))throw embeddingError('INVALID_JOB','任务 ID 无效。');
    const root=this.root(project),file=jobId?path.join(root,'jobs',jobId+'.json'):path.join(root,'latest-job.json');await this.base.checkPath(file);
    let job=jobId?this.entries.get(`${project.projectId}:${jobId}`)?.record:null;job??=await readJson(file);
    if(job){
      const entry=this.entries.get(`${project.projectId}:${job.jobId}`);
      // A terminal in-memory record can precede its final disk write and lock
      // release. Do not enable the next UI build before cleanup has settled.
      if(entry&&!active.has(entry.record.status))await entry.done?.catch(()=>{});
      job=entry?.record??job;if(job.projectId!==project.projectId)throw embeddingError('INVALID_JOB','任务不属于当前项目。');
      if(active.has(job.status)&&!this.entries.has(`${project.projectId}:${job.jobId}`)&&!alive(job.pid))job={...job,status:'interrupted',phase:'interrupted',error:{code:'HOST_EXITED',message:'宿主已退出；成功批次已保留，请点击继续。'}};}
    if(jobId&&!job)throw embeddingError('JOB_NOT_FOUND','未找到此项目的向量任务。');
    const snapshot=job?structuredClone(job):null;
    let current,indexError;try{current=await this.current(project);}catch(error){indexError={code:error.code??'EMBEDDING_INDEX_INVALID',message:'向量索引不可用，可显式重建；基础检索不受影响。'};}
    return {job:snapshot,index:current?.manifest??null,...(indexError?{indexError}:{}),baseGeneration:current?.base.generation??null};
  }
  async start({project,profile,key,config,roots,requestId,mode='update',resumeOf,previous}){
    if(this.closed)throw embeddingError('KNOWLEDGE_CLOSED','知识服务正在关闭。');
    if(!uuid.test(requestId))throw embeddingError('INVALID_REQUEST_ID','需要 UUID requestId。');
    const identity=`${project.projectId}:${requestId}`,fingerprint=hashEmbedding([profile.configFingerprint,roots,config,mode,resumeOf??null]);
    const pending=this.starts.get(identity);if(pending){if(pending.fingerprint!==fingerprint)throw embeddingError('EMBEDDING_REQUEST_CONFLICT','requestId 已用于不同的向量任务。');return pending.promise;}
    const parameters={project:structuredClone(project),profile,key,config:structuredClone(config),roots:[...roots],requestId,mode,resumeOf,previous};
    const promise=this.startOnce(parameters);this.starts.set(identity,{fingerprint,promise});try{return await promise;}finally{this.starts.delete(identity);}
  }
  async startOnce(params){
    const {project,profile,roots,requestId,config,mode,resumeOf}=params,baseRoot=await this.base.safeRoot(project),root=this.root(project),jobFile=path.join(root,'jobs',requestId+'.json');
    const requestFingerprint=hashEmbedding([profile.configFingerprint,roots,config,mode,resumeOf??null]);
    for(const file of [root,jobFile,path.join(root,'latest-job.json'),path.join(root,'vectors.sqlite'),path.join(baseRoot,'generations'),path.join(baseRoot,'current.json'),path.join(baseRoot,'build.lock')])await this.base.checkPath(file);
    const old=await readJson(jobFile);if(old){if(old.requestFingerprint!==requestFingerprint)throw embeddingError('EMBEDDING_REQUEST_CONFLICT','requestId 已用于不同的向量任务。');return (await this.status(project,requestId)).job;}
    if(this.slots>=2)throw embeddingError('KNOWLEDGE_BUSY','已有两个向量任务，请等待完成。');this.slots++;
    const lockFile=path.join(baseRoot,'build.lock');let lock;
    try{
      try{lock=await open(lockFile,'wx');}catch(error){
        if(error.code!=='EEXIST')throw error;
        const held=await readJson(lockFile).catch(()=>null);
        if(held?.pid?alive(held.pid):Date.now()-(await stat(lockFile)).mtimeMs<30000)throw embeddingError('KNOWLEDGE_BUSY','此项目已有基础或向量索引任务。');
        await rm(lockFile);lock=await open(lockFile,'wx');
      }
      await lock.writeFile(JSON.stringify({pid:process.pid,requestId,kind:'embedding'}));
      await mkdir(path.dirname(jobFile),{recursive:true});
      return await this.launch(params,{baseRoot,root,jobFile,requestFingerprint,lock,lockFile});
    }catch(error){this.slots--;if(lock){await lock.close();await rm(lockFile,{force:true});}throw error;}
  }
  async launch(params,paths){
    const {project,profile,key,config,roots,requestId,mode,resumeOf,previous}=params,{root,baseRoot,jobFile,requestFingerprint,lock,lockFile}=paths;
    const record={jobId:requestId,requestId,projectId:project.projectId,projectHandle:project.projectHandle,projectFile:project.projectFile,descriptorHash:project.descriptorHash,configFingerprint:profile.configFingerprint,policyFingerprint:hashEmbedding(config),spaceFingerprint:profile.spaceFingerprint,profileId:profile.profileId,model:profile.model,roots,mode,requestFingerprint,...(resumeOf?{resumeOf}:{}),pid:process.pid,status:'queued',phase:'queued',createdAt:new Date().toISOString(),embeddingRequests:0,previousRequests:(previous?.previousRequests??0)+(previous?.embeddingRequests??0),usage:{},previousUsage:previous?Object.fromEntries([...new Set([...Object.keys(previous.usage??{}),...Object.keys(previous.previousUsage??{})])].map(key=>[key,(previous.usage?.[key]??0)+(previous.previousUsage?.[key]??0)])): {}};
    const control=new AbortController(),entry={record,control,persist:Promise.resolve()};
    const save=()=>{const snapshot=structuredClone(record);entry.persist=entry.persist.then(async()=>{await atomicJson(jobFile,snapshot);await atomicJson(path.join(root,'latest-job.json'),snapshot);this.onChange();});return entry.persist;};
    await save();this.entries.set(`${project.projectId}:${requestId}`,entry);
    const generation=randomUUID(),cache=path.join(baseRoot,'generations',generation);
    const timeout=setTimeout(()=>control.abort(embeddingError('EMBEDDING_JOB_TIMEOUT','任务已达到总时限；可手动继续，成功缓存会复用。')),profile.jobTimeoutMs);
    entry.done=(async()=>{
      try{
        record.status='scanning';record.phase='scanning';await save();control.signal.throwIfAborted();
        await this.validate(project,profile,key,config);control.signal.throwIfAborted();
        const base=await this.runBase({project,cache,config,request:{tool:'project_update'}},{signal:control.signal,timeoutMs:300000,onProgress:p=>{if(record.status==='scanning'){Object.assign(record,p);void save().catch(()=>control.abort());}}});
        record.status='running';record.phase='embedding';await save();control.signal.throwIfAborted();
        await this.validate(project,profile,key,config);control.signal.throwIfAborted();
        const manifest=await this.runVector({project,cache,profile,key,roots,vectorCacheFile:path.join(root,'vectors.sqlite')},{signal:control.signal,onProgress:p=>{if(record.status==='running'){Object.assign(record,p);void save().catch(()=>control.abort());}}});
        control.signal.throwIfAborted();
        const fresh=await this.runBase({project,cache,request:{tool:'project_status'}},{signal:control.signal,timeoutMs:120000});
        if(!fresh.sourceFresh||fresh.memoryStatus?.data?.memory?.status!=='fresh')throw embeddingError('SOURCE_CHANGED','来源在向量构建期间变化，未发布；请手动继续。');
        await this.validate(project,profile,key,config);control.signal.throwIfAborted();
        if(hashEmbedding(await readFile(project.projectFile,'utf8'))!==project.descriptorHash)throw embeddingError('PROJECT_CHANGED','工程描述符已变化，未发布。');
        record.status='publishing';record.phase='publishing';await save();
        await atomicJson(path.join(baseRoot,'current.json'),{projectId:project.projectId,generation,updatedAt:manifest.createdAt,vectorProfileFingerprint:manifest.profileFingerprint});
        record.status='succeeded';record.phase='complete';record.result={generation,manifest,baseWarnings:base.warnings};
      }catch(error){
        const reason=control.signal.aborted?control.signal.reason:error;
        record.failureStage=record.phase;
        record.error=embeddingFailure(reason??error,{cancelled:control.signal.aborted});
        record.status=control.signal.aborted&&record.error.code==='CANCELLED'?'cancelled':'failed';record.phase=record.status;
      }finally{
        clearTimeout(timeout);record.finishedAt=new Date().toISOString();try{await save();}finally{this.slots--;await lock.close();await rm(lockFile,{force:true});}
      }
    })();
    void entry.done.catch(()=>{record.status='failed';record.error={code:'EMBEDDING_STATE_WRITE_FAILED',message:'无法持久化任务状态；成功向量缓存可在后续构建中复用。'};this.onChange();});
    return structuredClone(record);
  }
  abortAll(reason=embeddingError('CANCELLED','向量任务已停止。')){for(const entry of this.entries.values())if(active.has(entry.record.status)&&entry.record.status!=='publishing')entry.control.abort(reason);}
  async cancel(project,jobId){
    const {job}=await this.status(project,jobId),entry=this.entries.get(`${project.projectId}:${jobId}`);
    if(!entry){if(active.has(job.status))throw embeddingError('JOB_OWNED_BY_OTHER_HOST','请在启动任务的 DSH 进程中取消。');return job;}
    if(active.has(entry.record.status)&&entry.record.status!=='publishing')entry.control.abort(embeddingError('CANCELLED','向量任务已取消；已提交请求可能计费，成功缓存已保留。'));
    await entry.done;return structuredClone(entry.record);
  }
  async dispose(){this.closed=true;await Promise.allSettled([...this.starts.values()].map(start=>start.promise));this.abortAll();await Promise.allSettled([...this.entries.values()].map(entry=>entry.done));}
}
