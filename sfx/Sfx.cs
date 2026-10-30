// 手机远程 · 自解压启动器（SFX）
//
// 设计：
//   exe 自身末尾追加三样东西：[zip 数据][trailer 32 字节]
//   trailer = magic(16) + zipOffset(int64) + zipLength(int64)
//   运行时不读整个 exe（约 130MB），只读末尾 32 字节定位，再把 zip 段拷成临时文件解压。
//
// 用法：
//   PhoneAccess-Setup.exe                    安装前弹「免责声明 + 配置要求 + 同意勾选」，同意后才解压安装
//   PhoneAccess-Setup.exe --force-ui         即使已安装也弹一次（更新说明/验收用）
//   PhoneAccess-Setup.exe --silent           不弹窗直接装（自动化/自测用，绝不用于分发给客户）
//   PhoneAccess-Setup.exe --extract-only D:\out   只解压，不运行（build-sfx.ps1 自验证用）
//   PhoneAccess-Setup.exe --no-run           解压但打印目录，不运行
//
// 为什么要有这道弹窗（2026-10-30 用户要求）：
//   · 免责声明不能"一股脑全摆出来"——折叠起来，用户点开才看，但必须主动勾选同意才放行；
//   · 配置要求（系统版本/内存/管理员权限/网络）必须在装之前说清楚，避免装完不能用再来找售后；
//   · 已安装的机器按"升级"处理，跳过弹窗（不然每次更新都要再点一次，老客户会烦）。
//
// 编译：csc /target:exe /codepage:65001 /optimize /r:System.Windows.Forms.dll /r:System.Drawing.dll ...
// 全部源码给 csc.exe 编译，必须 UTF-8 with BOM（/codepage:65001），否则中文变乱码。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

static class Sfx
{
    static readonly byte[] Magic = Encoding.ASCII.GetBytes("PAZIPPAYLOAD0001"); // 16 字节
    const int TrailerSize = 32;

    // 隐藏双击时闪出来的黑色控制台窗口（--extract-only 自验证时要保留输出，所以按需隐藏）
    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    const int SwHide = 0;
    const int SwShow = 5;

    // ---- 免责声明正文（折叠后展示；完整版随安装包分发为「免责声明.md」）----------------
    static readonly string[] DisclaimerLines = new string[]
    {
        "1. 用途：本软件用于把你自己的电脑画面与操作同步到你自己的手机/平板上。",
        "2. 禁止：未经设备所有人明确同意，用它查看或操作他人电脑，属于违法行为，后果自负。",
        "3. 数据：画面、声音、键鼠事件只在你主动发起连接时，点对点传输到你的设备；",
        "   软件不设后门、不上传你的截图或文件、不做远程遥控回连。",
        "4. 组件：安装包内含 Node.js、Tailscale 等第三方组件，它们按各自的开源/商业许可分发。",
        "5. 网络：需要你自己的局域网或 tailnet 连接；公网访问能力取决于你的网络环境。",
        "6. 风险：远程操作可能造成误点、误删。请自行做好备份，本软件不承担数据丢失责任。",
        "7. 授权：破解、反编译、转售、去除授权提示均属违约；许可证仅限一台电脑使用。",
        "8. 隐私：本软件不含遥测；只有你主动点「检查更新」时才会联网查询版本。",
        "9. 卸载：从「设置-应用」或安装目录的「卸载」即可移除，卸载不保留后台进程。"
    };

    static readonly string RequirementsText =
        "• Windows 10 / 11（64 位）\r\n" +
        "• 内存 4 GB 以上（推荐 8 GB）\r\n" +
        "• 首次安装需要管理员权限（会弹一次 UAC 授权框）\r\n" +
        "• 安装位置：%LOCALAPPDATA%\\PhoneAccess（不写系统目录）\r\n" +
        "• 手机与电脑在同一局域网，或都加入同一个 tailnet\r\n" +
        "• 抓屏/编码会占用一部分 CPU，2560 宽档位建议 4 核以上";

