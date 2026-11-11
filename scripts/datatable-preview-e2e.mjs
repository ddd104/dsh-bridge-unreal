// Read-only verification against a real project. Never commits or saves an asset.
// node scripts/datatable-preview-e2e.mjs <Engine directory> <uproject> <DataTable object path>
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project,assetPath]=process.argv.slice(2);
assert.ok(engine&&project&&/^\/Game\/.+\.[^/]+$/.test(assetPath),'Supply engine, project and full /Game/ DataTable object path');
const stateDir=resolve('.test-state/datatable-preview-live');
await mkdir(stateDir,{recursive:true});
const assetFile=join(dirname(resolve(project)),'Content',assetPath.split('.')[0].slice('/Game/'.length)+'.uasset');
const hash=async()=>createHash('sha256').update(await readFile(assetFile)).digest('hex');
const originalHash=await hash();
const bridge=await new UnrealBridge({port:0,stateDir,allowWrites:false,requestTimeoutMs:60000}).start();
const request=bridge.request.bind(bridge);
bridge.request=(editor,method,params,options)=>{
  assert.ok(method==='mcp_discover'||(method==='data_table_patch'&&params.dryRun===true)||
    (method==='mcp_call_tool'&&params.name==='call_tool'&&params.arguments.toolset_name==='editor_toolset.toolsets.data_table.DataTableTools'&&params.arguments.tool_name==='get_rows'),'Only preview and audited reads may be dispatched');
  return request(editor,method,params,options);
};
let child;
try{
  child=spawn(join(engine,'Binaries/Win64/UnrealEditor-Cmd.exe'),[resolve(project),'/Engine/Maps/Entry','-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound','-NoAutoSave',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`],{stdio:'ignore',windowsHide:true});
  let failure;
  child.once('error',error=>{failure=error;});
  const deadline=Date.now()+180000;
  while(!bridge.list().length){
    if(failure)throw failure;
    if(child.exitCode!==null)throw new Error(`Editor exited ${child.exitCode}`);
    if(Date.now()>deadline)throw new Error('Editor connection timed out');
    await new Promise(done=>setTimeout(done,250));
  }
  bridge.bind('preview-test',bridge.list()[0].editorId);
  assert.ok(bridge.target('preview-test').capabilities.includes('data_table_patch'));
  const read=()=>bridge.mcpCallToolset('preview-test',{toolsetName:'editor_toolset.toolsets.data_table.DataTableTools',toolName:'get_rows',arguments:{data_table:{refPath:assetPath},row_names:['Car','Predestrian']},requestId:randomUUID()});
  const before=await read();
  const result=await bridge.patchDataTable('preview-test',{assetPath,dryRun:true,operations:[{op:'copy',path:['colorTypeMaterialParams','Green'],sourcePath:['ColorTypeMaterialParams','Blue']}],requestId:randomUUID()});
  assert.equal(result.verified,true);assert.equal(result.dryRun,true);assert.equal(result.saved,false);
  assert.equal(result.dirtyAfter,result.dirtyBefore);
  assert.deepEqual(await read(),before,'Read-back after preview must be identical');
  assert.equal(await hash(),originalHash,'On-disk DataTable must be unchanged');
  await writeFile(join(stateDir,'verification.json'),JSON.stringify({status:'passed',result,assetHashUnchanged:true,sampleRowsUnchanged:true},null,2));
  console.log(JSON.stringify({status:'passed',...result,assetHashUnchanged:true,sampleRowsUnchanged:true}));
}finally{
  // This process is an owned, unattended preview instance with autosave disabled.
  if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,10000);});}
  await bridge.close();
}
