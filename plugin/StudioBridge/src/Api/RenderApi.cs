using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using BepInEx.Bootstrap;
using HarmonyLib;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Render and export through the installed VideoExport plugin (Joan6694) instead of rebuilding it: read and
    /// change its settings, start/stop a recording of the timeline, and report progress. Everything goes through
    /// reflection so nothing breaks if VideoExport is missing or changes (see Compat "render").
    /// Settings changed here apply to this session; VideoExport saves its own when its window changes them.
    /// </summary>
    internal static class RenderApi
    {
        public const string Guid = "com.joan6694.illusionplugins.videoexport";

        private static object Plugin => Chainloader.PluginInfos.TryGetValue(Guid, out var p) ? p.Instance : null;
        private static Type T => Plugin?.GetType();

        private static readonly string[] Fields =
        {
            "_fps", "_exportFps", "_limitDuration", "_selectedLimitDuration", "_limitDurationNumber", "_selectedExtension",
            "_resize", "_resizeX", "_resizeY", "_autoGenerateVideo", "_autoDeleteImages", "_prewarmLoopCount", "_isRecording",
            "_generatingVideo", "_currentRecordingFrame", "_recordingFrameLimit", "_currentMessage", "_progressBarPercentage",
            "_outputFolder", "_globalFramesFolder",
        };

        /// <summary>For Compat: null when every member used here exists.</summary>
        public static string Probe()
        {
            var t = T;
            if (t == null) return "not loaded";
            var missing = new List<string>();
            foreach (var f in Fields) if (AccessTools.Field(t, f) == null) missing.Add(f);
            if (AccessTools.Method(t, "RecordVideo") == null) missing.Add("RecordVideo");
            if (AccessTools.Method(t, "StopRecording") == null) missing.Add("StopRecording");
            return missing.Count == 0 ? null : "missing " + string.Join(", ", missing.ToArray());
        }

        /// <summary>Mix the scene's audio clips into rendered videos (Keyframe Studio's own; this session).</summary>
        public static bool WithAudio = true;

        public static int Warmups() => Plugin == null ? 0 : (int)Get("_prewarmLoopCount");

        /// <summary>
        /// Before recording, so hair and clothes physics have settled: off; quick (the 1.5 s leading into the start
        /// played, or held at the start — a second or two, whatever the length); play (the whole range played through
        /// first, VideoExport's warm-up count times — for seamless loops).
        /// </summary>
        public static string Warm = "quick";

        /// <summary>The speed settings (this session): warm, encode (balanced | small | gpu), draft.</summary>
        internal static void ApplySpeed(Dictionary<string, object> a)
        {
            if (a.GetString("frames") is string fr && (fr == "direct" || fr == "files")) DirectRender.Frames = fr;
            if (a.GetString("warm") is string w && (w == "off" || w == "quick" || w == "play")) Warm = w;
            if (a.GetString("encode") is string e && (e == "balanced" || e == "small" || e == "gpu")) RenderSpeed.Encode = e;
            if (a.Has("draft")) RenderSpeed.Draft = a.GetBool("draft");
        }

        public static void Register(CommandRouter r)
        {
            r.Add("render.status", a => Status());
            r.Add("render.set", a => { Apply(a); return Status(); });
            r.Add("render.start", a =>
            {
                if ((bool)Get("_isRecording")) throw new BridgeException("Already recording");
                RenderSpeed.EnsurePatched();
                Apply(a);
                // VideoExport only records the screen: in Seconds, Frames and no-limit modes it never starts the
                // timeline, and its Timeline mode doesn't play the current Timeline either (it records the right
                // number of frames of a still scene). So with Timeline installed, Keyframe Studio plays the timeline
                // while VideoExport records: the whole timeline from 0 (with the warm-up plays), or from the
                // playhead. Its Animation mode follows the characters' own animation and is left to it.
                bool limited = (bool)Get("_limitDuration");
                string mode = limited ? Get("_selectedLimitDuration").ToString() : "none";
                if (TimelineApi.Available && mode != "Animation")
                {
                    float dur = TimelineApi.Duration();
                    float n = Convert.ToSingle(Get("_limitDurationNumber"));
                    var versions = ShotApi.Versions(a);
                    bool useShots = a.GetBool("useShots", true); // the shots' cameras and transitions, when there are shots
                    if (mode == "Timeline")
                    {
                        ShotApi.StartRange(0f, dur, Warmups(), versions, useShots);
                        return Status();
                    }
                    float start = a.Has("from") ? a.GetFloat("from") : TimelineApi.PlaybackTime();
                    if (start >= dur - 0.01f) start = 0f; // at the end: from the start
                    float secs = mode == "Seconds" ? n : mode == "Frames" ? n / Math.Max(1, (int)Get("_fps")) : dur - start;
                    ShotApi.StartRange(start, secs, Warmups(), versions, useShots);
                    return Status();
                }
                AccessTools.Method(T, "RecordVideo").Invoke(Plugin, null);
                return Status();
            });
            // what VideoExport captures with (for diagnostics and tests)
            r.Add("render.capture", a => CaptureInfo());
            r.Add("render.stop", a => { Stop(); return Status(); });
        }

        /// <summary>Recording or encoding right now.</summary>
        public static bool Busy() => Plugin != null && ((bool)Get("_isRecording") || (bool)Get("_generatingVideo"));

        /// <summary>
        /// Stop VideoExport's recording — only while it records: its stop is a flag that stays set otherwise, and would
        /// cut the next recording off after its first frame (a Stop during a warm-up or a straight-to-video render).
        /// </summary>
        public static void Stop()
        {
            if (Plugin != null && (bool)Get("_isRecording")) AccessTools.Method(T, "StopRecording").Invoke(Plugin, null);
        }

        /// <summary>Record `seconds` from now (the caller plays the timeline). Null when started, else why not.</summary>
        public static string StartSeconds(float seconds)
        {
            if (Plugin == null) return "VideoExport is not installed";
            if (Busy()) return "VideoExport is busy";
            Apply(new Dictionary<string, object> { { "limit", "Seconds" }, { "limitNumber", (double)seconds } });
            RenderSpeed.EnsurePatched();
            AccessTools.Method(T, "RecordVideo").Invoke(Plugin, null);
            return null;
        }

        // ---------------- picture size: render at the size, never stretch ----------------

        /// <summary>The size settings (resize on/off, width, height), to put back after versions changed them.</summary>
        public static object[] SaveSizeSettings() => Plugin == null ? null : new[] { Get("_resize"), Get("_resizeX"), Get("_resizeY") };

        public static void RestoreSizeSettings(object[] s)
        {
            if (s == null || Plugin == null) return;
            Set("_resize", s[0]);
            Set("_resizeX", s[1]);
            Set("_resizeY", s[2]);
        }

        /// <summary>A version's size: {width, height}; 0 (or missing) = no size (Screencap's own, or the window).</summary>
        public static void UseSize(Dictionary<string, object> v)
        {
            int w = v.GetInt("width", 0), h = v.GetInt("height", 0);
            if (w >= 16 && h >= 16)
            {
                Set("_resize", true);
                Set("_resizeX", w);
                Set("_resizeY", h);
            }
            else Set("_resize", false);
        }

        /// <summary>Rename a finished video to "<its name> <suffix>" (characters Windows forbids are dropped); the new path.</summary>
        public static string NameVideo(string video, string suffix)
        {
            try
            {
                foreach (var c in Path.GetInvalidFileNameChars()) suffix = suffix.Replace(c.ToString(), "");
                string dir = Path.GetDirectoryName(video), ext = Path.GetExtension(video), stem = Path.GetFileNameWithoutExtension(video) + " " + suffix.Trim();
                var dest = Path.Combine(dir, stem + ext);
                for (int n = 2; File.Exists(dest); n++) dest = Path.Combine(dir, stem + " (" + n + ")" + ext);
                File.Move(video, dest);
                return dest;
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("Render: couldn't name " + video + ": " + e.Message);
                return video;
            }
        }

        /// <summary>What PrepareSize changed, to put back; Crop set when the video still needs cutting to shape.</summary>
        public sealed class SizeState
        {
            public object Selected, Resize, OldX, OldY, Shot;
            public int CropW, CropH;
        }

        private static object Screencap(out int index)
        {
            index = -1;
            if (!(Get("_screenshotPlugins") is IList list)) return null;
            for (int i = 0; i < list.Count; i++)
                if (list[i] != null && list[i].GetType().Name.IndexOf("Screencap", StringComparison.OrdinalIgnoreCase) >= 0) { index = i; return list[i]; }
            return null;
        }

        /// <summary>A size setting on VideoExport's Screencap capture: a plain int or a ConfigEntry&lt;int&gt;.</summary>
        private static object SizeValue(object owner, string field, object set = null)
        {
            var fi = AccessTools.Field(owner.GetType(), field);
            if (fi == null) return null;
            var v = fi.GetValue(fi.IsStatic ? null : owner);
            var prop = v?.GetType().GetProperty("Value");
            if (prop != null)
            {
                var old = prop.GetValue(v, null);
                if (set != null) prop.SetValue(v, Convert.ChangeType(set, prop.PropertyType), null);
                return old;
            }
            if (set != null) fi.SetValue(fi.IsStatic ? null : owner, Convert.ChangeType(set, fi.FieldType));
            return v;
        }

        private static void SetLoose(string f, object v)
        {
            var fi = AccessTools.Field(T, f);
            fi.SetValue(fi.IsStatic ? null : Plugin, Convert.ChangeType(v, fi.FieldType));
        }

        /// <summary>
        /// VideoExport's "resize" stretches the window's frames to the size, so another shape (vertical, square) comes
        /// out squished. With a size set, record through Screencap at exactly that size instead (the camera frames the
        /// shape itself, at full sharpness), with VideoExport's stretch off. Without Screencap: record the window and
        /// cut the middle to shape afterwards (Crop). Null when nothing needed changing.
        /// </summary>
        public static SizeState PrepareSize()
        {
            if (Plugin == null || !(bool)Get("_resize")) return null;
            int w = (int)Get("_resizeX"), h = (int)Get("_resizeY");
            var st = new SizeState { Resize = Get("_resize"), Selected = Get("_selectedPlugin") };
            var shot = Screencap(out int index);
            if (shot != null && AccessTools.Field(shot.GetType(), "_resolutionX") != null)
            {
                st.Shot = shot;
                st.OldX = SizeValue(shot, "_resolutionX", w);
                st.OldY = SizeValue(shot, "_resolutionY", h);
                SetLoose("_selectedPlugin", index);
                Set("_resize", false);
                return st;
            }
            float window = (float)Screen.width / Math.Max(1, Screen.height), target = (float)w / Math.Max(1, h);
            if (Math.Abs(window - target) < 0.01f) return null; // same shape: VideoExport's own scaling is right
            Set("_resize", false);
            st.CropW = w;
            st.CropH = h;
            return st;
        }

        public static void RestoreSize(SizeState st)
        {
            if (st == null || Plugin == null) return;
            if (st.Shot != null)
            {
                SizeValue(st.Shot, "_resolutionX", st.OldX);
                SizeValue(st.Shot, "_resolutionY", st.OldY);
            }
            SetLoose("_selectedPlugin", st.Selected);
            Set("_resize", st.Resize);
        }

        private static object CaptureInfo()
        {
            if (Plugin == null) throw new BridgeException("VideoExport is not installed");
            var list = Get("_screenshotPlugins") as IList;
            var shot = Screencap(out int index);
            return new Dictionary<string, object>
            {
                { "plugins", list == null ? new List<object>() : list.Cast<object>().Select(p => (object)(p?.GetType().Name ?? "?")).ToList() },
                { "selected", Convert.ToInt32(Get("_selectedPlugin")) },
                { "screencap", index },
                { "screencapSize", shot == null ? null : (object)new List<object> { SizeValue(shot, "_resolutionX"), SizeValue(shot, "_resolutionY") } },
                { "window", new List<object> { Screen.width, Screen.height } },
            };
        }

        /// <summary>The video VideoExport wrote since `since` (null when it only kept the frames).</summary>
        public static string NewestVideo(DateTime since)
        {
            if (Plugin == null || !(bool)Get("_autoGenerateVideo")) return null;
            var dir = Get("_outputFolder") as string;
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return null;
            return new DirectoryInfo(dir).GetFiles()
                .Where(f => f.LastWriteTime >= since.AddSeconds(-2) && new[] { ".mp4", ".webm", ".avi" }.Contains(f.Extension.ToLowerInvariant()))
                .OrderByDescending(f => f.LastWriteTime)
                .Select(f => f.FullName)
                .FirstOrDefault();
        }

        // ---------------- what straight-to-video renders take from VideoExport's settings ----------------

        internal static string Format() => Plugin == null ? "MP4" : Get("_selectedExtension").ToString();
        internal static int Fps() => Plugin == null ? 30 : (int)Get("_fps");
        internal static bool AutoEncode() => Plugin != null && (bool)Get("_autoGenerateVideo");
        internal static string OutputFolder() => Get("_outputFolder") as string ?? Path.Combine(BepInEx.Paths.GameRootPath, "UserData\\VideoExport\\Output");
        internal static bool DynamicBonesEveryFrame() => Plugin != null && AccessTools.Field(T, "_selectedUpdateDynamicBones")?.GetValue(Plugin)?.ToString() == "EveryFrame";

        /// <summary>An encoder's quality setting in VideoExport (its x264 CRF, its VP9 CRF).</summary>
        private static int ExtQuality(int index, int fallback)
        {
            try
            {
                if (Get("_extensions") is IList list && list.Count > index && list[index] != null)
                {
                    var f = AccessTools.Field(list[index].GetType(), "_quality");
                    if (f != null) return Convert.ToInt32(f.GetValue(list[index]));
                }
            }
            catch { }
            return fallback;
        }
        internal static int Mp4Quality() => Mathf.Clamp(ExtQuality(0, 18), 0, 51);
        internal static int WebmQuality() => Mathf.Clamp(ExtQuality(1, 15) * 2, 4, 63);

        /// <summary>The video's size: the size set, else Screencap's (when VideoExport records through it), else the window.</summary>
        internal static int[] DirectSize()
        {
            if (Plugin != null && (bool)Get("_resize")) return new[] { Math.Max(16, (int)Get("_resizeX")), Math.Max(16, (int)Get("_resizeY")) };
            int index = -1;
            var shot = Plugin != null ? Screencap(out index) : null;
            if (shot != null && Convert.ToInt32(Get("_selectedPlugin")) == index && SizeValue(shot, "_resolutionX") is object x && SizeValue(shot, "_resolutionY") is object y)
                return new[] { Convert.ToInt32(x), Convert.ToInt32(y) };
            return new[] { Screen.width, Screen.height };
        }

        /// <summary>VideoExport's own ffmpeg.</summary>
        internal static string Ffmpeg()
        {
            // VideoExport.dll sits in plugins (or its own folder); its ffmpeg is in VideoExport/ffmpeg
            var dir = Path.GetDirectoryName(T.Assembly.Location);
            string name = IntPtr.Size == 8 ? "ffmpeg-64.exe" : "ffmpeg.exe";
            foreach (var d in new[] { Path.Combine(dir, "ffmpeg"), Path.Combine(Path.Combine(dir, "VideoExport"), "ffmpeg"), Path.Combine(Path.Combine(BepInEx.Paths.PluginPath, "VideoExport"), "ffmpeg") })
            {
                var exe = Path.Combine(d, name);
                if (File.Exists(exe)) return exe;
            }
            return null;
        }

        /// <summary>
        /// Mix the clips into the video (in place): each clip where it plays on the timeline relative to the render's
        /// start, at its volume, cut to the video's length. Runs ffmpeg (call it off the main thread). Null when done,
        /// else why not.
        /// </summary>
        public static string MixAudio(string video, List<AudioTrack.RenderClip> clips, float start, float seconds, int cropW = 0, int cropH = 0)
        {
            var ffmpeg = Ffmpeg();
            if (ffmpeg == null) return "VideoExport's ffmpeg wasn't found";
            string ext = Path.GetExtension(video).ToLowerInvariant();
            string codec = ext == ".webm" ? "libopus -b:a 160k" : ext == ".avi" ? "libmp3lame -b:a 192k" : "aac -b:a 192k";
            clips = clips ?? new List<AudioTrack.RenderClip>();
            // cut the middle to the size's shape, then scale (only when it couldn't be rendered at the size)
            string vf = null, vcodec = "copy";
            if (cropW > 0 && cropH > 0)
            {
                vf = "crop='min(iw,ih*" + cropW + "/" + cropH + ")':'min(ih,iw*" + cropH + "/" + cropW + ")',scale=" + cropW + ":" + cropH + ":flags=lanczos,setsar=1";
                vcodec = ext == ".webm" ? "libvpx-vp9 -crf 30 -b:v 0" : ext == ".avi" ? "mpeg4 -q:v 2" : RenderSpeed.CropCodec();
            }
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            var args = new System.Text.StringBuilder("-y -hide_banner -loglevel error -i \"" + video + "\"");
            var filter = new System.Text.StringBuilder();
            for (int i = 0; i < clips.Count; i++)
            {
                var c = clips[i];
                args.Append(" -i \"" + c.Path + "\"");
                float rel = c.Offset - start; // where the clip starts in the video
                filter.Append("[" + (i + 1) + ":a]");
                // the clip as it plays: trims, speed (pitch follows, as in Studio), balance, fades
                filter.Append("atrim=start=" + c.TrimIn.ToString("0.###", inv) + ":end=" + (c.Length - c.TrimOut).ToString("0.###", inv) + ",asetpts=PTS-STARTPTS,");
                if (Math.Abs(c.Speed - 1f) > 0.001f) filter.Append("asetrate=" + Math.Round(c.Rate * c.Speed).ToString(inv) + ",aresample=" + c.Rate.ToString(inv) + ",");
                float l = c.Pan > 0 ? 1f - c.Pan : 1f, r = c.Pan < 0 ? 1f + c.Pan : 1f;
                filter.Append("aformat=channel_layouts=stereo,pan=stereo|c0=" + l.ToString("0.###", inv) + "*c0|c1=" + r.ToString("0.###", inv) + "*c1,");
                if (c.FadeIn > 0.001f) filter.Append("afade=t=in:st=0:d=" + c.FadeIn.ToString("0.###", inv) + ",");
                if (c.FadeOut > 0.001f) filter.Append("afade=t=out:st=" + Math.Max(0f, c.Span - c.FadeOut).ToString("0.###", inv) + ":d=" + c.FadeOut.ToString("0.###", inv) + ",");
                if (rel >= 0) filter.Append("adelay=" + ((int)Math.Round(rel * 1000)).ToString(inv) + ":all=1,");
                else filter.Append("atrim=start=" + (-rel).ToString("0.###", inv) + ",asetpts=PTS-STARTPTS,");
                filter.Append("volume=" + c.Volume.ToString("0.###", inv) + "[a" + i + "];");
            }
            for (int i = 0; i < clips.Count; i++) filter.Append("[a" + i + "]");
            if (clips.Count > 0)
            {
                filter.Append(clips.Count > 1 ? "amix=inputs=" + clips.Count + ":normalize=0:dropout_transition=0," : "anull,");
                filter.Append("atrim=end=" + seconds.ToString("0.###", inv) + "[aout]");
            }
            if (vf != null) filter.Append((clips.Count > 0 ? ";" : "") + "[0:v]" + vf + "[vout]");
            var tmp = Path.Combine(Path.GetDirectoryName(video), Path.GetFileNameWithoutExtension(video) + ".finished" + ext);
            args.Append(" -filter_complex \"" + filter + "\" -map " + (vf != null ? "\"[vout]\"" : "0:v") + (clips.Count > 0 ? " -map \"[aout]\" -c:a " + codec : "") + " -c:v " + vcodec + " \"" + tmp + "\"");
            var psi = new ProcessStartInfo(ffmpeg, args.ToString()) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            using (var p = Process.Start(psi))
            {
                p.StandardOutput.ReadToEnd();
                string errText = p.StandardError.ReadToEnd();
                if (!p.WaitForExit(300000)) { try { p.Kill(); } catch { } return "ffmpeg took too long"; }
                if (p.ExitCode != 0 || !File.Exists(tmp))
                {
                    if (File.Exists(tmp)) File.Delete(tmp);
                    return "ffmpeg: " + (errText.Trim().Length > 0 ? errText.Trim() : "exit code " + p.ExitCode);
                }
            }
            File.Delete(video);
            File.Move(tmp, video);
            return null;
        }

        /// <summary>The length settings (mode and number), to put back after a render that had to change them.</summary>
        public static object[] SaveLimit() => Plugin == null ? null : new[] { Get("_limitDuration"), Get("_selectedLimitDuration"), Get("_limitDurationNumber") };

        public static void RestoreLimit(object[] saved)
        {
            if (saved == null || Plugin == null || Busy()) return;
            Set("_limitDuration", saved[0]);
            Set("_selectedLimitDuration", saved[1]);
            Set("_limitDurationNumber", saved[2]);
        }

        private static object Get(string f) => AccessTools.Field(T, f).GetValue(AccessTools.Field(T, f).IsStatic ? null : Plugin);
        private static void Set(string f, object v)
        {
            var fi = AccessTools.Field(T, f);
            fi.SetValue(fi.IsStatic ? null : Plugin, v);
        }

        private static string[] EnumNames(string field) => Enum.GetNames(AccessTools.Field(T, field).FieldType);

        private static object Status()
        {
            if (Plugin == null) throw new BridgeException("VideoExport is not installed");
            RenderSpeed.TestGpu(Ffmpeg()); // once, in the background: whether the GPU encoder can be offered
            return new Dictionary<string, object>
            {
                { "recording", DirectRender.Recording || (bool)Get("_isRecording") },
                { "encoding", DirectRender.Finishing || (bool)Get("_generatingVideo") },
                { "frame", DirectRender.Recording ? DirectRender.Frame : Get("_currentRecordingFrame") },
                { "frameLimit", DirectRender.Recording ? DirectRender.FrameLimit : Get("_recordingFrameLimit") },
                { "message", DirectRender.Finishing ? "Finishing the video" : Get("_currentMessage") as string ?? "" },
                { "progress", DirectRender.Recording ? (double)DirectRender.Frame / Math.Max(1, DirectRender.FrameLimit) : Convert.ToDouble(Get("_progressBarPercentage")) },
                { "outputFolder", Get("_outputFolder") as string ?? "" },
                { "framesFolder", Get("_globalFramesFolder") as string ?? "" },
                { "settings", new Dictionary<string, object>
                    {
                        { "fps", Get("_fps") }, { "exportFps", Get("_exportFps") },
                        { "limit", (bool)Get("_limitDuration") ? Get("_selectedLimitDuration").ToString() : "none" },
                        { "limitNumber", Convert.ToDouble(Get("_limitDurationNumber")) },
                        { "format", Get("_selectedExtension").ToString() },
                        { "resize", Get("_resize") }, { "width", Get("_resizeX") }, { "height", Get("_resizeY") },
                        { "autoEncode", Get("_autoGenerateVideo") }, { "deleteFrames", Get("_autoDeleteImages") },
                        { "prewarm", Get("_prewarmLoopCount") },
                        { "audio", WithAudio },
                        { "warm", Warm }, { "encode", RenderSpeed.Encode }, { "draft", RenderSpeed.Draft }, { "frames", DirectRender.Frames },
                    }
                },
                { "gpuEncode", RenderSpeed.GpuWorks },
                { "limits", EnumNames("_selectedLimitDuration") },
                { "formats", EnumNames("_selectedExtension") },
            };
        }

        /// <summary>args (all optional): fps, exportFps, limit (none|Frames|Seconds|Animation|Timeline), limitNumber,
        /// format (MP4|WEBM|GIF|AVI), resize, width, height, autoEncode, deleteFrames, prewarm</summary>
        private static void Apply(Dictionary<string, object> a)
        {
            if (Plugin == null) throw new BridgeException("VideoExport is not installed");
            if ((bool)Get("_isRecording")) throw new BridgeException("Recording — stop it first");
            if (a.Has("fps")) Set("_fps", Math.Max(1, Math.Min(120, a.GetInt("fps"))));
            if (a.Has("exportFps")) Set("_exportFps", Math.Max(1, Math.Min((int)Get("_fps"), a.GetInt("exportFps"))));
            else if (a.Has("fps")) Set("_exportFps", Get("_fps"));
            if (a.Has("limit"))
            {
                string l = a.GetString("limit");
                if (l == "none") Set("_limitDuration", false);
                else
                {
                    var ft = AccessTools.Field(T, "_selectedLimitDuration").FieldType;
                    if (Array.IndexOf(Enum.GetNames(ft), l) < 0) throw new BridgeException("Unknown length mode: " + l);
                    Set("_limitDuration", true);
                    Set("_selectedLimitDuration", Enum.Parse(ft, l));
                }
            }
            if (a.Has("limitNumber")) Set("_limitDurationNumber", Math.Max(0f, a.GetFloat("limitNumber")));
            // in Timeline mode the number is how many times the timeline plays: 0 would record nothing
            if ((bool)Get("_limitDuration") && Get("_selectedLimitDuration").ToString() == "Timeline" && Convert.ToSingle(Get("_limitDurationNumber")) < 1f)
                Set("_limitDurationNumber", 1f);
            if (a.Has("format"))
            {
                var ft = AccessTools.Field(T, "_selectedExtension").FieldType;
                string f = a.GetString("format");
                if (Array.IndexOf(Enum.GetNames(ft), f) < 0) throw new BridgeException("Unknown format: " + f);
                Set("_selectedExtension", Enum.Parse(ft, f));
            }
            if (a.Has("resize")) Set("_resize", a.GetBool("resize"));
            if (a.Has("width")) Set("_resizeX", Math.Max(16, a.GetInt("width")));
            if (a.Has("height")) Set("_resizeY", Math.Max(16, a.GetInt("height")));
            if (a.Has("autoEncode")) Set("_autoGenerateVideo", a.GetBool("autoEncode"));
            if (a.Has("deleteFrames")) Set("_autoDeleteImages", a.GetBool("deleteFrames"));
            if (a.Has("prewarm")) Set("_prewarmLoopCount", Math.Max(0, Math.Min(10, a.GetInt("prewarm"))));
            if (a.Has("audio")) WithAudio = a.GetBool("audio");
            ApplySpeed(a);
        }
    }
}
