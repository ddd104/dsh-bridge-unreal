# UE MCP 全量开放审计

本文迁入自原仓库提交 `c95de19f3fba2fbb9845981734870572a12504c4`。下述真实 UE 编译、运行及项目同步结果均为原仓库记录，不代表本次迁移重新执行；本仓库 2026-11-23 的实际检查结果见[迁移验证](validation.md)。本仓库提供 UE 源码，未附带预编译 DLL。

审计日期：2026-11-18。基线：修改前的 bridge；引擎：本机 UE 5.8.4-0+UE5，临时 HostProject 启用 AllToolsets。数量来自编辑器实时注册表，不是从函数名或文档估算。

## 结论

实时发现 **3 个顶层调度工具、52 个工具集、830 个叶子工具**。bridge 原本已有动态通用调用，不需要为每个 UE 工具重复写接口。蓝图 53 项、材质 22 项、材质实例 13 项，以及 ObjectTools 6 项和 AssetTools 21 项原本大多可调用。此次消除了默认功能禁用规则，修正了查询的只读分类，并给工具描述增加可用性、只读属性和旧实现的替代建议。

修改后 830 个叶子工具均通过默认开放策略检查；所有工具集均能实际 describe。**这不表示已执行 830 个工具的全部业务分支**：执行测试集中覆盖蓝图/材质 CRUD 和本次解禁入口，其他领域以真实目录、参数结构与开放策略核验为证据。工具依赖的 UE 插件、资产类型和运行状态仍由 UE 决定。

## 修改前未开放的功能

| 工具集 | 功能 | 修改前原因 | 修改后 |
| --- | --- | --- | --- |
| `editor_toolset.toolsets.data_table.DataTableTools` | `add_rows` | lossy_json_roundtrip | 默认开放 |
| `editor_toolset.toolsets.data_table.DataTableTools` | `rename_rows` | lossy_json_roundtrip | 默认开放 |
| `editor_toolset.toolsets.data_table.DataTableTools` | `set_rows` | lossy_json_roundtrip | 默认开放 |
| `editor_toolset.toolsets.programmatic.ProgrammaticToolset` | `execute_tool_script` | script_execution | 默认开放 |
| `editor_toolset.toolsets.programmatic.ProgrammaticToolset` | `get_execution_environment` | script_execution | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `Click` | desktop_input | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `Drag` | desktop_input | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `FillForm` | desktop_input | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `Hover` | desktop_input | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `PressKey` | desktop_input | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `SelectOption` | desktop_input | 默认开放 |
| `SlateInspectorToolset.SlateInspectorToolset` | `Type` | desktop_input | 默认开放 |
| SlateInspectorToolset.SlateInspectorToolset | Windows(select/close) | 默认只允许 list | 默认开放 |
| editor_toolset.toolsets.asset.AssetTools | write_file(.py/.js/.ps1) | UE 适配模块按扩展名拒绝 | 开放，沿用 UE 自身路径约束 |

总计 **12 个完全被禁用的方法，加 2 个部分操作受限的方法**。ProgrammaticToolset 的整组拦截还阻止了该工具集的 describe 和环境说明查询；本次同时解除。

配置 `allowMcpDesktopInput` 默认值改为 true。已有用户显式设置 false 时仍保留其直接 Slate 输入限制；启用状态会在工具描述 `bridge.available/condition` 中体现。没有修改用户的宿主配置文件。

旧 DataTable 的 add_rows/set_rows/rename_rows 按 UE 原始行为开放；它们通过 JSON 重建整表，不能承诺不损失无关字段。工具描述返回 preferredTool，分别指向原生增行、写行、改名接口。原生保真接口继续保留，未改写旧工具的参数与返回值。

## 蓝图、蓝图节点、材质、材质节点 CRUD 路由

以下均通过 `unreal_mcp_describe` 获取实时 schema，再使用 `unreal_mcp_call_toolset`。表内工具集使用短称；完整名称见后面的全量目录。

| 对象 | 增 | 查 | 改 | 删 |
| --- | --- | --- | --- | --- |
| 蓝图资产 | BlueprintTools.create；AssetTools.duplicate | AssetTools.find_assets/load_asset；BlueprintTools.list_graphs/get_parent/get_default_object；ObjectTools.get_properties | ObjectTools.set_properties/reset_properties；BlueprintTools.set_parent/compile_blueprint；AssetTools.move/save_assets | AssetTools.delete |
| 蓝图节点 | create_node/add_event/add_component_bound_event | find_nodes/get_node_infos/get_connected_subgraph；get_pin_value | set_node_position/arrange_nodes/retarget_node_class；set_pin_value；connect_pins/break_pins；add_node_pin/remove_node_pin | delete_node |
| 蓝图函数、变量 | add_function_graph/add_function_param/add_struct_function_param/add_object_function_param；add_variable/add_struct_variable/add_object_variable | list_functions/list_events/list_variables；get_variable_category/get_variable_replication | set_variable_category/set_variable_replication/set_variable_instance_editable；ObjectTools 修改默认值 | remove_function_graph/remove_function_param/remove_variable |
| 材质资产/函数 | MaterialTools.create_material/create_function/create_parameter_collection；AssetTools.duplicate | ObjectTools.get_properties/list_properties；MaterialTools.get_expressions/get_referencing_materials | ObjectTools.set_properties/reset_properties；MaterialTools.recompile；AssetTools.move/save_assets | AssetTools.delete |
| 材质节点 | add_expression | get_expressions/get_expression_input_names/get_expression_output_names/get_expression_inputs；ObjectTools.get_properties | ObjectTools.set_properties/reset_properties；connect_expressions/disconnect_expressions；connect_to_output/disconnect_from_output；layout_expressions | delete_expression/delete_unused_expressions |
| 材质参数组 | 对参数节点设置 Group | list_parameter_groups | rename_parameter_group；ObjectTools 设置节点属性 | delete_parameter_group（清除分组，不删除节点） |
| 材质实例 | MaterialInstanceTools.create | list_parameters；get_scalar/vector/texture/static_switch_parameter | set_parent；set_scalar/vector/texture/static_switch_parameter；set_parameter_override | clear_parameters 清除覆盖；AssetTools.delete 删除资产 |

