import {z} from 'zod';
import {dataTableAddRowsSchema,dataTableRenameRowsSchema,dataTableRenameRowSchema,dataTableDeleteRowsSchema,dataTableDuplicateRowsSchema,dataTableClearSchema} from './protocol.mjs';
import {UnrealBridge} from './bridge.mjs';
import {id,assetPath,patchSchema,createSchema,readSchema,focusSchema,catalogSchema,knowledgeSchema,knowledgeRecordSchema,mcpDescribeSchema,mcpCallSchema,mcpToolsetCallSchema,dataTableCopySchema,dataTablePatchSchema,dataTableWriteRowsSchema,runtimeSnapshotSchema,runtimeHistorySchema,jsonSchema,fail,errorResult} from './protocol.mjs';
import {TYPERT} from './remote.mjs';
import {writeFile} from 'node:fs/promises';
import {VisualService} from './visual.mjs';
import {prepareVisualOutput,renderVisualOutput,normalizeVisualValue} from './visual-output.mjs';
import {visualCaptureSchema,visualCompareSchema,imageAnalyzeSchema} from './protocol.mjs';
import {registerProjectSkills} from './skills.mjs';
import {registerExecutionGuard} from './execution-guard.mjs';
import {registerModelRecovery} from './model-recovery.mjs';
import {GUIDE} from './guide.mjs';
import {createConfigState,registerSettings} from './settings.mjs';
import {CacheManager} from './cache-manager.mjs';
import {createStateService} from './state-service.mjs';
import {operationContext} from './operation-context.mjs';
import {compactExecutionSafety} from './compact-safety.mjs';
import {optionalServices} from './optional-services.mjs';
export {Config} from './settings.mjs';
import {levelBlueprintSchema} from './protocol.mjs';
import {materialReadSchema,materialPatchSchema} from './protocol.mjs';
import {requiresMcpOperationContext} from './mcp-contract.mjs';
import {KnowledgeService} from './knowledge-service.mjs';
import {hostKnowledgeSchema,knowledgeBuildSchema,knowledgeStatusSchema,knowledgeCancelSchema} from './knowledge-protocol.mjs';
import {EmbeddingService} from './embedding-service.mjs';
import {embeddingStatusSchema,embeddingTestSchema,embeddingCredentialSchema,embeddingRemoveCredentialSchema,embeddingBuildSchema,embeddingCancelSchema,embeddingResumeSchema} from './embedding-protocol.mjs';
import {boundKnowledgeActionSchema} from './bound-knowledge.mjs';

export const name='unreal-bridge';
export const inject=['tools','systemPrompt','typert'];
const sessionOf=agent=>{if(!agent?.session?.id)fail('SESSION_REQUIRED','An owning conversation is required');return agent.session.id;};


