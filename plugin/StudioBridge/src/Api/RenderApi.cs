using System;
using System.Collections.Generic;
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

        public static void Register(CommandRouter r)
        {
            r.Add("render.status", a => Status());
            r.Add("render.set", a => { Apply(a); return Status(); });
            r.Add("render.start", a =>
            {
                if ((bool)Get("_isRecording")) throw new BridgeException("Already recording");
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
                    if (mode == "Timeline")
                    {
                        ShotApi.StartRange(0f, dur, (int)Get("_prewarmLoopCount"));
                        return Status();
                    }
                    float start = a.Has("from") ? a.GetFloat("from") : TimelineApi.PlaybackTime();
                    if (start >= dur - 0.01f) start = 0f; // at the end: from the start
                    float secs = mode == "Seconds" ? n : mode == "Frames" ? n / Math.Max(1, (int)Get("_fps")) : dur - start;
                    ShotApi.StartRange(start, secs);
                    return Status();
                }
                AccessTools.Method(T, "RecordVideo").Invoke(Plugin, null);
                return Status();
            });
            r.Add("render.stop", a => { AccessTools.Method(T, "StopRecording").Invoke(Plugin, null); return Status(); });
        }

        /// <summary>Recording or encoding right now.</summary>
        public static bool Busy() => Plugin != null && ((bool)Get("_isRecording") || (bool)Get("_generatingVideo"));

        public static void Stop()
        {
            if (Plugin != null) AccessTools.Method(T, "StopRecording").Invoke(Plugin, null);
        }

        /// <summary>Record `seconds` from now (the caller plays the timeline). Null when started, else why not.</summary>
        public static string StartSeconds(float seconds)
        {
            if (Plugin == null) return "VideoExport is not installed";
            if (Busy()) return "VideoExport is busy";
            Apply(new Dictionary<string, object> { { "limit", "Seconds" }, { "limitNumber", (double)seconds } });
            AccessTools.Method(T, "RecordVideo").Invoke(Plugin, null);
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
            return new Dictionary<string, object>
            {
                { "recording", Get("_isRecording") },
                { "encoding", Get("_generatingVideo") },
                { "frame", Get("_currentRecordingFrame") },
                { "frameLimit", Get("_recordingFrameLimit") },
                { "message", Get("_currentMessage") as string ?? "" },
                { "progress", Convert.ToDouble(Get("_progressBarPercentage")) },
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
                    }
                },
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
        }
    }
}
