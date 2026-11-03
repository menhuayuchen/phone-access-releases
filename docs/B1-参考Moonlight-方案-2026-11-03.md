# 参考 Moonlight/Sunshine 的高性能模式 · 可行性与集成方案（2026-11-03）

> 用户想法：Moonlight 延迟低、体验好，只是**配置太难**；我们应该尽量参考它，
> 甚至把「网页屏幕共享」降级成第二选择给客户。
> 本文回答三件事：能不能走、怎么落地、要改什么。

---

## 一、先说结论

**能走，而且最适合我们的走法是「把 Sunshine 集成成高性能模式」，而不是自己实现 Moonlight 协议。**

- Moonlight 的低延迟来自：**DXGI 抓屏 + GPU 硬编（NVENC/AMF/QSV）+ UDP 推流 + 客户端原生解码**。
  这套东西开源实现就是 **Sunshine**（被控端，GPL-3.0）。
- 我们不需要重写它：**把 Sunshine 静默安装 + 预配置 + 配对自动化 + 许可证控制**，
  客户手机装 Moonlight（或用我们引导的 APK），体验就是"+配置好的 Sunshine"。
- 网页模式保留为**第二选择**（免装 App、iOS 也能用、剪贴板/文件传输/手势都在网页里）。
  这样两个卖点都保住：网页 = 免装；Moonlight = 低延迟高性能。

> 一句话定位：**「不用配置的 Sunshine」+「免装 App 的网页模式」二合一。**

---

## 二、事实核对（2026-11-03 查证）

