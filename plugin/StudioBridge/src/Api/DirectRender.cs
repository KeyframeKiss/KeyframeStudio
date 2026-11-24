using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using BepInEx.Bootstrap;
using HarmonyLib;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Straight to video: each frame is rendered at the video's size (through Screencap when it's installed — the same
    /// picture VideoExport records — else Studio's camera, supersampled), its pixels go straight into ffmpeg while
    /// recording, and the video is done moments after the last frame. No image files, no encoding pass afterwards.
    /// The game clock steps one frame at a time (Time.captureFramerate, as VideoExport does), so the result plays at the
    /// right speed however long a frame takes. MP4 and WEBM; GIF and AVI go through VideoExport's image files.
    /// </summary>
    internal static class DirectRender
    {
        /// <summary>direct (straight to video) | files (VideoExport's image files)</summary>
        public static string Frames = "direct";

        public static bool Supports(string format) => format == "MP4" || format == "WEBM";

        // what's happening, for render.status
        public static bool Recording, Finishing;
        public static int Frame, FrameLimit;
        public static double MsPerFrame;
        public static string Provider; // what took the pictures in the last recording

        /// <summary>
        /// Record `seconds` from this frame on (the caller has the timeline paused at the start; this plays it), then
        /// finish the file. Reports the video's path, or why there's none (null path, error set; null both = cancelled).
        /// </summary>
        public static IEnumerator Record(float seconds, Func<bool> cancelled, Action<string, string> done)
        {
            string format = RenderApi.Format();
            int fps = Mathf.Clamp(RenderApi.Fps(), 1, 120);
            var size = RenderApi.DirectSize();
            int w = size[0] & ~1, h = size[1] & ~1; // even, for the video's colour format
            int ss = RenderSpeed.Draft ? 1 : RenderSpeed.Supersampling();
            int n = Mathf.Max(1, Mathf.RoundToInt(seconds * fps));
            var ffmpeg = RenderApi.Ffmpeg();
            if (ffmpeg == null) { done(null, "VideoExport's ffmpeg wasn't found"); yield break; }
            if ((long)w * ss * h * ss > 8192L * 8192L) ss = 1;

            string dir = RenderApi.OutputFolder();
            Directory.CreateDirectory(dir);
            string ext = format == "WEBM" ? ".webm" : ".mp4";
            string path = Path.Combine(dir, DateTime.Now.ToString("yyyy-MM-ddTHH-mm-ss") + ext);
            for (int k = 2; File.Exists(path); k++) path = Path.Combine(dir, DateTime.Now.ToString("yyyy-MM-ddTHH-mm-ss") + " (" + k + ")" + ext);

            Recording = true;
            Finishing = false;
            Provider = null;
            Frame = 0;
            FrameLimit = n;
            Process proc = null;
            Writer writer = null;
            string error = null;
            int cachedRate = Time.captureFramerate;
            var bones = BonesEveryFrame();
            var sw = new Stopwatch();
            try
            {
                for (int i = 0; i < n; i++)
                {
                    if (i > 0) yield return new WaitForEndOfFrame();
                    if (cancelled()) break;
                    if (writer?.Error != null) { error = "ffmpeg stopped: " + writer.Error; break; }
                    sw.Start();
                    var tex = Capture(w, h, ss);
                    if (tex == null) { error = "Couldn't render the frame"; break; }
                    byte[] px;
                    string pixFmt;
                    try
                    {
                        pixFmt = PixFmt(tex.format);
                        px = pixFmt != null ? tex.GetRawTextureData() : null;
                        if (px == null) { pixFmt = "rgba"; px = Rgba(tex); }
                    }
                    finally { UnityEngine.Object.Destroy(tex); }
                    if (proc == null)
                    {
                        // the first frame says what the pixels look like: start ffmpeg on it, then the clock and the timeline
                        proc = Start(ffmpeg, w, h, fps, pixFmt, format, path);
                        writer = new Writer(proc.StandardInput.BaseStream);
                        Time.captureFramerate = fps;
                        TimelineApi.Play();
                    }
                    writer.Add(px); // waits when ffmpeg is a few frames behind
                    sw.Stop();
                    Frame = i + 1;
                }
            }
            finally
            {
                Time.captureFramerate = cachedRate;
                RestoreBones(bones);
                Recording = false;
                MsPerFrame = Frame > 0 ? Math.Round(sw.Elapsed.TotalMilliseconds / Frame, 2) : 0;
            }

            // the rest of the frames into the file, then ffmpeg finishes it
            Finishing = true;
            bool cancel = cancelled();
            if (writer != null)
            {
                writer.Close(cancel);
                float t0 = Time.realtimeSinceStartup;
                while (!proc.HasExited && Time.realtimeSinceStartup - t0 < 600f)
                {
                    if (cancel) { try { proc.Kill(); } catch { } break; }
                    yield return null;
                }
                if (!proc.HasExited) { try { proc.Kill(); } catch { } error = error ?? "ffmpeg took too long"; }
                string err = "";
                try { err = proc.StandardError.ReadToEnd().Trim(); } catch { }
                if (!cancel && error == null && proc.HasExited && proc.ExitCode != 0) error = "ffmpeg: " + (err.Length > 0 ? err : "exit code " + proc.ExitCode);
                if (error == null && writer.Error != null) error = "ffmpeg stopped: " + writer.Error + (err.Length > 0 ? " — " + err : "");
                proc.Dispose();
            }
            Finishing = false;
            StudioBridgePlugin.Logger.LogInfo("Render (straight to video): " + Frame + " frames " + w + "×" + h + " by " + Provider + ", " + MsPerFrame + " ms each");
            if (cancel || error != null)
            {
                try { if (File.Exists(path)) File.Delete(path); } catch { }
                done(null, cancel ? null : error);
            }
            else done(File.Exists(path) ? path : null, File.Exists(path) ? null : "No video was written");
        }

        private static Process Start(string ffmpeg, int w, int h, int fps, string pixFmt, string format, string path)
        {
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            string codec = format == "WEBM"
                ? "-c:v libvpx-vp9 -crf " + RenderApi.WebmQuality() + " -b:v 0 -deadline good -cpu-used 4 -row-mt 1 -pix_fmt yuv420p"
                : RenderSpeed.Encode == "gpu" && RenderSpeed.GpuWorks == true
                    ? "-c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq " + (RenderApi.Mp4Quality() + 1) + " -b:v 0 -pix_fmt yuv420p"
                    : "-c:v libx264 -tune animation -crf " + RenderApi.Mp4Quality() + " -preset " + (RenderSpeed.Encode == "small" ? "slower" : "medium") + " -pix_fmt yuv420p";
            string args = "-y -hide_banner -loglevel error -f rawvideo -pix_fmt " + pixFmt + " -s " + w + "x" + h + " -r " + fps.ToString(inv) +
                          " -i - -vf vflip " + codec + (format == "WEBM" ? "" : " -movflags +faststart") + " \"" + path + "\"";
            var psi = new ProcessStartInfo(ffmpeg, args)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardError = true, RedirectStandardOutput = false,
            };
            return Process.Start(psi);
        }

        /// <summary>The frames to ffmpeg from a worker thread, a few at most waiting (the main thread waits beyond that).</summary>
        private sealed class Writer
        {
            private readonly Stream _to;
            private readonly Queue<byte[]> _q = new Queue<byte[]>();
            private bool _closed;
            public volatile string Error;
            private readonly Thread _t;

            public Writer(Stream to)
            {
                _to = to;
                _t = new Thread(Loop) { IsBackground = true, Name = "KF video writer" };
                _t.Start();
            }

            public void Add(byte[] frame)
            {
                lock (_q)
                {
                    while (_q.Count >= 6 && Error == null) Monitor.Wait(_q, 200);
                    if (Error != null) return;
                    _q.Enqueue(frame);
                    Monitor.PulseAll(_q);
                }
            }

            private void Loop()
            {
                try
                {
                    while (true)
                    {
                        byte[] f;
                        lock (_q)
                        {
                            while (_q.Count == 0 && !_closed) Monitor.Wait(_q);
                            if (_q.Count == 0) break;
                            f = _q.Peek();
                        }
                        _to.Write(f, 0, f.Length);
                        lock (_q)
                        {
                            _q.Dequeue();
                            Monitor.PulseAll(_q);
                        }
                    }
                    _to.Flush();
                }
                catch (Exception e) { Error = e.Message; }
                finally
                {
                    try { _to.Close(); } catch { }
                    lock (_q) Monitor.PulseAll(_q);
                }
            }

            /// <summary>No more frames: the rest are written (or dropped when cancelled), then the input closes.</summary>
            public void Close(bool drop)
            {
                lock (_q)
                {
                    if (drop) _q.Clear();
                    _closed = true;
                    Monitor.PulseAll(_q);
                }
                _t.Join(drop ? 2000 : 120000);
            }
        }

        // ---------------- the picture ----------------

        private const string ScreencapGuid = "com.bepis.bepinex.screenshotmanager";

        private static Texture2D Capture(int w, int h, int ss)
        {
            if (Chainloader.PluginInfos.TryGetValue(ScreencapGuid, out var info))
            {
                try
                {
                    var m = AccessTools.Method(info.Instance.GetType(), "Capture", new[] { typeof(int), typeof(int), typeof(int), typeof(bool) });
                    if (m?.Invoke(info.Instance, new object[] { w, h, ss, false }) is Texture2D t) { Provider = "Screencap " + t.format; return t; }
                    if (Provider == null) StudioBridgePlugin.Logger.LogWarning("Render: Screencap gave no picture (" + (m == null ? "no Capture method" : "null") + "), using Studio's camera");
                }
                catch (Exception e) { if (Provider == null) StudioBridgePlugin.Logger.LogWarning("Render: Screencap capture failed, using Studio's camera: " + (e.InnerException ?? e)); }
            }
            Provider = "camera";
            return StillsApi.RenderCamera(w, h, ss);
        }

        private static string PixFmt(TextureFormat f)
        {
            switch (f)
            {
                case TextureFormat.RGB24: return "rgb24";
                case TextureFormat.RGBA32: return "rgba";
                case TextureFormat.ARGB32: return "argb";
                case TextureFormat.BGRA32: return "bgra";
                default: return null;
            }
        }

        private static byte[] Rgba(Texture2D t)
        {
            var c = t.GetPixels32();
            var b = new byte[c.Length * 4];
            for (int i = 0, j = 0; i < c.Length; i++, j += 4) { b[j] = c[i].r; b[j + 1] = c[i].g; b[j + 2] = c[i].b; b[j + 3] = c[i].a; }
            return b;
        }

        // hair and skirts every frame while recording, when VideoExport is set to (its "update dynamic bones" option)
        private static List<KeyValuePair<object, float>> BonesEveryFrame()
        {
            var was = new List<KeyValuePair<object, float>>();
            if (!RenderApi.DynamicBonesEveryFrame()) return was;
            foreach (var b in Resources.FindObjectsOfTypeAll<DynamicBone>()) { was.Add(new KeyValuePair<object, float>(b, b.m_UpdateRate)); b.m_UpdateRate = -1f; }
            foreach (var b in Resources.FindObjectsOfTypeAll<DynamicBone_Ver02>()) { was.Add(new KeyValuePair<object, float>(b, b.UpdateRate)); b.UpdateRate = -1f; }
            return was;
        }

        private static void RestoreBones(List<KeyValuePair<object, float>> was)
        {
            foreach (var kv in was)
            {
                if (kv.Key is DynamicBone a && a != null) a.m_UpdateRate = kv.Value;
                else if (kv.Key is DynamicBone_Ver02 b && b != null) b.UpdateRate = kv.Value;
            }
        }
    }
}
