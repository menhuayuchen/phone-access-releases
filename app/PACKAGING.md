# PACKAGING.md — 产品打包清单（交付前逐项打勾）

> 对象：`phone-access-product\app\`（从生产目录 `phone-access\` 复制出来的参数化副本）
> 目的：把「一个能跑的安装目录」做成「一个能卖的产品包」。当前副本**缺运行必需的二进制与素材**（复制时没带过来），
> 不补齐的话 `start-screen.ps1` 会在 `capture.exe missing` 处直接抛错，二维码功能也不可用。
> 基准机：`LAPTOP-0FIMMV7J`（Windows 11 / PowerShell 5.1 / node v24.21.0），实测日期 2026-10-28。
> 生产目录只读：**本文所有文件都从生产目录“拷进”产品包，绝不修改生产目录**。

---

## 0. 一句话

**补齐二进制 + 锁死 node/wrtc + 剔除密钥和开发垃圾 + 打完包立刻跑 `自检.ps1`。**
四件事任何一件漏了，客户机上都会表现为「装了但用不了」或「密钥泄漏」。

---

## 1. 必须补进产品包的运行时文件

从生产目录 `phone-access\` 拷到产品包 `app\`，保持相对路径不变。缺任意一项都有明确故障。

### 1.1 必需（缺了核心功能直接坏）

| 文件 | 体积（实测） | 缺了会怎样 | 依据 |
|---|---|---|---|
| `capture.exe` | 21,504 B | 抓屏循环起不来 → 手机黑屏；`start-screen.ps1` 直接 throw `capture.exe missing` | `start-screen.ps1:129-135` |
| `capture.exe.bak` | 18,432 B | Defender 隔离 `capture.exe` 后无法自愈（脚本会把 `.bak` 拷回去） | `start-screen.ps1:131-134` |
| `input.exe` | 17,920 B | 手机能看不能点（鼠标键盘注入器） | `start-screen.ps1:96-117` |
| `audio.exe` | 17,920 B | 手机上没有电脑声音（画面/操作不受影响） | `start-screen.ps1:85-92` |
| `sources.exe` | 7,168 B | 页面「指定窗口」列表为空（`/sources` 接口失败） | `screen-server.mjs:680` |
| `lib\NAudio.Core.dll` | 187,904 B | **声音转发依赖**：`audio.exe` 启动时显式加载这三个 DLL，缺了直接起不来（不只是没声音） | `audio.cs` 头部：`/r:lib\NAudio.*.dll`、显式 AssemblyResolve |
| `lib\NAudio.Wasapi.dll` | 179,200 B | 同上 | 同上 |
| `lib\NAudio.WinMM.dll` | 57,344 B | 同上 | 同上 |
| `make-qr.py` | 864 B | 二维码不生成（网址 txt 仍会写，属降级不阻断） | `start-screen.ps1:170-184` |
| `decode-qr.py` | 451 B | 主链路不用（只在 README 的排障流程里提到）。想保留「截图解码二维码」的客服能力就带上，不带也能正常交付 | `README.md:474` |
| `qrlib\`（118 个文件） | 2,466,976 B | `make-qr.py` / `decode-qr.py` 报 `ModuleNotFoundError`（qrcode / zxingcpp / colorama 都在这里，脚本会把 `qrlib` 加进 `sys.path`） | `make-qr.py:5-10`、`decode-qr.py:5-9` |
| `icon-192.png` | 969 B | 手机「添加到主屏」没有图标；`/manifest.json` 里两条 icon 指向它 | `screen-server.mjs:740-747` |
| `icon-512.png` | 3,380 B | 同上 | 同上 |
| `runtime\node.exe` | 89.2 MB | 客户机没装 node 就起不来画面服务；**且必须与打包时同一份**（见第 3 节 ABI） | `product-config.ps1` 第 2 顺位自动发现 |
| `node_modules\`（整目录） | 35.1 MB / 192 文件 | 画面服务、WebRTC、sharp 全部起不来 | `package.json` |
| `package.json` + `pnpm-lock.yaml` | 131 B + 13,720 B | 版本无法复现；后续无法判断现场到底装的哪版 | — |

### 1.2 可选 / 按档位带（体积大，避免基础档客户白下载）

| 文件 | 体积 | 什么时候必须带 | 说明 |
|---|---|---|---|
| `bin\cloudflared.exe` | **55 MB**（本机 2026.10.3） | **仅标准档 / 常驻档**的「临时支持窗口」 | `start-remote.ps1:6,33` 用它开临时隧道；基础档不提供远程支持，可不带。**单独做一个附加包**，不要塞进基础档 |
| `bin\tailscale-setup.exe` | 1.4 MB | 现场帮客户装 Tailscale 时 | 可选；客户自己从官网装也行 |
| `runtime\python.exe`（+ 其运行库） | 体积取决于 python 发行版（通常几十 MB） | 想让客户机「一定能出二维码」时 | 不带 python 不会阻断主链路：网址照写、二维码不生成（`start-screen.ps1:174-179` 已降级）。带的话 `qrlib\` 必须一起带 |

> 结论：**基础档安装包 ≈ 129 MB**（app 代码 + 二进制 + 素材 + node_modules 35.1 MB + node.exe 89.2 MB）；
> **标准档再 +55 MB cloudflared ≈ 184 MB**。两个包分开出，别让基础档客户下 55 MB 用不到的东西。

### 1.3 拷贝注意（pnpm 的 junction 坑）

本机 `node_modules\` 是 **pnpm 的链接结构**（`node_modules\@roamhq\wrtc` 是 Junction，真实文件在
`.pnpm\@roamhq+wrtc@0.10.0\...`，原生库 `wrtc.node` 15.5 MB 在 `.pnpm\@roamhq+wrtc-win32-x64@0.10.0\...`）。
用资源管理器复制一般会跟随 junction，但压缩包 / 部分脚本会把它当链接存，到客户机就成断链。
**推荐两种做法，选一个**：

1. 打包前把 `node_modules` 做成扁平结构：`app\.npmrc` 里写 `node-linker=hoisted`，用同一份 `pnpm-lock.yaml`
   重装一次 `pnpm install --prod --frozen-lockfile`，然后整个目录拷走（最稳）。
2. 或者用 `pnpm deploy --prod --frozen-lockfile <目标目录>` 生成自包含目录，再压缩。

打完包必须验证（见第 4 节）：`Test-Path .\node_modules\@roamhq\wrtc\package.json` 为真，且原生库
`*.node` 能加载（自检的「流畅模式」就是测这个）。

---

## 2. 必须剔除的文件（**不能随包发**）

### 2.1 凭据与密钥（最高优先级：客户会转发、会截图）

**实测：生产系统的 `screen.key`（16 字符 = 64 bit，2026-10-22 生成、从未轮换）明文出现在 11 个文件共 16161 处**，
其中 `autostart.log` 8657 处、`supervisor.log` 7286 处、`door.log` 202 处；`手机远程入口速查.pdf` 4 处、
`手机入口速查.md` 4 处、`README.md` 1 处、3 个 `*url.txt`、`make_doc.py` 1 处。**这不是理论风险，是已发生的泄漏。**

必须剔除：

| 文件 / 目录 | 为什么 |
|---|---|
| `screen.key` | 登录密钥本体（16 字符 = **64 bit，太短**）。客户机首次启动会自动生成 **32 字符（128 bit）** 新密钥（`start-screen.ps1:59-64`）；**绝不沿用生产密钥** |
| `screen-url.txt` / `screen-url-lan.txt` / `tailip-url.txt` / `lan-url.txt` / `login-url.txt` / `phone-url.txt` | 全是带 `?k=`（有时带 `?token=`）的完整入口地址 |
| 所有二维码图片：`phone-qr.png`、`qr-login.png`、`qr-tailip.png`、`screen-qr.png`、`screen-qr-lan.png`、`tailnet-qr.png` | 二维码里就是带密钥的 URL，扫一下即得密钥 |
| `手机入口速查.md`、`手机远程入口速查.pdf`、`build-doc\`、`make_doc.py` | 文档里明文带 key / 内网 IP（PDF 天生适合转发，最危险） |
| `README.md`（生产版） | 生产版里含密钥与 10 处本机 tailnet IP/域名；产品包需要一份**重写的、不含任何密钥**的 README |
| 所有 `*.log`（`autostart.log`、`supervisor.log`、`input.log`、`door.log`、`screen-server.log`、`screen-capture.log`、`screen-auth.log`、`web-lan.log`、`proxy*.log*`、`tunnel.log`、`cf-tunnel.log`、`run.log`、`tailscale-up.log`、`plugin-sync.log`、`pipe-diag.log`、`*-test.log` 等） | 日志里有密钥、内网 IP、窗口标题、访问记录；而且客户看到一堆历史日志只会更慌 |
| `node-path.txt` | 生产机的绝对路径。应改成 `runtime\node.exe`（自检/启动脚本都会自动发现），或安装器重写 |
| `升级/测试残留`：`upgrade-rc3.ps1`、`upgrade-rc3.result.txt`、`upgrade-rc3.log` | 内部升级脚本，与产品无关 |

### 2.2 开发 / 诊断文件（客户用不到，增加误报与支持成本）

| 类别 | 具体文件 |
|---|---|
| 语法/自检脚本（开发用） | `syntax-check.ps1` |
| 测试脚本 | `focus-test.ps1`、`elevated-inject-test.ps1`、`input-test.mjs`、`test-unblock.mjs`、`pipe-bench.mjs` |
| 诊断源码与产物 | `cursor-test.cs` / `.exe` / `.log`、`cursor-probe.cs`、`input-diag.cs` / `input-diag2.cs` / `input-diag3.cs` 及对应 `.exe` / `.log`、`win-scan.ps1`、`diagnostics\`、`pipe-diag.log` |
| C# 源码 | `capture.cs`、`input.cs`、`audio.cs`、`sources.cs`、`capture-sources.inc`（产品只发编译好的 exe；源码留在内部仓库。需要现场重编译时再单独给） |
| 备份 / 缓存 | `tunnel-proxy.mjs.bak-20261025-2030`、`plugin-sync-backup\`、`.dsh-memory\` |
| 运行时状态（不要随包） | `capture.mode`、`capture.interval`、`viewers.count`、`supervisor.heartbeat`、`supervisor.lock`、`plugin-sync.stamp`、`screen-latest.jpg`、`maintenance.flag`、`phone-qr-*.png` |

> 判定口径：**除了第 1 节列出的文件，`app\` 里多出来的东西一律默认不带**。
> 交付目录最后应该只剩「代码 + 二进制 + 素材 + node 运行时 + node_modules + 文档」这几类。

### 2.3 交付前的密钥动作（必做）

1. **绝不把生产机的 `screen.key` 打进包。** 客户机首次启动时 `start-screen.ps1` 会自动生成 32 位十六进制新密钥；
   如果产品是"解压即用"而不是走启动脚本，安装器必须显式生成一个 32 位随机密钥。
2. **生产机的旧密钥已经随日志泄漏**（16 字符、64 bit、从未轮换）。这轮交付前建议在**用户同意的前提下**，
   在生产机跑一次 `rotate-key.ps1 -Force` 轮换密钥（会让已有手机书签/二维码失效，需重新扫码）。
   注意：这是对用户生产系统的改动，**必须用户点头才能做**，不在本次自检改造范围内。
3. 打完后跑第 4 节的「密钥扫描」，命中 `?k=` / `?token=` 就重新打。

---

## 3. 必须锁死的版本约束（**ABI 绑死，换一个 node 就黑屏**）

### 3.1 @roamhq/wrtc 是原生模块，ABI 绑 node 版本

实测本机（能正常出画面）：

| 组件 | 版本 / 实测值 |
|---|---|
| node | **v24.21.0**（生产机通过 `node-path.txt` 指定，绝对路径） |
| `@roamhq/wrtc` | **0.10.0**（pnpm 解析后） |
| `@roamhq/wrtc-win32-x64` | **0.10.0**，原生库 `wrtc.node` = 15,567,872 B |
| `sharp` | **0.35.5**，原生库 `@img/sharp-win32-x64\lib\sharp-win32-x64-0.35.5.node` = 443,904 B |
| `ws` | **8.22.0** |

**规则（任一条破了，客户机「流畅」模式就黑屏/加载失败）：**

1. 产品包里的 `runtime\node.exe` **必须就是打包时用来验证 wrtc 的那一份**（本机 v24.21.0）。不要用客户机上
   已有的 node，也不要让安装器"帮你找一个 node"。
2. **禁止**在客户机上跑 `npm install` / `pnpm install` / `npm update`。`node_modules` 必须随包发。
3. **禁止**替换/升级 `runtime\node.exe`：DSH 自带运行时的 node、NVM 切版本、系统装的新 node 都不行——
   ABI 对不上时报错在 `require('@roamhq/wrtc')`，页面表现是切「流畅」后黑屏，不是报错弹窗。
4. `sharp` 同理（也是原生模块 + prebuilt），`ws` 纯 JS 不敏感，但仍按锁文件版本走。
5. 验收必须**真的切一次「流畅」模式**看图（见 4.2），静态检查证明不了 ABI。

### 3.2 其他编码 / 语法约束

- 所有 `.ps1`：**UTF-8 带 BOM**（PowerShell 5.1 读无 BOM 的中文 .ps1 会直接语法报错，本次已实测踩到）。
- 所有 `.mjs` / `product.config.json`：**UTF-8 无 BOM**（Node 的 `JSON.parse` 把 BOM 当非法字符）。
- 目标环境是 **Windows PowerShell 5.1**，不是 PowerShell 7：不要引入 `??`、`?.`、`-Parallel`、三元运算符等 PS7 语法。
- 执行策略：本机实测 `Restricted`，所以**只能通过 `.cmd` 包装启动 .ps1**（`-ExecutionPolicy Bypass`）。

---

## 4. 打包后第一步：先跑自检（必做，缺一步都不算打完）

### 4.1 必须先补一个包装层（当前包内还没有）

`自检.ps1` 已随包，但 PS 5.1 的默认执行策略会拦双击 .ps1。**打包时必须加**（属于打包产物，不在本次三文件写范围内）：

`app\自检.cmd`：

```bat
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0自检.ps1"
if errorlevel 1 pause
```

再加桌面快捷方式「自查」指向它（`交付说明.md` 第七节承诺的就是这个图标）。

### 4.2 打完包在**本机（或干净验证机）**按顺序做

```powershell
# ① 文件齐不齐（缺哪个一眼看到）
$pkg = 'D:\download\办共\phone-access-product\app'
$need = @(
  'capture.exe','capture.exe.bak','input.exe','audio.exe','sources.exe',
  'make-qr.py','decode-qr.py','icon-192.png','icon-512.png',
  'lib\NAudio.Core.dll','lib\NAudio.Wasapi.dll','lib\NAudio.WinMM.dll',
  'product-config.ps1','product.config.json','自检.ps1','自检.cmd',
  'package.json','pnpm-lock.yaml',
  'runtime\node.exe',
  'node_modules\ws\package.json','node_modules\sharp\package.json','node_modules\@roamhq\wrtc\package.json'
)
$missing = @($need | Where-Object { -not (Test-Path -LiteralPath (Join-Path $pkg $_)) })
if ($missing.Count -eq 0) { '文件齐全' } else { '缺: ' + ($missing -join ', ') }

