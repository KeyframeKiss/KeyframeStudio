using System;
using System.Collections.Generic;
using System.Linq;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Logging;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Everything a bug report needs from the Studio side: versions, installed mods, which Keyframe Studio features
    /// are on, and the recent log (this bridge's messages plus any mod's warnings and errors).
    /// </summary>
    internal static class DiagApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("diag.info", a => Info());
            r.Add("diag.log", a => RecentLog(a.GetInt("max", 300)));
            r.Add("diag.lighting", a => Lighting(a));
        }

        public static void Install()
        {
            if (!Logger.Listeners.Contains(Ring)) Logger.Listeners.Add(Ring);
        }

        public static Dictionary<string, object> Paths() => new Dictionary<string, object>
        {
            { "game", BepInEx.Paths.GameRootPath },
            { "userData", System.IO.Path.Combine(BepInEx.Paths.GameRootPath, "UserData") },
            { "bepinexLog", System.IO.Path.Combine(BepInEx.Paths.BepInExRootPath, "LogOutput.log") },
        };

        /// <summary>
        /// Why a light does or doesn't reach a character: the quality's per-pixel light budget, each light's settings
        /// (type, range, layers it lights, render mode), and which character shaders have a pass for extra lights.
        /// </summary>
        private static object Lighting(Dictionary<string, object> a)
        {
            var lights = new List<object>();
            foreach (var l in UnityEngine.Object.FindObjectsOfType<UnityEngine.Light>())
                lights.Add(new Dictionary<string, object>
                {
                    { "name", l.name }, { "type", l.type.ToString() }, { "enabled", l.enabled && l.gameObject.activeInHierarchy },
                    { "intensity", (double)l.intensity }, { "range", (double)l.range }, { "spot", (double)l.spotAngle },
                    { "color", new List<object> { (double)l.color.r, (double)l.color.g, (double)l.color.b } },
                    { "mask", l.cullingMask }, { "litChara", (l.cullingMask & (1 << 10)) != 0 }, { "renderMode", l.renderMode.ToString() },
                    { "shadows", l.shadows.ToString() }, { "layer", l.gameObject.layer },
                    { "pos", new List<object> { (double)l.transform.position.x, (double)l.transform.position.y, (double)l.transform.position.z } },
                });
            var shaders = new Dictionary<string, object>();
            var getPass = typeof(UnityEngine.Material).GetMethod("GetPassName", new[] { typeof(int) });
            foreach (var r in UnityEngine.Object.FindObjectsOfType<UnityEngine.Renderer>())
            {
                if (r.gameObject.layer != 10) continue; // characters
                foreach (var m in r.sharedMaterials)
                {
                    if (m == null || m.shader == null || shaders.ContainsKey(m.shader.name)) continue;
                    var passes = new List<object>();
                    try { for (int i = 0; i < m.passCount; i++) passes.Add(getPass != null ? getPass.Invoke(m, new object[] { i }) : i.ToString()); } catch { }
                    shaders[m.shader.name] = new Dictionary<string, object> { { "passes", passes }, { "queue", m.renderQueue } };
                }
            }
            // named shaders' passes (e.g. xukmi/SkinPlus), whether used here or not
            var named = new Dictionary<string, object>();
            var want = new HashSet<string>((a.GetList("shaders") ?? new List<object>()).Select(x => Convert.ToString(x)));
            if (want.Count > 0)
                foreach (var sh in UnityEngine.Resources.FindObjectsOfTypeAll<UnityEngine.Shader>())
                {
                    if (sh == null || !want.Contains(sh.name) || named.ContainsKey(sh.name)) continue;
                    var m = new UnityEngine.Material(sh);
                    var passes = new List<object>();
                    try { for (int i = 0; i < m.passCount; i++) passes.Add(getPass != null ? getPass.Invoke(m, new object[] { i }) : i.ToString()); } catch { }
                    UnityEngine.Object.Destroy(m);
                    named[sh.name] = passes;
                }
            var cam = UnityEngine.Camera.main;
            return new Dictionary<string, object>
            {
                { "named", named },
                { "pixelLightCount", UnityEngine.QualitySettings.pixelLightCount }, { "quality", UnityEngine.QualitySettings.GetQualityLevel() },
                { "renderingPath", cam != null ? cam.actualRenderingPath.ToString() : null }, { "camMask", cam != null ? cam.cullingMask : 0 },
                { "lights", lights }, { "charaShaders", shaders }, { "charaLayers", CharaLayers() },
                { "ambient", new Dictionary<string, object>
                    {
                        { "mode", UnityEngine.RenderSettings.ambientMode.ToString() }, { "intensity", (double)UnityEngine.RenderSettings.ambientIntensity },
                        { "light", Rgb(UnityEngine.RenderSettings.ambientLight) }, { "sky", Rgb(UnityEngine.RenderSettings.ambientSkyColor) },
                        { "equator", Rgb(UnityEngine.RenderSettings.ambientEquatorColor) }, { "ground", Rgb(UnityEngine.RenderSettings.ambientGroundColor) },
                        { "reflection", (double)UnityEngine.RenderSettings.reflectionIntensity }, { "skybox", UnityEngine.RenderSettings.skybox != null ? UnityEngine.RenderSettings.skybox.name : null },
                    } },
                { "cameras", UnityEngine.Camera.allCameras.Select(c => (object)new Dictionary<string, object> { { "name", c.name }, { "mask", c.cullingMask }, { "depth", (double)c.depth }, { "main", c == cam } }).ToList() },
            };
        }

        private static List<object> Rgb(UnityEngine.Color c) => new List<object> { (double)c.r, (double)c.g, (double)c.b };

        /// <summary>Per character: how many of its renderers sit on each layer (and which shaders), shown or not.</summary>
        private static object CharaLayers()
        {
            var list = new List<object>();
            foreach (var cha in UnityEngine.Object.FindObjectsOfType<ChaControl>())
            {
                var layers = new Dictionary<string, object>();
                foreach (var r in cha.GetComponentsInChildren<UnityEngine.Renderer>(true))
                {
                    string k = r.gameObject.layer + (r.enabled && r.gameObject.activeInHierarchy ? "" : " (hidden)") + " " + r.GetType().Name;
                    layers[k] = (layers.TryGetValue(k, out var n) ? (int)n : 0) + 1;
                }
                list.Add(new Dictionary<string, object> { { "name", cha.name }, { "layer", cha.gameObject.layer }, { "renderers", layers } });
            }
            return list;
        }

        private static Dictionary<string, object> Info()
        {
            var studio = Singleton<Studio.Studio>.Instance;
            int objects = studio != null ? studio.dicObjectCtrl.Count : 0;
            return new Dictionary<string, object>
            {
                { "plugin", StudioBridgePlugin.Version },
                { "protocol", StudioBridgePlugin.ProtocolVersion },
                { "bepinex", typeof(BaseUnityPlugin).Assembly.GetName().Version.ToString() },
                { "unity", UnityEngine.Application.unityVersion },
                { "os", Environment.OSVersion.ToString() },
                { "paths", Paths() },
                { "features", Compat.Report() },
                { "scene", new Dictionary<string, object> { { "objects", objects }, { "fps", Math.Round(1f / UnityEngine.Mathf.Max(1e-4f, UnityEngine.Time.smoothDeltaTime), 1) } } },
                { "bridgeFrame", new Dictionary<string, object> { { "avg", Math.Round(StudioBridgePlugin.FrameMs, 2) }, { "max30s", Math.Round(StudioBridgePlugin.FrameMaxMs, 2) } } },
                { "changeScan", new Dictionary<string, object> { { "last", Math.Round(EventPump.ScanMs, 2) }, { "avg", Math.Round(EventPump.ScanAvgMs, 2) }, { "max30s", Math.Round(EventPump.ScanMaxMs, 2) } } },
                { "plugins", Chainloader.PluginInfos.Values
                    .OrderBy(p => p.Metadata.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(p => (object)new Dictionary<string, object> { { "guid", p.Metadata.GUID }, { "name", p.Metadata.Name }, { "version", p.Metadata.Version.ToString() } })
                    .ToList() },
            };
        }

        private static List<object> RecentLog(int max)
        {
            lock (Ring.Lines)
                return Ring.Lines.Skip(Math.Max(0, Ring.Lines.Count - max)).Cast<object>().ToList();
        }

        private static readonly RingListener Ring = new RingListener();

        /// <summary>Keeps the last few hundred relevant log lines in memory.</summary>
        private sealed class RingListener : ILogListener
        {
            public readonly List<string> Lines = new List<string>();
            private const int Max = 400;

            public void LogEvent(object sender, LogEventArgs e)
            {
                try
                {
                    bool mine = e.Source != null && e.Source.SourceName == StudioBridgePlugin.Name;
                    bool problem = (e.Level & (LogLevel.Fatal | LogLevel.Error | LogLevel.Warning)) != 0;
                    if (!mine && !problem) return;
                    var text = DateTime.Now.ToString("HH:mm:ss") + " [" + e.Level + ":" + (e.Source?.SourceName ?? "?") + "] " + e.Data;
                    if (text.Length > 2000) text = text.Substring(0, 2000) + "…";
                    lock (Lines)
                    {
                        Lines.Add(text);
                        if (Lines.Count > Max) Lines.RemoveRange(0, Lines.Count - Max);
                    }
                }
                catch { }
            }

            public void Dispose() { }
        }
    }
}
