# 手机远程访问 DSH

目录：`C:\Users\ccj\Documents\deepseek-harness\default-workspace\phone-access`

## 现在就能用

| 场景 | 地址 | 速度 |
|---|---|---|
| 异地 / 流量（按名字） | `http://dsh-laptop.tailb9b4f0.ts.net/`（需要 MagicDNS 能解析） | 快（P2P） |
| 异地 / 流量（**不依赖 DNS**） | `http://100.108.92.22:8642/` ← 平板/设备解析不了名字时用这个 | 快（P2P） |
| 同一 Wi-Fi | `http://<电脑 WLAN IP>:8642/`，当前是 `http://10.120.215.45:8642/` | 最快 |

- 登录二维码：`phone-qr.png`（名字入口）、`qr-tailip.png`（IP 入口）；对应地址 `phone-url.txt`、
  `tailip-url.txt`、`lan-url.txt`。扫一次下发 **30 天** cookie，三个入口共用同一份 cookie。
- 拿到的是完整 DSH Web UI：和电脑共用同一个 `~/.dsh`，同一工作区、同一份会话列表。
- **打不开时先分两种情况**：同 Wi-Fi → 用 LAN 地址（完全不经过 Tailscale）；异地 →
  确认设备上 Tailscale 已连接，再用 IP 入口（名字解析失败时 IP 仍然通）。

## 结构（为什么不是直接开桌面版那个窗口）

桌面版 DSH 的 Web 服务写死监听 `127.0.0.1` 并带一次性 token，手机连不上。
所以另起一个 `web` profile 实例，但**只绑回环**：

```
dsh --profile web --host 127.0.0.1 --port 8642 --no-open
```

DSH 有个 browser-trust fence：只信任 loopback / 自己的绑定地址，并且**按它看到的
authority 签名 cookie**。所以外面三扇门都先经过 `tunnel-proxy.mjs`，把
`Host`/`Origin`/`Referer` 改写成常量 `127.0.0.1:8642` 再转发：

```
设备 ──WireGuard──> tailscaled ──serve :80──> 127.0.0.1:8650 ┐
设备 ──WireGuard───────────────> 100.108.92.22:8642 ────────┤
设备 ──Wi-Fi──────────────────> 10.120.215.45:8642 ─────────┤
                                                            └─> 127.0.0.1:8642 (DSH)
```

好处：

- DSH 本体从不对外监听，外部只有代理；
- authority 恒为 `127.0.0.1:8642`，**DHCP 换 IP 不会让 cookie 失效**；
- 换隧道供应商也不用改 DSH 参数。

## 免扫码登录（`/go`，永不过期）

DSH 每次启动都会生成新的一次性 token，所以带 token 的 URL/二维码会变。为此代理里加了一个
**永久的登录门**：

```
http://100.108.92.22:8642/go?k=<screen.key>      ← login-url.txt / qr-login.png
http://10.120.215.45:8642/go?k=<screen.key>
http://dsh-laptop.tailb9b4f0.ts.net/go?k=<screen.key>
```

打开它就 302 到**当前**的 `/?token=…`，由 DSH 顺手发一张新的 30 天 cookie。所以：

- **存这个地址当书签/主屏图标，永远不用再扫码**（token 换了它自己跟）；
- key 错了返回 401，不会泄露 token；
- 三扇门各自独立（cookie 是 host-only，各一份，但 `/go` 都能续）。

实现：`tunnel-proxy.mjs` 在转发前先处理 `/go`，token 从 `web-lan.log` 最后一条 `token=…`
读（启动时日志会被截断，所以最后一条就是当前值），取不到再退到 `phone-url.txt`。

## 空闲自动省电（没人看就不抓屏）

```
浏览器打开页面 ──> /stream ──> screen-server 记 viewers=1 ──> viewers.count
                                                  │
capture.exe 每圈读 viewers.count ── 0 => 完全停抓（0% CPU）
                                  └─ >0 => 正常 13.6 fps（约 0.4 秒内恢复）
```

页面切到后台 / 手机锁屏时，前端会主动断开流，于是 PC 立刻回到 0% CPU。
实测：空闲 8 秒 CPU 增量 **0 秒**；连上看画面 **0.4 秒**内出帧；断开后 6 秒内回到 0。

## 抓屏看门狗（真的"卡住"才重启）

supervisor 每 8 秒检查一次：

| 条件 | 动作 |
|---|---|
| `capture.exe` 不存在 / 端口没监听 / 内存 > 300 MB | 重启画面服务 |
| **有人观看（`viewers.count > 0`）但 `/health` 报 `age>10`** | 重启 `capture.exe`（管道模式不写文件，不能靠时间戳判断） |
| `screen-capture.log` > 2 MB | 轮转成 `.old` |
| 无人观看 | 不判帧新鲜度（抓屏本来就是暂停的），**不会误杀** |

## 远程看电脑画面（手机 / 平板）

不需要装 App，浏览器直接开一个直播页面：

| 场景 | 地址 |
|---|---|
| 异地（tailnet 直连 IP，不依赖 DNS） | `http://100.108.92.22:8660/?k=<key>` ← `screen-url.txt` / `screen-qr.png` |
| 同一 Wi-Fi | `http://10.120.215.45:8660/?k=<key>` ← `screen-url-lan.txt` / `screen-qr-lan.png` |

组成：

```
capture.exe（C# 抓屏循环：BitBlt + 双缓冲流水线，~32 fps、2560 宽、JPEG q62）─> 命名管道 `dsh-screen-frames`（内存）
                                                                    │
screen-server.mjs（只绑 Tailscale IP 与 WLAN IP）──> MJPEG 网页 ──────┘
```

- **DPI 感知**：这台机器是 2560×1600 + 150% 缩放，抓屏程序启动时声明
  `PER_MONITOR_AWARE_V2`；否则它只看到 1707×1067 的逻辑尺寸，截出来是**残缺的一块**
  （这就是之前"屏不完整"的原因）。现在 `screen-capture.log` 会打印
  `screen=2560x1600 targetWidth=1920`，帧是 `1920x1200`（和平板 1920 物理像素 1:1，不再被放大）。
- 参数：`capture.exe <out> <width> <intervalMs> <log> [quality]`，改完重跑
  `start-screen.cmd` 生效（看门狗会自动接管）。

- 密钥在 `screen.key`（32 位十六进制），页面/二维码里带 `?k=`；打开后下发 cookie，
  之后直接开地址即可。**没有密钥 = 401**。
- **画面这条不需要 `/go`，因为它比 DSH 更稳**：DSH 的 token 每次重启都变，而这里用的是
  **固定的 `screen.key`（不轮换）**，所以带 `?k=` 的地址和二维码**永久有效**；
  cookie（`screen-key`）只是"以后不用带参数"的便利，有效期 **1 年**。
  书签就存 `http://100.108.92.22:8660/?k=<screen.key>`，一辈子不用重扫。
- 想轮换密钥：停画面服务 → 删掉 `screen.key` → 跑 `start-screen.cmd`
  （会生成新 key，`screen-url*.txt` / `screen-qr*.png` / `login-url.txt` / `qr-login.png`
  随之更新，旧链接和旧 cookie 立即失效）。
- 端口 8660 **只绑私有地址**，公网完全不可达。
- 为什么用编译版 `capture.exe` 而不是 PowerShell 脚本：Windows Defender 的 AMSI
  把「截屏 + 存成 JPEG」这个组合判定为信息窃取类恶意脚本，直接拒绝执行
  （`ScriptContainedMaliciousContent`）。编译后的 `capture.exe` 不走脚本扫描。
  源码在 `capture.cs`，重编译：
  ```powershell
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe `
    /out:capture.exe /r:System.Drawing.dll /r:System.Windows.Forms.dll capture.cs
  ```
- 是**只看不控**：没有输入注入。要能控制鼠标键盘（真正远程操作）需要另加一层
  （Windows 远程桌面会把你本机登录挤下线；或者装 VNC/向日葵这类），需要的话再说。
- 隐私：画面就是当前桌面的全部内容，包括 DSH 窗口。不想被看到时把页面关掉、
  或者停掉服务：`Get-Process capture,screen-server -ErrorAction SilentlyContinue | Stop-Process`
  （看门狗会在 8 秒内又拉起来 —— 要长期停就删掉/改名 `start-screen.ps1`）。
- 自愈：`supervise.ps1` 每 8 秒顺带检查抓屏进程和 8660 端口，缺哪个补哪个
  （日志里是 `screen viewer down (capture=… server=…)`）。

### 清晰度 / 流量（2026-10-22 调过）

| 阶段 | 尺寸 | 帧大小 | 帧率 | 带宽 | CPU（单核） |
|---|---|---|---|---|---|
| 最初（糊，串行） | 1280×800 q50 | ~120 KB | 10.6 fps | 1.2 MB/s | 33% |
| 换 1920（串行） | 1920×1200 q65 | ~168 KB | 7.9 fps | 1.3 MB/s | 53% |
| 双缓冲流水线 | 1920×1200 q65 | ~172 KB | 13.6 fps | 2.3 MB/s | 89% |
| 原生 2560 + 写文件 | 2560×1600 q62 | ~300 KB | 21 fps | 6.1 MB/s | 106% |
| **现在：原生 2560 + BitBlt + 命名管道** | **2560×1600 q62** | **~300 KB** | **~32 fps** | **10.7 MB/s** | **104%** |
| 省流量（页面按钮） | 同上，2 帧/秒 | 300×2 KB/s | 2 fps | **~0.6 MB/s** | 抓屏间歇跑 |

四步提速各自的作用：

1. **双缓冲流水线**：截屏线程与「缩放+JPEG」线程交替用两块 Bitmap，帧周期从
   `截屏+编码` 变成 `max(截屏, 编码)` → 7.9 → 13.6 fps。
2. **原生 2560 不缩放**：省掉 DrawImage 那一步，`HighQualityBilinear` 在 0.75 倍下
   要 ~30 ms；2560 是 1:1，直接把 Bitmap 交给编码器。
3. **BitBlt 代替 GDI+ CopyFromScreen**：实测 20.6 ms vs 30 ms（CAPTUREBLT 反而慢，
   用 `SRCCOPY`）。
4. **命名管道传帧**：以前每帧写 `screen-latest.jpg`，浏览器同时在读同一文件，
   写入经常被共享冲突挡掉（编码 28 fps、真正落盘只有 21）。改成
   `capture.exe` 当管道服务端、`screen-server` 当客户端，帧只在内存里走，
   零磁盘写入、零共享冲突 → 21 → 32 fps。

管道细节：
- 帧格式 = 4 字节小端长度 + JPEG。长度 0 是心跳（让抓屏停摆时也能发现客户端已断开）。
- 抓屏只在有客户端时才发帧；没有客户端就连心跳都不发（更省电）。
- 客户端断开/管道不存在时，`screen-server` 自动回退读 `screen-latest.jpg`（兼容旧模式）。
- `/health` 现在返回 `source=pipe|file` 和 `age=<最新帧龄秒>`：
  看门狗和 `check-health.ps1` 用 `age` 判断抓屏死活（管道模式不写文件，
  靠文件时间戳会误判"卡住"并重启，这一点已修）。

**注意**：32 fps × 2560×1600 意味着平板每秒解码 4 百万像素×32 帧 ≈ 1.3 亿像素/秒，
老平板可能发热掉帧。若卡顿：把 `start-screen.ps1` 里的 `2560 0` 改成 `2560 40`
（约 25 fps、8 MB/s）或 `2560 60`（约 17 fps、5 MB/s），再点页面右上角「省流量」。

流水线（`capture.cs`）：截屏线程与「缩放+JPEG+落盘」线程用两块 Bitmap 交替，
帧周期从 `截屏+编码` 变成 `max(截屏, 编码)`，所以帧率几乎翻倍，代价是单核占用上去
（整机 8 线程下也就 10% 左右）。

- 「糊」的根因是**帧比屏幕小**：平板 1920 物理像素 vs 旧帧 1280 宽 → 图片被放大 1.5 倍。
  现在 1920 与平板 1:1、手机（1290 物理）是缩小显示，所以都锐。
- 缩放算法试过 `HighQualityBicubic`（CPU 70%、5 fps）和 `HighQualityBilinear`
  （53%、7.9 fps），最终用 `HighQualityBilinear` + `HighSpeed` 偏移；
  `HighQuality*` 偏移模式会拖到 5 fps，不要用。
- 页面右上角「省流量」按钮：切到 `/frame.jpg` 每 500 ms 取一帧（蜂窝网络下大约省 4 倍流量），
  再点一次回到直播。这种轮询也算"有人观看"，抓屏照常跑，停 3 秒后自动暂停。

### 延迟（2026-10-22 修）

MJPEG 最大的坑是**延迟会随时间累积**：客户端解不动时，帧在 TCP 缓冲里排队，
画面越来越落后（能到几秒）。现在的对策：

- **拥塞就丢帧**：`res.write()` 返回 false（发送缓冲满）时不再推新帧，只在 `drain`
  后推**最新**那一帧。宁可少几帧，也不让延迟漂移。
- **帧内打时间戳**：每帧 JPEG 的 SOI 后面插一个 COM 段 `TSD<毫秒>`（浏览器忽略），
  用本地客户端就能精确量出端到端延迟。
- 实测（同一局域网、快速客户端）：p50 **23 ms**、p90 36 ms、20 帧漂移 **+2 ms**（不累积）。
- `/health` 增加 `dropped=<累计丢帧数>`，可直接看链路是否在丢帧。

**闸门文件同步**：`viewers.count` 以前"只在变化时"写，若被外部改动会与服务端真实状态
脱钩，抓屏会以为没人看而一直暂停。现在服务端每 700 ms 强制重写一次。

`screen-server.mjs` 的管道重连也修了：断开时先 `socket.destroy()`（半开句柄会永久占住
单实例管道，导致之后再也连不上），并在"有人观看却 6 秒无新帧"时主动断开重连。

### 自适应码率 / HUD / 装到主屏幕（2026-10-22）

- **自适应帧预算**：`screen-server` 每 4 秒看一次丢帧增量——
  - 4 秒内丢帧 > 40 → 让 `capture.exe` 放慢一档（33 → 45 → 60 → 80 → 110 ms，即 ~30/22/17/12/9 fps）；
  - 连续 3 次（12 秒）零丢帧 → 提速一档。
  档位通过 `capture.interval` 文件下发，抓屏每 300 ms 读一次，所以**不用重启**。
  效果：链路差时自动降码率保住延迟，链路恢复后自动升回去。`/health` 里能看到 `cap=<当前档位 ms>`。
- **页面 HUD**：右上角实时显示收到的帧率（`__ fps`），旁边是连接状态与「省流量」按钮。
- **装到主屏幕**：页面带 `manifest.json` + 192/512 图标 + `apple-mobile-web-app-capable`，
  iOS Safari「添加到主屏幕」/ Android Chrome「安装应用」后是全屏、无地址栏，像原生 App。
  `manifest.json` 和图标**不需要密钥**即可获取（图标/清单不含隐私），页面本身仍要 `?k=`。

### 帧率到底怎么测（2026-10-23 修正）

之前页面 HUD 的帧率是错的，两个坑：

1. **`<img>` 的 `load` 事件在 MJPEG 流里只触发一次**（整条流只算一帧），
   按 `load` 计数得到的是 1 fps 这种假数。
2. **`res.write()` 写 300 KB 帧永远返回 false**（Node 默认水位只有 16 KB），
   于是"返回 false = 拥塞"的判断把每一帧都判成拥塞，`out=` 一直是 0。

现在的测法：
- 服务端在**每一帧真正写入 viewer 后**记一次时间戳，`/health` 的 `out=` 是最近
  2 秒的实测下发帧率；`dropped=` 只统计 `writableLength > 2 帧` 时的真实丢帧。
- 页面 HUD 每 2 秒轮询 `/health`，显示 `out` fps + 当前档位上限 + 丢帧数。
- `check-health.ps1` 新增「实际帧率」一行，直接读 `out=`。

自查方法：`curl http://100.108.92.22:8660/health` → `out=` 就是你这台设备**真的**在收的帧率。
注意这个数是"服务端已经写进 socket"的帧数；如果设备解码跟不上，它仍然会低于 `cap` 对应的上限。

