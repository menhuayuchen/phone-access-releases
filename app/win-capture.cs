// win-capture.exe <hwnd> [fps] [maxWidth]
// 真·单窗口采集：用 PrintWindow(PW_RENDERFULLCONTENT) 抓指定窗口的客户区，
// 哪怕窗口被其它窗口挡住也能拿到它自己的画面（GPU 合成的 Chrome/Edge 也支持）。
// stdout = 连续的 BGRA 原始帧；stderr 在首帧前输出一次 "SIZE <w> <h>"。
// 客户区尺寸变化 / 窗口消失时退出：2=尺寸变了，3=窗口没了，4=参数错误。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr v);

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }

    private const uint PW_RENDERFULLCONTENT = 2;

    private static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("usage: win-capture.exe <hwnd> [fps] [maxWidth]"); return 4; }
        long hv;
        if (!long.TryParse(args[0], out hv) || hv <= 0) { Console.Error.WriteLine("bad hwnd"); return 4; }
        int fps = 30;
        if (args.Length >= 2) int.TryParse(args[1], out fps);
        if (fps < 5 || fps > 60) fps = 30;
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }

        IntPtr h = new IntPtr(hv);
        if (!IsWindow(h)) { Console.Error.WriteLine("window not found"); return 3; }

        Stream outS = Console.OpenStandardOutput();
        Stream errS = Console.OpenStandardError();
        var sw = new Stopwatch();
        Bitmap full = null, client = null;
        int lastW = 0, lastH = 0;
        byte[] buf = null;
        try
        {
            while (true)
            {
                if (!IsWindow(h)) return 3;
                RECT cr, wr;
                if (!GetClientRect(h, out cr) || !GetWindowRect(h, out wr)) return 3;
                int cw = cr.Right - cr.Left, ch = cr.Bottom - cr.Top;
                int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
                if (cw < 16 || ch < 16 || ww < 16 || wh < 16) return 3;
                if (cw != lastW || ch != lastH)
                {
                    if (lastW > 0) return 2;                  // 尺寸变了：服务端重启管线
                    lastW = cw; lastH = ch;
                    full = new Bitmap(ww, wh, PixelFormat.Format32bppArgb);
                    client = new Bitmap(cw, ch, PixelFormat.Format32bppArgb);
                    buf = new byte[cw * ch * 4];
                    string line = "SIZE " + cw + " " + ch + "\n";
                    byte[] lb = System.Text.Encoding.ASCII.GetBytes(line);
                    errS.Write(lb, 0, lb.Length);
                    // 客户区在屏幕上的物理坐标（给页面做输入坐标换算用；窗口移动/改大小时随 SIZE 一起更新）
                    POINT cp = new POINT();
                    ClientToScreen(h, ref cp);
                    string rline = "RECT " + cp.X + " " + cp.Y + " " + cw + " " + ch + "\n";
                    byte[] rb = System.Text.Encoding.ASCII.GetBytes(rline);
                    errS.Write(rb, 0, rb.Length);
                    errS.Flush();
                }

                sw.Restart();
                using (Graphics g = Graphics.FromImage(full))
                {
                    IntPtr hdc = g.GetHdc();
                    try { PrintWindow(h, hdc, PW_RENDERFULLCONTENT); }
                    finally { g.ReleaseHdc(hdc); }
                }
                // 客户区在窗口里的偏移（窗口含边框/标题栏）
                POINT p = new POINT();
                ClientToScreen(h, ref p);
                int ox = p.X - wr.Left, oy = p.Y - wr.Top;
                if (ox < 0) ox = 0;
                if (oy < 0) oy = 0;
                if (ox + cw > ww) ox = Math.Max(0, ww - cw);
                if (oy + ch > wh) oy = Math.Max(0, wh - ch);

                using (Graphics g2 = Graphics.FromImage(client))
                {
                    g2.DrawImage(full, new Rectangle(0, 0, cw, ch), new Rectangle(ox, oy, cw, ch), GraphicsUnit.Pixel);
                }
                BitmapData bd = client.LockBits(new Rectangle(0, 0, cw, ch), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    int stride = bd.Stride;
                    if (stride == cw * 4)
                    {
                        Marshal.Copy(bd.Scan0, buf, 0, cw * ch * 4);
                        outS.Write(buf, 0, cw * ch * 4);
                    }
                    else
                    {
                        for (int y = 0; y < ch; y++)
                        {
                            IntPtr row = IntPtr.Add(bd.Scan0, y * stride);
                            Marshal.Copy(row, buf, y * cw * 4, cw * 4);
                        }
                        outS.Write(buf, 0, cw * ch * 4);
                    }
                    outS.Flush();
                }
                finally { client.UnlockBits(bd); }

                int spent = (int)sw.ElapsedMilliseconds;
                int target = 1000 / fps;
                if (spent < target) Thread.Sleep(target - spent);
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("capture error: " + e.Message);
            return 5;
        }
    }
}
