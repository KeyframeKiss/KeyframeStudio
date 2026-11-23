using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Xml;
using BepInEx.Bootstrap;
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
    /// Entry point that is safe to touch even when Timeline.dll is absent.
    /// Everything that references Timeline types lives in <see cref="TimelineImpl"/>.
    /// </summary>
    internal static class TimelineApi
    {
        private static bool? _available;

        public static bool Available
        {
            get
            {
                // installed AND exposes everything Keyframe Studio reaches into (see Compat)
                if (_available == null) _available = Chainloader.PluginInfos.ContainsKey(StudioBridgePlugin.TimelineGuid) && Probe() == null;
                return _available.Value;
            }
        }

        /// <summary>Null when Timeline is usable; otherwise what's missing.</summary>
        public static string Probe()
        {
            if (!Chainloader.PluginInfos.ContainsKey(StudioBridgePlugin.TimelineGuid)) return "not installed";
            try { return ProbeImpl(); }
            catch (Exception e) { return (e.InnerException ?? e).Message; }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string ProbeImpl() => TimelineImpl.Probe();

        public static void Register(CommandRouter r)
        {
            if (!Available) return;
            RegisterImpl(r);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterImpl(CommandRouter r) => TimelineImpl.Register(r);

        public static void Rebase() { if (Available) RebaseImpl(); }

        // ---- viewport helpers (plain types only, so ViewportTools never touches Timeline types) ----
        public static float PlaybackTime() => Available ? PlaybackTimeImpl() : 0f;
        [MethodImpl(MethodImplOptions.NoInlining)] private static float PlaybackTimeImpl() => TimelineImpl.IsReady ? TL.playbackTime : 0f;
        public static float Duration() => Available ? DurationImpl() : 10f;
        [MethodImpl(MethodImplOptions.NoInlining)] private static float DurationImpl() => TimelineImpl.IsReady ? TL.duration : 10f;
        public static bool Playing() => Available && PlayingImpl();
        [MethodImpl(MethodImplOptions.NoInlining)] private static bool PlayingImpl() => TimelineImpl.IsReady && TL.isPlaying;
        public static void SeekTo(float t) { if (Available) SeekToImpl(t); }
        /// <summary>Stop playback and put the playhead at t.</summary>
        public static void PauseAt(float t) { if (Available) PauseAtImpl(t); }
        [MethodImpl(MethodImplOptions.NoInlining)] private static void PauseAtImpl(float t) { if (TimelineImpl.IsReady) { TL.Pause(); TL.Seek(t); } }
        public static void Play() { if (Available) PlayImpl(); }
        [MethodImpl(MethodImplOptions.NoInlining)] private static void PlayImpl() { if (TimelineImpl.IsReady && !TL.isPlaying) TL.Play(); }
        [MethodImpl(MethodImplOptions.NoInlining)] private static void SeekToImpl(float t) { if (TimelineImpl.IsReady) TL.Seek(t); }
        public static int Pending() => Available ? PendingImpl() : 0;
        public static bool PoseStale() => Available && PoseStaleImpl();
        public static void BeginScan() { if (Available) BeginScanImpl(); }
        public static void EndScan() { if (Available) EndScanImpl(); }
        [MethodImpl(MethodImplOptions.NoInlining)] private static void BeginScanImpl() => TimelineImpl.BeginScan();
        [MethodImpl(MethodImplOptions.NoInlining)] private static void EndScanImpl() => TimelineImpl.EndScan();
        [MethodImpl(MethodImplOptions.NoInlining)] private static bool PoseStaleImpl() => TimelineImpl.PoseStale;
        /// <summary>A seek or playback re-evaluated every track: the pose matches the keys again.</summary>
        public static void PoseFresh() { if (Available) PoseFreshImpl(); }
        [MethodImpl(MethodImplOptions.NoInlining)] private static void PoseFreshImpl() => TimelineImpl.PoseStale = false;
        [MethodImpl(MethodImplOptions.NoInlining)] private static int PendingImpl() => TimelineImpl.PendingCount;
        public static List<ViewportTools.PathInfo> PositionPaths(HashSet<ObjectCtrlInfo> ocis, bool camera) =>
            Available ? PositionPathsImpl(ocis, camera) : new List<ViewportTools.PathInfo>();
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static List<ViewportTools.PathInfo> PositionPathsImpl(HashSet<ObjectCtrlInfo> ocis, bool camera) => TimelineImpl.PositionPaths(ocis, camera);
        /// <summary>The object has an enabled Timeline track with at least two keys (something to trace).</summary>
        public static bool Animated(ObjectCtrlInfo oci) => Available && AnimatedImpl(oci);
        [MethodImpl(MethodImplOptions.NoInlining)] private static bool AnimatedImpl(ObjectCtrlInfo oci) => TimelineImpl.Animated(oci);
        /// <summary>Add (or find) a track of another plugin's model on an object, keyed at keyAt; returns the track id.</summary>
        public static object AddModelTrack(string modelId, string ownerContains, ObjectCtrlInfo oci, float keyAt) =>
            Available ? AddModelTrackImpl(modelId, ownerContains, oci, keyAt) : throw new BridgeException("Timeline is not installed");
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object AddModelTrackImpl(string modelId, string ownerContains, ObjectCtrlInfo oci, float keyAt) => TimelineImpl.AddModelTrack(modelId, ownerContains, oci, keyAt);
        /// <summary>The character's clip is driven by the timeline (Animation Time keys).</summary>
        public static bool ClipDriven(OCIChar c) => Available && ClipDrivenImpl(c);
        [MethodImpl(MethodImplOptions.NoInlining)] private static bool ClipDrivenImpl(OCIChar c) => TimelineImpl.IsReady && TimelineImpl.ClipDriven(c);
        public static bool InterfaceVisible() => Available && InterfaceVisibleImpl();
        [MethodImpl(MethodImplOptions.NoInlining)] private static bool InterfaceVisibleImpl() => TimelineImpl.IsReady && TL.InterfaceVisible;
        public static void SetInterfaceVisible(bool on) { if (Available) SetInterfaceVisibleImpl(on); }
        [MethodImpl(MethodImplOptions.NoInlining)] private static void SetInterfaceVisibleImpl(bool on) { if (TimelineImpl.IsReady) TL.InterfaceVisible = on; }
        public static List<float> KeyTimes(HashSet<ObjectCtrlInfo> ocis) => Available ? KeyTimesImpl(ocis) : new List<float>();
        [MethodImpl(MethodImplOptions.NoInlining)] private static List<float> KeyTimesImpl(HashSet<ObjectCtrlInfo> ocis) => TimelineImpl.KeyTimes(ocis);

        public static void Observe() { if (Available) ObserveImpl(); }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ObserveImpl() => TimelineImpl.Observe();

        public static void ResetVolatility() { if (Available) ResetVolatilityImpl(); }

        public static void PruneDeadTracks() { if (Available) PruneImpl(); }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void PruneImpl() => TimelineImpl.PruneDeadTracks();

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ResetVolatilityImpl() => TimelineImpl.ResetVolatility();

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RebaseImpl() => TimelineImpl.Rebase();

        /// <summary>
        /// Change polling for the event pump: returns (pending change count, keys auto-keyed this call).
        /// Auto-key only fires when no mouse button is held, i.e. after the user finishes a gizmo drag.
        /// </summary>
        public static int[] PollChanges(bool mouseFree) => Available ? PollChangesImpl(mouseFree) : new[] { 0, 0 };

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int[] PollChangesImpl(bool mouseFree)
        {
            if (!TimelineImpl.IsReady || TL.isPlaying) return new[] { TimelineImpl.PendingCount, 0 };
            if (TimelineImpl.AutoKey && mouseFree)
            {
                var keyed = (int)TimelineImpl.KeyChanged(TL.playbackTime, TimelineImpl.AutoKeyNew, true, settledOnly: true);
                if (keyed > 0) return new[] { 0, keyed };
            }
            var d = (Dictionary<string, object>)TimelineImpl.ChangesSummaryPublic();
            return new[] { (int)d["count"], 0 };
        }

        public static void ClearHistory() { UndoStack.Clear(); }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ClearHistoryImpl() => TimelineImpl.ClearHistory();

        /// <summary>Does Studio's camera move by Timeline keys between s and e?</summary>
        public static bool CameraAnimatedIn(float s, float e) => Available && CameraAnimatedInImpl(s, e);

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool CameraAnimatedInImpl(float s, float e) => TimelineImpl.IsReady && TimelineImpl.CameraAnimatedIn(s, e);

        /// <summary>Every frame: keep playback inside the loop range (a shot), if one is set.</summary>
        public static void LoopTick(int clients) { if (Available) LoopTickImpl(clients); }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void LoopTickImpl(int clients) => TimelineImpl.LoopTick(clients);

        /// <summary>Cheap state for per-frame ticks. Null when Timeline is unavailable/not loaded.</summary>
        public static Dictionary<string, object> TickState() => Available ? TickStateImpl() : null;

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static Dictionary<string, object> TickStateImpl() => TimelineImpl.IsReady ? TimelineImpl.State() : null;

        /// <summary>Hash of track/key layout; changes whenever anything in the timeline is edited.</summary>
        public static long Signature() => Available ? SignatureImpl() : 0;

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static long SignatureImpl() => TimelineImpl.IsReady ? TimelineImpl.Signature() : 0;
    }

    internal static partial class TimelineImpl
    {
        // ---- Reflection handles into Timeline's private state ----
        private static readonly FieldInfo F_self = AccessTools.Field(typeof(TL), "_self");
        private static readonly FieldInfo F_loaded = AccessTools.Field(typeof(TL), "_loaded");
        private static readonly FieldInfo F_interpolables = AccessTools.Field(typeof(TL), "_interpolables");
        private static readonly FieldInfo F_tree = AccessTools.Field(typeof(TL), "_interpolablesTree");
        private static readonly FieldInfo F_selectedOCI = AccessTools.Field(typeof(TL), "_selectedOCI");
        private static readonly FieldInfo F_models = AccessTools.Field(typeof(TL), "_interpolableModelsList");
        private static readonly FieldInfo F_duration = AccessTools.Field(typeof(TL), "_duration");
        private static readonly FieldInfo F_fps = AccessTools.Field(typeof(TL), "_desiredFrameRate");
        private static readonly FieldInfo F_fpsField = AccessTools.Field(typeof(TL), "_frameRateInputField");
        private static readonly FieldInfo F_isPlaying = AccessTools.Field(typeof(TL), "_isPlaying");
        private static readonly FieldInfo F_selectedKeyframes = AccessTools.Field(typeof(TL), "_selectedKeyframes");
        private static readonly MethodInfo M_addInterpolable = AccessTools.Method(typeof(TL), "AddInterpolable");
        private static readonly MethodInfo M_removeInterpolable = AccessTools.Method(typeof(TL), "RemoveInterpolable");
        private static readonly MethodInfo M_updateGrid = AccessTools.Method(typeof(TL), "UpdateGrid");
        private static readonly MethodInfo M_updateView = AccessTools.Method(typeof(TL), "UpdateInterpolablesView");
        private static readonly MethodInfo M_updateKeyWindow = AccessTools.Method(typeof(TL), "UpdateKeyframeWindow");
        private static readonly MethodInfo M_interpolate = AccessTools.Method(typeof(TL), "Interpolate");

        private static TL Self => (TL)F_self.GetValue(null);

        /// <summary>Every private Timeline member this bridge uses must exist (they're resolved by name).</summary>
        public static string Probe()
        {
            var missing = new List<string>();
            foreach (var f in typeof(TimelineImpl).GetFields(BindingFlags.NonPublic | BindingFlags.Static))
            {
                if (f.FieldType != typeof(FieldInfo) && f.FieldType != typeof(MethodInfo) && f.FieldType != typeof(Type)) continue;
                if (f.GetValue(null) == null) missing.Add(f.Name.TrimStart('F', 'M', '_'));
            }
            var tree = typeof(TL).GetField("_interpolablesTree", BindingFlags.NonPublic | BindingFlags.Instance)?.FieldType;
            if (tree == null || AccessTools.Field(tree, "_nodes") == null || AccessTools.Field(tree, "_rootGroup") == null) missing.Add("tree internals");
            return missing.Count == 0 ? null : "missing " + string.Join(", ", missing.ToArray());
        }

        public static bool IsReady => Self != null && (bool)F_loaded.GetValue(Self);

        private static TL Ready
        {
            get
            {
                var s = Self;
                if (s == null || !(bool)F_loaded.GetValue(s)) throw new BridgeException("Timeline is not loaded yet");
                return s;
            }
        }

        private static Dictionary<int, Interpolable> Interpolables => (Dictionary<int, Interpolable>)F_interpolables.GetValue(Ready);
        private static List<InterpolableModel> Models => (List<InterpolableModel>)F_models.GetValue(Ready);
        private static object Tree => F_tree.GetValue(Ready);

        public static void ClearHistory() => History.Clear();

        private static float _loopStart = -1f, _loopEnd = -1f;

        /// <summary>
        /// While playing with a loop range set: past its end (or before its start — Timeline wraps at its own end)
        /// the playhead goes back to its start. Checked every frame, so the loop is frame-accurate. The range is
        /// dropped when the app goes away.
        /// </summary>
        public static void LoopTick(int clients)
        {
            if (_loopEnd < 0f || !IsReady) return;
            if (clients == 0) { _loopStart = _loopEnd = -1f; return; }
            if (!TL.isPlaying) return;
            float t = TL.playbackTime;
            float end = Mathf.Min(_loopEnd, TL.duration);
            if (t >= end - 1e-4f || t < _loopStart - 1e-3f) TL.Seek(_loopStart);
        }

        public static void Register(CommandRouter r)
        {
            r.Add("timeline.get", a => Get());
            r.Add("timeline.state", a => State());
            r.Add("timeline.play", a => { if (!TL.isPlaying) TL.Play(); return State(); });
            r.Add("timeline.pause", a => { TL.Pause(); return State(); });
            r.Add("timeline.stop", a => { TL.Stop(); return State(); });
            r.Add("timeline.seek", a => { Seek(a.GetFloat("t")); return State(); });
            r.Add("timeline.setSettings", SetSettings);
            r.Add("timeline.setUiVisible", a => { TL.InterfaceVisible = a.GetBool("visible"); return State(); });
            // loop a stretch while playing (a shot): {start, end} sets it, {} clears it
            r.Add("timeline.loopRange", a =>
            {
                float s0 = a.GetFloat("start", -1f), s1 = a.GetFloat("end", -1f);
                if (a.Has("start") && a.Has("end") && s0 >= 0f && s1 - s0 > 0.05f) { _loopStart = s0; _loopEnd = s1; }
                else _loopStart = _loopEnd = -1f;
                return new Dictionary<string, object> { { "on", _loopEnd > 0f }, { "start", (double)_loopStart }, { "end", (double)_loopEnd } };
            });

            r.Add("timeline.models", ListModels);
            // a character's bones and IK targets, to animate one directly: {oci} → [{kind, index, label, group, animated}]
            r.Add("timeline.bones", ListBones);
            r.Add("timeline.addTrack", AddTrack);
            r.Add("timeline.removeTracks", RemoveTracks);
            r.Add("timeline.setTrack", SetTrack);
            // mute / unmute several tracks at once (a folder, an object): one undo step
            r.Add("timeline.setTracksEnabled", SetTracksEnabled);

            r.Add("timeline.keyInfo", KeyInfo);
            r.Add("timeline.addKeys", AddKeys);
            r.Add("timeline.deleteKeys", DeleteKeys);
            r.Add("timeline.moveKeys", MoveKeys);
            r.Add("timeline.copyKeys", CopyKeys);
            r.Add("timeline.setCurve", SetCurve);

            r.Add("timeline.keyValues", KeyValues);
            r.Add("timeline.setKeyValue", SetKeyValue);
            r.Add("timeline.resetPose", a => ResetPose());
            RegisterExtras(r);
            RegisterCleanup(r);
            RegisterCameraMoves(r);
            RegisterLimbLock(r);
            RegisterAnimTimeline(r);
            RegisterClips(r);

        }

        // =====================================================================
        // Undo / redo — snapshots of the tracks an edit touches
        // =====================================================================

        private sealed class TrackSnapshot
        {
            public Interpolable Track;
            public bool Present;
            public List<KeyValuePair<float, TLKeyframe>> Keys;
            // Where the track sat in the track list: its folders (outermost first, each with its index in its
            // parent) and its own index, so a deleted track comes back in the same place.
            public List<KeyValuePair<Timeline.IGroupNode, int>> Path;
            public int Index = int.MaxValue;
        }

        private sealed class TimelineUndo : IUndoEntry
        {
            private readonly List<TrackSnapshot> _snap;
            public TimelineUndo(List<TrackSnapshot> snap, string label) { _snap = snap; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;

            public IUndoEntry Restore()
            {
                var inverse = new TimelineUndo(History.Capture(_snap.Select(s => s.Track)), Label);
                // lowest positions first, so tracks restored into the same folder land in their original order
                foreach (var s in _snap.OrderBy(x => x.Index)) History.Restore(s);
                RefreshView();
                AfterEdit();
                return inverse;
            }
        }

        private static class History
        {
            public static List<TrackSnapshot> Capture(IEnumerable<Interpolable> tracks)
            {
                var list = new List<TrackSnapshot>();
                var seen = new HashSet<Interpolable>();
                foreach (var ip in tracks)
                {
                    if (ip == null || !seen.Add(ip)) continue;
                    var snap = new TrackSnapshot
                    {
                        Track = ip,
                        Present = Interpolables.ContainsKey(ip.GetHashCode()),
                        Keys = ip.keyframes.Select(kv => new KeyValuePair<float, TLKeyframe>(kv.Key, new TLKeyframe(kv.Value))).ToList(),
                    };
                    if (snap.Present) CapturePlace(snap);
                    list.Add(snap);
                }
                return list;
            }

            private static void CapturePlace(TrackSnapshot snap)
            {
                try
                {
                    var leaf = LeafNode(snap.Track) as Timeline.INode;
                    if (leaf == null) return;
                    var root = RootGroup;
                    snap.Index = (leaf.parent ?? root).children.IndexOf(leaf);
                    var path = new List<KeyValuePair<Timeline.IGroupNode, int>>();
                    for (var g = leaf.parent; g != null; g = g.parent)
                        path.Insert(0, new KeyValuePair<Timeline.IGroupNode, int>(g, (g.parent ?? root).children.IndexOf(g)));
                    snap.Path = path;
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("Track place not recorded: " + e.Message); }
            }

            /// <summary>
            /// Put a re-added track back where it was. Timeline prunes a folder when its last track is deleted, so
            /// folders on the way that are no longer in the tree are re-attached (same node: same id, name, state).
            /// </summary>
            private static void PlaceBack(TrackSnapshot s)
            {
                var root = RootGroup;
                var nodes = (System.Collections.IDictionary)AccessTools.Field(Tree.GetType(), "_nodes").GetValue(Tree);
                Timeline.IGroupNode parent = null;
                if (s.Path != null)
                    foreach (var kv in s.Path)
                    {
                        var g = kv.Key;
                        int key = g.GetHashCode();
                        if (!nodes.Contains(key))
                        {
                            var list = (parent ?? root).children;
                            list.Insert(Mathf.Clamp(kv.Value, 0, list.Count), g);
                            g.parent = parent;
                            nodes[key] = g;
                        }
                        else if (!ReferenceEquals(nodes[key], g)) break; // replaced by another folder: stop here
                        parent = g;
                    }
                var leaf = (Timeline.INode)AccessTools.Method(Tree.GetType(), "AddLeaf").Invoke(Tree, new object[] { s.Track, parent });
                if (leaf == null || s.Index == int.MaxValue) return;
                var siblings = (leaf.parent ?? root).children;
                if (siblings.Remove(leaf)) siblings.Insert(Mathf.Clamp(s.Index, 0, siblings.Count), leaf);
            }

            /// <summary>Call before mutating the given tracks.</summary>
            public static void Record(IEnumerable<Interpolable> tracks) => Push(Capture(tracks));

            public static void Push(List<TrackSnapshot> snap, string label = "Animation edit")
            {
                if (snap.Count == 0) return;
                UndoStack.Push(new TimelineUndo(snap, label));
            }

            public static void Clear() => UndoStack.Clear();

            public static void Restore(TrackSnapshot s)
            {
                // Object was deleted since the snapshot — don't resurrect orphan tracks.
                if (s.Track.oci != null && !Singleton<Studio.Studio>.Instance.dicObjectCtrl.ContainsValue(s.Track.oci)) return;
                var self = Ready;
                var dict = Interpolables;
                bool present = dict.TryGetValue(s.Track.GetHashCode(), out var live);
                if (s.Present && !present)
                {
                    dict[s.Track.GetHashCode()] = s.Track;
                    try { PlaceBack(s); }
                    catch (Exception e)
                    {
                        StudioBridgePlugin.Logger.LogDebug("Track restored at the top level: " + e.Message);
                        if (LeafNode(s.Track) == null) AccessTools.Method(Tree.GetType(), "AddLeaf").Invoke(Tree, new object[] { s.Track, null });
                    }
                    live = s.Track;
                }
                else if (!s.Present && present)
                {
                    M_removeInterpolable.Invoke(self, new object[] { live });
                    return;
                }
                // The track may have been deleted and re-created (same hash, new instance) since the snapshot:
                // write into the instance Timeline actually uses.
                var target = live ?? s.Track;
                target.keyframes.Clear();
                foreach (var kv in s.Keys) target.keyframes[kv.Key] = new TLKeyframe(kv.Value.value, target, new AnimationCurve(kv.Value.curve.keys));
            }
        }

        // =====================================================================
        // State / read
        // =====================================================================

        public static Dictionary<string, object> State()
        {
            var s = Ready;
            return new Dictionary<string, object>
            {
                { "playing", TL.isPlaying },
                { "time", TL.playbackTime },
                { "duration", TL.duration },
                { "fps", (int)F_fps.GetValue(s) },
                { "speed", Time.timeScale },
                { "uiVisible", TL.InterfaceVisible },
                { "pending", PendingCount },
                { "poseStale", PoseStale },
            };
        }

        private static object Get()
        {
            var state = State();
            var groups = new List<object>();
            var tracks = new List<object>();
            var rootNodes = (List<Timeline.INode>)AccessTools.Property(Tree.GetType(), "tree").GetValue(Tree, null);
            _walkOrder = 0;
            WalkTree(rootNodes, -1, groups, tracks);
            state["groups"] = groups;
            state["tracks"] = tracks;
            return state;
        }

        private static int _walkOrder;

        private static void WalkTree(List<Timeline.INode> nodes, int parentGroup, List<object> groups, List<object> tracks)
        {
            foreach (var node in nodes)
            {
                if (node is Timeline.LeafNode<Interpolable> leaf)
                {
                    if (leaf.obj == null) continue;
                    // One broken track (e.g. a mod's name callback throwing) must not hide all the others.
                    try { var td = SerializeTrack(leaf.obj, parentGroup); td["order"] = _walkOrder++; tracks.Add(td); }
                    catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("Skipping track " + leaf.obj.id + ": " + e.Message); }
                }
                else if (node is Timeline.IGroupNode)
                {
                    // GroupNode<InterpolableGroup> — InterpolableGroup is private, so go through reflection.
                    var t = node.GetType();
                    var obj = t.GetField("obj").GetValue(node);
                    int gid = node.GetHashCode();
                    groups.Add(new Dictionary<string, object>
                    {
                        { "id", gid },
                        { "parent", parentGroup },
                        { "order", _walkOrder++ },
                        { "name", obj?.GetType().GetField("name")?.GetValue(obj) as string ?? "Group" },
                        { "expanded", obj?.GetType().GetField("expanded")?.GetValue(obj) as bool? ?? true },
                    });
                    var children = (List<Timeline.INode>)t.GetProperty("children").GetValue(node, null);
                    WalkTree(children, gid, groups, tracks);
                }
            }
        }

        private static Dictionary<string, object> SerializeTrack(Interpolable ip, int group)
        {
            var keys = new List<object>(ip.keyframes.Count);
            foreach (var kv in ip.keyframes)
            {
                var k = new List<object>(2) { kv.Key };
                var curve = CurveToList(kv.Value.curve);
                if (curve != null) k.Add(curve);
                keys.Add(k);
            }
            string name = SafeName(ip);
            var d = new Dictionary<string, object>
            {
                { "id", ip.GetHashCode() },
                { "name", name },
                { "alias", ip.alias },
                { "owner", ip.owner },
                { "model", ip.id },
                { "oci", ip.oci?.objectInfo != null ? ip.oci.objectInfo.dicKey : -1 },
                { "enabled", ip.enabled },
                { "color", new List<object> { ip.color.r, ip.color.g, ip.color.b } },
                { "group", group },
                { "keys", keys },
            };
            string tr = Translation.Get(name, true, "Track");
            if (tr != null) d["nameEn"] = tr;
            return d;
        }

        /// <summary>
        /// Interpolable.name runs the owner's getFinalName callback, which can throw for some tracks
        /// (Timeline's own UI only evaluates it for the selected object). Fall back to the raw model name.
        /// </summary>
        private static string SafeName(Interpolable ip)
        {
            try
            {
                var n = ip.name;
                if (!string.IsNullOrEmpty(n)) return n;
            }
            catch { }
            try
            {
                var raw = AccessTools.Field(typeof(InterpolableModel), "_name").GetValue(ip) as string;
                if (!string.IsNullOrEmpty(raw)) return raw;
            }
            catch { }
            return ip.id ?? "Track";
        }

        /// <summary>Flattened [t,v,in,out, t,v,in,out, ...], or null for the default linear curve.</summary>
        private static List<object> CurveToList(AnimationCurve c)
        {
            if (c == null) return null;
            var keys = c.keys;
            // Linear: only the inner tangents matter (first key's in / last key's out are never evaluated).
            if (keys.Length == 2 &&
                keys[0].time == 0f && keys[0].value == 0f && keys[0].outTangent == 1f &&
                keys[1].time == 1f && keys[1].value == 1f && keys[1].inTangent == 1f)
                return null;
            var l = new List<object>(keys.Length * 4);
            foreach (var k in keys) { l.Add(k.time); l.Add(k.value); l.Add(k.inTangent); l.Add(k.outTangent); }
            return l;
        }

        private static AnimationCurve ListToCurve(List<object> l)
        {
            if (l == null || l.Count < 8 || l.Count % 4 != 0) return AnimationCurve.Linear(0f, 0f, 1f, 1f);
            var keys = new UnityEngine.Keyframe[l.Count / 4];
            for (int i = 0; i < keys.Length; i++)
            {
                float time = F(l[i * 4]), value = F(l[i * 4 + 1]);
                if (float.IsNaN(time) || float.IsInfinity(time) || float.IsNaN(value) || float.IsInfinity(value))
                    throw new BridgeException("Invalid curve point");
                // Infinite tangents (stepped/hold curves) come back from JSON.stringify as null.
                keys[i] = new UnityEngine.Keyframe(time, value, Tan(l[i * 4 + 2]), Tan(l[i * 4 + 3]));
            }
            return new AnimationCurve(keys);
        }

        private static float Tan(object o)
        {
            float f = F(o);
            return float.IsNaN(f) ? float.PositiveInfinity : f;
        }

        private static float F(object o)
        {
            if (o == null) return float.NaN;
            double d = Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture);
            if (d > float.MaxValue) return float.PositiveInfinity;
            if (d < float.MinValue) return float.NegativeInfinity;
            return (float)d;
        }

        /// <summary>Bumped by every edit we make, so value/curve edits (same key count) still change the signature.</summary>
        private static long _editVersion;

        public static long Signature()
        {
            unchecked
            {
                long h = 17 + _editVersion * 7919;
                foreach (var ip in Interpolables.Values)
                {
                    h = h * 31 + ip.GetHashCode();
                    h = h * 31 + (ip.enabled ? 1 : 0);
                    h = h * 31 + (ip.alias?.GetHashCode() ?? 0);
                    foreach (var kv in ip.keyframes)
                    {
                        h = h * 31 + kv.Key.GetHashCode();
                        h = h * 31 + RuntimeHelpers.GetHashCode(kv.Value);
                        h = h * 31 + (kv.Value.curve?.length ?? 0);
                        h = h * 31 + (kv.Value.value?.GetHashCode() ?? 0); // value edits (also from Timeline's own UI)
                    }
                }
                return h;
            }
        }

        // =====================================================================
        // Transport / settings
        // =====================================================================

        private static void Seek(float t)
        {
            t = Mathf.Clamp(t, 0f, TL.duration);
            if (Mathf.Approximately(t, TL.playbackTime)) Reapply();
            else TL.Seek(t);
        }

        /// <summary>Re-evaluate every track at the current time (after edits) — mirrors SeekPlaybackTime.</summary>
        private static void Reapply()
        {
            var s = Ready;
            bool was = (bool)F_isPlaying.GetValue(s);
            F_isPlaying.SetValue(s, true);
            try
            {
                M_interpolate.Invoke(s, new object[] { true });
                M_interpolate.Invoke(s, new object[] { false });
            }
            finally { F_isPlaying.SetValue(s, was); }
            PoseStale = false;
        }

        /// <summary>
        /// Key edits were made but not shown on the pose (there were unkeyed changes to protect). While set, the
        /// change baseline is kept, so those unkeyed changes stay counted and protected across further edits.
        /// </summary>
        public static bool PoseStale;

        /// <summary>Throw away unkeyed changes: the pose goes back to what the keys say (and shows deferred edits).</summary>
        private static object ResetPose()
        {
            Reapply();
            Rebase();
            return true;
        }

        private static object SetSettings(Dictionary<string, object> a)
        {
            var s = Ready;
            if (a.Has("duration"))
            {
                float d = Mathf.Max(0.01f, a.GetFloat("duration"));
                F_duration.SetValue(s, d);
                RefreshView();
            }
            if (a.Has("fps"))
            {
                int fps = Mathf.Clamp(a.GetInt("fps"), 1, 240);
                F_fps.SetValue(s, fps);
                var field = F_fpsField.GetValue(s) as UnityEngine.UI.InputField;
                if (field != null) field.text = fps.ToString();
            }
            if (a.Has("speed")) Time.timeScale = Mathf.Max(0f, a.GetFloat("speed"));
            return State();
        }

        // =====================================================================
        // Tracks
        // =====================================================================

        private static Interpolable Track(object id)
        {
            int key = Convert.ToInt32(id);
            if (!Interpolables.TryGetValue(key, out var ip)) throw new BridgeException("Track not found (it may have been deleted)");
            return ip;
        }

        private static object ListModels(Dictionary<string, object> a)
        {
            ObjectCtrlInfo oci = a.Has("oci") ? SceneApi.FindOci(a.GetInt("oci")) : null;
            var list = new List<object>();
            foreach (var m in Models)
            {
                bool ok;
                try { ok = m.IsCompatibleWithTarget(oci); } catch { ok = false; }
                if (!ok) continue;
                string mname;
                try { mname = m.name ?? m.id; } catch { mname = m.id; }
                var d = new Dictionary<string, object> { { "owner", m.owner }, { "id", m.id }, { "name", mname } };
                string tr = Translation.Get(mname, false, "Track type");
                if (tr != null) d["nameEn"] = tr;
                list.Add(d);
            }
            return list;
        }

        /// <summary>A character's FK bones and IK targets, grouped the way people think of a body.</summary>
        private static object ListBones(Dictionary<string, object> a)
        {
            if (!(SceneApi.FindOci(a.GetInt("oci", -1)) is OCIChar c)) return new List<object>();
            // what's animated already: guide objects with GO tracks
            var animated = new Dictionary<GuideObject, List<object>>();
            foreach (var ip in Interpolables.Values)
                if (ip.owner == "Timeline" && ip.oci == c && ip.parameter is GuideObject g && ip.id.StartsWith("guideObject"))
                {
                    if (!animated.TryGetValue(g, out var l)) animated[g] = l = new List<object>();
                    l.Add(ip.id == "guideObjectRot" ? "rot" : ip.id == "guideObjectPos" ? "pos" : "scale");
                }
            var list = new List<object>();
            for (int i = 0; i < c.listBones.Count; i++)
            {
                var b = c.listBones[i];
                var g = b?.guideObject;
                var name = g?.transformTarget?.name;
                if (name == null) continue;
                list.Add(new Dictionary<string, object>
                {
                    { "kind", "bone" }, { "index", i }, { "name", name }, { "label", ViewportGizmos.Pretty(name) },
                    { "group", BoneGroupLabel(b.boneGroup, name) },
                    { "animated", animated.TryGetValue(g, out var l) ? l : new List<object>() },
                });
            }
            for (int i = 0; i < c.listIKTarget.Count; i++)
            {
                var k = c.listIKTarget[i];
                var g = k?.guideObject;
                if (g == null) continue;
                list.Add(new Dictionary<string, object>
                {
                    { "kind", "ik" }, { "index", i }, { "name", k.targetObject?.name ?? "" }, { "label", "IK " + ViewportGizmos.Pretty(k.targetObject?.name) },
                    { "group", "IK targets" }, { "canRotate", g.enableRot },
                    { "animated", animated.TryGetValue(g, out var l) ? l : new List<object>() },
                });
            }
            return list;
        }

        private static string BoneGroupLabel(OIBoneInfo.BoneGroup g, string n)
        {
            if ((g & OIBoneInfo.BoneGroup.Hair) != 0) return "Hair";
            if ((g & OIBoneInfo.BoneGroup.Skirt) != 0) return "Skirt";
            if ((g & OIBoneInfo.BoneGroup.Breast) != 0) return "Chest";
            if ((g & OIBoneInfo.BoneGroup.Neck) != 0) return "Head & neck";
            if ((g & OIBoneInfo.BoneGroup.LeftHand) != 0) return "Left fingers";
            if ((g & OIBoneInfo.BoneGroup.RightHand) != 0) return "Right fingers";
            bool left = n.EndsWith("_L"), right = n.EndsWith("_R");
            if ((left || right) && (n.Contains("shoulder") || n.Contains("arm") || n.Contains("hand") || n.Contains("elbo") || n.Contains("wrist")))
                return left ? "Left arm" : "Right arm";
            if ((left || right) && (n.Contains("thigh") || n.Contains("leg") || n.Contains("foot") || n.Contains("toe") || n.Contains("knee") || n.Contains("ankle")))
                return left ? "Left leg" : "Right leg";
            if (n.Contains("neck") || n.Contains("head")) return "Head & neck";
            return "Body";
        }

        public static object AddModelTrack(string modelId, string ownerContains, ObjectCtrlInfo oci, float keyAt)
        {
            var model = Models.FirstOrDefault(m => m.id == modelId && m.owner != null && m.owner.IndexOf(ownerContains, StringComparison.OrdinalIgnoreCase) >= 0)
                ?? throw new BridgeException("Timeline has no " + ownerContains + " track type " + modelId);
            return AddTrack(new Dictionary<string, object> { { "owner", model.owner }, { "model", model.id }, { "oci", oci.objectInfo.dicKey }, { "keyAt", keyAt } });
        }

        private static object AddTrack(Dictionary<string, object> a)
        {
            var s = Ready;
            string owner = a.GetString("owner"), id = a.GetString("model");
            var model = Models.FirstOrDefault(m => m.owner == owner && m.id == id);
            if (model == null) throw new BridgeException("Unknown track type " + owner + "/" + id);
            ObjectCtrlInfo oci = a.Has("oci") ? SceneApi.FindOci(a.GetInt("oci")) : null;

            int before = Interpolables.Count;
            Interpolable ip;
            if (model.owner == "Timeline" && model.id.StartsWith("guideObject") && oci != null)
            {
                // Timeline's GuideObject Pos/Rot/Scale models take their target from Studio's *selected gizmo*,
                // not from the OCI. Bind explicitly to this object's own guide object.
                var guide = oci.guideObject;
                if (oci is OCIChar oc && a.Has("bone"))
                {
                    // one of the character's bones: it needs FK on its part for the track to show (from the pose on screen)
                    int bi = a.GetInt("bone", -1);
                    if (bi < 0 || bi >= oc.listBones.Count) throw new BridgeException("No such bone");
                    ViewportGizmos.EnsureFk(oc, bi);
                    guide = oc.listBones[bi].guideObject;
                }
                else if (oci is OCIChar oc2 && a.Has("ik"))
                {
                    int ii = a.GetInt("ik", -1);
                    if (ii < 0 || ii >= oc2.listIKTarget.Count) throw new BridgeException("No such IK target");
                    ViewportGizmos.EnsureIk(oc2, ii);
                    guide = oc2.listIKTarget[ii].guideObject;
                }
                if (guide == null) throw new BridgeException("That object has no transform to animate");
                ip = new Interpolable(oci, guide, model);
                if (Interpolables.TryGetValue(ip.GetHashCode(), out var already)) ip = already;
                else
                {
                    Interpolables[ip.GetHashCode()] = ip;
                    AccessTools.Method(Tree.GetType(), "AddLeaf").Invoke(Tree, new object[] { ip, null });
                }
            }
            else
            {
                // AddInterpolable targets Timeline's "selected OCI"; swap it in temporarily.
                var prev = F_selectedOCI.GetValue(s);
                F_selectedOCI.SetValue(s, oci);
                try { ip = (Interpolable)M_addInterpolable.Invoke(s, new object[] { model }); }
                finally { F_selectedOCI.SetValue(s, prev); }
            }
            if (ip == null) throw new BridgeException("This track type can't be added to that object");

            if (Interpolables.Count > before)
                History.Push(new List<TrackSnapshot> { new TrackSnapshot { Track = ip, Present = false, Keys = new List<KeyValuePair<float, TLKeyframe>>() } });
            else if (a.Has("keyAt"))
                History.Record(new[] { ip });

            if (a.Has("keyAt")) AddOrUpdateKey(ip, a.GetFloat("keyAt"));
            AfterEdit();
            return ip.GetHashCode();
        }

        private static object RemoveTracks(Dictionary<string, object> a)
        {
            var s = Ready;
            var targets = TracksFromIds(a.GetList("tracks"));
            History.Record(targets);
            foreach (var ip in targets) M_removeInterpolable.Invoke(s, new object[] { ip });
            int n = targets.Count;
            AfterEdit();
            return n;
        }

        private static object SetTracksEnabled(Dictionary<string, object> a)
        {
            var targets = TracksFromIds(a.GetList("tracks"));
            bool on = a.GetBool("enabled", true);
            var change = targets.Where(ip => ip.enabled != on).ToList();
            if (change.Count == 0) return 0;
            UndoStack.Push(new MuteUndo(change.ToDictionary(ip => ip, ip => ip.enabled), on ? "Unmute tracks" : "Mute tracks"));
            foreach (var ip in change) ip.enabled = on;
            RefreshView();
            AfterEdit();
            return change.Count;
        }

        private sealed class MuteUndo : IUndoEntry
        {
            private readonly Dictionary<Interpolable, bool> _was;
            public MuteUndo(Dictionary<Interpolable, bool> was, string label) { _was = was; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var live = _was.Keys.Where(ip => Interpolables.ContainsKey(ip.GetHashCode())).ToList();
                var inverse = new MuteUndo(live.ToDictionary(ip => ip, ip => ip.enabled), Label);
                foreach (var ip in live) ip.enabled = _was[ip];
                RefreshView();
                AfterEdit();
                return inverse;
            }
        }

        private static object SetTrack(Dictionary<string, object> a)
        {
            var ip = Track(a["track"]);
            if (a.Has("enabled")) ip.enabled = a.GetBool("enabled", true);
            if (a.ContainsKey("alias")) ip.alias = a.GetString("alias") ?? "";
            if (a.Has("color"))
            {
                var c = a.GetList("color");
                if (c.Count >= 3) ip.color = new Color(F(c[0]), F(c[1]), F(c[2]));
            }
            RefreshView();
            AfterEdit();
            return SerializeTrack(ip, -1);
        }

        // =====================================================================
        // Keys
        // =====================================================================

        /// <summary>Find a key by time, tolerating float→double→float noise.</summary>
        private static bool FindKey(Interpolable ip, float t, out float exact)
        {
            if (ip.keyframes.ContainsKey(t)) { exact = t; return true; }
            foreach (var k in ip.keyframes.Keys)
                if (Mathf.Abs(k - t) < 1e-4f) { exact = k; return true; }
            exact = t;
            return false;
        }

        private struct KeyRef
        {
            public Interpolable Track;
            public float Time;
            public int Index; // position in the request's "keys" list (stays aligned with "toTracks")
        }

        private static List<Interpolable> TracksFromIds(List<object> ids)
        {
            var list = new List<Interpolable>();
            foreach (var id in ids)
                if (id != null && Interpolables.TryGetValue(Convert.ToInt32(id), out var ip) && !list.Contains(ip))
                    list.Add(ip);
            return list;
        }

        private static List<KeyRef> KeyRefs(Dictionary<string, object> a)
        {
            var list = new List<KeyRef>();
            var keys = a.GetList("keys");
            for (int i = 0; i < keys.Count; i++)
            {
                var k = keys[i] as Dictionary<string, object>;
                if (k == null) continue;
                if (!Interpolables.TryGetValue(k.GetInt("track"), out var ip)) continue;
                if (!FindKey(ip, k.GetFloat("t"), out var exact)) continue;
                list.Add(new KeyRef { Track = ip, Time = exact, Index = i });
            }
            return list;
        }

        private static void AddOrUpdateKey(Interpolable ip, float t)
        {
            object value = ip.GetValue();
            if (FindKey(ip, t, out var exact))
            {
                ip.keyframes[exact].value = value;
                return;
            }
            // Inherit the curve of the previous key, like Timeline does.
            TLKeyframe prev = null;
            foreach (var kv in ip.keyframes) { if (kv.Key < t) prev = kv.Value; else break; }
            var curve = prev != null ? new AnimationCurve(prev.curve.keys) : AnimationCurve.Linear(0f, 0f, 1f, 1f);
            ip.keyframes.Add(t, new TLKeyframe(value, ip, curve));
        }

        private static object AddKeys(Dictionary<string, object> a)
        {
            float t = Mathf.Clamp(a.Has("t") ? a.GetFloat("t") : TL.playbackTime, 0f, TL.duration);
            var targets = TracksFromIds(a.GetList("tracks"));
            History.Record(targets);
            foreach (var ip in targets) AddOrUpdateKey(ip, t);
            int n = targets.Count;
            // what these tracks show now is keyed: no longer an unkeyed change (other changes stay counted)
            foreach (var ip in targets) { try { TrackBase[ip] = ValueString(ip); } catch { } }
            AfterEdit(reapply: false); // keep the pose the user just set
            return n;
        }

        private static object DeleteKeys(Dictionary<string, object> a)
        {
            int n = 0;
            var refs = KeyRefs(a);
            History.Record(refs.Select(r => r.Track));
            foreach (var k in refs)
                if (k.Track.keyframes.Remove(k.Time)) n++;
            AfterEdit();
            return n;
        }

        /// <summary>
        /// args: {keys:[{track,t}], dt}  — shifts all keys by dt, atomically.
        /// Fails (no change) if any key would land on an unmoved key or go below 0.
        /// </summary>
        private static object MoveKeys(Dictionary<string, object> a)
        {
            float dt = a.GetFloat("dt");
            var refs = KeyRefs(a);
            if (refs.Count == 0 || dt == 0f) return 0;

            var byTrack = refs.GroupBy(r => r.Track).ToList();
            foreach (var g in byTrack)
            {
                var moving = new HashSet<float>(g.Select(r => r.Time));
                foreach (var r in g)
                {
                    float to = r.Time + dt;
                    if (to < -1e-5f) throw new BridgeException("Can't move keys before 0");
                    if (to > TL.duration + 1e-4f) throw new BridgeException("Can't move keys past the end (" + TL.duration.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "s) — make the timeline longer first");
                    foreach (var existing in g.Key.keyframes.Keys)
                        if (!moving.Contains(existing) && Mathf.Abs(existing - to) < 1e-4f)
                            throw new BridgeException("A key already exists at " + to.ToString("0.###") + "s on " + SafeName(g.Key));
                }
            }
            History.Record(byTrack.Select(g => g.Key));
            foreach (var g in byTrack)
            {
                var pulled =g.Select(r => new KeyValuePair<float, TLKeyframe>(r.Time, g.Key.keyframes[r.Time])).ToList();
                foreach (var p in pulled) g.Key.keyframes.Remove(p.Key);
                foreach (var p in pulled) g.Key.keyframes[Mathf.Max(0f, p.Key + dt)] = p.Value;
            }
            AfterEdit();
            return refs.Count;
        }

        /// <summary>args: {keys:[{track,t}], dt, toTracks?:[id per key]} — duplicates keys at t+dt (overwrites).</summary>
        private static object CopyKeys(Dictionary<string, object> a)
        {
            float dt = a.GetFloat("dt");
            var refs = KeyRefs(a);
            var toTracks = a.GetList("toTracks");
            var copies = new List<KeyValuePair<Interpolable, KeyValuePair<float, TLKeyframe>>>();
            for (int i = 0; i < refs.Count; i++)
            {
                var src = refs[i].Track;
                var dest = src;
                int ti = refs[i].Index; // original index: a skipped (stale) key must not shift the destinations
                if (ti < toTracks.Count && toTracks[ti] != null)
                {
                    // a destination that's gone (deleted object, reloaded scene) must not fall back onto the source track
                    if (!Interpolables.TryGetValue(Convert.ToInt32(toTracks[ti]), out var d)) continue;
                    if (d.owner != src.owner || d.id != src.id) continue; // incompatible value types
                    dest = d;
                }
                var kf = src.keyframes[refs[i].Time];
                float at = refs[i].Time + dt;
                if (at < -1e-4f || at > TL.duration + 1e-4f) continue; // outside the timeline: don't pile keys up at the ends
                var clone = new TLKeyframe(kf.value, dest, new AnimationCurve(kf.curve.keys));
                copies.Add(new KeyValuePair<Interpolable, KeyValuePair<float, TLKeyframe>>(dest,
                    new KeyValuePair<float, TLKeyframe>(Mathf.Clamp(at, 0f, TL.duration), clone)));
            }
            History.Record(copies.Select(c => c.Key));
            foreach (var c in copies)
            {
                FindKey(c.Key, c.Value.Key, out var exact);
                c.Key.keyframes[exact] = c.Value.Value;
            }
            AfterEdit();
            return copies.Count;
        }

        private static object SetCurve(Dictionary<string, object> a)
        {
            var curveList = a.GetList("curve");
            int n = 0;
            var refs = KeyRefs(a);
            History.Record(refs.Select(r => r.Track));
            foreach (var k in refs)
            {
                k.Track.keyframes[k.Time].curve = ListToCurve(curveList);
                n++;
            }
            AfterEdit();
            return n;
        }

        private static object KeyInfo(Dictionary<string, object> a)
        {
            var ip = Track(a["track"]);
            if (!FindKey(ip, a.GetFloat("t"), out var exact)) throw new BridgeException("Key not found");
            var kf = ip.keyframes[exact];
            return new Dictionary<string, object>
            {
                { "t", exact },
                { "value", DescribeValue(ip, kf.value) },
                { "curve", CurveToList(kf.curve) ?? new List<object> { 0f, 0f, 1f, 1f, 1f, 1f, 1f, 1f } },
            };
        }

        /// <summary>
        /// Numeric view of key values for the graph editor: {track: [[t, {attr: number}], ...]}.
        /// Non-numeric attributes are dropped; tracks with no numeric attributes come back empty.
        /// </summary>
        private static object KeyValues(Dictionary<string, object> a)
        {
            var result = new Dictionary<string, object>();
            foreach (var ip in TracksFromIds(a.GetList("tracks")))
            {
                var keys = new List<object>();
                foreach (var kv in ip.keyframes)
                {
                    var nums = new Dictionary<string, object>();
                    if (DescribeValue(ip, kv.Value.value) is Dictionary<string, object> attrs)
                        foreach (var at in attrs)
                            if (!at.Key.StartsWith("_") && at.Value is string s &&
                                float.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var f))
                                nums[at.Key] = f;
                    keys.Add(new List<object> { kv.Key, nums });
                }
                result[ip.GetHashCode().ToString()] = keys;
            }
            return result;
        }

        /// <summary>
        /// args: {track, t, value:{attr: number|string}} — merges the given attributes into the key's
        /// current XML form and reads it back through the interpolable's own reader (works for any mod).
        /// </summary>
        private static object SetKeyValue(Dictionary<string, object> a)
        {
            var ip = Track(a["track"]);
            if (!FindKey(ip, a.GetFloat("t"), out var exact)) throw new BridgeException("Key not found");
            var kf = ip.keyframes[exact];
            var current = DescribeValue(ip, kf.value) as Dictionary<string, object>;
            var patch = a.GetObject("value") ?? new Dictionary<string, object>();

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

            // a drag in the app previews many values: only its first one is an undo step (the value before it)
            if (!a.GetBool("noHistory")) History.Record(new[] { ip });
            kf.value = ip.ReadValueFromXml(el);
            AfterEdit();
            return DescribeValue(ip, kf.value);
        }

        /// <summary>Uses the interpolable's own XML writer so every mod's value type is supported.</summary>
        private static object DescribeValue(Interpolable ip, object value)
        {
            var result = new Dictionary<string, object>();
            try
            {
                var sw = new StringWriter();
                using (var w = new XmlTextWriter(sw))
                {
                    w.WriteStartElement("v");
                    ip.WriteValueToXml(w, value);
                    w.WriteEndElement();
                }
                var doc = new XmlDocument();
                doc.LoadXml(sw.ToString());
                foreach (XmlAttribute attr in doc.DocumentElement.Attributes) result[attr.Name] = attr.Value;
                if (doc.DocumentElement.HasChildNodes) result["_xml"] = doc.DocumentElement.InnerXml;
            }
            catch (Exception e)
            {
                result["_text"] = value?.ToString() ?? "null";
                result["_error"] = e.Message;
            }
            return result;
        }

        /// <summary>Keep Timeline's own window coherent after we mutate its data.</summary>
        private static void AfterEdit(bool reapply = true)
        {
            var s = Ready;
            _editVersion++;
            ((System.Collections.IList)F_selectedKeyframes.GetValue(s)).Clear();
            // Rebuild Timeline's row displays first: UpdateGrid indexes them by visible-track order and
            // throws if they are stale (e.g. after AddTrack swapped _selectedOCI). This schedules UpdateGrid itself.
            RefreshView();
            M_updateKeyWindow.Invoke(s, new object[] { false });
            // Reapply re-evaluates *every* track, which would wipe the user's unkeyed pose changes.
            // When there are some, leave the pose alone and mark it stale: the edit shows once the changes are
            // keyed, the pose is reset to the keys, or on the next seek/play. The app says so.
            if (!reapply) return;
            if (TimelineImpl.PendingCount == 0) Reapply();
            else PoseStale = true;
        }
    }
}