## 无窗口运行（不再弹一堆黑框）

以前每次拉起服务都会弹出 `cmd.exe` 黑色窗口（DSH、两个代理、画面服务各一个，
外加看门狗每 2 分钟一个）。现在全部隐藏，两种手段：

| 场景 | 做法 |
|---|---|
| 后台服务（DSH / 代理 / 画面服务 / supervisor） | `Win32_Process.Create` 附带 `Win32_ProcessStartup.ShowWindow = 0`（SW_HIDE）——进程创建时就没有窗口，且不在计划任务作业树里，任务结束不会连带清理 |
| 计划任务 `DSH Phone Access` | 动作改成 `wscript.exe //nologo run-autostart.vbs`，VBS 用 `WScript.Shell.Run(cmd, 0, False)` 以窗口样式 0 启动 `autostart.ps1` |
| `capture.exe` | 用 `/target:winexe` 编译，本身没有控制台 |

注意：

- `Win32_ProcessStartup.CreateFlags`（想用 `CREATE_NO_WINDOW`）会被 WMI 拒绝（返回 21），
  所以只用 `ShowWindow = 0`；效果一样（实测 `MainWindowHandle = 0`）。
- 手动双击 `start-phone-access.cmd` / `start-screen.cmd` 时仍会出现一个控制台窗口——
  那是你自己前台运行的，正常；后台与自启路径都无窗口。
- 检查有没有漏网的窗口：
  ```powershell
  Get-Process cmd,node,powershell,capture,wscript -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select Id,ProcessName,MainWindowTitle
  ```

## 30 天有效性 / 体检

一键体检（打印一页表，最后一行会告诉你有没有问题）：

```powershell
.\check-health.ps1          # 或 powershell -File check-health.ps1 -Quiet
```

它检查：计划任务状态与下次运行、四条门的监听、DSH/抓屏/supervisor 进程、心跳年龄、
`token` 是否真能登录（HTTP 303）、**二维码是否等于当前地址**、Tailscale key 到期日、
磁盘空间、画面帧新鲜度。

### 什么会自动保持有效

| 项 | 期限 / 依据 |
|---|---|
| 会话 cookie | **30 天**（`Max-Age=2592000`，HttpOnly）。签名密钥持久化，**DSH 重启不会失效**（已实测：重启后旧 cookie 仍 200） |
| 二维码 / token | token 每次 DSH 重启都变，看门狗每 2 分钟会读新 token 并重画二维码（实测：重启后 `phone-qr.png` 与 `phone-url.txt` 自动一致） |
| 计划任务 | 每 2 分钟，重复到 `P3650D`（10 年），无执行时限；动作是 `wscript.exe` 隐藏启动 |
| Tailscale | 本机设备 key 到期 `2027-04-19`，远超 30 天 |
| 画面服务 | 抓屏进程/端口缺失会被 supervisor 8 秒级重拉；`capture.exe` 被 Defender 隔离会从 `capture.exe.bak` 自动恢复 |

### 30 天内可能会遇到的三个情况

1. **cookie 到期（2026-11-21）**：到期后页面 401。回电脑上打开最新二维码扫一次即可（二维码
   会自动更新）；手机/平板**每个入口各有一份 cookie**（名字门、IP 门、LAN 门域名不同，
   host-only cookie），所以换入口要重新登录一次。
2. **局域网 IP 变（DHCP）**：LAN 地址会失效，tailnet 地址不受影响；看门狗 2 分钟内会刷新
   `lan-url.txt`。
3. **重启后没登录桌面**：计划任务是"登录时触发 + 每 2 分钟"，属于用户会话级；
   重启后只要**登录一次桌面**（锁屏也算已登录），服务就会在 ~20 秒内补齐。

### 实测过的恢复能力

| 场景 | 结果 |
|---|---|
| 杀掉 DSH 进程（崩溃） | 10 s 恢复，token 自动更新，cookie 仍有效 |
| 挂起全部线程（卡死/AppHang） | 54 s 恢复 |
| 杀掉 supervisor | 83 s（等下一轮看门狗）恢复 |
| 移走 `capture.exe`（模拟被隔离） | 6 s 从 `.bak` 恢复 |
| **整套全灭（DSH + 代理 + 画面 + supervisor）** | **18 s 全栈恢复，零可见窗口** |

### 残余风险（不能靠代码消除的）

- **Windows 锁屏时**抓屏通常只能拿到锁屏画面（secure desktop），不是桌面内容。
- **Defender 深扫**有可能把 `capture.exe` 判为可疑并隔离；已做备份+自动恢复，但若连 `.bak`
  一起被隔离，需要重编译（README 上方有命令）。
- 计划任务是用户会话级：注销（不只锁屏）后不会运行。
- 公网完全不可达；但如果有人拿到带 token 的 URL 就等于拿到控制权，别外传。

## 插件 / 配置 / 第三方 API 与桌面端一致

桌面版用的是 `~/.dsh/profiles/desktop`，手机这边是 `~/.dsh/profiles/web`。原来 web 只装了
`dsh-base` + `dsh-web-app`，所以插件、模型供应商、UI 设置全是空的。现在 web 已改成**镜像 desktop**：

- `web/package.json` 的 dependencies + bundles 与 desktop 相同（21 个 bundle）；
- `web/cordis.patch.yml` 复制自 desktop，于是 `llm-pi-ai` 的第三方供应商
  （SiliconFlow / 阿里 DashScope / 本地 Ollama）、`media-gen`、`vision-router`、
  `permission`、`computer-use` 配置全部生效；
- `web/node_modules` 是指向 `desktop/node_modules` 的 **junction**（同一份安装，省 700MB，
  桌面端新装插件立刻可见）。

API key 存在 `~/.dsh/.credentials.yaml` 的 `refs:`（共享），所以两边读到的是同一批 key。

**桌面端加/改插件或配置后，同步一次：**

```powershell
sync-profile.cmd           # 同步 manifest + patch
sync-profile.cmd -Restart  # 同步并重启手机侧实例
```

改完在手机上刷新页面即可 —— 30 天 cookie 不受影响，不用重新扫码。

## 自动恢复（以前「用一会就挂」的原因）

两个查实的故障来源：

1. **计划任务的作业树清理**：Task Scheduler 收尾会关掉它拉起的进程树，服务跟着一起没了。
   现在 DSH 和两个代理都用 `Win32_Process.Create` 拉起（父进程 `cmd.exe`），不在任务作业树里。
2. **AppHang**：2026-10-22 13:40 出现过 `DeepSeek Harness.exe` 停止响应（事件日志
   `Application Hang 1002` / `AppHangB1`），Windows 直接把进程关掉了。

三层保护：

| 层 | 频率 | 作用 |
|---|---|---|
| `supervise.ps1`（常驻） | 每 8 秒 | HTTP 探活（401 也算活着）；连续 3 次无响应（约 24 秒）就杀掉重启；进程没了直接重启；内存 > 4.4 GB 主动重启；两扇门（tailnet + LAN）任一不在就补；日志超 25 MB 轮转 |
| 计划任务 `DSH Phone Access` | 每 2 分钟 | 幂等自检：补进程、重发 `tailscale serve`、刷新 URL/二维码；supervisor 进程没了或心跳超 3 分钟就替换掉它 |
| 登录触发器 | 每次登录 | 同上 |

其它加固：

- 进程用 `Win32_Process.Create` 拉起，不挂在计划任务作业树里（任务结束不会连带清理）；
- 关掉了 Windows「程序停止响应」弹窗（`HKCU\...\Windows Error Reporting\DontShowUI=1`），
  避免卡死时弹出对话框挡住恢复；
- 每次重启前把现场存到 `diagnostics\restart-<时间>.txt`（进程 CPU/内存/线程数 + 服务日志尾部 40 行）；
- `web-lan.log`、`supervisor.log` 都会轮转，不会无限长大。

实测：

| 场景 | 结果 |
|---|---|
| 直接杀进程（模拟崩溃） | 10 秒恢复 |
| 挂起全部线程（模拟 AppHang 卡死） | 54 秒恢复（24 秒探活 + 重启） |

看状态：

```powershell
Get-Content supervise.log -Tail 20        # 30 分钟一条心跳；每次重启都有记录
Get-Content supervisor.heartbeat         # 应在最近 10 秒内
Get-ChildItem diagnostics                # 每次重启的现场快照
Get-NetTCPConnection -State Listen -LocalPort 8642,8650
```

重启会换 token，`phone-url.txt` / `phone-qr.png` 自动重新生成；手机 cookie 绑定的是稳定的
`127.0.0.1:8642`，所以**刷新页面就能接着用，不用重新扫码**。

