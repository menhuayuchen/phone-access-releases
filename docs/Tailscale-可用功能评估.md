# Tailscale 功能盘点与「轻屏」可用性评估

日期：2026-11-09 · 本机实测版本：Tailscale **1.104.2**（`C:\Program Files\Tailscale\tailscale.exe`）
评估对象：`phone-access-product`（Windows 被控端 + 手机浏览器观看/触控，走 Tailscale 私网）

> 结论一句话：**Tailscale 的能力我们只用了大约三分之一，而且剩下的那部分里，真正"低成本、高收益"的只有三件事：`netcheck` 网络体检、中继区域可视化、公网暴露（Funnel）检测。**
> 其余能力要么被平台门槛挡死（Windows 无 SSH 服务端、Taildrop 限同一用户、Taildrive 共享节点读不到），要么会和"客户用自己的账号、我们不进客户网络"这条 selling point 冲突。

---

## 一、现在到底用了 Tailscale 的哪些能力

| # | 能力 | 用在哪（证据） | 说明 |
|---|---|---|---|
| 1 | 私网连通（WireGuard 打洞 + DERP 兜底） | 全产品的基础 | 手机与电脑的唯一通道 |
| 2 | `tailscale serve --bg --https=443` | `app/screen-server.mjs:3300`、`app/https-setup.ps1`、`app/start-screen.ps1:265` | 给 PWA 用的 HTTPS 域名入口 |
| 3 | `tailscale serve --http=80 / 8443` | 本机 `serve status` 实测：80→8650、8443→8650、443→8660 | DSH 门（`enableDsh` 时才起） |
| 4 | `tailscale ip -4` / `status --json` 自动发现 | `app/product-config.ps1:250`、`app/supervise.ps1:42` | 取 tailnet IP 做监听地址与入口文件 |
| 5 | `Tailscale-User-Login` 请求头 | `app/screen-server.mjs:2117` | 猜密钥失败计数的 key（避免整个 tailnet 被锁） |
| 6 | 防火墙只放 `100.64.0.0/10` | `app/install.ps1:729` 起 | 局域网设备进不来 |
| 7 | 状态面板 `/tailscale-status` | `app/screen-server.mjs:2300`、`app/page.mjs:4250` | 安装/登录/在线/直连或中继/peer 列表 |
| 8 | 一键装 Tailscale、一键开 HTTPS | `screen-server.mjs:3281`、`:3300` | 把客户最大的门槛收进页面 |
| 9 | 节点密钥到期检查 | `app/selfcheck.ps1:764` | "半年后突然连不上"的预警 |
| 10 | 节点共享（node sharing） | 文档层（`交付说明.md`、`临时支持窗口-设计.md`） | 常驻档的官方机制，代码未接 |

**一句话**：连通、HTTPS 入口、状态展示这三块做得挺全。缺的是**诊断**和**防呆**。

---

## 二、本机实测数据（可直接引用给客户/客服）

```
UDP: true                        ← UDP 出得去，打洞有可能
IPv4: 202.204.205.115            ← 有公网映射（但不是固定的）
MappingVariesByDestIP: true      ← 对称 NAT：打洞成功率低，4G 下多半走中继
PortMapping: (空)                ← 路由器没开 UPnP/NAT-PMP
Nearest DERP: Singapore 70.1ms
DERP 延迟: sin 70 / tok 89 / nue 152 / sfo 162 / syd 165 / lax 165 / sea 172
```

- 官方 DERP 全球 28 个区域，**离中国大陆最近的是香港(hkg)、新加坡(sin)、东京(tok)**，无大陆节点。
  本机这次探测里 **hkg 没出现在延迟表里**（大概率超时/被阻），实际落在 sin 70ms、tok 89ms。
- 所以"4G 下能用但不如同一 Wi-Fi"是物理规律，不是 bug：同 Wi-Fi 时 `CurAddr` 是局域网地址（实测 `10.120.75.237:52927`）＝真直连；4G 下多半 `relay=sin`。
- **对称 NAT + 无端口映射**这两条决定了：想"更稳/更快"，光调产品参数没用，得从网络侧动（见 B3）。

---

## 三、还能用、而且值得加（A 类：客户什么都不用做）

