// capture.cs — screen capture loop for the phone/tablet viewer.
// Compiled to capture.exe so Windows Defender's script (AMSI) scanner is not involved.
//
// usage: capture.exe <outFile> <width> <intervalMs> <logFile> [quality] [viewersFile]
//
//  * If viewersFile is given and contains 0, the loop idles (sleeps) instead of
//    capturing: nobody is watching the stream, so don't burn CPU/battery.
//
// Notes:
//  * The process declares per-monitor-DPI-awareness v2, otherwise on a 150% display it
//    only sees 1707x1067 logical pixels and the captured image is a cropped fragment.
//  * Capture and encode run as a 2-stage pipeline over two reusable buffers: CopyFromScreen
//    (~65 ms for 2560x1600) overlaps with scale+JPEG (~60 ms), so the frame period is the
//    slower stage instead of the sum — roughly doubles the frame rate at ~2x CPU, which is
//    still only a few percent of a modern multi-core box.
using System;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class Capture
{
    static FramePipe pipe;

// ---- frame delivery over a named pipe ------------------------------------
// Writing a 300 KB JPEG to disk 30x/s made the viewer and the encoder fight over the
// same file handle (real write rate fell to ~21 fps). A pipe keeps everything in RAM:
// no disk churn, no sharing violations, and lower latency.
class FramePipe
{
    readonly string name;
    byte[] slot;
    readonly object sync = new object();
    readonly System.Threading.AutoResetEvent hasData = new System.Threading.AutoResetEvent(false);
    volatile bool hasClient;

    public bool HasClient { get { return hasClient; } }

    public FramePipe(string name)
    {
        this.name = name;
        System.Threading.Thread t = new System.Threading.Thread(Loop);
        t.IsBackground = true;
        t.Start();
    }

    // frame = [type byte][payload]; type 0 = JPEG, type 1 = I420 (u16 w, u16 h, planes)
    public void Publish(byte type, byte[] payload)
    {
        byte[] frame = new byte[payload.Length + 1];
        frame[0] = type;
        Buffer.BlockCopy(payload, 0, frame, 1, payload.Length);
        lock (sync) { slot = frame; }
        hasData.Set();
    }

    void Loop()
    {
        while (true)
        {
            NamedPipeServerStream s = null;
            try
            {
                s = new NamedPipeServerStream(name, PipeDirection.Out, 1,
                                              PipeTransmissionMode.Byte, PipeOptions.None);
                s.WaitForConnection();
                hasClient = true;
                while (s.IsConnected)
                {
                    hasData.WaitOne(500);
                    byte[] f;
                    lock (sync) { f = slot; }
                    if (f == null) continue;
                    // one buffer + a write timeout: a half-open client would otherwise make
                    // s.Write() block forever and lock the pipe against every future viewer
                    byte[] buf = new byte[4 + f.Length];
                    Buffer.BlockCopy(BitConverter.GetBytes(f.Length), 0, buf, 0, 4);
                    Buffer.BlockCopy(f, 0, buf, 4, f.Length);
                    System.Threading.Tasks.Task w = s.WriteAsync(buf, 0, buf.Length);
                    if (!w.Wait(5000)) throw new TimeoutException("pipe write timeout");
                }
            }
            catch (Exception ex)
            {
                try { File.AppendAllText("pipe-diag.log", DateTime.Now.ToString("HH:mm:ss.fff") + " " + ex.GetType().Name + ": " + ex.Message + Environment.NewLine); } catch { }
            }
            finally
            {
                hasClient = false;
                try { if (s != null) s.Dispose(); } catch { }
                System.Threading.Thread.Sleep(200);
            }
        }
    }
}

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    static extern bool BitBlt(IntPtr hDest, int x, int y, int width, int height,
                             IntPtr hSrc, int xSrc, int ySrc, int rop);

    [DllImport("winmm.dll")]
    static extern uint timeBeginPeriod(uint ms);

    const int SRCCOPY = 0x00CC0020;

    static string logFile;
    static ImageCodecInfo jpeg;
    static EncoderParameters enc;
    static string outFile, tmpFile;
    static string viewersFile;
static string intervalFile;          // server-written fps cap, so the link can adapt itself
    static int targetWidth;
    static long quality;
    static int intervalMs;

    static void EnableDpiAwareness()
    {
        try
        {
            // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    static void Log(string text)
    {
        try { File.AppendAllText(logFile, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text + Environment.NewLine); }
        catch { }
    }

    static ImageCodecInfo FindJpeg()
    {
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") return c;
        return null;
    }

    static DateTime gateRead = DateTime.MinValue;
    static int gateValue = 1;

    // reading a file every frame costs several ms under real-time AV scanning; 200 ms is plenty
    // insert "TSD<unix ms>" as a JPEG COM segment right after SOI so a client can measure
    // end-to-end latency exactly; viewers ignore COM segments
    static byte[] StampJpeg(byte[] jpeg)
    {
        string text = "TSD" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        byte[] payload = System.Text.Encoding.ASCII.GetBytes(text);
        byte[] outp = new byte[jpeg.Length + 4 + payload.Length];
        outp[0] = 0xFF; outp[1] = 0xD8;                       // SOI
        outp[2] = 0xFF; outp[3] = 0xFE;                       // COM
        int segLen = payload.Length + 2;
        outp[4] = (byte)(segLen >> 8); outp[5] = (byte)(segLen & 0xFF);
        Buffer.BlockCopy(payload, 0, outp, 6, payload.Length);
        Buffer.BlockCopy(jpeg, 2, outp, 6 + payload.Length, jpeg.Length - 2);
        return outp;
    }

    static DateTime capRead = DateTime.MinValue;
    static int capValue = -1;

    // server writes the current minimum frame period here when the link needs throttling
    static int ReadIntervalCap()
    {
        if (intervalFile == null) return intervalMs;
        if ((DateTime.UtcNow - capRead).TotalMilliseconds < 300) return capValue < 0 ? intervalMs : capValue;
        capRead = DateTime.UtcNow;
        try
        {
            int n;
            if (int.TryParse(File.ReadAllText(intervalFile).Trim(), out n) && n >= 0) capValue = n;
        }
        catch { capValue = intervalMs; }
        return capValue < 0 ? intervalMs : capValue;
    }

    static int ReadViewers()
    {
        if (viewersFile == null) return 1;      // standalone: always capture
        if ((DateTime.UtcNow - gateRead).TotalMilliseconds < 200) return gateValue;
        gateRead = DateTime.UtcNow;
        try
        {
            int n;
            if (int.TryParse(File.ReadAllText(viewersFile).Trim(), out n)) gateValue = n;
        }
        catch { gateValue = 1; }                 // missing/unreadable gate file: assume watching
        return gateValue;
    }

    // ---- capture source selection (whole desktop / one monitor / one window) ----
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    // ---- 被遮挡的窗口：用 PrintWindow 直接渲染窗口内容，而不是从屏幕上 BitBlt 一块 ----
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    const uint PW_RENDERFULLCONTENT = 2;

    [DllImport("user32.dll")]
    static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    const uint GA_ROOT = 2;

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    // 采样窗口内的几个点，看最上面盖着的到底是不是它自己（含子窗口/同一顶层窗口）
    static bool WindowOccluded(IntPtr hwnd, Rectangle r)
    {
        if (r.Width <= 0 || r.Height <= 0) return false;
        if (GetForegroundWindow() == hwnd) return false;
        POINT[] pts = new POINT[]
        {
            new POINT { X = r.Left + r.Width / 2, Y = r.Top + r.Height / 2 },
            new POINT { X = r.Left + r.Width / 4, Y = r.Top + r.Height / 4 },
            new POINT { X = r.Left + r.Width * 3 / 4, Y = r.Top + r.Height / 4 },
            new POINT { X = r.Left + r.Width / 4, Y = r.Top + r.Height * 3 / 4 },
            new POINT { X = r.Left + r.Width * 3 / 4, Y = r.Top + r.Height * 3 / 4 },
        };
        int covered = 0, checkedPts = 0;
        foreach (POINT pt in pts)
        {
            IntPtr top = WindowFromPoint(pt);
            if (top == IntPtr.Zero) continue;
            checkedPts++;
            if (top != hwnd && GetAncestor(top, GA_ROOT) != hwnd) covered++;
        }
        if (checkedPts == 0) return false;
        // 窗口面积被挡住一半以上就当作遮挡（部分遮挡时整窗用 PrintWindow 内容更完整）
        return covered * 2 >= checkedPts;
    }

    static DateTime occlCheck = DateTime.MinValue;
    static bool occlNow = false;
    static int occlForWindow = 0;
    static DateTime occlLog = DateTime.MinValue;
    static DateTime occlDbg = DateTime.MinValue;

    // PrintWindow 渲染整窗内容（不受其他窗口遮挡影响）。
    // 注意：dc 必须是已经取到的位图 HDC，不能再对同一个 Graphics 调 GetHdc（会抛"对象正在其他地方使用"）。
    static bool PrintWindowInto(IntPtr hwnd, IntPtr dc)
    {
        try { return PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT); }
        catch { return false; }
    }

    // PrintWindow 对硬件加速/分层窗口经常"返回成功但全黑"，所以要检查结果是不是几乎全黑。
    static bool NearlyBlack(Bitmap b)
    {
        int w = b.Width, h = b.Height;
        int stepX = Math.Max(8, w / 32), stepY = Math.Max(8, h / 32);
        int total = 0, dark = 0;
        for (int y = stepY / 2; y < h; y += stepY)
            for (int x = stepX / 2; x < w; x += stepX)
            {
                Color c = b.GetPixel(x, y);
                total++;
                if (c.R < 8 && c.G < 8 && c.B < 8) dark++;
            }
        return total > 0 && (long)dark * 1000 >= (long)total * 995;
    }

    // 被遮住又抓不到内容时，写一个"请把窗口提到前面"的请求，由 screen-server 转给注入器执行。
    static string raiseFile;
    static DateTime lastRaiseReq = DateTime.MinValue;

    static void RequestRaise(int hwnd)
    {
        if (raiseFile == null) return;
        if ((DateTime.Now - lastRaiseReq).TotalSeconds < 10) return;
        lastRaiseReq = DateTime.Now;
        try
        {
            System.IO.File.WriteAllText(raiseFile, hwnd.ToString("X"));
            Log("window 0x" + hwnd.ToString("X") + " occluded & not printable -> ask server to raise it");
        }
        catch { }
    }

    static void ClearRaise()
    {
        if (raiseFile == null) return;
        try { if (System.IO.File.Exists(raiseFile)) System.IO.File.Delete(raiseFile); } catch { }
    }

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    static string modeFile;
    static string ctlMode = "mjpeg";
    static int ctlMonitor = -1;
    static int ctlWindow = 0;
    static int ctlWidth = 0;
    static DateTime ctlRead = DateTime.MinValue;
    static readonly System.Collections.Generic.List<Rectangle> monitors =
        new System.Collections.Generic.List<Rectangle>();

    static void RefreshMonitors()
    {
        monitors.Clear();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, MonitorProc, IntPtr.Zero);
    }

    static bool MonitorProc(IntPtr h, IntPtr hdc, ref RECT r, IntPtr data)
    {
        monitors.Add(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom));
        return true;
    }

    // returns true when the requested source/mode changed (the caller restarts the loop)
    static bool ReadControl()
    {
        if (modeFile == null) return false;
        if ((DateTime.UtcNow - ctlRead).TotalMilliseconds < 300) return false;
        ctlRead = DateTime.UtcNow;
        string text;
        try { text = File.ReadAllText(modeFile); }
        catch { return false; }

        string oldMode = ctlMode;
        int oldMon = ctlMonitor, oldWin = ctlWindow, oldW = ctlWidth;
        foreach (string raw in text.Split('\n'))
        {
            string line = raw.Trim();
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string k = line.Substring(0, eq).Trim().ToLowerInvariant();
            string v = line.Substring(eq + 1).Trim();
            int n;
            if (!int.TryParse(v, out n)) n = 0;
            if (k == "mode") ctlMode = v.ToLowerInvariant();
            else if (k == "monitor") ctlMonitor = n;
            else if (k == "window") ctlWindow = n;
            else if (k == "width") ctlWidth = n;
        }
        return oldMode != ctlMode || oldMon != ctlMonitor || oldWin != ctlWindow || oldW != ctlWidth;
    }

    static Rectangle GetSourceRect()
    {
        if (ctlWindow != 0)
        {
            RECT r;
            if (GetWindowRect(new IntPtr(ctlWindow), out r) && r.Right > r.Left && r.Bottom > r.Top)
                return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        }
        if (ctlMonitor >= 0)
        {
            if (monitors.Count == 0) RefreshMonitors();
            if (ctlMonitor < monitors.Count) return monitors[ctlMonitor];
        }
        return SystemInformation.VirtualScreen;
    }

    // BGRA bitmap -> I420 (Y at full res, U/V 2x2 subsampled)
    static byte[] ToI420(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        int ySize = w * h;
        int cw = (w + 1) / 2, ch = (h + 1) / 2;
        int uvSize = cw * ch;
        byte[] outp = new byte[ySize + uvSize * 2];

        BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        try
        {
            unsafe
            {
                byte* basePtr = (byte*)data.Scan0.ToPointer();
                fixed (byte* p = outp)
                {
                    byte* yPlane = p;
                    byte* uPlane = p + ySize;
                    byte* vPlane = uPlane + uvSize;

                    for (int y = 0; y < h; y++)
                    {
                        byte* row = basePtr + y * data.Stride;
                        int yRow = y * w;
                        for (int x = 0; x < w; x++)
                        {
                            byte b = row[x * 4 + 0], g = row[x * 4 + 1], r = row[x * 4 + 2];
                            yPlane[yRow + x] = (byte)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
                        }
                    }

                    for (int y = 0; y < h; y += 2)
                    {
                        for (int x = 0; x < w; x += 2)
                        {
                            int rs = 0, gs = 0, bs = 0, n = 0;
                            for (int dy = 0; dy < 2 && y + dy < h; dy++)
                            {
                                byte* row = basePtr + (y + dy) * data.Stride;
                                for (int dx = 0; dx < 2 && x + dx < w; dx++)
                                {
                                    byte* px = row + (x + dx) * 4;
                                    bs += px[0]; gs += px[1]; rs += px[2]; n++;
                                }
                            }
                            int r = rs / n, g = gs / n, b = bs / n;
                            int idx = (y / 2) * cw + (x / 2);
                            uPlane[idx] = (byte)(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
                            vPlane[idx] = (byte)(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
                        }
                    }
                }
            }
        }
        finally { bmp.UnlockBits(data); }
        return outp;
    }

    // ---- one pipeline run at a fixed screen size -----------------------------
    static void RunPipeline(Rectangle screen, int outW, int outH)
    {
        Bitmap[] src = new Bitmap[2];
        Graphics[] gsrc = new Graphics[2];
        for (int i = 0; i < 2; i++)
        {
            src[i] = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppPArgb);
            gsrc[i] = Graphics.FromImage(src[i]);
        }

        Bitmap dst = new Bitmap(outW, outH, PixelFormat.Format32bppPArgb);
        Graphics gdst = Graphics.FromImage(dst);
        // 改动（2026-10-30）：HighQualityBilinear -> Bilinear。2560x1600 实机实测：
        // HQB 做降档缩放单步约 34ms（1920 档 encode 合计 49ms，帧率被锁死 15.5fps），
        // 且 GDI+ 缩放期间压着 GDI 通道，还把 copy 阶段从 28ms 拖到 54ms（GDI 锁等待）。
        // Bilinear 只要几 ms，出图过 q62 JPEG 压缩后观感差别可忽略；
        // 2560 满档不缩放、不受此影响（改前改后都是 24.7fps）。
        gdst.InterpolationMode = InterpolationMode.Bilinear;
        gdst.PixelOffsetMode = PixelOffsetMode.HighSpeed;
        gdst.CompositingQuality = CompositingQuality.HighSpeed;

        ConcurrentQueue<int> freeIdx = new ConcurrentQueue<int>();
        ConcurrentQueue<int> filledIdx = new ConcurrentQueue<int>();
        freeIdx.Enqueue(0);
        freeIdx.Enqueue(1);
        SemaphoreSlim freeSem = new SemaphoreSlim(2, 2);
        SemaphoreSlim filledSem = new SemaphoreSlim(0, 2);
        ManualResetEventSlim stop = new ManualResetEventSlim(false);

        int frames = 0;
        DateTime fpsStamp = DateTime.Now;
        int fails = 0;
        long copyMsSum = 0, encMsSum = 0, periodSum = 0, gapSum = 0, waitSum = 0;
        int copyN = 0, encN = 0;

        Thread encoder = new Thread(() =>
        {
            while (true)
            {
                filledSem.Wait();
                if (stop.IsSet) break;

                int idx;
                if (!filledIdx.TryDequeue(out idx)) { continue; }

                try
                {
                    DateTime encT0 = DateTime.Now;
                    gdst.DrawImage(src[idx], 0, 0, dst.Width, dst.Height);

                    if (ctlMode == "raw")
                    {
                        // WebRTC path: hand raw I420 to the pipe, libwebrtc does the encoding
                        byte[] i420 = ToI420(dst);
                        byte[] payload = new byte[4 + i420.Length];
                        payload[0] = (byte)(dst.Width & 0xFF);
                        payload[1] = (byte)(dst.Width >> 8);
                        payload[2] = (byte)(dst.Height & 0xFF);
                        payload[3] = (byte)(dst.Height >> 8);
                        Buffer.BlockCopy(i420, 0, payload, 4, i420.Length);
                        if (pipe != null && pipe.HasClient) pipe.Publish(1, payload);
                    }
                    else
                    {
                        using (MemoryStream ms = new MemoryStream(256 * 1024))
                        {
                            dst.Save(ms, jpeg, enc);
                            byte[] raw = ms.ToArray();
                            byte[] jpegBytes = StampJpeg(raw);
                            if (pipe != null && pipe.HasClient)
                            {
                                pipe.Publish(0, jpegBytes);   // RAM only, no disk
                            }
                            else
                            {
                                for (int i = 0; i < 4; i++)
                                {
                                    try { File.WriteAllBytes(outFile, jpegBytes); break; }
                                    catch { Thread.Sleep(15); }
                                }
                            }
                        }
                    }
                    frames++;
                    fails = 0;
                    encMsSum += (long)(DateTime.Now - encT0).TotalMilliseconds; encN++;

                    if ((DateTime.Now - fpsStamp).TotalSeconds >= 30)
                    {
                        double secs = (DateTime.Now - fpsStamp).TotalSeconds;
                        Log("fps=" + (frames / secs).ToString("0.0")
                            + " copy=" + (copyN > 0 ? (copyMsSum / copyN).ToString("0.0") : "-") + "ms"
                            + " encode=" + (encN > 0 ? (encMsSum / encN).ToString("0.0") : "-") + "ms"
                            + " period=" + (copyN > 0 ? (periodSum / copyN).ToString("0.0") : "-") + "ms"
                            + " gap=" + (copyN > 0 ? (gapSum / copyN).ToString("0.0") : "-") + "ms"
                            + " semwait=" + (copyN > 0 ? (waitSum / copyN).ToString("0.0") : "-") + "ms");
                        frames = 0; fpsStamp = DateTime.Now;
                        copyMsSum = 0; encMsSum = 0; periodSum = 0; gapSum = 0; waitSum = 0; copyN = 0; encN = 0;
                    }
                }
                catch (Exception ex)
                {
                    fails++;
                    if (fails <= 3) Log("encode error: " + ex.Message);
                    Thread.Sleep(200);
                }

                freeIdx.Enqueue(idx);
                freeSem.Release();
            }
        });
        encoder.IsBackground = true;
        encoder.Start();

        Log("pipeline " + screen.Width + "x" + screen.Height + " -> " + outW + "x" + outH
            + " interval=" + intervalMs + "ms quality=" + quality);

        DateTime lastCopy = DateTime.Now;
        DateTime lastCopyEnd = DateTime.Now;
        IntPtr screenDc = GetDC(IntPtr.Zero);

        while (!stop.IsSet)
        {
            if (ReadControl()) break;                 // monitor/window/mode changed -> restart
            Rectangle now = GetSourceRect();
            if (now.Width != screen.Width || now.Height != screen.Height) break;   // source resized

            if (ReadViewers() == 0)
            {
                Thread.Sleep(300);
                continue;
            }

            DateTime waitT0 = DateTime.Now;
            freeSem.Wait();
            waitSum += (long)(DateTime.Now - waitT0).TotalMilliseconds;
            gapSum += (long)(DateTime.Now - lastCopyEnd).TotalMilliseconds;
            int idx;
            if (!freeIdx.TryDequeue(out idx)) { freeSem.Release(); continue; }

            try
            {
                DateTime copyT0 = DateTime.Now;
                IntPtr bmpDc = gsrc[idx].GetHdc();
                bool blitted = false;
                bool printed = false;
                try
                {
                    // 指定窗口 + 它被别的窗口盖住时，从屏幕 BitBlt 只会截到盖住它的那个窗口，
                    // 所以改用 PrintWindow 渲染窗口自身内容（无论前后台都能截全）。
                    if (ctlWindow != 0 && (DateTime.Now - occlCheck).TotalMilliseconds > 400)
                    {
                        occlCheck = DateTime.Now;
                        occlForWindow = ctlWindow;
                        occlNow = WindowOccluded(new IntPtr(ctlWindow), now);
                        if ((DateTime.Now - occlDbg).TotalSeconds > 5)
                        {
                            occlDbg = DateTime.Now;
                            Log("occl probe 0x" + ctlWindow.ToString("X") + " fg=0x"
                                + GetForegroundWindow().ToString("X") + " occluded=" + occlNow
                                + " rect=" + now.Left + "," + now.Top + " " + now.Width + "x" + now.Height);
                        }
                    }
                    if (ctlWindow != 0 && ctlWindow == occlForWindow && occlNow)
                    {
                        printed = PrintWindowInto(new IntPtr(ctlWindow), bmpDc);
                        if (printed && NearlyBlack(src[idx]))
                        {
                            // 返回成功但是黑屏（硬件加速/分层窗口常见）→ 当作失败
                            printed = false;
                        }
                        // 抓不到窗口自身内容（返回失败或全黑）→ 回退 BitBlt，并请求把窗口提到前面
                        if (!printed) RequestRaise(ctlWindow);
                        if ((DateTime.Now - occlLog).TotalSeconds > 3)
                        {
                            occlLog = DateTime.Now;
                            Log("window 0x" + ctlWindow.ToString("X") + " occluded -> PrintWindow"
                                + (printed ? " ok " : " unusable ") + now.Width + "x" + now.Height);
                        }
                    }
                    else if (ctlWindow != 0 && ctlWindow == occlForWindow && !occlNow)
                    {
                        ClearRaise();
                        if ((DateTime.Now - occlLog).TotalSeconds > 10)
                        {
                            occlLog = DateTime.Now;
                            Log("window 0x" + ctlWindow.ToString("X") + " visible -> BitBlt crop " + now.Width + "x" + now.Height);
                        }
                    }
                    if (!printed)
                        blitted = BitBlt(bmpDc, 0, 0, now.Width, now.Height,
                                         screenDc, now.Left, now.Top, SRCCOPY);
                }
                finally { gsrc[idx].ReleaseHdc(bmpDc); }
                if (!blitted && !printed)
                    gsrc[idx].CopyFromScreen(now.Left, now.Top, 0, 0, new Size(now.Width, now.Height),
                                             CopyPixelOperation.SourceCopy);
                DateTime now2 = DateTime.Now;
                copyMsSum += (long)(now2 - copyT0).TotalMilliseconds;
                periodSum += (long)(now2 - lastCopy).TotalMilliseconds;
                copyN++;
                filledIdx.Enqueue(idx);
                filledSem.Release();
            }
            catch (Exception ex)
            {
                freeIdx.Enqueue(idx);
                freeSem.Release();
                fails++;
                if (fails <= 3) Log("capture error: " + ex.Message);
                Thread.Sleep(500);
                continue;
            }

            lastCopyEnd = DateTime.Now;
            // intervalMs is a minimum frame period, so a fast machine doesn't spin hot
            double elapsed = (DateTime.Now - lastCopy).TotalMilliseconds;
            if (intervalMs > 0 && elapsed < intervalMs)
                Thread.Sleep((int)(intervalMs - elapsed));
            lastCopy = DateTime.Now;
        }

        ReleaseDC(IntPtr.Zero, screenDc);
        stop.Set();
        filledSem.Release();
        encoder.Join(1500);

        gdst.Dispose();
        dst.Dispose();
        for (int i = 0; i < 2; i++) { gsrc[i].Dispose(); src[i].Dispose(); }
        freeSem.Dispose();
        filledSem.Dispose();
        stop.Dispose();
    }

    static int Main(string[] args)
    {
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try
                {
                    File.AppendAllText(AppDomain.CurrentDomain.BaseDirectory + "capture-error.log",
                        DateTime.Now.ToString("HH:mm:ss.fff") + " " + (e.ExceptionObject == null ? "null" : e.ExceptionObject.ToString()) + Environment.NewLine);
                }
                catch { }
            };
        outFile = args.Length > 0 ? args[0] : "screen-latest.jpg";
        targetWidth = args.Length > 1 ? int.Parse(args[1]) : 1920;
        intervalMs = args.Length > 2 ? int.Parse(args[2]) : 40;
        logFile = args.Length > 3 ? args[3] : "screen-capture.log";
        quality = args.Length > 4 ? long.Parse(args[4]) : 65;
        viewersFile = args.Length > 5 ? args[5] : null;
        intervalFile = args.Length > 7 ? args[7] : null;
        modeFile = args.Length > 8 ? args[8] : null;
        string pipeName = args.Length > 6 ? args[6] : null;
        tmpFile = outFile + "." + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp";
        // 遮挡且抓不到内容时，往这个文件写"请把窗口提到前面"的请求（screen-server 每 2 秒读一次）
        raiseFile = System.IO.Path.Combine(
            System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(outFile)), "raise-window.txt");

        EnableDpiAwareness();
        timeBeginPeriod(1);

        jpeg = FindJpeg();
        enc = new EncoderParameters(1);
        enc.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);

        if (!string.IsNullOrEmpty(pipeName)) pipe = new FramePipe(pipeName);

        Log("capture start targetWidth=" + targetWidth + " interval=" + intervalMs + "ms quality=" + quality
            + " out=" + outFile + " viewers=" + (viewersFile ?? "(none)"));

        while (true)
        {
            ReadControl();
            Rectangle screen = GetSourceRect();
            int wantW = ctlWidth > 0 ? ctlWidth : targetWidth;
            int outW = Math.Max(2, Math.Min(wantW, screen.Width));
            int outH = Math.Max(2, (int)Math.Round(screen.Height * (double)outW / screen.Width));
            RunPipeline(screen, outW, outH);
            Thread.Sleep(300);
        }
    }
}
