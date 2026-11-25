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
    /// Camera move presets: from the camera as it is now, write the keys for an orbit, dolly, zoom, pan, crane or
    /// truck over a time range. Studio's camera turns around a pivot (pos) at a distance; Timeline animates the
    /// pivot, its rotation (slerp — so long turns get a key every 45°), the distance and the field of view.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static void RegisterCameraMoves(CommandRouter r) => r.Add("camera.move", CameraMove);

        private struct CamState
        {
            public Vector3 Pos, Rot, Dist;
            public float Fov;
        }

        /// <summary>
        /// args: {preset: orbit|dolly|zoom|pan|crane|truck, amount, duration, t0?, ease?: "smooth"|"linear"}
        /// amount: orbit/pan degrees, dolly/zoom factor (0.6 = closer/narrower), crane/truck distance as a fraction
        /// of the camera's distance to its subject (unit-free: 0.5 = half that distance).
        /// Camera keys strictly inside the range are replaced. One undo step; the camera ends where it started.
        /// </summary>
        private static object CameraMove(Dictionary<string, object> a)
        {
            // with a free work camera, the move starts from the keyed camera and the user's view comes back after
            bool free = ShotApi.FreeViewWanted;
            var keep = KeepView.Take();
            try
            {
                using (FreeView.Hold()) return CameraMoveHeld(a, free);
            }
            finally
            {
                if (free) keep.Restore();
            }
        }

        private static object CameraMoveHeld(Dictionary<string, object> a, bool free)
        {
            var studio = Singleton<Studio.Studio>.Instance;
            var cc = studio.cameraCtrl;
            string preset = a.GetString("preset") ?? "orbit";
            // check everything before any key is touched
            if (Array.IndexOf(new[] { "orbit", "pan", "dolly", "zoom", "crane", "truck" }, preset) < 0) throw new BridgeException("Unknown camera move: " + preset);
            float amount = a.GetFloat("amount");
            float dur = a.GetFloat("duration", 2f);
            float t0 = Mathf.Clamp(a.Has("t0") ? a.GetFloat("t0") : TL.playbackTime, 0f, TL.duration);
            float t1 = t0 + dur;
            bool smooth = (a.GetString("ease") ?? "smooth") != "linear";
            if (dur < 0.05f) throw new BridgeException("Make the move at least a few frames long");
            if (t1 > TL.duration + 1e-4f) throw new BridgeException("The move would end at " + t1.ToString("0.##") + "s, past the end of the timeline (" + TL.duration.ToString("0.##") + "s) — make the timeline longer or start earlier");
            if (studio.ociCamera != null) throw new BridgeException("A scene camera object is active — switch back to Studio's main camera to key camera moves");

            // Start from the camera at t0: at the playhead that's the camera as the user framed it; elsewhere it's
            // what the keys say there (so moves chain: an orbit's end is the next move's start).
            bool away = Mathf.Abs(t0 - TL.playbackTime) > 1e-4f;
            if (away)
            {
                if (PendingCount > 0) throw new BridgeException("Key or reset your unkeyed changes first — starting a move away from the playhead moves the playhead, which would undo them");
                TL.Seek(t0);
                Reapply(); // evaluate the camera tracks at t0 now, not next frame
            }
            else if (free && PendingCount == 0) Reapply(); // Studio's view is the user's: start from the keyed camera instead
            var start = cc.Export();
            var s0 = new CamState { Pos = start.pos, Rot = start.rotate, Dist = start.distance, Fov = cc.fieldOfView };
            var rot0 = Quaternion.Euler(s0.Rot);
            var camPos0 = s0.Pos + rot0 * s0.Dist;
            float reach = Mathf.Max(0.01f, Mathf.Abs(s0.Dist.z)); // crane/truck distances scale with it

            Func<float, CamState> at = f =>
            {
                var s = s0;
                switch (preset)
                {
                    case "orbit": // around the pivot (the subject)
                        s.Rot = (Quaternion.AngleAxis(amount * f, Vector3.up) * rot0).eulerAngles;
                        break;
                    case "pan": // turn where the camera stands: the pivot swings around the camera
                    {
                        var r = Quaternion.AngleAxis(amount * f, Vector3.up) * rot0;
                        s.Rot = r.eulerAngles;
                        s.Pos = camPos0 - r * s0.Dist;
                        break;
                    }
                    case "dolly": // move closer / further along the view
                        s.Dist = new Vector3(s0.Dist.x, s0.Dist.y, s0.Dist.z * Mathf.Lerp(1f, Mathf.Max(0.05f, amount), f));
                        break;
                    case "zoom": // change the lens, camera stays
                        s.Fov = Mathf.Clamp(s0.Fov * Mathf.Lerp(1f, Mathf.Max(0.05f, amount), f), 1f, 179f);
                        break;
                    case "crane": // rise (or sink) while keeping the subject in frame
                    {
                        var cam = camPos0 + Vector3.up * amount * reach * f;
                        var look = s0.Pos - cam;
                        if (look.sqrMagnitude < 1e-8f) break;
                        var r = Quaternion.LookRotation(look.normalized, Vector3.up);
                        s.Rot = r.eulerAngles;
                        s.Pos = cam - r * s0.Dist;
                        break;
                    }
                    case "truck": // slide sideways, looking the same way
                        s.Pos = s0.Pos + (rot0 * Vector3.right) * amount * reach * f;
                        break;
                    default:
                        throw new BridgeException("Unknown camera move: " + preset);
                }
                return s;
            };

            // turns slerp the short way: a key at least every 45°
            int steps = preset == "orbit" || preset == "pan" ? Mathf.Clamp(Mathf.CeilToInt(Mathf.Abs(amount) / 45f), 1, 64) : 1;
            Func<float, float> ease = x => smooth ? x * x * (3f - 2f * x) : x;

            var tracks = CameraTracksForEdit(out var snap);
            if (tracks.Count == 0) throw new BridgeException("Timeline's camera tracks are unavailable");
            History.Push(snap, "Camera move: " + preset);

            int removed = 0;
            foreach (var ip in tracks)
                foreach (var k in ip.keyframes.Keys.Where(k => k > t0 + 1e-4f && k < t1 - 1e-4f).ToList())
                {
                    ip.keyframes.Remove(k);
                    removed++;
                }

            var linear = AnimationCurve.Linear(0f, 0f, 1f, 1f);
            try
            {
                for (int i = 0; i <= steps; i++)
                {
                    float x = (float)i / steps;
                    // one segment: Timeline's own ease-in-out curve; several: eased positions on linear segments
                    var st = at(steps == 1 ? x : ease(x));
                    Apply(cc, st);
                    float t = t0 + dur * x;
                    foreach (var ip in tracks)
                    {
                        AddOrUpdateKey(ip, t);
                        if (FindKey(ip, t, out var exact))
                            ip.keyframes[exact].curve = steps == 1 && smooth && i == 0 ? AnimationCurve.EaseInOut(0f, 0f, 1f, 1f) : new AnimationCurve(linear.keys);
                    }
                }
            }
            finally
            {
                Apply(cc, s0); // the camera ends where it started; the playhead shows the keyed result after AfterEdit
            }
            RefreshView();
            AfterEdit();
            return new Dictionary<string, object> { { "t0", t0 }, { "t1", t1 }, { "keys", steps + 1 }, { "replaced", removed } };
        }

        /// <summary>
        /// Shot cuts: for each (time, put the shot's camera in place), key the camera there and make the key before
        /// it a hold, so the view jumps into the shot. One undo step; the camera is back where it was afterwards.
        /// </summary>
        public static object KeyShotCuts(List<KeyValuePair<float, Action>> cuts) =>
            KeyShotCuts(cuts.Select(c => new CutKey { T = c.Key, Apply = c.Value }).ToList());

        /// <summary>Key Studio's camera at each time (Apply puts it there): a hard cut, or with Glide an eased move from the key before.</summary>
        public static object KeyShotCuts(List<CutKey> cuts)
        {
            var cc = Singleton<Studio.Studio>.Instance.cameraCtrl;
            var tracks = CameraTracksForEdit(out var snap);
            if (tracks.Count == 0) throw new BridgeException("Timeline's camera tracks are unavailable");
            History.Push(snap, "Build camera cuts");
            var before = cc.Export();
            float fov = cc.fieldOfView;
            var hold = new AnimationCurve(new UnityEngine.Keyframe(0f, 0f, 0f, 0f), new UnityEngine.Keyframe(1f, 1f, float.PositiveInfinity, 0f));
            try
            {
                foreach (var cut in cuts.OrderBy(c => c.T))
                {
                    float t = Mathf.Clamp(cut.T, 0f, TL.duration);
                    cut.Apply();
                    foreach (var ip in tracks)
                    {
                        AddOrUpdateKey(ip, t);
                        TLKeyframe prev = null;
                        foreach (var kv in ip.keyframes) { if (kv.Key < t - 1e-4f) prev = kv.Value; else break; }
                        if (prev != null)
                            prev.curve = cut.Glide
                                ? (cut.Smooth ? AnimationCurve.EaseInOut(0f, 0f, 1f, 1f) : AnimationCurve.Linear(0f, 0f, 1f, 1f))
                                : new AnimationCurve(hold.keys);
                    }
                }
            }
            finally
            {
                cc.Import(before);
                cc.fieldOfView = fov;
            }
            RefreshView();
            AfterEdit();
            return cuts.Count;
        }

        private static void Apply(Studio.CameraControl cc, CamState s)
        {
            var d = cc.Export();
            d.pos = s.Pos;
            d.rotate = s.Rot;
            d.distance = s.Dist;
            cc.Import(d);
            cc.fieldOfView = s.Fov;
        }
    }
}