`ObjectTools` 是蓝图默认对象、材质属性和材质节点属性的共享入口，不能只查看 BlueprintTools/MaterialTools 就判断缺少“改”。同样，资产级删除、复制、改名和保存由 AssetTools 提供。节点坐标/引脚应使用 BlueprintTools 的专用查询和修改方法；ObjectTools 只能读取 UE 反射接口允许访问的属性。

## 只读查询补齐

此前部分查询只有在 allowWrites=true 时可用。本次新增 21 项精确审计的只读方法，宿主与 UE 侧保持同一名单：

- BlueprintTools：get_graph、list_functions、list_events、get_connected_subgraph、get_create_event_function、get_pin_value、get_parent、list_variables、get_variable_replication、get_variable_category、list_event_dispatchers、get_graph_dsl_docs、list_component_events、list_compatible_event_functions（14 项）。
- MaterialInstanceTools：list_parameters、get_scalar_parameter、get_vector_parameter、get_texture_parameter、get_static_switch_parameter（5 项）。
- ObjectTools.search_subclasses、ProgrammaticToolset.get_execution_environment（2 项）。

当前精确只读名单共 40 项。find_node_types/find_node_categories/get_node_type_pins/read_graph_dsl 会临时创建/删除节点，仍按写操作处理；执行脚本也按写操作处理。未审计的方法不凭 get/list 前缀或第三方 annotations 认定只读。

## 调用与保证

所有叶子工具继续经过当前 schema 校验、原生目标类型/归属校验、写权限、写入互斥、requestId 去重和错误传播。Blueprint/Object 的操作上下文凭据与修复保护保持有效。开放功能不代表工具可以传入错误对象、绕过只读模式，或获得原生补丁的统一事务和回滚保证。

ProgrammaticToolset 使用 UE 提供的执行环境；调用前先查询 get_execution_environment。一次脚本内的各工具调用不分别经过 bridge 的目标预检、修复计数和预览流程，不能把单个外层请求的保护描述为内部所有操作的原子保证。

`unreal_mcp_call` 用于顶层工具；`unreal_mcp_call_toolset` 使用完整 toolsetName 和函数短名。describe 的原始 inputSchema 保持不变，新增 `bridge.available/readOnly/note/preferredTool/condition` 说明字段；includeSchema=false 的紧凑描述同样保留 bridge 信息。

## UE 本身的边界

- 注册表没有独立的“BlueprintTools.delete 蓝图资产”或“MaterialTools.set_expression_properties”；相关能力由共享工具集实现，并非 bridge 遗漏。
- UE 没有注册的叶子操作不会被虚构出来。不同工程的插件启用状态可能改变工具集数量，运行时发现始终以绑定编辑器为准。
- 蓝图事件分发器有 add/list 及参数编辑接口，但当前 BlueprintTools 没有专门的 remove_event_dispatcher 方法；不能把未注册方法宣传为已开放。
- 原生蓝图补丁、原生材质批次与通用 MCP 是不同保证范围。关卡蓝图继续先用 unreal_level_blueprint 获得精确引用，原生普通蓝图补丁不会因此扩展为支持关卡子对象。

## 原仓库验证记录

- UE 5.8.4 C++ 插件实际编译成功。
- 实时 registry → describe：52 个工具集、830 个叶子工具；机器可读清单见 [ue-mcp-catalog.json](../test/fixtures/ue-mcp-catalog.json)。
- 真实临时工程通过公共 bridge 路由验证蓝图资产/节点/引脚/连线/变量/函数图，材质资产/节点/连接/输出/参数组，材质函数节点和材质实例，以及保存、复制、改名、删除与结果回读。
- UE 脚本环境查询与简单执行、AssetTools 脚本文件读写、旧 DataTable 增行/写行/改名/回读和 Slate 窗口枚举已实际通过。完整 CRUD 验证记录 115 次调用、10 个检查点；常规业务工程未被用于编辑测试。
- 重现命令：`node scripts/mcp-coverage-e2e.mjs <engine-root> <workspace/.test-state/.../HostProject.uproject> <workspace/.test-state/report> --crud`。脚本验证临时项目边界和连接 PID；报告记录每次调用参数、结果和检查点。
- `npm run check`：397 项宿主测试全部通过。UE 原生 MCP 目标校验、操作归属和写入协调：10 项测试全部通过。精确只读名单的宿主/UE 一致性、全目录开放策略、参数错误、重复请求和只读写入拒绝均有回归覆盖。

