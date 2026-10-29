# 参数化改造说明（P0-1 ~ P0-4）

> 改造对象：`D:\download\办共\phone-access-product\app\`（生产系统 `C:\Users\ccj\Documents\deepseek-harness\default-workspace\phone-access\` 的副本）
> 改造日期：2026-10-28
> 生产目录状态：**只读，一个字节都没改**（用文件哈希逐文件对比过：生产目录与副本之间，内容不同的只有下面第 3 节列出的这些文件，且都是副本侧被改）
> 目标读者：接手这次改造的人 / 下一棒做安装器与自检的人

---

## 0. 一句话结论

四个 P0 全部消除：tailnet IP、四个绝对路径、分辨率常量链、端口三元组 + `tailscale serve :80` 都不再写死在源码里。
现在把 `app\` 整个目录拷到另一台满足硬门槛的机器上，**只改 `product.config.json` 里的端口就能跑**，不需要改任何源码。

代价（诚实说）：为了让"行为与原来完全一致"，我**没有**顺手重构、没有删除死代码、没有动 `page.mjs`。所以本文第 9 节列了 14 条遗留点——其中 6 条是"客户机上仍会失效但不在本次 P0 范围"的（主要是自检/运维脚本里的同类硬编码），必须有人接着做。

---

## 1. 配置源：`app/product.config.json`

这是**唯一**配置源。`.ps1` 用 `ConvertFrom-Json` 读，`.mjs` 用 `JSON.parse` 读（同一个文件，两边逻辑一致）。

| 字段 | 默认值 | 含义 | 运行时会读它的地方 |
|---|---|---|---|
| `ports.door` | 8650 | tailnet 名字门（`tunnel-proxy`，方案乙才用） | `start-phone-access.ps1`、`supervise.ps1`、`tunnel-proxy.mjs` 默认值 |
| `ports.screen` | 8660 | **画面服务**（方案甲的唯一入口） | `start-screen.ps1`、`supervise.ps1`、`screen-server.mjs` 默认值 |
| `ports.record` | 8780 | 录屏模块（**本目录外**，暂无代码。预留给安装器/自检） | 无（仅配置位） |
| `ports.dsh` | 8642 | DSH 网页（可选模块） | `start-phone-access.ps1`、`supervise.ps1`、`tunnel-proxy.mjs` 默认值 |
| `tailnetServePort` | 80 | `tailscale serve --http=<这个>` 对外发布的端口 | `start-phone-access.ps1` |
| `enableDsh` | `false` | **方案甲=false**（只交付屏幕+触控）；`true`=方案乙（额外启动 DSH 对话控制台与它的三扇门） | `start-phone-access.ps1`、`supervise.ps1` |
| `installDir` | `%LOCALAPPDATA%\PhoneAccess` | 安装目录（**当前运行时链路不读它**，留给安装器用；会展开环境变量） | 无（安装器预留） |
| `runtime.nodePath` | `""` | 空=自动发现；填了=只用这个路径 | `start-screen.ps1`、`start-phone-access.ps1`、`supervise.ps1` |
| `runtime.pythonPath` | `""` | 同上（只用于画二维码，找不到只降级不阻断） | 同上 |
| `runtime.tailscalePath` | `""` | 同上 | 同上 |
| `runtime.dshPath` | `""` | 同上（`enableDsh=true` 时才需要） | `start-phone-access.ps1` |
| `screen.captureWidth` | `0` | 0=按主显示器物理分辨率自动推导 | `start-screen.ps1`、`screen-server.mjs` |
| `screen.captureHeight` | `0` | 同上 | 同上 |
| `screen.rtcWidth` | `0` | 0=取抓屏宽的一半（2560→1280，与改造前一致） | `screen-server.mjs` |
| `screen.maxCaptureWidth` | 2560 | 抓屏宽度上限（0=不限制）。4K 屏仍抓 2560 宽，避免带宽翻倍 | `start-screen.ps1`、`screen-server.mjs` |

**容错规则（已实测）**：

- 文件不存在 → 内置默认值继续跑，打印一行 `[!] 配置提示：...`，**不崩**
- JSON 写坏 → 同上
- 字段缺失 → 该项用默认值
- 类型写错（端口写成字符串 `"18080"`、开关写成字符串 `"false"`）→ 正确转换（`"false"` 不会被当成 True）

**典型改法**：客户机 8660 被占用，只把 `ports.screen` 改成 `8661` 即可。启动时如果发现 8661 也被占，程序会直接告诉你"谁占的、改成多少好"。

---

## 2. 四个 P0 各自怎么解的

### P0-1：`supervise.ps1:9` 的 tailnet IP（`100.108.92.22`）

**原来**：写死。守护拿它去 `curl http://<ip>:8660/health` 判断帧新鲜度与注入器是否卡死。换机后 curl 必然失败，而失败是**静默**的——退回去看 `screen-latest.jpg` 的 mtime，可管道模式下 `capture.exe` 根本不写这个文件（`capture.cs:509-520` 只在无管道客户端时才写）。结果：画面卡死、注入器卡死这两类最重要的自愈全部失效。

