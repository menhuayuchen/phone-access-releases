# STATUS · 手机远程控制产品 交接文档

> **新会话第一件事：读这个文件。**
> 读完你应该知道：产品是什么、现在能不能用、哪里是坏的、下一步做什么、怎么验。
>
> 最后更新：2026-10-30

---

## 一、这是什么

Windows 上的自建产品：**客户用自己手机，看自己电脑的屏幕并操作它**。
走 Tailscale 私有网络，不经过任何第三方服务器。装一次，永久使用。

**商业形态**：卖家（本人）交付安装包 + 签发许可证。客户用自己的 Tailscale 账号。
**卖家进不去客户电脑**——技术上到不了，这是核心卖点。
**2026-10-29 起半免费**：不装许可证也能用（画面/触控/声音/流畅/高清/标准全免费），
许可证只解锁**超清不限时长**（免费每天 1 小时）+ **个性化**（主题/光标/自定义导入）。详见第十节。

---

## 二、现在能用的（都实测过）

| 功能 | 状态 | 怎么验 |
|---|---|---|
| 手机看画面 + 触控 | ✅ | 手机打开入口地址，画面在动、点一下光标真的动 |
| 许可证（贴短码 / 放文件） | ✅ | 设置（⚙）→「许可证」分区粘贴 → 生效后自动刷新（整屏遮罩已随半免费取消） |
| 一键卸载 | ✅ | 桌面「卸载」→ 输入 YES → 六步撤干净 |
| 一键重启 | ✅ | 桌面「重启」→ 三步全绿 |
| 画面质量档位（超清2560/高清1920/标准1440） | ✅ | 设置面板改 → 桌面「重启」→ 查 `capture.exe` 实际参数 |
| 半免费：未授权放行 | ✅ | 移开 licence.json → 页面照常打开、2560 出图、无遮罩（2026-10-29 实测） |
| 超清每日配额（服务端强制） | ✅ | `/health` 的 `uq=` 倒计时 → 耗尽后 frame.jpg 实测 1920、/stream 首帧 SOF 解析 1920 → 恢复许可证立即回 2560，无需重启 |
| 个性化（主题/光标/导入，许可功能） | ✅ | 未授权：控件 disabled、点击只出购买提示；已授权：切主题/18px 光标/自定义 JSON 导入/非法 JSON 拒绝，浏览器全过 |
| 收款码随包（branding\） | ✅ | ❤ 面板两图 `/branding/*.jpg` → 200 image/jpeg（FF D8 头）+ 联系.txt 邮箱电话 |
| 检查更新 | ✅ | 设置面板点「检查更新」；未配置更新源时提示"联系卖家" |
| PWA 装到手机桌面 | ✅（2026-10-30 修真机回归） | 手机浏览器「添加到主屏幕/安装应用」，图标是显示器+手机；**装的 App 打开必须能出画面**（10-29 的 start_url='/' 方案在安卓真机上 401，已修，见第十二节） |
| 客户机不出现 DSH | ✅ | 客户版 `enableDsh=false`，8642/8650 两扇门不启动 |

**当前实机状态**（2026-10-29 18:20，半免费改造部署后）：

```
capture.exe 宽度=2560 间隔=40ms      ← 超清抓屏
health: uq=na（本机已授权）           ← 未授权时=剩余秒数，耗尽=0:x
version=1.0.4  freemium.ultraFreeSecPerDay=3600
监听 8660 × 3 地址（回环+tailnet+局域网）
监听 8642 × 3 地址（8642 回环=DSH本体；tailnet/局域网=门）
配置 enableDsh=True（这台是卖家自用；客户版是 False）
```

**帧率基线**（2026-10-30 修正，详见第十三节）：2560 档（不缩放）实机 **24.7fps**（`in=24.5 out=24.0`），
抓屏受 CPU 限制（2560x1600 的 DWM 读回约 28ms 就是本机上限）。
**降档不提速**：旧 capture.exe 用 GDI+ HighQualityBilinear 做降档缩放（约 34ms），1920/1440 档反而只有
15.5/18fps；2026-10-30 改 Bilinear 后 1920≈20-22fps、1440≈22-24fps。

---

## 三、现在坏的（P0-2 未修；P0-1 已修）

**完整清单在**：`docs\独立审查包-第二轮\05-修复清单.md`（每条都有可执行验收标准）

### P0-1 · `/manifest.json` 泄露访问密钥 → **已修（2026-10-29 复核代码确认）**

```
screen-server.mjs 现状（改动处都带注释）：
  · /manifest.json 已进 STRICT_AUTH_PATHS（裸 GET → 401）
  · PWA 用页面渲染时现签的 1 小时短时 token 取清单
  · start_url 10-29 改为 '/'（靠 cookie 认证）→ 10-30 真机回归（安卓装的 App 不带 cookie，打开 401），
    改回 '/?k=<密钥>'——安全前提没变：清单在严格鉴权集合内，裸 GET 仍 401；页面 HTML/二维码本就含密钥（见第十二节）
  · LICENCE_OPEN_PATHS 已随半免费改造整体移除（402 闸门取消）
```

同清单的 P1-1（`/set-quality` `/update-check` 不在严格集合）也已修，两者都进了 STRICT_AUTH_PATHS。

### P0-2 · `DshInput` 目录提权（高危）

```
%LOCALAPPDATA%\DshInput\input.exe   用户可写
    ↑ 由 RunLevel Highest 的计划任务启动
    ↑ 还被加进 Defender 排除
```

用户级恶意代码替换 exe → 无 UAC 拿到管理员权限。

### 中低危（同一份清单里；前两条已修）

~~`/set-quality` `/update-check` 没进严格集合~~（已修） · 许可证 `null` 字段两端判定不一致 ·
`mine` 为空时跳过机器码比对 · `\n` 拼接歧义 · 快捷方式 `-FallbackScript` 缺失 ·
文案说 4 个图标实际 6 个 · `%TEMP%` 安装日志可能留密钥 URL · `uninstall.ps1` 按进程名杀会误杀

---

## 四、下一步做什么

**照 `docs\独立审查包-第二轮\05-修复清单.md` 做，P0-1 已完成，从 P0-2 开始。**

顺序不能乱：

1. ~~P0-1~~ **已修**（复核确认：manifest 进 STRICT_AUTH_PATHS + start_url='/' + 短时签名 token）
2. **P0-2 单独做**（挪到 `%ProgramFiles%` 或收紧 ACL）
3. 再 P1 → P2 → P3 → P4

**一次只做一条。** 上一轮连续改多条，出错时分不清是哪条导致的。

---

## 五、环境事实（不知道这些会反复踩坑）

### 编码硬规则（违反必出诡异错误）

| 类型 | 编码 | 备注 |
|---|---|---|
| `.ps1` | UTF-8 **带 BOM** | 无 BOM 时 PS 5.1 按 ANSI 读，中文注释会导致语法错 |
| `.mjs` / `.json` | UTF-8 **无 BOM** | 有 BOM 时 `JSON.parse` 会抛错 |
| `.cmd` | **纯 ASCII** | 一个中文字符都不能有，也不要 `chcp 65001` |
| `.vbs` | UTF-8 无 BOM | |

**`edit` 工具会去掉 BOM**，改完 `.ps1` 必须重新加：
```powershell
$t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true)))
```

### PowerShell 坑

- **不要给 `$pid` `$home` `$host` `$input` `$error` 赋值**
- PS 5.1 没有 `[datetime]::TryParse($s,[ref]$d)` 重载，用 `TryParseExact`
- **数组字面量里的 `+` 会吃掉逗号**：`@('a' + $x + 'b', 'c')` 只有一个元素，
  必须写 `@(('a' + $x + 'b'), 'c')`
- 读**无 BOM** 的文件时 `Get-Content`/`Select-String` 要显式 `-Encoding UTF8`
- **here-string 里的反引号是转义符**：写 markdown 代码块用 `~~~` 不用 ```` ``` ````

### 关键路径

```
D:\download\办共\phone-access-product\
   app\                   源代码（出货文件由 pack.ps1 白名单决定）
   dist\                  交付物
      【点这里安装】手机远程-v1.0.3.exe
      卖家工具（不要发给客户）\
   seller-keys\           私钥 + 签发许可证.cmd    ← 永不外发
   sfx\                   打单文件 exe
   docs\                  文档
