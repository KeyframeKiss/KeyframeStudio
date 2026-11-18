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
    /// Everything a bug report needs from the Studio side: versions, installed mods, which Studio EX features
    /// are on, and the recent log (this bridge's messages plus any mod's warnings and errors).
    /// </summary>
    internal static class DiagApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("diag.info", a => Info());
            r.Add("diag.log", a => RecentLog(a.GetInt("max", 300)));
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
