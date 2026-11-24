using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Text.RegularExpressions;
using HarmonyLib;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Faster renders through VideoExport. Measured on the sample scene (1280×720, Screencap at 2× supersampling):
    /// a frame took ~74 ms to capture, almost all of it Screencap compressing a PNG on the main thread; JPG frames at
    /// quality 100 took ~37 ms and the video came out the same (PSNR against PNG frames as close as two PNG renders
    /// are to each other). So while Keyframe Studio renders a video:
    ///  - frames are JPG at quality 100 (Screencap's own settings come back afterwards);
    ///  - Draft turns supersampling off (faster again, edges a little rougher);
    ///  - MP4 encodes with x264 Medium (Balanced), VideoExport's own preset (Smallest files: Slower by default), or
    ///    the NVIDIA encoder (GPU), when a test encode shows it works here.
    /// The capture time per frame is measured each recording (render.speed).
    /// </summary>
    internal static class RenderSpeed
    {
        /// <summary>balanced | small | gpu</summary>
        public static string Encode = "balanced";
        public static bool Draft;

        private static bool _patched;
        private static string _patchError;
        private static MethodInfo _capture;
        private static bool _active; // inside one of our renders: the encoder choice applies

        private static int _frames;
        private static double _captureMs;

        public static void Register(CommandRouter r)
        {
            r.Add("render.speed", a => Stats());
        }

        /// <summary>Patch VideoExport (once): time the frame captures; the MP4 encoder choice.</summary>
        public static void EnsurePatched()
        {
            if (_patched) return;
            _patched = true;
            try
            {
                var h = new Harmony(StudioBridgePlugin.GUID + ".renderspeed");
                var t = AccessTools.TypeByName("VideoExport.VideoExport") ?? throw new Exception("VideoExport not found");
                var routine = AccessTools.Method(t, "RecordVideo_Routine") ?? throw new Exception("RecordVideo_Routine not found");
                var moveNext = AccessTools.EnumeratorMoveNext(routine) ?? throw new Exception("its MoveNext not found");
                h.Patch(moveNext, transpiler: new HarmonyMethod(typeof(RenderSpeed), nameof(Transpiler)));
                var mp4 = AccessTools.Method(AccessTools.TypeByName("VideoExport.Extensions.MP4Extension"), "GetArguments");
                if (mp4 != null) h.Patch(mp4, postfix: new HarmonyMethod(typeof(RenderSpeed), nameof(Mp4Arguments)));
            }
            catch (Exception e)
            {
                _patchError = e.Message;
                StudioBridgePlugin.Logger.LogWarning("Render: VideoExport wasn't patched (no speed-ups): " + e.Message);
            }
        }

        private static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
        {
            foreach (var i in instructions)
            {
                if ((i.opcode == OpCodes.Callvirt || i.opcode == OpCodes.Call) && i.operand is MethodInfo m && m.DeclaringType?.Name == "IScreenshotPlugin" && m.Name == "Capture")
                {
                    _capture = m;
                    i.opcode = OpCodes.Call;
                    i.operand = AccessTools.Method(typeof(RenderSpeed), nameof(Capture));
                }
                yield return i;
            }
        }

        public static byte[] Capture(object plugin, string path)
        {
            var sw = Stopwatch.StartNew();
            var bytes = (byte[])_capture.Invoke(plugin, new object[] { path });
            _captureMs += sw.Elapsed.TotalMilliseconds;
            _frames++;
            return bytes;
        }

        /// <summary>VideoExport's MP4 command line, with the encoder chosen here (only in our renders).</summary>
        private static void Mp4Arguments(ref string __result)
        {
            if (!_active || __result == null) return;
            try { __result = EncoderArgs(__result); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Render: encoder choice not applied: " + e.Message); }
        }

        /// <summary>x264's line → this choice's (Balanced: preset medium; GPU: NVENC at about the same quality).</summary>
        internal static string EncoderArgs(string args)
        {
            if (Encode == "balanced") return Regex.Replace(args, @"-preset \S+", "-preset medium");
            if (Encode == "gpu" && GpuWorks == true)
            {
                var m = Regex.Match(args, @"-crf (\d+)");
                int cq = m.Success ? int.Parse(m.Groups[1].Value) + 1 : 19;
                args = args.Replace("-tune animation ", "");
                args = Regex.Replace(args, @"-vcodec libx26[45]", "-vcodec h264_nvenc");
                args = Regex.Replace(args, @"-pix_fmt yuv420p10le", "-pix_fmt yuv420p");
                args = Regex.Replace(args, @"-crf \d+ -preset \S+", "-preset p6 -tune hq -rc vbr -cq " + cq + " -b:v 0");
                args = Regex.Replace(args, @"-threads \d+ ", "");
            }
            return args;
        }

        /// <summary>For our own re-encode (cutting to shape): the same choice.</summary>
        internal static string CropCodec() =>
            Encode == "gpu" && GpuWorks == true ? "h264_nvenc -preset p6 -tune hq -rc vbr -cq 19 -b:v 0 -pix_fmt yuv420p"
            : "libx264 -crf 18 -preset " + (Encode == "balanced" ? "medium" : "slow") + " -pix_fmt yuv420p";

        // ---------------- one render's settings, put back afterwards ----------------

        private static object[] _saved;
        private static object _cfg; // Screencap's config file: not saved while a render has its settings changed
        private static object _saveWas;

        /// <summary>Before a video is recorded: JPG frames (quality 100), Draft's supersampling, our encoder choice.</summary>
        public static void Begin()
        {
            EnsurePatched();
            _frames = 0;
            _captureMs = 0;
            _saved = new[] { Screencap("UseJpg"), Screencap("JpgQuality"), Screencap("DownscalingRate") };
            // (a crash mid-render mustn't leave the screenshot settings changed on disk)
            _cfg = Entry("UseJpg")?.GetType().GetProperty("ConfigFile")?.GetValue(Entry("UseJpg"), null);
            var save = _cfg?.GetType().GetProperty("SaveOnConfigSet");
            _saveWas = save?.GetValue(_cfg, null);
            if (save != null) save.SetValue(_cfg, false, null);
            Screencap("UseJpg", true);
            Screencap("JpgQuality", 100);
            if (Draft) Screencap("DownscalingRate", 1);
            _active = true;
        }

        public static void End()
        {
            _active = false;
            if (_saved == null) return;
            if (_saved[0] != null) Screencap("UseJpg", _saved[0]);
            if (_saved[1] != null) Screencap("JpgQuality", _saved[1]);
            if (_saved[2] != null) Screencap("DownscalingRate", _saved[2]);
            _saved = null;
            if (_cfg != null && _saveWas != null) _cfg.GetType().GetProperty("SaveOnConfigSet")?.SetValue(_cfg, _saveWas, null);
            _cfg = null;
            if (_frames > 0) StudioBridgePlugin.Logger.LogInfo("Render: " + _frames + " frames, " + Math.Round(_captureMs / _frames, 1) + " ms each to capture");
        }

        /// <summary>A Screencap setting (a static ConfigEntry on its ScreenshotManager) — read, or set when value given.</summary>
        private static object Entry(string name)
        {
            var t = AccessTools.TypeByName("Screencap.ScreenshotManager");
            return t == null ? null : AccessTools.Property(t, name)?.GetValue(null, null);
        }

        private static object Screencap(string name, object value = null)
        {
            try
            {
                var entry = Entry(name);
                var prop = entry?.GetType().GetProperty("Value");
                if (prop == null) return null;
                if (value != null) prop.SetValue(entry, Convert.ChangeType(value, prop.PropertyType), null);
                return prop.GetValue(entry, null);
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogDebug("Screencap " + name + ": " + e.Message);
                return null;
            }
        }

        // ---------------- does the NVIDIA encoder work here? (a tiny test encode, once) ----------------

        /// <summary>null until known.</summary>
        public static bool? GpuWorks;
        private static bool _gpuTesting;

        public static void TestGpu(string ffmpeg)
        {
            if (GpuWorks != null || _gpuTesting || ffmpeg == null) return;
            _gpuTesting = true;
            new System.Threading.Thread(() =>
            {
                try
                {
                    var outFile = Path.Combine(Path.GetTempPath(), "kf-nvenc-test.mp4");
                    var psi = new ProcessStartInfo(ffmpeg, "-y -hide_banner -loglevel error -f lavfi -i testsrc2=size=256x256:rate=30 -t 0.2 -c:v h264_nvenc \"" + outFile + "\"")
                        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
                    using (var p = Process.Start(psi))
                    {
                        p.StandardOutput.ReadToEnd();
                        p.StandardError.ReadToEnd();
                        GpuWorks = p.WaitForExit(20000) && p.ExitCode == 0 && File.Exists(outFile);
                    }
                    try { File.Delete(outFile); } catch { }
                }
                catch { GpuWorks = false; }
            }) { IsBackground = true }.Start();
        }

        public static Dictionary<string, object> Stats() => new Dictionary<string, object>
        {
            { "patched", _patched && _patchError == null }, { "patchError", _patchError },
            { "encode", Encode }, { "draft", Draft }, { "gpu", GpuWorks },
            { "frames", _frames }, { "captureMsPerFrame", _frames > 0 ? Math.Round(_captureMs / _frames, 2) : 0.0 },
            { "jpg", Screencap("UseJpg") }, { "upsample", Screencap("DownscalingRate") },
        };
    }
}
