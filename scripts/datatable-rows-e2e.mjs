// Real bridge + UE validation in a disposable workspace project; no business assets.
// node scripts/datatable-rows-e2e.mjs <Engine directory> <.test-state/...uproject>
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,realpath,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project]=process.argv.slice(2);
assert.ok(engine&&project,'Supply engine and disposable project');
const root=await realpath(resolve('.test-state')),projectPath=await realpath(resolve(project));
const part=relative(root,projectPath);
assert.ok(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep),'Project must be under workspace .test-state');
const stateDir=join(root,'datatable-crud-e2e');
await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:60000}).start();
const session='rows-e2e',toolsetName='editor_toolset.toolsets.data_table.DataTableTools';
const assetName='DT_Rows_'+randomUUID().replaceAll('-','');
const assetPath='/Game/DSHBridgeTests/'+assetName+'.'+assetName;
const checks=[];
const decode=result=>{
  assert.notEqual(result?.isError,true,JSON.stringify(result));
  const value=result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
  return Object.hasOwn(value,'returnValue')?value.returnValue:value;
};
const call=async(toolName,args)=>decode(await bridge.mcpCallToolset(session,{toolsetName,toolName,arguments:args,requestId:randomUUID()}));
const read=async(names)=>JSON.parse(await call('get_rows',{data_table:{refPath:assetPath},row_names:names}));
const write=args=>bridge.writeDataTableRows(session,{assetPath,...args,requestId:randomUUID()});
const manage=args=>bridge.manageDataTableRows(session,{assetPath,...args,requestId:randomUUID()});
const pass=label=>{checks.push(label);console.log('PASS: '+label);};
let child,processError;
try{
  child=spawn(join(engine,'Binaries/Win64/UnrealEditor-Cmd.exe'),[projectPath,'/Engine/Maps/Entry','-unattended','-NullRHI','-nosplash','-nop4','-nosound','-NoAutoSave','-DSHBridgeDescriptor='+bridge.descriptorPath,'-abslog='+join(stateDir,'editor.log')],{stdio:'ignore',windowsHide:true});
  child.once('error',error=>{processError=error;});
  const deadline=Date.now()+180000;
  while(!bridge.list().length){
    if(processError)throw processError;
    if(child.exitCode!==null)throw new Error('Editor exited '+child.exitCode);
    if(Date.now()>deadline)throw new Error('Editor connection timed out');
    await new Promise(done=>setTimeout(done,250));
  }
  bridge.bind(session,bridge.list()[0].editorId);
  assert.ok(bridge.target(session).capabilities.includes('data_table_write_rows'));
  pass('Updated UE advertises row writing');
  await bridge.mcpDescribe(session,{toolsetName,query:'create',includeSchema:true});
  await call('create',{folder_path:'/Game/DSHBridgeTests',asset_name:assetName,schema:{refPath:'/Script/DSHUnrealBridge.DSHDataTableCopyTestRow'}});
  const rows=[{rowName:'Car',values:{Label:'Sedan',FloatParameters:{Speed:55,Retain:8},ColorTypeMaterialParams:{Blue:{Colors:{Paint:{R:0.1,G:0.2,B:0.3,A:1}}}}}},{rowName:'Bus',values:{Label:'Coach',FloatParameters:{Speed:40}}}];
  const preview=await write({mode:'add',rows});
  assert.equal(preview.addedRows,2);assert.equal(preview.dryRun,true);
  assert.deepEqual(await call('list_rows',{data_table:{refPath:assetPath}}),[]);
  pass('Preview predicts additions without modifying the table');
  const added=await write({mode:'add',rows,dryRun:false});
  assert.equal(added.addedRows,2);assert.equal(added.verified,true);assert.equal(added.saved,false);
  const before=await read(['Car','Bus']);
  await writeFile(join(stateDir,'readback.json'),JSON.stringify({schema:await call('get_schema',{data_table:{refPath:assetPath}}),before},null,2));
  assert.equal(before.Car.label,'Sedan');assert.equal(before.Bus.label,'Coach');
  pass('Different values written per row and read through UE MCP');
  await write({mode:'update',rows:[{rowName:'Car',values:{FloatParameters:{Speed:60}}}],dryRun:false});
  const after=await read(['Car','Bus']);
  // UE's exporter wraps scalar map values; compare its actual read format.
  assert.equal(after.Car.floatParameters.Speed.FloatParameters,60);
  const expected=structuredClone(before);expected.Car.floatParameters.Speed.FloatParameters=60;
  assert.deepEqual(after,expected);
  pass('Partial row update preserves unrelated fields, map entries and other rows');
  await assert.rejects(write({mode:'upsert',rows:[{rowName:'Truck',values:{Label:'New'}},{rowName:'Bus',values:{UnknownField:1}}],dryRun:false}),{code:'PROPERTY_VALUE_INVALID'});
  assert.deepEqual(await read(['Car','Bus']),after);
  assert.deepEqual(await call('list_rows',{data_table:{refPath:assetPath}}),['Car','Bus']);
  pass('Invalid later row rejects the whole batch without partial additions');
  const args={assetPath,mode:'upsert',rows:[{rowName:'Truck',values:{Label:'Truck'}},{rowName:'Bus',values:{Label:'Updated coach'}}],dryRun:false,requestId:randomUUID()};
  const first=await bridge.writeDataTableRows(session,args);
  assert.equal(first.addedRows,1);assert.equal(first.updatedRows,1);
  assert.deepEqual(await bridge.writeDataTableRows(session,args),first);
  const status=await bridge.requestStatus(session,args.requestId);
  assert.equal(status.status,'completed');
  const last=await read(['Truck','Bus']);
  assert.equal(last.Truck.label,'Truck');assert.equal(last.Bus.label,'Updated coach');
  pass('Upsert, request deduplication and completed-request recovery work');
  assert.ok(bridge.target(session).capabilities.includes('data_table_manage_rows'));
  assert.ok(bridge.target(session).capabilities.includes('data_table_patch_containers'));
  await bridge.addDataTableRows(session,{assetPath,rows:[{rowName:'Defaults'}],dryRun:false,requestId:randomUUID()});
  const defaults=await read(['Defaults']);
  assert.equal(defaults.Defaults.label,'');
  pass('Explicit add_rows creates native struct defaults without requiring a dummy field');

  const allNames=await call('list_rows',{data_table:{refPath:assetPath}});
  const originalRows=await read(allNames);
  const copyPreview=await manage({action:'duplicate',copies:[{sourceRow:'Car',newRowName:'CarCopy'}]});
  assert.equal(copyPreview.duplicatedRows,1);
  assert.deepEqual(await call('list_rows',{data_table:{refPath:assetPath}}),allNames);
  await manage({action:'duplicate',copies:[{sourceRow:'Car',newRowName:'CarCopy'}],dryRun:false});
  assert.deepEqual((await read(['CarCopy'])).CarCopy,originalRows.Car);
  pass('Row duplication previews without mutation and deep-copies native contents');

  const renames=[{rowName:'Car',newRowName:'Bus'},{rowName:'Bus',newRowName:'Car'}];
  assert.equal((await manage({action:'rename',renames})).renamedRows,2);
  assert.deepEqual(await read(allNames),originalRows);
  await manage({action:'rename',renames,dryRun:false});
  const swapped=await read(['Car','Bus']);
  assert.deepEqual(swapped.Car,originalRows.Bus);assert.deepEqual(swapped.Bus,originalRows.Car);
  await manage({action:'rename',renames:[{rowName:'Bus',newRowName:'bUS'}],dryRun:false});
  assert.ok((await call('list_rows',{data_table:{refPath:assetPath}})).includes('bUS'));
  pass('Batch rename swaps original row values and preserves case-only display changes');

  await assert.rejects(manage({action:'delete',rows:['CarCopy','Missing'],dryRun:false}),{code:'ROW_NOT_FOUND'});
  assert.deepEqual((await read(['CarCopy'])).CarCopy,originalRows.Car);
  await manage({action:'delete',rows:['CarCopy','Defaults'],dryRun:false});
  assert.deepEqual(await call('list_rows',{data_table:{refPath:assetPath}}),['bUS','Car','Truck']);
  pass('Deletion rejects a missing later row atomically and preserves survivor order');

  const untouched=await read(['Car','Truck']);
  await bridge.patchDataTable(session,{assetPath,rows:['bUS'],operations:[
    {op:'set',path:['RenderTargetColors'],value:{Body:{Samples:[{X:1},{X:2},{X:3}]}}},
    {op:'remove',path:['RenderTargetColors','Body','Samples','1']},
    {op:'remove',path:['FloatParameters','Retain']},
    {op:'set',path:['AnimToPlay'],value:null},
  ],dryRun:false,requestId:randomUUID()});
  const containerRow=(await read(['bUS'])).bUS;
  assert.equal(containerRow.floatParameters.Retain,undefined);
  assert.equal(containerRow.renderTargetColors.Body.Samples.length,2);
  assert.deepEqual(await read(['Car','Truck']),untouched);
  pass('Nested map/array deletion and composite field writes round-trip through real MCP reads');

  const clearPreview=await manage({action:'clear'});
  assert.equal(clearPreview.deletedRows,3);assert.equal(clearPreview.rowCountAfter,0);
  assert.equal((await call('list_rows',{data_table:{refPath:assetPath}})).length,3);
  const clearArgs={assetPath,action:'clear',dryRun:false,requestId:randomUUID()};
  const cleared=await bridge.manageDataTableRows(session,clearArgs);
  assert.equal(cleared.deletedRows,3);
  assert.deepEqual(await bridge.manageDataTableRows(session,clearArgs),cleared);
  assert.deepEqual(await call('list_rows',{data_table:{refPath:assetPath}}),[]);
  assert.equal((await bridge.requestStatus(session,clearArgs.requestId)).status,'completed');
  assert.equal((await manage({action:'clear',dryRun:false})).changedRows,0);
  pass('Clear is explicit, previewable, idempotent, recoverable and a no-op on empty tables');
  await writeFile(join(stateDir,'result.json'),JSON.stringify({status:'passed',checks,assetPath,preview,added},null,2));
}catch(error){
  await writeFile(join(stateDir,'result.json'),JSON.stringify({status:'failed',checks,error:{message:error.message,code:error.code,stack:error.stack}},null,2));
  throw error;
}finally{
  if(child&&child.exitCode===null){child.kill();await new Promise(done=>{child.once('exit',done);setTimeout(done,10000).unref();});}
  await bridge.close();
}