# ② 不许出现的文件（凭据 / 日志 / 二维码 / 开发脚本）
$forbid = @(
  'screen.key','screen-url.txt','screen-url-lan.txt','tailip-url.txt','lan-url.txt',
  'login-url.txt','phone-url.txt','phone-qr.png','qr-login.png','qr-tailip.png','screen-qr.png',
  '手机入口速查.md','手机远程入口速查.pdf','README.md','make_doc.py',
  'upgrade-rc3.ps1','syntax-check.ps1','focus-test.ps1','elevated-inject-test.ps1',
  'cursor-test.cs','cursor-probe.cs','win-scan.ps1','node-path.txt'
)
foreach ($f in $forbid) { if (Test-Path -LiteralPath (Join-Path $pkg $f)) { "不该有: $f" } }
Get-ChildItem -LiteralPath $pkg -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.log','.err','.out' -or ($_.Name -like '*.bak*' -and $_.Name -ne 'capture.exe.bak') } |
  ForEach-Object { "不该有: $($_.FullName)" }

# ③ 密钥扫描：只看会随包发出去的数据/文档类型（产品代码里的 ?k= 是拼 URL 的代码，不算泄漏）。
#    只打印「文件:行号」，不打印命中的内容——别把密钥又抄进聊天窗口。
#    注意：这里不能用 -Include（和 -LiteralPath 一起用时它不生效，会把 .ps1/.mjs 代码也算进来）。
Get-ChildItem -LiteralPath $pkg -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.txt','.log','.json','.md' -and $_.Name -ne 'PACKAGING.md' } |
  Select-String -Pattern 'k=[0-9a-fA-F]{16,}|token=' |
  ForEach-Object { '疑似凭据: ' + $_.Path + ':' + $_.LineNumber }