### A1. `tailscale netcheck` 网络体检 —— 优先级最高
- 能干什么：一条命令说清"UDP 通不通、是不是对称 NAT、最近中继是哪个、各区域延迟"。
- 怎么接：Node 里 `execFile('tailscale.exe', ['netcheck','--format=json'])`，**必须 `2>$null`**（实测 stderr 会混进 `portmap: monitor: gateway and self IP changed...` 这类日志，直接 `ConvertFrom-Json` 会炸）。
- 落到哪：自检页新增一节"网络体检"＋排障按钮；报障时让客户点一下，把 JSON 贴回来。
- 代价：几乎为零，只读、不联网改配置。
- 判断：**强烈建议**。它把"客户说卡"变成"客户说 sin 中继 70ms"。现有 `/tailscale-status` 只回答"能不能连"，回答不了"为什么慢"。

### A2. 中继区域可视化 —— 半天工作量
- 现状：`tailscaleSummary()` 只算 `direct = !!CurAddr`，页面只能说"直连/中继"。
- 可以加：`Peer.Relay`（区域码，如 `sin`）、`Peer.PeerRelay`（本机 1.104.2 的 `status --json` 里**已确认存在**这个字段）、`Peer.LastHandshake`。
- 效果：HUD 从「WebRTC264 直连」变成「经 新加坡(SIN) 中继 70ms」。
- 判断：值得做。客户能立刻理解"我在用星巴克 WiFi 所以慢"。

### A3. Funnel 公网暴露检测 —— 安全防呆，必须有
- 风险：客户（或教程）手一抖 `tailscale funnel 8660`，我们的整个安全模型当场归零——公网可达、只剩 URL 里的 `?k=`、`Tailscale-User-Login` 头也没有了、`100.64/10` 防火墙白设。
- 怎么接：启动/巡检时跑 `tailscale funnel status`，非空且指向 8660 → 页面红字告警并在 `/health` 里置失败，明确告诉客户"把这条关掉"。
- 判断：**建议做**。这是"别人不会替我们踩的坑"。

### A4. `tailscale serve status --json` 断言
- 现状：`Get-HttpsScreenUrl()` 只是"读到就用"。
- 改成：启动与自检时断言"443 → 本机画面端口"存在，丢了就自动补一条 `serve --bg --https=443`，补不上才报错。
- 判断：值得做，能消掉"昨天还好今天打不开"的一类投诉（`--bg` 状态被别的东西覆盖、被 `serve reset` 清掉）。

### A5. Tailscale 版本与自动升级
- 记录 `status --json` 的 `Self.Version` 进体检报告（现在只取了 `j.Version` 但没进报告）。
- 客户机上**建议固定版本**：Tailscale 升级会重启 tailscaled（连接瞬断），个别版本还会改 serve/身份头行为；升级前跑一轮回归比较稳。Windows 上是否静默自动升级取决于安装方式，需要在客户机上确认（未验证）。
- 判断：低成本，建议做（至少"记录＋提示"）。

### A6. `tailscale set --unattended=true`（Windows 独有）
- 现状：产品自启是 **`-AtLogOn`**（`app/install.ps1:1638`），Tailscale 也没开 unattended。
  → **客户重启后只要没登录 Windows，手机就完全打不开**（连页面都进不去）。
- 开了之后：tailscaled 在无用户登录时仍在线，手机能连到这台机器（页面仍是 502/连不上 8660，但至少能区分"电脑关机"和"电脑开着没人登录"）。
- 官方明确：**Unattended Mode 是 Windows 专有**（本机 `--help` 原文 `(Windows-only)`）。
- 进阶（可选，要设计）：8660 上常驻一个 SYSTEM 级"待机页"，开机就起，回答"电脑已开机，请在电脑上登录"；用户登录后由 `supervise.ps1` 停掉待机页、交出端口给真正的画面服务。这样"重启后手机一片黑"变成"重启后手机能看到一句人话"。
- 判断：**建议开 `--unattended`**；待机页属可选，值不值得做取决于重启类售后占比。

### A7. 体检加三条 Tailscale 侧检查项
1. 客户 tailnet 是否开了 **device approval**（新设备要管理员批准 → 扫码后用不了，纯支持成本）；
2. 电脑是否被打了 **tag**（tagged 设备**不注入** `Tailscale-User-Login`，我们的失败计数会退化成"按 IP/不锁"，已有回退逻辑，但要能告诉客户"这不影响使用"）；
3. 节点是否**多设备共用同一账号**（同一 tailnet 里别的设备也能打开这个页面，`?k=` 才是真正的门）。

---