发布版本为 DSH 0.6.5 / UE 0.5.5。宿主产物位于仓库 `lib/`；UE DLL 需在目标 UE 5.8 工程中编译，不随本仓库源码或 DSH 安装包迁入。插件显式声明 EditorToolset 和 SlateInspectorToolset 的 Editor 目标依赖，解决未启用 AllToolsets 的项目安装 bridge 后仍缺少核心蓝图、材质工具的问题；不增加 Android Runtime 模块依赖。

### 原仓库的本机安装与项目同步验证

DSH desktop 已安装 0.6.5，安装后的运行时检查 9 项通过，保留原宿主配置；完全退出 DSH（含托盘）后重新启动才会加载新宿主。三个项目均已同步 UE 插件 0.5.5，替换文件前保留备份，并核对源文件及配套运行时；原有项目知识配置和缓存保留。

| 项目 | 同步与验证结果 |
| --- | --- |
| D7M8（CN_D7M8） | 实际工程启动成功，8 项只读检查通过；53 项蓝图、22 项材质、13 项材质实例工具均已开放。补齐核心工具集依赖后复验通过。 |
| EHV | 插件同步完成；启动检查被既有 `Script/Camera/ASCameraPawn.as` 编译错误阻断：`FCameraOperationData` 缺少 `BeforeArmLength` 等成员，`UHMICameraComponent` 缺少 `NowCenterProjectionOffset`。未修改业务脚本，不能宣称该项目运行验证通过。 |
| qirui_v25 | 经用户确认，关联从已失效的 UEAS58 改为当前 UEAS（UE 5.8.4）。Editor Target 全量重编成功，实际启动与 8 项只读检查通过；补齐依赖后的增量编译也通过。 |

业务工程检查使用 Entry 地图、关闭资产写入，不保存业务资产。qirui_v25 的知识服务可调用，但 `project_status` 返回索引缺失、`needsUpdate=true`；此次未重建全量图谱，也未声称完成图谱影响分析。Windows 编辑器已按上述范围验证；Android 打包与真机未验证，尤其 qirui_v25 的引擎关联更新也会影响后续 Android 构建所用版本。

## 全量目录

以下列出审计时每个工具集的全部叶子方法，均默认开放。某些工具的有效执行仍取决于已启用的插件、合法目标和 UE 自身前置条件。

| 工具集 | 数量 |
| --- | ---: |
| `aimodule_toolset.toolsets.behavior_tree.BehaviorTreeTools` | 7 |
| `animation_toolset.toolsets.conditions.SequencerConditionTools` | 9 |
| `animation_toolset.toolsets.controlrig_sequencer.SequencerControlRigTools` | 72 |
| `animation_toolset.toolsets.controlrig.ControlRigTools` | 44 |
| `animation_toolset.toolsets.custom_bindings.SequencerCustomBindingTools` | 8 |
| `animation_toolset.toolsets.import_export.SequencerImportExportTools` | 6 |
| `animation_toolset.toolsets.keyframing.SequencerKeyframingTools` | 22 |
| `animation_toolset.toolsets.outliner.SequencerOutlinerTools` | 18 |
| `animation_toolset.toolsets.sequencer.SequencerTools` | 140 |
| `AutomationTestToolset.AutomationTestToolset` | 7 |
| `ConfigSettingsToolset.ConfigSettingsToolset` | 8 |
| `conversation_toolset.toolsets.conversation.ConversationTools` | 7 |
| `DataflowAgent.DataflowAgentToolset` | 22 |
| `DataRegistryToolset.DataRegistryTools` | 7 |
| `editor_toolset.toolsets.actor.ActorTools` | 17 |
| `editor_toolset.toolsets.asset.AssetTools` | 21 |
| `editor_toolset.toolsets.blueprint.BlueprintTools` | 53 |
| `editor_toolset.toolsets.curve_table.CurveTableTools` | 9 |
| `editor_toolset.toolsets.data_asset.DataAssetTools` | 1 |
| `editor_toolset.toolsets.data_table.DataTableTools` | 10 |
| `editor_toolset.toolsets.material_instance.MaterialInstanceTools` | 13 |
| `editor_toolset.toolsets.material.MaterialTools` | 22 |
| `editor_toolset.toolsets.object.ObjectTools` | 6 |
| `editor_toolset.toolsets.primitive.PrimitiveTools` | 4 |
| `editor_toolset.toolsets.programmatic.ProgrammaticToolset` | 2 |
| `editor_toolset.toolsets.scene.SceneTools` | 20 |
| `editor_toolset.toolsets.skeletal_mesh.SkeletalMeshTools` | 22 |
| `editor_toolset.toolsets.static_mesh.StaticMeshTools` | 16 |
| `editor_toolset.toolsets.string_table.StringTableTools` | 8 |
| `editor_toolset.toolsets.texture.TextureTools` | 2 |
| `EditorToolset.EditorAppToolset` | 21 |
| `EditorToolset.LogsToolset` | 4 |
| `GameFeaturesToolset.GameFeaturesToolset` | 7 |
| `GameplayTagsToolset.GameplayTagsToolset` | 6 |
| `GASToolsets.AbilitySystemInspectorToolset` | 4 |
| `GASToolsets.AttributeSetToolset` | 2 |
| `GASToolsets.GameplayCueToolset` | 8 |
| `NiagaraToolsets.NiagaraToolset_Assets` | 3 |
| `NiagaraToolsets.NiagaraToolset_Blueprint` | 2 |
| `NiagaraToolsets.NiagaraToolset_Component` | 4 |
| `NiagaraToolsets.NiagaraToolset_Info` | 1 |
| `NiagaraToolsets.NiagaraToolset_System` | 46 |
| `PCGToolset.PCGSpatialToolset` | 1 |
| `PCGToolset.PCGToolset` | 30 |
| `PhysicsToolsets.PhysicsAssetToolset` | 17 |
| `PluginToolset.PluginToolset` | 17 |
| `SemanticSearchToolset.SemanticSearchToolset` | 2 |
| `SlateInspectorToolset.SlateInspectorToolset` | 14 |
| `state_tree_toolset.toolsets.state_tree.StateTreeTools` | 9 |
| `ToolsetRegistry.AgentSkillToolset` | 4 |
| `UMGToolSet.UMGToolSet` | 23 |
| `WorldConditionsToolset.WorldConditionTools` | 2 |