# ④ 跑客户版自检（-NoReport 只为快速验证；正式验收用默认，报告会存到桌面）
powershell -NoProfile -ExecutionPolicy Bypass -File "$pkg\自检.ps1" -Quiet -ReportPath "$env:TEMP\pack-verify.txt"
```

**通过标准（自检输出）：**

| 项 | 期望 |
|---|---|
| 顶部结论 | 🟢 正常（电池睡眠、第三方杀毒这类环境项允许 🟡 注意 / 小提示） |
| 系统 / 私有网络 / 画面服务 / 屏幕读取 / 手机连进来的通道 | 全绿 |
| **流畅模式（画面更顺）** | **必须绿**（这是 node+wrtc ABI 唯一有效的验收；黄了就是第 3 节的版本没锁住） |
| **手机上的入口** | **必须绿**（证明新密钥已生成、地址与当前 tailnet IP 一致） |
| 自动恢复程序 | 绿（心跳存在） |
| 控制台与报告内容 | 不出现 `?k=`、`token`、完整 URL。自检只从 `screen-url.txt` 取**主机名**做一致性比对，不打印文件内容；报告里的「登录密钥文件 / 手机网址文件」只写「已生成（内容不打印）」 |

再用工程师工具复核一遍（应全 ok）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$pkg\check-health.ps1" -Quiet
```

