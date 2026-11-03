// audio.cs - system audio loopback capture -> named pipe (PCM)
//
// Build (Windows .NET Framework 4.x csc):
//   csc.exe /nologo /target:winexe /out:audio.exe audio.cs ^
//       /r:lib\NAudio.Core.dll /r:lib\NAudio.Wasapi.dll /r:lib\NAudio.WinMM.dll ^
//       /r:%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\netstandard.dll
//
// Usage:
//   audio.exe <pipeName> <logFile>
//   default pipeName = dsh-audio, default logFile = <exeDir>\audio.log
//
// Capture:
//   NAudio WasapiLoopbackCapture on the default render endpoint (system audio,
//   NOT the microphone). The shared-mode mix format on this machine is
//   48000 Hz / 32-bit float / 2ch. The converter normalizes every source format
//   to 48000 Hz / 16-bit signed LE / 2ch PCM, with linear interpolation for
//   non-48 kHz sources and mono->stereo duplication. If the source has more
//   than 2 channels, the first two channels (front L/R) are used.
//
// Wire protocol on the named pipe (byte mode):
//   [uint32 little-endian length][PCM payload] ...
//   chunk length = 3840 bytes = 20 ms of 48000 Hz / 16-bit / 2ch PCM
//   (48000 * 0.020 * 2ch * 2 bytes = 3840). Chunks are written on a 20 ms
//   wall-clock cadence. When no loopback data is available the chunk is padded
//   with zero PCM (digital silence), so the downstream decoder keeps a stable
//   pace. Capture data is buffered in a 2 second ring and trimmed to chunks;
//   buffer overflow drops the oldest audio.
//
// Logging:
//   A line every 30 seconds: rms=<0.0000> chunks=<n> err=<n>
//   rms and chunks cover the last 30 second window (sent chunks only).
//   Connection changes and capture errors are logged as they happen.
//
// Default output device following (2026-11-03):
//   The capture is bound to the default render endpoint at start. A watcher
//   thread re-reads the default endpoint ID every 2 s; when it changes (user
//   plugs in headphones, switches speakers, USB headset reconnects...), the
//   capture loop is torn down and recreated on the new device **in the same
//   process** - the pipe, stats and protocol are untouched. Before this, the
//   process stayed bound to the old device until a reboot -> "phone shows the
//   sound button but there is no sound" (real incident 2026-11-02).
//   Self-test hook: PA_AUDIO_TEST_SWITCH_SEC=<n> forces one device-change
//   restart after n seconds, for machines where you cannot unplug anything.
//
// The process is meant to run windowless (/target:winexe) and be restarted by
// an external supervisor; no watchdog is built in.

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.Wave;

internal static class Program
{
    private static void Main(string[] args)
    {
        // NAudio DLLs live in lib\ next to the exe. Load them explicitly before
        // any method that touches NAudio types is JIT-compiled; the resolver is
        // kept as a fallback for lazy/dependent loads.
        AppDomain.CurrentDomain.AssemblyResolve += ResolveAudioAssembly;
        try
        {
            PreloadAudioAssemblies();
        }
        catch (Exception ex)
        {
            try { Logger.FallbackLog("preload: " + ex); }
            catch { }
        }
        int rc;
        try
        {
            rc = AudioRunner.Run(args);
        }
        catch (Exception ex)
        {
            try { Logger.FallbackLog("fatal: " + ex); }
            catch { }
            rc = 2;
        }
        Environment.Exit(rc);
    }

    private static void PreloadAudioAssemblies()
    {
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string libDir = Path.Combine(baseDir, "lib");
        string[] names = new string[] { "NAudio.Core", "NAudio.Wasapi", "NAudio.WinMM" };
        for (int i = 0; i < names.Length; i++)
        {
            string candidate = Path.Combine(libDir, names[i] + ".dll");
            if (File.Exists(candidate))
                Assembly.Load(File.ReadAllBytes(candidate));
        }
    }