<details>
<summary>aimodule_toolset.toolsets.behavior_tree.BehaviorTreeTools（7）</summary>

`get_blackboard`、`get_children`、`get_node_depth`、`get_node_depths`、`get_root_decorators`、`get_subtree`、`list_nodes`

</details>

<details>
<summary>animation_toolset.toolsets.conditions.SequencerConditionTools（9）</summary>

`clear_section_condition`、`clear_track_condition`、`clear_track_row_condition`、`get_section_condition`、`get_track_condition`、`get_track_row_condition`、`set_section_condition`、`set_track_condition`、`set_track_row_condition`

</details>

<details>
<summary>animation_toolset.toolsets.controlrig_sequencer.SequencerControlRigTools（72）</summary>

`add_layer_from_selection`、`bake_space`、`bake_to_control_rig`、`blend_values_on_selected`、`clear_selection`、`collapse_anim_layers`、`delete_anim_layer`、`delete_space`、`duplicate_anim_layer`、`export_fbx_from_rig`、`find_or_create_track`、`frame_selection`、`get_actor_transform_at_frame`、`get_anim_layers`、`get_anim_mode_gizmo_scale`、`get_anim_mode_hide_manips`、`get_anim_mode_hierarchy`、`get_anim_mode_local_spaces`、`get_anim_mode_nulls`、`get_anim_mode_only_rig_sel`、`get_bool`、`get_control_rigs`、`get_controls_info`、`get_controls_mask`、`get_euler_transform`、`get_float`、`get_int`、`get_position`、`get_priority_order`、`get_rotator`、`get_scale`、`get_selected_controls`、`get_transform`、`get_vector2d`、`get_world_transform`、`hide_all_controls`、`import_fbx_to_rig`、`is_fk_control_rig`、`is_layered_control_rig`、`key_controls`、`key_controls_at_frames`、`load_anim_into_rig`、`merge_anim_layers`、`mirror_selected_controls`、`move_space`、`reorder_anim_layers`、`select_control`、`select_mirrored_controls`、`set_anim_mode_gizmo_scale`、`set_anim_mode_hide_manips`、`set_anim_mode_hierarchy`、`set_anim_mode_local_spaces`、`set_anim_mode_nulls`、`set_anim_mode_only_rig_sel`、`set_bool`、`set_controls_mask`、`set_euler_transform`、`set_float`、`set_int`、`set_layered_mode`、`set_position`、`set_priority_order`、`set_rotator`、`set_scale`、`set_space`、`set_transform`、`set_vector2d`、`set_world_transform`、`show_all_controls`、`snap_control_rig`、`tween_control_rig`、`zero_transforms`

</details>

<details>
<summary>animation_toolset.toolsets.controlrig.ControlRigTools（44）</summary>

`add_backward_solve_graph`、`add_bone`、`add_control`、`add_element`、`add_event_graph`、`add_event_node`、`add_graph`、`add_interaction_graph`、`add_null`、`add_variable`、`add_variable_node`、`change_variable_type`、`connect_pins`、`create`、`create_node`、`delete_node`、`disconnect_pins`、`get_all_bones`、`get_all_controls`、`get_all_nulls`、`get_backward_solve_graph`、`get_children`、`get_connected_pins`、`get_elements`、`get_event_graph`、`get_forward_solve_graph`、`get_global_transform`、`get_graph`、`get_interaction_graph`、`get_local_transform`、`get_node_position`、`get_parent`、`get_pin_value`、`get_variable`、`import_bones_from_asset`、`list_graphs`、`list_nodes`、`list_pins`、`list_variables`、`remove_variable`、`set_global_transform`、`set_local_transform`、`set_node_position`、`set_pin_value`

</details>

<details>
<summary>animation_toolset.toolsets.custom_bindings.SequencerCustomBindingTools（8）</summary>

`change_actor_template_class`、`convert_to_custom_binding`、`convert_to_possessable`、`convert_to_spawnable`、`get_custom_binding_objects`、`get_custom_binding_type`、`get_custom_bindings_of_type`、`save_default_spawnable_state`

</details>

<details>
<summary>animation_toolset.toolsets.import_export.SequencerImportExportTools（6）</summary>

`export_anim_sequence`、`export_fbx`、`get_linked_anim_sequences`、`get_linked_level_sequence`、`import_fbx`、`link_anim_sequence`

</details>

<details>
<summary>animation_toolset.toolsets.keyframing.SequencerKeyframingTools（22）</summary>

