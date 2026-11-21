using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using TL = Timeline.Timeline;
using Interpolable = Timeline.Interpolable;
using TLKeyframe = Timeline.Keyframe;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Foot and hand locking: a foot (or hand) stays on one spot in the world over a time range while the rest of the
    /// body keeps moving. It works on the limb's IK target: the timeline is stepped frame by frame over the range (like
    /// the foot-sliding check), the target's place under its moving parent is worked out for each frame, and only as
    /// many keys are written as it takes to stay within a few millimetres (linear between them).
    ///
    /// A limb posed with FK goes to IK first. So that nothing else about it changes, its FK motion over the whole
    /// timeline is converted into keys on all of that limb's IK targets (hand / foot, elbow / knee, shoulder / thigh)
    /// before the lock is written. Everything (keys, new tracks, the FK / IK switch) is one undo step.
    /// Result arrives as the "motion.lock" event: {progress} while stepping, then {done, keys, converted} or {error}.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static void RegisterLimbLock(CommandRouter r) => r.Add("motion.lock", LimbLockStart);

        public static bool LockRunning { get; private set; }

        /// <summary>The IK part (Studio's activeIK index) of each lockable limb.</summary>
        private static readonly Dictionary<string, int> LimbParts = new Dictionary<string, int>
        {
            { "footR", 1 }, { "footL", 2 }, { "handR", 3 }, { "handL", 4 },
        };
        private static readonly Dictionary<string, string> LimbNames = new Dictionary<string, string>
        {
            { "footR", "right foot" }, { "footL", "left foot" }, { "handR", "right hand" }, { "handL", "left hand" },
        };

        /// <summary>The limb's IK targets, from its root (shoulder / thigh) to its end (hand / foot).</summary>
        private static List<int> LimbTargets(OCIChar c, int part)
        {
            var idx = new List<int>();
            for (int i = 0; i < c.listIKTarget.Count; i++)
            {
                var k = c.listIKTarget[i];
                if (k?.guideObject != null && k.targetObject != null && k.boneObject != null && ViewportGizmos.IkPart(k.boneGroup) == part) idx.Add(i);
            }
            // order by how deep each target's bone is under the others' (no reliance on names)
            Func<int, int> depth = i => idx.Count(j => j != i && c.listIKTarget[i].boneObject.IsChildOf(c.listIKTarget[j].boneObject));
            return idx.OrderBy(depth).ToList();
        }

        private sealed class LockJob
        {
            public OCIChar Chara;
            public string Limb;
            public int Part;
            public List<int> Targets; // root … end
            public int End;
            public float T0, T1, At;
            public float Blend, BlendIn; // seconds to ease back into the limb's own motion after (and before) the lock
            public float LimbLength; // root → middle → end bone, for the reach check
            public bool Rotation, Convert;
            public List<float> Times;
            public float Back;
        }

        /// <summary>
        /// args: {id, limb: footL|footR|handL|handR, t0, t1, at?: the moment whose spot is kept (default t0),
        /// rotation?: keep its angle too (default true), blend?: seconds to ease back into its own motion after the
        /// range (and into the lock before it, when the kept moment isn't t0; default 0.25)} → {samples, convert}.
        /// </summary>
        private static object LimbLockStart(Dictionary<string, object> a)
        {
            var s = Ready;
            if (LockRunning || MotionSampler.Running || ViewportTools.Busy) throw new BridgeException("Already busy — try again in a moment");
            if (TL.isPlaying) throw new BridgeException("Pause the timeline first");
            if (PendingCount > 0) throw new BridgeException("Key or reset your unkeyed changes first — locking steps through the timeline, which would undo them");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null || c.finalIK == null) throw new BridgeException("That character isn't loaded");
            string limb = a.GetString("limb") ?? "";
            if (!LimbParts.TryGetValue(limb, out int part)) throw new BridgeException("Which foot or hand?");
            var targets = LimbTargets(c, part);
            if (targets.Count == 0) throw new BridgeException("This character has no IK targets for its " + LimbNames[limb]);

            float dur = TL.duration;
            float t0 = Mathf.Clamp(a.GetFloat("t0"), 0f, dur);
            float t1 = Mathf.Clamp(a.GetFloat("t1"), 0f, dur);
            if (t1 < t0) { var x = t0; t0 = t1; t1 = x; }
            int fps = Mathf.Clamp((int)F_fps.GetValue(s), 1, 240);
            if (t1 - t0 < 1f / fps - 1e-4f) throw new BridgeException("Make the range at least a frame long");
            float at = Mathf.Clamp(a.Has("at") ? a.GetFloat("at") : t0, t0, t1);
            var end = c.listIKTarget[targets[targets.Count - 1]];
            bool convert = !ViewportGizmos.IkOn(c, part);
            float blend = Mathf.Clamp(a.Has("blend") ? a.GetFloat("blend") : 0.25f, 0f, 2f);
            float blendIn = at > t0 + 1e-4f ? blend : 0f; // kept spot = where it is at t0: nothing to ease into
            float lo = Mathf.Max(0f, t0 - blendIn), hi = Mathf.Min(dur, t1 + blend);
            float limbLength = 0f;
            for (int i = 1; i < targets.Count; i++)
                limbLength += Vector3.Distance(c.listIKTarget[targets[i - 1]].boneObject.position, c.listIKTarget[targets[i]].boneObject.position);

            // the moments to look at: every frame of the range and its easing (up to 60 a second); with a
            // conversion, the whole timeline as well, at up to 30 a second
            const int maxSamples = 1500;
            float rateL = Mathf.Min(fps, 60);
            int nL = Mathf.CeilToInt((hi - lo) * rateL);
            if (nL > maxSamples / (convert ? 2 : 1)) throw new BridgeException("That range is too long to lock in one go — lock it in a few shorter parts");
            var times = new List<float>();
            for (int i = 0; i <= nL; i++) times.Add(Mathf.Min(hi, lo + i / rateL));
            times.Add(t0);
            times.Add(t1);
            times.Add(at);
            if (convert)
            {
                float rateC = Mathf.Min(Mathf.Min(fps, 30), (maxSamples - times.Count) / Mathf.Max(dur, 0.01f));
                int nC = Mathf.Max(1, Mathf.CeilToInt(dur * rateC));
                for (int i = 0; i <= nC; i++) times.Add(Mathf.Min(dur, dur * i / nC));
            }
            times.Sort();
            var unique = new List<float>();
            foreach (var t in times) if (unique.Count == 0 || t - unique[unique.Count - 1] > 1e-4f) unique.Add(t);

            var job = new LockJob
            {
                Chara = c, Limb = limb, Part = part, Targets = targets, End = targets[targets.Count - 1],
                T0 = t0, T1 = t1, At = at, Convert = convert, Blend = blend, BlendIn = blendIn, LimbLength = limbLength,
                Rotation = a.GetBool("rotation", true) && end.guideObject.enableRot,
                Times = unique, Back = TL.playbackTime,
            };
            LockRunning = true;
            StudioBridgePlugin.Instance.StartCoroutine(LockRun(job));
            return new Dictionary<string, object> { { "samples", unique.Count }, { "convert", convert } };
        }

        /// <summary>What was seen at one moment for one target: its parent's placement and its own local values.</summary>
        private struct LockSample
        {
            public Matrix4x4 ParentToWorld;
            public Quaternion ParentRot;
            public float Scale;
            public Vector3 Pos;
            public Quaternion Rot;
            public Vector3 Bone; // where its bone is (the limb's root bone, for the reach check)
        }

        private static IEnumerator LockRun(LockJob job)
        {
            var c = job.Chara;
            int n = job.Times.Count;
            var watched = job.Convert ? job.Targets : new List<int> { job.Targets[0], job.End }.Distinct().ToList();
            var seen = watched.ToDictionary(i => i, i => new LockSample[n]);
            string error = null;
            bool seeked = false, stepped = false;
            try
            {
                for (int k = 0; k < n; k++)
                {
                    ViewportTools.HoldBusy(); // requests and change detection wait until we're done
                    TL.Seek(job.Times[k]);
                    seeked = true;
                    yield return new WaitForEndOfFrame(); // animation, FK and IK applied for this moment
                    if (c.charInfo == null) { error = "The character was removed"; yield break; }
                    foreach (int i in watched)
                    {
                        var ik = c.listIKTarget[i];
                        // FK limb: where its IK target would be to hold the pose on screen (Studio's own copy)
                        if (job.Convert) ik.CopyBone();
                        var parent = ik.targetObject.parent;
                        seen[i][k] = new LockSample
                        {
                            ParentToWorld = parent != null ? parent.localToWorldMatrix : Matrix4x4.identity,
                            ParentRot = parent != null ? parent.rotation : Quaternion.identity,
                            Scale = parent != null ? Mathf.Abs(parent.lossyScale.x) : 1f,
                            Pos = ik.guideObject.changeAmount.pos,
                            Rot = Quaternion.Euler(ik.guideObject.changeAmount.rot),
                            Bone = ik.boneObject.position,
                        };
                    }
                    if (k % 20 == 0)
                        StudioBridgePlugin.Instance?.Broadcast("motion.lock", new Dictionary<string, object> { { "progress", Math.Round((double)k / n, 3) } });
                }
                stepped = true;
            }
            finally
            {
                if (seeked) { try { TL.Seek(job.Back); } catch { } }
                ViewportTools.Busy = false;
                // stopped early (removed character, or something threw): say so instead of leaving the app waiting
                if (!stepped) Finish(job, null, error ?? "Stepping through the timeline failed — see the BepInEx log");
            }

            Dictionary<string, object> result = null;
            try { result = LockApply(job, seen); }
            catch (Exception e)
            {
                error = e is BridgeException ? e.Message : "Locking failed: " + e.Message;
                StudioBridgePlugin.Logger.LogWarning("Limb lock: " + e);
            }
            Finish(job, result, error);
        }

        private static void Finish(LockJob job, Dictionary<string, object> result, string error)
        {
            if (!LockRunning) return;
            LockRunning = false;
            EventPump.RequestRebase();
            var msg = error != null ? new Dictionary<string, object> { { "done", true }, { "error", error } } : result;
            msg["done"] = true;
            StudioBridgePlugin.Instance?.Broadcast("motion.lock", msg);
        }

        private static Dictionary<string, object> LockApply(LockJob job, Dictionary<int, LockSample[]> seen)
        {
            var c = job.Chara;
            var times = job.Times;
            int n = times.Count;
            Func<float, int> indexOf = t =>
            {
                int best = 0;
                for (int k = 1; k < n; k++) if (Mathf.Abs(times[k] - t) < Mathf.Abs(times[best] - t)) best = k;
                return best;
            };
            int k0 = indexOf(job.T0), k1 = indexOf(job.T1), kAt = indexOf(job.At);
            int kLo = indexOf(job.T0 - job.BlendIn), kHi = indexOf(job.T1 + job.Blend);
            // how much the hand or foot is held at sample k: fully over the range, easing to its own motion around it
            Func<float, float> smooth = u => u <= 0f ? 0f : u >= 1f ? 1f : u * u * (3f - 2f * u);
            Func<int, float> hold = k =>
            {
                float t = times[k];
                if (k >= k0 && k <= k1) return 1f;
                if (t > job.T1 && job.Blend > 0f) return 1f - smooth((t - job.T1) / job.Blend);
                if (t < job.T0 && job.BlendIn > 0f) return 1f - smooth((job.T0 - t) / job.BlendIn);
                return 0f;
            };

            // the spot (and angle) the hand or foot keeps: where it is at the chosen moment, in the world
            var endSeen = seen[job.End];
            var lockPos = endSeen[kAt].ParentToWorld.MultiplyPoint3x4(endSeen[kAt].Pos);
            var lockRot = endSeen[kAt].ParentRot * endSeen[kAt].Rot;

            // the tolerance scales with the limb (whatever the character's size or pose): about 2 mm on a real leg
            float posTol = Mathf.Max(1e-4f, 0.002f * (job.LimbLength > 0.01f ? job.LimbLength : 0.5f));
            const float rotTol = 1f; // degrees

            var posModel = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == "guideObjectPos");
            var rotModel = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == "guideObjectRot");
            if (posModel == null || rotModel == null) throw new BridgeException("Timeline's position / rotation track types weren't found");

            UndoStack.BeginGroup();
            int written = 0;
            float reachFrom = -1f, reachShort = 0f;
            try
            {
                if (job.Convert)
                {
                    UndoStack.Push(new KinematicsUndo(c, ViewportGizmos.KinematicsRestorer(c)));
                    ViewportGizmos.EnsureIk(c, job.End); // this limb only; FK stays on beside it
                }

                var rewrite = job.Convert ? job.Targets : new List<int> { job.End };
                foreach (int i in rewrite)
                {
                    var ik = c.listIKTarget[i];
                    var g = ik.guideObject;
                    bool isEnd = i == job.End;
                    var ss = seen[i];
                    // the range this target's keys are rewritten in
                    int from = job.Convert ? 0 : kLo, to = job.Convert ? n - 1 : kHi;
                    var pos = new Vector3[n];
                    var rot = new Quaternion[n];
                    for (int k = from; k <= to; k++)
                    {
                        float w = isEnd ? hold(k) : 0f;
                        if (w <= 0f) { pos[k] = ss[k].Pos; rot[k] = ss[k].Rot; continue; }
                        // between its own place and the kept spot, in the world, then back under its (moving) parent
                        var own = ss[k].ParentToWorld.MultiplyPoint3x4(ss[k].Pos);
                        var ownRot = ss[k].ParentRot * ss[k].Rot;
                        var want = Vector3.Lerp(own, lockPos, w);
                        var wantRot = job.Rotation ? Quaternion.Slerp(ownRot, lockRot, w) : ownRot;
                        pos[k] = ss[k].ParentToWorld.inverse.MultiplyPoint3x4(want);
                        rot[k] = Quaternion.Inverse(ss[k].ParentRot) * wantRot;
                        // can the limb reach? (its root bone moves with the body; the limb is only so long)
                        // (only while it's fully held: easing out it's on its way back to where it can reach)
                        if (w >= 1f && job.LimbLength > 0f && job.Targets.Count > 1 && seen.TryGetValue(job.Targets[0], out var root))
                        {
                            float shortBy = Vector3.Distance(root[k].Bone, want) - job.LimbLength;
                            if (shortBy > 0.01f * job.LimbLength)
                            {
                                if (reachFrom < 0f) reachFrom = times[k];
                                reachShort = Mathf.Max(reachShort, shortBy);
                            }
                        }
                    }
                    // rotation keys: the end target when its angle is kept or the limb is converted; the others if they turn
                    bool doRot = g.enableRot && (isEnd ? job.Rotation || job.Convert : job.Convert);

                    var forced = new List<int> { from, to };
                    if (isEnd) { forced.Add(k0); forced.Add(k1); forced.Add(kLo); forced.Add(kHi); }
                    var posKeys = Simplify(forced, from, to, (k, a, b, f) => Vector3.Distance(Vector3.LerpUnclamped(pos[a], pos[b], f), pos[k]) * ss[k].Scale, posTol, times);
                    written += WriteGuideKeys(c, g, posModel, posKeys, times, from, to, job, k => g.changeAmount.pos = pos[k]);
                    if (doRot)
                    {
                        var rotKeys = Simplify(forced, from, to, (k, a, b, f) => Quaternion.Angle(Quaternion.SlerpUnclamped(rot[a], rot[b], f), rot[k]), rotTol, times);
                        written += WriteGuideKeys(c, g, rotModel, rotKeys, times, from, to, job, k => g.changeAmount.rot = rot[k].eulerAngles);
                    }
                }
            }
            finally
            {
                UndoStack.EndGroup("Lock " + LimbNames[job.Limb]);
            }
            AfterEdit();
            var result = new Dictionary<string, object>
            {
                { "keys", written }, { "converted", job.Convert }, { "limb", job.Limb },
                { "t0", Math.Round(job.T0, 4) }, { "t1", Math.Round(job.T1, 4) },
            };
            // out of reach somewhere: it's held as close as the limb allows; say from when, and how far short
            if (reachFrom >= 0f)
                result["outOfReach"] = new Dictionary<string, object> { { "from", Math.Round(reachFrom, 3) }, { "short", Math.Round(reachShort / job.LimbLength, 3) } };
            return result;
        }

        /// <summary>
        /// The fewest samples to key so straight-line interpolation between them stays within the tolerance
        /// everywhere (split each stretch at its worst sample until none is off by more).
        /// err(k, a, b, f): how far sample k is from the line between keys a and b at fraction f.
        /// </summary>
        private static List<int> Simplify(List<int> forced, int from, int to, Func<int, int, int, float, float> err, float tol, List<float> times)
        {
            var keys = new HashSet<int>(forced.Where(k => k >= from && k <= to));
            var stack = new Stack<KeyValuePair<int, int>>();
            var list = keys.OrderBy(k => k).ToList();
            for (int i = 0; i + 1 < list.Count; i++) stack.Push(new KeyValuePair<int, int>(list[i], list[i + 1]));
            while (stack.Count > 0)
            {
                var seg = stack.Pop();
                int a = seg.Key, b = seg.Value;
                if (b - a < 2) continue;
                float span = times[b] - times[a];
                int worst = -1;
                float worstErr = tol;
                for (int k = a + 1; k < b; k++)
                {
                    float f = span > 1e-6f ? (times[k] - times[a]) / span : 0f;
                    float e = err(k, a, b, f);
                    if (e > worstErr) { worstErr = e; worst = k; }
                }
                if (worst < 0) continue;
                keys.Add(worst);
                stack.Push(new KeyValuePair<int, int>(a, worst));
                stack.Push(new KeyValuePair<int, int>(worst, b));
            }
            return keys.OrderBy(k => k).ToList();
        }

        /// <summary>
        /// Replace a guide object track's keys over [times[from], times[to]] with keys at the given samples (its track
        /// is made if needed). set(k) puts sample k's value on the guide object so the track reads it in its own type.
        /// </summary>
        private static int WriteGuideKeys(OCIChar c, GuideObject g, Timeline.InterpolableModel model, List<int> keys, List<float> times, int from, int to, LockJob job, Action<int> set)
        {
            var ip = new Interpolable(c, g, model);
            if (Interpolables.TryGetValue(ip.GetHashCode(), out var already))
            {
                ip = already;
                History.Record(new[] { ip });
            }
            else
            {
                Interpolables[ip.GetHashCode()] = ip;
                AccessTools.Method(Tree.GetType(), "AddLeaf").Invoke(Tree, new object[] { ip, null });
                History.Push(new List<TrackSnapshot> { new TrackSnapshot { Track = ip, Present = false, Keys = new List<KeyValuePair<float, TLKeyframe>>() } });
            }

            float lo = times[from] - 1e-4f, hi = times[to] + 1e-4f;
            // the easing that carried on past the range: the last old key at or before its end
            AnimationCurve after = null;
            foreach (var kv in ip.keyframes) { if (kv.Key <= hi) after = kv.Value.curve; else break; }
            var gone = ip.keyframes.Keys.Where(t => t >= lo && t <= hi).ToList();
            foreach (var t in gone) ip.keyframes.Remove(t);

            var linear = AnimationCurve.Linear(0f, 0f, 1f, 1f);
            foreach (int k in keys)
            {
                set(k);
                var curve = k == to && after != null && !job.Convert ? new AnimationCurve(after.keys) : new AnimationCurve(linear.keys);
                ip.keyframes[times[k]] = new TLKeyframe(ip.GetValue(), ip, curve);
            }
            return keys.Count;
        }

        /// <summary>Undo for the FK / IK switch a lock makes (with the keys, in the same step).</summary>
        private sealed class KinematicsUndo : IUndoEntry
        {
            private readonly OCIChar _c;
            private readonly Action _restore;
            public KinematicsUndo(OCIChar c, Action restore) { _c = c; _restore = restore; }
            public string Label => "FK / IK";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                if (_c?.charInfo == null) return null;
                var inverse = new KinematicsUndo(_c, ViewportGizmos.KinematicsRestorer(_c));
                _restore();
                return inverse;
            }
        }
    }
}