## 四、值得评估（B 类：要客户点一次，或要改架构）

### B1. ACL grants 把暴露面从"8660+443"收成"只有 443"
- 现状：8660 同时绑 `127.0.0.1` 和 tailnet IP（`app/start-screen.ps1:95`），所以 tailnet 内**可以直连 `http://100.x:8660/?k=...`**。
  这条路径上，`Tailscale-User-Login` 头是"可以自己伪造"的（只有经 serve 才可信）。现有 `STRICT_AUTH_PATHS` 已经把它压住了，但暴露面还在。
- 做法：客户在 `console.tailscale.com/admin/acls` 粘一段 `grants`，只放 `tcp:443`。
- **代价（重要）**：会失去"`ts.net` 域名解析抽风时用数字 IP 兜底"的入口——这是现在文档里明确写的备用入口。所以这是个**取舍**，不是无脑加。要加的话，正确做法是另开一条备用（例如 `serve --http=8080` 走 MagicDNS 短名），而不是保留裸 8660。
- 判断：安全上是净收益，但要先补一条备用入口。**先想清楚再动**。

### B2. 身份头做审计/免密钥（不是替代 `?k=`）
- 能力：serve 会注入 `Tailscale-User-Login`（邮箱）、`Tailscale-User-Name`；官方口径：**Funnel 不注入、tagged 设备不注入、经 node sharing 进来的外部用户会注入**（最后这条是常驻档的关键依据，**建议实测确认**）。
- 可做：①连接记录里显示"来自 xxx@xxx 的 iPhone"；②常驻档里，卖家访问客户机器**不再需要客户的 `?k=` 密钥**，而是靠 tailnet 身份 + ACL，审计也更干净。
- 不要做：用它**替代** `?k=`。因为同一 tailnet 里的任何成员设备都会带这个头，等于把"单机密钥"降级成"账号内任何设备都能进"。
- 判断：审计值得做；免密钥只用于常驻档这种"身份本来就可信"的场景。

### B3. 国内链路加速：自定义 DERP / peer relay
- 事实：`tailscale set --relay-server-port`（本机 help 有）、`status --json` 的 `PeerRelay` 字段（1.104.2 有）→ **peer relay 是当前版本的真实能力**：让 tailnet 内某台机器当中转，替代境外 DERP。
- 但：peer relay **要求中转机在同一个 tailnet 里**。我们是"每个客户自己的 tailnet"，所以只有当客户自己有一台公网设备时才用得上（不符合大众客户）。
- 真正可行的是**自定义 DERP**：卖家自建一台 derper（香港/日本/新加坡 VPS + 域名 + TLS），客户在自己 tailnet 的 policy 文件里粘一段 `derpMap`（一次性）。
- 判断：**先别做**。实测 70–90ms 中继对"H.264 画面＋触控"是可接受的，用户自己也反馈 4G 流畅。等 `netcheck` 数据攒够、确实有一批客户卡在中继上，再作为"高级档/付费加速"推出。
  （注意：大陆 VPS 要跑 443+TLS 域名要备案，所以落地机大概率选香港/日本。）

### B4. `tsnet` 把节点嵌进 Go 侧车（免装客户端）
- 能力：`tailscale.com/tsnet` 让 `rtc-h264.exe` 自己成为一个 tailnet 节点，**不需要装官方客户端、不需要管理员、不需要 TUN 驱动**；`srv.ListenTLS(":443")` 可以直接替掉 `tailscale serve`；登录用 `StartLoginInteractive()` 拿到授权 URL，**客户仍是用自己的账号登录**（不破坏"我们不是客户网络成员"）。
- 代价：①依赖树极大（现在是 `pion/*` 十几个包，加 tsnet 会拉进 tailscale 全栈，`go.sum` 从 4KB 变成几百 KB，二进制从 16MB 涨到可能 30MB+）；②节点身份变了，域名会从 `<现有机器名>.ts.net` 变成 `<我们起的名字>.ts.net`（所有已发出去的入口要重发）；③tsnet 的 `FileStore` 注释写明日志会自动上传到 `log.tailscale.com`（要评估是否与"不泄露客户信息"的承诺冲突，以及能不能关）；④用户态网络栈的吞吐要实测。
- 判断：**不作为近期方案**，但它是"装机门槛再降一档"的唯一路径，值得列进 v2 候选。

