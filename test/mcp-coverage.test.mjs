import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertSafeMcpCall} from '../src/mcp-policy.mjs';
import {AUDITED_MCP_READS,isReadOnlyMcpCall} from '../src/mcp-contract.mjs';

const catalog=JSON.parse(await readFile(new URL('./fixtures/ue-mcp-catalog.json',import.meta.url),'utf8'));
test('installing the bridge enables core asset and Slate toolsets for editor targets',async()=>{
  const plugin=JSON.parse(await readFile(new URL('../unreal/DSHUnrealBridge/DSHUnrealBridge.uplugin',import.meta.url),'utf8'));
  for(const name of ['EditorToolset','SlateInspectorToolset']){
    const dependency=plugin.Plugins.find(item=>item.Name===name);
    assert.equal(dependency?.Enabled,true,name);
    assert.deepEqual(dependency.TargetAllowList,['Editor'],`${name} must not become a runtime dependency`);
  }
});
test('every leaf in the live UE 5.8 catalog is exposed through the public dispatch forms',()=>{
  const names=new Set();
  for(const set of catalog.toolsets)for(const tool of set.tools){
    const fullName=`${set.name}.${tool}`;assert.ok(!names.has(fullName));names.add(fullName);
    for(const call of [
      {name:fullName,arguments:{}},
      {name:'call_tool',arguments:{toolset_name:set.name,tool_name:tool,arguments:{}}},
      {name:'call_tool',arguments:{toolset_name:set.name,tool_name:fullName,arguments:{}}},
    ])assert.doesNotThrow(()=>assertSafeMcpCall(call),fullName);
  }
  assert.equal(catalog.toolsets.length,52);assert.equal(names.size,830);
  for(const name of AUDITED_MCP_READS)assert.ok(names.has(name),`Audited read absent from real catalog: ${name}`);
});

test('Blueprint and material CRUD has explicit discoverable routes including shared Object/Asset tools',()=>{
  const expected={
    'editor_toolset.toolsets.blueprint.BlueprintTools':['create','list_graphs','get_graph','create_node','delete_node','get_node_infos','set_node_position','connect_pins','break_pins','set_pin_value','get_pin_value','add_variable','remove_variable','list_variables'],
    'editor_toolset.toolsets.material.MaterialTools':['create_material','create_function','add_expression','delete_expression','get_expressions','connect_expressions','disconnect_expressions','connect_to_output','disconnect_from_output','recompile'],
    'editor_toolset.toolsets.object.ObjectTools':['get_properties','set_properties','reset_properties'],
    'editor_toolset.toolsets.asset.AssetTools':['find_assets','duplicate','move','delete','save_assets'],
    'editor_toolset.toolsets.material_instance.MaterialInstanceTools':['create','set_parent','list_parameters','set_parameter_override','clear_parameters'],
  };
  for(const [name,tools] of Object.entries(expected)){
    const found=catalog.toolsets.find(s=>s.name===name);assert.ok(found);
    for(const tool of tools)assert.ok(found.tools.includes(tool),`${name}.${tool}`);
  }
});

test('queries that temporarily spawn nodes and all explicit mutations still require write admission',()=>{
  for(const tool of ['find_node_types','find_node_categories','get_node_type_pins','read_graph_dsl','write_graph_dsl','create_node','delete_node','set_pin_value'])assert.equal(isReadOnlyMcpCall({name:`editor_toolset.toolsets.blueprint.BlueprintTools.${tool}`}),false,tool);
  assert.equal(isReadOnlyMcpCall({name:'editor_toolset.toolsets.programmatic.ProgrammaticToolset.execute_tool_script'}),false);
  for(const tool of ['get_graph','get_parent','get_pin_value','list_variables','list_functions','list_events','get_connected_subgraph'])assert.equal(isReadOnlyMcpCall({name:`editor_toolset.toolsets.blueprint.BlueprintTools.${tool}`}),true,tool);
});