**现在**：
- `supervise.ps1` 顶部用 `Resolve-ProductRuntime` 找 `tailscale.exe`，再 `Get-TailscaleInfo` 取 IP；顺序是 **`tailscale ip -4` → 失败再从 `status --json` 的 `Self.TailscaleIPs` 补 → 都失败才退回 `127.0.0.1`**。
- 不写进配置文件让客户填（按任务要求）。
- 启动时把结果写进 `supervisor.log`（成功：`tailnet ip discovered: 100.x.y.z; ...`；失败：`[warn] tailnet ip 没取到…`）。
- 运行中如果 `/health` 探测连续打不通，每 30 轮（≈4 分钟）在日志里告警一次：`[warn] /health 探测不通（第 N 轮）…`——把"守护的眼睛没接上"从静默变成可见。

本机实测：`tailscale ip -4` → `100.108.92.22`，与原来写死的值一致，行为不变。

### P0-2：`start-phone-access.ps1:4-7` 四个绝对路径

| 原来（写死） | 现在 |
|---|---|
| `D:\deepseek\resources\runtime\cli\bin\dsh.cmd` | 仅在 `enableDsh=true` 时查找：`runtime.dshPath` → `runtime\dsh.cmd` → PATH → 找不到就**明确报错**并提示"方案甲请把 enableDsh 改 false" |
| `C:\Users\ccj\.dsh\...\node.exe` | 自动发现：`runtime.nodePath` → `runtime\` 自带目录 → `node-path.txt`（老约定）→ PATH；找不到给中文三步指引后 `exit 1` |
| `C:\Users\ccj\.dsh\...\python.exe` | 自动发现：`runtime.pythonPath` → `runtime\` → PATH；**找不到只降级**（网址照写、二维码不生成），不阻断启动 |
| `C:\Program Files\Tailscale\tailscale.exe` | 自动发现：`runtime.tailscalePath` → `runtime\` → PATH → 官方默认安装目录（`%ProgramFiles%\Tailscale` 等）；找不到只影响 tailnet 入口，局域网仍可用 |
| （额外）`run-autostart.vbs:5` 写死 `C:\Users\ccj\Documents\...\autostart.ps1` | 改成用 `WScript.ScriptFullName` 的父目录推导（**超出四个 P0 的一条**，见第 3 节说明） |

**方案甲开关**：`enableDsh=false`（默认）时，`start-phone-access.ps1` 完全不启动 DSH、不启动三扇门代理、不发布 `tailscale serve`、不去 `web-lan.log` 里找 token；`supervise.ps1` 也完全跳过 DSH 的存活/内存/HTTP 探活与插件同步（否则守护会每十几秒去重启一个"本来就不该存在"的 DSH，日志被刷满）。

本机实测查找结果：node→`node-path.txt`、python→PATH、tailscale→PATH、dsh→PATH。**与改造前实际使用的可执行文件完全相同**。

### P0-3：分辨率常量链 `2560 / 1280`

**原来**：`start-screen.ps1:104`（抓屏宽）、`screen-server.mjs:195/256/779/814`（满宽判断、publishViewers 强制回写、`/frame.jpg` 与 `/stream` 的 `?w=` 上限）、`decode.mjs:6`（RTC 宽）、`rtc.mjs:21`（预置帧 1280×800）。
另外**盘点文档漏了一处**：`screen-server.mjs` 的 `/rtc-off` 里 `sourceState.width = 2560`（会白白触发一次抓屏管线重启）。这次一并纳入。

**现在（正常路径全自动）**：

```
抓屏几何 Get-CaptureGeometry()
  1) product.config.json 的 screen.captureWidth/Height 非 0 → 用它
  2) 否则读主显示器物理像素（先声明 DPI 感知；不声明时 150% 缩放下会读成 1707×1067 —— 环境矩阵 §5.3 记录的那个坑）
  3) 再不行退回 WMI 的 Win32_VideoController（物理像素）
  4) 都失败才用 2560×1600（唯一保留的写死默认值，只作兜底）
  最后按 maxCaptureWidth(默认 2560) 截断宽度，高度按同比例缩放
