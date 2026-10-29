// 手机远程 · 自解压启动器（SFX）
//
// 设计：
//   exe 自身末尾追加三样东西：[zip 数据][trailer 32 字节]
//   trailer = magic(16) + zipOffset(int64) + zipLength(int64)
//   运行时不读整个 exe（130MB），只读取末尾 32 字节定位，再把 zip 段拷成临时文件解压。
//
// 用法：
//   PhoneAccess-Setup.exe                 解压到临时目录并运行 install.cmd（客户双击）
//   PhoneAccess-Setup.exe --extract-only D:\out   只解压，不运行（自测用）
//   PhoneAccess-Setup.exe --no-run        解压但打印目录，不运行
//
// 全部 ASCII：这份源码要给 csc.exe 编译，避免任何编码歧义。

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;

static class Sfx
{
    static readonly byte[] Magic = Encoding.ASCII.GetBytes("PAZIPPAYLOAD0001"); // 16 字节
    const int TrailerSize = 32;

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
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--extract-only" && i + 1 < args.Length) { extractOnly = args[i + 1]; i++; }
            else if (args[i] == "--no-run") { noRun = true; }
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
