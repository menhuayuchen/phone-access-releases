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

### 结论二：改画质后底部裁切——服务端帧完整，疑似重启抖动期的坏帧被手机定格（待 iPad 复测）

- 23:58 抓取的当时 1920x1200 帧：**任务栏完整**（视觉确认）；当前 2560 帧也完整——服务端没裁。
- 桌面浏览器复现"切画质→服务重启→双缓冲换流"全流程：`object-fit:contain` 布局正常，不变形不裁切。
- 最大嫌疑：用户 23:48 切画质时抓屏进程 **10 秒内重启 3 次**（日志三条 pipeline，2560↔1920 抖动），
  期间可能输出一帧裁切的不完整画面，手机页面定格在该帧 → 视觉上是"放大一点+底部没了"。
- 处置：服务已干净重启（现 2560 档 24.5fps），请用户 iPad 复测；若再现要新截图。

### 观察项（不影响结论）

- 22:01~23:11 之间显示状态变过：23:11 抓屏启动时 `Get-CaptureGeometry` 读到 **1920x1200**
  （source: dpi-aware-screen），00:13 起稳定读 2560x1600（现 240Hz）。用户"没动过/不记得"——
  疑为系统/驱动自动调整。若再现注意：显示掉到 1920x1200 时抓屏源也会跟着变小。

### 本轮后实机状态（2026-10-30 00:51）

health ok：`in=24.5 out=23.5`、frame SOF=2560x1600、source=pipe、uq=na（已授权）、input connected；
capture.exe=新 Bilinear 包（20480B，00:50 启动），旧包快照 `capture.exe.bilinear.bak` 在安装目录；
`product.config.json` maxCaptureWidth=2560（超清档，用户 App 当前档位）。
