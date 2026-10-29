# STATUS · 手机远程控制产品 交接文档

> **新会话第一件事：读这个文件。**
> 读完你应该知道：产品是什么、现在能不能用、哪里是坏的、下一步做什么、怎么验。
>
> 最后更新：2026-10-29

---

## 一、这是什么

Windows 上的自建产品：**客户用自己手机，看自己电脑的屏幕并操作它**。
走 Tailscale 私有网络，不经过任何第三方服务器。装一次，永久使用。

**商业形态**：卖家（本人）交付安装包 + 签发许可证。客户用自己的 Tailscale 账号。
**卖家进不去客户电脑**——技术上到不了，这是核心卖点。

---

## 二、现在能用的（都实测过）

| 功能 | 状态 | 怎么验 |
|---|---|---|
| 手机看画面 + 触控 | ✅ | 手机打开入口地址，画面在动、点一下光标真的动 |
| 许可证（贴短码 / 放文件） | ✅ | 手机遮罩页粘贴 → 2 秒生效 |
| 一键卸载 | ✅ | 桌面「卸载」→ 输入 YES → 六步撤干净 |
| 一键重启 | ✅ | 桌面「重启」→ 三步全绿 |
| 画面质量档位 | ✅ | 改 `maxCaptureWidth` → **杀掉 screen-server 再启动** → 查 `capture.exe` 参数 |
| 检查更新 | ✅ | 设置面板点「检查更新」；未配置更新源时提示"联系卖家" |
| PWA 装到手机桌面 | ✅ | 手机浏览器「添加到主屏幕」，图标是显示器+手机 |
| 客户机不出现 DSH | ✅ | 客户版 `enableDsh=false`，8642/8650 两扇门不启动 |

**当前实机状态**（2026-10-29 16:37）：

```
capture.exe 宽度=2560 间隔=40ms      ← 高清抓屏
health: in=2.0 out=0.0 cap=33       ← 无人观看时抓屏会停，正常
监听 8660 × 3 地址（回环+tailnet+局域网）
监听 8642 × 3 地址（8642 回环=DSH本体；tailnet/局域网=门）
配置 enableDsh=True（这台是卖家自用；客户版是 False）
```

**帧率基线**：2560 宽实机约 **24 fps**（`in=24.5 out=24.0`），抓屏受 CPU 限制。
降分辨率可提帧率，实测 1920 时 `capture.exe` 参数会变。

---

## 三、现在坏的（两个高危，未修）

**完整清单在**：`docs\独立审查包-第二轮\05-修复清单.md`（每条都有可执行验收标准）

### P0-1 · `/manifest.json` 泄露访问密钥（高危）

```
screen-server.mjs 的 /manifest.json 路由
  · 在 LICENCE_OPEN_PATHS 里，不在 STRICT_AUTH_PATHS 里
  · start_url: '/?k=' + KEY          ← 响应体里带着完整密钥
  · cache-control: max-age=86400
```

任何 tailnet 对端 GET 一次就拿到密钥 → `/input`、`/exec`、`/frame.jpg` 全解锁。
**这是上一轮 H1 的同类洞，修鉴权时漏了这个路由。**

### P0-2 · `DshInput` 目录提权（高危）

```
%LOCALAPPDATA%\DshInput\input.exe   用户可写
    ↑ 由 RunLevel Highest 的计划任务启动
    ↑ 还被加进 Defender 排除
```

用户级恶意代码替换 exe → 无 UAC 拿到管理员权限。

### 中低危（同一份清单里）

`/set-quality` `/update-check` 没进严格集合 · 许可证 `null` 字段两端判定不一致 ·
`mine` 为空时跳过机器码比对 · `\n` 拼接歧义 · 快捷方式 `-FallbackScript` 缺失 ·
文案说 4 个图标实际 6 个 · `%TEMP%` 安装日志可能留密钥 URL · `uninstall.ps1` 按进程名杀会误杀

---

## 四、下一步做什么

**照 `docs\独立审查包-第二轮\05-修复清单.md` 从 P0 开始。**

顺序不能乱：

1. **P0-1 单独做**，三处一起改（加 STRICT + start_url 去 key + 去长缓存），
   四条验收全过再往下
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

## 七、已知的版本不一致（待修）

| 项 | 值 |
|---|---|
| `product.config.json` 的 `version` | **1.0.0** |
| 交付包文件名 | **v1.0.3** |

手机「设置」里显示的是 1.0.0。下次改动时统一（建议改成 1.0.4 起，避免和已发出去的混淆）。

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