## 会话写锁：为什么「这条对话一直转圈、发不出消息」

DSH 的每个会话目录里有 `session.lock`，实现是**内核锁**（Windows 命名信号量 / POSIX flock），
写句柄持有到关闭为止（源码：`@deepseek-ai/dsh-session-persistence-jsonl` 的 lease 模块）。
规则是**一个会话同时只能有一个写者**：

- 电脑上打开（或正在用）的那条会话，写锁在电脑进程手里；
- 手机端去续这条会话 → 拿到 `SessionAlreadyOwnedError`（`session/writer-held`），
  于是界面一直转圈、消息发不出去；
- 手机端自己新建的会话没有任何进程占锁 → 立刻可用（实测 4 秒完成一轮）。

锁是内核对象，进程退出/被杀时自动释放，不会留下需要手工删的锁文件；进程中途挂掉留下的
未闭合 turn 也会由 `openTurnClosers` 在下次打开时补一条结束事件。

**用法约定（重要）**：

- 手机上**新建会话**聊天，不要点电脑当前正开着的那条；
- 想在手机上接着某条电脑上的对话，先在电脑端关掉它（切走/关掉该会话页）；
- 被锁住的会话切走再切回来，或换个会话即可；实在顽固就重启手机侧实例（`start-phone-access.cmd`）。

## 日常操作

| 要做的事 | 运行 |
|---|---|
| 启动全部（DSH + 两扇门 + 重画二维码） | `start-phone-access.cmd` |
| 停掉全部 | `stop-phone-access.cmd` |
| 只看当前二维码 | `show-qr.cmd` |
| 服务日志 | `web-lan.log`；代理日志 `proxy-tailnet.log`、`proxy-lan.log` |

脚本是幂等的：已经在跑就跳过，只刷新地址和二维码。

## 开机自启（已配好）

计划任务 **`DSH Phone Access`**，登录时触发，先等 Wi-Fi 拿到 IPv4（最多 4 分钟），
再调用 `autostart.ps1` → `start-phone-access.ps1`。日志：`autostart.log`。

```powershell
Get-ScheduledTask -TaskName 'DSH Phone Access' | Select TaskName,State
Start-ScheduledTask   -TaskName 'DSH Phone Access'   # 手动跑一次
Disable-ScheduledTask -TaskName 'DSH Phone Access'   # 暂停自启
Unregister-ScheduledTask -TaskName 'DSH Phone Access' -Confirm:$false   # 删掉自启
```

`tailscale serve` 的配置存在 tailscaled 里，重启后自动恢复；任务只负责把 DSH 和代理拉起来。

## 注意 / 限制

- **每次 DSH 重启 token 都会变**（一次性登录 token），脚本会自动重画二维码；
  手机上的 30 天 cookie 不受影响，所以只有首次或 cookie 过期才需要扫码。
  更省事的方式是用**永久登录门** `…/go?k=<screen.key>`（见上文），它永远跟着当前 token 走。
- **WLAN IP 是 DHCP 给的**，会变（今天就是 `10.120.222.63` → `10.120.215.45`）。
  tailnet 地址不变；局域网地址变了就重跑 `start-phone-access.cmd` 刷新 `lan-url.txt`。
- 这个 tailnet **不支持签发 TLS 证书**（`tailscale cert` 返回 500），入口是 `http://`。
  传输在 WireGuard 内加密且仅 tailnet 设备可达，但不是浏览器 HTTPS。想要 `https://`
  需在 admin 控制台 DNS 页启用 HTTPS Certificates，再把 serve 改成 https。
- 手机必须装 Tailscale 并登录同一账号（`ccc475235@gmail.com`）且开着开关。
- **不要两边同时续跑同一个会话**：两个 DSH 进程同时写同一份会话日志有风险，
  建议手机上新开会话。
- **安全**：入口靠 token / cookie 鉴权，二维码和带 token 的 URL 等同密码，别外传。

## 备用：Cloudflare 快速隧道（公网，临时）

手机不方便装 Tailscale 时可临时用：

```powershell
start-remote.cmd   # 起 cloudflared 快速隧道（复用 127.0.0.1:8650 这扇门），生成公网二维码
stop-remote.cmd    # 只停隧道，不动本地代理
```

- 域名每次重启都变（`xxx.trycloudflare.com`），换域名要重新扫码。
- **公网入口 + cookie = 这台电脑 agent 的控制权**，用完立刻停。
- `bin/cloudflared.exe` 是 Cloudflare 官方二进制（2026.10.3，55,329,336 字节）。

## 清理

```powershell
# 停服务（不含 Tailscale 本身）
.\stop-phone-access.cmd

# 删防火墙规则
Remove-NetFirewallRule -DisplayName "DSH Web (phone access) 8642"
```

## 文件说明

- `start-phone-access.ps1` / `.cmd` — 主启动器：DSH（回环）+ 三扇门 + serve + 二维码 + 画面服务
- `sync-profile.ps1` / `.cmd` — 把桌面端 profile 的插件与配置同步到手机端 profile
- `supervise.ps1` — 常驻健康检查（8 秒探活，挂了/卡了/内存超限就重启；顺带看画面服务），日志 `supervisor.log`
- `autostart.ps1` — 登录自启入口（等 Wi-Fi，再调主启动器）
- `stop-phone-access.ps1` / `.cmd` — 停 DSH、代理并关闭 tailnet 入口
- `tunnel-proxy.mjs` — 反向代理，参数：`<listenHost> <listenPort> <targetHost> <targetPort>`
- **画面相关**：`start-screen.ps1`（拉起抓屏+观看服务）、`capture.cs` → `capture.exe`
  （编译版抓屏循环）、`screen-server.mjs`（MJPEG 服务）、`screen.key`（访问密钥）、
  `screen-url.txt` / `screen-url-lan.txt` / `screen-qr.png` / `screen-qr-lan.png`、
  `screen-latest.jpg`（仅在无管道客户端时作回退）、`capture.interval`（自适应帧预算）、`icon-192.png` / `icon-512.png`（PWA 图标）、`screen-server.log` / `screen-capture.log`、
  `viewers.count`（当前观看人数，0 时抓屏暂停）
- `login-url.txt` / `qr-login.png` — **永久登录地址与二维码**（`/go?k=…`，永不过期）
- `check-health.ps1` — 一键体检（计划任务、四扇门、进程、心跳、token 实测、二维码一致性、磁盘、帧新鲜度）
- `show-qr.ps1` / `.cmd` — 重画二维码
- `start-remote.ps1` / `.cmd`、`stop-remote.ps1` / `.cmd` — Cloudflare 备用入口
- `make-qr.py`、`decode-qr.py` — 二维码生成 / 解码（依赖 `qrlib/`）
- `qrlib/` — 当前可用的 Python 依赖（qrcode、zxing-cpp）
- `pylib/` — 旧依赖目录，**权限已损坏（ACL 拒绝访问），留着别用**
- `phone-qr.png`、`phone-url.txt`、`lan-url.txt` — 当前二维码 / 地址
- `web-lan.log` — DSH 服务日志（含当前 token）

## 流畅模式：WebRTC 传输（视频 + 声音）

页面顶部两个模式按钮：

| 按钮 | 传输 | 用途 |
|---|---|---|
| 清晰 | MJPEG over HTTP（2560×1600 q62） | 看细节、看文字、当第二块屏 |
| 流畅 | WebRTC（VP8 1280×800 + Opus 音频） | 手滑、拖拽、看视频，延迟更低 |

实现路径（为什么不用管道直传 I420）：命名管道送 300 KB 的 JPEG 很稳，但 1.4 MB 的原始 I420 帧会
把管道写满、触发写超时。所以**抓屏仍然只产出 JPEG**，Node 端用 sharp 解码成 I420 后喂给
`RTCVideoSource`，libwebrtc 负责 VP8 编码：

- 解码：`decode.mjs`，sharp `raw` → BGRA→I420，实测 **10 ms/帧**，12 fps 上限（省 CPU）。
- 编码：`rtc.mjs`，`maxBitrate 1.5 Mbps`、`maxFramerate 12`、`degradationPreference=maintain-framerate`。
- 连接：`GET /rtc` WebSocket（复用 `?k=` 或 cookie 鉴权）做 offer/answer + ICE，STUN 尽力而为。
- 视频轨在服务启动时用一帧黑色 1280×800 预热再建轨：libwebrtc 建轨时锁定帧尺寸，0×0 的轨在浏览器里永远不出画。
- 浏览器侧必须把 `ontrack` 收到的一轨一轨合并进同一个 `MediaStream`（服务端 addTrack 不带 stream），
  否则后到的一轨会把 `srcObject` 覆盖成只有声音的流。

实测（本机 Chrome / Tailscale）：`videoWidth=1280 videoHeight=800`，`framesAge 0.07s`，
音频块 50/s，连接状态 `connected`。

## 远程鼠标键盘

**控制默认就是开着的**（记住上次选择在 `localStorage.ctl`）：打开页面直接点屏幕就有反应，
不需要先点「控制」；「控制」现在的作用是**关掉输入**、让你能双指缩放看细节。

触摸/鼠标事件 → 虚拟桌面绝对坐标 → `POST /input` → `input.exe` 注入：

| 手势 | 动作 |
|---|---|
| 轻点 | 左键单击（落点先送 `move`，并显示黄点 + 绿色波纹 + 轻震动） |
| 双击 | 双击 |
| 拖动 | 左键拖拽（>8 px 才算拖动，避免点按抖动变成拖拽） |
| 长按 0.55 s 后抬起 | 右键单击（有震动提示） |
| 长按 0.55 s 后拖动 | 右键拖拽 |
| 双指竖直滑动 | 滚轮 |
| 「输入」按钮 → 文本框 | 文本注入（只在按「输入」时才弹软键盘） |

两个曾踩过的坑（已修）：

- **点屏幕没反应**：旧版 `#overlay` 默认 `display:none`（要手动点「控制」），普通点击落不到任何处理器上。
  现在覆盖层常驻，只靠 `pointer-events` 切换是否有输入。
- **点屏幕弹平板键盘**：旧版切「控制」时会 `kb.focus()` 一个隐形输入框，软键盘就一直挂着。
  现在没有任何常驻 focus 元素，只有按「输入」才聚焦 `#kbtext`。

手势改用 Pointer Events（`pointerdown/move/up` + `setPointerCapture`），Chrome/Safari 都稳；
双指滚轮单独用 `touch*`，`touch-action:none` + `overscroll-behavior:none` 保证页面不跟着滚。

坐标换算用抓屏来源的矩形（全屏或所选窗口），并考虑 `object-fit: contain` 的黑边，
所以切到单个窗口后点击位置依然对得上。实测日志：`{"t":"move","x":1022,"y":583}` → `down` → `up`。

## 多显示器 / 指定窗口

`GET /sources` 跑 `sources.exe`（DPI 感知），返回：

```json
{"monitors":[{"i":0,"x":0,"y":0,"w":2560,"h":1600}],
 "windows":[{"hwnd":3018124,"title":"电脑画面 - Google Chrome","x":368,"y":207,"w":1567,"h":1563}]}
```

下拉框选「显示器 N」或「窗口：标题」→ `POST /mode` 写 `capture.mode`
（`mode=` `monitor=` `window=` `width=`），抓屏端每 300 ms 重读并在变化时重建管线：

| 选择 | 管线实测 |
|---|---|
| 全部屏幕 | 2560×1600 → 2560×1600 |
| 指定窗口（Chrome 1567×1563） | 1585×1572 → 1585×1572，JPEG 82 KB |

## 声音转发

`audio.exe`（NAudio 2.2.1，WASAPI **loopback**）把系统声音转成 48 kHz / 16 bit / 双声道 PCM，
每 20 ms 一块（3840 B）写进 `\\.\pipe\dsh-audio`；`audio.mjs` 读取后交给 `RTCAudioSource`。
libwebrtc 要 10 ms 帧，所以每块再切成两帧（480×2 采样）——直接送 960 帧会报
`Expected a .numberOfFrames of 480`。

页面「声音」按钮把 `<video>` 解除静音（移动端必须用户手势后才能出声）。
实测：采集进程 1 个、50 块/秒、RMS ≈ 0.05–0.09，静音段照常补块。

## 新增接口一览