`add_key_bool`、`add_key_float`、`add_key_integer`、`add_key_string`、`bake_channel_keys`、`close_curve_editor`、`curve_editor_empty_selection`、`curve_editor_select_keys`、`get_channel_names`、`get_curve_editor_selected_keys`、`get_default_value`、`get_keys`、`get_keys_by_index`、`get_selected_channels`、`get_selected_key_channels`、`is_curve_editor_open`、`is_curve_shown`、`open_curve_editor`、`remove_key_at_frame`、`select_channels`、`set_default_value`、`show_curve`

</details>

<details>
<summary>animation_toolset.toolsets.outliner.SequencerOutlinerTools（18）</summary>

`get_deactivated_nodes`、`get_locked_nodes`、`get_muted_nodes`、`get_node_label`、`get_outliner_children`、`get_outliner_selection`、`get_outliner_tree`、`get_pinned_nodes`、`get_sections_for_nodes`、`get_soloed_nodes`、`is_node_expanded`、`set_node_deactivated`、`set_node_expanded`、`set_node_locked`、`set_node_muted`、`set_node_pinned`、`set_node_solo`、`set_outliner_selection`

</details>

<details>
<summary>animation_toolset.toolsets.sequencer.SequencerTools（140）</summary>

`add_actors`、`add_actors_by_name`、`add_actors_to_binding`、`add_binding_to_folder`、`add_event_repeater_section`、`add_event_trigger_section`、`add_marked_frame`、`add_root_folder`、`add_section`、`add_spawnable_from_class`、`add_spawnable_from_instance`、`add_track_to_binding`、`add_track_to_folder`、`add_track_to_sequence`、`bake_transform`、`close_sequence`、`copy_bindings`、`copy_folders`、`copy_sections`、`copy_tracks`、`create_camera`、`create_level_sequence`、`delete_all_marked_frames`、`delete_marked_frame`、`empty_selection`、`find_binding_by_name`、`find_binding_by_tag`、`find_bindings_by_tag`、`find_marked_frame_by_label`、`find_tracks_by_type`、`fix_actor_references`、`focus_parent_sequence`、`focus_sub_sequence`、`force_evaluate`、`get_all_binding_tags`、`get_binding_id`、`get_binding_name`、`get_binding_tags`、`get_bindings`、`get_bound_objects`、`get_child_possessables`、`get_clock_source`、`get_current_sequence`、`get_display_rate`、`get_evaluation_type`、`get_focused_sequence`、`get_folder_contents`、`get_loop_mode`、`get_marked_frames`、`get_playback_range`、`get_playback_speed`、`get_playhead_frame`、`get_root_folders`、`get_section_blend_type`、`get_section_completion_mode`、`get_section_ease_in`、`get_section_ease_out`、`get_section_post_roll_frames`、`get_section_pre_roll_frames`、`get_section_properties`、`get_section_range`、`get_section_to_key`、`get_sections`、`get_selected_bindings`、`get_selected_folders`、`get_selected_sections`、`get_selected_tracks`、`get_selection_range`、`get_sequence_lock_state`、`get_sub_sequence_hierarchy`、`get_tick_resolution`、`get_track_display_name`、`get_track_filter_names`、`get_tracks_on_binding`、`get_tracks_on_sequence`、`get_view_range`、`get_work_range`、`has_section_end_frame`、`has_section_start_frame`、`is_camera_cut_locked`、`is_playback_range_locked`、`is_playing`、`is_sequence_locked`、`is_track_filter_active`、`open_sequence`、`paste_bindings`、`paste_folders`、`paste_sections`、`paste_tracks`、`pause`、`play`、`play_to`、`rebind_component`、`refresh_sequence`、`remove_actors_from_binding`、`remove_all_bindings`、`remove_binding`、`remove_binding_tag`、`remove_invalid_bindings`、`remove_root_folder`、`remove_section`、`remove_track`、`remove_track_from_sequence`、`replace_binding_with_actors`、`select_bindings`、`select_folders`、`select_sections`、`select_tracks`、`set_binding_name`、`set_byte_track_enum`、`set_camera_cut_binding`、`set_camera_lock`、`set_clock_source`、`set_display_rate`、`set_evaluation_type`、`set_loop_mode`、`set_playback_range`、`set_playback_range_locked`、`set_playback_speed`、`set_playhead_frame`、`set_property_name_and_path`、`set_section_animation`、`set_section_blend_type`、`set_section_completion_mode`、`set_section_ease_in`、`set_section_ease_out`、`set_section_end_bounded`、`set_section_post_roll_frames`、`set_section_pre_roll_frames`、`set_section_range`、`set_section_start_bounded`、`set_selection_range`、`set_sequence_locked`、`set_tick_resolution`、`set_track_display_name`、`set_track_filter_active`、`set_view_range`、`set_work_range`、`tag_binding`、`untag_binding`

</details>

<details>
<summary>AutomationTestToolset.AutomationTestToolset（7）</summary>

`DiscoverTests`、`GetTestResults`、`GetTestStatus`、`ListTests`、`RunTests`、`RunTestsByFilter`、`StopTests`

</details>

<details>
<summary>ConfigSettingsToolset.ConfigSettingsToolset（8）</summary>

`GetSectionPropertyValues`、`GetSectionSchema`、`ListCategories`、`ListContainers`、`ListSections`、`ResetSectionToDefaults`、`SaveSection`、`SetSectionProperties`

</details>

<details>
<summary>conversation_toolset.toolsets.conversation.ConversationTools（7）</summary>

`get_all_nodes`、`get_node_by_guid`、`get_node_connections`、`get_node_guids`、`get_sub_nodes`、`list_entry_points`、`list_speakers`