    private static Assembly LoadAudioAssembly(string path)
    {
        // Assembly.LoadFrom refuses this workspace path with "loaded from a
        // network location" (HRESULT 0x80131515) even though the path is local.
        // Loading the raw image bypasses that zone/CAS check; dependencies are
        // satisfied by preloading Core before Wasapi/WinMM.
        return Assembly.Load(File.ReadAllBytes(path));
    }

    private static Assembly ResolveAudioAssembly(object sender, ResolveEventArgs e)
    {
        try
        {
            string simpleName = new AssemblyName(e.Name).Name;
            string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string candidate = Path.Combine(Path.Combine(baseDir, "lib"), simpleName + ".dll");
            if (File.Exists(candidate)) return LoadAudioAssembly(candidate);
            candidate = Path.Combine(baseDir, simpleName + ".dll");
            if (File.Exists(candidate)) return LoadAudioAssembly(candidate);
        }
        catch
        {
        }
        return null;
    }
}

internal static class Logger
{
    private static readonly object Sync = new object();
    private static string _path;

    public static void Init(string path)
    {
        _path = path;
        try
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        }
        catch
        {
        }
    }

    public static void Write(string message)
    {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                      + " " + message + "\r\n";
        lock (Sync)
        {
            try
            {
                if (_path != null)
                    File.AppendAllText(_path, line, new UTF8Encoding(false));
            }
            catch
            {
            }
        }
    }

    public static void FallbackLog(string message)
    {
        try
        {
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                          + " " + message + "\r\n";
            File.AppendAllText(Path.Combine(dir, "audio-fatal.log"), line, new UTF8Encoding(false));
        }
        catch
        {
        }
    }
}

// Fixed-size circular byte buffer. Oldest bytes are dropped when full so that
// the stream always carries fresh audio instead of growing latency.
internal sealed class AudioRing
{
    private readonly byte[] _buffer;
    private readonly object _sync = new object();
    private int _read;
    private int _write;
    private int _count;
    private long _droppedBytes;

    public AudioRing(int capacity)
    {
        _buffer = new byte[capacity];
    }

    public int Count
    {
        get { lock (_sync) { return _count; } }
    }

    public long DroppedBytes
    {
        get { lock (_sync) { return _droppedBytes; } }
    }

    public void Clear()
    {
        lock (_sync)
        {
            _read = 0;
            _write = 0;
            _count = 0;
        }
    }

    public void Write(byte[] src, int offset, int length)
    {
        if (length <= 0) return;
        lock (_sync)
        {
            if (length > _buffer.Length)
            {
                // Caller passed more than the whole ring; keep the newest tail.
                int keep = _buffer.Length;
                Buffer.BlockCopy(src, offset + length - keep, _buffer, 0, keep);
                _read = 0;
                _write = 0;
                _count = keep;
                _droppedBytes += length - keep;
                return;
            }

            int space = _buffer.Length - _count;
            if (length > space)
            {
                int drop = length - space;
                if (drop > _count) drop = _count;
                _read = (_read + drop) % _buffer.Length;
                _count -= drop;
                _droppedBytes += drop;
            }

            int first = Math.Min(length, _buffer.Length - _write);
            Buffer.BlockCopy(src, offset, _buffer, _write, first);
            if (length > first)
                Buffer.BlockCopy(src, offset + first, _buffer, 0, length - first);
            _write = (_write + length) % _buffer.Length;
            _count += length;
        }
    }

    public int Read(byte[] dst, int offset, int length)
    {
        lock (_sync)
        {
            int n = Math.Min(length, _count);
            if (n <= 0) return 0;
            int first = Math.Min(n, _buffer.Length - _read);
            Buffer.BlockCopy(_buffer, _read, dst, offset, first);
            if (n > first)
                Buffer.BlockCopy(_buffer, 0, dst, offset + first, n - first);
            _read = (_read + n) % _buffer.Length;
            _count -= n;
            return n;
        }
    }
}

internal sealed class AudioStats
{
    private readonly object _sync = new object();
    private long _chunks;
    private long _errors;
    private long _samples;
    private double _sumSquares;