```

传法：`start-screen.ps1` 把结果作为 `capture.exe` 的第 2 个位置参数，并作为 `screen-server.mjs` 的**第 6 个位置参数**（新增、可选，格式 `宽x高`）。服务端据此算：

- `CAP_W`：`publishViewers()` 写入 `capture.mode` 的宽度、`encodeStream` 的"满宽透传"判据、`/stream` 与 `/frame.jpg` 的 `?w=` 上限、`/rtc-off` 写回的宽度
- `RTC_W = even(round(CAP_W / 2))`，`RTC_H = even(round(RTC_W × CAP_H / CAP_W))`：`decode.mjs` 的缩放宽度与 `rtc.mjs` 的预置帧尺寸（两者必须一致，否则 libwebrtc 建轨时锁的尺寸与喂帧尺寸不符 → 黑屏/拉伸）
- 旧调用方式（只传 5 个参数）仍然按 2560×1600 工作，向后兼容。

**实测的推导结果**（脚本静态验算，非运行）：

| 机器/配置 | 抓屏 | 流畅模式(RTC) |
|---|---|---|
| 本机 2560×1600（DPI 150%） | 2560×1600 | 1280×800（**与改造前完全一致**） |
| 1920×1080 | 1920×1080 | 960×540 |
| 3840×2160（受 maxCaptureWidth=2560 限制） | 2560×1440 | 1280×720 |
| 1366×768（奇数宽） | 1366×768 | 682×382（取偶，I420 要求） |

### P0-4：端口三元组 `8642/8650/8660` + `tailscale serve :80`

- **可配置**：全部走 `product.config.json`（见第 1 节）。`.ps1` 与 `.mjs` 的默认值同源。
- **启动时检测冲突，冲突就明确提示**（不静默）：
  - 画面端口：`start-screen.ps1` 启动最前面检测。被别的程序占用 → 打印
    `[x] 端口 8660 已被其它程序占用（chrome.exe（pid=1234），监听 0.0.0.0；命令行：…）。请修改 product.config.json 里的 ports.screen（例如改成 8661），然后重新运行。` → `exit 1`
  - DSH 门端口 / DSH 端口：仅在 `enableDsh=true` 时检测，逻辑同上（`ports.door` / `ports.dsh`）
  - **"自家进程"不算冲突**：用命令行特征（`screen-server\.mjs` / `tunnel-proxy\.mjs` / `--profile web`）区分。因为计划任务每 2 分钟重跑一次，"已经在自己监听"必须视为正常幂等。
  - 建议端口由程序算出来（沿端口往后找第一个空闲的），不让客户自己翻端口表。
- **`tailscale serve` 端口可配**（`tailnetServePort`，默认 80）；发布前先看 `tailscale serve status`，如果 tailnet 里已有别的 serve 配置且不是指向我们的门，会先把现有配置打印出来再覆盖（不静默覆盖别人的配置）。
- **8642 属 DSH 可选模块**：`enableDsh=false` 时 `start-phone-access.ps1` 根本不启动它，`supervise.ps1` 也不守护它。

---

## 3. 改了哪些文件

**新增（2 个）**

| 文件 | 作用 |
|---|---|
| `app/product.config.json` | 唯一配置源（第 1 节） |
| `app/product-config.ps1` | 配置读取 + 运行时自动发现 + 显示器物理分辨率 + 端口冲突检测。被 3 个 `.ps1` 点源引用；**只有函数定义，点源无副作用** |

**修改（8 个）**

| 文件 | 改动点（都留了 `改动（P0-x）` 中文注释） |
|---|---|
| `start-phone-access.ps1` | ① 四个绝对路径 → 自动发现（`node` 硬依赖、`python`/`tailscale` 可降级）；② `dsh.cmd` 与三扇门整体收进 `enableDsh` 开关；③ 端口/`serve` 端口读配置 + 冲突检测；④ `serve status` 覆盖前提示；⑤ 方案甲下不读 `web-lan.log` 的 token，改为打印画面入口 |
| `start-screen.ps1` | ① `node`/`python`/`tailscale` → 自动发现（含 `node-path.txt` 老约定）；② 画面端口读配置 + 启动前冲突检测（冲突 `exit 1`）；③ 抓屏宽度按主显示器物理分辨率推导，传给 `capture.exe` 和 `screen-server.mjs`（第 6 参数）；④ `python` 缺失时二维码降级而不是抛红字 |
| `supervise.ps1` | ① `$screenIp` → `tailscale ip -4` 自动发现（失败退回 127.0.0.1）并写入日志、探测失败告警；② 三个端口读配置；③ `enableDsh=false` 时跳过维护窗口/插件同步/DSH 判活/门判活/内存与 HTTP 探活（守卫式跳过，见遗留点 14） |
| `screen-server.mjs` | ① 读 `product.config.json`（`JSON.parse`）；② 启动参数解析上移，新增可选第 6 参数 `宽x高`；③ 四处写死 2560 → `CAP_W`；④ `/rtc-off` 的 2560 → `CAP_W`；⑤ 算 `RTC_W/RTC_H` 并传给 `createRtc(prime)` 与 `createDecoder(width)` |
| `decode.mjs` | `RTC_WIDTH = 1280` → `createDecoder({ width })`，不传仍默认 1280（向后兼容） |
| `rtc.mjs` | 预置帧写死 1280×800 → `createRtc({ prime })`，不传仍默认 1280×800 |
| `tunnel-proxy.mjs` | ① 默认端口 8650/8642 → 读配置（读不到同值兜底）；② 登录页提示文字里写死的 `http://100.108.92.22:8642/` → 中性占位 + 实际 DSH 端口（**盘点文档漏记的第 5、6 处 tailnet IP 硬编码**） |
| `run-autostart.vbs` | **超出四个 P0 的一条，请 lead 复核**：写死的 `C:\Users\ccj\Documents\...\autostart.ps1` → 用 `WScript.ScriptFullName` 的父目录推导。理由：这一行决定"计划任务每 2 分钟的自愈层"能否在客户机上跑；不修则换机后自愈层静默死掉，与四个 P0 属同一类静默失败。只改路径推导，无逻辑变化；已用临时目录 + 桩脚本实测（`wscript`/`cscript` 都能正确启动同目录的 `autostart.ps1`） |

