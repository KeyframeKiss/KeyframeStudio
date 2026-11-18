using System;
using System.Collections.Generic;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using StudioEX.Bridge.Api;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge
{
    [BepInPlugin(GUID, Name, Version)]
    [BepInProcess("CharaStudio")]
    [BepInDependency(TimelineGuid, BepInDependency.DependencyFlags.SoftDependency)]
    public class StudioBridgePlugin : BaseUnityPlugin
    {
        public const string GUID = "studioex.bridge";
        public const string Name = "Keyframe Studio Bridge";
        public const string Version = "0.1.0";
        public const int ProtocolVersion = 1;
        internal const string TimelineGuid = "com.joan6694.illusionplugins.timeline";

        internal static StudioBridgePlugin Instance;
        internal static new ManualLogSource Logger;

        private ConfigEntry<int> _port;
        private WebSocketServer _server;
        private readonly CommandRouter _router = new CommandRouter();
        private readonly Queue<KeyValuePair<WsClient, string>> _inbox = new Queue<KeyValuePair<WsClient, string>>();
        private readonly Queue<string> _logQueue = new Queue<string>();

        private EventPump _events;

        private void Awake()
        {
            Instance = this;
            Logger = base.Logger;
            DiagApi.Install(); // keep recent log lines for "Copy diagnostics"
            _port = Config.Bind("Connection", "Port", 47615, "Local WebSocket port the Keyframe Studio app connects to (127.0.0.1 only).");

            gameObject.AddComponent<ViewportTools>();
            ViewportTools.Register(_router);
            gameObject.AddComponent<FaceBaker>();
            gameObject.AddComponent<PoseThumbs>();
            PoseThumbs.Register(_router);
            LibraryMeta.Register(_router);
            LightRigs.Register(_router);
            PresetStore.Register(_router);
            gameObject.AddComponent<MotionSampler>();
            MotionSampler.Register(_router);
            gameObject.AddComponent<PreviewStream>(); // experimental live preview (roadmap Phase 3 spike)
            PreviewStream.Register(_router);
            CoreApi.Register(_router);
            DiagApi.Register(_router);
            UndoStack.Register(_router);
            ObjectApi.Register(_router);
            CameraApi.Register(_router);
            ConfigApi.Register(_router);
            LookApi.Register(_router);
            MaterialLookApi.Register(_router);
            SceneApi.Register(_router);
            TimelineApi.Register(_router);
            CharaApi.Register(_router);
            AbmxApi.Register(_router);
            PoseApi.Register(_router);
            FaceApi.Register(_router);
            ExpressionApi.Register(_router);
            Translation.Register(_router);
            _events = new EventPump(Broadcast);
            HarmonyLib.Harmony.CreateAndPatchAll(typeof(Hooks), GUID);

            try
            {
                _server = new WebSocketServer(_port.Value);
                _server.MessageReceived += (c, m) => { lock (_inbox) _inbox.Enqueue(new KeyValuePair<WsClient, string>(c, m)); };
                _server.ClientConnected += c => Enqueue("Keyframe Studio app connected (#" + c.Id + ")");
                _server.ClientDisconnected += c => Enqueue("Keyframe Studio app disconnected (#" + c.Id + ")");
                _server.Log += Enqueue;
                _server.Start();
                Logger.LogInfo("Listening on ws://127.0.0.1:" + _port.Value);
            }
            catch (Exception e)
            {
                Logger.LogError("Could not start bridge server on port " + _port.Value + ": " + e.Message);
            }
        }

        private void Enqueue(string log) { lock (_logQueue) _logQueue.Enqueue(log); }

        /// <summary>Main-thread time this plugin spends per frame (requests, events, change scan), smoothed.</summary>
        internal static double FrameMs, FrameMaxMs;
        private static float _frameMaxAt;
        private readonly System.Diagnostics.Stopwatch _frameSw = new System.Diagnostics.Stopwatch();

        private void Update()
        {
            _frameSw.Reset();
            _frameSw.Start();
            try { UpdateInner(); }
            finally
            {
                double ms = _frameSw.Elapsed.TotalMilliseconds + ViewportTools.LastFrameMs;
                if (ms > 100) Logger.LogInfo("Slow bridge frame: " + Math.Round(ms) + " ms (viewport tools " + Math.Round(ViewportTools.LastFrameMs) + " ms)");
                FrameMs = FrameMs * 0.95 + ms * 0.05;
                if (ms > FrameMaxMs || UnityEngine.Time.unscaledTime - _frameMaxAt > 30f) { FrameMaxMs = ms; _frameMaxAt = UnityEngine.Time.unscaledTime; }
            }
        }

        private void UpdateInner()
        {
            lock (_logQueue)
                while (_logQueue.Count > 0) Logger.LogInfo(_logQueue.Dequeue());

            ViewportTools.Watchdog();
            // the app went away mid-preview: put the characters back in their own poses
            if (PoseApi.Previewing && ClientCount == 0) PoseApi.EndPreview();
            // Handle a bounded number of requests per frame to keep Studio responsive. While ghosts are
            // baking the playhead is temporarily elsewhere: hold requests for those few frames.
            for (int n = 0; n < 64 && !ViewportTools.Busy; n++)
            {
                KeyValuePair<WsClient, string> item;
                lock (_inbox)
                {
                    if (_inbox.Count == 0) break;
                    item = _inbox.Dequeue();
                }
                item.Key.Send(_router.Handle(item.Value));
            }

            // While ghosts are baked the timeline jumps around on purpose: don't report it as user activity.
            if (_server != null && _server.ClientCount > 0 && !ViewportTools.Busy && !PoseThumbs.Running)
                _events.Update();
        }

        internal int ClientCount => _server?.ClientCount ?? 0;

        internal void BroadcastBinary(byte[] data) => _server?.BroadcastBinary(data);

        internal void Broadcast(string evt, object data)
        {
            if (_server == null) return;
            _server.Broadcast(Json.Serialize(new Dictionary<string, object> { { "event", evt }, { "data", data } }));
        }

        private void OnDestroy()
        {
            _server?.Dispose();
        }
    }
}