</details>

<details>
<summary>DataflowAgent.DataflowAgentToolset（22）</summary>

`AddCommentBox`、`AddNode`、`AddVariable`、`AssignDataflowTemplate`、`ConnectNodePins`、`CreateDataflowCompatibleAsset`、`CreateDataflowCompatibleAssetFromTemplate`、`CreateGraph`、`DisconnectNodePins`、`GetGraphStructure`、`GetNodeInfo`、`GetNodeTypeSchema`、`ListDataflowCompatibleAssetTypes`、`ListDataflowTemplatesForAssetClass`、`ListNodeTypes`、`ListVariables`、`RemoveCommentBox`、`RemoveNode`、`RemoveVariable`、`RepositionNode`、`SetVariable`、`UpdateNode`

</details>

<details>
<summary>DataRegistryToolset.DataRegistryTools（7）</summary>

`GetItems`、`GetRegistryInfo`、`GetSchema`、`ListDataSources`、`ListItems`、`ListRegistries`、`ListRuntimeSources`

</details>

<details>
<summary>editor_toolset.toolsets.actor.ActorTools（17）</summary>

`add_component`、`add_tag`、`get_actor_bounds`、`get_actor_transform`、`get_component_actor`、`get_components`、`get_label`、`get_parent_component`、`get_root_component`、`get_tags`、`has_tag`、`look_at`、`remove_component`、`remove_tag`、`set_actor_transform`、`set_label`、`set_parent_component`

</details>

<details>
<summary>editor_toolset.toolsets.asset.AssetTools（21）</summary>

`can_edit_asset`、`create_folder`、`delete`、`duplicate`、`exists`、`find_assets`、`get_asset_class`、`get_asset_tags`、`get_dependencies`、`get_metadata_tags`、`get_plugin_content_paths`、`get_referencers`、`is_checked_out`、`is_dirty`、`list_folders`、`load_asset`、`move`、`read_file`、`save_assets`、`update_metadata_tags`、`write_file`

</details>

<details>
<summary>editor_toolset.toolsets.blueprint.BlueprintTools（53）</summary>

`add_component_bound_event`、`add_event`、`add_event_dispatcher`、`add_function_graph`、`add_function_param`、`add_node_pin`、`add_object_function_param`、`add_object_variable`、`add_struct_function_param`、`add_struct_variable`、`add_variable`、`arrange_nodes`、`break_pins`、`compile_blueprint`、`connect_pins`、`create`、`create_node`、`delete_node`、`find_node_categories`、`find_node_types`、`find_nodes`、`get_connected_subgraph`、`get_create_event_function`、`get_default_object`、`get_graph`、`get_graph_dsl_docs`、`get_node_infos`、`get_node_type_pins`、`get_parent`、`get_pin_value`、`get_variable_category`、`get_variable_replication`、`list_compatible_event_functions`、`list_component_events`、`list_event_dispatchers`、`list_events`、`list_functions`、`list_graphs`、`list_variables`、`read_graph_dsl`、`remove_function_graph`、`remove_function_param`、`remove_node_pin`、`remove_variable`、`retarget_node_class`、`set_create_event_function`、`set_node_position`、`set_parent`、`set_pin_value`、`set_variable_category`、`set_variable_instance_editable`、`set_variable_replication`、`write_graph_dsl`

</details>

<details>
<summary>editor_toolset.toolsets.curve_table.CurveTableTools（9）</summary>

`add_key`、`add_row`、`create`、`get_keys`、`import_file`、`list_rows`、`remove_row`、`rename_row`、`set_keys`

</details>

<details>
<summary>editor_toolset.toolsets.data_asset.DataAssetTools（1）</summary>

`create`

</details>

<details>
<summary>editor_toolset.toolsets.data_table.DataTableTools（10）</summary>

`add_rows`、`create`、`get_rows`、`get_schema`、`import_file`、`list_rows`、`remove_rows`、`rename_rows`、`search_row_structs`、`set_rows`

</details>

<details>
<summary>editor_toolset.toolsets.material_instance.MaterialInstanceTools（13）</summary>

`clear_parameters`、`create`、`get_scalar_parameter`、`get_static_switch_parameter`、`get_texture_parameter`、`get_vector_parameter`、`list_parameters`、`set_parameter_override`、`set_parent`、`set_scalar_parameter`、`set_static_switch_parameter`、`set_texture_parameter`、`set_vector_parameter`

</details>

<details>
<summary>editor_toolset.toolsets.material.MaterialTools（22）</summary>

`add_expression`、`connect_expressions`、`connect_to_output`、`create_function`、`create_material`、`create_parameter_collection`、`delete_expression`、`delete_parameter_group`、`delete_unused_expressions`、`disconnect_expressions`、`disconnect_from_output`、`get_expression_input_names`、`get_expression_inputs`、`get_expression_output_names`、`get_expressions`、`get_property_input`、`get_referencing_materials`、`layout_expressions`、`list_expression_classes`、`list_parameter_groups`、`recompile`、`rename_parameter_group`

</details>

<details>
<summary>editor_toolset.toolsets.object.ObjectTools（6）</summary>

`get_class`、`get_properties`、`list_properties`、`reset_properties`、`search_subclasses`、`set_properties`

</details>

<details>
<summary>editor_toolset.toolsets.primitive.PrimitiveTools（4）</summary>

