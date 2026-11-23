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
            r.Add("timeline.groupCreate", a => Undoable("New folder", () => GroupCreate(a)));
            r.Add("timeline.groupRename", a => Undoable("Rename folder", () => { var g = FindGroup(a.GetInt("group")); SetGroupField(g, "name", a.GetString("name") ?? "Folder"); RefreshView(); return true; }));
            r.Add("timeline.groupExpand", a => { var g = FindGroup(a.GetInt("group")); SetGroupField(g, "expanded", a.GetBool("expanded", true)); RefreshView(); return true; });
            r.Add("timeline.groupDelete", a => Undoable("Ungroup folder", () => GroupDelete(a)));
            r.Add("timeline.groupMove", a => Undoable("Move to folder", () => GroupMove(a)));

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

        private static Timeline.IGroupNode RootGroup => (Timeline.IGroupNode)AccessTools.Field(Tree.GetType(), "_rootGroup").GetValue(Tree);

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

        /// <summary>A folder change as one step in the shared undo history.</summary>
        private static object Undoable(string label, Func<object> change)
        {
            var before = FolderUndo.Capture(label);
            var r = change();
            UndoStack.Push(before);
            return r;
        }

        /// <summary>
        /// The whole folder tree as it was: every folder (with its name and open state) and every track, in order.
        /// Restoring puts it back exactly; tracks deleted since stay deleted, tracks added since go to the top level.
        /// </summary>
        private sealed class FolderUndo : IUndoEntry
        {
            private struct Entry
            {
                public Timeline.INode Node;
                public Timeline.IGroupNode Parent;
                public string Name;
                public bool Expanded;
            }
            private readonly List<Entry> _entries = new List<Entry>();
            public string Label { get; }
            private FolderUndo(string label) => Label = label;

            public static FolderUndo Capture(string label)
            {
                var u = new FolderUndo(label);
                void Walk(List<Timeline.INode> kids, Timeline.IGroupNode parent)
                {
                    foreach (var n in kids)
                    {
                        var e = new Entry { Node = n, Parent = parent };
                        if (n is Timeline.IGroupNode g)
                        {
                            var obj = GroupObj(n);
                            e.Name = GroupType.GetField("name").GetValue(obj) as string;
                            e.Expanded = (bool)GroupType.GetField("expanded").GetValue(obj);
                            u._entries.Add(e);
                            Walk(g.children, g);
                        }
                        else u._entries.Add(e);
                    }
                }
                Walk(RootNodes, null);
                return u;
            }

            public IUndoEntry Restore()
            {
                var inverse = Capture(Label);
                var root = RootGroup;
                var dict = (System.Collections.IDictionary)AccessTools.Field(Tree.GetType(), "_nodes").GetValue(Tree);
                var all = AllNodes(RootNodes).ToList();
                var leaves = all.Where(n => !(n is Timeline.IGroupNode)).ToList();
                var live = new HashSet<Timeline.INode>(leaves);
                var groupsNow = all.OfType<Timeline.IGroupNode>().ToList();
                var keepGroups = new HashSet<Timeline.INode>(_entries.Where(e => e.Node is Timeline.IGroupNode).Select(e => e.Node));
                foreach (var g in groupsNow) g.children.Clear();
                root.children.Clear();
                foreach (var g in groupsNow)
                    if (!keepGroups.Contains(g)) dict.Remove(g.GetHashCode());
                var placed = new HashSet<Timeline.INode>();
                foreach (var e in _entries)
                {
                    bool isGroup = e.Node is Timeline.IGroupNode;
                    if (!isGroup && !live.Contains(e.Node)) continue; // deleted since: stays deleted
                    (e.Parent ?? root).children.Add(e.Node);
                    e.Node.parent = e.Parent;
                    if (isGroup)
                    {
                        dict[e.Node.GetHashCode()] = e.Node;
                        var obj = GroupObj(e.Node);
                        GroupType.GetField("name").SetValue(obj, e.Name);
                        GroupType.GetField("expanded").SetValue(obj, e.Expanded);
                    }
                    placed.Add(e.Node);
                }
                foreach (var l in leaves)
                    if (!placed.Contains(l))
                    {
                        root.children.Add(l); // added since: top level
                        l.parent = null;
                    }
                // folders left with no tracks inside go, as Timeline itself would have it
                var remove = Tree.GetType().GetMethod("Remove", new[] { typeof(Timeline.INode) });
                bool HasTrack(Timeline.IGroupNode g) => g.children.Any(c => !(c is Timeline.IGroupNode) || HasTrack((Timeline.IGroupNode)c));
                foreach (var g in AllNodes(RootNodes).OfType<Timeline.IGroupNode>().ToList())
                    if (!HasTrack(g)) remove.Invoke(Tree, new object[] { g });
                RefreshView();
                return inverse;
            }

            public bool Absorbs(IUndoEntry next) => false;
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

        public static bool Animated(ObjectCtrlInfo oci) =>
            IsReady && Interpolables.Values.Any(ip => ip.enabled && ip.oci == oci && ip.keyframes.Count >= 2);

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

        /// <summary>The camera tracks (created if needed) and an undo snapshot that removes the ones just created.</summary>
        private static List<Interpolable> CameraTracksForEdit(out List<TrackSnapshot> snap)
        {
            var existing = new HashSet<Interpolable>(CameraTracks(false));
            var tracks = CameraTracks(true);
            snap = History.Capture(tracks);
            foreach (var s in snap)
                if (!existing.Contains(s.Track)) { s.Present = false; s.Keys = new List<KeyValuePair<float, TLKeyframe>>(); }
            return tracks;
        }

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
            var tracks = CameraTracksForEdit(out var snap);
            if (tracks.Count == 0) throw new BridgeException("Timeline's camera tracks are unavailable");
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
        /// <summary>
        /// Does Studio's camera move between s and e by its Timeline keys: a camera key inside, or a keyed move running
        /// through (a key before and one after with different values, not a hold)?
        /// </summary>
        public static bool CameraAnimatedIn(float s, float e)
        {
            foreach (var ip in CameraTracks(false))
            {
                TLKeyframe before = null;
                foreach (var kv in ip.keyframes)
                {
                    if (kv.Key >= s - 1e-4f && kv.Key < e - 1e-4f) return true;
                    if (kv.Key < s) { before = kv.Value; continue; }
                    // the first key after: a move through the whole stretch?
                    if (before != null && !Equals(before.value, kv.Value.value) && !IsHold(before.curve)) return true;
                    break;
                }
            }
            return false;
        }

        private static bool IsHold(AnimationCurve c) => c != null && c.keys.Any(k => float.IsInfinity(k.outTangent) || float.IsInfinity(k.inTangent));

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
            public bool Root; // the object's own transform (else an FK bone / IK target)
        }

        private static string LabelOf(GuideObject go, GoState st) => st.Root ? SceneApi.DisplayName(st.Oci) : TName(go);

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

        /// <summary>
        /// A track's current value as comparable text: Timeline's own XML for it, without parsing it back. During a
        /// change scan (volatility sample + comparison, nothing changes in between) each value is computed once.
        /// </summary>
        private static string ValueString(Interpolable ip)
        {
            if (_scanCache && ValueCache.TryGetValue(ip, out var cached)) return cached;
            var sw = new System.IO.StringWriter(System.Globalization.CultureInfo.InvariantCulture);
            using (var w = new System.Xml.XmlTextWriter(sw))
            {
                w.WriteStartElement("v");
                ip.WriteValueToXml(w, ip.GetValue());
                w.WriteEndElement();
            }
            var text = sw.ToString();
            if (_scanCache) ValueCache[ip] = text;
            return text;
        }

        private static readonly Dictionary<Interpolable, string> ValueCache = new Dictionary<Interpolable, string>();
        private static bool _scanCache;

        /// <summary>The event pump's change scan: values are read once and shared until EndScan.</summary>
        public static void BeginScan() { ValueCache.Clear(); _scanCache = true; }
        public static void EndScan() { _scanCache = false; ValueCache.Clear(); }

        private static long CoverKey(int instanceId, string model) =>
            ((long)instanceId << 2) | (model == "guideObjectPos" ? 1L : model == "guideObjectRot" ? 2L : 3L);

        /// <summary>Every guide object a user can move: object roots, active FK bones, active IK targets, item FK.</summary>
        private static IEnumerable<KeyValuePair<GuideObject, GoState>> GuideTargets()
        {
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) yield break;
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                if (oci?.guideObject != null)
                    yield return Pair(oci.guideObject, oci, true);
                if (oci is OCIChar c)
                {
                    if (c.oiCharInfo.enableFK)
                        foreach (var b in c.listBones)
                            if (b?.guideObject != null && b.active) yield return Pair(b.guideObject, oci, false);
                    if (c.oiCharInfo.enableIK)
                        foreach (var ik in c.listIKTarget)
                            if (ik?.guideObject != null && ik.active) yield return Pair(ik.guideObject, oci, false);
                }
                else if (oci is OCIItem it && it.listBones != null && it.itemInfo.enableFK)
                {
                    foreach (var b in it.listBones)
                        if (b?.guideObject != null) yield return Pair(b.guideObject, oci, false);
                }
            }
        }

        private static string TName(GuideObject g) => g.transformTarget != null ? g.transformTarget.name : "?";

        private static KeyValuePair<GuideObject, GoState> Pair(GuideObject go, ObjectCtrlInfo oci, bool root)
        {
            var ca = go.changeAmount;
            return new KeyValuePair<GuideObject, GoState>(go, new GoState { Pos = ca.pos, Rot = ca.rot, Scale = ca.scale, Oci = oci, Root = root });
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
            GoSeenAt.Clear();
            try
            {
                foreach (var kv in GuideTargets())
                    if (!GoBase.ContainsKey(kv.Key)) GoBase.Add(kv.Key, kv.Value);
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("rebase: " + e.Message); }
            PendingCount = 0;
        }

        private static float _nextGuideScan;
        // when an object was first seen this way: it isn't reported until it has been watched for a moment, so things
        // that move by themselves (spinning effects, physics) get recognised as such first
        private static readonly Dictionary<GuideObject, float> GoSeenAt = new Dictionary<GuideObject, float>();
        private const float NewGuideGrace = 2f;

        /// <summary>
        /// Objects that appeared since the last rebase (a loaded scene, a new item, FK / IK switched on) get their
        /// current state as their baseline the first time they're seen, so later edits to them count as changes.
        /// Throttled: walking every guide object is the expensive part.
        /// </summary>
        private static void AddUnseenGuides()
        {
            if (Time.unscaledTime < _nextGuideScan) return;
            _nextGuideScan = Time.unscaledTime + 1.5f;
            try
            {
                foreach (var kv in GuideTargets())
                    if (kv.Key != null && !GoBase.ContainsKey(kv.Key))
                    {
                        GoBase.Add(kv.Key, kv.Value);
                        GoSeenAt[kv.Key] = Time.unscaledTime;
                    }
                var gone = GoBase.Keys.Where(g => g == null).ToList(); // destroyed with their objects
                foreach (var g in gone) GoBase.Remove(g);
                foreach (var g in GoSeenAt.Keys.Where(g => g == null || Time.unscaledTime - GoSeenAt[g] > NewGuideGrace).ToList()) GoSeenAt.Remove(g);
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("guide scan: " + e.Message); }
        }

        private static List<Change> Changes(bool includeNew, bool settledOnly = false)
        {
            var list = new List<Change>();
            if (!IsReady || TL.isPlaying) return list;
            var all = Interpolables;

            // Guide objects already covered by a GO track: (guide, modelId)
            var covered = new HashSet<long>();
            foreach (var ip in all.Values)
                if (ip.owner == "Timeline" && ip.parameter is GuideObject g && ip.id.StartsWith("guideObject"))
                    covered.Add(CoverKey(g.GetInstanceID(), ip.id));

            foreach (var kv in TrackBase)
            {
                var ip = kv.Key;
                if (!all.ContainsKey(ip.GetHashCode()) || TrackVolatile.Contains(ip)) continue;
                if (settledOnly && !Settled(ip)) continue;
                string now;
                try { now = ValueString(ip); } catch { continue; }
                if (now != kv.Value) list.Add(new Change { Track = ip, Oci = ip.oci, Label = SafeName(ip) });
            }

            if (includeNew) AddUnseenGuides();
            if (includeNew)
                foreach (var kv in GoBase)
                {
                    var go = kv.Key;
                    if (go == null || GoVolatile.Contains(go)) continue; // destroyed / moves by itself
                    if (GoSeenAt.TryGetValue(go, out var seen) && Time.unscaledTime - seen < NewGuideGrace) continue; // just appeared
                    if (settledOnly && !Settled(go)) continue;
                    var st = kv.Value;
                    var ca = go.changeAmount;
                    int id = go.GetInstanceID();
                    if ((ca.pos - st.Pos).sqrMagnitude > 1e-8f && !covered.Contains(CoverKey(id, "guideObjectPos")))
                        list.Add(new Change { Guide = go, Oci = st.Oci, ModelId = "guideObjectPos", Label = LabelOf(go, st) + " position" });
                    if (Quaternion.Angle(Quaternion.Euler(ca.rot), Quaternion.Euler(st.Rot)) > 0.05f && !covered.Contains(CoverKey(id, "guideObjectRot")))
                        list.Add(new Change { Guide = go, Oci = st.Oci, ModelId = "guideObjectRot", Label = LabelOf(go, st) + " rotation" });
                    if ((ca.scale - st.Scale).sqrMagnitude > 1e-8f && !covered.Contains(CoverKey(id, "guideObjectScale")))
                        list.Add(new Change { Guide = go, Oci = st.Oci, ModelId = "guideObjectScale", Label = LabelOf(go, st) + " scale" });
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
            EndScan(); // keying (and a possible re-apply) changes values: no cached reads from here on
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
            // Earlier key edits were held back to protect these changes; once nothing is left unkeyed, show them.
            if (PoseStale && Changes(includeNew, settledOnly).Count == 0)
            {
                Reapply();
                Rebase();
            }
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
                    GoBase[c.Guide] = new GoState { Pos = ca.pos, Rot = ca.rot, Scale = ca.scale, Oci = c.Oci, Root = c.Oci != null && c.Guide == c.Oci.guideObject };
                }
            }
            // Tracks created by this key pass start from their current value.
            foreach (var ip in Interpolables.Values)
                if (ip.enabled && ip.keyframes.Count > 0 && !TrackBase.ContainsKey(ip))
                    try { TrackBase[ip] = ValueString(ip); } catch { }
        }
    }
}
