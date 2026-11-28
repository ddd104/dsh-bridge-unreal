import path from 'node:path';
import {open,rm,stat} from 'node:fs/promises';
import {atomicJson,readJson} from './knowledge-jobs.mjs';
import {samePath,insidePath} from './project-context.mjs';
import {fail} from './protocol.mjs';

export const snapshotExportTools=['snapshot_export_start','snapshot_export_status','snapshot_export_cancel'];
export const snapshotReadTools=['read_asset_snapshot','search_asset_snapshots'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class SnapshotService {
  constructor(knowledge){this.knowledge=knowledge;this.imports=new Map();}
  root(project){return path.join(this.knowledge.jobs.rootFor(project),'snapshots');}
  async current(project){
    await this.knowledge.jobs.migration.ensure(project);
    const root=this.root(project),file=path.join(root,'current.json');await this.knowledge.jobs.checkPath(file);
    const pointer=await readJson(file);if(!pointer)return null;
    if(pointer.projectId!==project.projectId||!uuid.test(pointer.generation)||!/^[a-f0-9]{40}$/.test(pointer.manifestSha1))fail('SNAPSHOT_INVALID','Invalid local snapshot pointer.');
    if(pointer.descriptorHash!==project.descriptorHash)fail('SNAPSHOT_STALE','Project descriptor changed since snapshot import.');
    const cache=path.join(root,'generations',pointer.generation);await this.knowledge.jobs.checkPath(cache);
    return {...pointer,cache};
  }
  async status(project){
    try{const current=await this.current(project);return current?{available:true,generation:current.generation,editorId:current.editorId,capturedAt:current.capturedAt,assetCount:current.assetCount,complete:current.complete,excludedCount:current.excludedCount,freshness:'checked_per_asset',liveState:'not_verified'}:{available:false,reason:'snapshot_missing'};}
    catch(error){return {available:false,reason:error.code??'snapshot_unavailable'};}
  }
  async publish(project,imported,check){
    const root=this.root(project),file=path.join(root,'current.json'),lockFile=path.join(root,'publish.lock');
    await this.knowledge.jobs.checkPath(file);await this.knowledge.jobs.checkPath(lockFile);
    let lock;
    try{lock=await open(lockFile,'wx');}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const held=await readJson(lockFile).catch(()=>null);let alive=true;
      if(held?.pid){try{process.kill(held.pid,0);}catch(error){alive=error.code==='EPERM';}}
      else alive=Date.now()-(await stat(lockFile)).mtimeMs<30000;
      if(alive)fail('SNAPSHOT_IMPORT_BUSY','Another host is publishing this project snapshot.');
      await rm(lockFile);lock=await open(lockFile,'wx');
    }
    try{
      await lock.writeFile(JSON.stringify({pid:process.pid}));
      const previous=await readJson(file);await check();
      await atomicJson(file,{...imported,projectId:project.projectId});
      try{await check();}
      catch(error){
        // Rebinding/cancellation while replacing the pointer must not leave a
        // failed import current. The lock excludes another host's publication.
        if(previous)await atomicJson(file,previous);else await rm(file,{force:true});
        throw error;
      }
    }finally{await lock.close();await rm(lockFile,{force:true});}
  }
  async action({project,sessionId,args,signal,verify}){
    const bridge=this.knowledge.bridge,editor=bridge.target(sessionId);
    if(!editor.capabilities.includes('ue_snapshot_export_v1'))fail('SNAPSHOT_CAPABILITY_UNAVAILABLE','This UE version lacks independent snapshot export; existing knowledge tools remain available.');
    const expected=editor;const check=async()=>{await verify();if(bridge.editors.get(editor.editorId)!==expected)fail('INSTANCE_CHANGED','The exporting editor connection changed.');};
    const arg=args.arguments??{},id=args.tool==='snapshot_export_start'?arg.requestId:arg.jobId;
    if(!uuid.test(id??''))fail('INVALID_JOB','Supply a UUID requestId/jobId.');
    await check();
    if(args.tool!=='snapshot_import'){
      const result=await bridge.knowledge(sessionId,{tool:args.tool,arguments:arg},signal);await check();return result;
    }
    const result=await bridge.knowledge(sessionId,{tool:'snapshot_export_status',arguments:{jobId:id}},signal);await check();
    if(result.status!=='succeeded'||!uuid.test(result.generation)||result.editorId!==editor.editorId||!samePath(result.projectFile??'',project.projectFile)||typeof result.snapshotRoot!=='string'||!insidePath(project.projectRoot,result.snapshotRoot)||!result.snapshotRoot.replaceAll('\\','/').endsWith('/Cache/UE/published'))fail('SNAPSHOT_NOT_PUBLISHED','A completed export from this project/editor is required.');
    if(this.imports.has(project.projectId))fail('SNAPSHOT_IMPORT_BUSY','A snapshot import is already running for this project.');
    const task=(async()=>{
      const root=this.root(project);await this.knowledge.jobs.safeRoot(project);await this.knowledge.jobs.checkPath(root);
      const imported=await this.knowledge.runWorker({project,request:{tool:'snapshot_import_internal',arguments:{snapshotRoot:result.snapshotRoot,destination:path.join(root,'generations'),generation:result.generation,editorId:editor.editorId}}},{signal,timeoutMs:120000});
      await this.publish(project,imported,check);
      return {status:'imported',...imported,projectId:project.projectId,knowledgeBackend:'dsh_snapshot',embeddingRequests:0};
    })();this.imports.set(project.projectId,task);
    try{return await task;}finally{this.imports.delete(project.projectId);}
  }
  async read({project,tool,args,signal,verify}){
    const snapshot=await this.current(project);if(!snapshot)fail('SNAPSHOT_MISSING','No imported snapshot is available.');
    const result=await this.knowledge.runWorker({project,request:{tool:'snapshot_query_internal',arguments:{snapshot,tool,args}}},{signal,timeoutMs:this.knowledge.bridge.config.knowledgeTimeoutMs});
    await verify();return {...result,knowledgeBackend:'dsh_snapshot',retrievalMode:'base',projectId:project.projectId,projectHandle:project.projectHandle};
  }
}
