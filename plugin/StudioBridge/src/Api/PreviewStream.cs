using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using HarmonyLib;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// EXPERIMENTAL (roadmap Phase 3 spike): streams Studio's camera view into the Studio EX window.
    ///
    /// Each captured frame renders Studio's main camera a second time into a RenderTexture (image effects
    /// included), reads it back to the CPU, encodes JPEG and broadcasts it as a binary WebSocket frame:
    ///   "SXPV" | int32 frame | float64 captureUnixMs | int32 inputSeq | int16 width | int16 height | JPEG
    /// Every stage is timed so the go/no-go decision can be made from numbers (preview.stats).
    /// Dragging in the preview moves Studio's own camera (preview.orbit), so a frame's round trip is the
    /// same as a real interactive viewport's.
    /// </summary>
    internal sealed class PreviewStream : MonoBehaviour
    {
        public static PreviewStream Instance;

        private bool _on;
        private int _w = 1280, _h = 720, _quality = 75;
        private float _fps = 30f;
        private RenderTexture _rt;
        private Texture2D _tex;
        private Coroutine _loop;
        private float _next;
        private int _frame;
        private int _inputSeq;

        // Options under test
        private bool _raw;      // send raw RGB24 instead of JPEG (no encode on Studio's main thread)
        private bool _delayed;  // read back one game frame after rendering (GPU has finished: shorter stall)
        private bool _pendingRead;
        private double _captureMs;
        private int _captureSeq;

        // Background sender: keeps only the newest frame, so a slow client never blocks Studio.
        private System.Threading.Thread _sender;
        private readonly object _outLock = new object();
        private byte[] _outgoing;
        private readonly System.Threading.AutoResetEvent _outReady = new System.Threading.AutoResetEvent(false);
        private volatile bool _alive = true;
        private int _dropped;

        // Timings (exponential moving averages, ms) and counters
        private double _renderMs, _readMs, _encodeMs, _sendMs, _kb;
        private float _gameDt = 1f / 60f;
        private readonly Queue<float> _sentTimes = new Queue<float>();
        private readonly Stopwatch _sw = new Stopwatch();

        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public static void Register(CommandRouter r)
        {
            r.Add("preview.start", a =>
            {
                Instance._raw = a.GetString("format") == "raw";
                Instance._delayed = a.GetBool("delayed", true);
                return Instance.Start(a.GetInt("width", 1280), a.GetInt("height", 720), a.GetFloat("fps", 30f), a.GetInt("quality", 75));
            });
            r.Add("preview.stop", a => { Instance.Stop(); return true; });
            r.Add("preview.stats", a => Instance.Stats());
            r.Add("preview.orbit", a => Instance.Orbit(a));
        }

        private void Awake() => Instance = this;

        private void Update()
        {
            // Game frame time, always measured, so "preview off" gives the baseline.
            _gameDt = Mathf.Lerp(_gameDt, Time.unscaledDeltaTime, 0.05f);
            if (_on && StudioBridgePlugin.Instance != null && StudioBridgePlugin.Instance.ClientCount == 0) Stop();
        }

        private object Start(int w, int h, float fps, int quality)
        {
            _w = Mathf.Clamp(w, 160, 3840);
            _h = Mathf.Clamp(h, 90, 2160);
            _fps = Mathf.Clamp(fps, 1f, 120f);
            _quality = Mathf.Clamp(quality, 10, 100);
            if (_rt == null || _rt.width != _w || _rt.height != _h)
            {
                Release();
                _rt = new RenderTexture(_w, _h, 24, RenderTextureFormat.ARGB32) { name = "StudioEX.Preview" };
                _tex = new Texture2D(_w, _h, TextureFormat.RGB24, false) { name = "StudioEX.PreviewRead" };
            }
            _renderMs = _readMs = _encodeMs = _sendMs = _kb = 0;
            _sentTimes.Clear();
            _pendingRead = false;
            _dropped = 0;
            if (_sender == null)
            {
                _sender = new System.Threading.Thread(SendLoop) { IsBackground = true, Name = "StudioEX.PreviewSend" };
                _sender.Start();
            }
            _on = true;
            if (_loop == null) _loop = StartCoroutine(Loop());
            return Stats();
        }

        private void Stop()
        {
            _on = false;
            if (_loop != null) { StopCoroutine(_loop); _loop = null; }
        }

        private void Release()
        {
            if (_rt != null) { _rt.Release(); Destroy(_rt); _rt = null; }
            if (_tex != null) { Destroy(_tex); _tex = null; }
        }

        private void OnDestroy()
        {
            Stop();
            Release();
            _alive = false;
            _outReady.Set();
        }

        private void SendLoop()
        {
            var sw = new Stopwatch();
            while (_alive)
            {
                _outReady.WaitOne();
                byte[] msg;
                lock (_outLock) { msg = _outgoing; _outgoing = null; }
                if (msg == null) continue;
                sw.Reset(); sw.Start();
                try { StudioBridgePlugin.Instance.BroadcastBinary(msg); } catch { }
                _sendMs = Ema(_sendMs, sw.Elapsed.TotalMilliseconds);
            }
        }

        private IEnumerator Loop()
        {
            var eof = new WaitForEndOfFrame();
            while (_on)
            {
                yield return eof;
                try
                {
                    if (_pendingRead) { _pendingRead = false; ReadAndShip(); } // rendered last game frame
                    if (Time.unscaledTime < _next || ViewportTools.Busy) continue;
                    _next = Time.unscaledTime + 1f / _fps;
                    if (!Render()) continue;
                    if (_delayed) _pendingRead = true;
                    else ReadAndShip();
                }
                catch (Exception e)
                {
                    StudioBridgePlugin.Logger.LogWarning("Preview capture failed: " + e.Message);
                    _on = false;
                }
            }
            _loop = null;
        }

        private static double Ema(double prev, double v) => prev <= 0 ? v : prev * 0.9 + v * 0.1;

        private bool Render()
        {
            var cam = Camera.main;
            if (cam == null || _rt == null) return false;
            _captureMs = (DateTime.UtcNow - Epoch).TotalMilliseconds;
            _captureSeq = _inputSeq;

            // 1) render Studio's camera again into our texture (image effects included)
            _sw.Reset(); _sw.Start();
            var prevTarget = cam.targetTexture;
            try
            {
                cam.targetTexture = _rt;
                cam.Render();
            }
            finally { cam.targetTexture = prevTarget; }
            _renderMs = Ema(_renderMs, _sw.Elapsed.TotalMilliseconds);
            return true;
        }

        private void ReadAndShip()
        {
            // 2) GPU -> CPU readback (stalls until the GPU has finished)
            _sw.Reset(); _sw.Start();
            var prevActive = RenderTexture.active;
            RenderTexture.active = _rt;
            _tex.ReadPixels(new Rect(0, 0, _w, _h), 0, 0, false);
            RenderTexture.active = prevActive;
            _readMs = Ema(_readMs, _sw.Elapsed.TotalMilliseconds);

            // 3) payload: JPEG encoded here, or the raw RGB24 pixels (rows bottom-up) copied out
            _sw.Reset(); _sw.Start();
            byte[] body = _raw ? _tex.GetRawTextureData() : _tex.EncodeToJPG(_quality);
            _encodeMs = Ema(_encodeMs, _sw.Elapsed.TotalMilliseconds);

            // 4) header; sending happens on the background thread
            var msg = new byte[24 + body.Length];
            msg[0] = (byte)'S'; msg[1] = (byte)'X'; msg[2] = (byte)'P'; msg[3] = (byte)(_raw ? 'R' : 'V');
            Buffer.BlockCopy(BitConverter.GetBytes(++_frame), 0, msg, 4, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(_captureMs), 0, msg, 8, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(_captureSeq), 0, msg, 16, 4);
            Buffer.BlockCopy(BitConverter.GetBytes((short)_w), 0, msg, 20, 2);
            Buffer.BlockCopy(BitConverter.GetBytes((short)_h), 0, msg, 22, 2);
            Buffer.BlockCopy(body, 0, msg, 24, body.Length);
            lock (_outLock)
            {
                if (_outgoing != null) _dropped++;
                _outgoing = msg;
            }
            _outReady.Set();
            _kb = Ema(_kb, body.Length / 1024.0);

            _sentTimes.Enqueue(Time.unscaledTime);
            while (_sentTimes.Count > 0 && Time.unscaledTime - _sentTimes.Peek() > 2f) _sentTimes.Dequeue();
        }

        private object Stats()
        {
            float span = _sentTimes.Count > 1 ? Time.unscaledTime - _sentTimes.Peek() : 0f;
            return new Dictionary<string, object>
            {
                { "on", _on },
                { "width", _w }, { "height", _h }, { "fps", _fps }, { "quality", _quality },
                { "frames", _frame },
                { "sentFps", span > 0.2f ? (_sentTimes.Count - 1) / span : 0f },
                { "renderMs", _renderMs }, { "readbackMs", _readMs }, { "encodeMs", _encodeMs }, { "sendMs", _sendMs },
                { "costMs", _renderMs + _readMs + _encodeMs }, // Studio main-thread cost; sending is off-thread
                { "kbPerFrame", _kb },
                { "format", _raw ? "raw" : "jpeg" }, { "delayed", _delayed }, { "dropped", _dropped },
                { "gameFrameMs", _gameDt * 1000f },
                { "gameFps", 1f / Mathf.Max(1e-4f, _gameDt) },
                { "screen", Screen.width + "x" + Screen.height },
            };
        }

        /// <summary>Move Studio's own camera: orbit (dx, dy degrees), zoom (factor), pan (px, py in view units).</summary>
        private object Orbit(Dictionary<string, object> a)
        {
            var ctrl = SceneApi.Studio.cameraCtrl;
            var data = Traverse.Create(ctrl).Field("cameraData");
            if (!data.FieldExists()) throw new BridgeException("Studio camera data not found");
            var cd = data.GetValue();
            var t = Traverse.Create(cd);
            var rot = t.Field("rotate").GetValue<Vector3>();
            var pos = t.Field("pos").GetValue<Vector3>();
            var dist = t.Field("distance").GetValue<Vector3>();

            rot.y += a.GetFloat("dx");
            rot.x = Mathf.Clamp(rot.x + a.GetFloat("dy"), -89f, 89f);
            float zoom = a.GetFloat("zoom", 1f);
            if (zoom > 0f && Math.Abs(zoom - 1f) > 1e-4f) dist.z = Mathf.Clamp(dist.z * zoom, -100f, -0.05f);
            float px = a.GetFloat("px"), py = a.GetFloat("py");
            if (px != 0f || py != 0f)
            {
                var q = Quaternion.Euler(rot);
                float scale = Mathf.Abs(dist.z);
                pos += q * new Vector3(-px * scale, py * scale, 0f);
            }
            t.Field("rotate").SetValue(rot);
            t.Field("pos").SetValue(pos);
            t.Field("distance").SetValue(dist);
            if (a.Has("seq")) _inputSeq = a.GetInt("seq");
            return _inputSeq;
        }
    }
}
