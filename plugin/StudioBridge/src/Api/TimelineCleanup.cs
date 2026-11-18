using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml;
using StudioEX.Bridge.Net;
using UnityEngine;
using TL = Timeline.Timeline;
using TLKeyframe = Timeline.Keyframe;
using Interpolable = Timeline.Interpolable;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Motion cleanup helpers: many key values written in one undo step (smoothing, loops, pop fixes) and
    /// scaling key times around a pivot (retiming). The math lives in the app; these apply it safely.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static void RegisterCleanup(CommandRouter r)
        {
            r.Add("timeline.setKeyValues", SetKeyValues);
            r.Add("timeline.scaleKeys", ScaleKeys);
            r.Add("timeline.makeLoop", MakeLoop);
        }

        /// <summary>args: {edits:[{track, t, value:{attr: number}}], label?} — one undo step for all of them.</summary>
        private static object SetKeyValues(Dictionary<string, object> a)
        {
            var work = new List<KeyValuePair<Interpolable, KeyValuePair<float, Dictionary<string, object>>>>();
            foreach (var o in a.GetList("edits"))
            {
                var e = o as Dictionary<string, object>;
                if (e == null || !Interpolables.TryGetValue(e.GetInt("track"), out var ip)) continue;
                if (!FindKey(ip, e.GetFloat("t"), out var exact)) continue;
                work.Add(new KeyValuePair<Interpolable, KeyValuePair<float, Dictionary<string, object>>>(ip,
                    new KeyValuePair<float, Dictionary<string, object>>(exact, e.GetObject("value") ?? new Dictionary<string, object>())));
            }
            if (work.Count == 0) return 0;
            History.Push(History.Capture(work.Select(w => w.Key)), a.GetString("label") ?? "Edit key values");
            int n = 0;
            foreach (var w in work)
            {
                var ip = w.Key;
                var kf = ip.keyframes[w.Value.Key];
                try
                {
                    kf.value = ip.ReadValueFromXml(PatchedValueXml(ip, kf.value, w.Value.Value));
                    n++;
                }
                catch (Exception ex) { StudioBridgePlugin.Logger.LogDebug("setKeyValues skipped a key on " + SafeName(ip) + ": " + ex.Message); }
            }
            AfterEdit();
            return n;
        }

        /// <summary>The key's value as Timeline XML with some attributes replaced (any mod's value type).</summary>
        private static XmlElement PatchedValueXml(Interpolable ip, object value, Dictionary<string, object> patch)
        {
            var current = DescribeValue(ip, value) as Dictionary<string, object>;
            var doc = new XmlDocument();
            var el = doc.CreateElement("keyframe");
            doc.AppendChild(el);
            if (current != null)
                foreach (var kv in current)
                    if (!kv.Key.StartsWith("_")) el.SetAttribute(kv.Key, Convert.ToString(kv.Value, System.Globalization.CultureInfo.InvariantCulture));
            foreach (var kv in patch)
            {
                string v = kv.Value is double d ? XmlConvert.ToString((float)d) : Convert.ToString(kv.Value, System.Globalization.CultureInfo.InvariantCulture);
                el.SetAttribute(kv.Key, v);
            }
            if (current != null && current.TryGetValue("_xml", out var inner)) el.InnerXml = inner as string ?? "";
            return el;
        }

        /// <summary>
        /// args: {tracks:[ids], end} — each track ends on the value it starts with: the key at `end` (created if
        /// missing, keeping the last key's easing) gets a copy of the first key's value. One undo step.
        /// </summary>
        private static object MakeLoop(Dictionary<string, object> a)
        {
            float end = Mathf.Clamp(a.GetFloat("end"), 0f, TL.duration);
            var tracks = TracksFromIds(a.GetList("tracks")).Where(ip => ip.keyframes.Count >= 1 && ip.keyframes.Keys[0] < end - 1e-4f).ToList();
            if (tracks.Count == 0) return 0;
            History.Push(History.Capture(tracks), "Make loop");
            foreach (var ip in tracks)
            {
                var first = ip.keyframes.Values[0];
                // a copy of the value through the track's own XML (works for any value type, never shares objects)
                var value = ip.ReadValueFromXml(PatchedValueXml(ip, first.value, new Dictionary<string, object>()));
                if (FindKey(ip, end, out var exact)) ip.keyframes[exact].value = value;
                else
                {
                    var last = ip.keyframes.Values[ip.keyframes.Count - 1];
                    ip.keyframes[end] = new TLKeyframe(value, ip, new AnimationCurve(last.curve.keys));
                }
            }
            AfterEdit();
            return tracks.Count;
        }

        /// <summary>
        /// args: {keys:[{track,t}], factor, pivot, fps?: snap to frames} — new time = pivot + (t − pivot) × factor.
        /// Refused when keys would land before 0, past the end, on top of each other or on another key.
        /// </summary>
        private static object ScaleKeys(Dictionary<string, object> a)
        {
            float factor = a.GetFloat("factor", 1f), pivot = a.GetFloat("pivot");
            int fps = a.GetInt("fps", 0);
            if (factor <= 0.01f || factor > 100f) throw new BridgeException("Use a factor between 0.01 and 100");
            var refs = KeyRefs(a);
            if (refs.Count == 0 || Mathf.Approximately(factor, 1f)) return 0;
            Func<float, float> map = t =>
            {
                float to = pivot + (t - pivot) * factor;
                if (fps > 0) to = Mathf.Round(to * fps) / fps;
                return to;
            };
            var byTrack = refs.GroupBy(r => r.Track).ToList();
            foreach (var g in byTrack)
            {
                var moving = new HashSet<float>(g.Select(r => r.Time));
                var targets = new List<float>();
                foreach (var r in g)
                {
                    float to = map(r.Time);
                    if (to < -1e-5f) throw new BridgeException("Some keys would move before 0 — pick a later pivot or a smaller change");
                    if (to > TL.duration + 1e-4f) throw new BridgeException("Some keys would move past the end (" + TL.duration.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "s) — make the timeline longer first");
                    if (targets.Any(x => Mathf.Abs(x - to) < 1e-4f)) throw new BridgeException("Keys on " + SafeName(g.Key) + " would land on the same frame — use a larger factor");
                    targets.Add(to);
                    foreach (var existing in g.Key.keyframes.Keys)
                        if (!moving.Contains(existing) && Mathf.Abs(existing - to) < 1e-4f)
                            throw new BridgeException("A key already exists at " + to.ToString("0.###") + "s on " + SafeName(g.Key));
                }
            }
            History.Push(History.Capture(byTrack.Select(g => g.Key)), "Retime keys");
            foreach (var g in byTrack)
            {
                var pulled = g.Select(r => new KeyValuePair<float, TLKeyframe>(r.Time, g.Key.keyframes[r.Time])).ToList();
                foreach (var p in pulled) g.Key.keyframes.Remove(p.Key);
                foreach (var p in pulled) g.Key.keyframes[Mathf.Max(0f, map(p.Key))] = p.Value;
            }
            AfterEdit();
            return refs.Count;
        }
    }
}
