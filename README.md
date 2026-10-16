# dsh-vs-assist

一个 DeepSeek Harness 插件：让 DSH **直接驱动本机的 Visual Studio**（2019/2022/2026），像内联代码助手一样工作 —— 读取编辑器上下文 → 生成代码 → 写回 VS 编辑器 → 构建 → 读错误 → 修复 → 运行。

> **免责声明 / Disclaimer**
>
> 本项目是独立的第三方开源项目，与 GitHub, Inc. 或 Microsoft Corporation
> **无任何关联**，未获得其赞助、认可或授权。"GitHub Copilot" 是 GitHub, Inc.
> 的注册商标，"Visual Studio" 是 Microsoft Corporation 的商标，本项目仅以
> 描述性方式提及这些名称。
>
> 本插件**不包含、不调用、不模拟** GitHub Copilot 的任何代码、服务或订阅；
> 代码补全能力完全来自用户自己所配置的 DSH 模型。插件仅通过 Microsoft
> **公开文档化**的 `EnvDTE` 自动化接口驱动用户本机已授权安装的 Visual Studio，
> **不重分发**任何 Microsoft 二进制文件或程序集。

## 工作原理

- **控制 VS**：通过 Visual Studio 的 DTE COM 自动化接口（`EnvDTE`）。插件从 Host 进程调用
  `powershell.exe -STA`，用 `GetActiveObject("VisualStudio.DTE.18.0/17.0/16.0/15.0")` 附加到正在
  运行的 VS；没有实例时可通过 `vswhere` 找到 `devenv.exe` 自动启动（可配置）。
- **助手能力**：DSH 本身就是大模型，插件把 VS 的当前文档、光标、选区作为工具数据暴露给模型，
  并把模型的代码通过编辑器自动化写回 VS —— 这就是"读上下文 + 内联补全 + 聊天式重构"闭环。
- **构建/错误**：默认用 VS 自带的 `MSBuild.exe` 子进程构建并解析结构化的 error/warning
  （文件、行列、错误码、消息），不依赖 IDE 窗口状态，在虚拟机/远程桌面等 IDE 外壳受限的环境下依然可靠。

## 工具列表

| 工具 | 作用 |
| --- | --- |
| `vs_status` | 附加到 VS 实例，报告版本/解决方案/活动文档/UI 状态 |
| `vs_instances` | 列出正在运行的 devenv.exe 进程 |
| `vs_context` | 读取活动文档：语言、光标行列/偏移、选区、光标附近代码 |
| `vs_complete` | 在光标处插入代码（幽灵文本式补全） |
| `vs_edit` | 编辑代码：`insert` / `replace_selection` / `replace_range` / `replace_document`，可自动格式化 |
| `vs_open` | 在 VS 中打开文件并定位到行列；`.sln`/`.slnx` 路径会按解决方案打开 |
| `vs_open_solution` | 在 VS 中打开解决方案（.sln / .slnx） |
| `vs_new_file` | 创建新文件并写入内容，在 VS 中打开（自动归一化混合行尾） |
| `vs_save` | 保存当前/指定/全部文档 |
| `vs_build` | 构建解决方案或项目（`msbuild` 结构化引擎 / `ide` IDE 内构建） |
| `vs_errors` | 读取 VS 错误列表（构建 + IntelliSense） |
| `vs_run` | `start`（F5 调试）/ `start_without_debug`（Ctrl+F5）/ `stop` |
| `vs_solution` | 解决方案信息与项目列表 |
| `vs_command` | 执行白名单内的编辑器命令（格式化、注释、转到定义、撤销等） |

插件同时注册 `vs-assist` skill，引导模型按助手工作流操作（先 `vs_context` 再改码，改完构建修错）。

## 安装（本机手动挂载）

1. 把本目录放进你的 profile 依赖：

   ```powershell
   cd $env:DSH_HOME\profiles\desktop
   & $env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs add "dsh-vs-assist@file:C:\path\to\dsh-vs-assist"
   ```

