using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using ExtensibleSaveFormat;
using KKAPI.Studio.SaveLoad;
using KKAPI.Utilities;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Shot sequencer: named time ranges of the timeline, each with a camera it remembers (and a thumbnail) and
    /// notes. "Build camera cuts" keys a hard cut to every shot's camera at its start (one undo step); the
    /// render queue renders shots one after another through VideoExport. Shots are saved with the scene.
    /// A shot is {id, name, start, end, notes, cam?: {pos, rot, dist, fov}, thumb?}.
    /// </summary>
    internal sealed class ShotApi : MonoBehaviour
    {
        private static ShotApi _i;
        private static List<Dictionary<string, object>> _shots = new List<Dictionary<string, object>>();
        internal static List<Dictionary<string, object>> All => _shots;
        private static Coroutine _queue;
        private static readonly Dictionary<string, object> QueueState = new Dictionary<string, object> { { "running", false } };

        private void Awake() => _i = this;

        public static void Register(CommandRouter r)
        {
            r.Add("shots.get", a => _shots);
            r.Add("shots.set", a => { SetAll(a.GetList("shots")); return _shots; });
            r.Add("shots.captureCamera", CaptureCamera);
            r.Add("shots.view", a => { ApplyCamera(Find(a.GetString("id"))); return true; });
            r.Add("shots.buildCuts", a => BuildCuts());
            r.Add("render.queue", StartQueue);
            r.Add("render.queueStatus", a => QueueState);
            r.Add("render.queueCancel", a => { CancelQueue(); return QueueState; });
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Shots won't be saved with scenes (KKAPI): " + e.Message); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<ShotSceneData>(StudioBridgePlugin.GUID + ".shots");

        public static void Clear() => _shots = new List<Dictionary<string, object>>();

        private static void SetAll(List<object> list)
        {
            float dur = TimelineApi.Duration();
            var next = new List<Dictionary<string, object>>();
            foreach (var o in list.OfType<Dictionary<string, object>>())
            {
                float s = Mathf.Clamp(o.GetFloat("start"), 0f, dur), e = Mathf.Clamp(o.GetFloat("end"), 0f, dur);
                if (e - s < 0.05f) throw new BridgeException("Shot “" + o.GetString("name") + "” needs an end after its start");
                var shot = new Dictionary<string, object>
                {
                    { "id", o.GetString("id") ?? Guid.NewGuid().ToString("N").Substring(0, 8) },
                    { "name", (o.GetString("name") ?? "Shot").Trim() }, { "start", (double)s }, { "end", (double)e },
                    { "notes", o.GetString("notes") ?? "" },
                };
                // camera and thumbnail are kept from the existing shot unless given
                var old = _shots.FirstOrDefault(x => x.GetString("id") == shot.GetString("id"));
                var cam = o.GetObject("cam") ?? old?.GetObject("cam");
                if (cam != null) shot["cam"] = cam;
                var thumb = o.GetString("thumb") ?? old?.GetString("thumb");
                if (thumb != null) shot["thumb"] = thumb;
                next.Add(shot);
            }
            _shots = next.OrderBy(x => x.GetDouble("start")).ToList();
        }

        private static Dictionary<string, object> Find(string id) =>
            _shots.FirstOrDefault(x => x.GetString("id") == id) ?? throw new BridgeException("Shot not found");

        private static List<object> V(Vector3 v) => new List<object> { (double)v.x, (double)v.y, (double)v.z };
        private static Vector3 V(List<object> l) => l.Count >= 3 ? new Vector3(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2])) : Vector3.zero;

        /// <summary>args: {id} — the shot remembers Studio's current camera (and a thumbnail of the view).</summary>
        private static object CaptureCamera(Dictionary<string, object> a)
        {
            var shot = Find(a.GetString("id"));
            var cc = Singleton<Studio.Studio>.Instance.cameraCtrl;
            var d = cc.Export();
            shot["cam"] = new Dictionary<string, object> { { "pos", V(d.pos) }, { "rot", V(d.rotate) }, { "dist", V(d.distance) }, { "fov", (double)cc.fieldOfView } };
            var thumb = CameraApi.Snapshot(192);
            if (thumb != null) shot["thumb"] = thumb;
            return _shots;
        }

        internal static bool ApplyCamera(Dictionary<string, object> shot)
        {
            var cam = shot.GetObject("cam");
            if (cam == null) return false;
            var cc = Singleton<Studio.Studio>.Instance.cameraCtrl;
            var d = cc.Export();
            d.pos = V(cam.GetList("pos"));
            d.rotate = V(cam.GetList("rot"));
            d.distance = V(cam.GetList("dist"));
            cc.Import(d);
            cc.fieldOfView = cam.GetFloat("fov", cc.fieldOfView);
            return true;
        }

        /// <summary>Key a hard cut to each shot's camera at its start (shots without a camera are skipped).</summary>
        private static object BuildCuts()
        {
            if (!TimelineApi.Available) throw new BridgeException("Camera cuts need Timeline");
            var withCam = _shots.Where(s => s.GetObject("cam") != null).ToList();
            if (withCam.Count == 0) throw new BridgeException("Give the shots a camera first (frame the view, then Set camera)");
            return BuildCutsImpl(withCam);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object BuildCutsImpl(List<Dictionary<string, object>> shots) =>
            TimelineImpl.KeyShotCuts(shots.Select(s => new KeyValuePair<float, Action>(s.GetFloat("start"), () => ApplyCamera(s))).ToList());

        // ---------------- render queue ----------------

        /// <summary>args: {ids:[shot ids]} — render each shot (its time range) as its own video, in order.</summary>
        private static object StartQueue(Dictionary<string, object> a)
        {
            if ((bool)QueueState["running"]) throw new BridgeException("The render queue is already running");
            var ids = a.GetList("ids").Select(o => o as string).ToList();
            var shots = (ids.Count > 0 ? ids.Select(Find) : _shots).ToList();
            if (shots.Count == 0) throw new BridgeException("No shots to render");
            if (!TimelineApi.Available) throw new BridgeException("The render queue needs Timeline");
            if (TimelineApi.Pending() > 0) throw new BridgeException("Key or reset your unkeyed changes first — rendering plays the timeline");
            // VideoExport must be usable before we start moving the playhead around
            if (RenderApi.Probe() != null) throw new BridgeException("Render needs VideoExport");
            _queue = _i.StartCoroutine(_i.RunQueue(shots));
            return QueueState;
        }

        private static void CancelQueue()
        {
            if (!(bool)QueueState["running"]) return;
            QueueState["cancel"] = true;
            RenderApi.Stop();
        }

        private IEnumerator RunQueue(List<Dictionary<string, object>> shots)
        {
            QueueState["running"] = true;
            QueueState["cancel"] = false;
            QueueState["total"] = shots.Count;
            QueueState["done"] = 0;
            QueueState["error"] = null;
            try
            {
                for (int i = 0; i < shots.Count; i++)
                {
                    if ((bool)QueueState["cancel"]) break;
                    var s = shots[i];
                    QueueState["index"] = i;
                    QueueState["shot"] = s.GetString("name");
                    float start = s.GetFloat("start"), end = s.GetFloat("end");
                    TimelineApi.PauseAt(start);
                    yield return null;
                    yield return new WaitForEndOfFrame();
                    string err = RenderApi.StartSeconds(end - start);
                    if (err != null) { QueueState["error"] = err; break; }
                    TimelineApi.Play();
                    // VideoExport takes over the frame clock while recording; wait for recording and encoding
                    yield return null;
                    while (RenderApi.Busy()) yield return null;
                    TimelineApi.PauseAt(start);
                    QueueState["done"] = i + 1;
                }
            }
            finally
            {
                QueueState["running"] = false;
                _queue = null;
                EventPump.RequestRebase();
                StudioBridgePlugin.Instance?.Broadcast("render.queue", QueueState);
            }
        }

        // ---------------- saved with the scene ----------------

        private sealed class ShotSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                SetExtendedData(_shots.Count == 0 ? null : new PluginData { version = 1, data = new Dictionary<string, object> { { "shots", Json.Serialize(_shots) } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation == SceneOperationKind.Import) return;
                Clear();
                var d = GetExtendedData();
                if (d?.data == null || !d.data.TryGetValue("shots", out var j) || !(j is string json)) return;
                try { _shots = (Json.Parse(json) as List<object> ?? new List<object>()).OfType<Dictionary<string, object>>().ToList(); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene shots not loaded: " + e.Message); }
            }
        }
    }
}