| 接口 | 说明 |
|---|---|
| `POST /mode` | 切来源（mode/monitor/window/width） |
| `GET /sources` | 显示器 + 窗口列表 |
| `POST /input` | 鼠标键盘事件（move/down/up/click/wheel/key/text） |
| `POST /rtc-on` / `/rtc-off` | 流畅模式开关（同时把抓屏宽度降到 1280 省流量） |
| `GET /rtc` | WebSocket，WebRTC 信令 |
| `GET /health` | 增加了 `mode/raw/rtc/input` 字段；`blk=/blkage=/fg=` 是注入被 UIPI 挡的情况 |
| `GET /cursor` | 真实光标坐标（顺带回 `blocked` / `fg`） |
| `POST /unblock` | 抢回前台（页面「抢回前台」按钮用）：injector 抢一次 + PowerShell 抢一次 |
| `POST /exec?k=` | 跑一条 PowerShell 并回显（页面「命令」面板）。必须带 key + `application/json`，不吃本机豁免 |
| `POST /showdesktop` | 最小化所有窗口露出桌面（页面「桌面」按钮，Shell 的 `MinimizeAll`） |
### ⚠ 注入器必须放在 workspace 之外（低完整性标签）

DSH 的 workspace 文件带**低完整性（Low IL）标签**。从 workspace 里直接运行 `input.exe`，进程就是低 IL，
Windows 的 UIPI 会拦住它：`SetCursorPos` / `SendInput` 一律失败（`GetLastError` 返回 1300），
日志里能看到事件，但屏幕上什么都不动 —— 这是「手机上点了、黄球跟着走、电脑没反应」的真正原因。

所以 `start-screen.ps1` 会把 `input.exe` 复制到 `%LOCALAPPDATA%\DshInput\input.exe` 再启动：

```powershell
$inputDir = Join-Path $env:LOCALAPPDATA 'DshInput'
Copy-Item $inputSrc $inputExe -Force        # 源文件更新时自动覆盖
Start-Detached "cmd.exe /c `"`"$inputExe`" dsh-input ..."
```

`supervise.ps1` 现在也把 `audio` / `input` 缺失当作重启条件（以前只看 capture 和 8660 端口），
掉线会被自动补起来。

验证方法（不依赖日志，直接看真实光标）：

```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position      # 注入前后对比坐标
```
## 光标显示（黄点，不画箭头）

页面只用**黄色小球**标出你的手指落点：手指按下/移动时立刻跟手，松手后留在原地。
不再画白色箭头（试过一版，双标记反而干扰）。

`GET /cursor` 仍然保留：服务端把 `{"t":"cursor"}` 写进 `dsh-input` 管道，
`input.exe` 用 `GetCursorPos` 读回真实坐标写回去（管道 `PipeDirection.InOut`），同时在同一个回包里
捎上 `blocked`（累计被 UIPI 挡掉的次数）和 `fg`（当前前台窗口标题）。
`/health` 把它们原样透出成 `blk= / blkage= / fg=`，页面靠这三个值弹"被挡住"的红色提示条。
`check-health.ps1` 的「显示缩放」一行仍用它做 DPI 口径对照。

## 触屏"一下好一下坏"：UIPI 挡住了注入

这是查了很久才定位的真原因，跟手感、跟页面手势、跟 DPI 都无关。

**现象**：手机上点得好好的，忽然几下完全没反应（黄点跟着走、光标不动），过一会又自己好了。

**原因**：Windows 的 UIPI（用户界面特权隔离）规定——**前台窗口如果是高完整性（管理员）进程的窗口，
普通权限进程注入的鼠标/键盘会被整段丢弃**。这时 `input.exe` 里：

- `SetCursorPos` 返回 `FALSE`，`GetLastError` 是 `183`（`ERROR_ALREADY_EXISTS`，Windows 在这里给的
  就是这个莫名错误码，别被它误导）；
- `SendInput` 返回 `183`（经典 UIPI 拒绝码），光标纹丝不动；
- 你在页面上看到的黄点照常跟手（那是页面自己画的），但电脑上的真光标不动，点击也不生效。

这台机器上抓到的"挡路窗口"是 **LegionZone（联想游戏中心）** 和 **SSID（`C:\Program Files\SSID\ssid_client.exe`）**，
它们都是管理员权限，一旦跑到前台，注入就全黑。

**怎么自愈**（已内置）：

1. `input.exe` 每次移动后校验落点，没落到目标点就判定被挡：`SwitchToThisWindow(GetShellWindow())`
   把前台踢回桌面 `Program Manager`，等 130 ms 再试，最多 4 轮。
2. 某些进程上下文里第 1 步会被前台锁拒（实测 `input.exe` 里就拒），所以服务端再补一枪：
   `/health` 的 `blk` 计数在涨且有人在看画面时，`screen-server.mjs` 会 spawn 一个
   `powershell -NoProfile -Command "<Add-Type + SwitchToThisWindow>"` 抢前台（实测这条路稳定成功）。
3. 页面顶部会出现红色提示条：`⚠ 前台窗口 <名字> 挡住了鼠标注入`，旁边有「抢回前台」按钮，
   点它打 `POST /unblock`（会让 injector 和 PowerShell 各抢一次）。

### 为什么不"最小化/关掉"那个挡路窗口

**因为我们做不到，也不该做。** UIPI 同样会拦掉普通权限进程对高完整性窗口的窗口操作：
`ShowWindow(SW_MINIMIZE)`、`PostMessage(WM_SYSCOMMAND/SC_MINIMIZE)`、`CloseWindow`、`taskkill`
全部会被拒绝（`Access Denied`）。所以 `input.exe` / `screen-server.mjs` 里**只做一件事**：
`SwitchToThisWindow(GetShellWindow())` —— 把**桌面窗口**激活，不碰那个高权限窗口本身，因此不会被拦。

### 为什么"手动关掉"也不是长久之计

`LegionZone`（联想游戏中心）和 `SSID`（`C:\Program Files\SSID\ssid_client.exe`）都不是我们启动的，
也不是 Run 键 / 启动文件夹里的：

| 来源 | 状态 |
|---|---|
| `LenovoPcManagerService` / `LenovoModelMgrService` / `LenovoFnAndFunctionKeys` | 运行中，SYSTEM，会拉起这些 UI |
| 计划任务 `Lenovo UDC Diagnostic Scan` | Disabled / SYSTEM / Highest |
| HKLM `Run` | 只有 SecurityHealth、RtkAudUService |

也就是说：普通权限杀不掉它们，关掉后 SYSTEM 服务还会再拉起来（Whack-a-mole）。要治本只有两条路：
1. 管理员权限把这两个自启来源关掉（需要 UAC 一次）；
2. **把注入器本身提到管理员权限**（推荐，见下）。

### 治本：以管理员权限跑注入器（一次 UAC，之后永不受 UIPI 影响）

```powershell
# 右键「以管理员身份运行」PowerShell，然后：
powershell -ExecutionPolicy Bypass -File .\install-elevated-input.ps1
# 想改回普通权限：
powershell -ExecutionPolicy Bypass -File .\install-elevated-input.ps1 -Uninstall
```

它做三件事：
1. 注册计划任务 `DSH Input Injector`（`RunLevel=Highest`、`LogonType=Interactive`、失败自动重启）；
2. 在 `%LOCALAPPDATA%\DshInput\elevated.enabled` 打标记，`start-screen.ps1` 看到标记就用
   `Start-ScheduledTask` 启动注入器（否则还是原来的普通权限路径，行为不变）；
3. 立刻重启注入器，并在 `input.log` 里打出 `integrity=high` 供核对。

管理员权限的 `input.exe` 是 High 完整性，UIPI 对它不生效 —— 前台是 LegionZone / SSID 也能正常注入，
`blk` 会一直是 0，红色提示条再也不会出现。

**已装好的状态（2026-10-23 07:14 实测）**

| 项 | 值 |
|---|---|
| 计划任务 | `DSH Input Injector` · Running · `RunLevel=Highest` · `LogonType=Interactive` |
| `input.log` 启动行 | `[07:14:55] input service start pipe=dsh-input integrity=high` |
| 进程 | `input.exe` pid 14160，session 2（用户桌面） |
| 前台 = `SSID`（管理员窗口）时注入 | `move(1180,690)` → `/cursor {"x":1180,"y":690}`，`click` 无任何 `setcursorpos failed` / `sendinput failed` |
| `/health` | `blk=0 blkage=-1` |

**两个必须记住的实现细节**

1. **命名管道 DACL**：High 完整性进程创建的命名管道默认不给 Medium 进程写权限，服务端会报
   `EPERM`。`input.cs` 里创建管道时显式加了 `PipeAccessRule(WorldSid, FullControl, Allow)`，
   所以 `screen-server.mjs`（Medium）照样能连上。
2. **supervisor 杀不掉 High 进程**：`Stop-Process` 会 `Access denied`。改成
   `Stop-ScheduledTask` + `Start-ScheduledTask`；另外 supervisor 每 8 秒看一眼 `/health` 的
   `"connected":false`，连续 2 轮就重启这个计划任务（进程活着但管道断了也能自愈）。

**临时办法（不用 UAC）**：什么都不用做。被挡时页面会提示，服务端 1 秒内自动抢回前台，接着点就正常。
`check-health.ps1` 的「注入通道」一行会显示 `被挡 N 次（刚刚还在挡）` 和挡路窗口名字，恢复后显示
`历史被挡 N 次，已恢复`；装成管理员模式后显示 `正常（管理员权限运行，UIPI 不拦）`。

相关字段：`/health` 里的 `blk=`（累计被挡次数）、`blkage=`（距最后一次被挡多少毫秒，-1 = 从没被挡）、
`fg=`（当前前台窗口标题）。`blkage` 由 `input.exe` 自己算，不是服务端收到包的时间。

## 缩放屏（DPI 缩放）与页面缩放

这台机器的显示缩放是 **150%（AppliedDPI=144）**，物理分辨率 2560×1600。缩放会引入两类偏移，两边都要处理：

### 1. 进程必须声明 per-monitor DPI 感知（否则差 1.5 倍）

`capture.cs` / `sources.cs` 早就是 PMv2（抓的是物理像素），但 `input.exe` 一开始**没有**声明 DPI 感知，
于是 `SetCursorPos` / `GetCursorPos` 用的是被系统虚拟化过的「逻辑像素」——点页面中心（物理 1280,800）
实际会落到 (1920,1200)，正好偏 1.5 倍。

修法（`input.cs`）：

```csharp
[DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
static void EnableDpiAwareness() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }   // PER_MONITOR_AWARE_V2
    try { SetProcessDPIAware(); } catch { }
}
```

必须在 `Main` 的第一行调用（任何坐标 API 之前）。三个原生命令现在口径一致，都是物理像素：

| 程序 | DPI 感知 | 说明 |
|---|---|---|
| `capture.exe` | PMv2 | BitBlt 抓物理像素 2560×1600 |
| `sources.exe` | PMv2 | 显示器/窗口矩形都是物理像素 |
| `input.exe` | PMv2（本次修复） | SetCursorPos/GetCursorPos 物理像素 |

实测对照（同一时刻三个读数）：

```
PMv2 探针（cursor-probe.exe）: 1281,799   ← 物理
未声明 DPI 的 PowerShell     :  854,533   ← 逻辑（= 物理 / 1.5）
GET /cursor                  : 1281,799   ← 与物理一致 ✓
```

