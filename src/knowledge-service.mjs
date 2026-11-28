import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {ProjectContextResolver,samePath,localTarget} from './project-context.mjs';
import {IndexJobManager,runKnowledgeWorker} from './knowledge-jobs.mjs';
import {fail} from './protocol.mjs';
import {hostDocumentToolNames} from './knowledge-protocol.mjs';
import defaultPolicy from '../unreal/DSHUnrealBridge/Config/Knowledge/ProjectMemory.project.json' with {type:'json'};
import {indexPolicyFingerprint,projectKnowledgePolicy} from './knowledge-policy.mjs';
import {projectKnowledgeRoot} from './project-cache.mjs';
import {boundContext} from './knowledge-retrieval.mjs';
import {SnapshotService,snapshotExportTools,snapshotReadTools} from './snapshot-service.mjs';

const localTools=new Set(['project_status','project_context','project_search','graph_query','graph_feature','graph_impact','read_source','validate_evidence',...hostDocumentToolNames]);
const unavailable=new Set(['PROJECT_LOCAL_UNAVAILABLE','PROJECT_NOT_FOUND']);

export class KnowledgeService {
  constructor({getService,bridge,stateDir,runWorker=runKnowledgeWorker}){
    this.bridge=bridge;this.getService=getService;this.runWorker=runWorker;
    this.resolver=new ProjectContextResolver({getService,bridge});
    this.jobs=new IndexJobManager({stateDir,runWorker,onChange:()=>bridge.changed()});
    this.snapshots=new SnapshotService(this);
    this.requests=new Set();this.queryTasks=new Set();this.closed=false;
  }
  async projects(agent,signal){
    const projects=agent?await this.resolver.discover(agent,signal):await this.resolver.known(signal);
    return {capability:'dsh_local_knowledge_v1',documentCapability:'dsh_document_chunks_v2',snapshotCapability:'dsh_published_snapshots_v1',projects:await Promise.all(projects.map(async project=>({...project,knowledgeRoot:projectKnowledgeRoot(project),cacheRoot:this.jobs.rootFor(project),
      editors:this.bridge.list().filter(editor=>samePath(editor.projectPath,project.projectFile)).map(editor=>({editorId:editor.editorId,projectPath:editor.projectPath})),
      snapshotStatus:await this.snapshots.status(project)}))),requiresSelection:projects.length!==1};
  }
  async boundContext(agent,signal){
    const binding=this.binding(agent.session.id);
    let project;
    try{project=await this.resolver.bound(agent,{signal});}
    catch(error){if(!['NOT_BOUND','DISCONNECTED'].includes(error.code))throw error;return {project:null,reason:error.message,embedding:await this.embedding.status()};}
    this.assertBinding(agent.session.id,binding);
    const [embedding,base]=await Promise.all([this.embedding.status({projectHandle:project.projectHandle}),this.status({projectHandle:project.projectHandle},signal)]);
    this.assertBinding(agent.session.id,binding);
    return {project:{...project,knowledgeRoot:projectKnowledgeRoot(project),cacheRoot:this.jobs.rootFor(project)},embedding,base};
  }
  async boundAction(agent,{action,bindingVersion,projectHandle,...options},signal){
    const project=await this.resolver.bound(agent,{projectHandle,signal});
    if(project.bindingVersion!==bindingVersion)fail('INSTANCE_CHANGED','UE 绑定已变化，请刷新后在当前项目重试。');
    const binding=this.binding(agent.session.id),args={...options,projectHandle:project.projectHandle};
    // Revalidate after asynchronous policy/credential reads, immediately before starting work.
    const verify=()=>this.assertBinding(agent.session.id,binding);
    if(action==='baseBuild')return this.build(args,signal,agent,verify);
    if(action==='baseCancel'){verify();return this.cancel(args,signal);}
    if(action==='build')return this.embedding.build(args,verify);
    if(action==='resume')return this.embedding.resume(args,verify);
    if(action==='cancel'){verify();return this.embedding.cancel(args);}
    fail('INVALID_KNOWLEDGE_ACTION','Unknown knowledge action.');
  }
  async status({projectHandle,jobId},signal){const project=await this.resolver.resolveHandle(projectHandle,signal);return {...await this.jobs.status(project,jobId),snapshot:await this.snapshots.status(project)};}
  async build({projectHandle,requestId},signal,agent,verify=()=>{}){
    const project=agent?await this.resolver.resolve(agent,{projectHandle,signal}):await this.resolver.resolveHandle(projectHandle,signal);
    const config=await this.policy(project,signal);
    signal?.throwIfAborted();
    verify();
    return this.jobs.start(project,requestId,config);
  }
  async policy(project,signal){
    let config;
    // Read only a verified, bounded project policy. Never load project-side executable tools.
    for(const relative of ['Plugins/DSHUnrealBridge/Config/Knowledge/ProjectMemory.project.json','AgentTools/ProjectMemorySystem/ProjectMemory.project.json','ProjectMemory.project.json']){
      const file=path.join(project.projectRoot,relative);
      let target;
      try{target=await localTarget(this.getService('fs'),file,signal);}catch(error){if(['ENOENT','ENOTDIR','FS_NOT_FOUND'].includes(error.code))continue;throw error;}
      if(!target.info)continue;
      if(target.info.type!=='file'||!samePath(await realpath(file),file)||(await stat(file)).size>1024*1024)fail('KNOWLEDGE_CONFIG_INVALID','Project index policy must be a local regular file below 1 MiB.');
      config=JSON.parse(await readFile(file,'utf8'));break;
    }
    signal?.throwIfAborted();
    return projectKnowledgePolicy(config??defaultPolicy);
  }
  async cancel({projectHandle,jobId},signal){return this.jobs.cancel(await this.resolver.resolveHandle(projectHandle,signal),jobId);}
  binding(sessionId){return {editorId:this.bridge.sessions.get(sessionId),version:this.bridge.bindingVersions.get(sessionId)??0};}
  assertBinding(sessionId,binding){
    const current=this.binding(sessionId);
    if(current.editorId!==binding.editorId||current.version!==binding.version)fail('INSTANCE_CHANGED','Editor binding changed during the knowledge request; retry in the current project.');
  }
  async context(agent,projectHandle,signal){
    try{return await this.resolver.resolve(agent,{projectHandle,signal});}
    catch(error){if(!projectHandle&&unavailable.has(error.code)&&(!this.bridge.sessions.has(agent.session.id)||error.code==='PROJECT_LOCAL_UNAVAILABLE'))return null;throw error;}
  }
  async query(agent,args,signal){
    if(this.closed)fail('KNOWLEDGE_CLOSED','Knowledge service is shutting down.');
    if(this.requests.size>=4)fail('KNOWLEDGE_BUSY','Four knowledge queries are already active; retry after completion.');
    const control=new AbortController();this.requests.add(control);
    const combined=signal?AbortSignal.any([signal,control.signal]):control.signal;
    const task=this.queryOnce(agent,args,combined);this.queryTasks.add(task);
    try{return await task;}finally{this.requests.delete(control);this.queryTasks.delete(task);}
  }
  async queryOnce(agent,{projectHandle,backend='auto',...args},signal){
    if(args.tool==='project_context'){
      const query=String(args.arguments?.query??'').trim();
      if(!query||query.length>4000||args.arguments?.retrievalMode!==undefined&&!['auto','base'].includes(args.arguments.retrievalMode))fail('INVALID_QUERY','project_context requires a 1..4000 character query and retrievalMode auto or base.');
    }
    const sessionId=agent.session.id,binding=this.binding(sessionId);
    const project=await this.context(agent,projectHandle,signal);
    this.assertBinding(sessionId,binding);
    const verify=async()=>{
      signal?.throwIfAborted();this.assertBinding(sessionId,binding);
      if(project){const current=await this.resolver.resolve(agent,{projectHandle:project.projectHandle,signal});if(current.descriptorHash!==project.descriptorHash)fail('PROJECT_CHANGED','Project changed during the query.');}
      this.assertBinding(sessionId,binding);
    };
    const legacy=async(reasons=[])=>{
      await verify();const result=await this.bridge.knowledge(sessionId,args,signal);await verify();
      const response={...result,retrievalMode:'base',knowledgeBackend:'ue_legacy',degradedReasons:reasons,...(project?{projectId:project.projectId,projectHandle:project.projectHandle}:{})};
      const config=this.embedding?.getConfig()??this.bridge.config;
      return args.tool==='project_context'?boundContext(response,{maxTokens:config.knowledgeContextMaxTokens,maxChars:config.knowledgeContextMaxChars}):response;
    };
    const hostDocumentTool=hostDocumentToolNames.includes(args.tool);
    if([...snapshotExportTools,'snapshot_import'].includes(args.tool)){
      if(!project)fail('PROJECT_LOCAL_UNAVAILABLE','A verified local project is required for snapshot collaboration.');
      return this.snapshots.action({project,sessionId,args,signal,verify});
    }
    if(project&&(snapshotReadTools.includes(args.tool)||args.tool==='graph_impact'&&String(args.arguments?.nodeId??'').startsWith('ueasset:'))&&backend!=='editor'){
      try{return await this.snapshots.read({project,tool:args.tool,args:args.arguments??{},signal,verify});}
      catch(error){signal?.throwIfAborted();await verify();if(backend==='local'||!this.bridge.editors.has(binding.editorId))throw error;return legacy([error.code??'snapshot_unavailable']);}
    }
    if(hostDocumentTool&&(!project||backend==='editor'))fail('KNOWLEDGE_LOCAL_REQUIRED','Document/chunk IDs require a verified local project and the DSH base index; use backend local or auto.');
    if(backend==='local'&&(!project||!localTools.has(args.tool)))fail('KNOWLEDGE_LOCAL_UNAVAILABLE','This tool requires a verified local project and a supported document/source query.');
    if(backend==='editor'||!project||!localTools.has(args.tool))return legacy(project?[]:['local_workspace_unavailable']);
    const editor=this.bridge.editors.get(binding.editorId),canFallback=!hostDocumentTool&&backend!=='local'&&editor?.capabilities.includes('project_knowledge');
    let current,reason;
    try{current=await this.jobs.current(project);}catch(error){reason=error.code??'local_index_unavailable';}
    if(current&&!current.compatible){reason='project_descriptor_changed';current=null;}
    if(hostDocumentTool&&!current)fail('KNOWLEDGE_INDEX_REQUIRED','Build the local base index before reading document/chunk IDs.');
    let snapshot=null,snapshotReason='snapshot_missing';
    if(['project_context','project_status','graph_query'].includes(args.tool))try{snapshot=await this.snapshots.current(project);}catch(error){snapshotReason=error.code??'snapshot_unavailable';}
    // Published local asset evidence also works before a document index exists.
    if(!current&&!snapshot&&canFallback&&!['project_search','read_source','validate_evidence'].includes(args.tool))return legacy([reason??'local_index_missing']);
    const cache=current?.cache??path.join(this.jobs.rootFor(project),'missing');
    if(args.tool==='project_context'&&current){
      try{return await this.retrieveContext({project,current,args,signal,verify,snapshot,snapshotReason});}
      catch(error){signal?.throwIfAborted();await verify();if(canFallback&&!['PROJECT_POLICY_CHANGED','INVALID_QUERY'].includes(error.code))return legacy([error.code??'local_query_failed']);throw error;}
    }
    let result;
    try{result=await this.runWorker({project,cache,snapshot,request:{tool:args.tool,arguments:args.arguments??{}}},{signal,timeoutMs:this.bridge.config.knowledgeTimeoutMs??120000});}
    catch(error){
      signal?.throwIfAborted();await verify();
      if(canFallback)return legacy([error.code??'local_query_failed']);
      throw error;
    }
    await verify();
    const response={...result,retrievalMode:'base',knowledgeBackend:'dsh_local',assetEvidenceBackend:snapshot?'dsh_snapshot':'ue_legacy',...(['project_context','project_status'].includes(args.tool)?{snapshotStatus:result.snapshotStatus??await this.snapshots.status(project)}:{}),projectId:project.projectId,projectHandle:project.projectHandle,indexGeneration:current?.generation??null,degradedReasons:[...(reason?[reason]:[]),...(!current?['local_index_missing']:[])]};
    const config=this.embedding?.getConfig()??this.bridge.config;
    return args.tool==='project_context'?boundContext(response,{maxTokens:config.knowledgeContextMaxTokens,maxChars:config.knowledgeContextMaxChars}):response;
  }
  async retrieveContext({project,current,args,signal,verify,snapshot,snapshotReason}){
    const started=performance.now(),query=String(args.arguments?.query??'').trim();
    if(!query||query.length>4000)fail('INVALID_QUERY','project_context query must contain 1..4000 characters.');
    const envelope={knowledgeBackend:'dsh_local',assetEvidenceBackend:snapshot?'dsh_snapshot':'ue_legacy',projectId:project.projectId,projectHandle:project.projectHandle,indexGeneration:current.generation};
    const config=this.embedding?.getConfig()??this.bridge.config,budget={maxTokens:config.knowledgeContextMaxTokens,maxChars:config.knowledgeContextMaxChars};
    const policy=await this.policy(project)??defaultPolicy,policyFingerprint=indexPolicyFingerprint(policy);
    const policyFile=path.join(current.cache,'ProjectMemory.project.json');await this.jobs.checkPath(policyFile);
    if(indexPolicyFingerprint(JSON.parse(await readFile(policyFile,'utf8')))!==policyFingerprint){
      await verify();return boundContext({query,memory:null,sources:[],warnings:['Project index policy changed; explicitly update the index before reusing indexed evidence.'],retrievalMode:'base',degradedReasons:['project_policy_changed'],...envelope},budget);
    }
    const verifyContext=async()=>{await verify();if(indexPolicyFingerprint(await this.policy(project)??defaultPolicy)!==policyFingerprint)fail('PROJECT_POLICY_CHANGED','Index policy changed during the query; retry after an explicit index update.');};
    await verifyContext();
    const options={signal,timeoutMs:this.bridge.config.knowledgeTimeoutMs??120000};
    let context=await this.runWorker({project,cache:current.cache,request:{tool:'project_context',arguments:{query}},contextOptions:{indexedFirst:true}},options);
    await verifyContext();
    let semantic={results:[],warnings:[],degradedReasons:[],metrics:{embeddingRequests:0,cacheHit:false,usage:{}}};
    if(args.arguments?.retrievalMode==='base'||policy.memory?.semanticRetrieval===false)semantic.degradedReasons=['semantic_retrieval_disabled'];
    else if(this.embedding)semantic=await this.embedding.queries.retrieve({project,current,query,signal,verify:async()=>{
      await verifyContext();if((await this.policy(project)??defaultPolicy).memory?.semanticRetrieval===false)fail('SEMANTIC_RETRIEVAL_DISABLED','This project disabled semantic retrieval during the query.');
    }});
    else semantic.degradedReasons=['embedding_unavailable'];
    await verifyContext();
    try{context=await this.runWorker({project,cache:current.cache,snapshot,request:{tool:'retrieval_finalize',arguments:{context,semantic:semantic.results}}},options);}
    catch(error){
      signal?.throwIfAborted();context={query,memory:null,sources:[],warnings:['Context source verification failed; read current sources explicitly.']};semantic.degradedReasons.push(error.code??'context_verification_failed');
    }
    await verifyContext();
    const hasVector=context.memory?.relevantDocs?.some(hit=>hit.channels?.includes('vector'))??false;
    return boundContext({...context,...envelope,snapshotStatus:context.snapshotStatus??{available:false,reason:snapshotReason},retrievalMode:hasVector?'hybrid':'base',degradedReasons:semantic.degradedReasons,profileFingerprint:semantic.profileFingerprint??null,
      retrieval:{capability:'dsh_hybrid_retrieval_v1',fusion:'rrf-k60-exact-first',queryEmbedding:semantic.metrics,documentEmbeddingRequests:0,vectorCandidates:semantic.results.length,sourceWarnings:semantic.warnings,elapsedMs:Math.round(performance.now()-started)}},budget);
  }
  async record(agent,args,signal){
    const sessionId=agent.session.id,binding=this.binding(sessionId);
    await this.context(agent,undefined,signal);this.assertBinding(sessionId,binding);
    return this.bridge.knowledgeRecord(sessionId,args,signal);
  }
  async dispose(){
    this.closed=true;for(const control of this.requests)control.abort();
    await Promise.allSettled([...this.queryTasks,this.jobs.dispose()]);
  }
}
