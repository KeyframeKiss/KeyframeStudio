using System;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using TL = Timeline.Timeline;
using Interpolable = Timeline.Interpolable;
using TLKeyframe = Timeline.Keyframe;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Studio animation clips on the timeline.
    ///
    /// anim.toTimeline: the character's clip goes on the timeline at a moment — Timeline's own "Animation" track (which
    /// clip) and "Animation Time" track (where in the clip), keyed so the clip runs from its start at that moment at
    /// its own speed until the next clip on the track (or the end). Studio's free-running playback is stopped (speed 0)
    /// so scrubbing shows the pose at the playhead and every play and render is the same.
    ///
    /// anim.bake: a clip's motion turned into ordinary FK bone keys over a range (body, head and neck, hands), with
    /// each bone keyed only as often as it takes to stay within about half a degree of the clip. The clip stays on the
    /// timeline underneath (it still moves the hips through space and drives whatever isn't baked); FK on the baked
    /// parts takes over their rotations, so they can be edited like any other keys. One undo step each.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static void RegisterAnimTimeline(CommandRouter r)
        {
            r.Add("anim.timeline", a => ClipTimeline(CharaApi.Chara(a.GetInt("id"))));
            r.Add("anim.toTimeline", ClipToTimeline);
            r.Add("anim.bake", BakeClip);
        }

        private static AnimationCurve HoldCurve() => new AnimationCurve(new UnityEngine.Keyframe(0f, 0f, 0f, 0f), new UnityEngine.Keyframe(1f, 1f, float.PositiveInfinity, 0f));

        private static Interpolable CharTrack(OCIChar c, string model) =>
            Interpolables.Values.FirstOrDefault(ip => ip.oci == c && ip.id == model && ip.parameter == null);

        /// <summary>The character's clip is driven by the timeline (an Animation Time track with keys on it).</summary>
        internal static bool ClipDriven(OCIChar c)
        {
            var ip = CharTrack(c, "charAnimationTime");
            return ip != null && ip.enabled && ip.keyframes.Count > 0;
        }

        private static string ClipName(OICharInfo.AnimeInfo ai)
        {
            string name = null;
            try { name = Info.Instance.dicAnimeLoadInfo[ai.group][ai.category][ai.no].name; } catch { }
            if (string.IsNullOrEmpty(name)) return "Animation";
            return Translation.Get(name, false, "Character panel") ?? name;
        }

        /// <summary>{driven, tracks:{clip, time}, segments:[{t0, t1, name, group, category, no}]}</summary>
        private static object ClipTimeline(OCIChar c)
        {
            var anim = CharTrack(c, "charAnimation");
            var time = CharTrack(c, "charAnimationTime");
            var segs = new List<object>();
            if (anim != null)
            {
                var keys = anim.keyframes.ToList();
                for (int i = 0; i < keys.Count; i++)
                {
                    if (!(keys[i].Value.value is OICharInfo.AnimeInfo ai)) continue;
                    segs.Add(new Dictionary<string, object>
                    {
                        { "t0", Math.Round(keys[i].Key, 4) },
                        { "t1", Math.Round(i + 1 < keys.Count ? keys[i + 1].Key : TL.duration, 4) },
                        { "name", ClipName(ai) }, { "group", ai.group }, { "category", ai.category }, { "no", ai.no },
                    });
                }
            }
            return new Dictionary<string, object>
            {
                { "driven", ClipDriven(c) },
                { "tracks", new Dictionary<string, object> { { "clip", anim?.GetHashCode() }, { "time", time?.GetHashCode() } } },
                { "segments", segs },
            };
        }

        /// <summary>The character's track of this model, made if it isn't there (recorded for undo either way).</summary>
        private static Interpolable EnsureCharTrack(OCIChar c, string model)
        {
            var ip = CharTrack(c, model);
            if (ip != null) { History.Record(new[] { ip }); return ip; }
            var id = AddTrack(new Dictionary<string, object> { { "owner", "Timeline" }, { "model", model }, { "oci", c.objectInfo.dicKey } });
            return Interpolables[Convert.ToInt32(id)];
        }

        /// <summary>args: {id, t?: when the clip starts (default the playhead)} → {t0, t1, name, length, speed}.</summary>
        private static object ClipToTimeline(Dictionary<string, object> a)
        {
            var s0 = Ready;
            if (TL.isPlaying) throw new BridgeException("Pause the timeline first");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null || c.charAnimeCtrl?.animator == null) throw new BridgeException("That character isn't loaded");
            float t0 = Mathf.Clamp(a.Has("t") ? a.GetFloat("t") : TL.playbackTime, 0f, TL.duration);
            Dictionary<string, object> r;
            UndoStack.BeginGroup();
            try { r = PutOnTimeline(c, t0); }
            finally { UndoStack.EndGroup("Clip on the timeline"); }
            AfterEdit();
            return r;
        }

        /// <summary>
        /// Key the character's current clip to start at t0 (no undo group of its own). Animation Time is linear over
        /// the clip's stretch and holds at its last value, so the next clip starts cleanly from its own beginning.
        /// </summary>
        private static Dictionary<string, object> PutOnTimeline(OCIChar c, float t0)
        {
            var s = Ready;
            int fps = Mathf.Clamp((int)F_fps.GetValue(s), 1, 240);
            float frame = 1f / fps;
            var animator = c.charAnimeCtrl.animator;
            var st = animator.GetCurrentAnimatorStateInfo(0);
            float len = st.length > 1e-3f ? st.length : 1f;
            float speed = c.animeSpeed > 1e-3f ? c.animeSpeed : 1f;
            var ai = c.oiCharInfo.animeInfo;

            var clip = EnsureCharTrack(c, "charAnimation");
            var time = EnsureCharTrack(c, "charAnimationTime");
            var muted = new[] { clip, time }.Where(ip => !ip.enabled).ToList();
            if (muted.Count > 0)
            {
                UndoStack.Push(new MuteUndo(muted.ToDictionary(ip => ip, ip => ip.enabled), "Unmute tracks"));
                foreach (var ip in muted) ip.enabled = true;
            }
            // which clip from t0 (Timeline's own reader of the current one)
            AddOrUpdateKey(clip, t0);
            // its stretch: up to the next clip on the track, or the end of the timeline
            float t1 = TL.duration;
            foreach (var kv in clip.keyframes) if (kv.Key > t0 + 1e-4f) { t1 = kv.Key; break; }
            bool next = t1 < TL.duration - 1e-4f;
            float te = next ? Mathf.Max(t0 + frame * 0.5f, t1 - frame) : t1;

            // where the clip before this one had got to just before t0: it holds there, then this one starts
            float before = t0 - frame;
            float? held = null;
            if (before > 1e-4f)
            {
                KeyValuePair<float, TLKeyframe>? l = null, rr = null;
                foreach (var kv in time.keyframes) { if (kv.Key <= before + 1e-4f) l = kv; else { rr = kv; break; } }
                if (l != null && l.Value.Value.value is float lv)
                {
                    if (rr != null && rr.Value.Value.value is float rv && rr.Value.Key > l.Value.Key)
                    {
                        float u = (before - l.Value.Key) / (rr.Value.Key - l.Value.Key);
                        held = Mathf.LerpUnclamped(lv, rv, l.Value.Value.curve.Evaluate(u));
                    }
                    else held = lv;
                }
            }
            foreach (var t in time.keyframes.Keys.Where(t => t > before + 1e-4f && t < (next ? t1 - 1e-4f : t1 + 1e-4f)).ToList())
                time.keyframes.Remove(t);
            if (held != null) time.keyframes[before] = new TLKeyframe(held.Value, time, HoldCurve());
            time.keyframes[t0] = new TLKeyframe(0f, time, AnimationCurve.Linear(0f, 0f, 1f, 1f));
            float endValue = (te - t0) * speed / len;
            if (te > t0 + 1e-4f) time.keyframes[te] = new TLKeyframe(endValue, time, HoldCurve());

            // the timeline drives it now: no free-running on top (scrub = the pose at the playhead)
            if (c.animeSpeed > 1e-3f)
            {
                UndoStack.Push(CharaApi.CharaUndo.Capture(new[] { c }, "anime", "Clip on the timeline"));
                c.animeSpeed = 0f;
            }
            return new Dictionary<string, object>
            {
                { "t0", Math.Round(t0, 4) }, { "t1", Math.Round(t1, 4) }, { "name", ClipName(ai) },
                { "length", Math.Round(len, 4) }, { "speed", Math.Round(speed, 4) }, { "loop", st.loop },
                { "tracks", new List<object> { clip.GetHashCode(), time.GetHashCode() } },
            };
        }

        // ------------------------------------------------------------------ muting follows through

        /// <summary>
        /// After tracks were muted / unmuted (inside the mute's undo group). Only for characters whose clip is on the
        /// timeline (what they'd show without their bone keys is that clip):
        ///  · an FK part whose bone keys are now all muted goes back to the clip (FK off for it); unmuting any of them
        ///    gives the part to its keys again (FK on). Otherwise FK would hold the last pose: a frozen body while the
        ///    clip carries the hips on.
        ///  · an unmuted Animation Time track drives the clip again: Studio's own playback stops (speed 0), or the clip
        ///    would run on by itself between frames and while paused.
        /// </summary>
        private static void FollowMute(List<Interpolable> changed, bool on)
        {
            foreach (var c in changed.Select(ip => ip.oci as OCIChar).Where(x => x?.charInfo != null).Distinct().ToList())
            {
                var mine = changed.Where(ip => ip.oci == c).ToList();
                var time = CharTrack(c, "charAnimationTime");
                if (time == null || time.keyframes.Count == 0) continue; // no clip on the timeline: muting stays as it was

                if (on && mine.Contains(time) && c.animeSpeed > 1e-3f)
                {
                    UndoStack.Push(CharaApi.CharaUndo.Capture(new[] { c }, "anime", "Unmute tracks"));
                    c.animeSpeed = 0f;
                }

                // bone keys: which FK part each belongs to
                Func<Interpolable, int> partOf = ip =>
                {
                    if (ip.id != "guideObjectRot" || !(ip.parameter is GuideObject g)) return -1;
                    var b = c.listBones.FirstOrDefault(x => x?.guideObject == g);
                    return b != null ? ViewportGizmos.FkPart(b.boneGroup) : -1;
                };
                var parts = mine.Select(partOf).Where(p => p >= 0).Distinct().ToList();
                if (parts.Count == 0) continue;
                var all = Interpolables.Values.Where(ip => ip.oci == c && ip.keyframes.Count > 0).ToList();
                bool recorded = false;
                foreach (int part in parts)
                {
                    var tracks = all.Where(ip => partOf(ip) == part).ToList();
                    if (tracks.Count == 0) continue;
                    bool want = tracks.Any(ip => ip.enabled);
                    if (want == ViewportGizmos.FkOn(c, part)) continue;
                    if (!recorded) { UndoStack.Push(new KinematicsUndo(c, ViewportGizmos.KinematicsRestorer(c))); recorded = true; }
                    if (want)
                    {
                        int bone = c.listBones.FindIndex(b => b?.guideObject != null && ViewportGizmos.FkPart(b.boneGroup) == part);
                        if (bone >= 0) ViewportGizmos.EnsureFk(c, bone);
                    }
                    else
                    {
                        c.ActiveFK(FKCtrl.parts[part], false, false);
                        if (!c.oiCharInfo.activeFK.Any(x => x)) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, false, false);
                    }
                }
            }
        }

        /// <summary>The character's clip tracks are there with keys but muted: unmute them (undoable). True if it did.</summary>
        private static bool UnmuteClip(OCIChar c)
        {
            var tracks = new[] { CharTrack(c, "charAnimation"), CharTrack(c, "charAnimationTime") }.Where(ip => ip != null && !ip.enabled && ip.keyframes.Count > 0).ToList();
            if (tracks.Count == 0) return false;
            UndoStack.Push(new MuteUndo(tracks.ToDictionary(ip => ip, ip => ip.enabled), "Unmute tracks"));
            foreach (var ip in tracks) ip.enabled = true;
            return true;
        }

        // ------------------------------------------------------------------ bake to FK keys

        private static readonly Dictionary<string, OIBoneInfo.BoneGroup[]> BakeParts = new Dictionary<string, OIBoneInfo.BoneGroup[]>
        {
            { "body", new[] { OIBoneInfo.BoneGroup.Body } },
            { "neck", new[] { OIBoneInfo.BoneGroup.Neck } },
            { "hands", new[] { OIBoneInfo.BoneGroup.RightHand, OIBoneInfo.BoneGroup.LeftHand } },
        };

        /// <summary>
        /// args: {id, t0?, t1? (default: the whole timeline), parts?: [body, neck, hands] (default all), tolerance?: degrees
        /// (default 0.5)} → {keys, bones, samples, t0, t1, name, folder}.
        /// </summary>
        private static object BakeClip(Dictionary<string, object> a)
        {
            var s = Ready;
            if (LockRunning || MotionSampler.Running || ViewportTools.Busy) throw new BridgeException("Already busy — try again in a moment");
            if (TL.isPlaying) throw new BridgeException("Pause the timeline first");
            if (PendingCount > 0) throw new BridgeException("Key or reset your unkeyed changes first — baking steps through the timeline, which would undo them");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null || c.charAnimeCtrl?.animator == null) throw new BridgeException("That character isn't loaded");

            float dur = TL.duration;
            float t0 = Mathf.Clamp(a.Has("t0") ? a.GetFloat("t0") : 0f, 0f, dur);
            float t1 = Mathf.Clamp(a.Has("t1") ? a.GetFloat("t1") : dur, 0f, dur);
            if (t1 < t0) { var x = t0; t0 = t1; t1 = x; }
            int fps = Mathf.Clamp((int)F_fps.GetValue(s), 1, 240);
            if (t1 - t0 < 1f / fps - 1e-4f) throw new BridgeException("Make the range at least a frame long");
            float rate = Mathf.Min(fps, 30);
            int n = Mathf.CeilToInt((t1 - t0) * rate);
            if (n > 3600) throw new BridgeException("That range is too long to bake in one go — bake it in a few shorter parts");
            var times = new List<float>();
            for (int i = 0; i <= n; i++) times.Add(Mathf.Min(t1, t0 + i / rate));
            if (t1 - times[times.Count - 1] > 1e-4f) times.Add(t1);

            var partNames = a.GetList("parts").Select(o => o as string).Where(x => x != null && BakeParts.ContainsKey(x)).Distinct().ToList();
            if (!a.Has("parts")) partNames = BakeParts.Keys.ToList();
            if (partNames.Count == 0) throw new BridgeException("Pick what to bake: body, head and neck, hands");
            var groups = partNames.SelectMany(p => BakeParts[p]).ToList();
            var partIdx = new HashSet<int>(groups.Select(g => ViewportGizmos.FkPart(g)).Where(i => i >= 0));
            var bones = new List<OCIChar.BoneInfo>();
            foreach (var b in c.listBones)
                if (b?.guideObject?.transformTarget != null && partIdx.Contains(ViewportGizmos.FkPart(b.boneGroup))) bones.Add(b);
            if (bones.Count == 0) throw new BridgeException("This character has no FK bones for that");
            float tol = Mathf.Clamp(a.Has("tolerance") ? a.GetFloat("tolerance") : 0.5f, 0.05f, 10f);

            var rotModel = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == "guideObjectRot")
                ?? throw new BridgeException("Timeline's rotation track type wasn't found");
            var animator = c.charAnimeCtrl.animator;
            float back = TL.playbackTime;
            string name = ClipName(c.oiCharInfo.animeInfo);
            var rot = bones.Select(b => new Quaternion[times.Count]).ToList();
            int keys = 0;
            var made = new List<int>();

            UndoStack.BeginGroup();
            try
            {
                // the clip runs on the timeline (so the bake and what's left of the clip stay in step)
                // its tracks muted: unmute them (re-putting it from t0 would rewrite its stretches)
                if (!UnmuteClip(c) && !ClipDriven(c)) PutOnTimeline(c, t0);
                if (c.animeSpeed > 1e-3f)
                {
                    UndoStack.Push(CharaApi.CharaUndo.Capture(new[] { c }, "anime", "Bake"));
                    c.animeSpeed = 0f;
                }
                UndoStack.Push(new KinematicsUndo(c, ViewportGizmos.KinematicsRestorer(c)));
                // nothing holding the body: the bones show the clip alone
                if (c.oiCharInfo.enableFK) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, false, false);
                if (c.oiCharInfo.enableIK) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, false, false);

                var clipOf = new Func<string>(() => { var x = c.oiCharInfo.animeInfo; return x.group + "/" + x.category + "/" + x.no; });
                try
                {
                    string was = clipOf();
                    for (int k = 0; k < times.Count; k++)
                    {
                        float t = times[k];
                        if (Mathf.Abs(TL.playbackTime - t) < 1e-6f) TL.Seek(t + 1e-4f);
                        TL.Seek(t);
                        animator.Update(0f);
                        // another clip took over here: its state only exists from this update on, so set its time again
                        string now = clipOf();
                        if (now != was) { TL.Seek(t + 1e-4f); TL.Seek(t); animator.Update(0f); was = now; }
                        for (int i = 0; i < bones.Count; i++) rot[i][k] = bones[i].guideObject.transformTarget.localRotation;
                    }
                }
                finally
                {
                    if (Mathf.Abs(TL.playbackTime - back) < 1e-6f) TL.Seek(back + 1e-4f);
                    TL.Seek(back);
                }

                // FK on for the baked parts only (the rest follows the clip)
                var info = c.oiCharInfo;
                for (int i = 0; i < info.activeFK.Length; i++) info.activeFK[i] = partIdx.Contains(i);
                c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, true, false);
                for (int i = 0; i < FKCtrl.parts.Length && i < info.activeFK.Length; i++) c.ActiveFK(FKCtrl.parts[i], info.activeFK[i], true);

                int before = Interpolables.Count;
                var existing = new HashSet<Interpolable>(Interpolables.Values);
                for (int i = 0; i < bones.Count; i++)
                {
                    var g = bones[i].guideObject;
                    var q = rot[i];
                    var forced = new List<int> { 0, times.Count - 1 };
                    var ks = Simplify(forced, 0, times.Count - 1, (k, x, y, f) => Quaternion.Angle(Quaternion.SlerpUnclamped(q[x], q[y], f), q[k]), tol, times);
                    var keep = g.changeAmount.rot;
                    keys += WriteGuideKeys(c, g, rotModel, ks, times, 0, times.Count - 1, true, k => g.changeAmount.rot = q[k].eulerAngles);
                    g.changeAmount.rot = keep;
                }
                made.AddRange(Interpolables.Values.Where(ip => !existing.Contains(ip)).Select(ip => ip.GetHashCode()));
                if (made.Count > 0)
                    Undoable("Bake " + name, () => GroupCreate(new Dictionary<string, object> { { "name", name + " (baked)" }, { "tracks", made.Cast<object>().ToList() } }));
            }
            finally
            {
                UndoStack.EndGroup("Bake " + name);
            }
            AfterEdit();
            EventPump.RequestRebase();
            return new Dictionary<string, object>
            {
                { "keys", keys }, { "bones", bones.Count }, { "samples", times.Count }, { "tracks", made.Count },
                { "t0", Math.Round(t0, 4) }, { "t1", Math.Round(t1, 4) }, { "name", name },
                { "parts", partNames.Cast<object>().ToList() },
            };
        }
    }
}