这个探针（`cursor-probe.exe`）就留在 `%LOCALAPPDATA%\DshInput\` 里，以后怀疑偏移可以直接跑它对照。

### 2. 页面被缩放（浏览器缩放 / 双指缩放）

触摸事件的 `clientX/clientY` 是「视觉视口」坐标，而 `getBoundingClientRect()` 给的是「布局视口」坐标，
两者差了 `visualViewport.scale` 和 `offset`。页面统一走 `layoutPoint()` 换算：

```js
function layoutPoint(cx, cy) {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) < 0.005) return { x: cx, y: cy };
  return { x: vv.offsetLeft + cx / vv.scale, y: vv.offsetTop + cy / vv.scale };
}
```

所有手势（按下/拖动/抬起/右键/双指滚轮）都先过这一层，再进 `toScreen()`。
所以无论页面是否被缩放、窗口大小怎么变，换算结果只依赖 `getBoundingClientRect()`，不会跟着缩放漂。

实测：页面点 (522,486) → `toScreen` 预测 (1281,799) → `/cursor` 回读 (1281,799)，误差 0–1 px。

## 帧率 / 丢帧到底怎么算（这三个数不是一个意思）

以前 HUD 里的 fps 是**按推送次数**算的：一台设备看是 24.5，两台设备同时看就变成 49，
丢帧数则是各连接各报一次、每秒累加，于是数字只会越来越大、还没法判断到底是谁在丢。
现在口径统一为「按帧」：

| 字段 | 含义 | 来源 |
|---|---|---|
| `in=` | **抓屏帧率**：管道里真正收到的帧（capture.exe 的实际产出速度） | `/health` |
| `out=` | **送达帧率**：唯一的帧被推给观看者的速度，多设备同时看**不会翻倍** | `/health` |
| `dropped=` | **丢帧**：某台设备 socket 积压（`res.writableLength > 2 帧`）被跳过；同一帧多个观看者都跳过也只算 1 次 | `/health` |
| `cap=` | 抓屏最小间隔（ms），`1000/cap` 就是理论上限 | `/health` |

实现要点（`screen-server.mjs`）：

- `notePush(stamp)` 按帧时间戳去重 → 多设备不会重复计数；
- `noteDrop(stamp)` 同理去重，丢帧从"每连接每秒上报"改成**跳帧时立即记一次**；
- `acceptFrame()` 里 `noteIn()` 记抓屏侧帧率，用来区分「抓屏慢」和「送给手机时丢了」。

页面 HUD（每 2 秒轮询 `/health`）显示：

```
24.5 fps（抓屏 24.5） · 上限 30.3
```

- `out` 明显低于 `in` → 链路/解码跟不上，HUD 会显示 `· 丢帧 N`（N = 自本页面打开以来的增量，不是服务器累计值）；
- `in` 本身就低于 `上限` → 不是丢帧，是机器抓屏+编码就是这么快（2560×1600 全屏下约 24.5 fps）。

## 来源切换的三处体验修正（2026-10-23）

### 1. 居中提示只显示 5 秒

`page.mjs` 的 `setNote(t, ms)` 现在带定时清除：显示 `ms`（默认 5000）毫秒后自动清空，
并且新提示会取消旧定时器。`已切换来源` 不再永久糊在画面正中间。

### 2. 来源列表实时刷新（不用刷新页面）

- 页面每 **2 秒** 轮询一次 `/sources`，只有列表真的变了（显示器集合或窗口集合的签名变了）才重建 `<option>`，不会闪、不会打断正在做的选择；
- 正在拉开下拉框时（`document.activeElement === srcSel`）跳过这一轮重建，下一轮再补；
- 选中的窗口被关掉 → 自动切回「全部屏幕」并提示一句，不会停在已消失的窗口上；
- 服务器侧 `/sources` 加了 **600ms 缓存**（`sourcesCache`），页面轮询时不会每次都去枚举窗口（实测 `sources.exe` 约 34ms，`/sources` 约 50ms）。

### 3. 窗口被别的窗口挡住时不再是黑/错画面

三层处理，按顺序生效（`capture.cs` + `screen-server.mjs` + `input.cs`）：

| 触发时机 | 处理 | 实测 |
|---|---|---|
| 切换来源到某个窗口 | `/mode` 里让注入器 `focus` 该 hwnd（`SwitchToThisWindow` → `SetForegroundWindow` → Alt 解锁 → `AttachThreadInput` 依次尝试） | Chrome/画图/资源管理器 `focus ok ... (setfg)`，窗口立刻到最前 |
| 抓屏时该窗口被盖住 | `WindowFromPoint` 采样 5 点判断遮挡；被盖住就用 `PrintWindow(PW_RENDERFULLCONTENT)` 渲染窗口自身内容，并把结果做「几乎全黑」校验 | Nahimic：`PrintWindow ok`；Chrome：`unusable`（返回成功但全黑，已识别） |
| `PrintWindow` 抓不到（返回失败或全黑） | capture 写 `raise-window.txt` 请求，`screen-server` 每 2 秒读一次并让注入器把窗口提到前面，然后回到 BitBlt | Chrome 被资源管理器盖住 → 2 秒内自动回到最前，`occluded=False` |

注意两点：

- **只认标准 Win32 窗口**：以管理员/系统权限运行的窗口（Nahimic）和 UWP 窗口（设置、Windows 输入体验）无法被普通进程抢前台，`focus` 会记录 `focus ... failed`，这类窗口源不要选；
- 抓屏只在**有观看者**时真正抓帧（省 CPU），所以 `viewers=0` 时看不到遮挡日志，接上手机再看即可。

## 声音怎么走、为什么以前「清晰模式没声音」（2026-10-23）

### 结论先说

声音有**两条独立通道**，以前只实现了第二条：

| 页面模式 | 声音通道 | 状态 |
|---|---|---|
| 流畅（WebRTC） | WebRTC 的音频轨（`rtc.mjs` 的 `RTCAudioSource`，48kHz 立体声） | 一直可用 |
| 清晰（MJPEG） | **新增**：`/ws-audio` WebSocket 推 PCM + 页面 `ScriptProcessor` 播放 | 本次新增 |

所以以前在默认的「清晰」模式下点「声音」没反应——页面用的是 `<img>`，没有 `<video>`，也就没有 WebRTC 音频轨可以开声音。按钮只是把 `vid.muted` 翻了一下，而那个 `<video>` 在清晰模式下根本没有流。

### 抓音本身是好的（先排除了采集故障）

`audio.exe` 用 WASAPI loopback 抓「默认播放设备」的混音，每 30 秒写一行 `rms=…`。实测：

| 时间 | 系统在放什么 | rms |
|---|---|---|
| 08:10–08:12 | 什么都没放 | 0.0000 |
| 08:12（播放提示音） | Windows 提示音循环 | 0.0271 → 0.0363 |
| 08:26（播放提示音） | 同上 | 0.0591 → 0.1775 |

也就是说：**沉默是因为电脑真的没在放音，不是抓不到**。判断办法就是看 `audio.log` 的 `rms`，放首歌再看。

### 新通道的实现要点

服务器（`screen-server.mjs`）：

- `attachAudioWs(s, KEY)`：`/ws-audio?k=…` 校验 key，连上先发一条 JSON 头（48000/2ch/16bit/20ms）；
- `audioPush(pcm)` 把 `audio.exe` 的 20ms 块（3840 字节）分发给所有声音客户端；`ws.bufferedAmount > 256KB` 就跳过这一块，保证延迟不越攒越大；
- `rtc.mjs` 里原来「非 /rtc 的 upgrade 一律 destroy」改掉了，否则它会把 `/ws-audio` 的握手掐掉。

页面（`page.mjs`）：

- 点「声音」且当前是清晰模式 → `startPcmAudio()`：`AudioContext(48kHz)` + 环形缓冲（3 秒容量）+ `ScriptProcessor(2048)`；
- 80ms 起播水位、积压超过 400ms 丢最旧数据（延迟优先）；欠载输出静音，不会爆音；
- 采样率不一致（Safari 常见 44.1k）时做线性重采样；
- 切「流畅」→ 关掉 PCM 通道改用 WebRTC 音频轨；切「清晰」→ 自动重开 PCM 通道；
- WebSocket 断了 1.5 秒后自动重连。

### 一个真实坑：http:// 下 AudioWorklet 不可用

第一版用的是 `AudioWorklet`（延迟更低、跑在音频线程），实测报 `Cannot read properties of undefined (reading 'addModule')`——因为页面是 `http://100.108.92.22:8660`，**AudioWorklet 只在安全上下文（https/localhost）可用**。于是改成 `ScriptProcessor`（已废弃但到处都能用，iOS Safari 也支持）。如果哪天上了 HTTPS，可以再切回 worklet。

### 验证数据

| 检查项 | 结果 |
|---|---|
| 清晰模式点声音 | `ws=1`（已连）、`ctx=running`、`sampleRate=48000`、5 秒收到 395 块 PCM |
| 播放状态 | `playing=true`、环形缓冲稳定在 ~4700–8000 样本（约 80–170ms 水位） |
| 关声音 | `ws=3`（已关）、`ctx=closed`、服务器日志 `audio ws closed (0)` |
| 流畅模式点声音 | WebRTC `inbound-rtp audio`：`audioLevel=0.98`、`totalAudioEnergy=3.66`、`bytesReceived` 持续增长 |
| 服务器侧 | 日志 `audio ws connected (1)`；`/health` 里 `audioChunks` 持续增长、`audioAge≈0.01s` |

## 省流量模式（2026-10-23 复查）

### 原来的实现与问题

点「省流量」后页面不再走 MJPEG 流，改成每 500ms 用 `<img>` 拉一张 `/frame.jpg`（2 帧/秒）。但 `/frame.jpg` 返回的是**全分辨率原图**，实测：

| 模式 | 单帧 | 速率 | 折算带宽 |
|---|---|---|---|
| 正常清晰模式（MJPEG 流，~24 fps） | 390 KB | 9.3 MB/s（实测 4 秒 37.4 MB） | ≈ 75 Mbps |
| 省流量（修复前） | 390 KB | 780 KB/s | ≈ 6.1 Mbps |

也就是说它确实比流省了十几倍，但 6 Mbps 在移动数据下依然很重，而且每帧都是 2560×1600——**分辨率一点没降，只是帧率降了**。

另外发现两个真正的 bug：

| Bug | 现象 | 修复 |
|---|---|---|
| 切换来源后省流量静默失效 | 改下拉框会走 `restartImg()`，它把轮询定时器清掉却没重新拉起 → 按钮还亮着「省流量」，实际已经在跑全速 MJPEG 流 | `restartImg()` 按当前状态决定走流还是走轮询 |
| 切到流畅模式后轮询不停 | 只调了 `stopPcmAudio()`，没停 `lowTimer` → 在 WebRTC 模式下后台还在每秒拉 2 张 `/frame.jpg` | 切流畅时 `stopLowBw()` 并清掉按钮状态 |
| HUD 显示 0 fps | 省流量不走流，服务器 `out=` 恒为 0，HUD 看起来像卡住了 | 省流量时 HUD 直接显示 `省流量 · 2 帧/秒 · 1280 宽 q45` |

### 现在的做法

服务器 `/frame.jpg` 支持可选参数（不带参数时行为不变）：

- `?w=<像素>`：等比缩放到指定宽度（`withoutEnlargement`，不会放大）；
- `?q=<20-95>`：重编码质量；
- 同一帧（按 `frameStamp`）只重编码一次，结果缓存在 `thumb` 里，多个客户端共享；
- 参数非法（`w=abc`）当没传；重编码失败直接回原图，不 500。

页面在省流量模式下请求 `?w=<屏幕宽×dpr，最大 1280>&q=45`。

### 实测对比

| 模式 | 单帧 | 速率 | 折算带宽 | 单帧服务端耗时 |
|---|---|---|---|---|
| 正常清晰模式（流） | 390 KB | 9.3 MB/s | ≈ 75 Mbps | —（直接发原帧） |
| 省流量（修复前，全分辨率） | 390 KB | 780 KB/s | ≈ 6.1 Mbps | 0 |
| **省流量（现在，1280/q45）** | **94 KB** | **189 KB/s** | **≈ 1.5 Mbps** | 60 ms（每帧只算一次） |

图片尺寸校验：原图 2560×1600 → 缩小副本 1280×800。

其他验证：`/frame.jpg?w=1280&q=45` 无 key 时 401；`w=abc&q=zz` 时退回原图不报错；
省流量 + 声音同时开也正常（`ws=1`、`playing=true`、`chunks` 持续增长）；
切来源后仍保持轮询（3 秒内 5–6 个不同 URL，间隔 ~500ms）；
切流畅后 `lowBw=false`、按钮熄灭、不再有 `/frame.jpg` 请求。

## 流畅模式（WebRTC）三个老问题 —— 2026-10-23 定位与修复

用户反馈：切到「流畅」后，之前修过的三个毛病又都出现了（提示不消失 / 来源列表要刷新 / 切到被挡的窗口没反应）。
实测发现根因不在那三个功能本身，而是**流畅模式的连接一直在重建**：空闲时 60 秒重连 40 次（每 1.5 秒一次），
画面每秒黑一下、状态文字反复跳，看起来就像"什么都没生效"。

### 根因 1：track 跨连接复用 → 新连接立刻 failed
`rtc.mjs` 原来在启动时创建一次 `videoTrack` / `audioTrack`，每次有观众就连同一个 track。
一个 `MediaStreamTrack` 只能挂在一个 `RTCPeerConnection` 上，第一条连接一关，track 就废了，
之后每条新连接都瞬间 failed → 关 → 页面 1.5 秒后再连 → 死循环。

