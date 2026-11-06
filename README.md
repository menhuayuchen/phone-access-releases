# 轻器 · 轻屏（LightScreen）

一个人做的 Windows 远程桌面：手机浏览器打开就能看电脑屏幕、点鼠标、打字、听声音、传大文件。

- **不用装 App**：手机端是浏览器页面，可"添加到主屏幕"当 App 用
- **不经过厂商服务器**：画面走自己的加密网（Tailscale 点对点 / 自有中继）
- **完全免费**：没有专业版、没有体验期、不要账号、无广告

> 这个仓库里同时放着「轻器」产品站（`site/`）与「轻屏」客户端（`app/`）。

## 目录

| 目录 | 内容 |
|---|---|
| `app/` | 客户端源码：`screen-server.mjs`（Node 服务）+ `page.mjs`（手机页）+ `input.cs`/`capture.cs`/`audio.cs`（Windows 端小工具） |
| `site/` | 产品站：`index.html` 轻器首页 · `light-screen/` 轻屏产品页 · `about/` 作者与授权 |
| `dist/` | 本地构建出来的安装包（不入库） |
| `sfx/` `release-tools/` | 打包与发布脚本 |

## 授权（重要）

本项目采用 **PolyForm Noncommercial License 1.0.0**（见 [LICENSE](LICENSE)）：

- ✅ 自己使用、修改源码、分享给别人（保留作者信息与本协议）
- ✅ 基于它做自己的版本（非商业）
- ❌ **未经作者书面同意，不得用于任何商业用途**（内部商业化部署、销售、收费服务、打包进商业产品等）
- ❌ 不得去掉作者信息后当作原创发布

需要商用授权或定制：见 <https://menhuayuchen.github.io/phone-access-releases/about/>

> 这不是 OSI 开源协议：源码可见、可改，但商业用途受限。

## 本地构建（Windows）

```powershell
cd app
powershell -ExecutionPolicy Bypass -File pack.ps1 -Zip -Version 1.0.17
cd ..
powershell -ExecutionPolicy Bypass -File sfx\build-sfx.ps1 `
  -DistRoot (Join-Path (Get-Location) 'dist') `
  -OutFile (Join-Path (Get-Location) 'dist\LightScreen-Setup-v1.0.17.exe')
```

说明：`app/*.ps1` 必须保留 UTF-8 BOM；`.mjs` / `.json` / `.cmd` 不能带 BOM（`pack.ps1` 会校验）。
