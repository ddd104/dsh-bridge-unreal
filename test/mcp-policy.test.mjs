import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeMcpCall,mcpAccess} from '../src/mcp-policy.mjs';

const dataTable='editor_toolset.toolsets.data_table.DataTableTools';
const slate='SlateInspectorToolset.SlateInspectorToolset';
const programmatic='editor_toolset.toolsets.programmatic.ProgrammaticToolset';
const callTool=(toolset,tool,args={})=>({name:'call_tool',arguments:{toolset_name:toolset,tool_name:tool,arguments:args}});
const denied=(call,reason,options)=>assert.throws(()=>assertSafeMcpCall(call,options),error=>error.code==='MCP_POLICY_BLOCKED'&&error.details.reason===reason&&error.details.retryable===false);

test('all previously restricted UE tools are exposed through direct and toolset dispatch by default',()=>{
  for(const [toolset,leaves] of [
    [dataTable,['set_rows','add_rows','rename_rows','remove_rows','import_file']],
    [slate,['Click','DoubleClick','PressKey','Type','Hover','Drag','SelectOption','FillForm','Scroll','Windows']],
    [programmatic,['get_execution_environment','execute_tool_script']],
    ['editor_toolset.toolsets.asset.AssetTools',['write_file']],
  ])for(const tool of leaves){
    assertSafeMcpCall(callTool(toolset,tool));
    assertSafeMcpCall(callTool(toolset,`${toolset}.${tool}`));
    assertSafeMcpCall({name:`${toolset}.${tool}`,arguments:{}});
  }
  for(const action of ['list','select','close'])assertSafeMcpCall(callTool(slate,'Windows',{action}));
});

test('explicit desktop restriction is honored while preserving queries and other toolsets',()=>{
  const options={allowDesktopInput:false};
  for(const name of ['Click','DoubleClick','PressKey','Type','Hover','Drag','SelectOption','FillForm','Scroll'])denied(callTool(slate,name),'desktop_input',options);
  for(const name of ['Snapshot','Observe','Unobserve','ListObservers','Screenshot','WaitFor'])assertSafeMcpCall(callTool(slate,name),options);
  for(const args of [{},{action:'list'},{Action:'LIST'}])assertSafeMcpCall(callTool(slate,'Windows',args),options);
  for(const args of [{action:'select'},{Action:'close'},{action:'list',Action:'close'},{action:null}])denied(callTool(slate,'Windows',args),'desktop_input',options);
  assertSafeMcpCall(callTool(dataTable,'set_rows'),options);
  assertSafeMcpCall(callTool(programmatic,'execute_tool_script'),options);
  denied(callTool(slate,'Click',{allowDesktopInput:true}),'desktop_input',options);
});

test('ambiguous dispatcher fields and excessive nesting are still rejected',()=>{
  for(const args of [{},{toolset_name:dataTable},{toolset_name:'Safe',toolsetName:dataTable,tool_name:'set_rows'},{toolset_name:'Safe',tool_name:'get_rows',toolName:'execute_tool_script'}])denied({name:'call_tool',arguments:args},'invalid_tool_dispatch');
  let nested=callTool(dataTable,'get_rows');
  for(let i=0;i<9;i++)nested={name:'unreal_mcp_call',arguments:nested};
  denied(nested,'invalid_tool_dispatch');
});

test('wrapper aliases preserve explicit host restrictions without scanning arbitrary argument text',()=>{
  denied({name:'unreal_mcp_call_toolset',arguments:{toolsetName:slate,toolName:'Click'}},'desktop_input',{allowDesktopInput:false});
  denied({name:'unreal_mcp_call',arguments:callTool(slate,'Click')},'desktop_input',{allowDesktopInput:false});
  const call=callTool('editor_toolset.toolsets.blueprint.BlueprintTools','create_node',{name:'SlateInspectorToolset.Click',script:'execute_tool_script'});
  const before=structuredClone(call);assertSafeMcpCall(call,{allowDesktopInput:false});assert.deepEqual(call,before);
});

test('discovery explains legacy behavior and preferred native routes without hiding functionality',()=>{
  for(const [tool,preferred] of [['set_rows','unreal_data_table_write_rows'],['add_rows','unreal_data_table_add_rows'],['rename_rows','unreal_data_table_rename_rows']]){
    const access=mcpAccess(`${dataTable}.${tool}`);assert.equal(access.available,true);assert.equal(access.preferredTool,preferred);assert.match(access.note,/entire DataTable/);
  }
  assert.match(mcpAccess(`${programmatic}.execute_tool_script`).note,/Inner calls/);
  assert.equal(mcpAccess(`${slate}.Click`).available,true);
  assert.equal(mcpAccess(`${slate}.Click`,{allowDesktopInput:false}).available,false);
  assert.equal(mcpAccess(`${slate}.Snapshot`,{allowDesktopInput:false}).available,true);
});