    public void AddChunk(byte[] pcm, int offset, int length)
    {
        double sum = 0.0;
        long samples = 0;
        for (int i = offset; i + 1 < offset + length; i += 2)
        {
            short value = (short)(pcm[i] | (pcm[i + 1] << 8));
            double normalized = value / 32768.0;
            sum += normalized * normalized;
            samples++;
        }
        lock (_sync)
        {
            _chunks++;
            _sumSquares += sum;
            _samples += samples;
        }
    }

    public void AddError()
    {
        lock (_sync) { _errors++; }
    }

    public void TakeWindow(out long chunks, out double rms, out long errors)
    {
        lock (_sync)
        {
            chunks = _chunks;
            errors = _errors;
            rms = _samples > 0 ? Math.Sqrt(_sumSquares / _samples) : 0.0;
            _chunks = 0;
            _errors = 0;
            _samples = 0;
            _sumSquares = 0.0;
        }
    }
}

// Streaming linear-interpolation resampler, one instance per channel pair.
internal sealed class LinearResampler
{
    private readonly double _step;
    private float[] _left = new float[4096];
    private float[] _right = new float[4096];
    private int _count;
    private double _phase;

    public LinearResampler(int sourceRate, int targetRate)
    {
        _step = (double)sourceRate / targetRate;
    }

    public void Push(float[] left, float[] right, int frames)
    {
        EnsureCapacity(_count + frames);
        Array.Copy(left, 0, _left, _count, frames);
        Array.Copy(right, 0, _right, _count, frames);
        _count += frames;
    }

    public int Process(float[] outLeft, float[] outRight, int capacity)
    {
        int produced = 0;
        while (produced < capacity && _phase + 1.0 < _count)
        {
            int index = (int)_phase;
            double fraction = _phase - index;
            outLeft[produced] = (float)(_left[index] * (1.0 - fraction) + _left[index + 1] * fraction);
            outRight[produced] = (float)(_right[index] * (1.0 - fraction) + _right[index + 1] * fraction);
            produced++;
            _phase += _step;
        }

        int consumed = (int)_phase;
        if (consumed > 0)
        {
            int remaining = _count - consumed;
            if (remaining > 0)
            {
                Array.Copy(_left, consumed, _left, 0, remaining);
                Array.Copy(_right, consumed, _right, 0, remaining);
            }
            _count = remaining;
            _phase -= consumed;
        }
        return produced;
    }

    private void EnsureCapacity(int needed)
    {
        if (needed <= _left.Length) return;
        int size = _left.Length;
        while (size < needed) size *= 2;
        Array.Resize(ref _left, size);
        Array.Resize(ref _right, size);
    }
}

// Converts a NAudio capture buffer into 48000 Hz / 16-bit / 2ch PCM and writes
// it into the ring buffer.
internal sealed class PcmConverter
{
    private const int TargetRate = 48000;
    private const int TargetChannels = 2;

    private readonly int _sourceChannels;
    private readonly int _sourceRate;
    private readonly int _sourceBits;
    private readonly int _sourceBlockAlign;
    private readonly bool _isFloat32;
    private readonly AudioRing _ring;
    private readonly LinearResampler _resampler;

    private float[] _left = new float[2048];
    private float[] _right = new float[2048];
    private float[] _outLeft = new float[4096];
    private float[] _outRight = new float[4096];
    private byte[] _pcm = new byte[8192];

    public PcmConverter(WaveFormat format, AudioRing ring)
    {
        _sourceChannels = format.Channels;
        _sourceRate = format.SampleRate;
        _sourceBits = format.BitsPerSample;
        _sourceBlockAlign = format.BlockAlign;
        // Shared-mode WASAPI is 32-bit float. Extensible 32-bit is treated as
        // float here (the normal case); plain Pcm 32-bit is handled as integer.
        _isFloat32 = format.Encoding == WaveFormatEncoding.IeeeFloat
                     || (format.Encoding == WaveFormatEncoding.Extensible && format.BitsPerSample == 32);
        _ring = ring;
        if (_sourceRate != TargetRate)
            _resampler = new LinearResampler(_sourceRate, TargetRate);
    }