2. 在 profile 的 `cordis.patch.yml` 末尾追加挂载行：

   ```yaml
   - insert:
       - id: vs-assist
         name: dsh-vs-assist
         config:
           launchIfMissing: true
           softwareRendering: false
   ```

3. 重启 DSH（或在插件管理器中启用）。加载成功后在会话里能看到 `vs_*` 工具。

> 若通过 `dsh plugin add` / 插件市场渠道分发，包的 `dsh.bundle.patch` 会自动把该条目插入 bundle 栈，无需手写挂载行。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `devenvPath` | 自动 | devenv.exe 路径；缺省用 vswhere 探测 |
| `msbuildPath` | 自动 | MSBuild.exe 路径；缺省取 VS 安装目录 `MSBuild\Current\Bin\MSBuild.exe` |
| `versionKey` | `18.0` | 软件渲染注册表键版本（VS2026=`18.0`，VS2022=`17.0`，VS2019=`16.0`） |
| `launchIfMissing` | `true` | 没有运行实例时自动启动 VS |
| `launchTimeoutMs` | `180000` | 等待 VS 注册 DTE 的超时 |
| `commandTimeoutMs` | `60000` | 单次 DTE 桥接往返超时 |
| `buildTimeoutMs` | `600000` | 单次构建超时 |
| `contextLines` | `60` | `vs_context` 光标上下文行数 |
| `readMaxChars` | `120000` | `vs_context` 返回全文的字符上限 |
| `softwareRendering` | `false` | 启动前写入 WPF 软件渲染注册表（修复虚拟机/RDP 下 VS 窗口黑屏） |
| `normalizeNewlines` | `true` | `vs_new_file` 写入前把混合行尾归一化（防止 VS 弹"行尾不一致"对话框） |

## 故障排查

- **"no running Visual Studio instance found"**：VS 未运行且 `launchIfMissing: false`；
  手动打开一次 VS，或把该配置改为 `true`。
- **VS 窗口黑屏（虚拟机/远程桌面）**：WPF 硬件加速失效。把 `softwareRendering: true`（会写入
  `HKCU\Software\Microsoft\Avalon.Graphics DisableHWAcceleration=1` 与对应版本的
  `EnableHardwareAcceleration=0`）后重启 VS；或在 VS 选项里关闭硬件加速。
- **`vs_status.suppressedUi = true`**：当前实例以 UI 抑制的自动化模式运行（部分环境始终如此）。
  文档编辑、构建不受影响；错误列表类读取建议用 `vs_build`（msbuild 引擎）返回的结构化错误。
- **多实例**：插件通过 ROT 附加；同时开多个 VS 时附加到的实例不保证是最新窗口。先用
  `vs_instances` 查看，必要时关闭多余实例。
- **中文路径/中文代码**：桥接输出为 UTF-8 JSON，支持任意 Unicode；编辑操作基于字符偏移，与
  `vs_context` 返回的偏移严格一致（Windows CRLF 按 2 字符计）。
- **"不一致的行尾"对话框卡住自动化**：被编辑文件同时含 CRLF 与 LF 时，VS 会弹模态框，之后所有
  DTE 调用报 `RPC_E_CALL_REJECTED` 直到人工确认。`vs_edit` 结果会带 `lineEnding: "MIXED"` 与
  `lineEndingWarning` 提示；`vs_new_file` 默认自动归一化。对已有混合行尾文件建议先统一行尾再继续。

## 开发与发布

### 环境要求

- **Windows**(插件依赖 Visual Studio 的 DTE COM 自动化,其他平台无法工作)
- Node.js ≥ 20
- 本机已安装 Visual Studio 2019 / 2022 / 2026(需装 .NET 桌面或 C++ 工作负载之一)

### 本地检查

仓库自带 GitHub Actions 工作流([.github/workflows/ci.yml](.github/workflows/ci.yml)),
在每次 push / PR 时执行以下检查,提交前也可手动跑一遍:

