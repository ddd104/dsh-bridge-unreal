import React,{useEffect,useId,useRef,useState} from 'react';
import {SettingsStyles,settingsColors} from './settings-ui.mjs';
import {embeddingFailureView} from './embedding-failures.mjs';
const h=React.createElement;
const active=job=>job&&['queued','scanning','running','publishing'].includes(job.status);
const labels={queued:'等待处理',scanning:'扫描与构建基础索引',graph:'构建源码图谱',documents:'解析资料',verifying:'核对来源',embedding:'计算向量',verifying_vectors:'验证片段与来源',publishing:'发布索引',complete:'完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};

function FailureInfo({error,job,connection=false}){
  const view=embeddingFailureView(typeof error==='string'?{message:error}:error,job);
  return h('div',{role:'alert','data-tone':'error',className:'ub-feedback',style:{color:settingsColors.error}},
    h('strong',null,connection?'连接失败 · ':job?.failureStage?`${labels[job.failureStage]??job.failureStage}失败 · `:'',view.summary),
    h('p',{style:{marginTop:6}},view.hint),
    view.diagnostics.length?h('details',{style:{marginTop:8,fontSize:12}},h('summary',{style:{cursor:'pointer'}},'查看错误详情'),...view.diagnostics.map(line=>h('p',{key:line,style:{overflowWrap:'anywhere'}},line))):null);
}

export function EmbeddingPanel({access,draftPending=false,writable=true,configRevision=0}){
  const inputId=useId();
  const [context,setContext]=useState(null),[status,setStatus]=useState(null),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[connection,setConnection]=useState(null),[base,setBase]=useState(null);
  const mounted=useRef(true),epoch=useRef(0),pending=useRef(false),selected=useRef(''),request=useRef(0),currentAccess=useRef(access);
  currentAccess.current=access;
  const project=context?.project,handle=project?.projectHandle,roots=['ProjectKnowledge'];
  const scope={projectHandle:handle,bindingVersion:project?.bindingVersion};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
  const refresh=async()=>{
    const sequence=++request.current,result=await access.context();
    if(!mounted.current||currentAccess.current!==access||sequence!==request.current)return;
    const identity=JSON.stringify([result.project?.projectHandle,result.project?.editorId,result.project?.bindingVersion]);
    if(identity!==selected.current){selected.current=identity;epoch.current++;setNotice('');setConnection(null);}
    setContext(result);setStatus(result.embedding);setBase(result.base?.job??null);
    return result.embedding;
  };
  useEffect(()=>{
    epoch.current++;request.current++;setContext(null);setStatus(null);setBase(null);setError('');setNotice('');let stopped=false,timer;
    const poll=async()=>{try{await refresh();}catch(failure){if(!stopped){setContext(null);setStatus(null);setBase(null);setError(failure.message??'无法读取当前 UE 项目的知识状态。');}}if(!stopped)timer=setTimeout(poll,1000);};
    void poll();return()=>{stopped=true;request.current++;clearTimeout(timer);};
  },[access,configRevision]);
  useEffect(()=>{setKey('');setConnection(null);},[access,configRevision]);
  const execute=async(action,success,{connectionTest=false}={})=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');const version=epoch.current;
    if(connectionTest)setConnection({kind:'pending'});
    try{const value=await action();if(mounted.current&&version===epoch.current){if(success)success(value);await refresh();}}
    catch(failure){if(mounted.current&&version===epoch.current){const error={code:failure.code,message:failure.message??'操作失败，请刷新状态后重试。',details:failure.details};if(connectionTest)setConnection({kind:'error',error});else setError(error);}}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const profile=status?.profile,disabled=!writable||draftPending||busy,ready=!!profile;
  const job=status?.job,index=status?.index,canBuild=!disabled&&ready&&profile.enabled&&status.credentialConfigured&&handle&&roots.length&&!active(job)&&!active(base);
  const button=(label,onClick,blocked=false,className='',title)=>h('button',{type:'button',className,disabled:!!blocked,onClick,title},label);
  const configFingerprint=profile?.configFingerprint,testing=connection?.kind==='pending';
  const resumable=['failed','cancelled','interrupted'].includes(job?.status);
  const testReason=!writable?'当前配置只读。':draftPending?'请先保存上方配置，再测试连接。':!status?'正在读取服务配置…':!profile?.enabled?'请先启用“语义检索与云端向量”并保存设置。':!profile?.endpoint||!profile?.model?'请先填写并保存服务地址和 Embedding 模型。':!status.credentialConfigured?'请先保存 API Key。':busy&&!testing?'请等待当前操作完成。':'';
  const feedback=(message,tone='error')=>h('p',{role:tone==='error'?'alert':'status',className:'ub-feedback',style:{color:settingsColors[tone]}},message);
  return h('section',{'aria-label':'知识库与向量索引操作',className:'ub-knowledge ub-stack'},
    h(SettingsStyles),
    h('section',{className:'ub-card','aria-label':'凭据与连接'},
      h('div',{className:'ub-card-header'},h('div',null,h('h3',null,'凭据与连接'),h('p',{className:'ub-subtitle'},'API Key 独立保存在 DSH 用户侧，不写入工程。')),
        h('span',{className:'ub-badge',role:'status',style:status?.credentialConfigured?{color:settingsColors.success}:undefined},status?.credentialConfigured?'Key 已配置':'Key 未配置')),
      h('div',{className:'ub-credential-row'},
        h('div',{className:'ub-credential-field'},h('label',{htmlFor:inputId},'API Key'),h('input',{id:inputId,name:'embeddingApiKey',type:'password',autoComplete:'new-password',placeholder:status?.credentialConfigured?'已保存 · 输入新 Key 可替换':'输入服务的 API Key',value:key,disabled:disabled||!profile?.endpoint||!status?.credentialWritable,onChange:event=>setKey(event.target.value)})),
        h('div',{className:'ub-actions'},
          button('保存 API Key',()=>{const value=key;setKey('');void execute(()=>access.setCredential({configFingerprint,apiKey:value}),()=>{setConnection(null);setNotice('API Key 已保存。');});},disabled||!key.trim()||!profile?.endpoint||!status?.credentialWritable),
          button('移除 API Key',()=>execute(()=>access.removeCredential({configFingerprint}),()=>{setKey('');setConnection(null);setNotice('API Key 已移除，正在运行的向量任务已停止。');}),disabled||!status?.credentialConfigured||!status?.credentialWritable,'ub-quiet'))),
      h('div',{className:'ub-test-row'},
        button(testing?'测试中…':'测试连接',()=>execute(()=>access.test({configFingerprint,requestId:crypto.randomUUID()}),result=>setConnection({...result,kind:'success'}),{connectionTest:true}),busy||!!testReason,'',testReason||'发送一条固定短文本验证服务'),
        h('div',{className:'ub-test-feedback','aria-live':'polite','aria-atomic':true},
          testing?h('p',{role:'status'},'正在连接 Embedding 服务…'):connection?.kind==='success'?h('p',{role:'status','data-tone':'success',style:{color:settingsColors.success}},h('strong',null,'连接成功'),` · ${connection.model} · ${connection.dimensions} 维`):connection?.kind==='error'?h(FailureInfo,{error:connection.error,connection:true}):h('p',{className:'ub-subtitle',role:'status'},testReason||'配置就绪，可以测试连接。'))),
      h('p',{className:'ub-field-hint'},'仅发送一条固定短文本，可能计费；无需绑定 UE，也不会发送项目资料。更换服务地址后需保存对应 Key。'),
      connection&&testReason?h('p',{className:'ub-field-hint',role:'status'},testReason):null,
      status?.credentialBackend?h('p',{className:'ub-field-hint'},status.credentialBackend==='windows_dpapi'?'凭据存储：Windows 用户加密存储':'凭据存储：DSH 凭据存储'):null,
      status?.configError?feedback(status.configError.message):null),
    error?h(FailureInfo,{error}):null,notice?feedback(notice,'success'):null,
    h('section',{className:'ub-card','aria-label':'项目知识库'},
      h('div',{className:'ub-card-header'},h('div',null,h('h3',null,'项目知识库'),h('p',{className:'ub-subtitle'},'跟随当前对话绑定的 UE 工程，多对话共用同一工程知识库。')),
        h('span',{className:'ub-badge'},status?.retrievalMode==='hybrid'?'全文 + 向量':'基础检索')),
      project?h('div',{'aria-label':'当前 UE 知识库'},
        h('p',{style:{fontWeight:600}},`绑定项目：${project.name}`),
        !project.connected?h('p',{className:'ub-field-hint'},'UE 已离线，可继续使用本地索引。'):null,
        h('dl',{className:'ub-project-paths'},...[
          ['工程文件',project.projectFile],['知识资料 · ProjectKnowledge',project.knowledgeRoot],['索引与向量缓存 · 插件 Cache',project.cacheRoot],
        ].map(([label,value])=>h('div',{key:label},h('dt',null,label),h('dd',null,value))))):
        h('div',{className:'ub-empty',role:'status'},context?.reason??'正在读取当前对话绑定的 UE 项目…'),
      draftPending?h('p',{className:'ub-field-hint',role:'status',style:{marginBottom:12}},'请先保存上方配置，再执行索引操作。'):null,
      h('div',{className:'ub-actions'},
        button('生成/更新向量索引',()=>execute(()=>access.build({...scope,configFingerprint,roots,mode:'update',requestId:crypto.randomUUID()}),next=>setStatus(previous=>({...previous,job:next}))),!canBuild,'ub-primary'),
        button('更新基础索引',()=>execute(()=>access.baseBuild({...scope,requestId:crypto.randomUUID()}),next=>setBase(next)),disabled||!handle||active(job)||active(base)),
        active(job)?button('取消向量任务',()=>execute(()=>access.cancel({...scope,jobId:job.jobId}),next=>setStatus(previous=>({...previous,job:next}))),busy||!handle||job.status==='publishing'):null,
        active(base)?button('取消基础任务',()=>execute(()=>access.baseCancel({...scope,jobId:base.jobId}),next=>setBase(next)),busy||!handle||base.status==='publishing'):null),
      h('p',{className:'ub-field-hint'},'向量索引会发送 ProjectKnowledge 中的资料片段，可能计费。基础索引只在本机处理。'),
      h('p',{role:'status',className:'ub-field-hint'},index?`向量索引：${!status.indexCompatible?'配置已变化，需更新':index.chunksIndexed?'就绪':'没有可索引片段'} · ${index.documentsIndexed} 文档 / ${index.chunksIndexed} 片段`:'尚无已发布的向量索引，基础检索仍可使用。'),
      status?.indexError?feedback(status.indexError.message):null,
      job?h('div',{'aria-label':'向量任务状态',className:'ub-task'},h('p',{role:'status'},`向量任务：${labels[job.phase]??job.phase} · 成功 ${job.completedInputs??0}/${job.uniqueInputs??0} · 复用 ${job.cachedInputs??0} · 失败/中止 ${job.failedInputs??0}`),
        job.error?h(FailureInfo,{error:job.error,job}):null,
        resumable&&Number.isInteger(job.uniqueInputs)?h('p',{className:'ub-field-hint'},`已保留 ${job.completedInputs??0} 条成功向量，剩余 ${Math.max(0,job.uniqueInputs-(job.completedInputs??0))} 条未完成（包含本次失败或中止的输入）。来源与模型空间不变时，继续任务会复用这些成功向量。`):null,
        resumable?h('div',{className:'ub-actions',style:{marginTop:10}},button('继续未完成任务',()=>execute(()=>access.resume({...scope,jobId:job.jobId,configFingerprint,requestId:crypto.randomUUID()}),next=>setStatus(previous=>({...previous,job:next}))),disabled||!handle||!profile?.enabled||!status?.credentialConfigured||active(base)||!!job.configFingerprint&&job.configFingerprint!==configFingerprint),
          job.configFingerprint&&job.configFingerprint!==configFingerprint?h('p',{className:'ub-field-hint'},'设置已改变，请点击上方“生成/更新向量索引”；成功缓存仍可复用。'):null):null):null,
      base?h('div',{className:'ub-task',role:'status'},h('p',null,`基础任务：${labels[base.phase]??base.status} · ${base.documentsIndexed??0} 文档 / ${base.chunksIndexed??0} 片段`),base.error?feedback(base.error.message):null):null,
      h('details',{className:'ub-advanced'},h('summary',null,'索引维护与用量'),
        h('div',{className:'ub-actions'},
          button('重建向量索引',()=>execute(()=>access.build({...scope,configFingerprint,roots,mode:'rebuild',requestId:crypto.randomUUID()}),next=>setStatus(previous=>({...previous,job:next}))),!canBuild)),
        h('p',{className:'ub-field-hint'},'重建索引映射时仍复用匹配的成功向量。保存设置和普通聊天不会重建文档向量。'),
        h('p',{className:'ub-field-hint'},'启用且索引兼容时，检索会发送当前查询生成向量，缓存 5 分钟；服务失败时回到基础检索。'),
        job?.cacheRecovered?h('p',{role:'status',className:'ub-field-hint'},'损坏的向量缓存已隔离；本次手动任务会重新计算缺失向量。'):null,
        index?h('p',{className:'ub-field-hint'},`${index.model} / ${index.dimensions||'未确定'} 维 · 构建覆盖率 ${Math.round(index.coverage*100)}% · ${index.createdAt}`):null,
        job?h('p',{className:'ub-field-hint'},`文档向量：本次请求 ${job.embeddingRequests??0} 次，此前 ${job.previousRequests??0} 次，服务报告 Token ${job.usage?.total_tokens??'未提供'}。`):null,
        status?.queryUsage?h('p',{className:'ub-field-hint'},`本次宿主运行的查询向量：请求 ${status.queryUsage.requests} 次，缓存命中 ${status.queryUsage.cacheHits} 次，服务报告 Token ${status.queryUsage.usage?.total_tokens??'未提供'}。`):null,
        h('p',{className:'ub-field-hint'},'费用以服务商账单为准。'))),
  );
}