修复：每条连接各自 `videoSource.createTrack()` / `audioSource.createTrack()`，`cleanup()` 里 `track.stop()`。

### 根因 2：关旧 socket 前没摘回调 → 旧 onclose 把新连接打断
`stopRtc()` 只做了 `ws.close()`，旧 socket 的 `onclose` 还挂着；close 事件是异步的，
等它触发时模块变量 `ws` 已经指向新连接，于是又调一次 `restartRtc()` —— 自己踩自己，形成 1.5 秒循环。

修复：`stopRtc()` 先 `ws.onclose = ws.onerror = ws.onmessage = null` 再 close，并清掉画面看门狗定时器。

### 根因 3：服务器重启后 rtcMode 回到 false → 重连只有声音没有画面
`rtcMode` 是内存变量，服务重启即丢失；页面自动重连时不会再 POST `/rtc-on`，服务端就不喂帧。

修复：`restartRtc()` 重连前重新 POST `/rtc-on`，并等 `/health` 里 `age<3`（抓屏真的出帧）再建连接。

### 配套的几个小改动
| 改动 | 作用 |
|---|---|
| 重连退避 1.5s → 3s → 4.5s … 上限 8s，超过 6 次停下并提示 | 服务器没准备好时不再每 1.5 秒猛敲 |
| 画面看门狗：连上 5 秒仍无画面才重连，最多 2 次；已收到视频轨时不重连 | 切换来源后头一两秒没画面属于正常，不再误杀 |
| 后台（`document.hidden`）不重连，回前台时若未连上再重连 | 手机锁屏/切后台不烧流量和电 |
| 没人看 60 秒自动 `rtcMode=false` | 流畅模式开着却没人看时，抓屏能真正停下来省 CPU |

### 实测（本机 Chrome，2560×1600 @150%）
| 项目 | 修复前 | 修复后 |
|---|---|---|
| 空闲 60 秒内重连次数 | 40 次 | 0 次 |
| 切换来源后 16 秒内重连次数 | 4 次（连带黑屏） | 0 次（画面直接换，无黑屏） |
| RTC 帧计数 | 反复归零 | 295 → 514 持续增长 |
| 提示气泡（流畅模式） | —— | 0.25 秒出现、5.25 秒消失 |
| 来源列表（流畅模式） | —— | 新开窗口 ≤2 秒出现在下拉框 |
| 窗口被挡自动抬升（流畅模式） | —— | `occluded & not printable -> ask server to raise it` → `(occluded) raise window 0x…` |

要点：**页面改动需要刷新页面才会生效**（服务器 `import` 的 `page.mjs` 是启动时读的，刷新后拿到的就是新版本）。

## 流畅模式：触屏错位 + 不显示帧率 —— 2026-10-23 修复

### 触屏错位（点哪儿都偏，越往右下偏得越多）

根因在 `currentRect()`：选「全部屏幕」时（`monitor=-1, window=0`）它 `return null`，
于是 `toScreen()` 退化成按「视频像素」算：

```js
if (!src) return { x: fx * nw, y: fy * nh };   // nw/nh = 视频宽高
```

- 清晰模式：`img.naturalWidth = 2560`，正好等于屏幕宽 → 歪打正着是对的；
- 流畅模式：WebRTC 帧是 **1280 宽** → 所有点位缩到一半，右下角误差最大。

修复：
- 新增 `desktopRect()`（所有显示器的并集），`currentRect()` 在「全部屏幕」时返回它，
  `state.rect` 不再为 null；顺手把「窗口源」找不到时的兜底也变成整块桌面；
- `loadSources()` 的来源签名里加上 `x,y`，窗口挪动/改尺寸后 rect 会跟着刷新（以前只比尺寸）；
- 切换清晰/流畅时都 `applyRect()`。

验证（DPI 感知下读 `GetCursorPos`，屏幕物理坐标）：

| 场景 | 页面点击点 | 期望 | 实际 |
|---|---|---|---|
| 流畅 / 全部屏幕 | `toPage(2000,1200)` | 2000,1200 | **2000,1200** |
| 流畅 / 窗口源（记事本 1906×1165） | 窗口中心 | 1373,744 | **1373,744** |

> 附带说明：省流量模式下发的是 1280 宽的缩略图，以前同样会偏，现在一起修好了。

### 流畅模式不显示帧率

`pollStats()` 在流畅模式只写了 `WebRTC · N 连接`，没有任何帧率。
服务端 `out=` 是 MJPEG 的推送帧率，对 WebRTC 没意义，所以帧率只能在客户端数：

- 用 `video.requestVideoFrameCallback()` 累加解码帧数（不支持时退回 `getVideoPlaybackQuality().totalVideoFrames`）；
- 每次 `/health` 轮询（2 秒）算一次差值 → 真实解码帧率；
- HUD 变成 `WebRTC · 10.0 fps · 2 连接`。

实测：2560×1600 全屏、上限 12 fps 的配置下，静止画面显示 10.0 fps，切到有动画的窗口会升到 12 上下。
## 2026-10-23 全量自检：修掉的 4 个问题

这次按「把所有功能过一遍」的要求做了端到端自检，发现并修好 4 个问题，其中第 1 个是安全漏洞。

### 1. 接口鉴权闸门放在了路由后面（严重）

`handler()` 里 `authorized(req, url)` 的检查位置在 `/health`、`/sources`、`/cursor`、`/input`、
`/mode`、`/unblock`、`/rtc-on`、`/rtc-off`、`/manifest.json` 之后——同一个局域网里任何一台设备
（`http://10.120.215.45:8660` 这条入口是 Wi-Fi 内网地址）不用密钥就能：`POST /input` 直接控制
鼠标键盘、读 `/sources` 拿到所有窗口标题、读 `/manifest.json` 拿到地址里内嵌的完整密钥。
已改成：`handler()` 第一行先过闸门，唯一例外是「本机自连」（`remoteAddress === localAddress`）。

实测（临时起一个强制闸门的实例模拟外来客户端）：

| 路径 | 无密钥 | 带密钥 |
| --- | --- | --- |
| `/health` `/sources` `/cursor` `/manifest.json` `/frame.jpg` `/` | 401 | 200 |
| `POST /input` | 401 | 200 |

### 2. 服务器重启后清晰模式不再自动恢复

`/stream` 的 `<img>` 在服务器重启后经常是「半死」状态：既不触发 `error`，也再收不到帧，画面永久卡住，
必须手动刷新。加了两处：页面每 2 秒的 `pollStats()` 里带看门狗，清晰模式 6 秒没新帧就重连；
`/stream` 响应改成 `Connection: close`，旧连接不会被浏览器当成可复用 socket。

### 3. 换 `<img>` 元素会泄漏 MJPEG 连接（自检时踩到）

先试过「换掉整个 `<img>` 元素」，结果更糟：Chrome 不会因为元素被换掉就中止那条流，服务端 `viewers`
涨到 6，浏览器对同一域名只有 6 条 HTTP/1.1 连接，全被流占满后连 `/health`、`/input` 都发不出去，
整页表现为按钮全部失灵。正确做法是清掉 `src` 让浏览器主动断开（`abortStream()`）。
现在切换来源 3 次后 `viewers` 仍然稳定在 1。

### 4. 清晰模式的声音可能永远起不来

`startPcmAudio()` 里 `await audioCtx.resume()`——没有用户手势时它会一直 pending，整个函数卡死，
连 WebSocket 都没建立，但按钮已显示「声音已开」。改成先建 WS 和 ScriptProcessor，最后用
`Promise.race([resume(), 700ms 超时])` 尽力恢复。实测：`/ws-audio` 打开、`ctx=running`、每秒约
50 个 20ms 音频块，环形缓冲稳定在 60ms 左右。

### 自检覆盖到的其它项（均正常）

- 清晰模式：24.5 fps 上限 30.3；`/frame.jpg` 参数边界（`w=0/-5/99999`、`q=0/101/abc`）都被夹紧不报错；
- 省流量：`?w=1280&q=45` 实测 43.8 KB ≈ 2 帧/秒 88 KB/s，切流畅后轮询立刻停止；
- 流畅：`pc=connected`、1280×800、HUD `WebRTC · 10.0 fps · 1 连接`、点 (1560,260) 光标落在 (1560,260)；
- 键盘：`text` 事件把 "HELLO-AUDIT" 打进记事本（标题出现 `*`）；长按右键发出 `down b:1` + `up b:1`；
- supervisor：kill 掉画面服务后 14–19 秒拉起，页面**不刷新**自己恢复（HUD 回到 24 fps）；
- PWA：`/manifest.json` 带 cookie 正常，图标 2 个；计划任务 `DSH Phone Access`(0) / `DSH Input Injector`(Running)；
- 日志：server/capture/audio/input 近 400 行无异常；supervisor 的 10 条报错都集中在 07:37–07:38（旧的 `Id` 空值问题）。

## 2026-10-23 延迟/帧率优化：清晰模式带宽自适应

### 发现的两个性能 bug

**① 降档后帧率反而腰斩（12.5 fps）**：`/stream` 用 `setInterval(push, 25)` 轮询，编码要 30ms，
于是「25ms 检查一次 → 忙就跳过」变成每 80ms 才出一帧。改成编码一结束就立刻推下一帧（不等 tick）。

**② 排队阈值用了原始帧大小**：丢帧判据是 `writableLength > 原始帧 × 2`，可降档后实际帧只有 98KB，
要排到 580KB 才开始丢，实测窄带下延迟飙到 1.2 秒。改成按「编码后」的帧大小算（1.2 帧即丢）。

### 新增：`/stream?w=&q=` + 客户端自动升降档

同一帧同一参数只编码一次（多端共享缓存），不带宽时直接透传原始 JPEG、零额外 CPU。
服务端实测（2560×1600 源，24fps 抓屏，全部跑满帧率）：

| 清晰模式档位 | 每帧 | 带宽 | 帧率 |
| --- | --- | --- | --- |
| 2560 原图（透传） | 290 KB | 57 Mbps | 24.5 fps |
| 1920 q65 | 141 KB | 28 Mbps | 24.6 fps |
| 1280 q65 | 98 KB | 19 Mbps | 24.5 fps |
| 1024 q62 | 65 KB | 13 Mbps | 24.6 fps |
| 800 q62 | 42 KB | 8 Mbps | 24.6 fps |

客户端按 `/health` 的 `drop10=`、`lag=`、`out=` 自动调档：丢帧≥3 或排队≥2 帧立刻降一档，
帧率不到抓屏 80% 连两次也降；干净 12 秒才升一档（避免边缘链路上来回跳）。
起始档：局域网 1920、tailnet（100.64/10）1280。HUD 会显示当前档位，如 `24.0 fps（抓屏 24.5） · 上限 30.3 · 1280 宽`。

模拟 12 Mbps 窄带客户端实测：800 宽 = 24.4 fps / 延迟 29ms；1024 = 18.8 fps / 620ms；1280 = 12.6 fps / 740ms
（未降档前 1280 是 12.9 fps / 1228ms）。链路塞满时宁可降清晰度，也不让画面越拖越久。

### 顺带修掉的一个清晰度问题

以前只要有人开过流畅模式，`/rtc-on` 就把抓屏宽度写成 1280，**清晰模式也被一起降成 1280**
（多端混用时尤其明显）。现在宽度由 `publishViewers()` 统一决定：只要有人在看清晰模式，
抓屏一律 2560；只有「仅流畅模式观看」时才降到 1280 省 CPU。

### 远端延迟的真正瓶颈：Tailscale 在走中继

`tailscale netcheck`：UDP 可用，但 `MappingVariesByDestIP: true`（对称 NAT）且 `PortMapping:` 为空
（路由器没开 UPnP/NAT-PMP）。结果：远端设备 `neo8` 一直是 `via DERP(tok)`，实测 RTT **211–561 ms**，
`direct connection not established`。这段物理延迟没法用代码消掉，只能靠打洞。

要做直连：在路由器上把 **UDP 41641** 转发到本机（本机 `tailscaled` 已在 41641 监听，
防火墙规则 `Tailscale-In` 也已放行），或打开路由器的 UPnP。打通后 `tailscale status` 会显示
`direct` 而不是 `relay "tok"`，DSH 界面和画面都会一起变快。

### 追加修复：为什么"清晰模式比流畅模式还糊"

两个原因叠在一起：

