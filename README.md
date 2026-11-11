# DSH Unreal Bridge

DeepSeek Harness（DSH）的 Unreal Editor 桥接插件。每个对话可以独立绑定本机 UE 编辑器，显示资产、Actor、组件选区，并使用蓝图、材质、MCP、项目知识、运行快照和图像分析工具。

本仓库提供 **DSH 端插件**安装入口，版本为 **0.6.3**，同步原仓库 0.6.1 的最新实现，适配 DSH **0.2.1-rc.2**。UE 工程侧需要另外将 [DSHUnrealBridge 插件](unreal/DSHUnrealBridge)导入项目、编译并启用。

**仅支持 Unreal Engine 5.8（UE 5.8.x），不支持其他 UE 版本。** 请使用 UE 5.8 创建或打开目标项目，并使用同一引擎版本编译插件。

## 使用流程一览

**安装 DSH 端 → 将 DSHUnrealBridge 导入 UE 5.8 项目 → 编译并启用插件 → 打开两端并绑定对话 → 选择对象 → 提出任务 → 检查结果并保存。**

已经安装 UE 端插件的用户，只需安装本仓库的 DSH 端，然后重新选择编辑器。

| 准备项 | 要求 |
| --- | --- |
| DSH | 已安装并启动过的 DSH Desktop，当前适配版本为 0.2.1-rc.2 |
| 系统与工程 | 当前使用流程面向 Windows、本机 UE 工程；DSH 与 UE 使用同一 Windows 用户运行 |
| UE 插件 | 将 `DSHUnrealBridge` 整个目录导入工程的 `Plugins/DSHUnrealBridge`，编译并启用 |
| 引擎版本 | **仅支持 UE 5.8（5.8.x），其他版本不受支持** |
| 网络 | DSH 安装插件时需要下载依赖；GitHub 安装还需要能够访问仓库或 DSH 提供的镜像 |

仅安装 DSH 端不需要系统 Node.js。只有开发本插件或从源码准备 UE 端知识工具时，才需要 Node.js 22+ 和 npm。

## 第一步：在 DSH 页面安装

### 从 GitHub 安装

此方式在本仓库代码推送到 GitHub 后可用。若当前只有本地副本，使用下方“从本地目录安装”。

打开 **插件 → 添加插件**，在“包名、GitHub 仓库地址或本地目录路径”输入框中粘贴：

```text
https://github.com/ddd104/dsh-bridge-unreal
```

点击 **安装**，完成后启用插件；若输入框上方没有出现 Unreal Editor 面板，完整退出 DSH（包括托盘）后重新打开。

同一输入框也支持明确的 GitHub 包地址：

```text
github:ddd104/dsh-bridge-unreal
```

### 从本地目录安装

在同一“添加插件”输入框中，输入包含 `package.json` 的仓库根目录绝对路径。例如本机：

```text
./dsh-bridge-unreal/dist/dsh/install-dsh.bat
```

点击安装，完成后启用插件。路径应指向本仓库根目录，不是 `src`、`lib` 或 UE 工程的插件目录。

也可以输入已生成的 `.tgz` 安装包的绝对路径。安装包生成和独立交付方法见[发行说明](docs/dsh-release.md)。

仓库根目录已经包含插件声明、`cordis.patch.yml` 和编译好的 `lib/index.js`、`lib/client.js`、`lib/remote.js`。安装用户无需运行 npm、编译源代码或执行批处理；下载依赖仍需要网络。仓库地址安装使用远端提交，因此本地修改必须先推送到 GitHub 才能被其他机器下载。

“中国大陆镜像源”控制依赖下载与 DSH 提供的 GitHub 镜像流程；GitHub 下载失败时按 DSH 的连接提示选择镜像或切换网络。插件本身不设置系统代理或改写镜像地址。

仓库名是 `dsh-bridge-unreal`，**插件包名和运行时标识仍为 `dsh-unreal-bridge`**，以便沿用旧版设置及通信标识。这不是 npm 包名变更，也不要求同时启用两份插件。若旧版本来自本地安装包，按 DSH 界面提示先卸载旧包，再安装本仓库；升级前可备份 DSH 配置。

## 第二步：将 DSHUnrealBridge 导入 UE 5.8 项目

