using System;
using System.Collections.Generic;
using System.Reflection;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Request:  {"id": 7, "cmd": "timeline.seek", "args": {"t": 1.5}}
    /// Response: {"id": 7, "ok": true, "result": ...}  |  {"id": 7, "ok": false, "error": "..."}
    /// Event:    {"event": "timeline.tick", "data": ...}   (server push, no id)
    /// </summary>
    public sealed class CommandRouter
    {
        private readonly Dictionary<string, Func<Dictionary<string, object>, object>> _handlers =
            new Dictionary<string, Func<Dictionary<string, object>, object>>();

        public void Add(string cmd, Func<Dictionary<string, object>, object> handler) => _handlers[cmd] = handler;

        public IEnumerable<string> Commands => _handlers.Keys;

        public string Handle(string raw)
        {
            object id = null;
            try
            {
                var req = Json.Parse(raw) as Dictionary<string, object>;
                if (req == null) throw new BridgeException("Request must be a JSON object");
                req.TryGetValue("id", out id);
                string cmd = req.GetString("cmd");
                // a feature switched off for compatibility answers with the reason (not "unknown command")
                var blocked = cmd == null ? null : Compat.BlockReason(cmd);
                if (blocked != null) throw new BridgeException(blocked);
                if (cmd == null || !_handlers.TryGetValue(cmd, out var handler))
                    throw new BridgeException("Unknown command: " + cmd);
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var result = handler(req.GetObject("args") ?? new Dictionary<string, object>());
                var json = Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } });
                // anything that stalls Studio's frame noticeably is worth knowing about (shows in Copy diagnostics)
                if (sw.ElapsedMilliseconds > 50) StudioBridgePlugin.Logger.LogInfo("Slow command " + cmd + ": " + sw.ElapsedMilliseconds + " ms (" + json.Length / 1024 + " KB)");
                return json;
            }
            catch (Exception e)
            {
                if (e is TargetInvocationException tie && tie.InnerException != null) e = tie.InnerException;
                if (!(e is BridgeException))
                    StudioBridgePlugin.Logger.LogWarning("Command failed: " + (raw.Length > 500 ? raw.Substring(0, 500) + "..." : raw) + "\n" + e);
                return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", e.Message } });
            }
        }
    }

    /// <summary>Expected, user-facing failure (bad args, missing object). Not logged as a stack trace.</summary>
    public sealed class BridgeException : Exception
    {
        public BridgeException(string msg) : base(msg) { }
    }

    internal static class CoreApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("hello", a => new Dictionary<string, object>
            {
                { "plugin", StudioBridgePlugin.Version },
                { "protocol", StudioBridgePlugin.ProtocolVersion },
                { "game", "Koikatsu CharaStudio" },
                { "unity", UnityEngine.Application.unityVersion },
                { "timeline", TimelineApi.Available },
                { "translator", Translation.Available },
                { "features", Compat.Report() },
                { "paths", DiagApi.Paths() },
                { "commands", new List<string>(r.Commands) },
            });
            r.Add("ping", a => a.GetDouble("t"));
        }
    }
}
