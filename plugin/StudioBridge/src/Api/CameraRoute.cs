using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using Interpolable = Timeline.Interpolable;

namespace StudioEX.Bridge.Api
{
    /// <summary>One camera key: where Studio's camera turns around (pivot), its turn and distance, and where it stands.</summary>
    internal struct CamKey
    {
        public float T;
        public Vector3 Pivot;
        public Quaternion Rot;
        public float Dist; // Studio's distance.z (negative: the camera stands behind the pivot)
        public Vector3 Eye => Pivot + Rot * new Vector3(0f, 0f, Dist);
    }

    /// <summary>
    /// The camera's route for the viewport: where the camera itself stands over time (not just the point it turns
    /// around, which an orbit never moves), from Timeline's camera keys without seeking. Dragging a key moves the
    /// camera there, still aimed at its pivot; one undo step per drag.
    /// </summary>
    internal static partial class TimelineImpl
    {
        private static void CameraTriple(out Interpolable pos, out Interpolable rot, out Interpolable zoom)
        {
            var tracks = CameraTracks(false);
            pos = tracks.FirstOrDefault(t => t.id == "cameraOPos" && t.enabled);
            rot = tracks.FirstOrDefault(t => t.id == "cameraORot" && t.enabled);
            zoom = tracks.FirstOrDefault(t => t.id == "cameraOZoom" && t.enabled);
        }

        /// <summary>Times where the pivot, the turn and the distance all have a key: those move the camera as a whole.</summary>
        public static List<CamKey> CameraKeys()
        {
            var list = new List<CamKey>();
            if (!IsReady) return list;
            CameraTriple(out var pos, out var rot, out var zoom);
            if (pos == null || rot == null || zoom == null) return list;
            foreach (var kv in pos.keyframes)
            {
                if (!FindKey(rot, kv.Key, out float tr) || !FindKey(zoom, kv.Key, out float tz)) continue;
                if (!(kv.Value.value is Vector3 p) || !(rot.keyframes[tr].value is Quaternion q) || !(zoom.keyframes[tz].value is float d)) continue;
                list.Add(new CamKey { T = kv.Key, Pivot = p, Rot = q, Dist = d });
            }
            return list;
        }

        /// <summary>The camera's position at time t, the way Timeline interpolates its tracks (left key's curve).</summary>
        private static bool CameraAt(Interpolable pos, Interpolable rot, Interpolable zoom, float t, out Vector3 eye)
        {
            eye = default;
            if (!Eval(pos, t, out var p) || !Eval(rot, t, out var r) || !Eval(zoom, t, out var z)) return false;
            if (!(p is Vector3 pv) || !(r is Quaternion rq) || !(z is float zf)) return false;
            eye = pv + rq * new Vector3(0f, 0f, zf);
            return true;
        }

        private static bool Eval(Interpolable ip, float t, out object v)
        {
            v = null;
            var keys = ip.keyframes;
            if (keys.Count == 0) return false;
            float lt = 0f, rt = 0f;
            object lv = null, rv = null;
            AnimationCurve curve = null;
            bool haveLeft = false;
            foreach (var kv in keys)
            {
                if (kv.Key <= t) { lt = kv.Key; lv = kv.Value.value; curve = kv.Value.curve; haveLeft = true; continue; }
                rt = kv.Key;
                rv = kv.Value.value;
                break;
            }
            if (!haveLeft) { v = keys.First().Value.value; return true; }
            if (rv == null) { v = lv; return true; }
            float f = (t - lt) / Mathf.Max(1e-6f, rt - lt);
            f = curve != null ? curve.Evaluate(f) : f;
            if (lv is Vector3 a && rv is Vector3 b) v = Vector3.LerpUnclamped(a, b, f);
            else if (lv is Quaternion qa && rv is Quaternion qb) v = Quaternion.SlerpUnclamped(qa, qb, f);
            else if (lv is float fa && rv is float fb) v = Mathf.LerpUnclamped(fa, fb, f);
            else v = lv;
            return true;
        }

        /// <summary>Where the camera stands, sampled across its keys (about 30 a second, at most 600 points).</summary>
        public static List<Vector3> CameraRoute()
        {
            var pts = new List<Vector3>();
            if (!IsReady) return pts;
            CameraTriple(out var pos, out var rot, out var zoom);
            if (pos == null || rot == null || zoom == null) return pts;
            var times = pos.keyframes.Keys.Concat(rot.keyframes.Keys).Concat(zoom.keyframes.Keys).ToList();
            if (times.Count < 2) return pts;
            float t0 = times.Min(), t1 = times.Max();
            if (t1 - t0 < 1e-4f) return pts;
            int n = Mathf.Clamp(Mathf.CeilToInt((t1 - t0) * 30f), 8, 600);
            for (int i = 0; i <= n; i++)
                if (CameraAt(pos, rot, zoom, t0 + (t1 - t0) * i / n, out var e)) pts.Add(e);
            return pts;
        }

        /// <summary>Before a drag: the camera tracks as they are, to undo the whole drag as one step.</summary>
        public static object CameraEditBegin() => History.Capture(CameraTracks(false));

        /// <summary>Rewrites the camera key at t (pivot, turn and distance).</summary>
        public static void CameraEditSet(CamKey k)
        {
            CameraTriple(out var pos, out var rot, out var zoom);
            if (pos == null || rot == null || zoom == null) return;
            if (!FindKey(pos, k.T, out float tp) || !FindKey(rot, k.T, out float tr) || !FindKey(zoom, k.T, out float tz)) return;
            pos.keyframes[tp].value = k.Pivot;
            rot.keyframes[tr].value = k.Rot;
            zoom.keyframes[tz].value = k.Dist;
        }

        /// <summary>After a drag: one undo step (or put everything back). Studio's view stays where the user has it.</summary>
        public static void CameraEditEnd(object snap, bool keep, string label)
        {
            if (!(snap is List<TrackSnapshot> s)) return;
            var view = KeepView.Take();
            if (keep) History.Push(s, label);
            else foreach (var x in s) History.Restore(x);
            AfterEdit();
            view.Restore();
        }
    }
}