### 4.3 真机手机验收（打包机自检过了也必做）

1. 手机扫码 → 出画面；
2. 手机上点一下 → 光标动（证明 `input.exe` + 高权限注入）；
3. 手机里切「流畅」→ 画面正常、不是黑屏（证明 `wrtc` ABI）；
4. 手机里能听到电脑声音（证明 `audio.exe` + `lib\NAudio.*.dll`）；
5. **重启电脑 → 有人登录 → 2 分钟内手机重新连上**（证明计划任务 + `supervise.ps1` + 密钥持久）。

---

## 5. 打完包的目标目录树（参考）

```
app\
├─ start-phone-access.cmd          启动入口（.cmd 包 .ps1）
├─ start-screen.cmd                只启画面子系统
├─ stop-phone-access.cmd           停止
├─ 自检.cmd                        ← 打包时新增（给客户双击）
├─ 自检.ps1                        ← 客户版自检（注册表式，只读）
├─ check-health.ps1                工程师体检（参数化后）
├─ product.config.json             唯一配置源
├─ product-config.ps1              配置/运行时/端口 自动发现（被 3 个脚本点源）
├─ *.ps1 / *.mjs / *.cmd           业务代码（不含 *-test / 诊断 / upgrade）
├─ capture.exe / capture.exe.bak / input.exe / audio.exe / sources.exe
├─ make-qr.py / decode-qr.py / qrlib\
├─ icon-192.png / icon-512.png
├─ lib\NAudio.Core.dll / NAudio.Wasapi.dll / NAudio.WinMM.dll
├─ package.json / pnpm-lock.yaml
├─ node_modules\                   扁平化后整目录（ws / sharp / @roamhq/wrtc）
├─ runtime\node.exe                与打包验证时同一份 v24.21.0
├─ bin\cloudflared.exe             ★仅标准档/常驻档附加包
├─ PACKAGING.md                    本清单（随包）
├─（产品根目录另外放：交付说明.md、docs\环境矩阵.md —— 别放进 app\）
└─（运行时自动生成：screen.key、screen-url*.txt、*.log、supervisor.heartbeat …）
```

