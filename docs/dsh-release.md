# DSH 插件发行与安装

推荐安装方式是在 DSH **插件 → 添加插件** 输入 `https://github.com/ddd104/dsh-bridge-unreal`。仓库根目录提交了可直接运行的 bundle，不依赖安装脚本构建。

## 维护 GitHub 安装源

```powershell
npm ci
npm run check
```

提交源码、`package.json`、锁文件和重新构建的 `lib/*.js`，推送到默认分支。安装器只看远端文件，未推送的本地改动不会出现在 GitHub 安装中。升级时同步增加 `package.json` 和锁文件版本，再构建；保持包名 `dsh-unreal-bridge`。

## 单独交付安装包

```powershell
npm run package:dsh
```

`dist/dsh/` 中包含：

- `dsh-unreal-bridge-0.6.2.tgz`
- `install-dsh.bat`
- `install-dsh-release.ps1`
- `resolve-dsh-cli.ps1`
- `INSTALL.txt`

将五个文件放在同一目录，双击 `install-dsh.bat`。脚本调用 DSH 官方安装命令，默认使用已初始化的 `desktop` 配置，先备份配置并按 SHA256 保存安装包。安装后完整退出 DSH（包括托盘）再打开。安装机器不需要本仓库源码或系统 Node.js，依赖下载需要联网。

也可将 `.tgz` 的绝对路径粘贴到 DSH 添加插件输入框，或使用 DSH CLI：

```powershell
dsh plugin --profile desktop add 'github:ddd104/dsh-bridge-unreal' --ignore-scripts
```

发行包不含开发源码、测试、sourcemap 或 UE 插件。JS 构建产物仍可阅读，不是源码加密；第三方依赖保留各自许可证。许可文件随包交付。