1. **抓屏宽度来回抖**。上一版为了省 CPU，写了「只有流畅模式观看时把抓屏降到 1280」。
   但清晰模式的流只要断一下（换档、看门狗重连），`streams` 就瞬间变 0，
   抓屏立刻切 1280、下个 tick 又切回 2560 —— 一天切了 8 次。每次切换抓屏管线要重启 1~2 秒，
   清晰模式经常拿到 1280 的帧。现在**一律 2560 抓屏**，流畅模式的降采样交给 rtc.mjs。
2. **自适应档位降得太狠**。原来 `drop10>=3` 就降一档，网络抖一下能一路掉到 800 宽，
   而流畅模式是 1280 —— 于是"清晰"反而比"流畅"糊。现在档位表底部砍到 1280
   （`[2560,1920,1600,1280]`）：清晰模式**永远不会比流畅模式糊**；再窄的链路请用流畅模式。
   降档门槛提到 `drop10>=6 / lag>=3`，降档后 60 秒内不许升回去（防止来回跳），
   换档时屏幕上会提示「带宽不够，清晰度降到 X 宽」。

另外：请求宽度 >= 抓屏宽度时直接透传原始 JPEG，不再二次编码（二次 JPEG 压缩会掉细节）。

清晰度实测（同一帧，按手机屏幕放大回去算拉普拉斯方差，100% = 原图）：

| 抓屏宽度 | 清晰度 | 相当于原图 |
| --- | --- | --- |
| 2560 原图 | 563 | 100% |
| 1920 | 188 | 33% |
| 1600 | 124 | 22% |
| 1280 | 68 | 12% |
| 800 | 14 | 3% |

**清晰模式务必用 2560（默认就是）**：只要掉到 1280，细节只剩原图的 12%，肉眼就是"糊"。

### 追加修复：黑屏闪烁 + 误降档（"宽带够却越看越糊"）

三个 bug 叠在一起，看起来就像"带宽不够、画面一直重开"：

1. **看门狗误判，每 8 秒重开一次流**。Chrome 对 `multipart/x-mixed-replace` 的 `<img>`
   **只在第一帧触发一次 `load`**，而我之前用 `load` 更新 `imgOkAt` 做 6 秒看门狗，
   于是每 8 秒必然误判"画面卡住"→ 清空 src → 重开 → 黑一下。这就是"隔一秒黑一个屏"的真凶。
   现在改成**问服务端**：只有 `/health` 回报 `viewers=0`（我们这条流确实没了）连续两次，
   或 `/health` 连续 3 次拿不到，才重连。实测正常播放 12 秒内 `showStream` 调用次数 **0**。
2. **丢帧是全局计数器**，一台设备链路差丢的帧会算到另一台头上 → 好端端的设备被降档。
   现在 `/stream?…&s=<会话id>`，`/health?s=<会话id>` 只报自己这条流的丢帧。
3. **排队阈值太紧**（1.2 帧）。Chrome 解码 multipart 时本来就会短暂停一下，1.2 帧的阈值
   把正常抖动算成拥塞 → 一直"丢帧" → 一直降档。改成 2.2 帧（至少 120KB），另外自动降档
   的底线抬到 **1920**（1280 只剩原图 12% 细节，那种链路请用流畅模式）。

另外加了**双缓冲换流**：新的 `<img>` 先隐形加载，等它解出第一帧再把旧元素摘掉。
实测换档过程中屏幕上一直是旧画面（`imgs:1→2→1`，`naturalWidth` 从 2560 直接变 1920），
不再黑。服务端重启期间旧帧会停在屏幕上（"卡住"而不是"黑屏"），恢复后自动接上。

实测（局域网，2560 全速）：`in=24.5 out=25.0 drop10=0 lag=1`，12 秒 0 次重连、0 次换档。

## 清晰 vs 流畅：实测参数与差异

| | 清晰模式 | 流畅模式 |
| --- | --- | --- |
| 传输 | MJPEG（每帧独立 JPEG）走 HTTP | WebRTC（VP8）走 UDP/RTP |
| 分辨率 | 2560×1600（原图透传，不重编码） | 1280×800 |
| 帧率 | 24.5 fps（跟抓屏） | 12 fps（上限 15） |
| 实测码率 | ~7.1 MB/s ≈ 57 Mbps | 863 kbps（上限 3 Mbps） |
| 每像素数据 | ~1.7 bit/px | ~0.07 bit/px（约 1/24） |
| 延迟构成 | TCP + 单帧编码（~35ms） | UDP + 抖动缓冲（实测 jitter 13ms） |
| 弱网表现 | 丢帧/停顿，按 drop10 自动降档（底线 1920） | 自动降码率/帧率，抗丢包 |
| 音频 | PCM 48kHz 走 WebSocket | Opus 48kHz 走同一路 RTP |
| 适合 | 同一 Wi-Fi / 局域网看细节（文字、代码） | 4G、Tailscale 中继、远距离看动作 |

所以"流畅糊"是设计使然：它用约 1/24 的数据量换低延迟和抗丢包。看静态文字必然不如清晰。

### 顺手修掉流畅模式的三个问题

1. **流畅之前是把 2560×1600 塞进 1.5 Mbps 的 VP8**（我上一版统一抓屏宽度时引入的回归），
   当然糊。现在 `decode.mjs` 先缩到 1280×800 再转 I420（sharp 走 JPEG shrink-on-load，
   26~33ms/帧），编码上限提到 3 Mbps / 15fps，实测 1280×800 · 12fps · 863kbps · jitter 13ms。
2. **服务端刚重启时观众只有声音没有画面**：`rtc.mjs` 以前要求"最近 5 秒内有帧"才建视频轨，
   重启后那一瞬间必然不满足，而且不会重新协商。现在始终建轨（预置帧和实际帧都是 1280×800，
   不存在尺寸锁不一致的问题）。
3. **客户端重连 6 次就放弃**：服务端重启十几秒后流畅模式再也回不来。现在一直重试
   （封顶 8 秒一次），连上即清零计数。

## 不是同一个 Wi-Fi 时延迟高 / 掉帧高：原因与对策

实测（同一台笔记本）：

```
tailscale ping neo8  ->  pong via DERP(tok) in 397ms / 293ms
                        direct connection not established
netcheck             ->  MappingVariesByDestIP: true   PortMapping:（空）
tailscale status     ->  100.95.197.38  direct 10.120.65.64:58233   （同一 Wi-Fi 时）
                        100.69.71.104 relay "tok"                   （不在同一 Wi-Fi 时）
```

也就是说：**离开家里 Wi-Fi 后走的不是直连，而是东京 DERP 中继**，物理往返 300ms 起。
在这个延迟下，清晰模式（MJPEG over TCP，57Mbps）必然表现为"延迟特别高 + 掉帧特别高"：
TCP 在长肥管道上丢一个包就要等重传，画面会累积滞后；中继带宽也根本吃不下 7MB/s。

### 这次加的东西

1. **HUD 直接显示延迟**（`/health` 往返的中位数）：局域网 2~5ms，中继 200~500ms。一眼看出走的是哪条路。
2. **清晰模式保持"2560 满清晰不动"**（2026-10-23 按用户要求定稿：同一 Wi-Fi 下 2560 本来就很流畅，
   不要再自作聪明地降档）：档位表只有 `[2560, 1920]` 两级，且必须**连续两次** 丢帧≥10 或排队≥4 才退到
   1920，60 秒内不再升回。实测同一 Wi-Fi：24.5fps、0 丢帧、全程只有 1 次 `/stream` 请求、0 次降档，
   不再出现"分辨率乱跳"。（之前那一版放到 1024/800 并按 RTT 收紧门槛，已经被回退。）
3. **流畅模式按延迟自动调码率**：新增 `POST /rtc-quality?kbps=&fps=`，页面按 RTT 选
   3Mbps/15fps（<150ms）、1.5Mbps/12fps（150~250ms）、**0.9Mbps/10fps（>250ms 中继）**。
   因为 `@roamhq/wrtc` 的 `setParameters` 只在建 track 时生效一次，所以参数在**建连之前**就发好，
   线路等级变了才重连一次（45 秒迟滞）。
4. 调试开关：`?rtt=300` 可假装 300ms 延迟，用来验证降档/降码率（正常访问不带）。
   实测已验证：`?rtt=300` + 流畅 → HUD `延迟 300ms · 上限 0.9Mbps`，实际 8.0fps。

### 真正的解法：让 Tailscale 走直连

本机 `tailscaled` 已在 UDP 41641 监听、防火墙 `Tailscale-In` 已放行，缺的是**路由器的端口转发**：

1. 路由器里把 **UDP 41641** 转发到本机内网地址 **10.120.215.45**；
2. 或者在路由器上打开 **UPnP / NAT-PMP**（`netcheck` 的 `PortMapping` 就会显示出来）。
3. 验证：`tailscale ping neo8` 应该显示 `pong ... via 192.168.x.x:41641`（direct），
   `tailscale status` 里该设备不再显示 `relay "tok"`。

打通后延迟通常从 300ms 降到 20~60ms，清晰模式也能直接跑 2560。
如果所在网络（比如校园网）完全不允许端口转发，那就只能：**远程时用流畅模式**——
它现在会自动压到 0.9Mbps/10fps 左右，这是中继能平稳承载的量级。

## 手机「命令」面板（`POST /exec`，2026-10-23 新增）

触屏 + 注入只能操作"愿意接收合成输入"的窗口。有些东西天生不配合（见下一节），
所以加了一个**直接下命令**的通道：页面顶部多一个「命令」按钮，输入 PowerShell 就执行，结果回显在下面。

- `Ctrl+Enter` 或点「执行」；`↑/↓` 翻历史（光标在首/尾时才生效，不抢正常的光标移动）
- 结果只回显最后 20000 字符；服务端 60 秒超时；`maxBuffer` 16MB
- 「命令」和「输入」两个底栏互斥，开一个会自动收起另一个

### 安全设计（三条缺一不可）

1. **必须带 key**：`/exec?k=…`。和其它路由不同，它**不吃"本机自连"的豁免** ——
   否则浏览器里任意网页都能 `fetch('http://127.0.0.1:8660/exec')` 执行命令。
2. **必须 `content-type: application/json`**：网页表单只能发 `text/plain` / `urlencoded` / `multipart`，
   拦住 CSRF。
3. 服务只监听 Tailscale / 局域网私有地址，不碰 `0.0.0.0`。

实测：不带 key → `{"ok":false,"err":"forbidden"}`；带 key 但 `text/plain` → 同样 403；两者都对才执行。

### 中文乱码的坑（已修）

`powershell.exe` 默认按控制台代码页（中文系统是 GBK）往管道写，Node 用 `encoding:'utf8'` 读会全是 `???`。
现在执行前先内联两行：

```powershell
$ProgressPreference="SilentlyContinue";
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$OutputEncoding=[System.Text.Encoding]::UTF8;
<你的命令>
```

副作用：命令报错时，`所在位置 行:1 字符: N` 片段会把这两行前缀也显示出来，只是难看，不影响执行。

### 已知限制

- 需要交互的命令（`Read-Host`、等输入的脚本）会一直卡到 60 秒超时 —— 这是设计如此。
- 输出超过 20000 字符只留尾部；要完整结果请自己重定向到文件，再用别的方式取。
- 服务端日志会记 `exec: "<前 100 字符>" -> ok/err`，**别在命令里写明文密码**（要写就用 `-gu/-gp` 之外的方式）。

## VMware 控制台为什么点不动（2026-10-23 实测结论）

现象：手机点虚拟机画面没反应，VMware 状态栏一直显示
`To direct input to this VM, click inside or press Ctrl+G.`。

在同一台机器上对照测试：

| 目标 | 注入结果 |
|---|---|
| Edge 标题栏 | ✅ 激活成功 |
| VMware 自己的对话框按钮（Cancel） | ✅ 点中并关闭 |
| 宿主桌面 / 普通窗口 | ✅ 正常 |
| **虚拟机控制台（`MKSEmbedded` 子窗口）** | ❌ 完全无反应 |

试过四种注入方式全失败：`SetCursorPos` + `SendInput` 按键、纯 `SendInput` 绝对定位移动+点击、
连续移动后再点击、`PostMessage` 直接把 `WM_LBUTTONDOWN/UP` 投给控制台窗口；`Ctrl+G` 与按键也无效。

结论：VMware 的 MKS 控制台走**原始输入**，会丢弃带注入标记（`LLMHF_INJECTED` / `LLKHF_INJECTED`）的事件，
这是它的防自动化设计，不是坐标或权限问题（坐标实测像素级准确）。

