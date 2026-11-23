import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';

// Called only by mcp-coverage-e2e after its disposable-project and PID checks.
export async function verifyMcpCrud(bridge,session,report,checkpoint){
  const prefix='editor_toolset.toolsets.';
  const sets={bp:prefix+'blueprint.BlueprintTools',mat:prefix+'material.MaterialTools',mi:prefix+'material_instance.MaterialInstanceTools',obj:prefix+'object.ObjectTools',asset:prefix+'asset.AssetTools',dt:prefix+'data_table.DataTableTools',script:prefix+'programmatic.ProgrammaticToolset',slate:'SlateInspectorToolset.SlateInspectorToolset'};
  const checks=report.checks=[],calls=report.calls=[];
  const decode=result=>{const value=result.structuredContent??JSON.parse(result.content.find(b=>b.type==='text').text);return Object.hasOwn(value,'returnValue')?value.returnValue:value;};
  const call=async(set,tool,args={})=>{
    const entry={toolsetName:sets[set],toolName:tool,arguments:args,requestId:randomUUID()};calls.push(entry);await checkpoint();
    const result=decode(await bridge.mcpCallToolset(session,entry));entry.result=result;await checkpoint();return result;
  };
  const pass=label=>{checks.push(label);console.log(`PASS: ${label}`);};
  const folder=report.testAssetFolder=`/Game/DSHBridgeTests/McpCoverage_${randomUUID().replaceAll('-','')}`;
  const prop=async(instance,properties)=>JSON.parse(await call('obj','get_properties',{instance,properties}));
  const setProps=async(instance,values)=>assert.equal(await call('obj','set_properties',{instance,values:JSON.stringify(values)}),true);

  const bp=await call('bp','create',{folder_path:folder,asset_name:'BP_Crud',asset_type:{refPath:'/Script/Engine.Actor'}});
  assert.ok(bp.refPath.endsWith('/BP_Crud.BP_Crud'));
  const graph=await call('bp','get_graph',{blueprint:bp,graph_name:'EventGraph'});
  assert.ok((await call('bp','list_graphs',{blueprint:bp})).some(g=>g.refPath===graph.refPath));
  await call('bp','add_variable',{blueprint:bp,name:'CoverageValue',type_name:'float'});
  assert.ok((await call('bp','list_variables',{blueprint:bp})).includes('CoverageValue'));
  await call('bp','set_variable_category',{blueprint:bp,variable_name:'CoverageValue',category:'Coverage'});
  assert.equal(await call('bp','get_variable_category',{blueprint:bp,variable_name:'CoverageValue'}),'Coverage');
  await call('bp','compile_blueprint',{blueprint:bp});
  await setProps(bp,{CoverageValue:3.25});
  assert.equal((await prop(bp,['CoverageValue'])).CoverageValue,3.25);
  pass('Blueprint asset create/read/update and variable add/read/update');

  const types=await call('bp','find_node_types',{graph,type_id_filter:'PrintString',context_pins:[]});
  const type=types.find(t=>t.split('|').at(-1)==='PrintString');assert.ok(type,JSON.stringify(types));
  const node=await call('bp','create_node',{graph,type_id:type,pos:{x:100,y:100}});
  const nodeInfo=(await call('bp','get_node_infos',{nodes:[node]}))[0];
  const pin=nodeInfo.input_pins.find(p=>p.name==='InString')?.pin_id;assert.ok(pin,JSON.stringify(nodeInfo));
  await call('bp','set_pin_value',{pin,value:'MCP CRUD verified'});
  assert.equal(await call('bp','get_pin_value',{pin}),'MCP CRUD verified');
  await call('bp','set_node_position',{node,pos:{x:720,y:360}});
  const pos=(await call('bp','get_node_infos',{nodes:[node]}))[0].position;assert.equal(pos.x,720);assert.equal(pos.y,360);
  const next=await call('bp','create_node',{graph,type_id:type,pos:{x:1100,y:360}});
  const nextInfo=(await call('bp','get_node_infos',{nodes:[next]}))[0];
  const output=nodeInfo.output_pins.find(p=>p.name==='then')?.pin_id,input=nextInfo.input_pins.find(p=>p.name==='execute')?.pin_id;assert.ok(output&&input);
  await call('bp','connect_pins',{output_pin:output,input_pin:input});
  assert.equal((await call('bp','get_connected_subgraph',{node})).length,2);
  await call('bp','break_pins',{output_pin:output,input_pin:input});
  assert.equal((await call('bp','get_connected_subgraph',{node})).length,1);
  await call('bp','delete_node',{node:next});await call('bp','delete_node',{node});
  assert.ok(!(await call('bp','find_nodes',{graph,title:'Print String'})).some(n=>n.refPath===node.refPath));
  const fn=await call('bp','add_function_graph',{blueprint:bp,graph_name:'CoverageFunction'});
  await call('bp','add_function_param',{graph:fn,param_name:'Amount',param_type:'float',input_param:true});
  await call('bp','remove_function_param',{graph:fn,param_name:'Amount',input_param:true});
  await call('bp','remove_function_graph',{blueprint:bp,graph_name:'CoverageFunction'});
  assert.ok(!(await call('bp','list_graphs',{blueprint:bp})).some(g=>g.refPath===fn.refPath));
  await call('bp','remove_variable',{blueprint:bp,name:'CoverageValue'});
  assert.ok(!(await call('bp','list_variables',{blueprint:bp})).includes('CoverageValue'));
  await call('bp','compile_blueprint',{blueprint:bp});
  pass('Blueprint nodes CRUD, pin defaults, connect/disconnect, function graph and parameter lifecycle');

  const mat=await call('mat','create_material',{folder_path:folder,asset_name:'M_Crud'});
  await setProps(mat,{TwoSided:true});assert.equal((await prop(mat,['TwoSided'])).TwoSided,true);
  const expression=await call('mat','add_expression',{material_or_function:mat,expression_class:{refPath:'/Script/Engine.MaterialExpressionScalarParameter'},x:-400,y:0});
  await setProps(expression,{ParameterName:'Coverage',DefaultValue:0.25,Group:'Before'});
  assert.equal((await prop(expression,['DefaultValue'])).DefaultValue,0.25);
  const multiply=await call('mat','add_expression',{material_or_function:mat,expression_class:{refPath:'/Script/Engine.MaterialExpressionMultiply'}});
  assert.ok((await call('mat','get_expression_input_names',{expression:multiply})).includes('A'));
  await call('mat','connect_expressions',{from_expression:expression,from_output_name:'',to_expression:multiply,to_input_name:'A'});
  assert.ok((await call('mat','get_expression_inputs',{material_or_function:mat,expression:multiply})).some(p=>p.expression?.refPath===expression.refPath));
  await call('mat','connect_to_output',{expression:multiply,output_name:'',material_property:'MP_Roughness'});
  assert.equal((await call('mat','get_property_input',{material:mat,material_property:'MP_Roughness'})).expression.refPath,multiply.refPath);
  await call('mat','rename_parameter_group',{material_or_function:mat,old_name:'Before',new_name:'After'});
  assert.ok((await call('mat','list_parameter_groups',{material_or_function:mat})).includes('After'));
  await call('mat','delete_parameter_group',{material_or_function:mat,group_name:'After'});
  await call('mat','layout_expressions',{material_or_function:mat});
  await call('mat','recompile',{material_or_function:mat});
  pass('Material asset/node create/read/update, connections, outputs, parameter groups and compilation');

  const mi=await call('mi','create',{folder_path:folder,asset_name:'MI_Crud',parent:mat});
  await call('mi','set_scalar_parameter',{instance:mi,name:'Coverage',value:0.75});
  assert.equal(await call('mi','get_scalar_parameter',{instance:mi,name:'Coverage'}),0.75);
  await call('mi','clear_parameters',{instance:mi});
  assert.equal(await call('mi','get_scalar_parameter',{instance:mi,name:'Coverage'}),0.25);
  pass('Material instance create/read/update/reset');

  await call('mat','disconnect_expressions',{to_expression:multiply,to_input_name:'A'});
  await call('mat','disconnect_from_output',{material:mat,material_property:'MP_Roughness'});
  await call('mat','delete_expression',{material_or_function:mat,expression:multiply});
  await call('mat','delete_expression',{material_or_function:mat,expression});
  assert.equal((await call('mat','get_expressions',{material_or_function:mat})).length,0);
  pass('Material node disconnect and delete with empty-graph readback');

  const fnMat=await call('mat','create_function',{folder_path:folder,asset_name:'MF_Crud'});
  const fnNode=await call('mat','add_expression',{material_or_function:fnMat,expression_class:{refPath:'/Script/Engine.MaterialExpressionFunctionInput'}});
  await setProps(fnNode,{InputName:'CoverageInput'});
  assert.equal((await prop(fnNode,['InputName'])).InputName,'CoverageInput');
  await call('mat','delete_expression',{material_or_function:fnMat,expression:fnNode});
  assert.ok(!(await call('mat','get_expressions',{material_or_function:fnMat})).some(n=>n.refPath===fnNode.refPath));
  pass('Material function nodes create/read/update/delete');

  bridge.config.allowWrites=false;
  try{
    await call('bp','get_parent',{blueprint:bp});await call('bp','list_variables',{blueprint:bp});
    await call('bp','list_functions',{blueprint:bp});await call('bp','list_events',{blueprint:bp});
    await call('mat','get_expressions',{material_or_function:mat});await prop(mat,['TwoSided']);
    await call('mi','list_parameters',{material:mi});
    await call('script','get_execution_environment');
    await assert.rejects(call('script','execute_tool_script',{script:'def run():\n    return {}\n'}),{code:'READ_ONLY'});
  }finally{bridge.config.allowWrites=true;}
  pass('Blueprint/material queries remain usable in read-only mode; scripts still require write admission');

  const env=await call('script','get_execution_environment');assert.ok(env.instructions);
  const scriptResult=await call('script','execute_tool_script',{script:'def run():\n    return {"answer": 42}\n'});
  assert.equal((typeof scriptResult==='string'?JSON.parse(scriptResult):scriptResult).answer,42);
  const file=join(dirname(report.projectPath),'Saved',`McpCoverage_${randomUUID()}.py`);
  await call('asset','write_file',{file_path:file,content:'# MCP coverage fixture; not executed\n'});
  assert.match(await call('asset','read_file',{file_path:file}),/MCP coverage fixture/);
  await unlink(file);
  pass('Programmatic environment/execution and script-file write/read are exposed');

  const dt=await call('dt','create',{folder_path:folder,asset_name:'DT_Crud',schema:{refPath:'/Script/DSHUnrealBridge.DSHDataTableCopyTestRow'}});
  await call('dt','add_rows',{data_table:dt,row_names:['Before']});
  await call('dt','set_rows',{data_table:dt,values:JSON.stringify({Before:{label:'Coverage'}})});
  await call('dt','rename_rows',{data_table:dt,renames:{Before:'After'}});
  const rows=JSON.parse(await call('dt','get_rows',{data_table:dt,row_names:['After']}));
  assert.equal(rows.After.label,'Coverage');
  assert.equal(await call('asset','delete',{path:dt.refPath.split('.')[0]}),true);
  await call('slate','Windows',{action:'list'});
  pass('Legacy DataTable add/update/rename/read and Slate window enumeration reach the editor');

  for(const asset of [mi,fnMat,mat,bp]){
    const path=asset.refPath.split('.')[0];
    const copy=`${path}_Copy`,moved=`${path}_Moved`;
    await call('asset','save_assets',{asset_paths:[path]});
    assert.equal(await call('asset','duplicate',{path,new_path:copy}),true);
    assert.equal(await call('asset','move',{path:copy,new_path:moved}),true);
    assert.equal(await call('asset','exists',{path:moved}),true);
    assert.equal(await call('asset','delete',{path:moved}),true);
    assert.equal(await call('asset','delete',{path}),true);
    assert.equal(await call('asset','exists',{path}),false);
  }
  pass('Blueprint/material/function/instance assets save, duplicate, rename, query and delete');
}