| 项 | 结论 | 来源 |
|---|---|---|
| Sunshine 许可证 | **GPL-3.0** | GitHub API `license: gpl-3.0` |
| Windows 支持 | 官方 MSI 安装包（AMD64），Windows 10/11；采集用 **DXGI Desktop Duplication**；硬编支持 NVENC / QuickSync / AMDCVE（+software 回落）；HDR/HEVC/AV1 均可 | [Sunshine 配置文档](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)、[Getting Started](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2getting__started.html) |
| 端口 | Web UI/控制 `47984–47990` TCP，视频/音频/控制 `47998–48010` UDP，`port` 默认 `47989` | 同上 |
| 配对 | Web UI 登录后在「PIN」页输入 Moonlight 显示的 PIN；REST API `POST /api/pin`（需要 `pairing_id`+`pin`+`name`，Basic Auth） | [Sunshine API](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2api.html) |
| 客户端 | Moonlight：Windows/macOS/Linux/Android/iOS/Apple TV/树莓派等；Android APK 在 GitHub releases | [moonlight-stream.org](https://moonlight-stream.org/)、[moonlight-android releases](https://github.com/moonlight-stream/moonlight-android/releases) |
| 安装 | MSI 支持静默安装；也可用 lite zip + 服务脚本（官方说明性能会下降） | Getting Started |

**待核实**（做 spike 时确认）：① iOS 版 Moonlight 在中国区 App Store 是否可搜到（搜不到就需要非大陆 Apple ID，
和 Tailscale 的现状一样）；② 新版 `pairing_id` 怎么获取（有没有"待配对列表"接口；没有的话退路是
引导客户在电脑的 Sunshine 页面里输 PIN，或我们在电脑侧做一个小配对窗）。

---

## 三、两种落地方式对比

| | **A. 集成 Sunshine（推荐）** | B. 自己实现 Moonlight 兼容协议 |
|---|---|---|
| 工作量 | 小-中：安装/配置/配对/许可证/卸载 + 引导 | 极大：协议、FEC、UDP 传输、硬编封装… |
| 延迟/画质 | 直接拿到 Moonlight 级（10–20ms，60fps，硬编） | 看实现水平，风险高 |
| 许可证合规 | 以**独立程序**分发（我们不改源码，只配置/调用）→ GPL 聚合，附 GPL 文本+源码链接即可（不是法律意见，建议发布前找懂 GPL 的人确认一次） | 自己写不受 GPL 约束，但等于重做 Sunshine |
| 维护 | 跟随上游升级（可锁定版本，客户可选升级） | 全部自己维护 |
| 手机要求 | 要装 Moonlight（Android APK / iOS App Store） | 要装 Moonlight（协议兼容） |

**建议 A。** 我们只在"配置太难"这件事上做产品化——这正是用户痛点，也是我们能赢的地方。

---

## 四、集成方案 A 的落地设计

### 4.1 电脑端（安装器）

1. 安装包里带 **Sunshine MSI**（锁版本，比如某稳定版），安装器里作为**可选项**：
   - 默认勾选「高性能模式（手机装 Moonlight 看电脑，延迟更低）」；
   - 磁盘占用、GPL 许可证、需要管理员权限都在安装向导里写清楚。
2. 静默安装（`msiexec /i ... /qn ...`），装完由我们写**预配置**（`sunshine.conf`）：
   - `bind_address` = 本机 tailnet IP（**只绑 Tailscale，不监听公网/LAN**，和现在产品口径一致）；
     若端口冲突自动换（`port` 可改）。
   - `encoder` 留 auto（让 Sunshine 自己选 NVENC/AMF/QSV）；
   - 预设两档：**流畅 1080p60 / 清晰 1440p60**（码率 6–12 Mbps，可调）；
   - 关闭 UPnP、关闭 Web UI 对 LAN 的访问（`origin_web_ui_allowed = pc` 或只允许回环）。
3. 生成随机强密码的 Sunshine Web 凭据，存在我们安装目录（只给本机/我们的服务用）。
4. 服务和自启：由我们的守护逻辑负责（或沿用 Sunshine 自带服务），随产品启动/停止。
5. **许可证联动**：高性能模式只对「已授权/试用中」开放（启动前由我们的 host 检查 `licence.state.json`，
   未授权只给低码率/低帧率或直接提示升级）。否则 Moonlight 通道会绕过我们的付费门槛。
6. 卸载：一并卸载 Sunshine、删配置、恢复防火墙。

### 4.2 手机端（我们的网页里做「配对助手」）

现有网页是新客户第一个打开的入口，天然适合当引导页：

1. 页面新增「高性能模式」卡片：
   - 状态：Sunshine 是否运行、Tailscale 直连/中继（复用 A3 体检数据）、当前码率/分辨率；
   - 步骤：① 装 Moonlight（安卓给 APK 镜像链接，和 Tailscale 一样走 Gitee；iOS 给 App Store 链接/提示）；
     ② Moonlight 里添加电脑（显示本机 tailnet 地址/主机名）；③ Moonlight 显示 PIN → 在我们页面输入 PIN →
     我们调 Sunshine API 完成配对；④ 选择「桌面」应用开始串流。
2. 配对实现：我们的 screen-server 在本机代理 Sunshine API（Basic Auth 凭据只在服务端），
   页面 POST 一个 4 位 PIN 即可。若配对接口需要 `pairing_id`，由我们服务端去查/缓存。
3. 失败引导：常见问题（防火墙、编码器不可用、Moonlight 版本太旧）直接列在卡片里。

### 4.3 两种模式怎么选（给客户的说明）

| | 网页模式（默认、免装 App） | 高性能模式（Moonlight） |
|---|---|---|
| 手机准备 | 什么都不用装 | 装 Moonlight（安卓 APK / iOS App Store） |
| 延迟/帧率 | 办公够用（1080p 30fps 左右） | **10–20ms，60fps，硬编** |
| 画质 | 2560 超清（MJPEG） | 1080p/1440p 60fps（H.264/HEVC 硬编） |
| 触控与手势 | 圆点/缩放/双指滚动/剪贴板/文件传输 | Moonlight 自己的触控（鼠标相对/绝对模式，手势少） |
| 适用 | 临时看一眼、iOS 想免装、弱网 | 长时间操作、看视频/动画、对"卡"敏感 |

> 建议默认给新客户看「网页模式」（零门槛），把「高性能模式」作为**进阶选项**推荐给回头客/重度用户。

---

## 五、风险与要提前做的决定

1. **GPL-3.0**：我们以独立程序分发 Sunshine、不修改其源码 → 聚合分发。
   需要随包附 GPL 文本、上游源码链接、声明"未修改"。**建议发布前做一次合规确认**（我不做法律判断）。
2. **安全面变大**：Sunshine 有自己的 Web UI/端口/凭据，必须只绑 tailnet/回环、强密码、关闭 UPnP；
   我们"卖家进不去"的承诺本身不受影响（Sunshine 是客户自己的机器上的软件），但**文档要重写安全口径**。
3. **iOS 不确定性**：中国区 App Store 可能搜不到 Moonlight → iOS 继续用网页模式（正好对应"网页做第二选择"）。
4. **触控体验差异**：Moonlight 是游戏向客户端，桌面办公的触控（长按右键、双指滚动、捏合缩放）
   不如我们网页；这决定了两者长期并存，而不是互相替代。
5. **许可/收费口径**：Moonlight 通道必须纳入我们的授权体系（否则 ¥68 买断被绕过）。
6. **资源占用**：Sunshine 常驻会多一个进程和一套端口；只在"高性能模式"启用时启动可降低影响。
7. **上游变化**：锁版本 + 客户可选升级，避免新版 Sunshine 破坏预配置。

---

## 六、分阶段计划（不发布，先候选）

| 阶段 | 内容 | 产出 | 预计 |
|---|---|---|---|
| **S1 可行性 spike** | 在一台**测试机/虚拟机**上装 Sunshine，手写预配置，验证：绑定 tailnet、配对、1080p60/1440p60 的实际 fps/延迟/CPU；确认 `pairing_id` 获取方式与 iOS 客户端可得性 | spike 报告 + 一键配置脚本原型 | 0.5–1 天 |
| S2 安装器集成 | MSI 静默安装/卸载、预配置写入、凭据生成、服务与自启、许可证 gate | 可安装的候选包（不上传） | 1–2 天 |
| S3 配对助手 | 网页「高性能模式」卡片 + 服务端代理配对 API + 状态展示 + 失败引导 | 手机端可自助配对 | 1–2 天 |
| S4 打磨 | 码率/分辨率自适应（根据 A3 的直连/中继数据）、断线回落网页、文档与合规材料 | 验收通过 | 1–2 天 |

**验收**：手机装 Moonlight，从我们页面完成配对 ≤3 步；1080p60 稳定、延迟 <40ms（同 tailnet 直连）、
CPU 明显低于 MJPEG；不支持/装不了 Moonlight 时网页模式照常可用；卸载干净。

## 七、和之前 B1 路线的关系

- 之前的「B1 路线 A（榨干 MJPEG）/B（WebRTC）」仍然有用：**它们是网页模式的优化**，
  不是替代品。Sunshine 集成（本文）是**第三条独立通道**。
- 建议优先级：**先做本文 S1/S2/S3**（用户明确想参考 Moonlight），网页优化（B1 A）穿插做；
  自研 WebCodecs（路线 C）**暂缓**——除非将来要"网页也 60fps、且不想让客户装 Moonlight"。

## 八、需要用户拍板的三件事

1. **分发方式**：Sunshine 随包静默安装（默认勾选），还是"可选组件/按需下载"？（体积/合规考虑）
2. **GPL 合规**：接受"独立程序聚合 + GPL 文本 + 源码链接"这套做法吗？（需要一次合规确认）
3. **收费口径**：高性能模式是否只对已授权/试用用户开放？（我建议是，否则绕过 ¥68）

---

## 九、S1 spike 结果（2026-11-03 19:0x，主机临时目录便携运行，**未改系统**）

做法：下载官方 Sunshine-Windows-AMD64-lite.zip（v2026.914.233613，36.3 MB）解压到 %TEMP%，
用自定义 sunshine.conf（ind_address=127.0.0.1、port=47989、upnp=disabled、
origin_web_ui_allowed=pc、encoder=software）直接跑 sunshine.exe，测完即杀、目录删除。
**没有装 MSI、没有加服务/防火墙规则**——验证 API 与自动化，不碰客户机式改动。

实测结论（全部通过）：

| 验证项 | 结果 |
|---|---|
| 只绑回环 | 
etstat 只有 127.0.0.1:47984 / 47989 / 47990 / 48010，**没有 0.0.0.0**（ind_address 生效） |
| 首次凭据 | **POST /api/password 在未设置用户名时无需认证**，返回 {"status":true}，生成 sunshine_state.json。→ 安装后可由脚本自动设强密码，客户不用碰 Web UI |
| 待配对列表 | GET /api/pin → {"pairings":[]}（源码 getPendingPairings，返回 {id,name,address}）→ **配对助手可以自动发现手机请求** |
| 提交 PIN | POST /api/pin {pairing_id,pin,name}：没有对应请求时返回 {"status":false}（不崩）；id 格式非法 → 400 |
| 错误凭据 | 401（Basic Auth 有效） |
| 配置回读 | GET /api/config 回读我们写的 conf（bind_address/encoder/upnp/port 全对） |
| 编码器 | 本次强制 encoder=software（只测 API），真实机器要再确认 AMF/NVENC 是否可用 |

另外从源码/文档确认的集成细节：

- **MSI 静默安装**会执行 scripts\sunshine-setup.ps1 -Action install -Silent：迁移配置、**加防火墙规则**、
  装 Windows 服务、设自启。→ 我们装完后必须把防火墙规则收紧到**只允许 tailnet**（和 harden-firewall.ps1 同一口径），
  否则端口会对 LAN 敞开。
- Windows 默认配置目录 %ProgramFiles%\Sunshine\config（sunshine.conf + pps.json + sunshine_state.json）。
- pps.json 需要至少一个「Desktop」应用（无命令，直接串流桌面）；官方 lite 包自带一个模板。
- 可用 sunshine.exe <conf> --creds user pass 预设凭据，但需要优雅退出才落盘；
  **更稳的是首次启动后调 POST /api/password**（已验证）。
- 配对助手流程：手机 Moonlight 添加电脑 → Sunshine 产生待配对请求（GET /api/pin 可查）→
  我们页面显示设备名/地址 → 客户输入 PIN → 服务端 POST /api/pin → 完成。**全程不用打开 Sunshine 网页**。

**还没做（需要真机/虚拟机 + 客户手机）**：MSI 静默安装与服务/防火墙收紧、真实硬编检测、
Moonlight 客户端实际串流（fps/延迟/码率/手机发热）、iOS 客户端可得性。
这两项等许可后在一台可折腾的机器上做（不碰卖家本机运行中的产品）。
---

## 十、VM 实测：MSI 安装 / 配置 / 凭据 / 配对接口 / 防火墙 / 卸载（2026-11-03 19:3x）

环境：VMware 虚拟机 Win10 22H2（4 vCPU / 4GB，1024×768），用 mrun -gu 1hao -gp *** 在 guest 里执行；
所有文件通过宿主机共享/复制进去，测完已清理，VM 恢复干净（Sunshine 已卸载、配置残留已删、共享文件夹已移除）。

| 验证项 | 结果 |
|---|---|
| 静默安装 | msiexec /i Sunshine-Windows-AMD64-installer.msi /qn /l*v → **exit 0**，自动装出 SunshineService（Automatic，已运行） |
| 预配置生效 | 写 C:\Program Files\Sunshine\config\sunshine.conf（ind_address=127.0.0.1、port=47989、upnp=disabled、origin_web_ui_allowed=pc、encoder=software）+ 重启服务后，只监听 127.0.0.1:47984 / 47989 / 47990 / 48010，**没有 0.0.0.0** |
| 启动时延 | 服务重启后约 **15–20 秒** Web UI 才可用（安装脚本必须轮询 /api/config，不能用固定 sleep） |
| 首次凭据 | 未设凭据时 POST /api/password（无认证）→ {"status":true}；随后带 Basic Auth 的 GET /api/pin → {"pairings":[]}、GET /api/clients/list 正常 |
| 防火墙 | MSI 默认加 **两条 Inbound Allow 规则**（名字 Sunshine，TCP + UDP，emote=Any，profile=Any）→ **必须收紧**；Set-NetFirewallRule -RemoteAddress 100.64.0.0/10,127.0.0.1 实测生效（回读 100.64.0.0/255.192.0.0,127.0.0.1） |
| 卸载 | msiexec /x {F4B3C08C-F867-4367-9465-6DAB091E5FB6} /qn → exit 0；服务没了、防火墙规则清空；**但 C:\Program Files\Sunshine\config 会残留**（conf/state/logs/credentials）→ 我们的卸载器必须显式删掉 |
| 硬件编码 | VM 无 GPU 直通，只有 libx264 [software] → **硬编/60fps/延迟必须到真机验证** |

**结论**：安装、预配置、自动设密码、配对接口、防火墙收紧、卸载清理——**六条路径全部可自动化**。
集成方案（S2）按上面的顺序写脚本即可；剩下的真实性能与 Moonlight 客户端联通，等有 GPU 的真机 + 手机再验。

**安装器时序（给 S2 的硬要求）**：
1) msiexec /i ... /qn 等退出码 0；
2) 写 sunshine.conf → Restart-Service SunshineService；
3) **轮询** https://127.0.0.1:47990/api/config（跳过证书校验），最多 60 秒；
4) 连续两次成功后再 POST /api/password 设随机凭据（幂等：已有凭据则跳过）；
5) Set-NetFirewallRule -DisplayName 'Sunshine' -RemoteAddress 100.64.0.0/10,127.0.0.1（找不到规则就跳过并记日志）；
6) 卸载时：先 msiexec /x，再删 %ProgramFiles%\Sunshine\config，最后确认服务/规则都消失。