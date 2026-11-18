using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Samples where a character's bones are over a time range (motion cleanup: foot sliding, sudden moves).
    /// Steps the timeline frame by frame like the ghost bake does — requests and change detection wait meanwhile —
    /// then puts the playhead back. Refused while there are unkeyed changes (seeking would reset them).
    /// Result arrives as the "motion.sample" event: {done, times, bones:{name:[[x,y,z]…]}, height} or {error}.
    /// </summary>
    internal sealed class MotionSampler : MonoBehaviour
    {
        private static MotionSampler _instance;
        public static bool Running { get; private set; }

        private void Awake() => _instance = this;

        public static void Register(CommandRouter r)
        {
            r.Add("motion.sample", Start);
        }

        /// <summary>args: {id, bones:[names], t0?, t1?, rate?: samples per second (default 20)} → number of samples.</summary>
        private static object Start(Dictionary<string, object> a)
        {
            if (!TimelineApi.Available) throw new BridgeException("Motion sampling needs Timeline");
            if (Running || ViewportTools.Busy) throw new BridgeException("Already busy — try again in a moment");
            if (TimelineApi.Pending() > 0) throw new BridgeException("Key or reset your unkeyed changes first — checking the motion moves the playhead, which would undo them");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("That character isn't loaded");
            float dur = TimelineApi.Duration();
            float t0 = Mathf.Clamp(a.Has("t0") ? a.GetFloat("t0") : 0f, 0f, dur);
            float t1 = Mathf.Clamp(a.Has("t1") ? a.GetFloat("t1") : dur, t0, dur);
            float rate = Mathf.Clamp(a.Has("rate") ? a.GetFloat("rate") : 20f, 2f, 60f);
            int n = Mathf.Clamp(Mathf.CeilToInt((t1 - t0) * rate) + 1, 2, 1200);
            var names = a.GetList("bones").Select(o => o as string).Where(s => !string.IsNullOrEmpty(s)).Distinct().ToList();
            if (names.Count == 0) throw new BridgeException("Which bones?");
            var all = c.charInfo.GetComponentsInChildren<Transform>(true);
            var bones = new Dictionary<string, Transform>();
            foreach (var name in names.Concat(new[] { "cf_j_head", "cf_j_foot_L" }))
                if (!bones.ContainsKey(name)) { var tr = all.FirstOrDefault(x => x.name == name); if (tr != null) bones[name] = tr; }
            if (!names.Any(bones.ContainsKey)) throw new BridgeException("None of those bones exist on this character");
            _instance.StartCoroutine(_instance.Run(c, names.Where(bones.ContainsKey).ToList(), bones, t0, t1, n));
            return n;
        }

        private IEnumerator Run(OCIChar c, List<string> names, Dictionary<string, Transform> bones, float t0, float t1, int n)
        {
            Running = true;
            float back = TimelineApi.PlaybackTime();
            var times = new List<object>();
            var series = names.ToDictionary(x => x, x => new List<object>());
            double height = 0;
            string error = null;
            bool seeked = false;
            try
            {
                for (int i = 0; i < n; i++)
                {
                    ViewportTools.HoldBusy(); // requests and change detection wait until we're done
                    float t = n == 1 ? t0 : t0 + (t1 - t0) * i / (n - 1);
                    TimelineApi.SeekTo(t);
                    seeked = true;
                    yield return new WaitForEndOfFrame(); // IK/FK and animation applied for this time
                    if (c.charInfo == null) { error = "The character was removed"; yield break; }
                    times.Add(Math.Round(t, 4));
                    foreach (var name in names)
                    {
                        var p = bones[name].position;
                        series[name].Add(new List<object> { Math.Round(p.x, 5), Math.Round(p.y, 5), Math.Round(p.z, 5) });
                    }
                    if (i == 0 && bones.TryGetValue("cf_j_head", out var head) && bones.TryGetValue("cf_j_foot_L", out var foot))
                        height = Math.Round(Mathf.Abs(head.position.y - foot.position.y) * 1.08f, 4); // head bone to sole, roughly
                }
            }
            finally
            {
                if (seeked) { try { TimelineApi.SeekTo(back); } catch { } }
                ViewportTools.Busy = false;
                Running = false;
                EventPump.RequestRebase();
                var result = error != null
                    ? new Dictionary<string, object> { { "done", true }, { "error", error } }
                    : new Dictionary<string, object> { { "done", true }, { "id", c.objectInfo.dicKey }, { "times", times }, { "bones", series.ToDictionary(kv => kv.Key, kv => (object)kv.Value) }, { "height", height } };
                StudioBridgePlugin.Instance?.Broadcast("motion.sample", result);
            }
        }
    }
}