---

## 6. 已知遗留（不在本次三文件范围内，打包时要么按上面处理、要么单独排期）

1. `show-qr.ps1` / `stop-phone-access.ps1` / `start-remote.ps1` 里仍有本机绝对路径和写死端口
   （见 `PARAMETERIZATION.md` §9 遗留 1–2）。基础档主链路不依赖它们；标准档用到 `start-remote.ps1`
   时，**要么先参数化，要么别把它放进包**。
2. `autostart.ps1` 只认 `WLAN|Wi-Fi` 网卡别名，有线网卡机器上拿不到局域网 IP（主链路走 tailnet 不受影响）。
3. 8780 录屏模块不在本目录（`D:\dsh-rec\record-server.js`），配置里只留了 `ports.record` 占位。
4. `README.md` 生产版含密钥与内网地址，产品包要**重写一份**（不含任何密钥 / IP / 域名）。
5. `pylib\` 在本机看起来是 `qrlib\` 的另一份/链接（列出的包名完全相同），而且访问受限（读目录会报
   Access denied）。随包只需要 `qrlib\`，**不要**原样拷 `pylib\`（容易拷成断链或拷出运行时依赖）。

---

*本文档由 selfcheck-builder 随「客户版自检」一起交付；体积与泄漏处数为 2026-10-28 在本机实测。*
