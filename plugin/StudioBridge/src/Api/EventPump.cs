using System;
using System.Collections.Generic;
using Studio;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Polls Studio/Timeline state on the main thread and pushes change events:
    ///   timeline.tick    {playing,time,...}   — ~30 Hz while playing, or on any time change
    ///   timeline.changed {}                    — track/key layout changed (app should re-fetch)
    ///   scene.changed    {}                    — objects added/removed/renamed/reparented
    ///   selection        [ids]                 — Studio selection changed
    /// Polling keeps us decoupled from every mod that can mutate the scene.
    /// </summary>
    internal sealed class EventPump
    {
        private readonly Action<string, object> _send;

        private float _lastTickSent;
        private float _lastTime = -1f;
        private bool _lastPlaying;
        private float _nextSlowPoll;
        private long _timelineSig;
        private long _sceneSig;
        private string _selectionSig = "";

        public EventPump(Action<string, object> send) { _send = send; }

        public void Update()
        {
            try { Tick(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("tick: " + e.Message); }

            if (Time.unscaledTime < _nextSlowPoll) return;
            _nextSlowPoll = Time.unscaledTime + 0.2f;

            try { PollTimeline(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("timeline poll: " + e.Message); }
            try { PollScene(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("scene poll: " + e.Message); }

            if (Time.unscaledTime < _nextChangePoll) return;
            _nextChangePoll = Time.unscaledTime + 0.4f;
            try { PollChanges(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("change poll: " + e.Message); }
        }

        private float _nextChangePoll;
        private bool _rebaseDue = true;
        private static volatile bool _rebaseRequested;

        /// <summary>Ask for the change baseline to be retaken on the next change poll (e.g. after undo).</summary>
        public static void RequestRebase() { _rebaseRequested = true; }
        private int _lastPending = -1;

        /// <summary>Cost of the change scan on Studio's main thread (runs every 0.4 s while the app is connected).</summary>
        public static double ScanMs, ScanAvgMs, ScanMaxMs;
        private static float _scanMaxAt;
        private int _lastStale = -1;

        private void SendStale()
        {
            int st = TimelineApi.PoseStale() ? 1 : 0;
            if (st == _lastStale) return;
            _lastStale = st;
            _send("timeline.poseStale", st == 1);
        }

        /// <summary>
        /// After a seek / playback stop / timeline edit the pose on screen is "what the animation says",
        /// so it becomes the new baseline. Anything that differs afterwards is a user change.
        /// </summary>
        private void PollChanges()
        {
            if (_lastPlaying) return;
            if (PoseApi.Previewing) return; // a hover preview is not a change (and must never be auto-keyed)
            // While key edits are held back (pose stale), keep the baseline: re-taking it would drop the user's
            // unkeyed changes from the count, and the next edit would then overwrite them.
            bool stale = TimelineApi.PoseStale();
            if (_rebaseRequested) { _rebaseRequested = false; if (!stale) _rebaseDue = true; }
            if (stale) _rebaseDue = false; // a seek/playback clears stale first, so those still rebase
            if (_rebaseDue)
            {
                _rebaseDue = false;
                TimelineApi.Rebase();
                if (_lastPending != 0) { _lastPending = 0; _send("timeline.pending", 0); }
                return;
            }
            bool mouseFree = !Input.GetMouseButton(0) && !Input.GetMouseButton(1) && !Input.GetMouseButton(2);
            // Volatility = "changes on its own while nobody touches it". Only sample it when the user isn't
            // dragging; otherwise a 1 s gizmo drag would mark that bone volatile and disable auto-key for it.
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int[] r;
            TimelineApi.BeginScan(); // each track's value is read once for both passes
            try
            {
                if (mouseFree) TimelineApi.Observe();
                r = TimelineApi.PollChanges(mouseFree);
            }
            finally { TimelineApi.EndScan(); }
            ScanMs = sw.Elapsed.TotalMilliseconds;
            ScanAvgMs = ScanAvgMs <= 0 ? ScanMs : ScanAvgMs * 0.9 + ScanMs * 0.1;
            if (ScanMs > ScanMaxMs || Time.unscaledTime - _scanMaxAt > 30f) { ScanMaxMs = ScanMs; _scanMaxAt = Time.unscaledTime; }
            if (r[1] > 0)
            {
                _send("autokey", r[1]);
                _timelineSig = TimelineApi.Signature(); // our own edit: don't trigger another rebase cycle
            }
            if (r[0] != _lastPending)
            {
                _lastPending = r[0];
                _send("timeline.pending", r[0]);
            }
            SendStale();
        }

        private void Tick()
        {
            var state = TimelineApi.TickState();
            if (state == null) return;
            float t = (float)state["time"];
            bool playing = (bool)state["playing"];
            bool changed = t != _lastTime || playing != _lastPlaying;
            if (!changed) return;
            if (!playing) _rebaseDue = true;
            TimelineApi.PoseFresh(); // a seek or playback re-evaluates every track
            // ~30 Hz max (playing or scrubbing); a play/pause flip is sent immediately. Skipped values are
            // picked up on a later frame because _lastTime isn't updated, so the final position always arrives.
            if (playing == _lastPlaying && Time.unscaledTime - _lastTickSent < 1f / 30f) return;
            _lastTime = t;
            _lastPlaying = playing;
            _lastTickSent = Time.unscaledTime;
            _send("timeline.tick", state);
        }

        private void PollTimeline()
        {
            long sig = TimelineApi.Signature();
            if (sig == _timelineSig) return;
            _timelineSig = sig;
            // An edit re-applies the pose only when nothing is unkeyed (see AfterEdit). With unkeyed changes the
            // pose wasn't touched, so the baseline stays: re-taking it would drop those changes from the count
            // and the next edit would overwrite them.
            if (TimelineApi.Pending() == 0) _rebaseDue = true;
            _send("timeline.changed", null);
        }

        private void PollScene()
        {
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) return;

            unchecked
            {
                long h = 17;
                foreach (var kv in studio.dicInfo)
                {
                    var node = kv.Key;
                    if (node == null) continue;
                    h = h * 31 + node.GetInstanceID();
                    h = h * 31 + (node.textName?.GetHashCode() ?? 0);
                    h = h * 31 + (node.parent != null ? node.parent.GetInstanceID() : 0);
                    h = h * 31 + (node.visible ? 1 : 0);
                }
                if (Translation.Changed) { Translation.Changed = false; h ^= DateTime.Now.Ticks; }
                if (h != _sceneSig)
                {
                    _sceneSig = h;
                    _send("scene.changed", null);
                }
            }

            var sel = SceneApi.SelectedIds();
            string selSig = string.Join(",", sel.ConvertAll(o => o.ToString()).ToArray());
            if (selSig != _selectionSig)
            {
                _selectionSig = selSig;
                _send("selection", sel);
            }
        }
    }
}