    public void Process(byte[] buffer, int bytesRecorded)
    {
        if (bytesRecorded <= 0) return;
        int frames = bytesRecorded / _sourceBlockAlign;
        if (frames <= 0) return;

        EnsureSourceBuffers(frames);
        Decode(buffer, frames);

        int outFrames;
        float[] outLeft;
        float[] outRight;
        if (_resampler == null)
        {
            outFrames = frames;
            outLeft = _left;
            outRight = _right;
        }
        else
        {
            int capacity = (int)Math.Ceiling(frames * (double)TargetRate / _sourceRate) + 16;
            EnsureOutputBuffers(capacity);
            _resampler.Push(_left, _right, frames);
            outFrames = _resampler.Process(_outLeft, _outRight, capacity);
            outLeft = _outLeft;
            outRight = _outRight;
        }

        if (outFrames <= 0) return;
        int byteCount = outFrames * TargetChannels * 2;
        EnsurePcmBuffer(byteCount);

        int p = 0;
        for (int i = 0; i < outFrames; i++)
        {
            WritePcm16(_pcm, p, outLeft[i]); p += 2;
            WritePcm16(_pcm, p, outRight[i]); p += 2;
        }
        _ring.Write(_pcm, 0, byteCount);
    }

    private void Decode(byte[] buffer, int frames)
    {
        int bytesPerSample = _sourceBits / 8;
        for (int i = 0; i < frames; i++)
        {
            int offset = i * _sourceBlockAlign;
            float left = ReadSample(buffer, offset);
            float right;
            if (_sourceChannels <= 1) right = left;
            else right = ReadSample(buffer, offset + bytesPerSample);
            _left[i] = left;
            _right[i] = right;
        }
    }

    private float ReadSample(byte[] buffer, int offset)
    {
        switch (_sourceBits)
        {
            case 8:
                return (buffer[offset] - 128) / 128.0f;
            case 16:
                return (short)(buffer[offset] | (buffer[offset + 1] << 8)) / 32768.0f;
            case 24:
            {
                int value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
                if ((value & 0x800000) != 0) value |= unchecked((int)0xFF000000);
                return value / 8388608.0f;
            }
            case 32:
                if (_isFloat32) return BitConverter.ToSingle(buffer, offset);
                return BitConverter.ToInt32(buffer, offset) / 2147483648.0f;
            default:
                return 0.0f;
        }
    }

    private static void WritePcm16(byte[] buffer, int offset, float sample)
    {
        if (sample > 1.0f) sample = 1.0f;
        else if (sample < -1.0f) sample = -1.0f;
        int value = (int)(sample * 32767.0f);
        if (value > 32767) value = 32767;
        else if (value < -32768) value = -32768;
        buffer[offset] = (byte)(value & 0xFF);
        buffer[offset + 1] = (byte)((value >> 8) & 0xFF);
    }

    private void EnsureSourceBuffers(int frames)
    {
        if (frames <= _left.Length) return;
        int size = _left.Length;
        while (size < frames) size *= 2;
        _left = new float[size];
        _right = new float[size];
    }

    private void EnsureOutputBuffers(int frames)
    {
        if (frames <= _outLeft.Length) return;
        int size = _outLeft.Length;
        while (size < frames) size *= 2;
        _outLeft = new float[size];
        _outRight = new float[size];
    }

    private void EnsurePcmBuffer(int bytes)
    {
        if (bytes <= _pcm.Length) return;
        int size = _pcm.Length;
        while (size < bytes) size *= 2;
        _pcm = new byte[size];
    }
}

internal sealed class AudioRunner
{
    private const int TargetRate = 48000;
    private const int TargetChannels = 2;
    private const int ChunkMilliseconds = 20;
    private const int ChunkBytes = TargetRate * ChunkMilliseconds / 1000 * TargetChannels * 2; // 3840
    private const int PipeWriteTimeoutMs = 2000;