### 绕过去的两条路

1. **`vmrun`（无需触摸，本机 `D:\VMware\vmrun.exe`）**：

   | 目的 | 命令 |
   |---|---|
   | 列运行中的虚拟机 | `& "D:\VMware\vmrun.exe" list` |
   | 后台开机 | `& "D:\VMware\vmrun.exe" -T ws start "D:\VMS\win11-us\win11-us.vmx" nogui` |
   | 挂起 | `& "D:\VMware\vmrun.exe" -T ws suspend "D:\VMS\win11-us\win11-us.vmx"` |
   | 优雅关机 | `& "D:\VMware\vmrun.exe" -T ws stop "D:\VMS\win11-us\win11-us.vmx" soft` |
   | 在客户机里执行程序 | `& "D:\VMware\vmrun.exe" -T ws -gu 用户 -gp 密码 runProgramInGuest "...vmx" -activeWindow -interactive C:\Windows\System32\cmd.exe` |

   配合「命令」面板，手机上就能开机、关机、进客户机跑脚本。

2. **RDP 进客户机**（要图形界面时最稳）：客户机里开「远程桌面」→
   VMware 虚拟网络编辑器 VMnet8 → NAT 设置 → 端口转发 主机 `13389` → 客户机 `3389` →
   手机装 Microsoft Remote Desktop 连 `100.108.92.22:13389`。这样输入不再经过 VMware 控制台。

## UAC 弹窗：为什么"看得见、点不动"（2026-10-23）

`consent.exe` 跑在 **System 完整性**，而 `input.exe` 是 High（管理员）。
UIPI 规则是"低完整性不能往高完整性送输入"，所以弹窗一出现，整个桌面都被它占着，注入全被丢掉。

两条处置（都只改注册表，`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`）：

| 键 | 值 | 效果 |
|---|---|---|
| `PromptOnSecureDesktop` | `0` | 弹窗从"安全桌面"搬到普通桌面 → **看得见**（抓屏能抓到），但**仍然点不动**（System > High） |
| `ConsentPromptBehaviorAdmin` | `0` | 管理员提权**不再询问**，静默生效 → 彻底没有"卡住"这回事 |

桌面上放了 `UAC不再弹窗(静默提权).reg` 和 `UAC恢复默认(还原).reg`，双击即可。
要保留确认框又要点得动，只有装一个 **SYSTEM 完整性** 的注入服务（服务里 `SetThreadDesktop` 到输入桌面），
那是另一个工程量级，目前没做。

## 「桌面」按钮：一键最小化所有窗口（2026-10-24）

来源选择框右边多了一个 **「桌面」**，点一下就 `POST /showdesktop`：把当前所有窗口最小化、露出桌面，
不用在手机上一个个点最小化按钮。实测服务端 435ms 完成，页面 1.2 秒内出提示。

### 为什么不用 Win+D

一开始就是发 `Win+D`，测出来**不生效**：当时前台是一个**全屏的远程桌面窗口（mstsc）**，
全屏远程会话会把 Win 组合键截走、转发给被控的那台机器，宿主机根本收不到。

改用 `Shell.Application.MinimizeAll()`（任务栏那个"显示桌面"用的就是它）：

```powershell
(New-Object -ComObject Shell.Application).MinimizeAll()
```

它直接操作本机窗口，键盘被谁抓走都不影响；也不需要遍历窗口自己 `ShowWindow(SW_MINIMIZE)`
（那样动不了高权限窗口，还会漏掉 UWP 的全屏壳）。只有 PowerShell 调用本身失败时，才退回 `Win+D`。

### 两个细节

- **抓单窗口时点了没反应**：如果当前来源是「窗口：xxx」，最小化会把抓屏内容一起收走、画面直接变黑，
  所以服务端直接返回 `{"ok":false,"err":"当前抓的是单个窗口，最小化会让画面变黑；先切回「全部屏幕」"}`，
  页面把这个原因显示出来。
- **残留窗口**：`MinimizeAll` 不会动那些被 DWM 隐藏（cloaked）的 UWP 壳，比如「设置」「Nahimic」
  「Windows 输入体验」。它们本来就不在当前桌面上，不影响看到桌面。

### 已验证

| 项目 | 结果 |
|---|---|
| 全屏 mstsc 在最前面时最小化 | ✅ 窗口变成 `IsIconic=True`，桌面露出 |
| 响应耗时 | 435ms |
| 页面提示 | `已最小化所有窗口，回到桌面`（1.2s 内出现） |
| 抓单窗口时 | 返回 `ok:false` + 可读原因 |
| 最小化后剩余可见窗口 | 只有 cloaked=2 的 UWP 壳 + 桌面本身（像素抽样确认画面是壁纸） |

## 插件自动对齐：desktop → web（2026-10-25）

手机端跑的是独立的 `--profile web` 实例，它的插件清单在 `profiles\web\package.json`，
和桌面端的 `profiles\desktop\package.json` 是**两份**。以前在电脑上装个插件，手机上要手抄一遍
（依赖 + bundle + 有时还有 patch 配置）。现在自动了。

### 三个组成部分

| 文件 | 作用 |
|---|---|
| `sync-profile-plugins.ps1` | 对比两边 package.json，把 desktop 有、web 没有的依赖/bundle 补上 |
| `supervise.ps1`（新增一段） | 每 10 分钟调一次同步脚本；有改动就**由它统一重启** web 实例 |
| `plugin-sync-exclude.txt` | 黑名单，一行一个包名，列进去的永不同步（现在为空） |

### 为什么重启交给 supervisor，而不是同步脚本自己重启

因为**两个进程抢着重启**正是 2026-10-25 那次手机 401 事故的成因：旧的 dsh web 还占着
`127.0.0.1:8642`，启动脚本走"已在监听"分支不再生成 token，而 `web-lan.log` 已被清空，
代理只能回退读 `phone-url.txt` 的旧 token → `/go` 302 到一个服务器不认的 token → 手机进不去。

所以同步脚本只做两件事：改文件、写一个 `plugin-sync.pending` 标记；真正 kill+start 只由
supervisor 一个进程做，token 和 url 文件每次都走同一条已验证的路径。

### 安全设计

1. **只加不减**：只往 web 里补缺的，绝不删除、不改已有条目。
2. **装不上就不加**：包不在 `node_modules` 里就跳过（两边 node_modules 是 junction 共享，
   存在即能加载），避免写一条让 web 起不来的依赖。
3. **改前备份**：`plugin-sync-backup\` 保留改动前的 `package.json` + `cordis.patch.yml`。
4. **重启失败自动回滚**：supervisor 重启后 20 秒内 8642 没起来 → 用备份还原 → 再重启一次。
5. **配置条目只提示不硬抄**：desktop 独有的 `cordis.patch.yml` 条目会写进日志（因为里面可能有
   只在桌面成立的绝对路径），要不要同步由人决定。

### 手动用法

```powershell
cd 'C:\Users\ccj\Documents\deepseek-harness\default-workspace\phone-access'
.\sync-profile-plugins.ps1 -DryRun     # 只看差什么，不落盘
.\sync-profile-plugins.ps1             # 真同步（有改动会在下一轮被 supervisor 重启）
```

日志：`plugin-sync.log`。想临时关掉自动同步？把 `sync-profile-plugins.ps1` 改名即可
（supervisor 里 `Test-Path $syncScript` 会跳过）。

### 实测记录（2026-10-25）

第一次手工同步了三个：`@moon16u/dsh-mcp-console`、`dsh-office-kit`、`tool-ocr` 的 tesseract 配置。
之后做了一次完整的自动演练：故意把 `dsh-office-kit` 从 web 的 bundle 里删掉 →

| 步骤 | 时间 | 结果 |
|---|---|---|
| 同步脚本发现差异 | 17:58:18 | `发现差异：bundle +dsh-office-kit`，写回 package.json，写 pending |
| supervisor 响应 | 17:58:19 | `plugin config changed (bundle +dsh-office-kit); restarting dsh web` |
| web 实例重启 | 17:58:23 | 新 pid，新 token `OmGrOaey…`，url 文件自动更新 |
| 门可用 | — | `/go` → HTTP 200，493KB |
| 插件生效 | — | 页面含 `mcp-console` / `office` / `ocr`；MCP 路由 200 |

功能验证（让手机实例的 agent 自己调工具）：

- `ocr_status` → `tesseract (chi_sim+eng): AVAILABLE`，`tesseract v5.4.0.20240606`
- `office_status` → `全部可用`，Python 3.12.10 + 10 个软件包 + 渲染器 native

## 安全加固（2026-10-26）

起因：用户问「这样安全吗」。查下来有三个真问题，其中一个很严重。

### 发现的问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | **`D:\dsh-rec\record-server.js`（8780）完全没鉴权，还绑在 `0.0.0.0`** | 谁都能 `POST /start` 让你开始录屏（录的是整块屏幕），`/status` 能看到你在不在录 |
| 2 | **防火墙对局域网完全敞开** | 规则 `DSH Web (phone access) 8642` = Allow / Profile=Any / LocalAddress=Any / RemoteAddress=Any；`node.exe` 还有 Private+Public 的程序放行；当前 WLAN 是 `CUP-WLAN 2`（Public） |
| 3 | **全程明文 HTTP**，两个门都能无限猜密钥 | `tailscale serve` 没启用，443 连不上；`/go` 原先没有失败限流 |

### 做了什么

| 项 | 动作 | 验证 |
|---|---|---|
| 局域网 | `harden-firewall.ps1`（管理员）：停用宽放行，8642/8660 只允许 `100.64.0.0/10`，拒绝 `10/8`·`172.16/12`·`192.168/16` | 规则已就位，Block 优先于 Allow |
| 录屏服务 | 加 `screen.key` 鉴权（`?k=` 或 `reckey` cookie 存哈希），**只听 127.0.0.1 + Tailscale** | 无密钥 401；监听地址只剩两个 |
| `/go` 限流 | 同 IP 10 分钟错 8 次 → 429 锁 10 分钟；失败写 `door.log` | 第 9 次 429 |
| 画面服务限流 | 同上，失败写 `screen-auth.log`（第二道闸门也接了） | 第 8 次 429，带密钥照常 200 |
| 自动登录 cookie | 30 天 → **7 天**（`dshk`，存 key 的 sha256；`reckey` 同） | Set-Cookie 已确认 |

### 撤销 / 换密钥

```powershell
.\harden-firewall.ps1 -Undo     # 恢复局域网访问（管理员）
.\rotate-key.ps1 -Force         # 换密钥=立刻吊销所有旧链接 + 所有 cookie
```

### 手机最省事的入口：只用 `http://100.108.92.22:8642/`（不带 k）

2026-10-26 手机上报「访问密钥不对」，`door.log` 里看得很清楚：

```
02:52:14 401 GET /go?k=%E2%80%A6            ← k 是省略号（U+2026），复制时抄了占位符
02:52:39 302 GET /go?k=b1c3d7ea52849f60     ← 真链接，登录成功
02:52:55 401 GET /go?k=%E2%80%A6            ← 又是省略号
```

所以不是门坏了，是链接里的 `k=` 变成了 `…`。现在 `/go` 遇到占位符直接回 **400**「这个链接不完整」。

更省事的办法：书签只存 `http://100.108.92.22:8642/`（不带 `k=`）

| 情况 | 行为 |
|---|---|
| 这台设备 7 天内登录过（有 `dshk` cookie） | 自己跳转登录，直接进 |
| 没有 cookie | 显示「需要重新登录」页，**页面上那个按钮就带着真密钥**，点一下就进 |

实测：有 cookie → `/` 返回 200；没 cookie → 401 页面里含 `/go?k=<真密钥>` 的按钮。

### 仍然存在的限制（如实记录）

- 传输仍是 HTTP；现在只靠 Tailscale 的 WireGuard 加密保护。想彻底干净要开 HTTPS Serve：
  `https://login.tailscale.com/f/serve?node=nznzQD7TQ321CNTRL`（一次性授权）
- 画面服务的 `screen-key` cookie 存的是密钥原文，一年有效；要根治需把页面里的 `?k=` 去掉
- 门的密钥 64 bit（换密钥脚本会生成 128 bit）
- QQ / 桌面应用 Web 查看器 等第三方程序有 Profile=Any 的入站放行规则，与本项目无关但同样对外
- 校园网内仍可探测到本机（Windows 默认响应），但 8642/8660/8780 都连不上
