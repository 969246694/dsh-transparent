# NOTICE

## Unofficial

This is an unofficial, community-made plugin. It is not affiliated with,
endorsed by, or supported by DeepSeek. "DeepSeek", "DeepSeek Harness" and
related marks belong to their respective owners.

It reaches into the DSH desktop application in two ways that are worth stating
plainly, because both are unusual for a plugin:

1. **It injects CSS into the running interface** to clear the app's background
   and to style the composer.
2. **It spawns a PowerShell script** (`assets/window-glass.ps1`) that calls
   Win32/DWM APIs to make the application window translucent.

Both are visible in this repository. Read them before installing. Nothing is
downloaded, nothing is phoned home, and no network access is performed by
either half of the plugin.

## Design references

The liquid-glass treatment is inspired by **Apple's Liquid Glass** design
language. No Apple code, assets, fonts or proprietary materials are used or
redistributed. What this project implements is our own approximation of the
visual behaviour, built from:

- an SVG displacement map generated at runtime with canvas
- `backdrop-filter` referencing that map through `url(#id)`
- CSS layers for the sheen and rim highlights

An SVG normal map built with the Sobel operator is standard graphics technique,
not an Apple implementation.

## Third-party components

None. The plugin has **zero dependencies** — no runtime packages, no build
packages. `build.mjs` and `verify.mjs` use only Node's standard library.

## Platform

The window-transparency half is **Windows only**. It uses Win32
(`SetLayeredWindowAttributes`) and DWM (`DwmSetWindowAttribute`), and it is
invoked through `powershell.exe`.

On other platforms the browser half still works; only the window translucency
is skipped. See the README for details.

---

## 3. 打包进来的第三方代码（lib/vendor/）

`lib/vendor/` 下的两个文件不是本项目的代码，是为了让插件**零依赖**而内置的：

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| schemastery.mjs | @deepseek-ai/schemastery | 3.18.4 | MIT |
| cosmokit.mjs | @deepseek-ai/cosmokit | 1.8.5 | MIT |

两份许可证原文就在同目录下（`schemastery.LICENSE` / `cosmokit.LICENSE`）。

**为什么要打包**：设置界面需要 `Config` 结构，而它**必须是真正的 schemastery schema**——DSH 在加载时会用 Standard Schema 接口校验配置：

``js
runtime.Config['~standard'].validate(config)
``

而装在 `<profile>/node_modules` 下的插件**无法 import 应用的 schemastery**（实测，在运行中的应用里也是 `ERR_MODULE_NOT_FOUND`）。所以把这两个模块内置，只改了一处 import 路径。

唯一的改动：`schemastery.mjs` 里 `from "@deepseek-ai/cosmokit"` → `from "./cosmokit.mjs"`。