C:\Users\ccj\AppData\Local\PhoneAccess\   本机实际安装
D:\download\办共\private\                 卖家自用入口（含密钥）
```

### 关键端口

| 端口 | 用途 | 客户版有吗 |
|---|---|---|
| 8660 | 画面服务 | 有 |
| 8642 | DSH 门（tailnet/局域网）+ DSH 本体（回环） | **没有** |
| 8650 | DSH tailnet 门（serve 用） | **没有** |

---

## 六、工作规则（针对上一轮的失败模式写的）

上一轮我犯的错有共同点：**用配置文件/接口返回值当事实，而不是去测量实际运行状态**。
导致连错三次、白费几小时。所以：

### 必须遵守

1. **每条结论附实际命令和输出**，不准说"应该是"、"我验过了"
2. **改文件前先说要改哪个、改什么**
3. **一次只做一件事**，做完等确认
4. **破坏性操作前先说出目标路径**（删文件/杀进程/改 ACL）
5. **验收标准用"实际状态"**，不用"接口返回 200"

### 上一轮的具体教训

| 教训 | 具体情况 |
|---|---|
| 模型文件 ≠ 运行状态 | `capture.mode` 里的 `width` 长期是 1440，但真实抓屏宽度是 `capture.exe` 参数里的 2560。我信了模型文件，连错三次 |
| 同期发生 ≠ 因果 | DSH 开着 + 掉帧同期发生，我归因到 CPU 争用。实测 DSH 开着照样 24 帧 |
| 改完只看接口 | 画面质量改了 UI、改了接口、改了文档，实际没验过一次 `capture.exe` 参数 |
| `-Force` 参数从不存在 | `licence-state.ps1` 的 param 里没有 `-Force`，调用方传了它 → 错误被 catch 吞掉，M1 修复一直没生效 |
| 杀进程要看进程树 | 杀 DSH web 时把 agent 运行时的父进程一起带走，工具调用直接失败 |

### 抓屏分辨率的正确验法

```powershell
# 1. 改配置
$cfg = Get-Content "$env:LOCALAPPDATA\PhoneAccess\product.config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.screen.maxCaptureWidth = 1920
[System.IO.File]::WriteAllText(..., ($cfg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

# 2. 必须杀进程（start-screen.ps1:154 在端口已监听时不会重启 server）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'screen-server\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process capture -EA SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
Start-Sleep 2
powershell -File "$env:LOCALAPPDATA\PhoneAccess\start-screen.ps1"

# 3. 验「实际启动参数」，不是配置文件
(Get-CimInstance Win32_Process -Filter "Name='capture.exe'").CommandLine
# 期望看到: ... screen-latest.jpg 1920 40 ...
```

**`maxCaptureWidth` 是上限不是目标**：`captureWidth=0` 时取物理屏分辨率。
所以"把 2560 改成 2560"等于没改——这是上一轮误判的根源。

---

## 七、版本不一致（已解决，2026-10-29）

| 项 | 值 |
|---|---|
| `product.config.json` 的 `version` | **1.0.4**（随半免费改造统一提升） |
| 交付包文件名 | 旧包 v1.0.3；**下一包应命名 v1.0.4** |

升级安装的行为（install.ps1 实测过的逻辑）：新装机复制整套默认配置（拿到 1.0.4 + freemium 块）；
老机保留客户配置、**只增不改**地补新顶层键——所以升级机会补上 `freemium`，但 `version` 保持旧值
（纯显示问题；配额不依赖它，配置缺 freemium 块时服务端默认 3600）。

---

## 八、文档索引

| 文档 | 内容 |
|---|---|
| `docs\完整流程-卖家与客户.md` | 从接单到售后的全部动作（含客户可直接看的部分） |
| `docs\独立审查包-第二轮\05-修复清单.md` | **待修问题 + 每条验收标准** |
| `docs\独立审查包-第二轮\01-系统事实.md` | 架构与安全边界的准确事实 |
| `docs\独立审查包-第二轮\03-已知问题.md` | 已知残余风险（含我撤回的错误结论） |
| `docs\架构盘点.md` / `环境矩阵.md` | 早期盘点，部分内容可能已过时 |
| `private\我的远程入口（勿外传）.md` | 卖家自用入口，**含完整密钥** |

---

## 九、用户画像与产品定位（给后续工作的背景）

- **客户**：内容创作者，不熟技术，需要远程指导
- **收费**：实施费 + 月费（基础档不收月费，因为看不到客户电脑、提供不了对等服务）
- **核心约束**：产品不能影响卖家自用；客户机不能出现 DSH；最好只在桌面生成一个文件夹
- **安全承诺**：卖家技术上无法进入客户电脑（客户用自己的 Tailscale 账号）

**流量是重要卖点也是风险点**：清晰模式约 26 GB/小时，客户用手机流量看一小时会烧掉整个套餐。
文档里已明确写出，客户应点「流畅」（约 1.3 GB/小时）。

---

## 十、半免费模型（2026-10-29 上线，v1.0.4）

**商业口径**（卖家定的，改之前先问）：基本功能全免费；许可证只解锁两样——
1. **超清画质（2560）不限时长**：未授权每天免费 1 小时（3600 秒）
2. **个性化**：颜色主题（暖白/海洋蓝/暗夜紫/自定义 JSON 导入）、光标大小（6–24px）与颜色

画质档位命名（手机设置面板）：**超清=2560 · 高清=1920 · 标准=1440**。
高清/标准/流畅（WebRTC 1280）免费不限时。未授权**可以选超清**（不拦设置），
强制发生在**出图时刻**：配额用完后服务端把实际发出的帧压到 1920 宽。
**价格没有定死**：页面/文档只引导联系卖家（`app\branding\联系.txt`：邮箱 ccc475235@gmail.com /
电话 19873217121），❤ 面板展示微信/支付宝收款码（`branding\微信.jpg`、`支付宝.jpg`，同名替换即可换图）。

### 技术实现（防回归要点）

**配额引擎在 screen-server.mjs（服务端强制，改页面绕不过）**：
- `ULTRA_LIMIT=1920`；1 秒心跳，仅当「未授权 && 3 秒内实际发过 >1920 宽的帧」时 `seconds+=1`
- 用量写 `ultra-usage.json`：`{date:'YYYY-MM-DD',seconds:N}` 本地日历日，10 秒节流落盘 + exit 落盘；跨天自动清零
- 耗尽后 `deliverCapW()` 返回 1920：`/frame.jpg` 请求时钳制、`/stream` 在 push 循环里**逐帧**复查（恢复配额同样逐帧生效，**全程无需重启**）
- 覆盖项：`product.config.json → freemium.ultraFreeSecPerDay`（测试用 45 这种小值；缺块默认 3600）
- 透出：`/health` 尾部 ` uq=剩余秒|0:x|na`；`/licence`、`/set-quality` 响应带 `ultraQuota` 对象

**旧 402 整站闸门已拆除**：`LICENCE_OPEN_PATHS` 与页面 `blockPage` 整屏遮罩已删。
未授权=免费模式：页面照常打开出图。激活入口=设置面板「许可证」分区
（粘贴 → `POST /licence` → 轮询到 usable → 自动刷新）；页面每 30 秒轮询 `/licence`，
放文件/异地粘贴后不刷新也会解锁并提示。

**个性化是页面侧 gated**（诚实标注：装饰性功能，强制在页面里，服务端不校验——
主题/光标本质是 localStorage+CSS，没有可"绕过"的服务端资产）。
实现：`page.mjs` 的 `personalization()` IIFE（`window.__paP13n`）+ 设置面板 `p13nInner/p13nBind`；
偏好存手机 localStorage：`pa.theme` / `pa.cursor` / `pa.customTheme`；
未授权时 `applyAll(false)` 强制回落默认外观（已存偏好保留，授权后恢复）。

**branding 出货链路**：`app\branding\{微信.jpg,支付宝.jpg,联系.txt}` → `pack.ps1` 白名单已收录 →
`install.ps1` robocopy 排除表不含 branding（自动带上）→ 服务端 `/branding/*` 带密钥放行、
`/licence` 响应带 branding 字段（`licence-state.ps1` 扫描生成）。

### 实测记录（2026-10-29，卖家实机 + 本机浏览器，全过）

- **已授权**：`uq=na`；frame/stream 宽 2560；个性化全可用（切主题生效、光标 18px 绿色、自定义 JSON 导入应用、非法 JSON 被拒、授权开关回落正确）
- **未授权**：GET / = 200（无遮罩）；HUD 实时显示「超清余 59 分钟」；超清按钮带「🔒1小时/天」角标；个性化控件 disabled、点锁定主题只出购买提示；粘贴激活区在；❤ 面板显示「免费模式」+ 解锁清单
- **配额耗尽**（配置 45s 实测）：第 46 次轮询 `uq=0:x`；**frame.jpg 实测宽 1920**；**/stream 首帧 JPEG SOF 解析宽 1920**；usage 落盘正确；观看期间计时准确（浏览器实测留下 seconds:51）
- **恢复许可证**：`uq=na`、宽度立即回 2560（无重启）
- **收款码**：`/branding/微信.jpg`、`支付宝.jpg` → 200 image/jpeg、FF D8 头；❤ 面板两图 + 邮箱 + 电话显示正常

**测试时的坑（下次别再踩）**：
- 杀 screen-server 的进程匹配若用 `CommandLine -match 'screen-server\.mjs'`，会命中**自己这条 pwsh**（命令行里含脚本文本）→ 自杀。要限定 `Name -in node.exe,cmd.exe` 且排除 `$PID` 与父进程
- PowerShell `WebClient.DownloadString` 默认 GBK 解码，UTF-8 JSON/HTML 会 mojibake 导致 `ConvertFrom-Json` 炸、`Contains('中文')` 误报 False。先 `$wc.Encoding = [Text.Encoding]::UTF8`
- 改配置里的 `freemium` 值必须重启服务才生效（productConfig 只在启动时读）；但**配额的耗尽/恢复本身不需要重启**

---

## 十一、2026-10-29 第二轮：WebRTC 回归修复 + 画质档位结论 + 光标形状（v1.0.5）

### P4-4 回归：流畅模式（WebRTC）永远连不上 —— 已修复（commit 9f995a6）

**症状**（用户报告 + 本机复现）：点「流畅」→ WebRTC 连接中… → 几秒后自动退回清晰。
服务端日志特征：`viewer connected → video/audio track added → viewer closed code=1006`，
**从来没有 `state connecting/connected`**；浏览器侧 `signalingState=have-local-offer`、`remoteSdpLen=0`、`iceState=new`。

**根因**：Node 的 `upgrade` 事件派发给**所有**监听器。rtc.mjs（先注册）把 `/rtc` 成功升级后，
screen-server.mjs 的音频处理器（后注册，第二轮 P4-4 改动）看到 `pathname !== '/ws-audio'` 就
`socket.destroy()` —— 把刚升级好的信令 socket 掐死（1006）。浏览器 offer 发进死连接，answer 永远回不来。
P4-4 本意是销毁"两边都不认识"的悬挂连接，但误伤了 /rtc。**修 P4-4 之前流畅模式是好的——这是第二轮审查修复引入的回归。**

**修法**：音频处理器只销毁既不是 `/ws-audio` 也不是 `/rtc` 的 socket；`/rtc` 全权由 rtc.mjs 处理（含鉴权失败 401+destroy）。

**验收**（浏览器 + 日志双向）：`pc.connectionState=connected`、视频 1280×800 出流、HUD「1 连接 · 链路 3ms」、
服务端日志 `rtc: state connected`；切回清晰 code=1005 干净关闭。

### 画质三档"看不出差距" —— 机制正常，属感知问题（commit 45a8395）

实测证据链：config `maxCaptureWidth=1440` → 守护重启 argv `1440x900` → `capture.mode width=1440`（capture.exe 的 ctlWidth 覆盖启动参数）→ `/frame.jpg` 与页面透传帧实测 1440；切回 2560 后全链路 2560×1600。**三档真实生效**。
"看不出差距"的原因：手机屏/浏览器窗口会把 1440~2560 都缩到窗口宽，正常观看距离几乎无差；
差距在**双指放大的小字细节**与**流量**（约 26/15/8 GB每小时，像素比推算，基于 2560 档实测 26GB/h）。
已改：档位按钮直接标流量估算，设置页与使用说明.md 讲清"差在放大和流量"。

### 光标形状 + 自定义导入（许可功能，commit 727c3f6）

- 六种形状：圆点（默认）/ 圆环 / 十字 / 箭头 / 方框 / 自定义（导入图片）
- 导入限制：PNG/JPG/WebP/GIF（**拒 SVG 防注入**）、≤300KB、≤512×512；FileReader→dataURL 存 `pa.cursorImg`
- **可调颜色范围（2026-10-30 用户澄清，取代 10-29 的"仅圆点"规则）**：五种内置形状（圆点/圆环/十字/箭头/方框）全部可调颜色+大小；
  只有自定义导入图片只能调大小、不可调颜色——色板整行 disabled + 提示「自定义图片光标只能调大小，不能改颜色」
- 形状存 `pa.cursor.shape`，旧数据无 shape 字段 = 圆点（向后兼容）；未授权 `applyAll(false)` 强制回落默认
- **踩坑修复**：`.cursorDot` 基类自带黄底/圆角/黑光晕，内联样式清成 `''` 会漏染（实测圆环内是黄的）→ styleShapeEl 改为对每个属性显式设中性值再按形状覆盖
- 浏览器实测：六形状 computed style 全对、canvas 造图→DataTransfer 注入 file input→导入应用→移除回退，全绿；测试残留已清（pa.cursor 回默认、pa.cursorImg=null）

### 本轮后实机状态（19:32）

清晰 2560×1600 @24.5fps 延迟 2ms；流畅 connected（1280×800 视频）；selfcheck 19 项 🟢（2 条 cosmetic：第三方杀软在、24h 自动恢复 14 次——后者多为本日部署/测试杀进程所致）；config version=1.0.5。

---

## 十二、2026-10-30 第三轮：PWA 真机回归修复 + 光标可调颜色规则澄清

### PWA：「添加到主屏幕」装出的 App 打开是「这个地址缺了钥匙」——已修复

**症状**（用户真机报告 + 截图，2026-10-30）：远程地址在手机浏览器里正常打开；用浏览器「安装应用/
添加到主屏幕」装成 App 后，打开 App 是 401 页「这个地址缺了钥匙 / 这个地址里没有访问密钥」（standalone
全屏、无地址栏）。设备为安卓手机（小米系，视觉判断 ~90% 置信）。

**根因**：2026-10-29 P0-1 把 `start_url` 改成 `'/'`，靠 `'/'` 路由下发的 `screen-key` cookie 做后续认证。
但**装出来的 web 应用不共享浏览器的 cookie 存储**（iOS Safari 从不共享；本机安卓同样没共享）→
App 打开 `'/'` 时既无 cookie 也无 `?k` → 401。浏览器里正常是因为地址栏 URL 本来就带着 `k=`。
第二轮修复清单（`docs\独立审查包-第二轮\05-修复清单.md`）当时就标着「机制已验证；真机这一下仍需手机实测」
——本次真机实测正好打穿了那个缺口。

**修法**（`screen-server.mjs` manifest 路由）：`start_url` 改回 `'/?k=' + encodeURIComponent(KEY)`。
安全前提不变：
- `/manifest.json` 仍在 `STRICT_AUTH_PATHS`：裸 GET（不带 k / 不带 cookie / 不带有效短时 token）→ **401**，
  P0-1 原始泄露（未鉴权抓清单拿密钥）保持已修；
- 短时 token 只能从已鉴权的页面 HTML 拿到，而页面 HTML、入口二维码里本就含完整密钥 → 清单带密钥无新增暴露面；
- 装出的 App 打开 `start_url` 直接靠 `?k=` 过鉴权，不依赖任何 cookie；
- 代价：轮换密钥后旧 App 图标失效（同旧书签），需重新「添加到主屏幕」——与「我的远程入口」§四 口径一致。

**验收**（本机实测，2026-10-30，部署重启后）：
1. 裸 `GET /manifest.json`（无 k/cookie）→ **401**（P0-1 保持已修）
2. `GET /?k=<key>` → 200 + Set-Cookie；页面里提取到 `href=/manifest.json?v=2&exp=...&sig=...`
3. 用该短时 token、**全新客户端（无 cookie）**取清单 → **200**，响应体 `start_url="/?k=<完整密钥>"`（原始 JSON 已存证）
4. 裸 `GET /` → **401**（旧 App 图标仍然打不开）
5. **模拟新 App 启动**：无任何 cookie 直接打开 `start_url` → **200**（新装的 App 可打开）
6. `/icon-192.png`、`/icon-512.png` → 200、8950 PNG 头

**用户动作（必须）**：手机上**先删掉旧 App 图标**，再重新用浏览器打开地址「添加到主屏幕」一次——
旧图标的 start_url 是安装时定死的 `'/'`，不重装永远 401。

### 光标：可调颜色规则澄清（2026-10-30 用户拍板，取代 10-29「仅圆点」规则）

**新规则**：五种内置形状（圆点/圆环/十字/箭头/方框）全部可调**颜色 + 大小**；
只有**自定义导入图片**只能调大小、不可调颜色（图片自带颜色，染色无意义）。

**修法**（`page.mjs`）：
- `CURSOR_SHAPES` 的 `colorable` 标志：五种内置 = true，custom = false（色板禁用的唯一依据，`syncColorRow` 走它）
- `styleShapeEl`：圆环/方框 `border`、十字 `linear-gradient`、箭头 `background` 原固定 `#ffffff`，现全部吃用户所选颜色
  （颜色入参在 `applyCursor`/`syncPreview` 已做 isHex 校验，非法回落默认黄）
- 设置面板：色板整行只对 custom 禁用 + 提示「自定义图片光标只能调大小，不能改颜色」（原「仅默认圆点可调颜色」）
- 文案同步：`app\使用说明.md` 个性化表格行

**验收**（DSH 浏览器实测，2026-10-30，17/17 全过）：
- 圆环/十字/箭头/方框/圆点各选绿 `#6ee7a0` → `#dot` computed style 全对（border-color / 双渐变 / background = `rgb(110,231,160)`）
- 五种内置形状下色板启用、提示隐藏；选 custom 后整行禁用 + 提示显示；移除图片后恢复启用
- 大小 20px（方框）/ 18px（custom）即时生效
- 未导入图片就选 custom 正确拒绝（shape 不变，提示先选图）
- canvas 造 16×16 PNG → DataTransfer → file input → 导入应用 → `#dot` 显示 `url("data:image/png...")`
- 页面刷新后 localStorage 存的配置（18px 绿圆点）恢复应用
- 测试残留已清（`pa.cursor` 回默认 10px `#ffd166` 圆点、`pa.cursorImg`=null）

### 本轮后实机状态（2026-10-30 23:25）

health ok：viewers=1（验证浏览器）、in=15 out=15、source=pipe、uq=na（已授权）、input connected；
服务已带新文件重启（supervisor 于 23:12 拉起新 node 进程，start-screen.ps1 检测端口已监听未重复启动）；
部署前用 `git hash-object` 核对过：安装目录两文件 == 仓库基线，部署后 == 仓库新文件。

## 十三、2026-10-30 第四轮：降档帧率"砍半"根因修复（capture.cs 降档缩放改 Bilinear）

### 背景（用户 2026-10-29 深夜报告，iPad 真机）

1. "你改完之后所有画质的帧率怎么都砍半了"（怀疑第十二轮的 PWA/光标改动导致）。
2. "刚打开时画面正常，改了一下画质后画面被放大了一点，下面有一点画面看不到"（附 23:49 iPad 截图）。

### 结论一：帧率——不是本轮改动导致的，是 capture.cs 降档路径本来就慢（已修）

**证据链（全部来自本机 `screen-capture.log` / `/health`，可复现）：**

- 2560 档（输出=源尺寸，不缩放）：从 11:00 到深夜一直 **24.7fps**（copy≈27-30ms，encode≈13-17ms），
  包括 00:13 服务重启后（`fps=24.7 copy=27 encode=15`）——**从未砍半**。
- 1920 档（2560→1920 缩放）：**今早 11:40 起**就是 15.5fps（copy≈54ms，encode≈49-52ms）——
  在 10-30 任何改动之前就存在。1440 档同为 18fps（copy 49/encode 37）。
- 用户感觉"砍半"的真实原因：之前一直用超清 2560（24fps），这次切到高清/标准，撞上这两个档本来就慢。
- PWA start_url / 光标改动不碰抓屏与流路径，排除。

**根因（`capture.cs` `RunPipeline`，双线程流水线：copy 线程 BitBlt 抓屏 → encoder 线程缩放+JPEG）：**

- 降档缩放出 `InterpolationMode.HighQualityBilinear`——GDI+ 最慢的插值，2560x1600→1920x1200 单步约 34ms。
- 且 GDI+ 缩放/编码期间占用 GDI 通道，把并行 copy 线程的 BitBlt 从 28ms 拖到 54ms（GDI 锁等待混进 copy 计时）。
- 两级相加 → 1920 档帧周期锁死 ~59-61ms → 15.5fps。2560 档 1:1 不缩放，所以一直是 24.7。

**修法（一行，`capture.cs` ~L457）：** `HighQualityBilinear` → `Bilinear`（加注释记录实测数据）。
重编译：`csc /codepage:65001 /optimize /unsafe /r:System.Drawing.dll /r:System.Windows.Forms.dll`
（仓库无现成编译脚本；源码与审查包快照 SHA256 一致，确认改的就是部署的那份）。
部署：旧 exe 快照 `capture.exe.bilinear.bak`（21504B）→ 新 exe 20480B 就位。

**实测（本机，新包 vs 旧包，同一台 2560x1600@240Hz）：**

| 档位 | 旧包 | 新包 | 说明 |
|---|---|---|---|
| 超清 2560 | 24.7fps | 24.2-24.7fps | 不缩放，不受影响（回归通过） |
| 高清 1920 | 15.5fps（copy 54 / encode 49） | **20-22.4fps**（copy 40 / encode 28-30） | +30% |
| 标准 1440 | 18fps（copy 49 / encode 37） | **21.8-23.7fps**（copy 37 / encode 21） | +28% |

- 画质：1440 帧视觉检查（Bilinear+q62）——无偏色、无严重伪影；小字略软（0.56x 缩放+q62 的固有代价，可接受）。
- 上限说明：本机 copy 下限 ≈28ms（2560x1600 DWM 读回）→ 帧率天花板 ~24-25fps。
  降档档剩余 2-4fps 差距 = copy 线程与 GDI+ 编码的 GDI 争用（copy 37-40 vs 满档 28）。
  要再提得换更快的 JPEG 编码器（新增原生依赖，需过安全审查）——本轮未做，留作后续选项。

### 结论二：改画质后底部裁切——**已修（commit 5bb3572），待 iPad 复测**

**复现条件（用户补充，关键线索）：浏览器里同样操作完全正常，只有装到主屏幕的独立 App
（iOS standalone）在换画质后裁切**；且 App 刚打开时正常，一换画质（服务重启后）就裁。
裁切形态：顶部正常、左右无黑边、只有底部被切（Windows 任务栏没了）——布局盒比可见屏幕
**高出一截**、从底部溢出屏幕的形态。

**排查：**
- 服务端帧完整（23:58 的 1920 帧任务栏都在；当前 2560 帧 SOF=2560x1600）——服务端没裁。
- 桌面浏览器复现"切画质→服务重启→双缓冲换流"全流程：`object-fit:contain` 布局正常。
- 页面 CSS：`body{height:100dvh}` + `viewport-fit=cover` + `apple-mobile-web-app-status-bar-style=black-translucent`
  ——独立 App 全屏延伸到状态栏/ home 条下方，布局高度全靠 `100dvh`。

**根因判断：iOS 独立模式的视口高度会在会话中漂移**（100dvh 重新解析成比可见屏幕更大的值），
全新加载总是对的（用户原话"刚进去画面是好的"），所以"刚开正常、换画质后裁"。
（23:48 那次抓屏 10 秒抖 3 重启的坏帧是次要嫌疑，主嫌疑是这个。）

**修法（page.mjs，两层，commit 5bb3572）：**
1. **视口钉住**：`syncViewportHeight()` 把 body 高度钉在 `visualViewport.height + offsetTop`
   （真实可见区域，页面坐标换算本来就用这个 API），resize/转屏/visualViewport-resize 重同步。
   浏览器/桌面两者与 innerHeight 相等，无行为变化。
2. **画质生效后整页重载**：画质保存成功打 `qualityPending` 时间戳（TTL 10 分钟）；
   `pollStats` 检测到 /health 断流→恢复（=服务重启完成）后 800ms `location.reload()`。
   UI 本来就承诺"约 8 秒后刷新生效"，1 秒重载在承诺内；全新加载保证布局正确。
   顺带修了 `failPolls` 成功不清零的累计问题（原来恢复后多失败两次就会误重连）。

**桌面浏览器端到端实测（全过）：** 点 1920 → 重启服务 → 页面自动重载 ✓ 新档 1920 生效（img naturalWidth=1920）✓
body 高度重钉（501.333px = visualViewport）✓ 再切 2560 同流程 ✓ 截图布局无裁切、任务栏完整 ✓
2560 档 24.5fps ✓。（部署前 `node --check` 过；页面 HTML 已确认含新代码。）

**待用户 iPad 复测（复测步骤）：** ①把 App 从最近任务里划掉**彻底关掉**再重开（加载新页面代码）
②确认画面完整 ③换一次画质 ④服务重启后 App 会**自动刷新一下**（~1 秒，这是新行为，属正常）
⑤看底部还裁不裁；还裁发新截图。

### 观察项（不影响结论）

- 22:01~23:11 之间显示状态变过：23:11 抓屏启动时 `Get-CaptureGeometry` 读到 **1920x1200**
  （source: dpi-aware-screen），00:13 起稳定读 2560x1600（现 240Hz）。用户"没动过/不记得"——
  疑为系统/驱动自动调整。若再现注意：显示掉到 1920x1200 时抓屏源也会跟着变小。

### 本轮后实机状态（2026-10-30 01:17）

health ok：`in=24.5 out=24.5`、frame SOF=2560x1600、source=pipe、uq=na（已授权）、input connected；
capture.exe=新 Bilinear 包（20480B），旧包快照 `capture.exe.bilinear.bak` 在安装目录；
page.mjs=视口修复版（commit 5bb3572）；`product.config.json` maxCaptureWidth=2560（超清档，用户 App 当前档位）；
git 基线 `5bb3572`（本轮两 commit：`ecaf9b3` 帧率 + `5bb3572` PWA 裁切）。

---

## 十四、商业化收口（2026-10-30）：7 天试用 / 并发上限 / 检查更新 / 安装器声明

用户拍的板：按「收费点建议」落地四项，但第 4 项从"2~3 台"改成**免费版最多 3 台设备同时看**；
另外新增两条硬要求：试用必须**防反复卸载重装刷新**，安装包双击后**先弹免责声明+配置要求并强制勾选同意**。

### 14.1 新装 7 天全功能试用（`app/trial.ps1`）

- 试用内容：超清不限时 + 个性化全开 + 多设备不限（试用期内 `effectiveUsable=true`）。
- 锚点存在安装目录**之外**的四处，取**最早**一条：`HKLM\SOFTWARE\PhoneAccess`、`HKCU` 同名键、
  `%ProgramData%\PhoneAccess\trial.json`、`%LOCALAPPDATA%\PhoneAccessTrial\trial.json`。
  刻意不用安装目录（`%LOCALAPPDATA%\PhoneAccess`），那里卸载会被整个删掉。
- 每条记录带 `machine` + `SHA256(machine|start|salt)` 校验；改 start 或整份拷到别的机器都不认。
- 带 `lastSeen`，系统时间回拨 >1 天 → `clock-tamper`，试用判失效。
- `licence-state.ps1` 每次校验时顺带计算，写进 `licence.state.json` 的 `trial{...}` 与 `effectiveUsable`；
  `screen-server.mjs` 用 `effectiveUsable` 统一判断"全功能"（发帧配额、并发上限、页面解锁）。
- 天数读 `product.config.json` 的 `freemium.trialDays`（默认 7），改配置不用改代码。

**沙箱实测**（临时 ProgramData/LOCALAPPDATA，不动真机）：run1 试用 7 天 → 删掉安装目录里的副本再跑
（模拟卸载重装）锚点不变、仍 7 天 → 把 start 改到 8 天前并重算 chk → `expired`、剩余 0 天。
踩到的两个真 bug 已修（1feed8c）：`return ,$array` 让调用方拿不到元素（等于每次运行都重发试用）、
非管理员写 HKLM 时满屏红字。

**诚实边界**：纯本地方案挡得住"卸载重装/复制安装目录"，挡不住刻意逆向或手动删光四处记录；
产品没有中心服务器可对账。对外不要说"绝对防破解"。

### 14.2 免费版并发上限 3 台（`screen-server.mjs` / `rtc.mjs`）

- 计数口径 = 清晰模式 `/stream` 连接数 + 流畅模式 RTC 对端数（即 `wanted()` 的两个源）；同设备重连不重复计数。
- 超限：`/stream` 回 429 + 一句人话；`rtc.mjs` 的鉴权谓词从布尔扩展为三态（`true`/`false`/`"429 ..."`），
  流畅模式也被拦，不再表现为"连不上"。
- 上限值 `freemium.freeMaxViewers`（默认 3）；许可证或试用期内不限。

### 14.3 检查更新接 GitHub Releases（`screen-server.mjs` / `page.mjs`）

- 新配置 `update.github={owner,repo}`：读 `/releases/latest`，`tag_name` 剥 `v` 比版本，
  正文当说明，优先挑名字像安装包的 `.exe` asset。原"任意 JSON 地址"模式保留，二者互斥。
- 页面新增「下载并安装」：`POST /update-install` 由**服务端**下载（页面不能指定任意 URL），
  只允许 `github.com` / `objects.githubusercontent.com` 等域名 + https + `.exe`，
  落 `%TEMP%` 后 detached 启动。该接口已加入 `STRICT_AUTH_PATHS`（能执行代码，与 `/exec` 同级）。
- 仍然只有客户点按钮才联网，不后台轮询（与"不给卖家留远程入口"一致）。
- 卖家侧操作手册见 `docs/发布与更新.md`（含 release 步骤、排错表、国内网络受限时的 `update.url` 备选）。

### 14.4 安装器：装之前先弹声明（`sfx/Sfx.cs`）

- 重写成无依赖的 WinForms 单文件启动器（仍是 csc 直接编译）：配置要求 → 折叠的免责声明（9 条）→
  同意勾选 → 「同意并继续安装」。**勾选框初始禁用，必须先展开一次免责声明才可勾**；未勾选时安装按钮禁用。
- 取消/关闭 = 不安装（返回 2）；已安装的机器按升级处理跳过弹窗；`--force-ui` 强制弹、`--silent` 供自动化。
- `build-sfx.ps1` 改为按时间戳自动重编（避免"改了源码忘重编"发旧包）。
- `pack.ps1` 与 `install.ps1` 的必需清单都补了 `trial.ps1`。

### 14.5 本轮验证到什么程度

| 项 | 结论 |
|---|---|
| `trial.ps1` 首次安装/重装/到期 | 沙箱实测通过（见 14.1） |
| `node --check` screen-server / rtc / page | 通过 |
| `csc` 编译 Sfx.exe | 通过（0 warning 0 error） |
| 页面弹窗、429 文案、下载安装按钮 | 代码就位，**待真机点一遍** |
| GitHub release 端到端 | **未验证**：`update.github` 还空着，需要卖家先建仓库 |
| 升级后许可证/配置/试用锚点不丢 | 待装一版实测 |

### 14.6 待办

1. 卖家建 release 仓库 → 填 `update.github` → 发 v1.0.6 → 老机器点一次「检查更新」全流程验收。
2. 真机上跑一遍试用：新装看「试用 7 天」、卸载重装仍是剩余天数、到期回落免费档。
3. 三台手机同时看验证第 4 台被拦（清晰 + 流畅两种模式各一次）。
4. 安装包双击验证：勾选框未展开时不能选、取消不安装、已安装机器直接升级。

## 15. 1.0.7：设置里的版本标注与许可证粘贴入口（2026-10-30 晚，用户实测反馈）

### 15.1 用户报的现象

- 设置里显示"**永久**"（新装还没付款的机器也一样）。
- 设置里**没有粘贴许可证的区域**，客户买了许可证没地方粘。
- 设置里看不出是**免费版还是专业版**，免费版也没写试用还剩几天。

### 15.2 根因（不是许可证坏了）

`/licence` 返回的 `usable` 语义是"**全功能可用 = 有许可证 或 7 天试用期内**"（1.0.6 为兼容旧页面保留了
这个语义，另加了 `licensed` = 真的装了许可证）。但 `page.mjs` 的设置面板一直用 `lic.usable` 判断
"已授权"：

- 新装用户在试用期内 `usable=true` → 面板显示"已授权 + 有效期 永久"（`expires` 为空被兜底成"永久"）；
- 粘贴框写在 `if (!lic.usable)` 分支里 → **试用期内被整块藏掉**；
- 官方授权用户同样是 `usable=true` → 面板显示"已授权"，不像"专业版"。

所以客户的许可证文件/试用状态都没问题，是**页面显示口径**错了。

### 15.3 改法（`page.mjs`，不动授权逻辑）

- 设置「许可证」分区改由新函数 `licenceInner(lic)` 生成，显示口径只用 `licensed`：
  - `licensed=true` → 绿色徽章「专业版」+ 客户名 + 有效期（`never`/空 → 永久）+ 已解锁权益；
  - `licensed=false` → 橙色徽章「免费版」+ `trialSummary()` 一行（试用中·还剩 N 天（到期日）/ 试用已结束 /
    时间被调过 / 读不到机器码）+ 免费版权益与限制（超清每天 1 小时、个性化锁定、最多 3 台）。
- **粘贴入口不再依赖 `usable`**：
  - 免费版（含试用期内）→ 常显「已有许可证？粘贴到这里激活」；
  - 已授权 → 折叠成 `<details>`「换许可证 / 续期：点这里粘贴新的」，换许可证也有入口。
- 有许可证文件但校验失败（换机 / 过期 / 损坏）→ 直接显示 `lic.message`，不再静默变成"免费版"。
- 粘贴成功后轮询改用 `licensed` 判断（原来判断 `usable`，试用期内会"假成功"提前刷新）。
- 支持面板同步成「当前版本：专业版（已购买）」/「免费版 · 试用中…」，进页面时试用期只提示一次剩余天数。
- 试用期内不显示"今日超清剩 X 分钟"（试用本来就不限时，显示反而让人以为受限）。

### 15.4 验证

- `node --check page.mjs / screen-server.mjs / rtc.mjs` 通过。
- **真实页面渲染测试**（用产品自己的 `page.mjs` 起一个打桩服务器 `tools/ui-test-server.mjs`，只把
  `/licence`、`/health`、`/frame.jpg` 等接口 mock 掉，浏览器实际打开点齿轮验证；以后改文案也能用它复查）：
  | 桩状态 | 设置面板实际显示 |
  |---|---|
  | 试用中（daysLeft=2） | 免费版 · 7 天全功能试用中 · 还剩 2 天（到期日）· 粘贴框可见 |
  | 已授权永久 | 专业版 · 本人自用（永久）· 有效期 永久 · 折叠「换许可证 / 续期」 |
  | 试用已结束 | 免费版 · 7 天全功能试用已结束 · 免费版限制 · 今日超清已用完 |
  | 许可证换机 | 免费版 · "这个许可证是发给另一台电脑的。" · 粘贴框可见 |
- 截图目视检查：徽章、试用倒计时、粘贴框、验证并安装按钮排版正常，无溢出/遮挡。

### 15.5 待真机确认

1. 全新虚拟机装 1.0.7 → 设置里应显示「免费版 · 7 天全功能试用中 · 还剩 7 天」，粘贴框可见。
2. 粘贴卖家给的许可证 → 约 2~8 秒后自动刷新，徽章变「专业版」，有效期按许可证显示。
3. 卸装重装后仍是剩余天数（锚点不刷新）。

## 16. 1.0.7：画质三档变糊/掉帧（2026-10-30 晚，用户实测反馈）

### 16.1 现象

用户：「超清、高清、标准好像都变糊了，帧率也变低了」。
实测复现（本机 2560×1600）：配置 `maxCaptureWidth=2560`，但正在跑的 capture 是 1440 档、
`capture.mode` 里 `width=1440`，日志 `fps=18.6`。三档点哪个都一样 —— 因为**改档要重启**，
不重启就一直是旧档；而旧档（1440）本身又慢又软。

### 16.2 根因（两条叠在一起）

1. **抓屏侧缩放又慢又软**：`capture.exe` 拿到的是「档位宽度」（`Get-CaptureGeometry` 拿
   `maxCaptureWidth` 压过），2560→1440 在 GDI+ 里用 Bilinear 每帧缩放：
   - A/B 实测（同机、同 interval 40ms）：原生 2560 = **24.7fps**（copy 27ms / encode 15ms）；
     抓屏缩 1440 = **18.6fps**（copy 47ms / encode 37ms）。缩放占住 GDI 通道，把并行 BitBlt 也拖慢。
   - 缩放后小字发虚（Bilinear + q62 二次损失）。
2. **改档必须整机重启才生效**：`/set-quality` 只写配置，`CAP_W` 是启动时的常量；
   页面也写着「改完请双击桌面重启」。用户点了三档看不出变化，观感就是「三档都糊」。

### 16.3 改法（架构拆开：抓屏 ≠ 发送）

- **抓屏永远原生**：`product-config.ps1` 的 `Get-CaptureGeometry` 不再用 `maxCaptureWidth`
  压抓屏宽度（只保留 4K→2560 硬上限）。`screen-server.mjs` 新增 `CAPTURE_W`，
  `publishViewers` / `capture.mode` 的 `width` 一律写 `CAPTURE_W`，capture.exe 不再缩放。
- **画质档位 = 服务端发送宽度**：`CAP_W` 改成 `let`，`/set-quality` 里调 `setDeliveryWidth()`
  **立即生效**（`/stream` 每帧按当前 `CAP_W` 重算宽度，不重连、不重启）。
  缩小用 sharp（Lanczos），比 GDI+ Bilinear 清晰。
- `/mode` 的宽度钳制改用 `CAPTURE_W`；`/frame.jpg`、`/stream` 的"原图透传"判据改成
  `CAP_W < CAPTURE_W`（档位低于原生时一定会缩）。
- 抓屏 JPEG 质量 **62 → 70**（缩放不再二次损失；实测 q70 编码耗时 16ms，和 q62 的 15ms 基本一样，
  单帧只大 ~14%）。interval 默认 40ms → 33ms（30fps 上限）。
- 页面文案去掉「改完重启」，改成「切换立即生效、三档帧率一样」；点档位后直接刷新高亮。

### 16.4 验证（真实进程 + 真实 HTTP，不是只跑单测）

测试台：`capture.exe`（2560/33ms/q70，独立命名管道）+ 从仓库代码直接起的 `screen-server.mjs`
（127.0.0.1:8771，临时 node_modules 联结），用 Node fetch 走真实 `/set-quality` + `/stream`：

| 动作 | 结果 |
|---|---|
| 默认（未改配置） | `/frame.jpg` = **2560×1600**，410KB |
| POST 1440（不重启） | **1440×900**，174KB；`needFullRestart=false` |
| POST 1920 | **1920×1200**，265KB |
| POST 2560 | **2560×1600**，410KB |
| 推流 1440（4 秒实测） | **27.2fps**，4.7 MB/s；服务端 `/health` in=29 out=28 |
| 推流 2560（4 秒实测） | **27.7fps**，11.3 MB/s；in=29 out=29.5 |
| capture 日志 | 全程只有一条 `pipeline 2560x1600 -> 2560x1600`（**从未重启/换档**） |
| 服务端日志 | `delivery width 2560 -> 1440（抓屏仍按原生 2560，立即生效）` 等 |

对比：修复前 1440 档 18.6fps 且小字发虚 → 修复后 ~27fps、Lanczos 缩放。

### 16.5 代价与边界

- 1440/1920 档现在每帧要服务端 sharp 缩放+编码（本机约 20ms/帧，可跑满 ~27fps）；比抓屏侧缩放更费
  CPU，但换来帧率和清晰度。低于原生的档位才会有这个开销；超清（=原生）零开销透传。
- 流畅模式（WebRTC）的轨道尺寸仍在建连时按启动档位定（切档不影响它），避免黑屏。
- 4K 显示器仍只抓 2560（硬上限）；这一档在 capture 里缩放的老问题没动，属已知边界。

## 17. 1.0.7：升级后设置还显示旧版本 / 检查更新说没配置（2026-10-30 晚）

### 17.1 现象

用户在本机覆盖安装 1.0.7（提示安装成功），但手机「设置 → 版本与更新」仍显示 **1.0.5**，
点「检查更新」提示「还没配置更新源」。

### 17.2 根因（代码已经是新的，配置是旧的）

`install.ps1` 升级时**刻意保留客户的 `product.config.json`**（不覆盖端口/开关等设置）。
为了兼容新版本新增字段，它做了一次"只增不改"的迁移：只补**老配置里完全没有**的顶层键。
问题：

- `version` 老配置里也有（旧值 1.0.5）→ 不补 → 永远显示旧版本；
- `update` 老配置里也有（1.0.5 的 `{url:"",timeoutMs}`，没有后来才加的 `update.github`）→ 不补 →
  `/update-check` 读不到 GitHub 源，永远说「还没配置更新源」；
- 同理 `plans`（价格/权益）和 `freemium`（试用天数/并发上限）也会一直停在旧值。

实测：安装目录里的 `screen-server.mjs`/`page.mjs` 都是新版，但配置 `version=1.0.5`、
`update.github` 不存在。所以不是安装失败，是配置迁移口径错了。

### 17.3 修法

`install.ps1` 的旧配置迁移增加"产品自带字段强制同步"：`version` / `update` / `plans` /
`freemium` / `share` 每次升级都用安装包里的值覆盖；端口、`enableDsh`、`screen`、`support`、
许可证等客户设置仍然一个字不动。写入仍是 UTF-8 无 BOM。

已对这台机器当前的安装做了一次同样的迁移（原文件备份为 `product.config.json.bak-*`），
实测：

- `GET /licence` → `version=1.0.7`；
- `GET /update-check` → `configured=true, current=1.0.7, latest=1.0.6, hasUpdate=false`
  （1.0.7 还没发布，所以"已是最新"是对的）。

### 17.4 新增：分享给朋友（推广用）

- 手机「支持 / 购买」面板底部新增「分享给朋友」：显示可编辑的分享文案 +
  「复制分享文案」/「用系统分享…」（`navigator.share`，不支持时退回复制）。
- 文案与链接在 `product.config.json` 的 `share` 里：`{link}` 会替换成 `share.link`；
  `enabled=false` 隐藏。**改完不用重新打包**，重启服务即生效（`/licence` 会把 `share` 透传给页面）。
- 安全：面板里同时写明「别把带 k= 的完整地址发出去」，分享文案只含官网/下载页链接。

### 17.5 新增：落地页草稿

- `site/index.html`：单文件静态落地页（深色、响应式、无外部依赖），含卖点/功能/三步/价格/FAQ/下载/免责声明。
- `docs/网站与分享.md`：怎么用 GitHub Pages（免费）或国内 OSS/COS 发布、下载文件放哪、
  上线后要改的两处（`share.link`、页面价格）、合规提醒（公网别放手机号/收款码）。
- 页面的下载按钮现在指向 GitHub Releases 的 `releases/latest`，换镜像时改两处 `href`。

### 17.6 验证/待办

- 页面渲染用 `vision_html_screenshot` 整页截图检查过（1200 宽 / 3195px 高），排版正常。
- 分享面板用 `tools/ui-test-server.mjs` 在浏览器里真实点过：文案、复制按钮、系统分享按钮都在，
  点「复制分享文案」提示"已复制"。
- 待真机：装新包后设置应显示 1.0.7；点「检查更新」应返回"已是最新"（发布 1.0.7 后会提示升级）。
- 待办：注册/发布落地页 → 把 `share.link` 改成站点地址。

## 18. 官网已上线 + 调价 ¥68 + v1.0.7 软发布（2026-10-30 晚）

### 18.1 官网

- 地址：https://menhuayuchen.github.io/phone-access-releases/
  （`phone-access-releases` 仓库的 `gh-pages` 分支，GitHub Pages 自动发布，build_type=legacy）
- 内容：`site/index.html` 单文件（约 18 KB，无外部字体/图片/CDN），深色、响应式：
  卖点 / 4 个功能 / 三步使用 / 三档价格 / FAQ / 下载 / 免责声明。
- 备用镜像：https://raw.githack.com/menhuayuchen/phone-access-releases/gh-pages/index.html
  （同一份文件，GitHub 打不开时用；jsDelivr 对 .html 返回 text/plain，不能当页面用，已实测）。
- 国内访问：github.io 在部分网络会慢/打不开。兜底 = ①页面写明"打不开发邮件要网盘链接"；
  ②`docs/网站与分享.md` 写好了换国内 OSS/COS 的步骤；③有域名后可绑自定义域名。
- `product.config.json` 的 `share.link` 已指向官网；分享文案带"¥68 一次买断 + 打不开就回我一声"。

### 18.2 调价

- 专业版 **¥98 → ¥68**：`product.config.json` 的 `plans`（App 套餐页）+ `site/index.html` + 文档同步。
  文案加了「一次买断，不订阅 · 用三年平均每天不到 7 分钱」。
- 已对**当前运行的安装**热更新配置（`plans` 和 `share` 直接写进安装目录的 product.config.json），
  刷新手机页面 → 套餐页显示 ¥68；以后重装由 install.ps1 强制同步，不会回退。

### 18.3 v1.0.7 已发正式版（2026-10-30 晚）

- 先做成 prerelease 让官网先能下载，用户确认后**已转正式版**：
  `PATCH /releases/{id}` 带 `prerelease=false, make_latest=true`；
  现在 `GET /releases/latest` → **v1.0.7**，asset `PhoneAccess-Setup-v1.0.7.exe`（52,821,471 B，
  SHA256 `8EF622C7…2187D`）。
- 官网三处下载按钮已改回 `/releases/latest`（以后发新版不用改页面），实测线上页面已更新
  （18 KB → 17931 B，含 `releases/latest`）。
- **端到端验证**（用运行中的服务）：
  - 把客户版本临时当 `1.0.6` 调 `/update-check` → `hasUpdate=true`，`latest=1.0.7`，
    `downloadUrl=.../v1.0.7/PhoneAccess-Setup-v1.0.7.exe`；
  - 恢复 `1.0.7` → `hasUpdate=false`（已是最新）。临时改动已还原。
- 注意：这台机器本地装的 1.0.7 是**较早的那次构建**（只有设置修复、没有分享/画质/升级修复）。
  版本号相同，`检查更新` 不会提示自己，需要**手动跑一次最新安装包**才有分享入口。

## 19. 1.0.8：分享入口没出现（排查结论）+ 应用内下载不再"无反应"（2026-10-30 深夜）

### 19.1 「支持面板最底部没有分享给朋友」不是 bug，是装的是旧构建

- 实测这台机器的安装目录：`page.mjs` 138,439 B / 21:43，`screen-server.mjs` 104,545 B / 21:42，
  两者都**不含** `shareBlockHtml` / `share` 字段；`/licence` 也没有 `share`。
- 也就是说本机装的是 1.0.7 的**第一次构建**（只有许可证/版本修复），不是后来带分享的那一版。
  版本号相同，所以「检查更新」不会提示自己。
- 处理：装一次最新安装包（1.0.8）即可，分享入口在 ❤ 面板最底部。

### 19.2 点「下载并安装」长时间没反应：旧实现只有"等 10 分钟"这一条路

- 旧代码：`fetch(target)` → `await r.arrayBuffer()` → 10 分钟 AbortController。国内不翻墙时：
  - 连 GitHub asset CDN（`objects.githubusercontent.com`）**实测只有 ~25 KB/s**（303 秒下了 7.7 MB），
    52 MB 要 35 分钟；页面一直显示"下载中…"，没有任何进度；要等 10 分钟才报"下载超时"。
  - 有时候 TCP 直接连不上，但同样要等很久才有结论。
- 1.0.8 改法（只动更新链路，不动画面/授权）：
  - **流式下载**（`response.body.getReader()`）+ 写 `.part` 再改名。
  - 新增 `GET /update-progress`：页面每秒轮询，显示「已下载 x/50.4MB（xx%）· 速度 · 预计还需 N 分钟」。
  - **看门狗**（每秒检查）：连接 20 秒无响应 / 下载中 20 秒没新数据 / 平均 <60KB/s 且预计还要 >10 分钟 /
    总时长 >8 分钟 → 立即中止并给出中文原因。
  - 网络层错误不再把 `fetch failed` 抛给客户，统一翻成「连不上下载服务器（网络到 GitHub 不通）…」。
  - 页面失败后按钮恢复，并给「打开发布页」「复制下载地址」；失败提示里直接说"开代理/让卖家发网盘链接"。
  - 新增 `update.mirror`：卖家可填一个国内能直连的 exe 地址（OSS/COS 直链）。有它时页面优先用镜像、
    GitHub 作为备选，`/update-install` 额外放行该域名（仍只接受 https + .exe）。

### 19.3 验证

- **服务器真实网络路径**（临时副本、只把 spawn 换掉避免真的跑安装包）：
  - 网络被挡时：**10.7 秒**返回「连不上下载服务器（网络到 GitHub 不通）…」，不再挂 10 分钟；
  - 网络通但很慢时：实测 303 秒只下了 7.7 MB（25KB/s），进度接口返回
    `{phase:'downloading', bytes:7784284, total:52821471, pct:15, speedKB:25}`。
- **页面 UI 桩**（`tools/ui-test-server.mjs` 新增 /update-check、/update-progress、/update-install 模拟）：
  点下载后 3.5 秒显示「已下载 20.0 MB / 50.0 MB（40%）· 4.0 MB/s · 预计还需 1 分钟」，进度条 40%；
  6 秒后变红色「下载太慢：平均只有 25 KB/s，按这个速度还要约 35 分钟，已停止。」，按钮恢复可点。
- 仍缺：**国内镜像 URL 还没有**。等卖家把 exe 传到 OSS/COS（或任何国内 https 直链）后，
  在 `product.config.json` 的 `update.mirror` 填上，就是真正可用的国内自动更新。






- 1.0.8 已发正式版（2026-10-30 深夜）：/releases/latest = v1.0.8，asset PhoneAccess-Setup-v1.0.8.exe（52,825,184 B）。当前安装的 1.0.7 调 /update-check 已返回 hasUpdate=true、下载地址指向 v1.0.8。site/index.html 用的是 /releases/latest，无需改页面。

## 20. 宣传口径核对：官网两处说法与实现不符（2026-10-30 深夜）

### 20.1 用户质疑的两点

| 官网原文 | 实际实现 | 结论 |
|---|---|---|
| 「也不用把电脑一直开着远程桌面」 | 被控电脑必须**开机、联网、程序在运行**；产品不支持远程开机/唤醒 | 原文有歧义（会被读成"电脑关着也能连"），已改写成「不用开 Windows 远程桌面、不用公网 IP」，并明确「电脑要开着并联网，它不会替你开机」 |
| 「可缩放」「双指放大看小字依然锐利」 | `page.mjs` 的 viewport 是 `maximum-scale=1`（浏览器缩放被禁用）；双指手势在 overlay 上被映射成**滚轮**（`touchstart/touchmove` 里发 `wheel`），不是缩放 | **没有实现缩放**，相关文案全部删掉；新增 FAQ 说明「网页没有双指缩放，建议选超清或用手机系统放大功能」 |

- 安装器 `install.ps1` 本来就会提示「关掉电脑自动睡眠」（两处文案），但官网/说明书没写清，容易被误解为"电脑不用开"。
- 1.0.9 还删掉了页面里的一句残留文案「控制已关闭（可双指缩放看细节）」。

### 20.2 改动清单

- 官网：hero 句子、FAQ（新增「电脑关机或睡眠了还能连吗？」「可以放大画面看小字吗？」）、三步第 1 步（提醒关自动睡眠）、手机示意 HUD（「可缩放」→「超清 2560」）、功能卡（去掉"双指放大"）。
- App：设置→画面质量说明（去掉"双指放大"，改为文字边缘更清楚 + 系统放大功能提示）、「控制已关闭」提示、使用说明第八节。
- 版本 1.0.9（仅文案与口径，无功能变化）。

### 20.3 如果以后要做真缩放

不能直接放开 viewport：双指已经是"滚动 PC 画面"的核心手势，两者会打架。建议单独做：
① 工具栏加 1x/2x 档位按钮（CSS transform 缩放镜像，坐标映射用 getBoundingClientRect 本来就兼容变换）；
② 或做「放大镜」浮层。两种都需要真机验证，别在文案先行。

- 1.0.9 已发正式版（2026-10-30 深夜）：/releases/latest = v1.0.9，asset PhoneAccess-Setup-v1.0.9.exe（52,825,702 B）。官网文案已更新，线上校验含「不会替你开机」「没有做双指缩放」。/update-check（本机 1.0.7）已返回 latest=1.0.9、hasUpdate=true。

## 21. 流程约定：发版必须经用户同意（2026-10-30 深夜，用户明确要求）

- **不要频繁迭代版本**；**发布版本必须经过用户同意**。
- 这里的"发布"包含四件事：改 `product.config.json` 的 `version`、`pack.ps1` + `build-sfx.ps1` 出安装包并上传、打 tag、改 `/releases/latest`。
- 允许做的事：在仓库里改代码、commit 攒成一批；需要验证时**本地**出候选安装包给用户装，但不上传、不 bump 版本、不动 latest。
- 等用户说"可以发"之后，再按 `docs/发布与更新.md` 的流程走一遍。
- 复盘：1.0.8 和 1.0.9 是在用户只点了"先做第一个"（把 1.0.7 转正式版）之后，我为了修更新链路/文案自行发的——不符合这条规则。当前 latest=1.0.9；是否保留或退回 1.0.8，等用户决定。

## 22. 体验版（¥10/月）+ 国内下载方式调研（2026-10-31）

### 22.1 体验版：免费版和专业版之间加一档

- `product.config.json` 的 `plans` 增加第 2 档「体验版」：¥10 / 1 个月全功能（超清不限时、个性化、多设备），
  不自动续费，到期自动回落免费版。App 套餐页和官网价格卡都会自动显示这档（套餐页是配置驱动）。
- 许可证层面：用现有机制就能实现 —— 签发时 `-Days 30 -Edition trial`，payload 里 `edition=trial`、
  `expires=<30 天后>`。`licence.ps1` 的验签/到期检查不用改。
- 页面显示：`/licence` 新增 `edition` 字段；`page.mjs` 里 `edition=trial/month` 显示**蓝色「体验版」徽章**
  （专业版绿色、免费版橙色），有效期后面自动加「还剩 N 天」；支持面板显示「体验版（有效期至 …）」。
- 卖家签发：`seller-keys\make-licence.ps1` 新增 `-Days N`（与 `-Expires` 二选一），
  例：`.\make-licence.ps1 -Machine "..." -Name "张三" -Days 30 -Edition trial`。
- 验证：给 VM 机器码签了一个 30 天体验版许可证 → `Test-Licence` 返回 `State=ok, Edition=trial, Expires=2026-11-30`；
  同一机器的过期许可证返回 `State=expired`（不会误放行）。
- 页面用桩环境实测：设置里显示蓝色「体验版」+「有效期 2026-11-29（还剩 30 天）」+ 体验版说明；
  支持面板「当前版本：体验版（有效期至 2026-11-29）」；套餐页显示 4 档（免费/体验/专业/定制）。

### 22.2 国内下载方式调研（用户问蓝奏云）

- **蓝奏云不能做自动更新的 `update.mirror`**：分享页是 HTML + JS 跳转，真实直链带防盗链/会变，
  服务端没法直接 fetch；而且链接会失效。
- 但蓝奏云可以当**手动下载页**：新增配置 `update.mirrorPage`（任意 https 分享页）。
  `/update-check` 把它透传给页面，下载失败时页面多一个「国内网盘下载（手动）」链接，客户自己在浏览器里下。
  已实测（桩环境）链接能正常显示。
- 自动更新要**稳定直链**：阿里云 OSS / 腾讯云 COS（推荐，¥0.2~0.5/GB，需实名）、
  Cloudflare R2（免费额度，需账号）、Gitee 发行版（需账号）、GitHub Pages 直接放 exe（免费但仓库体积/条款要留意）。
- 官网访问实测（用户）：`menhuayuchen.github.io` 主站能正常打开；`raw.githack.com` 镜像**打不开**，
  已在 `docs/网站与分享.md` 标注为"最后手段"。

### 22.3 本轮状态：未发布（遵守发版规则）

- 按新规则（发布需用户同意），本轮只改代码/配置并在仓库 commit，**没有 bump 版本、没有上传、没有动 latest**。
- 本地出了候选安装包 `dist\【点这里安装】手机远程-v1.0.9-候选.exe`（配置里的 version 仍是 1.0.9，仅供试用）。
- 用户同意后再：bump 到 1.0.10 → pack/build-sfx → 发布 → 官网自动跟随。

## 23. Gitee 下载直链实测（2026-10-31）

- 用户建了仓库 `menhuayuchen/phone-access-download`，用「发行版」上传了一个 exe。
- **直链无 cookie / 无 Referer 也能下**：`GET https://gitee.com/<owner>/<repo>/releases/download/<tag>/<file>`
  返回 200，302 跳到 `foruda.gitee.com/attach_file/...` CDN；`content-type: application/vnd.microsoft.portable-executable`。
- 速度实测（本机）：curl 全量 50.4 MB → **35 秒（约 1.44 MB/s）**；Node fetch（UA=PhoneAccess-UpdateCheck）也能正常读。
  对比 GitHub release asset 的 ~25 KB/s，Gitee 快约 50 倍，**可以作为 `update.mirror` 国内直链**。
- ⚠️ 这次上传的文件是**候选包**（`【点这里安装】手机远程-v1.0.9-候选.exe`，SHA256 `8D736584…9A94`），
  不是已发布的正式版 1.0.9（`PhoneAccess-Setup-v1.0.9.exe`，SHA256 `BFB43692…0CDE`），所以**没有接入 `update.mirror`**。
- 另：tag 和文件名都是中文（`手机远程-v1.0.9-安装包`），URL 会变成长串百分号编码；能用，但建议以后用
  ASCII：tag `v1.0.10`、文件 `PhoneAccess-Setup-v1.0.10.exe`。
- **重要机制**：`update.mirror` 读的是**客户端自己安装目录**里的 `product.config.json`。
  所以：① 新装/升级到带 mirror 的版本才生效；② 老客户端要临时启用，得手动改它安装目录的配置；
  ③ 发新版时把 mirror 指向「该版本 Gitee 文件」再打包，老客户端下一次更新才会拿到这个配置。
- 待办：等 1.0.10 正式发版时，把 1.0.10 的 exe 传到 Gitee（ASCII 名），
  在 `product.config.json` 的 `update.mirror` 填对应直链 → 打包发布；同时给本机装的那版手工补上 mirror 做端到端验证。

## 24. Gitee 镜像落地 + 体验版限购（2026-10-31 中午）

### 24.1 Gitee：删掉错的、换上正式版（已用令牌脚本完成）

- 用 `%USERPROFILE%\.gitee-token`（用户已保存，令牌有效，账号 menhuayuchen）。
- 删除错误附件：`【点这里安装】手机远程-v1.0.9-候选.exe`（attach id 3548898，HTTP 204）。
- 上传正式版：`PhoneAccess-Setup-v1.0.9.exe`（attach id 3549005，52,825,702 B）。
- 无 cookie 验证：`GET` 直链 → 200，`content-type: application/vnd.microsoft.portable-executable`，
  下载 52,825,702 B，SHA256 `BFB43692…0CDE`（与 GitHub 正式版一致），速度 **1.31 MB/s（40 秒）**。
- 当前直链（tag 还是中文的，能用；下一版建议 ASCII `v1.0.10`）：
  `https://gitee.com/menhuayuchen/phone-access-download/releases/download/<中文tag>/PhoneAccess-Setup-v1.0.9.exe`
- 注意：`update.mirror` 还没接——客户端配置里要带上 mirror 才生效，等 1.0.10 发版时一起写。

### 24.2 体验版限购 3 次

- 文案已加：App 套餐页（`product.config.json` 的 trial `small`）、官网体验版卡片、使用说明。
- **无法系统级强制**：离线授权没有中心服务器，客户端记不住购买次数（删文件/重装可绕过）。
- 新增卖家工具 `tools\count-trial-licences.ps1 -Machine "机器码"`：扫描 `seller-keys\licence-*.json`，
  统计该机器 `edition=trial` 的签发次数并提示剩余可卖次数（实测：VM 机器码 1 次，陌生机器码 0 次）。
- 签发流程写进 `docs/完整流程-卖家与客户.md` §4.4：`-Days 30 -Edition trial`，发 `.code.txt` 一行短码。
- 本轮仍未 bump 版本/发布（遵守规则）；等 1.0.10 一起收口。

## 25. v1.0.10 正式发布 + 体验版上线 + 国内镜像打通（2026-10-31 下午，用户批准后发布）

### 25.1 发布物

- GitHub Release：`v1.0.10`（正式版，`/releases/latest` 已指向它），
  asset `PhoneAccess-Setup-v1.0.10.exe`，52,827,911 B，
  SHA256 `3DDE44752554D95D3E751588BE5BA1B37266EF92FABB0183CEB76E032A75E4B2`。
- Gitee 发行版：tag `v1.0.10`（ASCII），同文件同哈希；
  直链 `https://gitee.com/menhuayuchen/phone-access-download/releases/download/v1.0.10/PhoneAccess-Setup-v1.0.10.exe`。
- 官网已更新：价格 4 档（免费/体验/专业/定制），下载按钮改为「国内下载（Gitee）」「GitHub 下载」两个。
- 本机安装包：`dist\【点这里安装】手机远程-v1.0.10.exe`（用户本机还是 1.0.7，需要手动装一次）。

### 25.2 镜像端到端验证（真实服务，非桩）

在临时目录用 dist 里的 **1.0.10 代码** 起了一个服务，把配置 version 改成 `1.0.9` 模拟老客户：

| 检查 | 结果 |
|---|---|
| `/update-check` | `current=1.0.9`、`latest=1.0.10`、`hasUpdate=true` |
| `downloadUrl` | **Gitee 直链**（mirror 优先） |
| `fallbackUrl` | GitHub asset（备选） |
| `/update-install`（走 Gitee） | 进度 0→100%，**约 2.0 MB/s，26.7 秒** 下完 52,827,911 B |
| 下载文件 SHA256 | `3DDE44…E4B2`，与发布包一致 |
| 结论 | 国内自动更新链路打通（测试时把 `spawn` 换成空实现，避免真的启动安装程序） |

### 25.3 体验版签发工具

- `seller-keys\签发体验版.cmd`（双击）：输入机器码/客户名 → 先跑 `tools\count-trial-licences.ps1`
  显示已购次数 → 确认后签 30 天、`edition=trial` 许可证。
- 也可以手动：
  `powershell -File seller-keys\make-licence.ps1 -Machine "..." -Name "..." -Days 30 -Edition trial`
- 签发记录留在 `seller-keys\licence-*.json`，作为限购 3 次的台账（该目录 gitignore，不能丢）。

## 26. 安全收紧：强制走 Tailscale，移除局域网直连（2026-10-31 晚，用户要求）

用户明确要求：**不管手机和电脑在不在同一个 Wi-Fi，都必须装 Tailscale 并登录同一账号**；
同一 Wi-Fi 只是让 Tailscale 自己走局域网直连（更快），**不能绕过 Tailscale 直接连电脑**。
之前文档/官网里“同一 Wi-Fi 不用装 Tailscale”的说法是错的，已全部改掉。

### 26.1 代码改动

- `start-screen.ps1`：画面服务只绑 `127.0.0.1` + tailnet IP；不再绑 LAN IP；
  不再生成 `screen-url-lan.txt` / `screen-qr-lan.png`；Tailscale 没连上时直接报错退出（不再降级到局域网）。
- `start-phone-access.ps1`：移除 DSH 的 LAN 门（`proxy-lan`）和 `lan-url.txt`；不再打印 LAN 地址。
- `supervise.ps1`：守护不再检查 `lan-url.txt`（否则会每 8 秒误判“门没起来”反复重启）。
- `screen-server.mjs`：增加来源闸门——只接受 `127.0.0.1` / `::1` / tailnet `100.64.0.0/10`；
  其它来源一律 403（即使以后误绑了 LAN 也进不来）。
- `harden-firewall.ps1` 注释、`README.md` 里的旧 LAN 说明同步更新。

### 26.2 验证（本机真实服务）

临时用 1.0.10 运行时 + 改后的 `screen-server.mjs`，同时绑 `127.0.0.1 / LAN 10.120.169.250 / tailnet 100.108.92.22`：

| 来源 | 结果 |
|---|---|
| `http://127.0.0.1:8773/?k=…` | **200** |
| `http://10.120.169.250:8773/?k=…`（同一局域网，带正确密钥） | **403**（只接受 Tailscale） |
| `http://100.108.92.22:8773/?k=…`（tailnet） | **200** |

### 26.3 状态

- 代码/文档已改，**未发版**（当前 latest 仍是 1.0.10，客户安装后仍是旧行为）。
- 需要发 **1.0.11**（安全修复）才会到客户机器；按发版规则等用户确认。
- 注意：老客户的 `screen-url-lan.txt` / 旧二维码在升级后会失效，需重新扫 tailnet 入口。
- Tailscale 安卓官方 APK 约 **100.8 MB**，超过蓝奏云免费单文件 100 MB 上限，没法直接放蓝奏云；
  需要换 123 云盘/奶牛快传/OSS 等支持更大文件的地方（或蓝奏云会员）。

## 27. 安卓 Tailscale 国内镜像（Gitee，2026-10-31 晚）

- 官方安卓 APK（1.104.4 universal）**105,698,535 字节**，超过 Gitee 单文件 100 MiB 上限（104,857,600），直接传不上去。
- 处理：用 7-Zip（7zr.exe）LZMA2 最高压缩，**105.7 MB → 27,996,631 字节（约 27 MB）**，单文件可传。
  压缩包 SHA256 `343B987BB4AAF7C1DFD19C50A616B9DB233A5A963D8D7CB6F3B139CE0E8EE8A0`；
  APK 本身 SHA256 `47628CECDE2DE0ED03F4A69424635259023DAF76FB5D9AFEEDDFA62761690984`（与 GitHub 官方 digest 一致）。
- Gitee 发行版 tag `tailscale-android-1.104.4`，附件 `Tailscale-Android-1.104.4.7z`（27.9 MB）。
  直链：`https://gitee.com/menhuayuchen/phone-access-download/releases/download/tailscale-android-1.104.4/Tailscale-Android-1.104.4.7z`
  实测无 cookie 下载 200、2.08 MB/s、13.4 秒，哈希一致。
- 官网 FAQ 与《使用说明》《客户使用指南》已改成：安卓优先用 Gitee 这个 7z（ZArchiver 解压后安装），Google Play/官方 GitHub 作为备选。
- Windows 版 Tailscale（114.7 MB）这次传错、也没传；需要的话同样可以 7z 压到 100MB 以内再放 Gitee。
- 之前误建的空发行版 `tailscale-1.104.4` 已删除。

- 补充（同日）：用户把 27.9 MB 的 `Tailscale-Android-1.104.4.7z` 上传到蓝奏云文件夹
  `https://wwatu.lanzouv.com/b01i5yx5ng`（密码 `dcvr`）；官网 FAQ、使用说明、客户指南已同时列出
  「Gitee 镜像」和「蓝奏云」两个国内下载点（二者是同一个 7z，APK 哈希一致）。

## 28. 开机自启排查与加快（2026-10-31 晚，用户反馈“好像没有做开机自启”）

### 28.1 现场证据：其实有自启，只是慢 + 需要登录

- 计划任务 `DSH Phone Access` 存在且启用：**登录时触发** + 每 2 分钟兜底重试；动作是 `wscript run-autostart.vbs`。
- 今晚 20:45:50 重启，`autostart.log`：
  - 20:46:07 autostart begin（重启后 17 秒就触发了）
  - 20:47:17 network ready（等了 70 秒 IPv4）
  - 20:47:50 画面服务起来（supervisor.log `=== supervisor start ===`）
  → 服务确实自启了，但**开机后约 2 分钟**才可用，用户在这之前试就会以为没自启。
- 另一个硬限制：计划任务是**用户会话级**。重启后停在登录界面/注销状态不会运行（锁屏可以）。
  抓屏也必须有桌面会话，所以这是产品设计约束，不是 bug。

### 28.2 改动

- `autostart.ps1`：删掉「等 2 分钟网络就绪」的循环，**立即启动**；Tailscale 没连上时由守护进程每 8 秒重试。
- 已把新 `autostart.ps1` 热补到本机安装目录（旧文件备份为 `autostart.ps1.bak-before-20261031`），
  手动跑一遍耗时 15.1 秒（服务已全部在跑的情况），不再空等。
- 文档：使用说明/客户使用指南的「日常维护」改成「登录后约 10~60 秒起来」；
  官网 FAQ 新增「重启电脑后要手动启动吗？会开机自启吗？」说明登录要求和自动登录选项。
- 未发版：这些改动要等 **1.0.11** 才能到客户机器；本机是热补。

### 28.3 给用户的建议

- 重启后**先登录 Windows**（锁屏没关系），等 10~60 秒再连。
- 要真的“无人值守开机就能连”，必须开 Windows 自动登录（设置→账户→登录选项 / `netplwiz`），
  代价是本机安全性下降。
- 若登录后超过 2 分钟还连不上，双击「自查」把报告发来。

## 29. 主题 / 光标自定义取色器（2026-10-31 晚，用户要求）

- 设置 → 个性化里新增两组取色器：
  - **自定义配色（主题）**：背景 / 顶栏 / 按钮 / 文字 / 强调 五个 `<input type="color">`，
    改动即保存 `pa.customTheme` 并自动切到「自定义」主题（`pa-t-custom`），实时生效。
  - **光标自定义颜色**：6 个预设色旁边新增一个取色器，任意 `#hex`；保存 `pa.cursor.color` 并立即应用，
    若颜色恰好等于某个预设色会高亮对应色块。
- 兼容：免费/过期用户两组取色器都 `disabled`（保持个性化锁定）；选「自定义图片」光标时颜色取色器禁用；
  手写 JSON 导入后会把值同步回取色器，方便继续微调。`toColorInput()` 负责把 #abc / #rrggbbaa 归一成 #rrggbb。
- 实测（桩环境）：光标取色 #ff00aa → `#dot` 与预览变 `rgb(255,0,170)`，localStorage 记录正确；
  主题背景 #ff0000 → body 变 `pa-t-custom`、计算背景 `rgb(255,0,0)`，自定义主题 JSON 正确；
  expired（免费）时两组取色器均 disabled。
- 未发版：这些改动要等 **1.0.11** 才能到客户机器。

## 30. v1.0.11 发布（首个公开版，2026-10-31 深夜，用户批准）

- 版本号 1.0.11；GitHub Release `v1.0.11`（`/releases/latest`），asset `PhoneAccess-Setup-v1.0.11.exe`
  **52,829,458 B**，SHA256 `D8C3B1C0A5E7288D05B74F3218A150DA921AE117254B2F88E288FD398155FB26`。
- Gitee 发行版 `v1.0.11` 同文件；直链实测 200、**2.1 MB/s / 24.9 秒**、哈希一致。
- 用户要求「其他所有版本全部撤下来」：
  - GitHub：删除 v1.0.6/1.0.7/1.0.8/1.0.9/1.0.10 的 Release **和 tag**，现在只剩 v1.0.11 一个 release。
  - Gitee：删除旧产品发行版（v1.0.9 中文 tag、v1.0.10），只保留 `v1.0.11` 和 Tailscale 安卓镜像 `tailscale-android-1.104.4`。
  - 官网：移除蓝奏云「产品安装包」卡片（那个分享里是旧版）；`update.mirrorPage` 清空，
    等卖家把 1.0.11 传到蓝奏云后再填回。
- 官网下载区已更新为 v1.0.11 / 新 SHA；线上验证通过。
- 镜像链路验证：用 dist 的 1.0.11 代码起临时服务、配置 version 改成 1.0.10 模拟老客户 →
  `/update-check` 返回 `latest=1.0.11`、`downloadUrl=Gitee`、`fallbackUrl=GitHub`。
- 本机安装目录仍是 1.0.10，需要手动装一次 `dist\【点这里安装】手机远程-v1.0.11.exe`。

## 31. 官网加回蓝奏云产品安装包入口（2026-10-31 深夜）

- 用户提供 v1.0.11 的蓝奏云分享：`https://wwatu.lanzouv.com/iyNBv4e677ed`（密码 `95kq`）。
- 官网下载区恢复第三张卡片「蓝奏云（手动）」，密码 95kq；线上已验证。
- `product.config.json` 的 `update.mirrorPage` / `mirrorPageNote` 填回该链接与密码，
  **下一次打包**起，App 内更新失败会显示「国内网盘下载（手动）· 密码 95kq」。
- 注意：已经发布的 v1.0.11 安装包里配置是空的（发布时清掉了旧蓝奏云），
  所以现有客户的 App 内还看不到这个入口；要全员生效需再发一版（或手动改客户本机配置）。

## 32. Tailscale HTTPS / “安装到桌面”说明（2026-10-31 深夜）

- 产品侧：`https-setup.ps1` 会探测 tailnet 能否签证书；能签就自动
  `tailscale serve --bg --https=443 http://127.0.0.1:8660`，并把 `https://<机器名>.ts.net/?k=…` 写进 `screen-url.txt`。
  前提是客户在 **Tailscale 后台 → DNS → HTTPS Certificates** 点过 Enable HTTPS（一次性，不跟安装包走）。
- 文档：官网 FAQ 新增「手机上怎么‘安装到桌面’？为什么要开 HTTPS？」；《使用说明》《客户使用指南》的
  「装到手机桌面」一节补充了 4 步开启方法（后台地址 + 官方文档链接）。线上已验证。
- 说明要点：HTTPS 是浏览器“安装应用/添加到主屏幕”的硬要求；不开也能 http 浏览，只是不能装成 App；
  `tailscale serve` 只在 tailnet 内，不是公网 Funnel。
- App 侧改动（`update.mirrorPage` = 蓝奏云新分享 + 密码 95kq）已写进配置，**等下次打包**一起带上；
  本次不另发版本。

## 33. 第二轮独立审查：鉴权模型重写 + 更新校验（2026-10-31 23:3x，未发版）

第二轮会话审查交接文档，抓到一个 P0：`tailscale serve` 把请求变成 127.0.0.1，旧模型「本机自连免鉴权 + 危险路径黑名单」
让 `/licence` 可无密钥读写。**追加核实发现更严重**：`/frame.jpg`、`/stream` 也不在严格名单里，
同 tailnet 任何人不用密钥即可看屏幕；`/update-progress`、`/health` 也可读。

### 33.1 修复（都在仓库，未发版）

- **鉴权反转**：默认必须密钥（`?k=` 或 `screen-key` cookie）+ 显式公开白名单
  （`/health`、`/sw.js`、两个 icon、`/branding/*.png|jpg`、`/manifest.json` 的短时 token）。
  删除 `STRICT_AUTH_PATHS` 黑名单和 `isLocalConn` 豁免；跨站写请求仍拒。
- **WS upgrade 来源闸门**：抽出 `sourceAllowed()`；`/ws-audio` 加 403；`/rtc` 的 isAllowed 先过它。
- **限流**：优先用 `Tailscale-User-Login`；回环且无身份时只记日志不锁定（避免一台设备锁死整个 tailnet）。
- **下载校验**：`/update-check` 返回 GitHub asset digest（sha256）；页面随 `/update-install` 提交；
  服务端下载后算哈希，不一致报错、删文件、不启动安装程序；配置 `update.sha256` 可兜底。
- **镜像防旧包**：mirror URL 里写死的版本号与 latest 不一致时，忽略镜像、回退 GitHub。
- **绑定白名单**：只允许 `127.0.0.0/8` + `100.64.0.0/10`，LAN IP 直接拒绝绑定。
- 清理：`Get-LanIp` 死代码、启动提示旧文案、心跳阈值注释。

### 33.2 实测

- 无密钥：`/` 401、`/frame.jpg` 401、`/stream` 401、`/licence` 401、`/update-progress` 401、
  `/manifest.json` 401；`/health` 200。带 `?k=` 打开 `/` 得 cookie 后，以上均 200（浏览器页面正常）。
- LAN 地址进绑定白名单：被拒绝，只绑回环。
- 错误 sha256：下载 25.1s 后返回「安装包校验失败…已停止」，临时目录无 exe。
- 把 mirror 改成 v1.0.10 而 latest=1.0.11：返回 `mirror=false`、downloadUrl 回 GitHub。
- 注意：1.0.11 页面还没有 sha256 字段，这套校验只在 **1.0.12+** 生效。

### 33.3 状态与热补

- 本机安装目录 `screen-server.mjs` 已替换为新版（备份 `screen-server.mjs.bak-before-20261031-auth`），
  但**运行中的进程仍是旧代码**（PID 46280，权限不足无法结束），要重启程序/电脑才生效。
- **未发版**；建议发 1.0.12 带这些安全修复，仍需用户明确同意。

## 34. v1.0.12 发布（安全修复，2026-11-01 00:1x，用户批准）

- 版本号 1.0.12；GitHub Release `v1.0.12`（唯一 release，`/releases/latest`），
  asset `PhoneAccess-Setup-v1.0.12.exe` **52,829,608 B**，
  SHA256 `8A282A56A145A5CB8E4AC4D27C041FC7E0A754A059EBB140DDFADEAD8FBC92B2`。
- Gitee 发行版 `v1.0.12` 同文件；直链实测 200、25.0 秒、哈希一致。
- 旧版本：GitHub v1.0.11 的 release+tag、Gitee v1.0.11 发行版已删除；只剩 v1.0.12
  （Gitee 另有 Tailscale 安卓镜像）。
- 官网已更新 v1.0.12 / 新 SHA；蓝奏云「产品安装包」入口再次撤下（分享里是 1.0.11），
  `update.mirrorPage` 在 1.0.12 配置里为空。等用户把 1.0.12 传蓝奏云后再加。
- 镜像链路验证（模拟 1.0.11 客户端）：`/update-check` 返回 latest=1.0.12、downloadUrl=Gitee、
  fallback=GitHub、sha256=8a28…；镜像命中。
- 1.0.12 含本轮全部安全修复：默认必须密钥+公开白名单、WS 来源闸门、限流按身份、
  更新包 SHA256 校验、镜像版本校验、绑定只允许回环/Tailscale。
- 本机安装目录仍运行旧进程（权限不足未重启）；需要手动装一次 1.0.12 才会用上新鉴权。

- 补充（2026-11-01 00:3x）：用户提供 1.0.12 的蓝奏云分享
  `https://wwatu.lanzouv.com/irVYv4e6e1id`（密码 `4pp2`）；官网已加回第三张卡片并线上验证。
  仓库配置的 `update.mirrorPage`/`mirrorPageNote` 已指向它（**1.0.12 安装包内仍为空**，下次打包生效）。

## 35. 官网新增视频教程（2026-11-01 傍晚）

- 用户提供三个本地视频：`D:\视频稿\前言.mp4`（25.5s/30.9MB）、`下载安装教程.mp4`（847s/620.6MB）、
  `使用教程.mp4`（418s/490.8MB）。
- 用 `D:\download\办共\pipeline\bin\ffmpeg.exe` 压成网页版：1440 宽、H.264 CRF30、maxrate 1400k、
  AAC 96k、faststart：
  - `intro.mp4` 2.25MB
  - `install.mp4` 34.2MB
  - `usage.mp4` 23.8MB
  - 封面 `intro.jpg` / `install.jpg` / `usage.jpg`
- 托管：**GitHub Pages 的 `gh-pages` 分支 `videos/` 目录**（不是 Gitee 发行版——实测 Gitee 附件的
  `Content-Disposition: attachment` 且不支持 Range，不能做视频流）。线上验证：
  `Content-Type: video/mp4`、`Accept-Ranges: bytes`、Range 返回 206；页面三个 `<video>` readyState=4。
- 官网（master `site/index.html` + gh-pages）新增 `#videos` 区块 + 导航「视频教程」：
  前言 / 下载安装教程 / 使用教程 三张卡片，带简单描述、封面、直接播放；下方有直接下载链接。
- 视频只存在 gh-pages（不塞进 master git，避免仓库重复膨胀）；以后换视频 = 更新 gh-pages 的 videos/ 并重新构建。
- 本机保留了压好的源文件在 `D:\视频稿\web\`，方便以后重传。

## 36. 视频教程改用 B 站 + 前言更新（2026-11-01 晚）

- 用户上传了三个 B 站视频：
  - 前言 `BV1ppxx6CEZW`（35s，标题「手机远程 · 前言：这是什么，太好用了」）
  - 下载安装教程 `BV1WHxx65Eqm`（848s）
  - 使用教程 `BV1LBxx6YESB`（419s）
- **B 站 iframe 内嵌在 github.io 上被限制**：直接打开 player 正常；从 `github.io` 页面 iframe 打开只显示
  「你感兴趣的视频都在B站」的占位；从 `127.0.0.1` 本地页面 iframe 测试则正常播放。
  试过加 `isOutside/aid/cid`、改 referrerPolicy 都无效 → 判定是 B 站对 github.io 来源的嵌入限制。
- 因此页面改成**封面点击跳 B 站**：三张封面（`videos/*.jpg`）+ 播放图标 + 「在 B 站观看 · 时长」角标，
  点击新窗口打开对应 B 站视频；下方保留离线下载链接。
- 用户把前言换成了 `D:\视频稿\前言1.mp4`（34.2s/1726x1080）；已重新压成 `videos/intro.mp4`（3.17MB）
  并替换 gh-pages 上的封面/视频，页面文案改成 35 秒。
- 清理：Gitee 仓库里测试用的 `videos/*`、`tmp/test-*.bin` 已删除（Gitee raw 超过约 10MB 会要求登录，
  本来就不能当视频源；B 站发行版/附件同样不适合）。
- 线上验证：页面 `vidcover` 三张封面图片自然宽 960、链接 BV 正确；B 站 embed 的坑记录在此。

## 37. 触摸手势改进（2026-11-02，未发版）

- 双指滚轮：只在两指落下时 move 到两指正中，之后光标**固定**，直到双指全部抬起；wheel 只按纵向位移发，滚动始终在起始中点。
- 缩放改为 **三指及以上**：所有触点质心=手心；先 move 到质心，再 Ctrl down + wheel（张开=放大，捏合=缩小），每 10% 走一格；touchend/touchcancel/失焦/切后台/pagehide 都补 Ctrl up。
- 合成 Touch 验证：双指事件为 `move(起点) → wheel`（移动后没有再次 move）；三指序列为 `move→Ctrl down→move→wheel d=6→Ctrl up`。
- 使用说明/README 已同步；iPad 三指/五指可能与系统多任务手势冲突，需真机复测。

## 38. 双缩放模式 + 画面缩放恢复按钮（2026-11-02，未发版）

- 设置新增「缩放方式」：`系统缩放`（默认，三指及以上发 Ctrl+滚轮）/ `画面缩放`（只对 #img/#vid 做 CSS transform，电脑端零输入），偏好存 localStorage.zoomMode。
- 画面缩放：以手心为不动点，scale 1~5；左侧新增 `#viewReset`（恢复原大小），仅 scale>1 显示，点击归位并隐藏。
- 坐标换算：`toScreen()` 在 view.scale≠1 时先反算回未缩放坐标，`toPage()` 再正向变换；实测 zoom=2 时 `toPage(1000,500)→toScreen` 仍回到 (1000,500)。
- 验证：view 模式三指张开→ `#img` transform scale 2、`#viewReset` 显示、无任何 /input 事件；点恢复→ transform 清空、按钮隐藏；system 模式仍为 move→Ctrl down→wheel→Ctrl up。- 修复：画面缩放后 contentBox() 不能用 el.getBoundingClientRect()（会返回放大后的框，导致二次缩放、点哪都偏），改用 stage.getBoundingClientRect()；多指手势结束/取消时复位 ptr/dragBtn/longTimer，保证下一次单指正常。

## 39. v1.0.13 发布（2026-11-02 21:1x，用户批准）

- 版本 1.0.13，GitHub 唯一 release v1.0.13；asset `PhoneAccess-Setup-v1.0.13.exe` 52,833,674 B，
  SHA256 `6E6DD9E0450BAB31766C12D3348EF2551E5C19E1400F36C2BA2EFD5F732EE5AB`。
- Gitee v1.0.13 同文件；直链实测 200、25.7 秒、哈希一致。
- 旧版本：GitHub/Gitee 的 v1.0.12 release+tag 已删除，只剩 v1.0.13（Gitee 另有 Tailscale 安卓镜像）。
- 官网更新 v1.0.13/SHA；蓝奏云产品入口撤下（分享仍是 1.0.12），配置 mirrorPage 置空；蓝奏云新分享等用户上传后再加。
- `/update-check` 模拟 1.0.12 客户端：latest=1.0.13、downloadUrl=Gitee、sha256 正确。
- 内容：三指及以上缩放（顶部「缩放」折叠窗切换系统/画面；画面缩放光标跟手心、松手保持、左侧恢复）、双指光标固定、多指结束复位、画面缩放坐标反算。