在 DSH 中安装插件不会自动将 UE 插件装入项目，也不会自动编译 DLL。请手动导入本仓库的 `unreal/DSHUnrealBridge`；UE 端源码和构建说明也可在[原仓库](https://github.com/ddd104/dsh-unreal-bridge)查看。已经完成导入、编译和启用的 UE 5.8 项目可跳到下一步。

### 导入、编译与启用

1. 确认目标项目使用 **UE 5.8**，然后关闭该项目的 Unreal Editor。
2. 在 `.uproject` 文件所在的项目根目录创建 `Plugins` 文件夹；已存在时直接使用。
3. 将本仓库 `unreal/DSHUnrealBridge` **整个文件夹**复制到项目的 `Plugins` 下，确保插件描述文件位于 `Plugins/DSHUnrealBridge/DSHUnrealBridge.uplugin`。不要只复制 `.uplugin` 文件，也不要将插件放进 `Content` 或通过内容浏览器导入。
4. 使用 **UE 5.8** 和对应的 C++ 构建环境编译项目的 Editor 目标，再打开项目。如果提示模块缺失或需要重新编译，先完成编译；不能使用其他 UE 版本的插件 DLL。
5. 在 UE 的 **编辑 → 插件（Edit → Plugins）** 中搜索并启用 **DSH Unreal Bridge**。插件声明依赖 `ModelContextProtocol` 与 `ToolsetRegistry`；需要通用 UE MCP 操作时，工程还应启用所需工具集，例如原仓库使用的 `AllToolsets`。按 UE 提示重启编辑器。

导入后的目录结构应为：

```text
MyProject/
├─ MyProject.uproject
└─ Plugins/
   └─ DSHUnrealBridge/
      ├─ DSHUnrealBridge.uplugin
      ├─ Source/
      ├─ Config/
      ├─ Skills/
      ├─ ThirdParty/
      └─ Tools/
```

升级已有插件时，先备份原来的 `Plugins/DSHUnrealBridge`，并保留自己修改过的 `Config/Knowledge/ProjectMemory.project.json`。

### 准备项目知识工具

项目知识功能还需要固定版本的 Node 运行时和已构建的知识工具。如果导入的插件尚未包含准备好的 `Runtime` 和工具构建产物：

1. 在本机安装 Node.js 22+ 和 npm，并打开本仓库根目录。
2. 在**本仓库根目录**运行以下命令，下载并校验固定版本的 Node 运行时、构建配套知识工具。

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-knowledge.ps1
   ```

3. 将本仓库 `unreal/DSHUnrealBridge` 中准备好的 `Runtime`、`Tools` 目录复制到目标项目的 `Plugins/DSHUnrealBridge` 下，保持与该 UE 插件源码版本配套，然后重新打开项目。

原仓库的 `install-dsh.bat` 同时处理旧版 DSH 安装流程；已通过本仓库安装 DSH 端时，可按上面的步骤单独准备 UE 端。

本次两端同步增加了 DataTable 字段批量修改能力：支持预览后提交、嵌套字段及已有 Map 键和数组元素修改、从原值深复制，提交后不自动保存。使用该能力需要同时更新 DSH 端并重新编译 UE 端；参数说明见[工具与通信协议](docs/protocol.md)。

## 第三步：绑定编辑器并确认选区

1. 打开 DSH 和已准备好的 UE 工程。
2. 在 DSH 中打开一个对话，找到聊天输入框上方的 **Unreal Editor** 面板；如果面板收起，点击展开按钮。
3. 在面板中选择目标编辑器，核对显示的工程和连接状态。每个对话独立绑定，切换对话后需检查绑定对象。
4. 在 UE 的 Content Browser 中选一个蓝图，或在关卡中选一个 Actor/组件，确认 DSH 面板显示同一个对象。支持多选；执行针对单个对象的任务时，先选清楚目标。
5. 发送下面的只读请求，完成首次连通检查：

   ```text
   读取当前绑定的 Unreal Editor 状态，告诉我工程、当前选中对象和可用工具能力，不修改任何资产。
   ```

默认连接仅监听本机 `127.0.0.1:17891`。Windows 下 UE 从 `%LOCALAPPDATA%\DSHUnrealBridge\bridge.json` 发现 DSH 端连接信息；正常使用不需要手动填写或复制令牌。

选区变化只更新面板与本地缓存，不会自动向模型发送任务。多开工程时以当前对话的绑定为准，先核对对象再提出修改请求。

## 第四步：在对话中操作 UE

可以直接使用自然语言。以下示例中的“当前选中”指面板已经显示的对象。

### 读取与解释

```text
读取当前选中的蓝图，说明 BeginPlay 的执行逻辑和它引用的主要资产，不做修改。
```

### 修改蓝图或材质

```text
在当前选中蓝图的 BeginPlay 后增加 PrintString，打印 Hello。先读取当前图并预览修改，等我确认再应用，不要保存。
```

预览后确认目标与修改范围，再明确要求应用。检查 UE 中的编译结果和实际图内容，最后单独要求保存。原生蓝图、材质补丁不会自动保存资产；其他 MCP 工具是否包含保存行为，以该工具的说明为准。

### 分析运行状态

在 UE 中开始 PIE 或模拟，选中运行中的 Actor/组件，然后发送：

```text
读取当前运行实例的状态，检查组件可见性和变换，结合相关蓝图分析异常原因，不修改。
```

运行快照按请求采集，不是连续录像或执行轨迹。结束 PIE 后旧实例身份失效；重新运行需要重新选择对象。

### 对比参考图

上传参考图，在 UE 关卡中选择目标 Actor/组件，然后发送：

```text
将这张参考图与当前选中物体的编辑器画面对比，用中文说明色彩、形状和材质上的差异，不修改场景。
```

当前画面捕获支持编辑器关卡视口，不支持 PIE 游戏窗口截图。不同视角或构图的参考图用于辅助分析，不等同于像素验收。详见[局部画面对比](docs/visual-comparison.md)。

### 查询项目资料与技能

将 DSH 会话工作区设置为 UE 工程目录或其子目录。插件会向上寻找 `.uproject`，接入该工程 `Plugins/DSHUnrealBridge/Skills` 中的技能；项目知识查询需要 UE 端知识工具已经准备完成。可以请求“查询项目资料中角色移动系统的设计，并结合当前蓝图说明实现”。

完整工具行为与参数见[工具与通信协议](docs/protocol.md)。

## 设置、升级与卸载

在 **DSH 设置 → Unreal Bridge** 或插件行的配置入口调整执行权限、修复次数、任务预算、超时与缓存保留。

- 初次安装的 bundle 配置允许写入，原生写入批准选项为关闭。只读体验可关闭“允许修改 UE 资产和项目知识”；需要原生写入确认时开启“原生写入前请求批准”，其适用范围见设置说明。
- 权限与超时从下一次请求生效；预算和修复限制从下一轮用户任务生效。保存缓存设置本身不会删除文件。
- 升级 DSH 端时，按 DSH 插件页支持的更新或卸载重装流程操作，完成后重新打开 DSH。本地源码修改需重新构建并重新安装；GitHub 安装读取远端已推送的版本。
- 新功能如果报告 UE 能力不足，需要另外更新并重新编译 UE 插件，然后重启工程。
- 停用或卸载 DSH 端在插件页操作。该操作不会移除工程中的 UE 插件或项目资料。

## 常见问题

| 现象 | 排查顺序 |
| --- | --- |
| GitHub 地址安装失败 | 确认代码已推送且仓库可访问；按 DSH 提示选择镜像或检查网络。本地尚未发布时改用绝对目录路径安装 |
| 安装成功但没有面板 | 确认插件已启用、DSH 为适配版本；完整退出 DSH（包括托盘）后重开，并打开一个对话 |
| 面板没有在线 UE | 确认 UE 插件编译并加载成功、两端运行于同一用户、没有另一份桥接进程占用端口；查看 DSH 和 UE 的错误日志 |
| 有编辑器但选区不对 | 检查当前对话绑定的工程；在 UE 中重新选择目标，再核对面板中的对象路径 |
| UE 提示引擎版本不兼容 | 本插件仅支持 UE 5.8；请使用 UE 5.8 项目及该版本编译的插件，不支持其他引擎版本 |
| 提示 MCP 或某项能力不可用 | 核对 UE 端版本、`ModelContextProtocol` 及所需工具集；更新并编译 UE 插件后重启 |
| 技能或项目知识不可用 | 核对会话工作区能否向上找到 `.uproject`，以及 UE 插件的 `Skills`、准备好的 `Runtime` 和知识工具是否完整 |
| 写入超时或结果未知 | 先让 DSH 查询原请求状态并读取实际结果，避免直接重复相同修改 |