`add_cone`、`add_cube`、`add_cylinder`、`add_sphere`

</details>

<details>
<summary>editor_toolset.toolsets.programmatic.ProgrammaticToolset（2）</summary>

`execute_tool_script`、`get_execution_environment`

</details>

<details>
<summary>editor_toolset.toolsets.scene.SceneTools（20）</summary>

`add_to_scene_from_asset`、`add_to_scene_from_class`、`can_edit`、`commit_level_instance`、`create_level_instance`、`delete_folder`、`edit_level_instance`、`find_actors`、`get_actors_in_folder`、`get_collision_channels`、`get_current_level`、`get_folders`、`is_checked_out`、`load_level`、`merge_actors`、`remove_from_scene`、`rename_folder`、`save_actor`、`set_actor_folder`、`trace_world`

</details>

<details>
<summary>editor_toolset.toolsets.skeletal_mesh.SkeletalMeshTools（22）</summary>

`add_socket`、`assign_physics_asset`、`get_bone_children`、`get_bone_names`、`get_bone_parent`、`get_bounds`、`get_lod_count`、`get_material`、`get_material_slots`、`get_morph_target_names`、`get_physics_asset`、`get_section_count`、`get_skeleton`、`get_socket_bone`、`get_socket_names`、`get_socket_transform`、`get_vertex_count`、`import_file`、`remove_socket`、`rename_socket`、`set_material`、`set_socket_transform`

</details>

<details>
<summary>editor_toolset.toolsets.static_mesh.StaticMeshTools（16）</summary>

`generate_convex_collisions`、`generate_lods`、`get_bounds`、`get_lod_count`、`get_lod_thresholds`、`get_material`、`get_material_slots`、`get_triangle_count`、`get_vertex_count`、`import_file`、`is_nanite_enabled`、`remove_collisions`、`remove_lods`、`set_lod_thresholds`、`set_material`、`set_nanite_enabled`

</details>

<details>
<summary>editor_toolset.toolsets.string_table.StringTableTools（8）</summary>

`create`、`get_entry`、`get_namespace`、`get_table_id`、`import_file`、`list_keys`、`remove_entry`、`set_entry`

</details>

<details>
<summary>editor_toolset.toolsets.texture.TextureTools（2）</summary>

`get_size`、`import_file`

</details>

<details>
<summary>EditorToolset.EditorAppToolset（21）</summary>

`CaptureAssetImage`、`CaptureEditorImage`、`CaptureViewport`、`FocusOnActors`、`GetCameraTransform`、`GetContentBrowserPath`、`GetOpenAssets`、`GetSelectedActors`、`GetSelectedAssets`、`GetVisibleActors`、`IsPIERunning`、`OpenEditorForAsset`、`ScreenCoordsToWorld`、`SearchCVars`、`SelectActors`、`SelectAssets`、`SetCameraTransform`、`SetContentBrowserPath`、`StartPIE`、`StopPIE`、`WorldPosToScreenCoords`

</details>

<details>
<summary>EditorToolset.LogsToolset（4）</summary>

`GetLogCategories`、`GetLogEntries`、`GetVerbosity`、`SetVerbosity`

</details>

<details>
<summary>GameFeaturesToolset.GameFeaturesToolset（7）</summary>

`GetGameFeatureState`、`IsGameFeatureActive`、`IsGameFeaturePlugin`、`ListDiscoveredGameFeaturePlugins`、`ListEnabledGameFeaturePlugins`、`RequestActivateGameFeature`、`RequestDeactivateGameFeature`

</details>

<details>
<summary>GameplayTagsToolset.GameplayTagsToolset（6）</summary>

`AddTag`、`FindReferencersByTag`、`GetTagInfo`、`ListTags`、`RemoveTag`、`RenameTag`

</details>

<details>
<summary>GASToolsets.AbilitySystemInspectorToolset（4）</summary>

`GetActiveEffects`、`GetActiveTags`、`GetAttributeValues`、`GetGrantedAbilities`

</details>

<details>
<summary>GASToolsets.AttributeSetToolset（2）</summary>

`FindAttributeSetClasses`、`ListAttributes`

</details>

<details>
<summary>GASToolsets.GameplayCueToolset（8）</summary>

`AddCueTag`、`CreateCueNotifyAsset`、`ExecuteCueOnSelectedActor`、`FindCueNotifyAssets`、`FindCueTagsWithoutNotifies`、`GetCueInfo`、`ListCues`、`RemoveCueTag`

</details>

<details>
<summary>NiagaraToolsets.NiagaraToolset_Assets（3）</summary>

`FindNiagaraScripts`、`GetAssetDiscoveryInfo`、`GetNiagaraScriptDigest`

</details>

<details>
<summary>NiagaraToolsets.NiagaraToolset_Blueprint（2）</summary>

`ConstructNiagaraBPWrapperFromComponent`、`ConstructNiagaraBPWrapperFromSystem`

</details>

<details>
<summary>NiagaraToolsets.NiagaraToolset_Component（4）</summary>

`GetUserVariables`、`GetVariable`、`SetSystem`、`SetVariable`

</details>

<details>
<summary>NiagaraToolsets.NiagaraToolset_Info（1）</summary>

`UEnum_Info`

</details>

<details>
<summary>NiagaraToolsets.NiagaraToolset_System（46）</summary>