**没有改的文件**（明确声明）：`page.mjs`、`capture.cs`/`input.cs`/`audio.cs`/`sources.cs`、`check-health.ps1`、`show-qr.ps1`、`stop-phone-access.ps1`、`start-remote.ps1`、`harden-firewall.ps1`、`install-elevated-input.ps1`、`sync-profile*.ps1`、`rotate-key.ps1`、`maintenance.ps1`、各诊断脚本、全部 `.md`。

> 为什么不改 `page.mjs`：页面里 `W_LADDER=[2560,1920]` 与省流量模式的 `?w=1280` 请求在非 2560 宽的机器上会被服务端按 `CAP_W` 夹住，抓屏宽度 ≤ 请求宽度时直接透传原图，行为正确。按"不改业务逻辑"的要求保留。

---

## 4. 运行时自动发现规则（`Resolve-ProductRuntime`）

| 顺序 | 位置 | 说明 |
|---|---|---|
| 1 | `product.config.json` 的 `runtime.<name>Path` | 填了就用填的（支持 `%ENV%` 展开、去引号）；路径不存在会继续找并打印已试过的位置 |
| 2 | 程序自带运行时目录 | `<app>\runtime\<name>.exe`、`<app>\runtime\<name>\<name>.exe`、`<app>\runtime\<name>\bin\<name>.exe`、`<app>\runtime\bin\<name>.exe`；`node` 另外认老约定 `<app>\node-path.txt` |
| 3 | PATH | `Get-Command <name>` |
| 4 | 常见安装位置 | 只对 `tailscale`：`%ProgramFiles%\Tailscale`、`%ProgramFiles(x86)%\Tailscale`、`%LOCALAPPDATA%\Tailscale`（官方默认目录，属自动发现而非写死本机路径） |
| 失败 | 中文提示 + `Tried` 列表 | node/dsh 直接 `exit 1`；python/tailscale 降级并告警 |

