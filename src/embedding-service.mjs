import path from 'node:path';
import {readFile} from 'node:fs/promises';
import defaultPolicy from '../unreal/DSHUnrealBridge/Config/Knowledge/ProjectMemory.project.json' with {type:'json'};
import {EmbeddingCredentials,embeddingCredentialId} from './embedding-credentials.mjs';
import {EmbeddingJobs} from './embedding-jobs.mjs';
import {embeddingProfile,embeddingError,requireProfileRevision,hashEmbedding} from './embedding-profile.mjs';
import {requestEmbeddings,CONNECTION_TEST_TEXT} from './embedding-provider.mjs';
import {EmbeddingQueries} from './embedding-queries.mjs';
import {indexPolicyFingerprint} from './knowledge-policy.mjs';
import {validateEmbeddingBatch} from './embedding-provider-errors.mjs';

export class EmbeddingService {
  constructor({knowledge,getConfig,getService,stateDir,onChange=()=>{},credentials,runBase,runVector,fetchImpl}){
    Object.assign(this,{knowledge,getConfig,getService,onChange,fetchImpl});this.closed=false;this.tests=new Map();this.testControls=new Set();
    this.queries=new EmbeddingQueries(this);knowledge.embedding=this;
    this.credentials=credentials??new EmbeddingCredentials({stateDir,getService});
    this.jobs=new EmbeddingJobs({baseJobs:knowledge.jobs,runBase,runVector,onChange,validate:async(project,profile,key,config)=>{
      requireProfileRevision(this.profile(true),profile.configFingerprint);
      const current=await knowledge.resolver.resolveHandle(project.projectHandle);
      if(current.descriptorHash!==project.descriptorHash)throw embeddingError('PROJECT_CHANGED','工程描述符已变化，请重新选择工程。');
      if(await this.credentials.read(profile)!==key)throw embeddingError('EMBEDDING_CREDENTIAL_CHANGED','API Key 已改变，任务已停止；请显式重新启动。');
      if(hashEmbedding(await this.policy(current))!==hashEmbedding(config))throw embeddingError('EMBEDDING_SCOPE_CHANGED','工程索引策略已变化，任务已停止；请重新选择范围。');
      requireProfileRevision(this.profile(true),profile.configFingerprint);
    }});
  }
  profile(required=false){if(this.closed)throw embeddingError('KNOWLEDGE_CLOSED','向量服务正在关闭。');return embeddingProfile(this.getConfig(),{required});}
  configurationChanged(){
    this.queries.invalidate();
    for(const control of this.testControls)control.abort();this.tests.clear();
    for(const entry of this.jobs.entries.values())try{if(this.profile().configFingerprint!==entry.record.configFingerprint&&entry.record.status!=='publishing')entry.control.abort(embeddingError('EMBEDDING_CONFIG_CHANGED','已保存配置发生变化；成功缓存保留，请显式重新启动。'));}catch{entry.control.abort(embeddingError('EMBEDDING_CONFIG_CHANGED','配置已失效，任务已停止。'));}
    this.onChange();
  }
  credentialChanged(id){
    if(id&&!String(id).startsWith('unreal-bridge/embedding-'))return;
    this.queries.invalidate();
    for(const control of this.testControls)control.abort();this.tests.clear();this.jobs.abortAll(embeddingError('EMBEDDING_CREDENTIAL_CHANGED','凭据已改变或移除，任务已停止；成功缓存保留。'));this.onChange();
  }
  async policy(project){return await this.knowledge.policy(project)??structuredClone(defaultPolicy);}
  roots(config){
    if(!Array.isArray(config.knowledgeRoots)||config.knowledgeRoots.length>64)throw embeddingError('EMBEDDING_SCOPE_INVALID','工程 knowledgeRoots 配置无效。');
    return [...new Set(config.knowledgeRoots.map(root=>{
      if(typeof root!=='string'||!root.trim()||path.isAbsolute(root)||root.includes('\0')||root.replaceAll('\\','/').split('/').includes('..'))throw embeddingError('EMBEDDING_SCOPE_INVALID','资料目录必须是工程内的相对路径。');
      return root.replaceAll('\\','/').replace(/\/+$/,'');
    }))];
  }
  async status({projectHandle,jobId}={}){
    let profile,credential,configError;
    try{profile=this.profile();credential=await this.credentials.describe(profile);}catch(error){configError={code:error.code??'EMBEDDING_CONFIG_INVALID',message:error.code?error.message:'Embedding 配置不可用。'};}
    const result={capability:'dsh_embedding_index_v1',retrievalCapability:'dsh_hybrid_retrieval_v1',retrievalMode:'base',profile:profile??null,...credential,...(configError?{configError}:{}),integration:'hybrid_retrieval',queryUsage:structuredClone(this.queries.totals),job:null,index:null};
    if(projectHandle){
      const project=await this.knowledge.resolver.resolveHandle(projectHandle),config=await this.policy(project),status=await this.jobs.status(project,jobId);
      Object.assign(result,status,{projectHandle,projectId:project.projectId,projectFile:project.projectFile,availableRoots:this.roots(config),excludePatterns:[...(config.sourcePolicy?.excludePatterns??[]),...(config.sourcePolicy?.excludeGlobs??[])],indexCompatible:!!profile&&status.index?.spaceFingerprint===profile.spaceFingerprint});
      if(profile?.enabled&&credential?.credentialConfigured&&result.indexCompatible&&status.index?.chunksIndexed>0&&config.memory?.semanticRetrieval!==false){
        try{
          const current=await this.jobs.current(project);
          if(current?.manifest.generation===status.index.generation){
            const policyFile=path.join(current.base.cache,'ProjectMemory.project.json');await this.knowledge.jobs.checkPath(policyFile);
            if(indexPolicyFingerprint(JSON.parse(await readFile(policyFile,'utf8')))===indexPolicyFingerprint(config)&&!(this.queries.cooldowns.get(profile.configFingerprint)?.until>Date.now()))result.retrievalMode='hybrid';
          }
        }catch{result.retrievalReason='index_validation_failed';}
      }
    }else if(jobId)throw embeddingError('PROJECT_SELECTION_REQUIRED','查询任务需要选择 projectHandle。');
    return result;
  }
  async setCredential({configFingerprint,apiKey}){
    const profile=this.profile();requireProfileRevision(profile,configFingerprint);if(!profile.endpoint)throw embeddingError('EMBEDDING_CONFIG_INCOMPLETE','请先保存服务地址，再保存对应的 API Key。');
    const result=await this.credentials.set(profile,apiKey);this.credentialChanged(embeddingCredentialId(profile));return result;
  }
  async removeCredential({configFingerprint}){
    const profile=this.profile();requireProfileRevision(profile,configFingerprint);this.credentialChanged(embeddingCredentialId(profile));return this.credentials.remove(profile);
  }
  async test({requestId,configFingerprint}){
    const profile=this.profile(true);requireProfileRevision(profile,configFingerprint);
    const previous=this.tests.get(requestId);if(previous){if(previous.fingerprint!==configFingerprint)throw embeddingError('EMBEDDING_REQUEST_CONFLICT','测试 requestId 已用于另一配置。');return previous.promise;}
    if(this.testControls.size)throw embeddingError('EMBEDDING_TEST_BUSY','连接测试正在进行。');
    const control=new AbortController();this.testControls.add(control);
    const promise=(async()=>{
      try{
        const key=await this.credentials.read(profile);control.signal.throwIfAborted();
        const response=await requestEmbeddings(profile,key,[CONNECTION_TEST_TEXT],{signal:control.signal,maxRetries:0,fetchImpl:this.fetchImpl});
        requireProfileRevision(this.profile(true),configFingerprint);
        return {status:'connected',provider:profile.provider,model:profile.model,dimensions:response.dimensions,configFingerprint,embeddingRequests:1,usage:response.usage,testedAt:new Date().toISOString()};
      }catch(error){if(control.signal.aborted)throw embeddingError('CANCELLED','配置或凭据已改变，测试已取消。');throw error;}
      finally{this.testControls.delete(control);}
    })();
    this.tests.set(requestId,{fingerprint:configFingerprint,promise});if(this.tests.size>32)this.tests.delete(this.tests.keys().next().value);return promise;
  }
  async build(options,verify=()=>{}){
    const {projectHandle,requestId,configFingerprint,mode,roots}=options,profile=this.profile(true);requireProfileRevision(profile,configFingerprint);
    validateEmbeddingBatch(profile,profile.batchSize);
    const project=await this.knowledge.resolver.resolveHandle(projectHandle),config=await this.policy(project),available=this.roots(config);
    if(!roots?.length||roots.some(root=>!available.includes(root)))throw embeddingError('EMBEDDING_SCOPE_INVALID','请选择当前工程配置中的资料目录。');
    const key=await this.credentials.read(profile);requireProfileRevision(this.profile(true),configFingerprint);
    verify();return this.jobs.start({project,profile,key,config,roots:[...new Set(roots)].sort(),requestId,mode});
  }
  async cancel({projectHandle,jobId}){return this.jobs.cancel(await this.knowledge.resolver.resolveHandle(projectHandle),jobId);}
  async resume({projectHandle,jobId,requestId,configFingerprint},verify=()=>{}){
    const profile=this.profile(true);requireProfileRevision(profile,configFingerprint);
    validateEmbeddingBatch(profile,profile.batchSize);
    const project=await this.knowledge.resolver.resolveHandle(projectHandle),{job}=await this.jobs.status(project,jobId);
    if(!['failed','cancelled','interrupted'].includes(job.status))throw embeddingError('EMBEDDING_NOT_RESUMABLE','只有已停止或中断的任务可以继续。');
    if(job.configFingerprint!==configFingerprint)throw embeddingError('EMBEDDING_CONFIG_CHANGED','该任务使用的配置已变化，请重新生成新空间。');
    const config=await this.policy(project);if(hashEmbedding(config)!==job.policyFingerprint)throw embeddingError('EMBEDDING_SCOPE_CHANGED','工程索引策略已变化，请重新选择范围并生成。');
    const key=await this.credentials.read(profile);requireProfileRevision(this.profile(true),configFingerprint);
    verify();return this.jobs.start({project,profile,key,config,roots:job.roots,requestId,mode:job.mode,resumeOf:jobId,previous:job});
  }
  async dispose(){this.closed=true;if(this.knowledge.embedding===this)this.knowledge.embedding=null;for(const control of this.testControls)control.abort();await this.queries.dispose();await Promise.allSettled([...this.tests.values()].map(test=>test.promise));await this.jobs.dispose();}
}
