using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using ExtensibleSaveFormat;
using KKAPI.Studio.SaveLoad;
using KKAPI.Utilities;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using TL = Timeline.Timeline;
using Interpolable = Timeline.Interpolable;
using TLKeyframe = Timeline.Keyframe;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// The Motion builder: a character's motion as a sequence of blocks — Studio animation clips and poses from the pose
    /// library — placed on a lane, trimmed, sped up or down, and blended into one another. The sequence is the source
    /// (saved with the scene); every change rebuilds its result: ordinary Timeline keys in one "Motion" folder
    /// (FK rotations for the body, head and fingers; the hips' bob and travel on the character's position track; the
    /// Studio clip held still underneath on its Animation tracks, so nothing else moves the body).
    ///
    /// Clips are read straight from the animator (no timeline stepping); a pose is put on the character for a frame
    /// once and remembered. Every build replaces the whole result and is one undo step together with the sequence.
    /// Builds run one at a time; "motion.build" events report {id, progress} and {id, done, result | error}.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static readonly Dictionary<int, Dictionary<string, object>> Seqs = new Dictionary<int, Dictionary<string, object>>();
        private static readonly Dictionary<int, KeyValuePair<Dictionary<string, object>, string>> BuildQueue = new Dictionary<int, KeyValuePair<Dictionary<string, object>, string>>();
        private static bool _building;
        private static readonly Dictionary<string, PoseFrame> PoseCache = new Dictionary<string, PoseFrame>();

        private sealed class PoseFrame
        {
            public Quaternion[] Want; // each bone's rotation in the character's own space
            public Vector3 Hips;      // the hips, in the character's own space
        }

        private static void RegisterMotionBuilder(CommandRouter r)
        {
            r.Add("motion.seq.list", a => Seqs.Where(kv => SceneApi.FindOci(kv.Key) is OCIChar)
                .Select(kv => (object)new Dictionary<string, object> { { "id", kv.Key }, { "blocks", (kv.Value.GetList("blocks")).Count } }).ToList());
            r.Add("motion.seq.get", a => Seqs.TryGetValue(a.GetInt("id"), out var s) ? s : null);
            r.Add("motion.seq.set", SeqSet);
            r.Add("motion.seq.clear", SeqClear);
            try { RegisterMotionSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Motion sequences won't be saved with scenes (KKAPI): " + e.Message); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterMotionSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<MotionSceneData>(StudioBridgePlugin.GUID + ".motion");

        /// <summary>args: {id, seq, label?} → {queued}. The build's result comes as the "motion.build" event.</summary>
        private static object SeqSet(Dictionary<string, object> a)
        {
            var _ = Ready;
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null || c.charAnimeCtrl?.animator == null) throw new BridgeException("That character isn't loaded");
            var seq = a.GetObject("seq") ?? throw new BridgeException("No sequence");
            Validate(seq);
            int id = c.objectInfo.dicKey;
            BuildQueue[id] = new KeyValuePair<Dictionary<string, object>, string>(seq, a.GetString("label") ?? "Edit motion");
            if (!_building) StudioBridgePlugin.Instance.StartCoroutine(BuildLoop());
            return new Dictionary<string, object> { { "queued", true } };
        }

        private static void Validate(Dictionary<string, object> seq)
        {
            var blocks = seq.GetList("blocks");
            if (blocks.Count > 200) throw new BridgeException("That's a lot of blocks — split it up");
            foreach (var o in blocks)
            {
                if (!(o is Dictionary<string, object> b)) throw new BridgeException("A block isn't readable");
                string kind = b.GetString("kind");
                if (kind != "clip" && kind != "pose" && kind != "mclip") throw new BridgeException("Unknown block kind " + kind);
                if (kind == "mclip")
                {
                    string file = b.GetObject("mclip")?.GetString("file");
                    if (string.IsNullOrEmpty(file) || !File.Exists(ClipPath(file)))
                        throw new BridgeException("A motion clip block's clip is missing: " + (b.GetObject("mclip")?.GetString("name") ?? file));
                }
                if (b.GetFloat("len") <= 0f) throw new BridgeException("A block needs a length");
                if (kind == "pose")
                {
                    string path = b.GetObject("pose")?.GetString("path");
                    if (string.IsNullOrEmpty(path) || !File.Exists(path) || !(Path.GetExtension(path).Equals(".dat", StringComparison.OrdinalIgnoreCase) || Path.GetExtension(path).Equals(".png", StringComparison.OrdinalIgnoreCase)))
                        throw new BridgeException("A pose block's file is missing: " + (b.GetObject("pose")?.GetString("name") ?? path));
                }
            }
        }

        /// <summary>args: {id} — the sequence and its keys go (one undo step).</summary>
        private static object SeqClear(Dictionary<string, object> a)
        {
            var _ = Ready;
            var c = CharaApi.Chara(a.GetInt("id"));
            int id = c.objectInfo.dicKey;
            if (!Seqs.ContainsKey(id)) return false;
            UndoStack.BeginGroup();
            try
            {
                UndoStack.Push(new SeqUndo(id, Seqs[id]));
                Seqs.Remove(id);
                var tracks = MotionTracks(c);
                History.Record(tracks);
                foreach (var ip in tracks) M_removeInterpolable.Invoke(Ready, new object[] { ip });
            }
            finally { UndoStack.EndGroup("Clear motion"); }
            AfterEdit();
            SeqChanged(id);
            return true;
        }

        private static void SeqChanged(int id) =>
            StudioBridgePlugin.Instance?.Broadcast("motion.seq", new Dictionary<string, object> { { "id", id } });

        private sealed class SeqUndo : IUndoEntry
        {
            private readonly int _id;
            private readonly Dictionary<string, object> _seq;
            public SeqUndo(int id, Dictionary<string, object> seq) { _id = id; _seq = seq; }
            public string Label => "Motion";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var inverse = new SeqUndo(_id, Seqs.TryGetValue(_id, out var s) ? s : null);
                if (_seq == null) Seqs.Remove(_id); else Seqs[_id] = _seq;
                SeqChanged(_id);
                return inverse;
            }
        }

        // ------------------------------------------------------------------ building

        private static IEnumerator BuildLoop()
        {
            _building = true;
            try
            {
                while (BuildQueue.Count > 0)
                {
                    var next = BuildQueue.First();
                    BuildQueue.Remove(next.Key);
                    // other tools stepping the scene: wait for them
                    while (LockRunning || MotionSampler.Running || ViewportTools.Busy) yield return null;
                    var it = Build(next.Key, next.Value.Key, next.Value.Value);
                    while (true)
                    {
                        object cur;
                        try { if (!it.MoveNext()) break; cur = it.Current; }
                        catch (Exception e)
                        {
                            StudioBridgePlugin.Logger.LogWarning("Motion build: " + e);
                            BuildDone(next.Key, null, e is BridgeException ? e.Message : "Building the motion failed: " + e.Message);
                            break;
                        }
                        yield return cur;
                    }
                }
            }
            finally { _building = false; ViewportTools.Busy = false; }
        }

        private static void BuildDone(int id, Dictionary<string, object> result, string error)
        {
            var msg = error != null ? new Dictionary<string, object> { { "error", error } } : result ?? new Dictionary<string, object>();
            msg["id"] = id;
            msg["done"] = true;
            StudioBridgePlugin.Instance?.Broadcast("motion.build", msg);
        }

        /// <summary>The bones the builder drives: FK bones of the body, neck and hands.</summary>
        private static List<OCIChar.BoneInfo> MotionBones(OCIChar c)
        {
            var parts = new HashSet<int>(BakeParts.Values.SelectMany(x => x).Select(g => ViewportGizmos.FkPart(g)).Where(i => i >= 0));
            return c.listBones.Where(b => b?.guideObject?.transformTarget != null && parts.Contains(ViewportGizmos.FkPart(b.boneGroup))).ToList();
        }

        private static string MotionFolderName(OCIChar c) => "Motion: " + SceneApi.DisplayName(c);

        /// <summary>The tracks a build writes (for clearing): the Motion folder's tracks of this character.</summary>
        private static List<Interpolable> MotionTracks(OCIChar c)
        {
            string name = MotionFolderName(c);
            return Interpolables.Values.Where(ip => ip.oci == c && FolderNameOf(ip) == name).ToList();
        }

        private static string FolderNameOf(Interpolable ip)
        {
            var folder = (LeafNode(ip) as Timeline.INode)?.parent;
            return folder != null ? GroupType.GetField("name")?.GetValue(GroupObj(folder)) as string : null;
        }

        private struct Pick
        {
            public int A, B;   // blocks (B = the one being blended from, or -1)
            public float TA, TB; // timeline time each is read at
            public float W;    // weight of A (1 = A only)
        }

        private static float BStart(Dictionary<string, object> b) => b.GetFloat("start");
        private static float BEnd(Dictionary<string, object> b) => b.GetFloat("start") + b.GetFloat("len");

        private static IEnumerator Build(int id, Dictionary<string, object> seq, string label)
        {
            var s = Ready;
            if (!(SceneApi.FindOci(id) is OCIChar c) || c.charInfo == null) throw new BridgeException("That character is gone");
            var blocks = seq.GetList("blocks").OfType<Dictionary<string, object>>().OrderBy(BStart).ToList();
            int fps = Mathf.Clamp((int)F_fps.GetValue(s), 1, 240);
            float rate = Mathf.Min(fps, 60);
            var animator = c.charAnimeCtrl.animator;
            var bones = MotionBones(c);
            if (bones.Count == 0) throw new BridgeException("This character has no FK bones");
            var hipsT = c.listBones.FirstOrDefault(b => b?.guideObject?.transformTarget?.name == "cf_j_hips")?.guideObject.transformTarget;
            var root = c.guideObject;
            var rt = root.transformTarget;
            Quaternion rootInv = Quaternion.Inverse(rt.rotation);
            Func<Vector3> hipsNow = () => hipsT != null ? rt.InverseTransformPoint(hipsT.position) : Vector3.zero;
            Func<Quaternion[]> wantNow = () => bones.Select(b => rootInv * b.guideObject.transformTarget.rotation).ToArray();

            // what's undone with the build: the clip and speed, FK / IK, the sequence
            var animeUndo = CharaApi.CharaUndo.Capture(new[] { c }, "anime", label);
            var kinRestore = ViewportGizmos.KinematicsRestorer(c);
            var before = Seqs.TryGetValue(id, out var prevSeq) ? prevSeq : null;

            // the previous build's sequence (its result is worked out again to see what was edited by hand)
            var prevBlocks = before?.GetList("blocks").OfType<Dictionary<string, object>>().OrderBy(BStart).ToList();
            bool hasKeys = prevBlocks != null && MotionTracks(c).Count > 0;
            var ai0 = c.oiCharInfo.animeInfo;
            var own = new[] { ai0.group, ai0.category, ai0.no };

            // 1. poses (put on for a frame each, once; remembered by file and date)
            var poseKeys = new Dictionary<Dictionary<string, object>, string>();
            var missing = new List<KeyValuePair<string, string>>();
            foreach (var b in blocks.Concat(hasKeys ? prevBlocks : new List<Dictionary<string, object>>()).Where(x => x.GetString("kind") == "pose"))
            {
                string path = b.GetObject("pose").GetString("path");
                if (!File.Exists(path)) continue;
                string key = Path.GetFullPath(path).ToLowerInvariant() + "|" + File.GetLastWriteTimeUtc(path).Ticks + "|" + bones.Count;
                poseKeys[b] = key;
                if (!PoseCache.ContainsKey(key) && !missing.Any(m => m.Key == key)) missing.Add(new KeyValuePair<string, string>(key, path));
            }
            if (missing.Count > 0)
            {
                if (TL.isPlaying) TL.Pause();
                var original = new PauseCtrl.FileInfo(c);
                try
                {
                    int done = 0;
                    foreach (var m in missing)
                    {
                        ViewportTools.HoldBusy();
                        if (!PauseCtrl.Load(c, m.Value)) throw new BridgeException("Couldn't load the pose " + Path.GetFileNameWithoutExtension(m.Value));
                        yield return null; // FK, IK and the pose's clip settle
                        yield return new WaitForEndOfFrame();
                        if (c.charInfo == null) throw new BridgeException("The character was removed");
                        PoseCache[m.Key] = new PoseFrame { Want = wantNow(), Hips = hipsNow() };
                        done++;
                        StudioBridgePlugin.Instance?.Broadcast("motion.build", new Dictionary<string, object> { { "id", id }, { "progress", Math.Round((double)done / (missing.Count + 1), 3) } });
                    }
                }
                finally
                {
                    try { original.Apply(c); } catch { }
                    ViewportTools.Busy = false;
                }
            }

            var ctx = new BuildCtx { C = c, Bones = bones, Rate = rate, WantNow = wantNow, HipsNow = hipsNow, RootInv = rootInv, Rt = rt, PoseKeys = poseKeys, OwnClip = own };
            try
            {
                // hand edits to the last build's keys: kept with their blocks, so they survive this rebuild
                int tweaked = 0;
                if (hasKeys && prevBlocks.All(b => b.GetString("kind") != "pose" || poseKeys.ContainsKey(b)))
                {
                    try { tweaked = CaptureTweaks(ctx, Compute(ctx, prevBlocks), blocks); }
                    catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Motion: reading hand edits failed: " + e.Message); }
                }
                var o = Compute(ctx, blocks);
                var times = o.Times;
                float end = o.End;

                // where the character stands: kept from the first build (moving it = "Place here" on the page)
                var anchorList = seq.GetList("anchor");
                Vector3 anchor = anchorList.Count == 3 ? new Vector3(Convert.ToSingle(anchorList[0]), Convert.ToSingle(anchorList[1]), Convert.ToSingle(anchorList[2]))
                    : before?.GetList("anchor") is List<object> pa && pa.Count == 3 ? new Vector3(Convert.ToSingle(pa[0]), Convert.ToSingle(pa[1]), Convert.ToSingle(pa[2]))
                    : root.changeAmount.pos;
                seq["anchor"] = new List<object> { (double)anchor.x, (double)anchor.y, (double)anchor.z };
                var parentL2W = rt.parent != null ? rt.parent.localToWorldMatrix : Matrix4x4.identity;
                var rootM = parentL2W * Matrix4x4.TRS(anchor, rt.localRotation, rt.localScale);
                var parentW2L = parentL2W.inverse;
                var pos = new Vector3[times.Count];
                for (int k = 0; k < times.Count; k++) pos[k] = parentW2L.MultiplyPoint3x4(rootM.MultiplyPoint3x4(o.Hips[k] - o.HipsBase));

                // 7. write it all: one undo step with the sequence
                Dictionary<string, object> result;
                UndoStack.BeginGroup();
                try
                {
                    UndoStack.Push(new SeqUndo(id, before));
                    Seqs[id] = seq;
                    UndoStack.Push(animeUndo);
                    UndoStack.Push(new KinematicsUndo(c, kinRestore));
                    // every block's start and end, and where each blend ends (frames at those exact moments)
                    var edges = new List<int> { 0, times.Count - 1 };
                    Func<float, int> nearest = t => Mathf.Clamp(Mathf.RoundToInt(t * rate), 0, times.Count - 1);
                    foreach (var b in blocks)
                    {
                        edges.Add(nearest(BStart(b)));
                        edges.Add(nearest(BEnd(b)));
                        if (b.GetFloat("blend") > 0f) edges.Add(nearest(BStart(b) + b.GetFloat("blend")));
                    }
                    result = WriteMotion(c, times, bones, o.Local, pos, end, edges.Distinct().ToList());
                }
                finally { UndoStack.EndGroup(label); }
                if (end > TL.duration + 1e-4f) F_duration.SetValue(s, end); // room for all of it
                RefreshView();
                AfterEdit();
                EventPump.RequestRebase();
                result["lengths"] = o.Lengths;
                result["end"] = Math.Round(end, 4);
                result["tweaked"] = tweaked;
                BuildDone(id, result, null);
                SeqChanged(id);
            }
            catch
            {
                // put the character back the way it was
                try { animeUndo.Restore(); } catch { }
                try { kinRestore(); } catch { }
                throw;
            }
        }

        private sealed class BuildCtx
        {
            public OCIChar C;
            public List<OCIChar.BoneInfo> Bones;
            public float Rate;
            public Func<Quaternion[]> WantNow;
            public Func<Vector3> HipsNow;
            public Quaternion RootInv;
            public Transform Rt;
            public Dictionary<Dictionary<string, object>, string> PoseKeys;
            public int[] OwnClip; // the character's own clip when the build started (held when there's no clip block)
        }

        private sealed class Output
        {
            public List<float> Times;
            public Pick[] Picks;
            public List<Dictionary<string, object>> Blocks;
            public Quaternion[][] Local; // bone → frame
            public Vector3[] Hips;
            public Vector3 HipsBase;
            public float End;
            public Dictionary<string, object> Lengths = new Dictionary<string, object>();
        }

        /// <summary>
        /// A sequence's result (no writing): every frame's FK rotations under the held clip, and the hips. Hand edits kept
        /// with the blocks ("tweaks") are put on top.
        /// </summary>
        private static Output Compute(BuildCtx x, List<Dictionary<string, object>> blocks)
        {
            var c = x.C;
            var bones = x.Bones;
            var animator = c.charAnimeCtrl.animator;
            var rt = x.Rt;
            var wantNow = x.WantNow;
            var hipsNow = x.HipsNow;
            float rate = x.Rate;
            var o = new Output { Blocks = blocks };

            // 2. the clip held underneath: the first clip block's clip (else the character's own), on its first frame
            var baseClip = blocks.FirstOrDefault(b => b.GetString("kind") == "clip")?.GetObject("clip");
            int bg = baseClip?.GetInt("group") ?? x.OwnClip[0], bc = baseClip?.GetInt("category") ?? x.OwnClip[1], bn = baseClip?.GetInt("no") ?? x.OwnClip[2];

            // 3. what's read where: each output frame takes one block (or two, blending)
            float end = blocks.Count > 0 ? blocks.Max(BEnd) : 0f;
            int n = Mathf.Max(1, Mathf.CeilToInt(end * rate));
            if (n > 7200) throw new BridgeException("The motion is too long to build (2 minutes at most)");
            var times = new List<float>();
            for (int k = 0; k <= n; k++) times.Add(Mathf.Min(end, k / rate));
            var picks = new Pick[times.Count];
            for (int k = 0; k < times.Count; k++) picks[k] = PickAt(blocks, times[k]);
            o.Times = times;
            o.Picks = picks;
            o.End = end;
            var lengths = o.Lengths;

            // 4. clips: straight from the animator, block by block
            var clipFrames = new Dictionary<int, Dictionary<int, PoseFrame>>(); // block → (quantized clip time → frame)
            var clipTime = new Dictionary<int, Func<float, float>>();
            for (int bi = 0; bi < blocks.Count; bi++)
            {
                var b = blocks[bi];
                if (b.GetString("kind") != "clip") continue;
                var cl = b.GetObject("clip");
                c.LoadAnime(cl.GetInt("group"), cl.GetInt("category"), cl.GetInt("no"));
                var st = animator.GetCurrentAnimatorStateInfo(0);
                int hash = st.shortNameHash;
                float len = ClipLength(animator, st);
                lengths[b.GetString("id") ?? bi.ToString()] = Math.Round(len, 4);
                float speed = b.Has("speed") ? Mathf.Clamp(b.GetFloat("speed"), 0.05f, 10f) : 1f;
                float offset = Mathf.Max(0f, b.Has("offset") ? b.GetFloat("offset") : 0f);
                float start = BStart(b);
                Func<float, float> u = t => offset + (t - start) * speed; // seconds into the clip
                clipTime[bi] = u;
                var frames = new Dictionary<int, PoseFrame>();
                clipFrames[bi] = frames;
                var need = new HashSet<int>();
                for (int k = 0; k < picks.Length; k++)
                {
                    if (picks[k].A == bi) need.Add(Q(u(picks[k].TA)));
                    if (picks[k].B == bi) need.Add(Q(u(picks[k].TB)));
                }
                foreach (int q in need)
                {
                    animator.Play(hash, 0, (q / 10000f) / len);
                    animator.Update(0f);
                    frames[q] = new PoseFrame { Want = wantNow(), Hips = hipsNow() };
                }
            }

            // the held clip: read its pose and its bones' parents (the chain the keys sit under)
            c.LoadAnime(bg, bc, bn);
            int baseHash = animator.GetCurrentAnimatorStateInfo(0).shortNameHash;
            animator.Play(baseHash, 0, 0f);
            animator.Update(0f);
            var baseWant = wantNow();
            var baseParent = bones.Select(b => x.RootInv * (b.guideObject.transformTarget.parent != null ? b.guideObject.transformTarget.parent.rotation : rt.rotation)).ToArray();
            var hipsBase = hipsNow();

            // the chain the keys sit under: each bone's nearest driven ancestor, and how it hangs off it when held
            int nb = bones.Count;
            var tr = bones.Select(b => b.guideObject.transformTarget).ToList();
            var anc = new int[nb];
            var link = new Quaternion[nb];
            for (int i = 0; i < nb; i++)
            {
                anc[i] = -1;
                for (var par = tr[i].parent; par != null && anc[i] < 0; par = par.parent) anc[i] = tr.IndexOf(par);
                link[i] = anc[i] >= 0 ? Quaternion.Inverse(baseWant[anc[i]]) * baseParent[i] : Quaternion.identity;
            }
            Func<int, int> depth = i => { int d = 0; for (int a = anc[i]; a >= 0; a = anc[a]) d++; return d; };
            var topDown = Enumerable.Range(0, nb).OrderBy(depth).ToList();

            // 4b. Motion clips: their FK keys (bone by bone, at each moment) put together under the held chain;
            // their position keys move the hips
            for (int bi = 0; bi < blocks.Count; bi++)
            {
                var b = blocks[bi];
                if (b.GetString("kind") != "mclip") continue;
                var data = LoadMClip(ClipPath(b.GetObject("mclip").GetString("file")));
                lengths[b.GetString("id") ?? bi.ToString()] = Math.Round(data.Length, 4);
                float speed = b.Has("speed") ? Mathf.Clamp(b.GetFloat("speed"), 0.05f, 10f) : 1f;
                float offset = Mathf.Max(0f, b.Has("offset") ? b.GetFloat("offset") : 0f);
                float start = BStart(b), clen = data.Length;
                Func<float, float> u = t => Mathf.Clamp(offset + (t - start) * speed, 0f, clen);
                clipTime[bi] = u;
                var frames = new Dictionary<int, PoseFrame>();
                clipFrames[bi] = frames;
                var keysOf = tr.Select(x => data.Rot.TryGetValue(x.name, out var ks) ? ks : null).ToArray();
                Vector3? p0 = data.Pos != null ? PosOf(Eval(data.Pos, 0f)) : null;
                float sc = Mathf.Max(1e-4f, Mathf.Abs(rt.localScale.x));
                var need = new HashSet<int>();
                for (int k = 0; k < picks.Length; k++)
                {
                    if (picks[k].A == bi) need.Add(Q(u(picks[k].TA)));
                    if (picks[k].B == bi) need.Add(Q(u(picks[k].TB)));
                }
                foreach (int q in need)
                {
                    float at = q / 10000f;
                    var w = new Quaternion[nb];
                    foreach (int i in topDown)
                    {
                        var kd = keysOf[i] != null ? Eval(keysOf[i], at) : null;
                        var loc = kd != null && IsQuat(kd.A) ? Q(kd.A) : Quaternion.Inverse(baseParent[i]) * baseWant[i];
                        w[i] = (anc[i] >= 0 ? w[anc[i]] * link[i] : baseParent[i]) * loc;
                    }
                    var hp = hipsBase;
                    if (p0 != null && PosOf(Eval(data.Pos, at)) is Vector3 pu) hp += Quaternion.Inverse(rt.localRotation) * (pu - p0.Value) / sc;
                    frames[q] = new PoseFrame { Want = w, Hips = hp };
                }
            }

            // 5. mix: each frame's wanted rotations and hips (a mirrored block: left and right swapped and flipped)
            var partner = tr.Select(x => { var o = MirrorName(x.name); int j = o != null ? tr.FindIndex(y => y.name == o) : -1; return j; }).ToArray();
            Func<int, float, PoseFrame> frameOf = (bi, t) =>
            {
                var b = blocks[bi];
                var f = b.GetString("kind") == "pose" ? PoseCache[x.PoseKeys[b]] : clipFrames[bi][Q(clipTime[bi](t))];
                return b.GetBool("mirror") ? Mirrored(f, partner) : f;
            };
            var want = new Quaternion[times.Count][];
            var hips = new Vector3[times.Count];
            for (int k = 0; k < times.Count; k++)
            {
                var p = picks[k];
                if (p.A < 0) { want[k] = baseWant; hips[k] = hipsBase; continue; }
                var fa = frameOf(p.A, p.TA);
                if (p.B < 0 || p.W >= 1f) { want[k] = fa.Want; hips[k] = fa.Hips; continue; }
                var fb = frameOf(p.B, p.TB);
                var w = new Quaternion[nb];
                for (int i = 0; i < nb; i++) w[i] = Quaternion.Slerp(fb.Want[i], fa.Want[i], p.W);
                want[k] = w;
                hips[k] = Vector3.Lerp(fb.Hips, fa.Hips, p.W);
            }

            // 6. into keys: each bone's rotation under the held chain; the root where the held hips land right
            var local = new Quaternion[nb][];
            for (int i = 0; i < nb; i++)
            {
                local[i] = new Quaternion[times.Count];
                for (int k = 0; k < times.Count; k++)
                {
                    var parent = anc[i] >= 0 ? want[k][anc[i]] * link[i] : baseParent[i];
                    local[i][k] = Quaternion.Inverse(parent) * want[k][i];
                }
            }
            // hand edits kept with the blocks, on top
            for (int bi = 0; bi < blocks.Count; bi++)
            {
                var tw = TweaksOf(blocks[bi]);
                if (tw.Count == 0) continue;
                var ti = tr.Select(t => tw.TryGetValue(t.name, out var l) ? l : null).ToArray();
                for (int k = 0; k < times.Count; k++)
                {
                    var p = picks[k];
                    bool asA = p.A == bi, asB = p.B == bi && p.W < 1f;
                    if (!asA && !asB) continue;
                    float u = (asA ? p.TA : p.TB) - BStart(blocks[bi]);
                    float wgt = asA ? (p.B >= 0 ? p.W : 1f) : 1f - p.W;
                    for (int i = 0; i < nb; i++)
                        if (ti[i] != null) local[i][k] = local[i][k] * Quaternion.Slerp(Quaternion.identity, TweakAt(ti[i], u), wgt);
                }
            }
            o.Local = local;
            o.Hips = hips;
            o.HipsBase = hipsBase;
            return o;
        }

        /// <summary>
        /// What was changed by hand in the last build's keys (key edits on its bone tracks), as offsets kept with each
        /// block in the block's own time, added to what the block already had. Returns how many bones carry edits.
        /// </summary>
        private static int CaptureTweaks(BuildCtx x, Output prev, List<Dictionary<string, object>> next)
        {
            var c = x.C;
            var rotModel = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == "guideObjectRot");
            if (rotModel == null) return 0;
            string folder = MotionFolderName(c);
            var bones = x.Bones;
            var times = prev.Times;
            // per block id → bone → (block time, offset)
            var found = new Dictionary<string, Dictionary<string, List<KeyValuePair<float, Quaternion>>>>();
            for (int i = 0; i < bones.Count; i++)
            {
                var g = bones[i].guideObject;
                if (!Interpolables.TryGetValue(new Interpolable(c, g, rotModel).GetHashCode(), out var ip) || !ip.enabled || FolderNameOf(ip) != folder || ip.keyframes.Count == 0) continue;
                string bone = g.transformTarget.name;
                var diffs = new Quaternion[times.Count];
                bool any = false;
                for (int k = 0; k < times.Count; k++)
                {
                    var cur = TrackQuat(ip, times[k]);
                    diffs[k] = Quaternion.Inverse(prev.Local[i][k]) * cur;
                    if (Quaternion.Angle(Quaternion.identity, diffs[k]) > 0.6f) any = true;
                }
                if (!any) continue;
                for (int k = 0; k < times.Count; k++)
                {
                    var p = prev.Picks[k];
                    if (p.A < 0 || (p.B >= 0 && p.W < 1f)) continue; // blends follow from the blocks on either side
                    var b = prev.Blocks[p.A];
                    string bid = b.GetString("id");
                    if (bid == null) continue;
                    if (!found.TryGetValue(bid, out var byBone)) found[bid] = byBone = new Dictionary<string, List<KeyValuePair<float, Quaternion>>>();
                    if (!byBone.TryGetValue(bone, out var list)) byBone[bone] = list = new List<KeyValuePair<float, Quaternion>>();
                    list.Add(new KeyValuePair<float, Quaternion>(p.TA - BStart(b), diffs[k]));
                }
            }
            var touched = new HashSet<string>();
            foreach (var b in next)
            {
                string bid = b.GetString("id");
                if (bid == null || !found.TryGetValue(bid, out var byBone)) continue;
                var have = TweaksOf(b);
                var all = new Dictionary<string, object>();
                foreach (var kv in have) all[kv.Key] = null;
                foreach (var kv in byBone) all[kv.Key] = null;
                var outT = new Dictionary<string, object>();
                foreach (var bone in all.Keys)
                {
                    have.TryGetValue(bone, out var old);
                    byBone.TryGetValue(bone, out var add);
                    // samples: where the edit was read (or the old ones), the old offset then the new edit on top
                    var us = (add ?? old).Select(v => v.Key).ToList();
                    var qs = us.Select(u =>
                    {
                        var q0 = old != null ? TweakAt(old, u) : Quaternion.identity;
                        var q1 = add != null ? TweakAt(add, u) : Quaternion.identity;
                        return q0 * q1;
                    }).ToList();
                    if (qs.All(q => Quaternion.Angle(Quaternion.identity, q) < 0.3f)) continue;
                    var keep = Simplify(new List<int> { 0, us.Count - 1 }, 0, us.Count - 1, (k, a, bb, f) => Quaternion.Angle(Quaternion.SlerpUnclamped(qs[a], qs[bb], f), qs[k]), 0.3f, us);
                    outT[bone] = keep.Select(k => (object)new List<object> { Math.Round(us[k], 4), (double)qs[k].x, (double)qs[k].y, (double)qs[k].z, (double)qs[k].w }).ToList();
                    touched.Add(bone);
                }
                if (outT.Count > 0) b["tweaks"] = outT; else b.Remove("tweaks");
            }
            return touched.Count;
        }

        /// <summary>A block's kept hand edits: bone → (block time, offset), in time order.</summary>
        private static Dictionary<string, List<KeyValuePair<float, Quaternion>>> TweaksOf(Dictionary<string, object> b)
        {
            var r = new Dictionary<string, List<KeyValuePair<float, Quaternion>>>();
            if (!(b.GetObject("tweaks") is Dictionary<string, object> t)) return r;
            foreach (var kv in t)
            {
                if (!(kv.Value is List<object> keys)) continue;
                var list = new List<KeyValuePair<float, Quaternion>>();
                foreach (var k in keys.OfType<List<object>>())
                    if (k.Count == 5)
                        list.Add(new KeyValuePair<float, Quaternion>(Convert.ToSingle(k[0]), new Quaternion(Convert.ToSingle(k[1]), Convert.ToSingle(k[2]), Convert.ToSingle(k[3]), Convert.ToSingle(k[4]))));
                if (list.Count > 0) r[kv.Key] = list.OrderBy(x => x.Key).ToList();
            }
            return r;
        }

        private static Quaternion TweakAt(List<KeyValuePair<float, Quaternion>> l, float u)
        {
            if (u <= l[0].Key) return l[0].Value;
            if (u >= l[l.Count - 1].Key) return l[l.Count - 1].Value;
            int i = 0;
            while (i < l.Count - 2 && l[i + 1].Key <= u) i++;
            float span = l[i + 1].Key - l[i].Key;
            return Quaternion.Slerp(l[i].Value, l[i + 1].Value, span > 1e-6f ? (u - l[i].Key) / span : 0f);
        }

        /// <summary>A rotation track's value at t, the way Timeline interpolates it.</summary>
        private static Quaternion TrackQuat(Interpolable ip, float t)
        {
            KeyValuePair<float, TLKeyframe>? l = null, r = null;
            foreach (var kv in ip.keyframes) { if (kv.Key <= t + 1e-5f) l = kv; else { r = kv; break; } }
            if (l == null) return r != null && r.Value.Value.value is Quaternion q0 ? q0 : Quaternion.identity;
            var lq = l.Value.Value.value is Quaternion a ? a : Quaternion.identity;
            if (r == null || !(r.Value.Value.value is Quaternion rq)) return lq;
            float f = l.Value.Value.curve.Evaluate((t - l.Value.Key) / (r.Value.Key - l.Value.Key));
            return Quaternion.SlerpUnclamped(lq, rq, f);
        }

        private static int Q(float clipSeconds) => Mathf.RoundToInt(clipSeconds * 10000f);

        /// <summary>The bone on the other side (…_L ↔ …_R), or null for a middle bone.</summary>
        private static string MirrorName(string name)
        {
            if (name.EndsWith("_L")) return name.Substring(0, name.Length - 2) + "_R";
            if (name.EndsWith("_R")) return name.Substring(0, name.Length - 2) + "_L";
            if (name.Contains("_L_")) return name.Replace("_L_", "_R_");
            if (name.Contains("_R_")) return name.Replace("_R_", "_L_");
            return null;
        }

        /// <summary>
        /// A frame seen in a mirror across the character's middle: each bone takes its partner's rotation, reflected
        /// (x, −y, −z — the same flip the pose mirror uses), and the hips go to the other side.
        /// </summary>
        private static PoseFrame Mirrored(PoseFrame f, int[] partner)
        {
            var w = new Quaternion[f.Want.Length];
            for (int i = 0; i < w.Length; i++)
            {
                var q = f.Want[partner[i] >= 0 ? partner[i] : i];
                w[i] = new Quaternion(q.x, -q.y, -q.z, q.w);
            }
            return new PoseFrame { Want = w, Hips = new Vector3(-f.Hips.x, f.Hips.y, f.Hips.z) };
        }

        /// <summary>A saved Motion clip, as the builder reads it: FK rotation keys by bone name, the object's position keys.</summary>
        private sealed class MClip
        {
            public readonly Dictionary<string, List<KD>> Rot = new Dictionary<string, List<KD>>();
            public List<KD> Pos;
            public float Length;
        }
        private static readonly Dictionary<string, MClip> MClipCache = new Dictionary<string, MClip>();

        private static MClip LoadMClip(string path)
        {
            string key = path.ToLowerInvariant() + "|" + File.GetLastWriteTimeUtc(path).Ticks;
            if (MClipCache.TryGetValue(key, out var hit)) return hit;
            var doc = new System.Xml.XmlDocument();
            doc.Load(path);
            var root = doc.DocumentElement;
            var d = new MClip { Length = Mathf.Max(1f / 60f, System.Xml.XmlConvert.ToSingle(root.GetAttribute("length"))) };
            foreach (var t in root.SelectNodes("track").OfType<System.Xml.XmlElement>())
            {
                var keys = t.SelectNodes("k").OfType<System.Xml.XmlElement>().Select(ReadKeyNode).OrderBy(k => k.T).ToList();
                if (keys.Count == 0) continue;
                string id = t.GetAttribute("id"), gp = t.GetAttribute("guideObjectPath");
                if (id == "guideObjectRot" && !string.IsNullOrEmpty(gp)) d.Rot[gp.Split('/').Last()] = keys;
                else if (id == "guideObjectPos" && string.IsNullOrEmpty(gp)) d.Pos = keys;
            }
            if (d.Rot.Count == 0) throw new BridgeException("The motion clip “" + root.GetAttribute("name") + "” has no FK bone keys to use (IK or face only?)");
            MClipCache[key] = d;
            return d;
        }

        private static Vector3? PosOf(KD k)
        {
            if (k == null) return null;
            if (!k.A.TryGetValue("valueX", out var x) || !k.A.TryGetValue("valueY", out var y) || !k.A.TryGetValue("valueZ", out var z)) return null;
            if (!Num(x, out var fx) || !Num(y, out var fy) || !Num(z, out var fz)) return null;
            return new Vector3(fx, fy, fz);
        }

        private static float Ease(float u, string ease)
        {
            u = Mathf.Clamp01(u);
            return ease == "linear" ? u : u * u * (3f - 2f * u);
        }

        /// <summary>Which block(s) the motion takes at t: the last one started (held on its end in a gap), blended from
        /// the one before over its blend time.</summary>
        private static Pick PickAt(List<Dictionary<string, object>> blocks, float t)
        {
            if (blocks.Count == 0) return new Pick { A = -1, B = -1, W = 1f };
            int a = 0;
            for (int i = 0; i < blocks.Count; i++) if (BStart(blocks[i]) <= t + 1e-5f) a = i;
            var A = blocks[a];
            float ta = Mathf.Clamp(t, BStart(A), BEnd(A));
            float blend = a > 0 ? Mathf.Max(0f, A.GetFloat("blend")) : 0f;
            if (blend > 1e-4f && t < BStart(A) + blend && t >= BStart(A))
            {
                var B = blocks[a - 1];
                // blended from: it plays on through the blend if it ran into this one; held on its end after a gap
                float tb = BStart(A) > BEnd(B) + 1e-3f ? BEnd(B) : t;
                float w = Ease((t - BStart(A)) / blend, A.GetString("ease"));
                return new Pick { A = a, B = a - 1, TA = ta, TB = tb, W = w };
            }
            return new Pick { A = a, B = -1, TA = ta, W = 1f };
        }

        /// <summary>The build's keys: the held clip, every bone's rotation, the root's position; all in the Motion folder.</summary>
        private static Dictionary<string, object> WriteMotion(OCIChar c, List<float> times, List<OCIChar.BoneInfo> bones, Quaternion[][] local, Vector3[] pos, float end, List<int> edges)
        {
            var rotModel = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == "guideObjectRot") ?? throw new BridgeException("Timeline's rotation track type wasn't found");
            var posModel = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == "guideObjectPos") ?? throw new BridgeException("Timeline's position track type wasn't found");
            int n = times.Count;
            var existing = new HashSet<Interpolable>(Interpolables.Values);
            var written = new List<Interpolable>();

            // the clip held underneath, stopped (the character is already showing it)
            var clip = EnsureCharTrack(c, "charAnimation");
            var time = EnsureCharTrack(c, "charAnimationTime");
            foreach (var ip in new[] { clip, time }) { ip.keyframes.Clear(); ip.enabled = true; }
            AddOrUpdateKey(clip, 0f);
            time.keyframes[0f] = new TLKeyframe(0f, time, AnimationCurve.Linear(0f, 0f, 1f, 1f));
            c.animeSpeed = 0f;
            written.Add(clip);
            written.Add(time);

            // FK on for the body, head and hands; IK off
            var info = c.oiCharInfo;
            if (info.enableIK) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, false, false);
            var parts = new HashSet<int>(bones.Select(b => ViewportGizmos.FkPart(b.boneGroup)));
            for (int i = 0; i < info.activeFK.Length; i++) info.activeFK[i] = parts.Contains(i);
            if (!info.enableFK) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, true, false);
            for (int i = 0; i < FKCtrl.parts.Length && i < info.activeFK.Length; i++) c.ActiveFK(FKCtrl.parts[i], info.activeFK[i], true);

            int keys = 0;
            Action<GuideObject, Timeline.InterpolableModel, List<int>, Action<int>> write = (g, model, ks, set) =>
            {
                keys += WriteGuideKeys(c, g, model, ks, times, 0, n - 1, false, set);
                if (Interpolables.TryGetValue(new Interpolable(c, g, model).GetHashCode(), out var ip))
                {
                    foreach (var t in ip.keyframes.Keys.Where(t => t > end + 1e-4f).ToList()) ip.keyframes.Remove(t); // the old build's tail
                    ip.enabled = true;
                    written.Add(ip);
                }
            };
            for (int i = 0; i < bones.Count; i++)
            {
                var g = bones[i].guideObject;
                var q = local[i];
                var ks = Simplify(edges, 0, n - 1, (k, x, y, f) => Quaternion.Angle(Quaternion.SlerpUnclamped(q[x], q[y], f), q[k]), 0.4f, times);
                var keep = g.changeAmount.rot;
                write(g, rotModel, ks, k => g.changeAmount.rot = q[k].eulerAngles);
                g.changeAmount.rot = keep;
            }
            {
                var g = c.guideObject;
                float scale = Mathf.Max(1e-3f, Mathf.Abs(g.transformTarget.lossyScale.x));
                var ks = Simplify(edges, 0, n - 1, (k, x, y, f) => Vector3.Distance(Vector3.LerpUnclamped(pos[x], pos[y], f), pos[k]) * scale, 0.001f, times);
                var keep = g.changeAmount.pos;
                write(g, posModel, ks, k => g.changeAmount.pos = pos[k]);
                g.changeAmount.pos = keep;
            }

            // all of it in the character's Motion folder
            string folderName = MotionFolderName(c);
            var outside = written.Distinct().Where(ip => FolderNameOf(ip) != folderName).ToList();
            if (outside.Count > 0)
            {
                var hashes = outside.Select(ip => ip.GetHashCode()).ToList();
                FileInMotionFolder(c, hashes, true);
                UndoStack.Push(new MotionFolderEntry(c, hashes, false));
            }
            return new Dictionary<string, object>
            {
                { "keys", keys }, { "bones", bones.Count }, { "samples", n }, { "tracks", written.Distinct().Count() },
                { "made", Interpolables.Values.Count(ip => !existing.Contains(ip)) }, { "folder", folderName },
            };
        }

        /// <summary>Put these tracks of the character into its Motion folder (made if needed), or back out of it.</summary>
        private static void FileInMotionFolder(OCIChar c, List<int> hashes, bool inside)
        {
            string folderName = MotionFolderName(c);
            var tracks = hashes.Select(h => Interpolables.TryGetValue(h, out var ip) ? ip : null).Where(ip => ip != null).ToList();
            if (tracks.Count == 0) return;
            if (inside)
            {
                var move = tracks.Where(ip => FolderNameOf(ip) != folderName).ToList();
                if (move.Count == 0) return;
                var inFolder = Interpolables.Values.FirstOrDefault(ip => ip.oci == c && FolderNameOf(ip) == folderName);
                if (inFolder != null) ParentTo(move.Select(LeafNode).Where(x => x != null).ToList(), (LeafNode(inFolder) as Timeline.INode)?.parent);
                else GroupCreate(new Dictionary<string, object> { { "name", folderName }, { "tracks", move.Select(ip => (object)ip.GetHashCode()).ToList() } });
            }
            else ParentTo(tracks.Where(ip => FolderNameOf(ip) == folderName).Select(LeafNode).Where(x => x != null).ToList(), null);
            RefreshView();
        }

        /// <summary>Undo / redo of filing a build's new tracks into the Motion folder.</summary>
        private sealed class MotionFolderEntry : IUndoEntry
        {
            private readonly OCIChar _c;
            private readonly List<int> _hashes;
            private readonly bool _inside; // what Restore puts them back to
            public MotionFolderEntry(OCIChar c, List<int> hashes, bool inside) { _c = c; _hashes = hashes; _inside = inside; }
            public string Label => "Motion folder";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                if (_c?.charInfo == null) return null;
                FileInMotionFolder(_c, _hashes, _inside);
                return new MotionFolderEntry(_c, _hashes, !_inside);
            }
        }

        // ------------------------------------------------------------------ saved with the scene

        private sealed class MotionSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                var live = Seqs.Where(kv => SceneApi.FindOci(kv.Key) is OCIChar).ToDictionary(kv => kv.Key.ToString(), kv => (object)kv.Value);
                SetExtendedData(live.Count == 0 ? null : new PluginData { version = 1, data = new Dictionary<string, object> { { "json", Json.Serialize(live) } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation != SceneOperationKind.Import) Seqs.Clear();
                var d = GetExtendedData();
                if (d?.data == null || !d.data.TryGetValue("json", out var j) || !(j is string json)) { SeqChanged(-1); return; }
                try
                {
                    if (Json.Parse(json) is Dictionary<string, object> all)
                        foreach (var kv in all)
                            if (int.TryParse(kv.Key, out int old) && kv.Value is Dictionary<string, object> seq && loadedItems.TryGetValue(old, out var oci) && oci is OCIChar)
                                Seqs[oci.objectInfo.dicKey] = seq;
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Motion sequences not loaded: " + e.Message); }
                SeqChanged(-1);
            }
        }
    }
}