export async function apply(ctx,raw={}) {
  const configState=createConfigState(raw),config=configState.current,getConfig=()=>configState.snapshot();
  registerSettings(ctx);
  const getService=optionalServices(ctx,['sessionProjections','approval','fs','workingDirectory','attachments','llm','credentials']);
  const outputContext={get:getService};
  const bridge=new UnrealBridge(getConfig(),{getConfig});
  const knowledge=new KnowledgeService({getService,bridge,stateDir:bridge.config.stateDir});
  ctx.effect(()=>()=>knowledge.dispose(),'Unreal knowledge lifetime');
  const embedding=new EmbeddingService({knowledge,getConfig,getService,stateDir:bridge.config.stateDir,onChange:()=>bridge.changed()});
  ctx.effect(()=>()=>embedding.dispose(),'Unreal embedding lifetime');
  ctx.on?.('loader/volatile-update',()=>embedding.configurationChanged());
  ctx.on?.('credentials/record-updated',key=>embedding.credentialChanged(key));
  const guard=registerExecutionGuard(ctx,getConfig,{onChange:()=>bridge.changed(),getService});
  const disposeModelRecovery=registerModelRecovery(ctx,guard);
  ctx.effect(()=>disposeModelRecovery,'Unreal model parameter recovery');
  const state=createStateService(bridge,guard,getConfig);
  const cache=new CacheManager({stateDir:bridge.config.stateDir,getConfig,onError:error=>ctx.logger?.warn?.(`[Unreal Cache] ${error.message}`)});
  ctx.effect(()=>()=>cache.dispose(),'Unreal cache lifetime');
  ctx.on?.('loader/volatile-update',()=>bridge.changed());
  ctx.effect(()=>()=>guard.dispose(),'Unreal execution limits');
  const visual=new VisualService(bridge,{cache,getConfig,readReference:async(path,destination,exec)=>{
    const fs=getService('fs');
    if(!fs?.resolve||!fs?.readBytes)fail('FS_UNAVAILABLE','DSH filesystem service is required to read the reference image');
    const workingDirectory=getService('workingDirectory');
    const cwd=exec.agent&&workingDirectory?.ensure?await workingDirectory.ensure(exec.agent,exec.signal):undefined;
    const target=await fs.resolve(path,{cwd,signal:exec.signal});
    const info=await fs.stat(target,exec.signal);
    if(!info)ctx.emit?.('fs/observed',target,{kind:'absent'},exec);
    if(info?.type!=='file')fail('INVALID_REFERENCE','Reference image must be an accessible regular file');
    const bytes=await fs.readBytes(target,exec.signal,20*1024*1024);
    ctx.emit?.('fs/observed',target,{kind:'present',version:info.version},exec);
    await writeFile(destination,bytes,{flag:'wx'});
  }});
  ctx.effect(()=>()=>visual.dispose(),'Unreal visual lifetime');
  bridge.on('diagnostic',message=>ctx.logger?.warn?.(`[Unreal Bridge] ${message}`));
  try{await bridge.start();}catch(error){await bridge.close();throw error;} ctx.effect(()=>()=>bridge.close(),'Unreal bridge lifetime');
  cache.start();
  const remote={ctx,bridge,state:agent=>state(sessionOf(agent)),bind:(agent,editorId)=>{const session=sessionOf(agent);bridge.bind(session,editorId);return state(session);},editAssetCandidates:async(agent,options)=>{const session=sessionOf(agent);await bridge.editAssetCandidates(session,options);return state(session);},cacheStatus:()=>cache.status(),cacheCleanup:options=>cache.cleanup(options)};
  Object.assign(remote,{
    knowledgeContext:agent=>knowledge.boundContext(agent),
    knowledgeAction:(agent,options)=>knowledge.boundAction(agent,boundKnowledgeActionSchema.parse(options)),
    knowledgeProjects:()=>knowledge.projects(),knowledgeWorkspaceProjects:agent=>bridge.sessions.has(agent.session.id)?knowledge.projects(agent):{projects:[],requiresSelection:false},
    knowledgeStatus:options=>knowledge.status(knowledgeStatusSchema.parse(options)),
    knowledgeBuild:options=>knowledge.build(knowledgeBuildSchema.parse(options)),
    knowledgeCancel:options=>knowledge.cancel(knowledgeCancelSchema.parse(options)),
    embeddingStatus:options=>embedding.status(embeddingStatusSchema.parse(options??{})),
    embeddingTest:options=>embedding.test(embeddingTestSchema.parse(options)),
    embeddingSetCredential:options=>embedding.setCredential(embeddingCredentialSchema.parse(options)),
    embeddingRemoveCredential:options=>embedding.removeCredential(embeddingRemoveCredentialSchema.parse(options)),
    embeddingBuild:options=>embedding.build(embeddingBuildSchema.parse(options)),
    embeddingCancel:options=>embedding.cancel(embeddingCancelSchema.parse(options)),
    embeddingResume:options=>embedding.resume(embeddingResumeSchema.parse(options)),
  });
  remote.typertRemote=Object.freeze({service:remote,serviceKey:'unrealBridge',namespace:'unrealBridge'});
  ctx.provide('unrealBridge',remote);
  ctx.inject?.(['skills','fs'],skillCtx=>{
    const dispose=registerProjectSkills(skillCtx);
    skillCtx.effect(()=>dispose,'Unreal project skills');
  });
  ctx.typert.register(TYPERT);
  ctx.systemPrompt.section({name:'tool:unreal-bridge',order:680,text:GUIDE});
  async function approve(exec,reason){
    if(!config.allowWrites)fail('READ_ONLY','Writes are disabled');
    if(!config.requireApproval)return;
    const approval=getService('approval');if(!approval)fail('APPROVAL_UNAVAILABLE','The DSH approval service is unavailable');
    const outcome=await approval.request({agent:exec.agent,toolName:exec.name,callId:exec.callId,reason,signal:exec.signal});
    if(outcome!=='allowed-once')fail('PERMISSION_DENIED',`Operation was not approved: ${outcome}`);
  }
  async function guarded(exec,execute){
    let result;
    try{await guard.before(exec);result=await execute();}
    catch(error){result=errorResult(error?.name==='AbortError'?Object.assign(new Error('Operation cancelled'),{code:'CANCELLED'}):error);}
    await guard.after(exec,result);
    const budget=guard.status(exec.agent?.session?.id);
    if(budget&&(budget.warning||result?.ok===false)&&result&&typeof result==='object'&&!['unreal_state','unreal_bind'].includes(exec.name))
      result={...result,executionSafety:compactExecutionSafety(budget,result)};
    return result;
  }
  function parseToolArgs(name,schema,args){
    if(['unreal_read_blueprint','unreal_preview_patch','unreal_undo','unreal_save'].includes(name)&&typeof args?.assetPath==='string'&&args.assetPath.includes(':'))fail('LEVEL_BLUEPRINT_REQUIRES_LOOKUP','Use unreal_level_blueprint with the map path, then use its exact Blueprint reference with discovered MCP graph tools. Direct native Blueprint edits and saves do not support level subobjects',{execution:'not_started',retryable:true,recommendedTool:'unreal_level_blueprint'});
    if(!name.startsWith('unreal_mcp_'))return schema.parse(args);
    const parsed=schema.safeParse(args);
    if(!parsed.success){
      const issues=parsed.error.issues.slice(0,10).map(({path,message})=>({path,message}));
      fail('MCP_INVALID_ARGUMENTS','Invalid MCP request arguments; use the advertised parameter schema',{execution:'not_started',retryable:true,issues});
    }
    return parsed.data;
  }
  const tool=(name,description,schema,execute,write=false)=>ctx.tools.register({
    name,description,parameters:jsonSchema(schema),output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    isConcurrencySafe:()=>!write,presentCall:args=>({card:'generic',title:description.split('.')[0],kind:write?'edit':'read',rawInput:args}),
    async execute(args,exec){return guarded(exec,async()=>{
      const session=sessionOf(exec.agent);
      let parsed;
      try{parsed=parseToolArgs(name,schema,args);}
      catch(error){
        const operation=operationContext(bridge,session,name,args);
        if(operation){guard.setOperation(exec,operation);await guard.before(exec);}
        throw error;
      }
      let admitted=false;
      const admit=async evidence=>{
        if(admitted)return;
        admitted=true;
        const replay=evidence?.replay===true;
        const operation=operationContext(bridge,session,name,parsed,replay?undefined:evidence);
        if(replay&&operation)operation.kind='read';
        if(operation){guard.setOperation(exec,operation);await guard.before(exec);}
      };
      const deferredMcp=name==='unreal_mcp_call_toolset'
        ?requiresMcpOperationContext({name:'call_tool',arguments:{toolset_name:parsed.toolsetName,tool_name:parsed.toolName}})
        :name==='unreal_mcp_call'&&requiresMcpOperationContext(parsed);
      if(!deferredMcp)await admit();
      try{return {ok:true,...await execute(parsed,exec,session,admit)};}
      catch(error){
        // Preflight/schema failures have not reached a mutation. Retain their
        // stable fallback accounting; a verified operation is admitted once.
        if(!admitted)await admit();
        throw error;
      }
    });}
  });
  tool('unreal_state','Read available editor instances, current conversation binding/selection, execution limits, and installed visual-tool revision.',z.object({}).strict(),async(_a,_e,s)=>state(s));
  tool('unreal_bind','Bind this conversation to an editor instance, or null to disconnect.',z.object({editorId:id.nullable()}).strict(),async(a,_e,s)=>{bridge.bind(s,a.editorId);return state(s);});
  tool('unreal_runtime_snapshot','Sample properties and components of the exact PIE runtime target. Omit target only for one selected PIE Actor/component. Read-only sampled evidence, not execution history.',runtimeSnapshotSchema,async(a,e,s)=>bridge.runtimeSnapshot(s,a,e.signal));
  tool('unreal_runtime_history','Read this conversation\'s retained PIE snapshot summaries, or one full snapshot by snapshotId. Works while the editor is offline; inspect status and capturedAt before interpreting values.',runtimeHistorySchema,async(a,_e,s)=>bridge.runtimeHistory(s,a));
  tool('unreal_image_analyze','Read original decoded RGBA samples, regional color/alpha statistics and optional explicit background composites from a local image up to 20 MiB. Preserves source alpha; no editor connection, shape inference, scene edit, or visual match verdict.',imageAnalyzeSchema,async(a,e,s)=>normalizeVisualValue(await visual.analyze(s,a,e)));
  const visualTool=(name,description,schema,execute)=>ctx.tools.register({
    name,description,parameters:jsonSchema(schema),output:{schema:{type:'object',properties:{},additionalProperties:true},render:renderVisualOutput},
    isConcurrencySafe:()=>false,presentCall:args=>({card:'generic',title:description.split('.')[0],kind:'read',rawInput:args}),
    async execute(args,exec){return guarded(exec,async()=>{
      const parsed=schema.parse(args),sessionId=sessionOf(exec.agent),editorId=bridge.target(sessionId).editorId;
      const result=await execute(parsed,exec,sessionId);
      if(exec.signal?.aborted)fail('CANCELLED','Visual operation cancelled');
      if(bridge.target(sessionId).editorId!==editorId)fail('INSTANCE_CHANGED','Editor binding changed while preparing image attachments');
      return normalizeVisualValue({ok:true,...result});
    });}
  });
  visualTool('unreal_visual_capture','Capture the selected level Actor/component, an explicit targetPath, a viewport pixel region, or the full editor viewport. Returns a reusable captureId and image evidence; no scene edits.',visualCaptureSchema,async(a,e,s)=>{
    const result=await visual.capture(s,a,e.signal);
    return visual.withEvidence(result,()=>prepareVisualOutput(outputContext,e,result,[{path:result.previewPath,label:'当前 UE 目标区域'}]));
  });
  visualTool('unreal_visual_compare','Compare a referencePath image with a new editor capture or captureId. For color-only subjects with different views/sizes use analysis=color_distribution and explicit referenceRegion/currentRegion, checks=[color]. It returns regional color statistics without alignment or exposure inference. Spatial regression requires confirmed matching capture conditions.',visualCompareSchema,async(a,e,s)=>{
    const result=await visual.compare(s,a,e);
    return visual.withEvidence(result,()=>prepareVisualOutput(outputContext,e,result,[{path:result.evidence.comparison,label:'参考图（左）与当前 UE 截图（右）'},...(result.evidence.heatmapPreview?[{path:result.evidence.heatmapPreview,label:'色差热图：黑色表示无差异，红黄表示差异增大'}]:[])]));
  });
  tool('unreal_catalog','Search loaded native Blueprint functions and read their exact pin definitions. Omit query for common functions. For Make Struct, Make Array, variables and generic array operations, discover BlueprintTools.find_node_types through unreal_mcp_describe.',catalogSchema,async(a,_e,s)=>bridge.catalog(s,a));
  tool('unreal_knowledge','Query project documents, source and published graph/snapshots. project_context may embed the query but never rebuilds document vectors; arguments {query,retrievalMode:"base"} forces zero-network retrieval. Inspect retrievalMode/degradedReasons/sourceStatus. read_chunk {chunkId,expectedHash} and read_document {documentId,expectedHash,offset,maxChunks} verify indexed sources. Explicit UE snapshot workflow: snapshot_export_start {requestId:UUID}, snapshot_export_status/cancel {jobId}, then snapshot_import {jobId}. Export/import write derived cache only, never save assets or rebuild graphs. read_asset_snapshot {assetPath,section?,graph?,offset?,limit?} and search_asset_snapshots {query?,offset?,limit?} use imported saved-package evidence offline; inspect snapshotGeneration/liveState/coverage. backend=editor requests live/legacy editor evidence; backend=local forces local reads. The current conversation binding determines the UE project; an optional projectHandle only validates that binding.',hostKnowledgeSchema,async(a,e)=>{await knowledge.resolver.bound(e.agent,{projectHandle:a.projectHandle,signal:e.signal});return knowledge.query(e.agent,a,e.signal);});
  tool('unreal_knowledge_projects','Return the UE project bound to this conversation and its knowledge/cache paths. No separate project selection or indexing.',z.object({}).strict(),async(_a,e)=>{await knowledge.resolver.bound(e.agent,{signal:e.signal});return knowledge.projects(e.agent,e.signal);});
  tool('unreal_knowledge_build','Explicitly start a background base-index build for the bound UE project. Documents come from ProjectKnowledge; derived files stay in its plugin Cache. Local documents and source graph only; zero Embedding requests. Reuse requestId to inspect the same task.',knowledgeBuildSchema.partial({projectHandle:true}),async(a,e)=>{const project=await knowledge.resolver.bound(e.agent,{projectHandle:a.projectHandle,signal:e.signal});return {job:await knowledge.build({...a,projectHandle:project.projectHandle},e.signal,e.agent)};},true);
  tool('unreal_knowledge_status','Read published local index and background task status for the bound UE project.',knowledgeStatusSchema.partial({projectHandle:true}),async(a,e)=>{const project=await knowledge.resolver.bound(e.agent,{projectHandle:a.projectHandle,signal:e.signal});return knowledge.status({...a,projectHandle:project.projectHandle},e.signal);});
  tool('unreal_knowledge_cancel','Cancel a base-index task; the previous published index stays available.',knowledgeCancelSchema.partial({projectHandle:true}),async(a,e)=>{const project=await knowledge.resolver.bound(e.agent,{projectHandle:a.projectHandle,signal:e.signal});return {job:await knowledge.cancel({...a,projectHandle:project.projectHandle},e.signal)};},true);
  tool('unreal_knowledge_record','Save a sourced inference or reusable planning experience in the bound project cache under the configured approval policy. Use only for conclusions worth retaining.',knowledgeRecordSchema,async(a,e)=>{await approve(e,`保存项目知识：${a.tool}`);return knowledge.record(e.agent,a,e.signal);},true);
  tool('unreal_mcp_tools','List top-level UE 5.8 MCP tools and their input schemas for this editor.',z.object({}).strict(),async(_a,e,s)=>bridge.mcpTools(s,e.signal));
  tool('unreal_mcp_toolsets','List UE 5.8 MCP toolsets available in the bound editor. Use before describing a toolset.',z.object({}).strict(),async(_a,e,s)=>bridge.mcpToolsets(s,e.signal));
  tool('unreal_mcp_describe','Describe a UE 5.8 MCP toolset. Filter by function name; use includeSchema=false for a compact list, then obtain the exact matching schema before calling.',mcpDescribeSchema,async(a,e,s)=>bridge.mcpDescribe(s,a,e.signal));
  tool('unreal_mcp_call','Call a discovered UE 5.8 MCP tool directly in the bound editor without an approval prompt. Supply the exact name, arguments and requestId.',mcpCallSchema,async(a,e,s,admit)=>bridge.mcpCall(s,a,e.signal,admit),true);
  tool('unreal_mcp_call_toolset','Call a discovered UE 5.8 toolset function directly in the bound editor without an approval prompt. Supply the full toolsetName, function short name in toolName, and arguments matching its current discovered schema.',mcpToolsetCallSchema,async(a,e,s,admit)=>bridge.mcpCallToolset(s,a,e.signal,admit),true);
  tool('unreal_data_table_copy_property','Copy one reflected DataTable property from sourceRow to targetRows (omit for all other rows). Atomic native deep copy, verified rollback, no JSON round trip, no save or desktop input.',dataTableCopySchema,async(a,e,s)=>{await approve(e,`复制 DataTable 字段：${a.assetPath}\n${a.sourceRow} → ${a.targetRows?.join(', ')??'其他所有行'}\n${a.propertyName}`);return bridge.copyDataTableProperty(s,a,e.signal);},true);
  tool('unreal_data_table_add_rows','Add DataTable rows: rows:[{rowName,values?}]. Omit values for struct defaults. Existing names fail the whole batch. Preview defaults to dryRun=true; commit with false and a new requestId. Native, atomic, undoable, never saves.',dataTableAddRowsSchema,async(a,e,s)=>{
    if(!a.dryRun)await approve(e,`新增 DataTable 行：${a.assetPath}\n${a.rows.length} 行；不保存`);
    return bridge.addDataTableRows(s,a,e.signal);
  },true);
  const rowManagement=(name,description,schema,action,convert=a=>a)=>tool(name,description+' Requires data_table_manage_rows. Defaults to dryRun=true; commit with false and a new requestId. Atomic native snapshots, verified rollback and undo/redo; never saves.',schema,async(a,e,s)=>{
    if(!a.dryRun)await approve(e,`修改 DataTable 行：${a.assetPath}\n${action}；不保存`);
    return bridge.manageDataTableRows(s,{...convert(a),action},e.signal);
  },true);
  rowManagement('unreal_data_table_rename_rows','Rename rows simultaneously with renames:[{rowName,newRowName}]. Supports swaps, cycles and case-only changes; rejects duplicate sources/destinations and collisions with untouched rows. Preserves row contents and order. External row-name references are not rewritten.',dataTableRenameRowsSchema,'rename');
  rowManagement('unreal_data_table_rename_row','Rename one row using rowName/newRowName. External row-name references are not rewritten.',dataTableRenameRowSchema,'rename',({rowName,newRowName,...a})=>({...a,renames:[{rowName,newRowName}]}));
  rowManagement('unreal_data_table_delete_rows','Delete explicitly named rows:[name,...]. Missing or duplicate names reject the entire batch. Other rows retain their contents and order. External row-name references are not rewritten.',dataTableDeleteRowsSchema,'delete');
  rowManagement('unreal_data_table_duplicate_rows','Deep-copy complete original rows to new names with copies:[{sourceRow,newRowName}]. Can copy one source to several new rows. Targets must not exist; copied values retain their native types and precision.',dataTableDuplicateRowsSchema,'duplicate');
  rowManagement('unreal_data_table_clear','Explicitly remove every row while retaining the DataTable asset and row schema. Empty tables are a no-op. External row-name references are not rewritten.',dataTableClearSchema,'clear');
  tool('unreal_data_table_write_rows','Preview/apply individual DataTable rows with distinct values. mode: update (default, existing rows only), add (new rows only), upsert (either). rows: [{rowName,values}]. Structs/maps merge supplied fields/keys; supplied arrays replace that array. Unspecified fields/rows remain unchanged; new rows use struct defaults. Read get_schema first. Supports scalar values, text, enum identifiers, nested structs/maps/arrays and object references (path, {refPath}, or null). Defaults to dryRun=true; apply with dryRun=false and a new requestId. Atomic, verified, undoable; never saves.',dataTableWriteRowsSchema,async(a,e,s)=>{
    if(!a.dryRun)await approve(e,`写入 DataTable 行：${a.assetPath}\n${a.rows.length} 行；不保存`);
    return bridge.writeDataTableRows(s,a,e.signal);
  },true);
  tool('unreal_data_table_patch','Preview/apply atomic DataTable row edits. Paths traverse existing struct fields, map keys (including enums) and array indices. set writes typed values (structs/maps merge, arrays replace, null clears object references); remove deletes an existing map entry or dynamic array element in operation order; copy deep-copies a matching field from original sourcePath in the same row (or sourceRow). Omit rows for all rows. Example: copy path ["ColorTypeMaterialParams","Green"] from sourcePath ["ColorTypeMaterialParams","Blue"]. Defaults to dryRun=true; use a new requestId and dryRun=false to apply. Verifies every row and rolls back failures; never saves.',dataTablePatchSchema,async(a,e,s)=>{
    if(!a.dryRun)await approve(e,`修改 DataTable 字段：${a.assetPath}\n${a.operations.length} 项操作；不保存`);
    return bridge.patchDataTable(s,a,e.signal);
  },true);
  tool('unreal_material_read','Read a material or material-function graph revision, node identities, editable properties and exact pins. Optionally inspect expression class metadata in the same request. Requires material_graph_patch; material instances use their discovered parameter tools.',materialReadSchema,async(a,e,s)=>bridge.materialRead(s,a,e.signal));
  tool('unreal_material_patch','Preview or apply one coherent material/function graph batch with node aliases, properties, connections and outputs. Defaults to dryRun=true on a transient copy; use the same baseRevision and operations with dryRun=false to commit. Verifies compilation and failure restoration; never saves. Whole-graph layout and cleanup candidates must be explicit.',materialPatchSchema,async(a,e,s)=>{
    if(!a.dryRun)await approve(e,`修改材质图：${a.assetPath}\n${a.operations.length} 项操作；不保存`);
    return bridge.materialPatch(s,a,e.signal);
  },true);
  tool('unreal_read_blueprint','Read a blueprint summary or a graph with exact node IDs and pin names.',readSchema,async(a,e,s)=>bridge.read(s,a,e.signal));
  tool('unreal_level_blueprint','Resolve an existing level Blueprint from a map without creating it or changing levels. Returns exact Blueprint and graph references for MCP tools; requires level_blueprint_lookup.',levelBlueprintSchema,async(a,e,s)=>bridge.levelBlueprint(s,a,e.signal));
  tool('unreal_focus_asset','Open and maximize an asset editor; optionally focus a graph and its nodes. Asset edits already do this automatically.',focusSchema,async(a,e,s)=>bridge.focus(s,a,e.signal));
  tool('unreal_preview_patch','Validate a native function/event node patch against the base revision on a transient copy; returns previewId. For Make Struct, Make Array, local/member variables and generic array operations, discover BlueprintTools with unreal_mcp_describe and use unreal_mcp_call_toolset.',patchSchema,async(a,e,s)=>bridge.preview(s,'patch',a,e.signal));
  tool('unreal_preview_create','Preview creation of a new blueprint; existing assets are rejected.',createSchema,async(a,e,s)=>bridge.preview(s,'create',a,e.signal));
  tool('unreal_apply','Apply an exact validated preview under the configured approval policy. Does not save. Keep requestId for status queries.',z.object({previewId:id,requestId:z.string().uuid()}).strict(),async(a,e,s)=>{const p=bridge.previewRecord(s,a.previewId);await approve(e,`Unreal ${p.kind}: ${p.params.assetPath}\n${JSON.stringify(p.params)}`);return bridge.apply(s,a.previewId,a.requestId,e.signal);},true);
  tool('unreal_request_status','Recover the result of a timed-out request without repeating a write.',z.object({requestId:z.string().uuid()}).strict(),async(a,_e,s)=>bridge.requestStatus(s,a.requestId));
  tool('unreal_undo','Undo the last bridge graph edit only if it is still the latest editor transaction and revision.',z.object({assetPath,baseRevision:id,requestId:z.string().uuid()}).strict(),async(a,e,s)=>{await approve(e,`撤销蓝图修改：${a.assetPath}`);return bridge.mutate(s,'undo',{assetPath:a.assetPath,baseRevision:a.baseRevision},a.requestId,e.signal);},true);
  tool('unreal_save','Save an explicitly requested blueprint after revision and compilation checks.',z.object({assetPath,baseRevision:id,requestId:z.string().uuid()}).strict(),async(a,e,s)=>{await approve(e,`保存蓝图到磁盘：${a.assetPath}`);return bridge.mutate(s,'save',{assetPath:a.assetPath,baseRevision:a.baseRevision},a.requestId,e.signal);},true);
  // Cordis owns cleanup through the registered effect.
}