    static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("[x] 启动器出错: " + ex.Message);
            Pause();
            return 1;
        }
    }

    static int Run(string[] args)
    {
        string extractOnly = null;
        bool noRun = false;
        bool silent = false;
        bool forceUi = false;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--extract-only" && i + 1 < args.Length) { extractOnly = args[i + 1]; i++; }
            else if (args[i] == "--no-run") { noRun = true; }
            else if (args[i] == "--silent") { silent = true; }
            else if (args[i] == "--force-ui") { forceUi = true; }
        }

        bool uiNeeded = (extractOnly == null) && !noRun && !silent;

        // 已安装 = 升级场景，跳过声明弹窗（老客户更新时不该再被拦一次）
        bool installed = uiNeeded && !forceUi && IsInstalled();

        if (uiNeeded && !installed)
        {
            IntPtr con = GetConsoleWindow();
            if (con != IntPtr.Zero) { try { ShowWindow(con, SwHide); } catch { } }
            try
            {
                if (!ShowConsentDialog())
                {
                    Console.WriteLine("[i] 未同意条款，安装已取消。");
                    return 2;
                }
            }
            finally
            {
                if (con != IntPtr.Zero) { try { ShowWindow(con, SwShow); } catch { } }
            }
        }

        string self = Process.GetCurrentProcess().MainModule.FileName;
        long zipOffset, zipLength;
        using (FileStream fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (fs.Length < TrailerSize) { Console.Error.WriteLine("[x] 文件不完整"); return 1; }
            fs.Seek(-TrailerSize, SeekOrigin.End);
            byte[] tr = new byte[TrailerSize];
            ReadExact(fs, tr, TrailerSize);
            for (int i = 0; i < 16; i++)
            {
                if (tr[i] != Magic[i]) { Console.Error.WriteLine("[x] 不是有效的安装包（尾部标记不匹配）"); return 1; }
            }
            zipOffset = BitConverter.ToInt64(tr, 16);
            zipLength = BitConverter.ToInt64(tr, 24);
            if (zipOffset <= 0 || zipLength <= 0 || zipOffset + zipLength > fs.Length)
            {
                Console.Error.WriteLine("[x] 包内数据偏移异常，文件可能被截断");
                return 1;
            }
        }

        string dest = extractOnly;
        if (string.IsNullOrEmpty(dest))
        {
            dest = Path.Combine(Path.GetTempPath(), "PhoneAccessSetup_" + DateTime.Now.ToString("yyyyMMdd_HHmmss"));
        }
        Directory.CreateDirectory(dest);

        string tempZip = Path.Combine(Path.GetTempPath(), "PhoneAccessSetup_" + Guid.NewGuid().ToString("N") + ".zip");
        Console.WriteLine("[i] 正在解压安装文件…");
        using (FileStream src = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (FileStream dst = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
        {
            src.Seek(zipOffset, SeekOrigin.Begin);
            byte[] buf = new byte[1024 * 256];
            long left = zipLength;
            while (left > 0)
            {
                int want = (int)Math.Min(buf.Length, left);
                int got = src.Read(buf, 0, want);
                if (got <= 0) break;
                dst.Write(buf, 0, got);
                left -= got;
            }
        }

        ZipFile.ExtractToDirectory(tempZip, dest);
        try { File.Delete(tempZip); } catch { }

        // 包结构是 PhoneAccess-xxx\ 一层目录，把它提上来
        string root = dest;
        string[] sub = Directory.GetDirectories(dest);
        if (sub.Length == 1 && File.Exists(Path.Combine(sub[0], "install.cmd")))
        {
            root = sub[0];
        }

        Console.WriteLine("[i] 解压完成: " + root);

        if (extractOnly != null || noRun)
        {
            Console.WriteLine("[i] 已按参数停在解压阶段（未运行安装）。");
            return 0;
        }

        string installer = Path.Combine(root, "install.cmd");
        if (!File.Exists(installer))
        {
            Console.Error.WriteLine("[x] 解压后的目录里找不到 install.cmd，安装包可能损坏。");
            Console.Error.WriteLine("    目录: " + root);
            Pause();
            return 1;
        }

        Console.WriteLine("[i] 正在启动安装程序（会弹一次管理员授权，请点「是」）…");
        Console.WriteLine();
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = installer;
        psi.WorkingDirectory = root;
        psi.UseShellExecute = true;
        Process p = Process.Start(psi);
        if (p != null) { try { p.WaitForExit(); } catch { } }

        Console.WriteLine();
        Console.WriteLine("[i] 安装窗口已结束。如果刚才没看到安装界面，请再双击一次本文件。");
        Pause();
        return 0;
    }

    // 已安装判定：安装目录里有 product.config.json 或 install.cmd。
    // 安装位置与 product.config.json 的 installDir 保持一致（%LOCALAPPDATA%\PhoneAccess）。
    static bool IsInstalled()
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PhoneAccess");
            return File.Exists(Path.Combine(dir, "product.config.json"))
                || File.Exists(Path.Combine(dir, "install.cmd"));
        }
        catch { return false; }
    }

    // ---- 安装前声明弹窗 ---------------------------------------------------------------
    // 结构：标题 -> 一句话说明 -> 配置要求 -> [折叠] 免责声明（点开才显示）-> 同意勾选 -> 按钮
    // 关键行为：没勾选「同意」时，安装按钮是禁用的；点关闭/取消 = 不安装。
    static bool ShowConsentDialog()
    {
        bool agreed = false;

        using (Form f = new Form())
        {
            f.Text = "手机远程 · 安装";
            f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.StartPosition = FormStartPosition.CenterScreen;
            f.MaximizeBox = false;
            f.MinimizeBox = false;
            f.AutoScaleMode = AutoScaleMode.Font;
            f.ClientSize = new Size(660, 560);
            f.Font = new Font("Microsoft YaHei UI", 9f);
            f.TopMost = true;

            Label title = new Label();
            title.Text = "安装前请先阅读并同意";
            title.Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(24, 20);
            f.Controls.Add(title);

            Label intro = new Label();
            intro.Text = "本程序会把这台电脑的画面与操作同步到你的手机/平板。请先确认下面的配置要求，并阅读免责声明。";
            intro.Location = new Point(26, 62);
            intro.Size = new Size(608, 40);
            f.Controls.Add(intro);

            GroupBox req = new GroupBox();
            req.Text = "配置要求";
            req.Location = new Point(26, 108);
            req.Size = new Size(608, 132);
            f.Controls.Add(req);

            Label reqText = new Label();
            reqText.Text = RequirementsText;
            reqText.Location = new Point(12, 22);
            reqText.Size = new Size(584, 104);
            req.Controls.Add(reqText);

            Button toggle = new Button();
            toggle.Text = "▼ 展开免责声明（建议阅读，共 " + DisclaimerLines.Length + " 条）";
            toggle.TextAlign = ContentAlignment.MiddleLeft;
            toggle.Location = new Point(26, 252);
            toggle.Size = new Size(608, 32);
            toggle.FlatStyle = FlatStyle.System;
            f.Controls.Add(toggle);

            TextBox disclaimer = new TextBox();
            disclaimer.Multiline = true;
            disclaimer.ReadOnly = true;
            disclaimer.ScrollBars = ScrollBars.Vertical;
            disclaimer.WordWrap = true;
            disclaimer.BackColor = Color.White;
            disclaimer.Location = new Point(26, 288);
            disclaimer.Size = new Size(608, 0);   // 折叠状态：高度 0
            disclaimer.Visible = false;
            disclaimer.Text = string.Join("\r\n", DisclaimerLines);
            f.Controls.Add(disclaimer);

            CheckBox agree = new CheckBox();
            agree.Text = "我已阅读并同意上述免责声明与许可条款";
            agree.AutoSize = true;
            agree.Location = new Point(26, 300);
            agree.Enabled = false;                // 必须先展开一次，才允许勾选（防止"闭眼同意"）
            f.Controls.Add(agree);

            Label hint = new Label();
            hint.Text = "提示：安装程序只写入 %LOCALAPPDATA%\\PhoneAccess，不改系统目录；可随时从「设置-应用」卸载。";
            hint.ForeColor = Color.DimGray;
            hint.Location = new Point(26, 332);
            hint.Size = new Size(608, 22);
            f.Controls.Add(hint);

            Button install = new Button();
            install.Text = "同意并继续安装";
            install.Enabled = false;
            install.Location = new Point(400, 500);
            install.Size = new Size(140, 34);
            f.Controls.Add(install);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Location = new Point(552, 500);
            cancel.Size = new Size(82, 34);
            f.Controls.Add(cancel);

            int collapsedCheckTop = 300;

            toggle.Click += delegate
            {
                bool opening = !disclaimer.Visible;
                if (opening)
                {
                    disclaimer.Visible = true;
                    disclaimer.Height = 176;
                    toggle.Text = "▲ 收起免责声明";
                    agree.Location = new Point(26, 474);
                    agree.Enabled = true;
                }
                else
                {
                    disclaimer.Visible = false;
                    disclaimer.Height = 0;
                    toggle.Text = "▼ 展开免责声明（建议阅读，共 " + DisclaimerLines.Length + " 条）";
                    // 收起后仍然保留勾选状态，但位置回到上方
                    agree.Location = new Point(26, collapsedCheckTop);
                }
            };

            agree.CheckedChanged += delegate
            {
                install.Enabled = agree.Checked;
            };

            install.Click += delegate
            {
                if (!agree.Checked) return;
                agreed = true;
                f.Close();
            };

            cancel.Click += delegate
            {
                agreed = false;
                f.Close();
            };

            f.AcceptButton = install;
            f.CancelButton = cancel;

            // 默认焦点放在"展开免责声明"，让人先看到免责声明再往下走
            f.ActiveControl = toggle;

            f.ShowDialog();
        }

        return agreed;
    }

    static void ReadExact(Stream s, byte[] buf, int count)
    {
        int off = 0;
        while (off < count)
        {
            int got = s.Read(buf, off, count - off);
            if (got <= 0) throw new EndOfStreamException();
            off += got;
        }
    }

    static void Pause()
    {
        try
        {
            if (Environment.UserInteractive)
            {
                Console.WriteLine("按回车键关闭…");
                Console.ReadLine();
            }
        }
        catch { }
    }
}