---

## 5. 端口冲突检测的行为约定

- 只认"别的程序"：命令行命中 `screen-server\.mjs` / `tunnel-proxy\.mjs` / `--profile web` 的视为自家，跳过（保证每 2 分钟幂等重跑）。
- 占用进程读不到（系统进程/更高完整性）时，提示里写"进程名读不到，可能是系统进程"，不假装知道。
- 画面端口冲突 → `exit 1`（没有画面服务 = 产品没有核心功能，必须停）。
- DSH/门端口冲突 → `exit 1`（仅 `enableDsh=true`）。
- 冲突提示同时给出建议端口（沿端口往后找第一个空闲）。

---

## 6. 方案甲 / 方案乙怎么切

| | 方案甲（默认） | 方案乙 |
|---|---|---|
| 配置 | `"enableDsh": false` | `"enableDsh": true` + `runtime.dshPath`（或 dsh 在 PATH） |
| 启动的进程 | `audio` / `input` / `capture` / `screen-server` / `supervise` | 上述 + DSH(8642) + 三扇 `tunnel-proxy` + `tailscale serve` |
| 手机入口 | `screen-url.txt` / `screen-url-lan.txt`（画面服务） | 增加 `phone-url.txt` / `login-url.txt` / 各种二维码 |
| 守护范围 | 只守画面子系统 | 全栈 |
| 客户需要 | 只要 Tailscale | 还要装 DSH、要有模型账号 |

切换只改配置，不改代码。

---

## 7. 静态检查结果（2026-10-28 20:27，全过）

副本不能运行（见第 8 节），所以验证手段就是任务指定的两项静态检查 + 我加的两项（编码、JSON）。**0 失败**。

```
PowerShell: 5.1.26100.9711
node: v24.21.0

=== 1) .mjs 语法检查：node --check ===
  [OK]   audio.mjs          [OK]   test-unblock.mjs
  [OK]   decode.mjs         [OK]   page.mjs
  [OK]   input.mjs          [OK]   pipe-bench.mjs
  [OK]   input-test.mjs     [OK]   rtc.mjs
  [OK]   screen-server.mjs  [OK]   tunnel-proxy.mjs
  合计: 10 个文件，失败 0 个

=== 2) .ps1 语法检查：[System.Management.Automation.Language.Parser]::ParseFile ===
  [OK] 全部 21 个 .ps1（含新增的 product-config.ps1）
  合计: 21 个文件，失败 0 个

=== 3) 编码检查（Windows PowerShell 5.1 的硬要求）===
  21 个 .ps1 全部 UTF-8 带 BOM（不带 BOM 时 PS 5.1 会把中文注释按 ANSI 读，直接语法报错——改造过程中实测踩到过）
  10 个 .mjs 与 product.config.json 全部无 BOM（Node 的 JSON.parse 会把 BOM 当非法字符）

=== 4) product.config.json 合法性 ===
  [OK] JSON 合法：ports.door=8650 ports.screen=8660 ports.record=8780 ports.dsh=8642
       enableDsh=False tailnetServePort=80 installDir=%LOCALAPPDATA%\PhoneAccess
       runtime.nodePath='' pythonPath='' tailscalePath=''
```