### B5. 卖家自己 tailnet 的 API + Webhooks（只服务常驻档）
- 能力：`api.tailscale.com/api/v2` 拉设备清单；webhook 订阅 `nodeDeleted`（客户把共享撤了）、`nodeKeyExpiringInOneDay`（快到期）。
- 限制：**只有卖家自己 tailnet 的视角**（客户 tailnet 的 API 需要客户凭据，直接踩隐私承诺）；接收端要公网 HTTPS。
- 判断：常驻档客户超过 3–5 个再做，否则人工看更省事。

### B6. 一次性 auth key 代替客户手动登录
- 场景：客户死活搞不定浏览器登录 → 让他在自己后台生成一枚**一次性** auth key，装机脚本 `tailscale up --unattended --authkey=...` 当场消耗。
- 红线：**绝不接 reusable key**（等于把客户 tailnet 的入网权交给我们）。
- 判断：兜底手段，不进主流程。

---

## 五、明确不要用（C 类）

| 能力 | 为什么不要 |
|---|---|
| **Funnel** | 公网可达 + 无身份头 + 境外中继 + 只剩 `?k=` 单因子；与我们"只走私网、不暴露公网"的承诺正面冲突。客户要"不装 Tailscale 也能看"，应该另做中转方案。 |
| **Tailscale SSH** | 服务端只支持 Linux/macOS 开源 tailscaled，**Windows 没有服务端实现**。客户机是 Win10/11，这条通道不存在（`--ssh` 标志在 Windows 上能设也不等于有 sshd 语义）。 |
| **Taildrop** | 硬性限定"同一用户自己的设备之间"，卖家不是客户 tailnet 成员 → 给客户推安装包/收日志这条路直接堵死。产品自己已有断点续传的大文件传输。 |
| **Taildrive**（WebDAV） | 官方明确：**被 share 进来的设备访问不了 Taildrive**，常驻档用不上；且 Windows 默认单文件 50MB 限制、要改注册表。 |
| **subnet router / exit node** | 会把"客户整条局域网"或"客户全部出网流量"挂到这台电脑上，暴露面成倍放大，和产品定位无关。 |
| **Tailnet Lock / 设备审批** | 会把"装完扫码就能用"变成"等客户去后台点批准/签名"，而**我们没有代批权限**，纯增售后成本。 |
| **`serve --tcp` TCP 转发** | 只能转 TCP；WebRTC 是 UDP，转不了。画面入口用 HTTPS 反代才是正解。 |
| **Web 管理界面（5252）** | 只读页，改设置还要 owner 的 check 登录，还要客户在自己 policy 里放行端口。收益低，不如把 `status --json` 接进我们自己的诊断页。 |
| **`tailscale cert` 手动落盘证书** | `serve` 已在进程内自动签发+自动续期；落盘方式不自动续，只会给自己埋"证书过期"的雷。 |

---

## 六、如果只做三件事

1. **A1 `netcheck` 接入自检页**（一天内可完成，直接把"卡"变成可读数）
2. **A3 Funnel 暴露检测**（防止客户一个手抖毁掉安全模型）
3. **A6 `--unattended=true` + 体检里加 device approval / tag 两条提示**（消掉"重启后失联"和"扫码用不了"两类最常见售后）

再往后排：A2 中继区域显示 → A4 serve 断言 → B1 收窄暴露面（先补备用入口）→ B3/B4 看数据再定。

---

## 七、参考

- https://tailscale.com/docs/features/tailscale-serve （身份头、serve 语义）
- https://tailscale.com/docs/reference/tailscale-cli/serve （`--bg`/`--http`/`--tcp`/`--set-path`）
- https://tailscale.com/docs/features/tailscale-funnel （端口限制、beta、身份头缺失）
- https://tailscale.com/docs/features/access-control/acls （grants、端口级收窄）
- https://tailscale.com/docs/features/access-control/key-expiry
- https://tailscale.com/docs/how-to/run-unattended （Windows 独有）
- https://tailscale.com/docs/features/tailscale-ssh （Windows 无服务端）
- https://tailscale.com/docs/features/taildrop · https://tailscale.com/docs/features/taildrive
- https://tailscale.com/docs/reference/derp-servers/custom-derp-servers
- https://tailscale.com/docs/features/sharing （node sharing 与 quarantine）
- https://tailscale.com/docs/reference/tailscale-cli#netcheck · #status
- https://controlplane.tailscale.com/derpmap/default （DERP 区域原始表，本次实测据此对照）