```powershell
# JavaScript 语法
node --check lib/index.js; node --check lib/bridge.js; node --check lib/msbuild.js

# PowerShell 桥接语法
$e=$null; [System.Management.Automation.Language.Parser]::ParseFile("lib/vs-dte.ps1",[ref]$null,[ref]$e); $e.Count

# 打包内容(不会真的生成 tarball)
npm pack --dry-run
```

CI 覆盖的重点(都是本项目踩过坑的地方):

| 检查 | 为什么需要 |
| --- | --- |
| `vs-dte.ps1` 必须为**纯 ASCII** | Windows PowerShell 5.1 按 ANSI 读取 `.ps1`,非 ASCII 字节会被曲解 |
| `vs-dte.ps1` 必须有 fail-closed 的 `default` 分支 | 桥接按字符串动作名调用,未知动作必须报错而非静默通过 |
| `bridge.js` 必须传 `-STA` | EnvDTE 自动化要求单线程套间,漏掉会静默地让所有 COM 调用失败 |
| `lib/index.js` 的裸导入必须都在 `peerDependencies` 里 | 宿主 DSH 在运行时注入这些包,仓库里刻意不安装它们 |
| `package.json` 名称/描述/关键词不得含 Copilot 商标 | 商标合规,防止 CI 无意间把商标写回清单 |
| 清单引用的每个路径必须存在 | 防止 `exports.types` 之类的字段指向不存在的文件 |

### 发布到 npm

工作流 [.github/workflows/release.yml](.github/workflows/release.yml) 在推送 `v*` 标签时自动发布。

**一次性配置**:在 npm 生成有发布权限的 Access Token,加到仓库 Secrets,名为 `NPM_TOKEN`。

**发布步骤**:

```powershell
# 1. 改 package.json 的 version,提交
git add -A; git commit -m "Release v0.1.0"

# 2. 打同名标签并推送,触发自动发布
git tag v0.1.0
git push origin main --tags
```

工作流会先校验**标签版本与 `package.json` 版本一致**(不一致直接失败),再跑语法检查、
`npm pack --dry-run`,最后发布。

> 首次发布前建议确认包名 `dsh-vs-assist` 在 npm 上未被占用:
> `npm view dsh-vs-assist`(返回 404 说明可用)。

## 安全说明

- `vs_command` 仅允许白名单内的只读/编辑命令，不能执行任意 VS 命令。
- 所有编辑只发生在已打开的文档上；`vs_new_file` 只创建请求的路径。
- 插件从 DSH Host 进程派生 PowerShell 子进程，超时会 `taskkill` 整个进程树。

## 致谢

本插件的**插件结构**（Cordis 插件入口、`defineTool` 注册方式、`dsh.bundle.patch` 挂载约定、
skill 注册模式）参考了 DSH 生态中公开插件（如 `@wxg-prc-cpg/browser-skill-dsh-plugin`、
`dsh-better-sidebar`）所展示的公开接口用法。本项目的全部源码——包括 DTE 桥接
（`lib/vs-dte.ps1`）、Node 桥接（`lib/bridge.js`）、MSBuild 引擎（`lib/msbuild.js`）——
均为本项目独立编写，未复制上述项目的代码。

## 第三方组件与接口

| 名称 | 关系 | 说明 |
| --- | --- | --- |
| Visual Studio / `devenv.exe` | 用户自行安装并授权 | 本插件不打包、不重分发；仅从外部驱动 |
| `EnvDTE`（DTE COM） | Microsoft 公开文档化自动化接口 | 通过 PowerShell 的 `GetActiveObject` 调用，**不引用或分发任何 VS 程序集** |
| `MSBuild.exe` | 随 Visual Studio 提供 | 仅作为子进程调用，不重分发 |
| `@deepseek-ai/dsh-*`、`cordis`、`schemastery` | 宿主 DSH 提供 | 声明为 `peerDependencies`，不打包、不重分发 |

## License

MIT —— 见 [LICENSE](LICENSE)。商标、第三方接口与不重分发声明见 [NOTICE](NOTICE)。