**除语法检查外，还做了这些只读的静态验证**（都不启动任何服务）：

1. 本机实跑 `product-config.ps1` 的读取/发现函数：node 命中 `node-path.txt`、python 命中 PATH、tailscale 命中 PATH、`tailscale ip -4` 得到 `100.108.92.22`、抓屏几何得到 `2560x1600 (dpi-aware-screen)`。
2. 端口冲突检测：对 8660（线上 `screen-server` 正在监听）→ 正确判定"无冲突（自家）"；对 8642 用不匹配的标记 → 正确报出 `DeepSeek Harness.exe (pid=7152)` 并建议 8643。
3. 配置缺失 / JSON 损坏 / 字段写成字符串 → 全部退回默认值且不抛异常（"不要崩"这条要求）。
4. 分辨率推导在 4 种屏幕尺寸下的取值（见 P0-3 的表）。
5. `run-autostart.vbs` 在临时目录 + 桩脚本下实测 `wscript`/`cscript` 都能正确找到同目录的 `autostart.ps1`。

---

## 8. 如果要做运行时验证：正确步骤

**为什么不能直接在副本上跑**：副本和线上系统会抢同一批资源——

- 端口 `8642/8650/8660` 已被线上占用（`Get-NetTCPConnection` 实测三条都在听）
- `capture.exe` / `input.exe` / `audio.exe` 是**命名管道服务端、单实例**（`dsh-screen-frames` / `dsh-input` / `dsh-audio`），第二个实例起不来或互相踢
- 两个 `supervise.ps1` 会抢 `supervisor.lock`，同时还有计划任务每 2 分钟在补进程

所以二选一：

### 方案 A（推荐）：在一台干净机器 / 虚拟机上验证

