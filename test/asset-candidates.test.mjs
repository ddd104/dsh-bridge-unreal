import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {TYPERT} from '../src/remote.mjs';

const asset=path=>({kind:'asset',path,class:'/Script/Engine.DataTable'});
const A=asset('/Game/FolderA/DT_A.DT_A'),B=asset('/Game/FolderB/DT_B.DT_B');
const pause=()=>new Promise(done=>setTimeout(done,20));
async function fixture(t){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-candidates-'));
  const bridge=await new UnrealBridge({port:0,stateDir,allowWrites:false}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  return bridge;
}
async function connect(bridge,editorId='UE1',handle=()=>{},capabilities=['manual_asset_candidates']){
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}});
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId,project:'Fixture',projectPath:'/tmp/fixture',engineVersion:'5.8',pid:1,capabilities}));await ack;
  const calls=[];let sequence=0;
  const reply=(id,result)=>socket.send(JSON.stringify({type:'response',id,ok:true,result}));
  socket.on('message',raw=>{const message=JSON.parse(raw);if(message.type==='request'){calls.push(message);const result=handle(message);if(result!==undefined)reply(message.id,result);}});
  return {socket,calls,reply,event:(event,data)=>socket.send(JSON.stringify({type:'event',sequence:++sequence,event,data}))};
}

test('only explicit candidate snapshots populate manual selection; live objects and other editors stay separate',async t=>{
  const bridge=await fixture(t),one=await connect(bridge),two=await connect(bridge,'UE2');
  bridge.bind('chat','UE1');bridge.bind('shared','UE1');bridge.bind('other','UE2');
  one.event('selection_changed',{assets:[A]});await pause();
  assert.deepEqual(bridge.state('chat').selection,[]);
  one.event('asset_candidates_changed',{revision:1,assets:[A]});await pause();
  one.event('selection_changed',{assets:[B]});
  one.event('asset_candidates_changed',{revision:2,assets:[A,B]});await pause();
  const actor={kind:'actor',path:'/Game/Map.Map:PersistentLevel.Car',class:'/Script/Engine.Actor',name:'Car',label:'Car',worldPath:'/Game/Map.Map'};
  one.event('selection_changed',{assets:[actor]});await pause();
  assert.deepEqual(bridge.state('chat').selection,[A,B]);
  assert.deepEqual(bridge.state('chat').liveSelection,[actor]);
  assert.deepEqual(bridge.state('shared').selection,[A,B]);
  assert.deepEqual(bridge.state('other').selection,[]);
  two.event('asset_candidates_changed',{revision:1,assets:[B]});await pause();
  assert.deepEqual(bridge.state('other').selection,[B]);
});

test('candidate edits are editor-scoped context changes, available with asset writes disabled',async t=>{
  const bridge=await fixture(t),peer=await connect(bridge,'UE1',()=>({revision:2,assets:[B]}));
  bridge.bind('chat','UE1');peer.event('asset_candidates_changed',{revision:1,assets:[A,B]});await pause();
  const result=await bridge.editAssetCandidates('chat',{editorId:'UE1',revision:1,action:'remove',paths:[A.path]});
  assert.deepEqual(result.selection,[B]);
  assert.equal(peer.calls.length,1);assert.equal(peer.calls[0].method,'asset_candidates_edit');
  assert.deepEqual(peer.calls[0].params,{revision:1,action:'remove',paths:[A.path]});
  await assert.rejects(bridge.editAssetCandidates('chat',{editorId:'UE2',revision:2,action:'clear'}),{code:'INSTANCE_CHANGED'});
  await assert.rejects(bridge.editAssetCandidates('chat',{editorId:'UE1',revision:2,action:'clear',paths:[B.path]}));
  assert.equal(peer.calls.length,1);
  const descriptor=TYPERT.invocations.find(item=>item.method==='editAssetCandidates');
  assert.equal(descriptor.scope.context,'agent');
  assert.equal(descriptor.parameters[1].codec.create().parse({editorId:'UE1',revision:2,action:'clear'}).action,'clear');
});

test('late edit replies cannot erase assets newly attached in the editor',async t=>{
  const bridge=await fixture(t),peer=await connect(bridge);
  bridge.bind('chat','UE1');peer.event('asset_candidates_changed',{revision:1,assets:[A]});await pause();
  const edit=bridge.editAssetCandidates('chat',{editorId:'UE1',revision:1,action:'clear'});
  await pause();
  peer.event('asset_candidates_changed',{revision:3,assets:[B]});await pause();
  peer.reply(peer.calls[0].id,{revision:2,assets:[]});
  assert.deepEqual((await edit).selection,[B]);
  peer.event('asset_candidates_changed',{revision:1,assets:[A]});await pause();
  assert.deepEqual(bridge.state('chat').selection,[B]);
});

test('late candidate edits cannot return another editor binding or overwrite its list',async t=>{
  const bridge=await fixture(t),peer=await connect(bridge);await connect(bridge,'UE2');bridge.bind('chat','UE1');
  const edit=bridge.editAssetCandidates('chat',{editorId:'UE1',revision:0,action:'clear'});
  const rejected=assert.rejects(edit,{code:'INSTANCE_CHANGED'});
  await pause();bridge.bind('chat','UE2');peer.reply(peer.calls[0].id,{revision:1,assets:[]});await rejected;
  assert.equal(bridge.state('chat').editorId,'UE2');assert.deepEqual(bridge.state('chat').selection,[]);
});

test('disconnect keeps explicit candidates as offline metadata and reconnect never seeds them from browsing',async t=>{
  const bridge=await fixture(t),peer=await connect(bridge);bridge.bind('chat','UE1');
  peer.event('asset_candidates_changed',{revision:2,assets:[A]});await pause();
  const closed=once(bridge.editors.get('UE1').ws,'close');peer.socket.close();await closed;
  assert.equal(bridge.state('chat').connected,false);assert.deepEqual(bridge.state('chat').selection,[A]);assert.deepEqual(bridge.state('chat').liveSelection,[]);
  const reconnected=await connect(bridge);reconnected.event('asset_candidates_changed',{revision:2,assets:[A]});reconnected.event('selection_changed',{assets:[B]});await pause();
  assert.deepEqual(bridge.state('chat').selection,[A]);
});
