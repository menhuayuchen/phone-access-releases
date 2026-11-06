    // ---- capture source selection (whole desktop / one monitor / one window) ----
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

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