    private readonly string _pipeName;
    private readonly AudioRing _ring = new AudioRing(TargetRate * TargetChannels * 2 * 2); // 2 s
    private readonly AudioStats _stats = new AudioStats();
    private readonly long _chunkTicks = (long)(Stopwatch.Frequency * ChunkMilliseconds / 1000.0);
    private volatile bool _running = true;

    // 默认输出设备跟随（2026-11-03）：以前 audio.exe 启动时绑死当时的默认输出设备，
    // 用户换耳机/扬声器后采集的还是老设备，表现为"手机点声音没声音"，要重启电脑才恢复。
    // 现在每 2 秒查一次默认渲染设备的 ID，一变就让采集循环重建 capture（进程不退出，
    // 管道和统计线程不受影响），换设备几秒内自动恢复，不用重启任何东西。
    private volatile string _deviceId = "";
    private volatile bool _deviceChanged = false;
    // 自测钩子：设了 PA_AUDIO_TEST_SWITCH_SEC=10 时，10 秒后强制触发一次"设备变化"重启，
    // 用来在没法真的插拔耳机时验证重启通路（不影响正常使用，默认关闭）。
    private readonly int _testSwitchSec = 0;
    private long _testSwitchDone = 0;
    private readonly Stopwatch _watch = Stopwatch.StartNew();

    public AudioRunner(string pipeName)
    {
        _pipeName = pipeName;
        try
        {
            int sec = 0;
            if (int.TryParse(Environment.GetEnvironmentVariable("PA_AUDIO_TEST_SWITCH_SEC"), out sec) && sec > 0)
                _testSwitchSec = sec;
        }
        catch { }
    }

    public static int Run(string[] args)
    {
        string pipeName = (args.Length > 0 && args[0].Length > 0) ? args[0] : "dsh-audio";
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string logFile = (args.Length > 1 && args[1].Length > 0)
            ? args[1]
            : Path.Combine(exeDir, "audio.log");

        Logger.Init(logFile);
        Logger.Write("audio: start pid=" + Process.GetCurrentProcess().Id
                     + " pipe=" + pipeName + " log=" + logFile);
        Logger.Write("audio: capture=WASAPI loopback (default render endpoint), target="
                     + TargetRate + "Hz/16bit/" + TargetChannels + "ch, chunk=" + ChunkBytes
                     + " bytes (" + ChunkMilliseconds + " ms), protocol=[uint32 LE len][pcm]");
        Logger.Write("audio: silence padding enabled; reconnect loop enabled; stats every 30s");

        AudioRunner runner = new AudioRunner(pipeName);
        runner.Start();

        Thread.Sleep(Timeout.Infinite);
        return 0;
    }

    public void Start()
    {
        StartThread(PipeLoop, "audio-pipe");
        StartThread(CaptureLoop, "audio-capture");
        StartThread(StatsLoop, "audio-stats");
        StartThread(DeviceWatchLoop, "audio-devicewatch");
    }

    // 默认输出设备变化监听：只比 ID，2 秒一次，COM 调用很便宜（实测 <1ms）。
    // 设备被拔掉时枚举会抛异常，按"拿不到"处理，下一轮再试，不退出。
    private void DeviceWatchLoop()
    {
        while (_running)
        {
            Thread.Sleep(2000);
            if (!_running) break;

            if (_testSwitchSec > 0 && Interlocked.Read(ref _testSwitchDone) == 0
                && _watch.Elapsed.TotalSeconds >= _testSwitchSec)
            {
                Interlocked.Exchange(ref _testSwitchDone, 1);
                Logger.Write("device: [test] forced switch after " + _testSwitchSec + "s");
                _deviceChanged = true;
                continue;
            }

            string now = GetDefaultRenderDeviceId();
            if (now.Length == 0) continue;
            string cur = _deviceId;
            if (cur.Length == 0)
            {
                // 采集线程还没报上来（启动早期），先记下，不算切换
                _deviceId = now;
                continue;
            }
            if (!string.Equals(now, cur, StringComparison.OrdinalIgnoreCase))
            {
                Logger.Write("device: default output changed " + cur + " -> " + now + ", restart capture");
                _deviceChanged = true;
            }
        }
    }