1. 目标机满足硬门槛（Win10 2004+/64 位、管理员、无域控/MDM、能连 `login.tailscale.com:443`、C 盘 ≥10GB、**有登录的桌面会话**）
2. 装 Tailscale 并用客户账号登录
3. 把 node 放进 `app\runtime\node.exe`（推荐，客户机不用装 node）；有特殊安装位置就在 `runtime.nodePath` 填
4. 把**完整**的 `app\` 拷过去（注意：仓库里的副本缺 exe 与素材，见遗留点 5）
5. 需要时改 `product.config.json` 的 `ports.*` / `tailnetServePort`
6. 双击 `start-phone-access.cmd`（前台看输出）；正式跑用计划任务 + `run-autostart.vbs`（隐藏窗口）
7. 看日志：`screen-server.log`、`supervisor.log`、`autostart.log`；`supervisor.log` 开头应能看到 `tailnet ip discovered: ...` 与 `enableDsh=false（方案甲）...`
8. 验收清单：
   - `screen-url.txt` 里的地址在手机上能出画面
   - 点一下屏幕，光标跟着动（注入通）
   - `/health`（本机自连免密钥）返回 `ok viewers=N ... input={"connected":true,...,"errors":0,"blocked":0}`
   - 把手机端切"流畅"，画面比例正常、不黑屏（验证 RTC 宽高自动推导）
   - 断开网络再恢复 / 杀掉 `capture.exe`，8~16 秒内自动恢复（验证守护仍在工作）
   - 重启电脑 → 有人登录 → 2 分钟内自愈（验证 `run-autostart.vbs` 路径推导）
9. 收尾：`check-health.ps1` 体检（注意它还有写死的 tailscale 路径，见遗留点 1）

### 方案 B：就在本机验（会短暂中断生产）

1. **先停生产**：在生产目录跑 `stop-phone-access.cmd`（它会先杀 supervisor，再杀代理/capture/screen-server 并关闭 `tailscale serve`）
2. 等 30 秒，确认：`Get-Process capture,input,audio` 为空；`Get-NetTCPConnection -State Listen -LocalPort 8660,8650,8642` 里没有我们的进程
3. 把副本配置改成**另一组端口**（如 `8661/8651/8643`、`tailnetServePort: 8080`），避免任何残留冲突
4. 在 `app\` 目录跑 `start-screen.cmd`（先只验画面子系统，不动 DSH）→ 看 `screen-server.log`
5. 验完：`app\` 侧杀掉 node/capture/input/audio，回到生产目录 `start-phone-access.cmd` 恢复
6. **注意**：`capture.exe` 单例是硬约束，第 2 步没清干净就会失败；恢复生产后手机入口 URL/二维码会刷新一次

---

## 9. 仍然需要人工确认的遗留点

> 分三类：**A. 同类硬编码但不在本次 P0 范围**、**B. 打包/交付缺口**、**C. 设计边界（改不了，只能写进交付说明）**。

| # | 类别 | 遗留点 | 影响 / 建议 |
|---|---|---|---|
| 1 | A | `check-health.ps1:8` 写死 `tailscale.exe` 路径；`:221` 写死 tailnet IP 做 `/go` 测试；多处写死 `8642/8650/8660` | 客户机上体检会误报/失效。建议下一任务照 `product-config.ps1` 同款改（本文件已经把函数写好，直接点源即可） |
| 2 | A | `show-qr.ps1`（`$py` 写死、`$port=8642` 写死）、`stop-phone-access.ps1`（`$ts` 写死、`--http=80` 写死、命令行里写死 `8642`）、`start-remote.ps1`（`$node`/`$py` 写死） | 手动运维/备用链路脚本，方案甲主链路不依赖；但换机后这些工具会失效 |
| 3 | A | `autostart.ps1:16-18` 只认网卡别名 `WLAN\|Wi-Fi`，拿不到 IP 就 `exit 1`（`start-phone-access.ps1` 的 `Get-LanIp` 有兜底，两处逻辑不一致） | 有线网卡/改过名的网卡会整条链不启动（架构盘点 §8-11）。属"业务逻辑"，本次按要求没动 |
| 4 | A | 文档里的 tailnet IP/域名：`README.md` 10 处、`手机入口速查.md` 10 处；`harden-firewall.ps1:22,74`、`rotate-key.ps1:51`、诊断脚本里也有 | 交付前必须替换成模板/占位符（文档级硬编码，代码运行时不受影响） |
| 5 | B | **副本 `app\` 里缺运行必需的二进制与素材**：`capture.exe`、`capture.exe.bak`、`input.exe`、`audio.exe`、`sources.exe`、`make-qr.py`、`decode-qr.py`、`qrlib\`、`icon-192.png`、`icon-512.png`、`lib\NAudio.*.dll` | 拷贝副本时没带过来（生产目录里才有）。**不补齐的话**：`start-screen.ps1` 会在 `capture.exe missing` 处抛错；二维码功能不可用。打包交付时必须补 |
| 6 | B | `node-path.txt` 里仍是本机绝对路径 `C:\Users\ccj\.dsh\...\node.exe` | 这是**安装产物**，不是源码。客户机上该路径不存在时自动跳过并继续找 PATH/自带运行时（已实测），但安装器应在安装时重写它，或干脆用 `runtime\node.exe` 而不写这个文件 |
| 7 | B | `screen.key` 没有随副本（这是好事，没有泄漏） | 客户机首次运行自动生成 32 位十六进制。交付前建议在生产机跑一次 `rotate-key.ps1 -Force` 轮换历史遗留的 16 字符密钥（架构盘点 §8-5） |
| 8 | B | `@roamhq/wrtc` 是原生模块，ABI 与 node 版本绑定（本机 node v24.21.0） | "自带 node 运行时"必须与打包时编译 wrtc 的 ABI 一致，否则流畅模式（WebRTC）加载失败，只剩清晰模式。建议打包时固定同一份 node，并在验收清单里加"切流畅模式能出画" |
| 9 | B | `enableDsh=true` 时的 DSH 路径：本机靠 PATH 里有 `dsh.cmd` 才找到 | 客户机（方案乙）需要 `runtime.dshPath` 或 PATH；找不到时程序会明确报错，不会静默 |
| 10 | B | 8780 录屏模块不在本目录（`D:\dsh-rec\record-server.js`），配置里只留了 `ports.record` | 是否纳入产品仍是未决问题（项目启动.md 决策 7）。录屏代码不在本次改动范围内 |
| 11 | C | `PowerShell ExecutionPolicy=Restricted`（本机实测） | 必须通过 `.cmd` 包装（`-ExecutionPolicy Bypass`）启动，双击 `.ps1` 会被拒。交付时保留 `.cmd`，别只给 ps1 |
| 12 | C | 端口冲突只在**启动时**检测一次 | 运行时端口不可能被抢（已 bind）；不需要额外机制 |
| 13 | C | `tailscale serve` 端口可配，但 tailnet 里已有别的 serve 占用时**无法自动换端口**（入口约定就是那个端口） | 启动时会打印现有配置让人确认；极端情况需要客户在 Tailscale 后台自行清理 |
| 14 | C | `supervise.ps1` 里方案甲的跳过方式是**守卫式**（`if ($enableDsh) { ... }` 包住 DSH 段，被包住的 27 行没有重新缩进） | 为了把 diff 压到最小、方便逐条 review。维护时注意：那一段的缩进是历史缩进，不是漏了 |

---

## 10. 回滚方式

改造前的状态可以在生产目录里找到（**只读**参考）：

```powershell
# 1) 删掉两个新文件
Remove-Item D:\download\办共\phone-access-product\app\product.config.json
Remove-Item D:\download\办共\phone-access-product\app\product-config.ps1

