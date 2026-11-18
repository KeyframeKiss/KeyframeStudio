using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Xml;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using TL = Timeline.Timeline;
using TLKeyframe = Timeline.Keyframe;
using Interpolable = Timeline.Interpolable;
using InterpolableModel = Timeline.InterpolableModel;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Motion clips: a stretch of one object's animation (body, face, anything Timeline animates) saved to
    /// UserData/StudioEX/clips and dropped back in at any time, on the same or another character. Tracks are
    /// written with Timeline's own interpolable writer, so each track type's parameter (which bone, which face
    /// part…) is re-resolved on the target the same way Timeline's single-file load does it.
    ///
    /// Applying can replace what's there or add on top (as an offset from the clip's first pose), at a
    /// strength, with a blend in and out, faster or slower, looped. One undo step.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static readonly MethodInfo M_writeInterpolable = AccessTools.Method(typeof(TL), "WriteInterpolable");
        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        private static string ClipFolder => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/clips"));

        private static void RegisterClips(CommandRouter r)
        {
            r.Add("clips.list", a => ListClips());
            r.Add("clips.save", SaveClip);
            r.Add("clips.apply", ApplyClip);
            r.Add("clips.delete", a =>
            {
                string p = ClipPath(a.GetString("file"));
                if (!File.Exists(p)) throw new BridgeException("Clip not found");
                File.Delete(p);
                var jpg = Path.ChangeExtension(p, ".jpg");
                if (File.Exists(jpg)) File.Delete(jpg);
                return ListClips();
            });
            r.Add("clips.thumb", a =>
            {
                string p = ClipPath(a.GetString("file"));
                if (!File.Exists(p)) throw new BridgeException("Clip not found");
                WriteThumb(p);
                return ListClips();
            });
        }

        // ------------------------------------------------------------------ keys as plain data

        /// <summary>A key: time, value attributes + inner XML (exactly what the track's XML writer produces), easing.</summary>
        private sealed class KD
        {
            public float T;
            public Dictionary<string, string> A = new Dictionary<string, string>();
            public string Inner;
            public AnimationCurve Curve;
        }

        private static List<KD> LiveKeys(Interpolable ip)
        {
            var list = new List<KD>();
            foreach (var kv in ip.keyframes)
            {
                var d = DescribeValue(ip, kv.Value.value) as Dictionary<string, object>;
                if (d == null || d.ContainsKey("_error")) continue;
                list.Add(new KD
                {
                    T = kv.Key,
                    A = d.Where(x => !x.Key.StartsWith("_")).ToDictionary(x => x.Key, x => Convert.ToString(x.Value, Inv)),
                    Inner = d.TryGetValue("_xml", out var i) ? i as string : null,
                    Curve = new AnimationCurve(kv.Value.curve.keys),
                });
            }
            return list;
        }

        private static XmlElement ValueElement(XmlDocument doc, KD k)
        {
            var v = doc.CreateElement("v");
            foreach (var kv in k.A) v.SetAttribute(kv.Key, kv.Value);
            if (!string.IsNullOrEmpty(k.Inner)) v.InnerXml = k.Inner;
            return v;
        }

        private static object ValueOf(Interpolable ip, KD k)
        {
            var doc = new XmlDocument();
            var v = ValueElement(doc, k);
            doc.AppendChild(v);
            return ip.ReadValueFromXml(v);
        }

        private static XmlElement KeyNode(XmlDocument doc, KD k)
        {
            var e = doc.CreateElement("k");
            e.SetAttribute("t", XmlConvert.ToString(k.T));
            var c = CurveToList(k.Curve);
            if (c != null) e.SetAttribute("curve", string.Join(",", c.Select(x => XmlConvert.ToString(Convert.ToSingle(x))).ToArray()));
            e.AppendChild(ValueElement(doc, k));
            return e;
        }

        private static KD ReadKeyNode(XmlElement e)
        {
            var k = new KD { T = XmlConvert.ToSingle(e.GetAttribute("t")) };
            var curve = e.GetAttribute("curve");
            k.Curve = string.IsNullOrEmpty(curve)
                ? AnimationCurve.Linear(0f, 0f, 1f, 1f)
                : ListToCurve(curve.Split(',').Select(s => (object)XmlConvert.ToSingle(s)).ToList());
            if (e["v"] is XmlElement v)
            {
                foreach (XmlAttribute at in v.Attributes) k.A[at.Name] = at.Value;
                if (v.HasChildNodes) k.Inner = v.InnerXml;
            }
            return k;
        }

        // ------------------------------------------------------------------ value math (any value type)

        private static bool Num(string s, out float f) => float.TryParse(s, NumberStyles.Float, Inv, out f);
        private static readonly string[] QuatKeys = { "valueX", "valueY", "valueZ", "valueW" };
        private static bool IsQuat(Dictionary<string, string> a) => QuatKeys.All(a.ContainsKey) && QuatKeys.All(k => Num(a[k], out _));
        private static Quaternion Q(Dictionary<string, string> a) =>
            new Quaternion(float.Parse(a["valueX"], Inv), float.Parse(a["valueY"], Inv), float.Parse(a["valueZ"], Inv), float.Parse(a["valueW"], Inv));
        private static void SetQ(Dictionary<string, string> a, Quaternion q)
        {
            a["valueX"] = XmlConvert.ToString(q.x);
            a["valueY"] = XmlConvert.ToString(q.y);
            a["valueZ"] = XmlConvert.ToString(q.z);
            a["valueW"] = XmlConvert.ToString(q.w);
        }

        /// <summary>a → b by f: numbers lerp, rotations slerp, anything else switches at the end.</summary>
        private static KD Mix(KD a, KD b, float f, float t, bool switchAtHalf = false)
        {
            var r = new KD { T = t, Curve = a.Curve };
            bool takeB = switchAtHalf ? f >= 0.5f : f >= 0.999f;
            foreach (var kv in a.A)
            {
                if (b.A.TryGetValue(kv.Key, out var bv) && Num(kv.Value, out var x) && Num(bv, out var y))
                    r.A[kv.Key] = XmlConvert.ToString(Mathf.LerpUnclamped(x, y, f));
                else r.A[kv.Key] = takeB && b.A.ContainsKey(kv.Key) ? b.A[kv.Key] : kv.Value;
            }
            foreach (var kv in b.A) if (!r.A.ContainsKey(kv.Key)) r.A[kv.Key] = kv.Value;
            if (IsQuat(a.A) && IsQuat(b.A)) SetQ(r.A, Quaternion.Slerp(Q(a.A), Q(b.A), f));
            r.Inner = takeB ? b.Inner : a.Inner;
            return r;
        }

        /// <summary>e plus w × (c − c0): numbers add the difference, rotations add the turn; the rest stays e.</summary>
        private static KD AddOnTop(KD e, KD c, KD c0, float w, float t)
        {
            var r = new KD { T = t, Curve = e.Curve, Inner = e.Inner, A = new Dictionary<string, string>(e.A) };
            bool quat = IsQuat(e.A) && IsQuat(c.A) && IsQuat(c0.A);
            foreach (var kv in e.A)
            {
                if (quat && QuatKeys.Contains(kv.Key)) continue;
                if (Num(kv.Value, out var ev) && c.A.TryGetValue(kv.Key, out var cs) && c0.A.TryGetValue(kv.Key, out var c0s) && Num(cs, out var cv) && Num(c0s, out var c0v))
                    r.A[kv.Key] = XmlConvert.ToString(ev + w * (cv - c0v));
            }
            if (quat)
            {
                var delta = Quaternion.Inverse(Q(c0.A)) * Q(c.A);
                SetQ(r.A, Q(e.A) * Quaternion.Slerp(Quaternion.identity, delta, w));
            }
            return r;
        }

        /// <summary>The track's value at t from a sorted key list (easing of the left key), null when empty.</summary>
        private static KD Eval(List<KD> keys, float t)
        {
            if (keys.Count == 0) return null;
            if (t <= keys[0].T) return Clone(keys[0], t);
            var last = keys[keys.Count - 1];
            if (t >= last.T) return Clone(last, t);
            int i = 0;
            while (i < keys.Count - 2 && keys[i + 1].T <= t) i++;
            var l = keys[i];
            var rk = keys[i + 1];
            if (Mathf.Abs(t - l.T) < 1e-5f) return Clone(l, t);
            float f = l.Curve != null ? l.Curve.Evaluate((t - l.T) / (rk.T - l.T)) : (t - l.T) / (rk.T - l.T);
            return Mix(l, rk, f, t);
        }

        private static KD Clone(KD k, float t) => new KD { T = t, A = new Dictionary<string, string>(k.A), Inner = k.Inner, Curve = k.Curve };

        // ------------------------------------------------------------------ files

        private static string ClipPath(string file)
        {
            var sb = new StringBuilder();
            foreach (char ch in (file ?? "").Trim()) sb.Append(Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch);
            if (sb.Length == 0) throw new BridgeException("Name the clip");
            return Path.Combine(ClipFolder, sb + ".xml");
        }

        private static void WriteThumb(string clipPath)
        {
            var thumb = CameraApi.Snapshot(240);
            if (thumb != null) File.WriteAllBytes(Path.ChangeExtension(clipPath, ".jpg"), Convert.FromBase64String(thumb.Substring(thumb.IndexOf(',') + 1)));
        }

        private static object ListClips()
        {
            var list = new List<object>();
            if (!Directory.Exists(ClipFolder)) return list;
            foreach (var f in Directory.GetFiles(ClipFolder, "*.xml").OrderByDescending(File.GetLastWriteTimeUtc))
            {
                try
                {
                    var doc = new XmlDocument();
                    doc.Load(f);
                    var root = doc.DocumentElement;
                    var tracks = root.SelectNodes("track").OfType<XmlElement>().ToList();
                    var item = new Dictionary<string, object>
                    {
                        { "file", Path.GetFileNameWithoutExtension(f) },
                        { "name", root.GetAttribute("name") },
                        { "length", XmlConvert.ToSingle(root.GetAttribute("length")) },
                        { "source", root.GetAttribute("source") },
                        { "sourceType", root.GetAttribute("sourceType") },
                        { "note", root.GetAttribute("note") },
                        { "tracks", tracks.Count },
                        { "keys", tracks.Sum(t => t.SelectNodes("k").Count) },
                        { "trackNames", tracks.Select(t => (object)t.GetAttribute("name")).Take(12).ToList() },
                        { "modified", (File.GetLastWriteTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                    };
                    var jpg = Path.ChangeExtension(f, ".jpg");
                    if (File.Exists(jpg)) item["thumb"] = "data:image/jpeg;base64," + Convert.ToBase64String(File.ReadAllBytes(jpg));
                    list.Add(item);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Skipped clip " + f + ": " + e.Message); }
            }
            return list;
        }

        // ------------------------------------------------------------------ save

        /// <summary>args: {name, tracks:[ids], t0, t1, note?} — the tracks' keys from t0 to t1, starting at 0.</summary>
        private static object SaveClip(Dictionary<string, object> a)
        {
            var s = Ready;
            string name = (a.GetString("name") ?? "").Trim();
            string path = ClipPath(name);
            var ips = TracksFromIds(a.GetList("tracks")).Where(ip => ip.keyframes.Count > 0).ToList();
            if (ips.Count == 0) throw new BridgeException("Select the keys (or tracks) to save as a clip");
            var ocis = ips.Select(ip => ip.oci).Where(o => o != null).Distinct().ToList();
            if (ocis.Count > 1) throw new BridgeException("A clip holds one object's animation — select keys of one character or item");
            if (ocis.Count == 1 && ips.Any(ip => ip.oci == null)) ips = ips.Where(ip => ip.oci != null).ToList(); // scene-wide tracks don't belong to the object
            float t0 = Mathf.Max(0f, a.GetFloat("t0")), t1 = Mathf.Min(TL.duration, a.GetFloat("t1"));
            if (t1 - t0 < 1f / 120f) throw new BridgeException("Select keys spanning some time (at least two keys apart)");
            var oci = ocis.FirstOrDefault();

            var doc = new XmlDocument();
            var root = doc.CreateElement("clip");
            doc.AppendChild(root);
            root.SetAttribute("version", "1");
            root.SetAttribute("name", name);
            root.SetAttribute("length", XmlConvert.ToString(t1 - t0));
            root.SetAttribute("source", oci != null ? SceneApi.DisplayName(oci) : "Scene");
            root.SetAttribute("sourceType", oci is OCIChar ? "Char" : oci is OCIItem ? "Item" : oci is OCILight ? "Light" : oci != null ? "Object" : "Scene");
            root.SetAttribute("note", a.GetString("note") ?? "");
            root.SetAttribute("fps", Convert.ToString(F_fps.GetValue(s), Inv));

            int written = 0;
            foreach (var ip in ips)
            {
                var header = InterpolableHeader(s, ip, oci);
                if (header == null) continue;
                var track = (XmlElement)doc.ImportNode(header, true);
                // Timeline's own keyframes are replaced by ours (only the range, re-timed from 0)
                foreach (var kf in track.ChildNodes.OfType<XmlElement>().Where(n => n.Name == "keyframe").ToList()) track.RemoveChild(kf);
                var live = LiveKeys(ip);
                var inRange = live.Where(k => k.T >= t0 - 1e-4f && k.T <= t1 + 1e-4f).ToList();
                // the motion at the edges, also when no key sits exactly there
                if (!inRange.Any(k => Mathf.Abs(k.T - t0) < 1e-4f) && Eval(live, t0) is KD first) { first.Curve = KeyCurveAt(live, t0); inRange.Insert(0, first); }
                if (!inRange.Any(k => Mathf.Abs(k.T - t1) < 1e-4f) && Eval(live, t1) is KD lastKey) inRange.Add(lastKey);
                track.SetAttribute("name", SafeName(ip));
                foreach (var k in inRange.OrderBy(k => k.T))
                {
                    k.T = Mathf.Max(0f, k.T - t0);
                    track.AppendChild(KeyNode(doc, k));
                }
                // our element name, Timeline's attributes (owner, id, parameter…) and parameter children
                var el = doc.CreateElement("track");
                foreach (XmlAttribute at in track.Attributes) el.SetAttribute(at.Name, at.Value);
                foreach (var child in track.ChildNodes.OfType<XmlNode>().ToList()) el.AppendChild(child);
                root.AppendChild(el);
                written++;
            }
            if (written == 0) throw new BridgeException("None of these tracks can be saved in a clip");
            Directory.CreateDirectory(ClipFolder);
            doc.Save(path);
            WriteThumb(path);
            return ListClips();
        }

        /// <summary>The easing a key placed at t would continue with: that of the key before it.</summary>
        private static AnimationCurve KeyCurveAt(List<KD> keys, float t)
        {
            KD prev = null;
            foreach (var k in keys) { if (k.T <= t) prev = k; else break; }
            return prev?.Curve ?? AnimationCurve.Linear(0f, 0f, 1f, 1f);
        }

        /// <summary>Timeline's XML for the track (with its parameter), objectIndex 0 = the clip's object.</summary>
        private static XmlElement InterpolableHeader(TL s, Interpolable ip, ObjectCtrlInfo oci)
        {
            var dicType = M_writeInterpolable.GetParameters()[2].ParameterType;
            var dic = (System.Collections.IList)Activator.CreateInstance(dicType);
            var item = dicType.GetGenericArguments()[0];
            if (oci != null)
            {
                if (item.IsAssignableFrom(typeof(ObjectCtrlInfo))) dic.Add(oci);
                else if (item.IsGenericType && item.GetGenericTypeDefinition() == typeof(KeyValuePair<,>))
                    dic.Add(Activator.CreateInstance(item, oci.objectInfo.dicKey, oci));
            }
            var sw = new StringWriter();
            using (var w = new XmlTextWriter(sw))
            {
                w.WriteStartElement("root");
                M_writeInterpolable.Invoke(M_writeInterpolable.IsStatic ? null : s, new object[] { ip, w, dic });
                w.WriteEndElement();
            }
            var doc = new XmlDocument();
            doc.LoadXml(sw.ToString());
            return doc.DocumentElement.FirstChild as XmlElement;
        }

        // ------------------------------------------------------------------ apply

        /// <summary>
        /// args: {file, oci (target; -1/absent for scene-wide clips), t (start), mode: "replace"|"add",
        /// strength 0..1, blend (seconds in and out), speed (2 = twice as fast), loops ≥ 1}
        /// </summary>
        private static object ApplyClip(Dictionary<string, object> a)
        {
            var s = Ready;
            string path = ClipPath(a.GetString("file"));
            if (!File.Exists(path)) throw new BridgeException("Clip not found");
            var doc = new XmlDocument();
            doc.Load(path);
            var root = doc.DocumentElement;
            string clipName = root.GetAttribute("name");
            float len = XmlConvert.ToSingle(root.GetAttribute("length"));
            int targetId = a.GetInt("oci", -1);
            ObjectCtrlInfo oci = targetId >= 0 ? SceneApi.FindOci(targetId) : null;
            bool sceneClip = root.GetAttribute("sourceType") == "Scene";
            if (!sceneClip && oci == null) throw new BridgeException("Select the character or object to put the clip on");
            string srcType = root.GetAttribute("sourceType");
            if (srcType == "Char" && !(oci is OCIChar)) throw new BridgeException("This clip is a character's animation — select a character");
            if (srcType == "Item" && !(oci is OCIItem)) throw new BridgeException("This clip is an item's animation — select an item");

            float start = Mathf.Clamp(a.GetFloat("t", TL.playbackTime), 0f, TL.duration);
            float speed = Mathf.Clamp(a.GetFloat("speed", 1f), 0.1f, 10f);
            int loops = Mathf.Clamp(a.GetInt("loops", 1), 1, 100);
            float strength = Mathf.Clamp01(a.GetFloat("strength", 1f));
            float blend = Mathf.Max(0f, a.GetFloat("blend", 0f));
            bool add = a.GetString("mode") == "add";
            float span = len / speed, total = span * loops;
            float end = start + total;
            bool trimmed = end > TL.duration + 1e-4f;
            end = Mathf.Min(end, TL.duration);
            if (end - start < 1e-3f) throw new BridgeException("No room for the clip after the playhead — move it earlier or make the timeline longer");
            blend = Mathf.Min(blend, (end - start) / 2f);

            var plans = new List<KeyValuePair<Interpolable, List<KD>>>();
            var created = new List<Interpolable>();
            var skipped = new List<string>();
            foreach (XmlElement node in root.SelectNodes("track"))
            {
                string trackName = node.GetAttribute("name");
                try
                {
                    var model = Models.FirstOrDefault(m => m.owner == node.GetAttribute("owner") && m.id == node.GetAttribute("id"));
                    if (model == null) { skipped.Add(trackName + " (its mod isn't installed)"); continue; }
                    var target = sceneClip || !node.HasAttribute("objectIndex") ? null : oci;
                    Interpolable ip;
                    if (model.readParameterFromXml != null)
                    {
                        var param = model.readParameterFromXml(target, node);
                        if (param == null) { skipped.Add(trackName + " (not on this object)"); continue; }
                        ip = new Interpolable(target, param, model);
                    }
                    else ip = new Interpolable(target, model);
                    if (target != null)
                    {
                        bool compatible;
                        try { compatible = model.IsCompatibleWithTarget(target); } catch { compatible = false; }
                        if (!compatible) { skipped.Add(trackName + " (doesn't fit this object)"); continue; }
                    }
                    if (Interpolables.TryGetValue(ip.GetHashCode(), out var existing)) ip = existing;
                    else created.Add(ip);

                    var clip = node.SelectNodes("k").OfType<XmlElement>().Select(ReadKeyNode).OrderBy(k => k.T).ToList();
                    if (clip.Count == 0) continue;
                    plans.Add(new KeyValuePair<Interpolable, List<KD>>(ip, Plan(ip, created.Contains(ip) ? new List<KD>() : LiveKeys(ip), clip, start, end, span, speed, strength, blend, add)));
                }
                catch (Exception e)
                {
                    skipped.Add(trackName + " (" + e.Message + ")");
                    StudioBridgePlugin.Logger.LogDebug("Clip track skipped: " + e);
                }
            }
            if (plans.Count == 0) throw new BridgeException("Nothing in this clip fits the selected object" + (skipped.Count > 0 ? ": " + string.Join(", ", skipped.Take(3).ToArray()) : ""));

            History.Push(History.Capture(plans.Select(p => p.Key)), "Apply clip “" + clipName + "”");
            var addLeaf = AccessTools.Method(Tree.GetType(), "AddLeaf");
            foreach (var ip in created.Where(c => plans.Any(p => p.Key == c)))
            {
                Interpolables[ip.GetHashCode()] = ip;
                addLeaf.Invoke(Tree, new object[] { ip, null });
            }
            int keys = 0;
            foreach (var p in plans)
            {
                var ip = p.Key;
                foreach (var k in ip.keyframes.Keys.Where(k => k >= start - 1e-4f && k <= end + 1e-4f).ToList()) ip.keyframes.Remove(k);
                foreach (var k in p.Value)
                {
                    float t = Mathf.Clamp(k.T, 0f, TL.duration);
                    FindKey(ip, t, out var exact);
                    ip.keyframes[exact] = new TLKeyframe(ValueOf(ip, k), ip, k.Curve ?? AnimationCurve.Linear(0f, 0f, 1f, 1f));
                    keys++;
                }
            }
            AfterEdit();
            return new Dictionary<string, object>
            {
                { "tracks", plans.Count },
                { "created", created.Count(c => plans.Any(p => p.Key == c)) },
                { "keys", keys },
                { "end", end },
                { "trimmed", trimmed },
                { "skipped", skipped.Cast<object>().ToList() },
            };
        }

        /// <summary>The keys a track gets between start and end (everything else on it stays as it is).</summary>
        private static List<KD> Plan(Interpolable ip, List<KD> live, List<KD> clip, float start, float end, float span, float speed, float strength, float blend, bool add)
        {
            float len = span * speed;
            // the clip's own keys, laid out loop after loop
            var placed = new SortedList<float, KD>();
            for (int i = 0; start + i * span < end - 1e-4f; i++)
                foreach (var k in clip)
                {
                    float t = start + i * span + k.T / speed;
                    if (t > end + 1e-4f) break;
                    var c = Clone(k, t);
                    c.Curve = k.Curve;
                    placed[Round(t)] = c; // a loop's first key replaces the previous loop's last (same pose for a clean loop)
                }
            if (placed.Count == 0 || Mathf.Abs(placed.Keys[placed.Count - 1] - end) > 1e-3f)
            {
                var local = ((end - start) * speed) % len;
                if (local < 1e-4f && end > start) local = len;
                placed[Round(end)] = Eval(clip, local);
            }

            Func<float, KD> clipAt = t =>
            {
                float local = (t - start) * speed;
                float within = local % len;
                if (within < 1e-4f && local > 1e-4f) within = len; // the end of a loop, not the start of the next
                return Eval(clip, within);
            };
            Func<float, float> weight = t =>
            {
                float w = 1f;
                if (blend > 1e-4f) w = Mathf.Min(Mathf.Clamp01((t - start) / blend), Mathf.Clamp01((end - t) / blend));
                return strength * Mathf.SmoothStep(0f, 1f, w);
            };

            // nothing there yet, or a plain full replace: the clip's keys as they are
            bool pure = live.Count == 0 || (!add && strength >= 0.999f && blend < 1e-4f);
            var times = new SortedList<float, bool>();
            foreach (var t in placed.Keys) times[t] = true;
            if (!pure)
            {
                foreach (var k in live) if (k.T > start + 1e-4f && k.T < end - 1e-4f) times[Round(k.T)] = true;
                if (blend > 1e-4f) { times[Round(start + blend)] = true; times[Round(end - blend)] = true; }
                times[Round(start)] = true;
                times[Round(end)] = true;
            }
            var c0 = clip[0];
            var result = new List<KD>();
            foreach (var t in times.Keys)
            {
                var c = placed.TryGetValue(t, out var pk) ? pk : clipAt(t);
                KD v;
                if (pure) v = Clone(c, t);
                else
                {
                    var e = Eval(live, t);
                    float w = weight(t);
                    v = add ? AddOnTop(e, c, c0, w, t) : Mix(e, c, w, t, switchAtHalf: true);
                }
                // easing: the clip's where its keys are, the existing track's where its keys were, else linear
                v.Curve = placed.TryGetValue(t, out var ck) ? ck.Curve : live.FirstOrDefault(k => Mathf.Abs(k.T - t) < 1e-4f)?.Curve ?? AnimationCurve.Linear(0f, 0f, 1f, 1f);
                v.T = t;
                result.Add(v);
            }
            return result;
        }

        private static float Round(float t) => Mathf.Round(t * 10000f) / 10000f;
    }
}
