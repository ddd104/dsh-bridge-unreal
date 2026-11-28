import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {setTimeout as delay} from 'node:timers/promises';
import {EmbeddingPanel} from '../src/embedding-client.mjs';
import {mainSessionId} from '../src/client.mjs';
import {settingsColors} from '../src/settings-ui.mjs';

const h=React.createElement,button=(tree,label)=>tree.root.findAllByType('button').find(node=>node.children.includes(label)),text=tree=>JSON.stringify(tree.toJSON());
function fixture(){
  const calls=[],state={profile:{enabled:true,endpoint:'https://example.test/v1/embeddings',model:'test',configFingerprint:'a'.repeat(64)},credentialConfigured:true,credentialWritable:true,job:null,index:null};
  const context={project:{projectHandle:'a',name:'EHV',editorId:'ue-a',bindingVersion:2,connected:true,projectFile:'F:/EHV/EHV.uproject',knowledgeRoot:'F:/EHV/ProjectKnowledge',cacheRoot:'F:/EHV/Plugins/DSHUnrealBridge/Cache/Knowledge'},embedding:state,base:{job:null}};
  const access={context:async()=>({...context})};
  for(const name of ['setCredential','removeCredential','test','build','cancel','resume','baseBuild','baseCancel'])access[name]=async options=>{calls.push({name,options});return {jobId:'job',status:'succeeded',model:'test',dimensions:4,embeddingRequests:1};};
  return {calls,state,context,access};
}
async function mount(t,access,props={}){
  let tree;await act(async()=>{tree=Renderer.create(h(EmbeddingPanel,{access,...props}));});
  t.after(async()=>{await act(async()=>tree.unmount());});
  return {tree,update:async props=>act(async()=>tree.update(h(EmbeddingPanel,{access,...props}))),click:async label=>act(async()=>button(tree,label).props.onClick())};
}
test('knowledge settings use the bound UE with fixed document/cache paths and no project chooser',async t=>{
  const f=fixture(),ui=await mount(t,f.access);
  assert.equal(f.calls.length,0);assert.equal(ui.tree.root.findAllByType('select').length,0);
  assert.match(text(ui.tree),/绑定项目：EHV/);assert.match(text(ui.tree),/F:\/EHV\/ProjectKnowledge/);assert.match(text(ui.tree),/Plugins\/DSHUnrealBridge\/Cache/);
  assert.equal(button(ui.tree,'生成/更新向量索引').props.disabled,false);
  await ui.update({draftPending:true});for(const label of ['测试连接','生成/更新向量索引','更新基础索引'])assert.equal(button(ui.tree,label).props.disabled,true);
});
test('unbound settings never guess among registered projects or start an index',async t=>{
  const f=fixture();f.context.project=null;f.context.reason='请先绑定 UE 项目。';const ui=await mount(t,f.access);
  assert.match(text(ui.tree),/请先绑定 UE/);assert.equal(button(ui.tree,'更新基础索引').props.disabled,true);assert.equal(button(ui.tree,'生成/更新向量索引').props.disabled,true);assert.equal(f.calls.length,0);
});
test('credentials stay global; index actions carry the bound project and binding revision',async t=>{
  const f=fixture(),ui=await mount(t,f.access);
  await act(async()=>ui.tree.root.findByProps({name:'embeddingApiKey'}).props.onChange({target:{value:'fake-ui-key'}}));
  await ui.click('保存 API Key');assert.equal(ui.tree.root.findByProps({name:'embeddingApiKey'}).props.value,'');assert.deepEqual(f.calls[0],{name:'setCredential',options:{apiKey:'fake-ui-key',configFingerprint:f.state.profile.configFingerprint}});
  await ui.click('测试连接');assert.match(text(ui.tree),/连接成功/);assert.equal(f.calls[1].options.projectHandle,undefined);
  await ui.click('生成/更新向量索引');assert.deepEqual(f.calls[2].options.roots,['ProjectKnowledge']);assert.equal(f.calls[2].options.projectHandle,'a');assert.equal(f.calls[2].options.bindingVersion,2);
  await ui.click('重建向量索引');assert.equal(f.calls[3].options.mode,'rebuild');assert.notEqual(f.calls[3].options.requestId,f.calls[2].options.requestId);
});
test('late responses from another conversation cannot replace the new bound project',async t=>{
  let release;const a=fixture(),b=fixture();a.access.context=()=>new Promise(resolve=>{release=resolve;});b.context.project={...b.context.project,projectHandle:'b',name:'OtherUE',editorId:'ue-b'};
  const ui=await mount(t,a.access);await ui.update({access:b.access});assert.match(text(ui.tree),/OtherUE/);
  await act(async()=>release(a.context));assert.doesNotMatch(text(ui.tree),/绑定项目：EHV/);
  await ui.click('更新基础索引');assert.equal(b.calls[0].options.projectHandle,'b');assert.equal(a.calls.length,0);
});
test('binding refresh and task polling never submit work; cancellation carries the original binding',async t=>{
  const f=fixture();f.state.job={jobId:'old-job',status:'running',phase:'embedding'};let reads=0;f.access.context=async()=>{reads++;return {...f.context};};
  f.access.cancel=async options=>{f.calls.push({name:'cancel',options});return f.state.job={...f.state.job,status:'cancelled',phase:'cancelled'};};
  const ui=await mount(t,f.access),before=reads;await act(async()=>delay(1100));assert.ok(reads>before);assert.equal(f.calls.length,0);
  await ui.click('取消向量任务');assert.deepEqual(f.calls[0].options,{projectHandle:'a',bindingVersion:2,jobId:'old-job'});
  f.context.project={...f.context.project,projectHandle:'b',name:'OtherUE',bindingVersion:3};f.state.job=null;
  await act(async()=>delay(1100));assert.match(text(ui.tree),/OtherUE/);await ui.click('更新基础索引');assert.equal(f.calls[1].options.projectHandle,'b');
});
test('current session comes from the main view, never the last active or running background chat',()=>{
  assert.equal(mainSessionId({byId:{a:{id:'a',retainedBy:{mainView:1}},b:{id:'b',retainedBy:{unrealBridge:1},running:true}}}),'a');
  assert.equal(mainSessionId({byId:{a:{id:'a',retainedBy:{unrealBridge:1}}}}),null);
  assert.equal(mainSessionId({byId:{a:{id:'a',retainedBy:{mainView:1}},b:{id:'b',retainedBy:{mainView:1}}}}),null);
});