# 2) 从生产目录拷回 8 个改动文件（顺序无所谓，但第 1 步必须在拷回 3 个启动脚本之后，
#    否则它们 dot-source 不到 product-config.ps1，会直接报错）
$prod='C:\Users\ccj\Documents\deepseek-harness\default-workspace\phone-access'
$app ='D:\download\办共\phone-access-product\app'
foreach($f in 'start-phone-access.ps1','start-screen.ps1','supervise.ps1','screen-server.mjs','decode.mjs','rtc.mjs','tunnel-proxy.mjs','run-autostart.vbs'){
  Copy-Item (Join-Path $prod $f) (Join-Path $app $f) -Force
}
```

（生产目录本身**从未被修改**，所以不存在"回滚生产"这件事。）

---

## 11. 给下一棒（安装器 / 自检 / 交付文档）的接口约定

- 安装器只需要写 **一个文件** `product.config.json`：`ports`、`enableDsh`、`installDir`、`runtime.*`。别把端口写进任务计划参数里，否则两处会漂移。
- 自带运行时放 `app\runtime\node.exe`（`product-config.ps1` 的第 2 顺位会自动认），**不要**再往 `node-path.txt` 里写绝对路径。
- 自检脚本可以直接点源 `product-config.ps1` 复用：`Get-ProductConfig` / `Get-PortOwner` / `Test-ProductPortConflict` / `Get-TailscaleInfo` / `Get-CaptureGeometry`。
- 冲突提示的统一文案由 `Format-PortConflictMessage` 生成，别另写一套。
- 如果安装器要改配置，请**保留** `_说明`、`_ports说明`、`_tailnetServePort说明`、`_enableDsh说明`、`_runtime说明`、`_screen说明` 这些字段（它们是给客户看的自解释说明，代码不读）。

---

*本文档由改造者（param-fixer）随代码一起交付；静态检查与只读验证的结论都来自 2026-10-28 的实跑输出。*
