// Exercise the real UE Content Browser menu, websocket events and candidate controls.
// node scripts/asset-candidates-e2e.mjs <Engine directory> <.test-state/...uproject>
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,realpath,writeFile,readFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project]=process.argv.slice(2);
assert.ok(engine&&project,'Supply engine and disposable project');
const root=await realpath(resolve('.test-state')),projectPath=await realpath(resolve(project));
const part=relative(root,projectPath);
assert.ok(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep),'Project must be under workspace .test-state');
const stateDir=join(root,'asset-candidates-e2e');await mkdir(stateDir,{recursive:true});
const reportDir=join(stateDir,'native-report-'+Date.now());
const bridge=await new UnrealBridge({port:0,stateDir,allowWrites:false}).start();
const session='candidate-e2e',checks=[],history=[];
const pass=label=>{checks.push(label);console.log('PASS: '+label);};
let child,processError;
const until=async(predicate,timeout=120000)=>{
  const deadline=Date.now()+timeout;
  while(!predicate()){
    if(processError)throw processError;
    if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error('Editor exited '+child.exitCode);
    if(Date.now()>deadline)throw new Error('Editor condition timed out');
    await new Promise(done=>setTimeout(done,100));
  }
};
try{
  bridge.on('change',()=>{if(bridge.sessions.has(session))history.push(structuredClone(bridge.state(session)));});
  child=spawn(join(engine,'Binaries/Win64/UnrealEditor-Cmd.exe'),[projectPath,'/Engine/Maps/Entry','-unattended','-NullRHI','-nosplash','-nop4','-nosound','-NoAutoSave','-DSHCandidateE2E','-ExecCmds=Automation RunTests DSH.Bridge.AssetCandidateBridgeFixture','-ReportExportPath='+reportDir,'-DSHBridgeDescriptor='+bridge.descriptorPath,'-abslog='+join(stateDir,'editor.log')],{stdio:'ignore',windowsHide:true});
  child.once('error',error=>{processError=error;});
  await until(()=>bridge.list().length);
  const editorId=bridge.list()[0].editorId;bridge.bind(session,editorId);
  assert.ok(bridge.target(session).capabilities.includes('manual_asset_candidates'));
  await until(()=>bridge.state(session).assetCandidates!==null);
  assert.equal(bridge.state(session).selectionMode,'manual_assets');
  pass('Real editor advertises explicit candidate attachment and starts with a separate list');
  await until(()=>bridge.state(session).selection.length===2);
  const state=bridge.state(session),[a,b]=state.selection;
  assert.match(a.path,/CandidateFolderA\/DT_Candidate_A_/);assert.match(b.path,/CandidateFolderB\/DT_Candidate_B_/);
  assert.equal(state.assetCandidates.revision,2,'Repeated menu clicks are deduplicated');
  assert.ok(history.some(snapshot=>snapshot.selection.length===0));
  assert.ok(history.some(snapshot=>snapshot.selection.length===1&&snapshot.selection[0].path===a.path));
  assert.deepEqual(state.liveSelection,[]);
  await until(()=>existsSync(join(reportDir,'index.json')));
  const report=JSON.parse((await readFile(join(reportDir,'index.json'),'utf8')).replace(/^\uFEFF/,''));
  assert.equal(report.failed,0);assert.equal(report.succeeded,1);
  pass('Actual menu clicks append across directories, deduplicate and survive browsing changes');
  await assert.rejects(bridge.editAssetCandidates(session,{editorId,revision:1,action:'clear'}),{code:'CANDIDATES_CHANGED'});
  assert.deepEqual(bridge.state(session).selection,[a,b]);
  pass('A stale clear cannot erase candidates added after the displayed list');
  const removed=await bridge.editAssetCandidates(session,{editorId,revision:2,action:'remove',paths:[a.path]});
  assert.deepEqual(removed.selection,[b]);assert.equal(removed.assetCandidates.revision,3);
  pass('DSH removes only the requested candidate with asset writes disabled');
  bridge.target(session).ws.close();await until(()=>!bridge.state(session).connected,10000);
  assert.deepEqual(bridge.state(session).selection,[b]);
  await until(()=>bridge.state(session).connected&&bridge.state(session).assetCandidates?.revision===3,20000);
  assert.deepEqual(bridge.state(session).selection,[b]);
  pass('Disconnect preserves offline metadata and the same UE process reconnects with its candidates');
  const cleared=await bridge.editAssetCandidates(session,{editorId,revision:3,action:'clear'});
  assert.deepEqual(cleared.selection,[]);
  const noop=await bridge.editAssetCandidates(session,{editorId,revision:cleared.assetCandidates.revision,action:'clear'});
  assert.equal(noop.assetCandidates.revision,cleared.assetCandidates.revision);
  pass('Clear synchronizes back to UE and an empty clear is a no-op');
  await writeFile(join(stateDir,'result.json'),JSON.stringify({status:'passed',checks,assets:[a,b],history:history.map(s=>({connected:s.connected,revision:s.assetCandidates?.revision,selection:s.selection}))},null,2));
}catch(error){
  await writeFile(join(stateDir,'result.json'),JSON.stringify({status:'failed',checks,error:{message:error.message,code:error.code,stack:error.stack}},null,2));throw error;
}finally{
  if(child&&child.exitCode===null){child.kill();await new Promise(done=>{child.once('exit',done);setTimeout(done,10000).unref();});}
  await bridge.close();
}