`AddEmitter`、`AddModule`、`AddRenderer`、`AddSetParameterEntry`、`AddSetParametersModule`、`AddUserVariables`、`ApplyStackIssueFix`、`CreateNiagaraSystem`、`GetAvailableDynamicInputs`、`GetDataInterfaceSchema`、`GetDynamicInputChain`、`GetDynamicInputSchema`、`GetDynamicInputSchemaFromAsset`、`GetEmitterData`、`GetEmitterInputValues`、`GetEmitterSchema`、`GetEmitterSummary`、`GetEmitterTopology`、`GetModuleInputValues`、`GetModuleSchema`、`GetModuleSchemaFromAsset`、`GetModuleTopology`、`GetRendererData`、`GetRendererSchema`、`GetScriptStackInputValues`、`GetScriptStackTopology`、`GetStackInputData`、`GetStackInputSchema`、`GetStackInputTopology`、`GetStackIssues`、`GetSystemCompileState`、`GetSystemData`、`GetSystemDependencies`、`GetSystemSchema`、`GetSystemSummary`、`GetUserVariables`、`RemoveEmitter`、`RemoveModule`、`RemoveRenderer`、`RemoveSetParameterEntry`、`RemoveUserVariables`、`SetEmitterData`、`SetModuleEnabled`、`SetRendererData`、`SetStackInputData`、`SetSystemData`

</details>

<details>
<summary>PCGToolset.PCGSpatialToolset（1）</summary>

`RunPCGInstantGraph`

</details>

<details>
<summary>PCGToolset.PCGToolset（30）</summary>

`AddCommentBox`、`AddNode`、`AddSubgraphNode`、`ConnectNodePins`、`CreateGraph`、`DisconnectNodePins`、`DrawSpline`、`ExecuteGraphInstance`、`GetGraphDescription`、`GetGraphInstanceParams`、`GetGraphSchema`、`GetGraphStructure`、`GetNativeNodeSchema`、`GetNodeDataView`、`GetNodeInfo`、`ListAvailableSubgraphs`、`ListGraphInstances`、`ListNativeNodes`、`RemoveCommentBox`、`RemoveGraphParams`、`RemoveNode`、`RepositionNode`、`ResetGraphInstanceParams`、`SetGraphDescription`、`SetGraphInstanceParams`、`SetGraphParams`、`SetNodeComment`、`SpawnGraphInstance`、`UpdateCommentBox`、`UpdateNode`

</details>

<details>
<summary>PhysicsToolsets.PhysicsAssetToolset（17）</summary>

`AddBody`、`AddConstraint`、`CreateFromMesh`、`GetBodyMassScale`、`GetBodyNames`、`GetBodyPhysicsMode`、`GetBodyShapes`、`GetConstraints`、`RemoveBody`、`RemoveConstraint`、`RemoveShape`、`SetBodyMassScale`、`SetBodyPhysicsMode`、`SetBox`、`SetCapsule`、`SetConstraintLimits`、`SetSphere`

</details>

<details>
<summary>PluginToolset.PluginToolset（17）</summary>

`AddPluginDependency`、`CreatePlugin`、`GetPluginDependencies`、`GetPluginDependents`、`GetPluginDescriptor`、`GetPluginForAsset`、`GetPluginInfo`、`GetPluginTemplateDescriptions`、`IsEnabled`、`IsPluginCreationAllowed`、`IsPluginModificationAllowed`、`ListDiscoveredPlugins`、`ListEnabledPlugins`、`RemovePluginDependency`、`SetPluginEnabled`、`UpdatePluginDescriptor`、`ValidateNewPluginNameAndLocation`

</details>

<details>
<summary>SemanticSearchToolset.SemanticSearchToolset（2）</summary>

`FindSimilar`、`Search`

</details>

<details>
<summary>SlateInspectorToolset.SlateInspectorToolset（14）</summary>

`Click`、`Drag`、`FillForm`、`Hover`、`ListObservers`、`Observe`、`PressKey`、`Screenshot`、`SelectOption`、`Snapshot`、`Type`、`Unobserve`、`WaitFor`、`Windows`

</details>

<details>
<summary>state_tree_toolset.toolsets.state_tree.StateTreeTools（9）</summary>

`get_children`、`get_editor_data`、`get_enter_conditions`、`get_evaluators`、`get_global_tasks`、`get_node_description`、`get_root_states`、`get_tasks`、`get_transitions`

</details>

<details>
<summary>ToolsetRegistry.AgentSkillToolset（4）</summary>

`CreateSkill`、`GetSkills`、`ListSkills`、`UpdateSkill`

</details>

<details>
<summary>UMGToolSet.UMGToolSet（23）</summary>

`AddUIComponent`、`AddWidget`、`BindToEventProperty`、`CompileWidgetBlueprint`、`CreateWidgetBlueprint`、`GetNamedSlots`、`GetWidgetClassInfo`、`GetWidgetDescription`、`GetWidgetTreeDepth`、`GetWidgets`、`ListWidgetBlueprints`、`ListWidgetClasses`、`MoveUIComponent`、`MoveWidget`、`RemoveUIComponent`、`RemoveWidget`、`RenameWidget`、`ReplaceWidgetWithChild`、`ReplaceWidgetWithNamedSlot`、`ReplaceWidgetWithTemplate`、`SetNamedSlotContent`、`ToggleWidgetAsVariable`、`WrapWidgets`

</details>

<details>
<summary>WorldConditionsToolset.WorldConditionTools（2）</summary>

`GetConditionDescription`、`GetQueryDescription`

</details>
