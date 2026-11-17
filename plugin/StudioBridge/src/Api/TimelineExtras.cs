using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
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
    /// <summary>Timeline folders (groups) and change detection / auto-key.</summary>
    internal static partial class TimelineImpl
    {
        private static void RegisterExtras(CommandRouter r)
        {
            r.Add("timeline.groupCreate", GroupCreate);
            r.Add("timeline.groupRename", a => { var g = FindGroup(a.GetInt("group")); SetGroupField(g, "name", a.GetString("name") ?? "Folder"); RefreshView(); return true; });
            r.Add("timeline.groupExpand", a => { var g = FindGroup(a.GetInt("group")); SetGroupField(g, "expanded", a.GetBool("expanded", true)); RefreshView(); return true; });
            r.Add("timeline.groupDelete", GroupDelete);
            r.Add("timeline.groupMove", GroupMove);

            r.Add("timeline.changes", a => ChangesSummary(Changes(a.GetBool("includeNew", true))));
            r.Add("timeline.keyChanged", a => KeyChanged(a.Has("t") ? a.GetFloat("t") : TL.playbackTime, a.GetBool("includeNew", true), a.GetBool("restKey", true)));
            r.Add("timeline.rebase", a => { Rebase(); return true; });
            r.Add("timeline.setAutoKey", a =>
            {
                if (a.Has("on")) AutoKey = a.GetBool("on");
                if (a.Has("newTracks")) AutoKeyNew = a.GetBool("newTracks", true);
                if (AutoKey) Rebase();
                return new Dictionary<string, object> { { "on", AutoKey }, { "newTracks", AutoKeyNew } };
            });
        }

        /// <summary>
        /// Rebuild Timeline's own track list UI. A failure there (e.g. a broken third-party track whose name
        /// throws) must not abort our edit halfway, so it's logged instead of thrown.
        /// </summary>
        private static void RefreshView()
        {
            try { M_updateView.Invoke(Ready, null); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Timeline view refresh failed: " + (e.InnerException ?? e).Message); }
        }

        /// <summary>
        /// Timeline only resets its tracks when the loaded scene *has* Timeline data. Loading an older scene (or
        /// New) keeps the previous scene's tracks, pointing at deleted objects: they can't play, their names
        /// throw, and they break Timeline's view refresh. Drop tracks whose object no longer exists.
        /// </summary>
        public static int PruneDeadTracks()
        {
            if (!IsReady) return 0;
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) return 0;
            var alive = new HashSet<ObjectCtrlInfo>(studio.dicObjectCtrl.Values);
            var dead = Interpolables.Values.Where(ip => ip.oci != null && !alive.Contains(ip.oci)).ToList();
            foreach (var ip in dead)
            {
                try { M_removeInterpolable.Invoke(Ready, new object[] { ip }); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("prune: " + (e.InnerException ?? e).Message); }
            }
            if (dead.Count > 0)
            {
                StudioBridgePlugin.Logger.LogInfo("Removed " + dead.Count + " timeline track(s) left over from the previous scene");
                RefreshView();
            }
            return dead.Count;
        }

        // =====================================================================
        // Groups (Timeline folders)
        // =====================================================================

        private static readonly Type GroupType = typeof(TL).GetNestedType("InterpolableGroup", BindingFlags.NonPublic);
        private static readonly Type GroupNodeType = typeof(Timeline.GroupNode<>).MakeGenericType(GroupType);

        private static List<Timeline.INode> RootNodes => (List<Timeline.INode>)AccessTools.Property(Tree.GetType(), "tree").GetValue(Tree, null);

        private static IEnumerable<Timeline.INode> AllNodes(List<Timeline.INode> nodes)
        {
            foreach (var n in nodes)
            {
                yield return n;
                if (n is Timeline.IGroupNode)
                {
                    var kids = (List<Timeline.INode>)n.GetType().GetProperty("children").GetValue(n, null);
                    foreach (var k in AllNodes(kids)) yield return k;
                }
            }
        }

        private static Timeline.INode FindGroup(int id)
        {
            foreach (var n in AllNodes(RootNodes))
                if (n is Timeline.IGroupNode && n.GetHashCode() == id) return n;
            throw new BridgeException("Folder not found");
        }

        private static object GroupObj(Timeline.INode groupNode) => groupNode.GetType().GetField("obj").GetValue(groupNode);

        private static void SetGroupField(Timeline.INode groupNode, string field, object value) =>
            GroupType.GetField(field).SetValue(GroupObj(groupNode), value);

        private static object LeafNode(Interpolable ip) => AccessTools.Method(Tree.GetType(), "GetLeafNode").Invoke(Tree, new object[] { ip });

        /// <summary>
        /// Move nodes into a folder (null = top level). Timeline's own Tree.ParentTo prunes emptied folders
        /// upward *before* adding to the target, which can delete the target itself (A ⊃ B ⊃ T, ungroup B →
        /// A is removed and T is attached to a detached folder: invisible, not animated, not saved).
        /// So: move first, then prune emptied folders, never touching the target or its ancestors.
        /// </summary>
        private static void ParentTo(IEnumerable<object> nodes, object groupNode)
        {
            var root = (Timeline.IGroupNode)AccessTools.Field(Tree.GetType(), "_rootGroup").GetValue(Tree);
            var target = groupNode as Timeline.IGroupNode;
            var keep = new HashSet<object>();
            for (var g = target; g != null; g = g.parent) keep.Add(g);
            var emptied = new List<Timeline.IGroupNode>();
            foreach (var o in nodes.ToList())
            {
                var n = o as Timeline.INode;
                if (n == null || ReferenceEquals(n, target) || keep.Contains(n)) continue; // no cycles
                var from = n.parent;
                if (ReferenceEquals(from, target)) continue;
                (from ?? root).children.Remove(n);
                (target ?? root).children.Add(n);
                n.parent = target;
                if (from != null) emptied.Add(from);
            }
            var remove = Tree.GetType().GetMethod("Remove", new[] { typeof(Timeline.INode) });
            foreach (var g0 in emptied)
            {
                var g = g0;
                while (g != null && !keep.Contains(g) && g.children.Count == 0)
                {
                    var up = g.parent;
                    remove.Invoke(Tree, new object[] { g }); // also detaches it from its parent
                    g = up;
                }
            }
        }

        private static object GroupCreate(Dictionary<string, object> a)
        {
            var tracks = TracksFromIds(a.GetList("tracks"));
            if (tracks.Count == 0) throw new BridgeException("Select the tracks to put in the folder");
            var group = Activator.CreateInstance(GroupType, true);
            GroupType.GetField("name").SetValue(group, string.IsNullOrEmpty(a.GetString("name")) ? "New folder" : a.GetString("name"));
            var listType = typeof(List<Interpolable>);
            var leaves = (List<Interpolable>)Activator.CreateInstance(listType);
            leaves.AddRange(tracks);
            var node = AccessTools.Method(Tree.GetType(), "GroupTogether").Invoke(Tree, new[] { (object)leaves, group });
            RefreshView();
            return node.GetHashCode();
        }

        /// <summary>Ungroup: tracks (and sub-folders) move up one level; the folder disappears.</summary>
        private static object GroupDelete(Dictionary<string, object> a)
        {
            var g = FindGroup(a.GetInt("group"));
            var parent = g.parent; // IGroupNode or null (root)
            var kids = ((List<Timeline.INode>)g.GetType().GetProperty("children").GetValue(g, null)).Cast<object>().ToList();
            // Moving the last child out auto-removes the now-empty folder (Tree.ParentTo does that).
            ParentTo(kids, parent != null && parent.GetType() == GroupNodeType ? parent : null);
            RefreshView();
            return kids.Count;
        }

        private static object GroupMove(Dictionary<string, object> a)
        {
            int gid = a.GetInt("group", -1);
            object target = gid == -1 ? null : FindGroup(gid);
            var nodes = TracksFromIds(a.GetList("tracks")).Select(LeafNode).Where(n => n != null).ToList();
            ParentTo(nodes, target);
            RefreshView();
            return nodes.Count;
        }

        // =====================================================================
        // Viewport helpers (motion paths / ghosts)
        // =====================================================================

        public static List<ViewportTools.PathInfo> PositionPaths(HashSet<ObjectCtrlInfo> ocis, bool camera)
        {
            var list = new List<ViewportTools.PathInfo>();
            if (!IsReady) return list;
            foreach (var ip in Interpolables.Values)
            {
                if (!ip.enabled || ip.keyframes.Count == 0 || ip.owner != "Timeline") continue;
                bool isGo = ip.id == "guideObjectPos" && ip.parameter is GuideObject && ip.oci != null && ocis.Contains(ip.oci);
                bool isCam = camera && ip.id == "cameraOPos" && ip.oci == null;
                if (!isGo && !isCam) continue;
                var info = new ViewportTools.PathInfo
                {
                    Guide = ip.parameter as GuideObject,
                    IsCamera = isCam,
                    Times = new List<float>(),
                    Values = new List<Vector3>(),
                    Curves = new List<AnimationCurve>(),
                    Label = SafeName(ip),
                };
                foreach (var kv in ip.keyframes)
                {
                    if (!(kv.Value.value is Vector3 v)) continue;
                    info.Times.Add(kv.Key);
                    info.Values.Add(v);
                    info.Curves.Add(kv.Value.curve);
                }
                if (info.Times.Count > 0) list.Add(info);
            }
            return list;
        }

        /// <summary>Sorted key times of every track on the given objects (for "ghosts at neighbouring keys").</summary>
        public static List<float> KeyTimes(HashSet<ObjectCtrlInfo> ocis)
        {
            var set = new SortedDictionary<float, bool>();
            if (!IsReady) return new List<float>();
            foreach (var ip in Interpolables.Values)
                if (ip.enabled && ip.oci != null && ocis.Contains(ip.oci))
                    foreach (var k in ip.keyframes.Keys) set[(float)Math.Round(k, 4)] = true;
            return set.Keys.ToList();
        }

        // =====================================================================
        // Camera keying ("shots")
        // =====================================================================

        private static readonly string[] CameraModels = { "cameraOPos", "cameraORot", "cameraOZoom", "cameraFOV" };

        private static List<Interpolable> CameraTracks(bool create)
        {
            var list = new List<Interpolable>();
            var dict = Interpolables;
            foreach (var id in CameraModels)
            {
                var ip = dict.Values.FirstOrDefault(x => x.owner == "Timeline" && x.id == id && x.oci == null);
                if (ip == null && create)
                {
                    var model = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == id);
                    if (model == null) continue;
                    var s = Ready;
                    var prev = F_selectedOCI.GetValue(s);
                    F_selectedOCI.SetValue(s, null);
                    try { ip = (Interpolable)M_addInterpolable.Invoke(s, new object[] { model }); }
                    finally { F_selectedOCI.SetValue(s, prev); }
                }
                if (ip != null) list.Add(ip);
            }
            return list;
        }

        /// <summary>
        /// Keys the main camera (origin pos/rot, zoom, FOV) at t. With cut, the key before t gets a
        /// "hold" curve so the camera jumps at t instead of gliding — a hard cut between shots.
        /// </summary>
        public static object KeyCamera(float t, bool cut)
        {
            t = Mathf.Clamp(t, 0f, TL.duration);
            int before = Interpolables.Count;
            var tracks = CameraTracks(true);
            if (tracks.Count == 0) throw new BridgeException("Timeline's camera tracks are unavailable");
            var snap = History.Capture(tracks);
            foreach (var ip in tracks)
            {
                AddOrUpdateKey(ip, t);
                if (cut)
                {
                    TLKeyframe prev = null;
                    foreach (var kv in ip.keyframes) { if (kv.Key < t - 1e-4f) prev = kv.Value; else break; }
                    if (prev != null)
                        prev.curve = new AnimationCurve(new UnityEngine.Keyframe(0f, 0f, 0f, 0f), new UnityEngine.Keyframe(1f, 1f, float.PositiveInfinity, 0f));
                }
            }
            History.Push(snap, cut ? "Camera cut" : "Key camera");
            RefreshView();
            AfterEdit(reapply: false);
            Rebase();
            return new Dictionary<string, object> { { "t", t }, { "tracks", tracks.Count }, { "created", Interpolables.Count - before } };
        }

        /// <summary>Camera keyframe times with whether the camera cuts (holds) into them.</summary>
        public static List<object> CameraShots()
        {
            var tracks = CameraTracks(false);
            var times = new SortedDictionary<float, bool>();
            foreach (var ip in tracks)
            {
                TLKeyframe prev = null;
                foreach (var kv in ip.keyframes)
                {
                    float key = (float)Math.Round(kv.Key, 3);
                    bool isCut = prev != null && prev.curve != null && prev.curve.keys.Any(k => float.IsInfinity(k.outTangent) || float.IsInfinity(k.inTangent));
                    times[key] = (times.TryGetValue(key, out var c) && c) || isCut;
                    prev = kv.Value;
                }
            }
            return times.Select(kv => (object)new Dictionary<string, object> { { "t", kv.Key }, { "cut", kv.Value } }).ToList();
        }

        // =====================================================================
        // Change detection / "key what changed" / auto-key
        // =====================================================================

        public static bool AutoKey;
        public static bool AutoKeyNew = true;

        private struct GoState
        {
            public Vector3 Pos, Rot, Scale;
            public ObjectCtrlInfo Oci;
            public string Label;
        }

        private sealed class Change
        {
            public Interpolable Track;     // existing track whose value changed
            public GuideObject Guide;      // or: a moved guide object without a track
            public ObjectCtrlInfo Oci;
            public string ModelId;         // guideObjectPos / Rot / Scale
            public string Label;
        }

        private static readonly Dictionary<Interpolable, string> TrackBase = new Dictionary<Interpolable, string>();
        private static readonly Dictionary<GuideObject, GoState> GoBase = new Dictionary<GuideObject, GoState>();
        public static int PendingCount;

        // ---- self-animation filter ----
        // Spinning items, physics-driven bones, constraint plugins etc. change on their own. Anything that
        // changes in two consecutive polls is "volatile" and ignored until the scene changes. A real user
        // edit changes once and then holds still ("settled"); auto-key only keys settled changes.
        private static readonly Dictionary<GuideObject, GoState> GoLast = new Dictionary<GuideObject, GoState>();
        private static readonly Dictionary<GuideObject, int> GoConsec = new Dictionary<GuideObject, int>();
        private static readonly HashSet<GuideObject> GoVolatile = new HashSet<GuideObject>();
        private static readonly Dictionary<Interpolable, string> TrackLast = new Dictionary<Interpolable, string>();
        private static readonly Dictionary<Interpolable, int> TrackConsec = new Dictionary<Interpolable, int>();
        private static readonly HashSet<Interpolable> TrackVolatile = new HashSet<Interpolable>();
        // Polls in a row without movement; a volatile thing that holds still this long is trusted again.
        private static readonly Dictionary<object, int> Stable = new Dictionary<object, int>();
        private const int StablePollsToClear = 5; // ~2 s at the 0.4 s change-poll rate

        private static void Track<T>(T key, bool same, Dictionary<T, int> consec, HashSet<T> vol)
        {
            int c = same ? 0 : (consec.TryGetValue(key, out var n) ? n : 0) + 1;
            consec[key] = c;
            if (c >= 2) { vol.Add(key); Stable[key] = 0; }
            else if (same && vol.Contains(key))
            {
                int st = (Stable.TryGetValue(key, out var k) ? k : 0) + 1;
                Stable[key] = st;
                if (st >= StablePollsToClear) { vol.Remove(key); Stable.Remove(key); }
            }
        }

        private static bool SameGo(GoState a, GoState b) =>
            (a.Pos - b.Pos).sqrMagnitude <= 1e-8f && (a.Scale - b.Scale).sqrMagnitude <= 1e-8f &&
            Quaternion.Angle(Quaternion.Euler(a.Rot), Quaternion.Euler(b.Rot)) <= 0.05f;

        /// <summary>Called every poll while not playing: updates the "is it moving by itself" statistics.</summary>
        public static void Observe()
        {
            if (!IsReady || TL.isPlaying) return;
            List<KeyValuePair<GuideObject, GoState>> targets;
            try { targets = new List<KeyValuePair<GuideObject, GoState>>(GuideTargets()); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("observe: " + e.Message); return; }
            foreach (var kv in targets)
            {
                var go = kv.Key;
                if (GoLast.TryGetValue(go, out var last))
                    Track(go, SameGo(last, kv.Value), GoConsec, GoVolatile);
                GoLast[go] = kv.Value;
            }
            foreach (var ip in Interpolables.Values)
            {
                if (!ip.enabled || ip.keyframes.Count == 0) continue;
                string s;
                try { s = ValueString(ip); } catch { continue; }
                if (TrackLast.TryGetValue(ip, out var last))
                    Track(ip, s == last, TrackConsec, TrackVolatile);
                TrackLast[ip] = s;
            }
        }

        public static void ResetVolatility()
        {
            GoLast.Clear(); GoConsec.Clear(); GoVolatile.Clear();
            TrackLast.Clear(); TrackConsec.Clear(); TrackVolatile.Clear();
            Stable.Clear();
        }

        private static bool Settled(GuideObject go) => !GoConsec.TryGetValue(go, out var c) || c == 0;
        private static bool Settled(Interpolable ip) => !TrackConsec.TryGetValue(ip, out var c) || c == 0;

        private static string ValueString(Interpolable ip)
        {
            var d = DescribeValue(ip, ip.GetValue()) as Dictionary<string, object>;
            if (d == null) return "";
            var sb = new System.Text.StringBuilder();
            foreach (var kv in d) sb.Append(kv.Key).Append('=').Append(kv.Value).Append(';');
            return sb.ToString();
        }

        /// <summary>Every guide object a user can move: object roots, active FK bones, active IK targets, item FK.</summary>
        private static IEnumerable<KeyValuePair<GuideObject, GoState>> GuideTargets()
        {
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) yield break;
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                if (oci?.guideObject != null)
                    yield return Pair(oci.guideObject, oci, SceneApi.DisplayName(oci));
                if (oci is OCIChar c)
                {
                    if (c.oiCharInfo.enableFK)
                        foreach (var b in c.listBones)
                            if (b?.guideObject != null && b.active) yield return Pair(b.guideObject, oci, TName(b.guideObject));
                    if (c.oiCharInfo.enableIK)
                        foreach (var ik in c.listIKTarget)
                            if (ik?.guideObject != null && ik.active) yield return Pair(ik.guideObject, oci, TName(ik.guideObject));
                }
                else if (oci is OCIItem it && it.listBones != null && it.itemInfo.enableFK)
                {
                    foreach (var b in it.listBones)
                        if (b?.guideObject != null) yield return Pair(b.guideObject, oci, TName(b.guideObject));
                }
            }
        }

        private static string TName(GuideObject g) => g.transformTarget != null ? g.transformTarget.name : "?";

        private static KeyValuePair<GuideObject, GoState> Pair(GuideObject go, ObjectCtrlInfo oci, string label)
        {
            var ca = go.changeAmount;
            return new KeyValuePair<GuideObject, GoState>(go, new GoState { Pos = ca.pos, Rot = ca.rot, Scale = ca.scale, Oci = oci, Label = label });
        }

        /// <summary>Snapshot the current pose as "unchanged". Called after seeks, playback stops and edits.</summary>
        public static void Rebase()
        {
            if (!IsReady) return;
            // A seek/edit moves everything at once: that's not "moving by itself". Start the movement
            // statistics fresh so two seeks in a row don't mark every animated bone volatile.
            GoLast.Clear(); GoConsec.Clear();
            TrackLast.Clear(); TrackConsec.Clear();
            TrackBase.Clear();
            foreach (var ip in Interpolables.Values)
            {
                if (!ip.enabled || ip.keyframes.Count == 0) continue;
                try { TrackBase[ip] = ValueString(ip); } catch { }
            }
            GoBase.Clear();
            try
            {
                foreach (var kv in GuideTargets())
                    if (!GoBase.ContainsKey(kv.Key)) GoBase.Add(kv.Key, kv.Value);
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("rebase: " + e.Message); }
            PendingCount = 0;
        }

        private static List<Change> Changes(bool includeNew, bool settledOnly = false)
        {
            var list = new List<Change>();
            if (!IsReady || TL.isPlaying) return list;
            var all = Interpolables;

            // Guide objects already covered by a GO track: (guide, modelId)
            var covered = new HashSet<string>();
            foreach (var ip in all.Values)
                if (ip.owner == "Timeline" && ip.parameter is GuideObject g && ip.id.StartsWith("guideObject"))
                    covered.Add(g.GetInstanceID() + "|" + ip.id);

            foreach (var kv in TrackBase)
            {
                var ip = kv.Key;
                if (!all.ContainsKey(ip.GetHashCode()) || TrackVolatile.Contains(ip)) continue;
                if (settledOnly && !Settled(ip)) continue;
                string now;
                try { now = ValueString(ip); } catch { continue; }
                if (now != kv.Value) list.Add(new Change { Track = ip, Oci = ip.oci, Label = SafeName(ip) });
            }

            if (includeNew)
                foreach (var kv in GoBase)
                {
                    var go = kv.Key;
                    if (go == null || GoVolatile.Contains(go)) continue; // destroyed / moves by itself
                    if (settledOnly && !Settled(go)) continue;
                    var st = kv.Value;
                    var ca = go.changeAmount;
                    int id = go.GetInstanceID();
                    if ((ca.pos - st.Pos).sqrMagnitude > 1e-8f && !covered.Contains(id + "|guideObjectPos"))
                        list.Add(new Change { Guide = go, Oci = st.Oci, ModelId = "guideObjectPos", Label = st.Label + " position" });
                    if (Quaternion.Angle(Quaternion.Euler(ca.rot), Quaternion.Euler(st.Rot)) > 0.05f && !covered.Contains(id + "|guideObjectRot"))
                        list.Add(new Change { Guide = go, Oci = st.Oci, ModelId = "guideObjectRot", Label = st.Label + " rotation" });
                    if ((ca.scale - st.Scale).sqrMagnitude > 1e-8f && !covered.Contains(id + "|guideObjectScale"))
                        list.Add(new Change { Guide = go, Oci = st.Oci, ModelId = "guideObjectScale", Label = st.Label + " scale" });
                }
            return list;
        }

        public static object ChangesSummaryPublic() => ChangesSummary(Changes(true));

        private static object ChangesSummary(List<Change> changes)
        {
            PendingCount = changes.Count;
            return new Dictionary<string, object>
            {
                { "count", changes.Count },
                { "items", changes.Take(50).Select(c => (object)new Dictionary<string, object>
                    {
                        { "label", c.Label },
                        { "isNew", c.Track == null },
                        { "oci", c.Oci?.objectInfo != null ? c.Oci.objectInfo.dicKey : -1 },
                        { "track", c.Track != null ? c.Track.GetHashCode() : 0 },
                    }).ToList() },
            };
        }

        /// <summary>
        /// Keys every changed track at <paramref name="t"/>. With includeNew, moved bones/objects that have no
        /// track yet get one; with restKey, those new tracks also get their pre-change value at 0s so the
        /// earlier part of the animation keeps its old pose.
        /// </summary>
        public static object KeyChanged(float t, bool includeNew, bool restKey, bool settledOnly = false)
        {
            var s = Ready;
            t = Mathf.Clamp(t, 0f, TL.duration);
            var changes = Changes(includeNew, settledOnly);
            if (changes.Count == 0) return 0;

            var existing = changes.Where(c => c.Track != null).Select(c => c.Track).Distinct().ToList();
            var snap = History.Capture(existing);
            int keyed = 0;
            foreach (var ip in existing) { AddOrUpdateKey(ip, t); keyed++; }

            var dict = Interpolables;
            foreach (var c in changes.Where(c => c.Track == null))
            {
                var model = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == c.ModelId);
                if (model == null || c.Oci == null) continue;
                var ip = new Interpolable(c.Oci, c.Guide, model);
                if (dict.TryGetValue(ip.GetHashCode(), out var already)) ip = already;
                else
                {
                    dict[ip.GetHashCode()] = ip;
                    AccessTools.Method(Tree.GetType(), "AddLeaf").Invoke(Tree, new object[] { ip, null });
                    snap.Add(new TrackSnapshot { Track = ip, Present = false, Keys = new List<KeyValuePair<float, TLKeyframe>>() });
                }
                if (restKey && t > 1e-4f && GoBase.TryGetValue(c.Guide, out var st) && !ip.keyframes.ContainsKey(0f))
                {
                    object rest = c.ModelId == "guideObjectPos" ? (object)st.Pos : c.ModelId == "guideObjectRot" ? Quaternion.Euler(st.Rot) : (object)st.Scale;
                    ip.keyframes.Add(0f, new TLKeyframe(rest, ip, AnimationCurve.Linear(0f, 0f, 1f, 1f)));
                }
                AddOrUpdateKey(ip, t);
                keyed++;
            }
            History.Push(snap, "Key changes");
            RefreshView();
            AfterEdit(reapply: false);
            if (settledOnly) RebaseKeyed(changes);
            else Rebase();
            return keyed;
        }

        /// <summary>
        /// Auto-key only keys settled changes; a full rebase would also swallow changes that are still in
        /// progress (moved bone B right after A). Only the keyed things become the new baseline.
        /// </summary>
        private static void RebaseKeyed(List<Change> keyed)
        {
            foreach (var c in keyed)
            {
                if (c.Track != null) { try { TrackBase[c.Track] = ValueString(c.Track); } catch { } }
                if (c.Guide != null && c.Oci != null)
                {
                    var ca = c.Guide.changeAmount;
                    GoBase[c.Guide] = new GoState { Pos = ca.pos, Rot = ca.rot, Scale = ca.scale, Oci = c.Oci, Label = c.Label };
                }
            }
            // Tracks created by this key pass start from their current value.
            foreach (var ip in Interpolables.Values)
                if (ip.enabled && ip.keyframes.Count > 0 && !TrackBase.ContainsKey(ip))
                    try { TrackBase[ip] = ValueString(ip); } catch { }
        }
    }
}