    private static string GetDefaultRenderDeviceId()
    {
        MMDeviceEnumerator en = null;
        MMDevice dev = null;
        try
        {
            en = new MMDeviceEnumerator();
            dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            return dev == null ? "" : (dev.ID ?? "");
        }
        catch { return ""; }
        finally
        {
            if (dev != null) { try { dev.Dispose(); } catch { } }
            if (en != null) { try { en.Dispose(); } catch { } }
        }
    }

    private void StartThread(ThreadStart body, string name)
    {
        Thread thread = new Thread(delegate ()
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                _stats.AddError();
                Logger.Write("audio: thread " + name + " crashed: " + ex);
            }
        });
        thread.IsBackground = true;
        thread.Name = name;
        thread.Start();
    }

    private void PipeLoop()
    {
        while (_running)
        {
            NamedPipeServerStream pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(
                    _pipeName,
                    PipeDirection.Out,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.None,
                    65536,
                    65536);
                Logger.Write("pipe: listening name=" + _pipeName);
                pipe.WaitForConnection();
                Logger.Write("pipe: client connected");
                _ring.Clear();
                SendLoop(pipe);
                Logger.Write("pipe: client disconnected");
            }
            catch (Exception ex)
            {
                _stats.AddError();
                Logger.Write("pipe: error " + ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                if (pipe != null)
                {
                    try { pipe.Dispose(); }
                    catch { }
                }
            }
            if (_running) Thread.Sleep(500);
        }
    }

    private void SendLoop(NamedPipeServerStream pipe)
    {
        byte[] packet = new byte[4 + ChunkBytes];
        packet[0] = (byte)(ChunkBytes & 0xFF);
        packet[1] = (byte)((ChunkBytes >> 8) & 0xFF);
        packet[2] = (byte)((ChunkBytes >> 16) & 0xFF);
        packet[3] = (byte)((ChunkBytes >> 24) & 0xFF);
        long baseTicks = Stopwatch.GetTimestamp();
        long chunkIndex = 0;

        while (_running && pipe.IsConnected)
        {
            int read = _ring.Read(packet, 4, ChunkBytes);
            if (read < ChunkBytes) Array.Clear(packet, 4 + read, ChunkBytes - read);

            _stats.AddChunk(packet, 4, ChunkBytes);

            if (!WriteWithTimeout(pipe, packet))
                break;

            chunkIndex++;
            long targetTicks = baseTicks + chunkIndex * _chunkTicks;
            long now = Stopwatch.GetTimestamp();
            double waitMs = (targetTicks - now) * 1000.0 / Stopwatch.Frequency;
            if (waitMs > 0)
            {
                int sleepMs = (int)Math.Floor(waitMs);
                if (sleepMs > 0) Thread.Sleep(sleepMs);
            }
            else if (waitMs < -1000.0)
            {
                // Fell far behind (e.g. suspended); restart the pacing baseline.
                baseTicks = now;
                chunkIndex = 0;
            }
        }
    }

    private bool WriteWithTimeout(NamedPipeServerStream pipe, byte[] chunk)
    {
        try
        {
            IAsyncResult result = pipe.BeginWrite(chunk, 0, chunk.Length, null, null);
            if (!result.AsyncWaitHandle.WaitOne(PipeWriteTimeoutMs))
            {
                _stats.AddError();
                Logger.Write("pipe: write timeout after " + PipeWriteTimeoutMs + " ms");
                return false;
            }
            pipe.EndWrite(result);
            return true;
        }
        catch (IOException ex)
        {
            // A client that stops reading/closes the pipe is a normal event;
            // the server accepts a reconnect immediately.
            Logger.Write("pipe: write ended (client disconnected): " + ex.Message);
            return false;
        }
        catch (Exception ex)
        {
            _stats.AddError();
            Logger.Write("pipe: write failed " + ex.GetType().Name + ": " + ex.Message);
            return false;
        }
    }

    private void CaptureLoop()
    {
        while (_running)
        {
            WasapiLoopbackCapture capture = null;
            MMDevice device = null;
            bool restartForDevice = false;
            try
            {
                // 显式拿默认渲染设备：一是让日志能记下"现在绑的是哪个设备"，
                // 二是 WasapiLoopbackCapture(device) 能确保我们绑的就是这个设备（默认构造也会取默认设备，
                // 但拿不到它的 ID，就没法判断用户后来换没换）。
                MMDeviceEnumerator en = new MMDeviceEnumerator();
                try
                {
                    device = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                }
                finally
                {
                    try { en.Dispose(); } catch { }
                }
                _deviceId = (device == null) ? "" : (device.ID ?? "");
                _deviceChanged = false;
                if (device != null)
                {
                    Logger.Write("capture: device id=" + _deviceId + " name=" + (device.FriendlyName ?? ""));
                    capture = new WasapiLoopbackCapture(device);
                }
                else
                {
                    Logger.Write("capture: no default render device, fallback to default constructor");
                    capture = new WasapiLoopbackCapture();
                }
                WaveFormat format = capture.WaveFormat;
                Logger.Write("capture: source " + format.SampleRate + "Hz/" + format.BitsPerSample
                             + "bit/" + format.Channels + "ch encoding=" + format.Encoding
                             + " blockAlign=" + format.BlockAlign
                             + (format.Encoding == WaveFormatEncoding.Extensible ? " (extensible, 32bit=>float assumed when bits=32)" : ""));

                ManualResetEvent stopped = new ManualResetEvent(false);

                PcmConverter converter = new PcmConverter(format, _ring);
                capture.DataAvailable += delegate (object sender, WaveInEventArgs e)
                {
                    try
                    {
                        converter.Process(e.Buffer, e.BytesRecorded);
                    }
                    catch (Exception ex)
                    {
                        _stats.AddError();
                        Logger.Write("convert: error " + ex.GetType().Name + ": " + ex.Message);
                    }
                };
                capture.RecordingStopped += delegate (object sender, StoppedEventArgs e)
                {
                    stopped.Set();
                    if (e.Exception != null)
                    {
                        _stats.AddError();
                        Logger.Write("capture: stopped with error " + e.Exception.GetType().Name + ": " + e.Exception.Message);
                    }
                    else
                    {
                        Logger.Write("capture: stopped");
                    }
                };

                capture.StartRecording();
                Logger.Write("capture: started");

                while (_running && !stopped.WaitOne(500))
                {
                    // 默认输出设备变了：跳出循环，重建 capture 绑到新设备（进程和管道都保留）
                    if (_deviceChanged)
                    {
                        restartForDevice = true;
                        Logger.Write("capture: leaving for device change");
                        break;
                    }
                }

                Logger.Write("capture: capture loop leaving");
            }
            catch (Exception ex)
            {
                _stats.AddError();
                Logger.Write("capture: init error " + ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                if (capture != null)
                {
                    try { capture.StopRecording(); }
                    catch { }
                    try { capture.Dispose(); }
                    catch { }
                }
                if (device != null)
                {
                    try { device.Dispose(); }
                    catch { }
                }
            }
            // 换设备时立刻重建（不等 3 秒）；异常退出才等 3 秒重试
            if (_running && !restartForDevice) Thread.Sleep(3000);
        }
    }

    private void StatsLoop()
    {
        while (_running)
        {
            Thread.Sleep(30000);
            if (!_running) break;
            long chunks;
            double rms;
            long errors;
            _stats.TakeWindow(out chunks, out rms, out errors);
            Logger.Write("rms=" + rms.ToString("0.0000", CultureInfo.InvariantCulture)
                         + " chunks=" + chunks
                         + " err=" + errors);
        }
    }
}