test('connection test explains disabled state and exposes pending, green success and red failure without keeping an old success',async t=>{
  const f=fixture();f.context.project=null;f.state.profile.enabled=false;
  const ui=await mount(t,f.access);assert.equal(button(ui.tree,'测试连接').props.disabled,true);assert.match(text(ui.tree),/请先启用/);assert.match(button(ui.tree,'测试连接').props.title,/保存设置/);assert.equal(f.calls.length,0);
  f.state.profile.enabled=true;await ui.update({configRevision:1});assert.equal(button(ui.tree,'测试连接').props.disabled,false);
  let resolve,reject;f.access.test=()=>new Promise((a,b)=>{resolve=a;reject=b;});
  let work;await act(async()=>{work=button(ui.tree,'测试连接').props.onClick();});assert.equal(button(ui.tree,'测试中…').props.disabled,true);assert.match(text(ui.tree),/正在连接/);
  await act(async()=>{resolve({model:'test',dimensions:1024});await work;});assert.equal(ui.tree.root.findByProps({'data-tone':'success'}).props.style.color,settingsColors.success);
  await act(async()=>{work=button(ui.tree,'测试连接').props.onClick();});assert.equal(ui.tree.root.findAllByProps({'data-tone':'success'}).length,0);
  await act(async()=>{reject(new Error('API Key 无效（401）'));await work;});const failed=ui.tree.root.findByProps({'data-tone':'error'});assert.equal(failed.props.style.color,settingsColors.error);assert.equal(failed.props.role,'alert');assert.match(text(ui.tree),/401/);assert.equal(button(ui.tree,'测试连接').props.disabled,false);
  await ui.update({draftPending:true});assert.equal(button(ui.tree,'测试连接').props.disabled,true);assert.match(button(ui.tree,'测试连接').props.title,/先保存/);
});

test('stopped job explains retained progress, failure cause and direct resume; changed settings require a new build',async t=>{
  const f=fixture();f.state.job={jobId:'stopped',status:'failed',phase:'failed',failureStage:'embedding',completedInputs:1450,uniqueInputs:2033,failedInputs:20,configFingerprint:f.state.profile.configFingerprint,error:{code:'EMBEDDING_TIMEOUT',message:'单次请求等待 30 秒后超时，已尝试 3 次。',details:{attempts:3,timeoutMs:30000}}};
  const ui=await mount(t,f.access);assert.match(text(ui.tree),/剩余 583/);assert.match(text(ui.tree),/30 秒/);assert.match(text(ui.tree),/单次请求超时/);assert.match(text(ui.tree),/查看错误详情/);
  assert.equal(button(ui.tree,'继续未完成任务').props.disabled,false);await ui.click('继续未完成任务');assert.equal(f.calls[0].name,'resume');assert.equal(f.calls[0].options.jobId,'stopped');
  f.state.job.error={code:'CANCELLED',message:'向量任务已停止。'};delete f.state.job.failureStage;f.state.job.configFingerprint='old';await ui.update({configRevision:2});
  assert.match(text(ui.tree),/不能据此判断为手动取消/);assert.equal(button(ui.tree,'继续未完成任务').props.disabled,true);assert.match(text(ui.tree),/设置已改变/);
});
