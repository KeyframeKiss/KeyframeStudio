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
    /// A shot is {id, name, start, end, notes, status (idea|blocked|framed|final), camMode (still|keys), aspect?
    /// (its frame guide; 0 = leave the guides alone), cam?: {pos, rot, dist, fov}, thumb?}.
    ///
    /// Live cuts: while on, Studio's camera switches to each still shot's camera as the playhead enters it (every
    /// frame while playing), so the edit is seen without keying anything. Shots set to "keys" leave the camera to
    /// its Timeline keys. Every change to the shot list is one undo step and tells the app ("shots.changed").
    /// </summary>
    internal sealed class ShotApi : MonoBehaviour
    {
        private static ShotApi _i;
        private static List<Dictionary<string, object>> _shots = new List<Dictionary<string, object>>();
        private static bool _liveCuts;
        private static string _liveId; // the shot live cuts last switched to
        private static readonly string[] Statuses = { "idea", "blocked", "framed", "final" };
        internal static List<Dictionary<string, object>> All => _shots;
        private static Coroutine _queue;
        private static readonly Dictionary<string, object> QueueState = new Dictionary<string, object> { { "running", false } };

        private void Awake() => _i = this;

        public static void Register(CommandRouter r)
        {
            r.Add("shots.get", a => _shots);
            r.Add("shots.state", a => State());
            r.Add("shots.set", a =>
            {
                var before = Copy(_shots);
                SetAll(a.GetList("shots"));
                Changed(before, a.GetString("label") ?? "Edit shots");
                return _shots;
            });
            r.Add("shots.captureCamera", a =>
            {
                var before = Copy(_shots);
                var result = CaptureCamera(a);
                Find(a.GetString("id"))["camMode"] = "still";
                Changed(before, "Set shot camera");
                return result;
            });
            r.Add("shots.fromView", FromView);
            r.Add("shots.thumbs", RefreshThumbs);
            r.Add("shots.view", a =>
            {
                var sh = Find(a.GetString("id"));
                ApplyCamera(sh);
                ApplyAspect(sh);
                _liveId = sh.GetString("id");
                return true;
            });
            r.Add("shots.setLiveCuts", a =>
            {
                _liveCuts = a.GetBool("on");
                _liveId = null; // the next frame switches to the shot under the playhead
                Broadcast();
                return State();
            });
            r.Add("shots.buildCuts", a => BuildCuts());
            r.Add("render.queue", StartQueue);
            r.Add("render.queueStatus", a => QueueState);
            r.Add("render.queueCancel", a => { CancelQueue(); return QueueState; });
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Shots won't be saved with scenes (KKAPI): " + e.Message); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<ShotSceneData>(StudioBridgePlugin.GUID + ".shots");

        public static void Clear()
        {
            _shots = new List<Dictionary<string, object>>();
            _liveCuts = false;
            _liveId = null;
        }

        private static Dictionary<string, object> State() => new Dictionary<string, object> { { "shots", _shots }, { "liveCuts", _liveCuts } };

        private static void Broadcast() => StudioBridgePlugin.Instance?.Broadcast("shots.changed", null);

        /// <summary>A deep copy (through JSON), for undo.</summary>
        private static List<Dictionary<string, object>> Copy(List<Dictionary<string, object>> l) =>
            (Json.Parse(Json.Serialize(l)) as List<object> ?? new List<object>()).OfType<Dictionary<string, object>>().ToList();

        /// <summary>After a change: one undo step back to `before`, and the app hears about it.</summary>
        private static void Changed(List<Dictionary<string, object>> before, string label)
        {
            if (Json.Serialize(before) != Json.Serialize(_shots)) UndoStack.Push(new ShotsUndo(before, label));
            Broadcast();
        }

        private sealed class ShotsUndo : IUndoEntry
        {
            private readonly List<Dictionary<string, object>> _list;
            public ShotsUndo(List<Dictionary<string, object>> list, string label) { _list = list; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var inverse = new ShotsUndo(Copy(_shots), Label);
                _shots = Copy(_list);
                _liveId = null;
                Broadcast();
                return inverse;
            }
        }

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
                    { "status", Array.IndexOf(Statuses, o.GetString("status")) >= 0 ? o.GetString("status") : "idea" },
                    { "camMode", o.GetString("camMode") == "keys" ? "keys" : "still" },
                };
                if (o.Has("aspect") && o.GetFloat("aspect") > 0f) shot["aspect"] = (double)Mathf.Clamp(o.GetFloat("aspect"), 0.2f, 5f);
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
            var thumb = CameraApi.Snapshot(320);
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

        private static Dictionary<string, object> CamOf(Studio.CameraControl.CameraData d, float fov) =>
            new Dictionary<string, object> { { "pos", V(d.pos) }, { "rot", V(d.rotate) }, { "dist", V(d.distance) }, { "fov", (double)fov } };

        /// <summary>args: {id, slot: 0-9} — the shot takes the camera of one of Studio's saved views (and its picture).</summary>
        private static object FromView(Dictionary<string, object> a)
        {
            var shot = Find(a.GetString("id"));
            int i = a.GetInt("slot", -1);
            var s = Singleton<Studio.Studio>.Instance;
            if (i < 0 || i >= s.sceneInfo.cameraData.Length) throw new BridgeException("Saved views are 1-10");
            var d = s.sceneInfo.cameraData[i];
            if (!CameraApi.Used(d, s.cameraCtrl.ExportResetData())) throw new BridgeException("View " + (i + 1) + " is empty — save a view there first");
            var before = Copy(_shots);
            shot["cam"] = CamOf(d, d.parse);
            shot["camMode"] = "still";
            var thumb = ThumbThrough(shot);
            if (thumb != null) shot["thumb"] = thumb;
            Changed(before, "Shot camera from view " + (i + 1));
            return _shots;
        }

        /// <summary>
        /// Put Unity's camera where the shot's camera looks from, right now (Studio's camera control would only move
        /// it at the end of the frame): its pivot, turned by its angles, out at its distance.
        /// </summary>
        private static bool PlaceMainCamera(Dictionary<string, object> shot)
        {
            var cam = shot.GetObject("cam");
            var main = Camera.main;
            if (cam == null || main == null) return false;
            var rot = Quaternion.Euler(V(cam.GetList("rot")));
            main.transform.position = V(cam.GetList("pos")) + rot * V(cam.GetList("dist"));
            main.transform.rotation = rot;
            main.fieldOfView = cam.GetFloat("fov", main.fieldOfView);
            return true;
        }

        /// <summary>A picture through the shot's camera (Unity's camera is put back straight after).</summary>
        private static string ThumbThrough(Dictionary<string, object> shot)
        {
            var main = Camera.main;
            if (main == null) return null;
            var pos = main.transform.position;
            var rot = main.transform.rotation;
            float fov = main.fieldOfView;
            try { return PlaceMainCamera(shot) ? CameraApi.Snapshot(320) : null; }
            finally
            {
                main.transform.position = pos;
                main.transform.rotation = rot;
                main.fieldOfView = fov;
            }
        }

        /// <summary>args: {ids?} — new pictures for still shots, through their own cameras.</summary>
        private static object RefreshThumbs(Dictionary<string, object> a)
        {
            var ids = a.GetList("ids").Select(o => o as string).Where(x => x != null).ToList();
            int n = 0;
            foreach (var shot in _shots)
            {
                if (ids.Count > 0 && !ids.Contains(shot.GetString("id"))) continue;
                if (shot.GetString("camMode") == "keys" || shot.GetObject("cam") == null) continue;
                var t = ThumbThrough(shot);
                if (t != null) { shot["thumb"] = t; n++; }
            }
            if (n > 0) Broadcast();
            return n;
        }

        /// <summary>The shot's frame guide, if it has one.</summary>
        private static void ApplyAspect(Dictionary<string, object> shot)
        {
            if (shot.Has("aspect") && shot.GetFloat("aspect") > 0f) CameraTools.SetAspect(shot.GetFloat("aspect"));
        }

        private static Dictionary<string, object> ShotAt(float t)
        {
            Dictionary<string, object> hit = null;
            foreach (var s in _shots)
                if (t >= s.GetFloat("start") - 1e-4f && t < s.GetFloat("end") - 1e-4f) hit = s; // a later shot wins an overlap
            if (hit == null && _shots.Count > 0)
            {
                var last = _shots[_shots.Count - 1];
                if (Mathf.Abs(t - last.GetFloat("end")) < 1e-3f) hit = last; // the very end belongs to the last shot
            }
            return hit;
        }

        /// <summary>
        /// Live cuts: after Timeline has posed the scene for this frame, put the camera of the shot under the
        /// playhead in place — every frame while playing (so camera keys left in a still shot don't win), and when
        /// the playhead moves into another shot while paused (scrubbing inside one leaves your framing alone).
        /// </summary>
        private void LateUpdate()
        {
            if (!_liveCuts || _shots.Count == 0 || !TimelineApi.Available) return;
            if (ViewportTools.Busy) return; // sampling / ghost baking jump around on purpose
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null || studio.ociCamera != null) return; // looking through a scene camera
            try
            {
                var shot = ShotAt(TimelineApi.PlaybackTime());
                string id = shot?.GetString("id");
                bool entered = id != _liveId;
                _liveId = id;
                if (shot == null) return;
                if (entered) ApplyAspect(shot);
                if (shot.GetString("camMode") == "keys") return;
                if (entered || TimelineApi.Playing())
                {
                    ApplyCamera(shot);
                    PlaceMainCamera(shot); // this very frame, not the next (a render records it)
                }
            }
            catch (Exception e)
            {
                _liveCuts = false;
                StudioBridgePlugin.Logger.LogWarning("Live cuts stopped: " + e.Message);
                Broadcast();
            }
        }

        /// <summary>Key a hard cut to each shot's camera at its start (shots without a camera are skipped).</summary>
        private static object BuildCuts()
        {
            if (!TimelineApi.Available) throw new BridgeException("Camera cuts need Timeline");
            var withCam = _shots.Where(s => s.GetObject("cam") != null && s.GetString("camMode") != "keys").ToList();
            if (withCam.Count == 0) throw new BridgeException("Give the shots a camera first (frame the view, then Set camera)");
            return BuildCutsImpl(withCam);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object BuildCutsImpl(List<Dictionary<string, object>> shots) =>
            TimelineImpl.KeyShotCuts(shots.Select(s => new KeyValuePair<float, Action>(s.GetFloat("start"), () => ApplyCamera(s))).ToList());

        // ---------------- render queue ----------------

        /// <summary>args: {ids:[shot ids], versions?} — render each shot (its time range) as its own video, in order, once per version.</summary>
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
            _queue = _i.StartCoroutine(_i.RunQueue(Jobs(shots, Versions(a), true), RenderApi.Warmups()));
            return QueueState;
        }

        /// <summary>Render `seconds` of the timeline from `start` as one video per version, playing it while recording
        /// (VideoExport's own modes only record whatever is on screen, so the animation wouldn't move).</summary>
        public static object StartRange(float start, float seconds, int warmups = 0, List<Dictionary<string, object>> versions = null)
        {
            if ((bool)QueueState["running"]) throw new BridgeException("A render is already running");
            if (!TimelineApi.Available) throw new BridgeException("Rendering the animation needs Timeline");
            if (TimelineApi.Pending() > 0) throw new BridgeException("Key or reset your unkeyed changes first — rendering plays the timeline");
            if (RenderApi.Probe() != null) throw new BridgeException("Render needs VideoExport");
            if (seconds <= 0.01f) throw new BridgeException("Nothing to render: the playhead is at the end of the timeline");
            var range = new Dictionary<string, object> { { "name", "Timeline" }, { "start", (double)start }, { "end", (double)(start + seconds) } };
            _queue = _i.StartCoroutine(_i.RunQueue(Jobs(new List<Dictionary<string, object>> { range }, versions, false), warmups));
            return QueueState;
        }

        /// <summary>The "versions" arg: [{label, width, height (0 = no size), framing}] — several sizes/framings from one render.</summary>
        public static List<Dictionary<string, object>> Versions(Dictionary<string, object> a) =>
            a.ContainsKey("versions") ? a.GetList("versions").OfType<Dictionary<string, object>>().ToList() : null;

        /// <summary>Every range × every version, as the jobs the queue runs; the file gets the shot's and/or version's name.</summary>
        private static List<Dictionary<string, object>> Jobs(List<Dictionary<string, object>> ranges, List<Dictionary<string, object>> versions, bool shotsByName)
        {
            var jobs = new List<Dictionary<string, object>>();
            bool several = versions != null && versions.Count > 1;
            foreach (var r in ranges)
                foreach (var v in versions != null && versions.Count > 0 ? versions : new List<Dictionary<string, object>> { null })
                {
                    var j = new Dictionary<string, object>(r) { { "version", v } };
                    var parts = new List<string>();
                    if (shotsByName) parts.Add(r.GetString("name"));
                    if (several && v != null) parts.Add(v.GetString("label") ?? "");
                    j["suffix"] = string.Join(" - ", parts.Where(p => !string.IsNullOrEmpty(p)).ToArray());
                    j["label"] = string.Join(" · ", new[] { shotsByName ? r.GetString("name") : null, v?.GetString("label") }.Where(p => !string.IsNullOrEmpty(p)).ToArray());
                    jobs.Add(j);
                }
            return jobs;
        }

        private static void CancelQueue()
        {
            if (!(bool)QueueState["running"]) return;
            QueueState["cancel"] = true;
            RenderApi.Stop();
        }

        /// <summary>Record each job as its own video: its size and framing, warm-up plays, record while the timeline plays,
        /// then cut to shape if needed, mix the scene's audio in, and name the file. The audio stays silent the whole time
        /// (VideoExport slows the game clock while it records, so playing along would stutter and repeat).</summary>
        private IEnumerator RunQueue(List<Dictionary<string, object>> jobs, int warmups)
        {
            QueueState["running"] = true;
            QueueState["cancel"] = false;
            QueueState["total"] = jobs.Count;
            QueueState["done"] = 0;
            QueueState["error"] = null;
            QueueState["phase"] = null;
            QueueState["audioError"] = null;
            QueueState["files"] = new List<object>();
            AudioTrack.Silenced = true;
            var sizeSettings = RenderApi.SaveSizeSettings(); // each version sets its own size; the user's comes back after
            var limit = RenderApi.SaveLimit(); // each job is recorded in Seconds mode; the user's own mode comes back after
            var preview = RenderFraming.Active; // a framing preview pauses during the render
            RenderApi.SizeState size = null;
            try
            {
                for (int i = 0; i < jobs.Count; i++)
                {
                    if ((bool)QueueState["cancel"]) break;
                    var s = jobs[i];
                    var version = s["version"] as Dictionary<string, object>;
                    QueueState["index"] = i;
                    QueueState["shot"] = s.GetString("label") is string l && l.Length > 0 ? l : s.GetString("name");
                    float start = s.GetFloat("start"), end = s.GetFloat("end");
                    // this version's picture size (rendered at that size, never stretched) and camera framing
                    if (version != null) RenderApi.UseSize(version);
                    size = RenderApi.PrepareSize();
                    RenderFraming.Active = RenderFraming.From(version?.ContainsKey("framing") == true ? version["framing"] as Dictionary<string, object> : null);
                    // warm-up: play the range first (in real time) so hair and clothes physics have settled
                    for (int w = 0; w < warmups && !(bool)QueueState["cancel"]; w++)
                    {
                        QueueState["phase"] = "Warm-up " + (w + 1) + " of " + warmups;
                        TimelineApi.PauseAt(start);
                        yield return null;
                        TimelineApi.Play();
                        float t0 = Time.realtimeSinceStartup;
                        while (Time.realtimeSinceStartup - t0 < end - start && !(bool)QueueState["cancel"]) yield return null;
                    }
                    QueueState["phase"] = null;
                    if ((bool)QueueState["cancel"]) break;
                    TimelineApi.PauseAt(start);
                    yield return null;
                    yield return new WaitForEndOfFrame();
                    var startedAt = DateTime.Now;
                    string err = RenderApi.StartSeconds(end - start);
                    if (err != null) { QueueState["error"] = err; break; }
                    TimelineApi.Play();
                    // VideoExport takes over the frame clock while recording; wait for recording and encoding
                    yield return null;
                    while (RenderApi.Busy()) yield return null;
                    TimelineApi.PauseAt(start);
                    RenderFraming.Active = null;
                    // the finished video: cut to shape if it couldn't be rendered at the size, the scene's audio mixed in
                    // (ffmpeg on a worker thread), and the shot's / version's name on the file
                    var clips = RenderApi.WithAudio ? AudioTrack.ForRender(start, end) : null;
                    bool crop = size != null && size.CropW > 0;
                    string suffix = s.GetString("suffix") ?? "";
                    var video = !(bool)QueueState["cancel"] ? RenderApi.NewestVideo(startedAt) : null;
                    if (video != null && ((clips != null && clips.Count > 0) || crop))
                    {
                        QueueState["phase"] = crop ? "Cutting to size" + (clips != null && clips.Count > 0 ? " and adding the audio" : "") : "Adding the audio";
                        string audioErr = null;
                        bool mixed = false;
                        var worker = new System.Threading.Thread(() =>
                        {
                            try { audioErr = RenderApi.MixAudio(video, clips, start, end - start, crop ? size.CropW : 0, crop ? size.CropH : 0); }
                            catch (Exception e) { audioErr = e.Message; }
                            mixed = true;
                        }) { IsBackground = true };
                        worker.Start();
                        while (!mixed) yield return null;
                        QueueState["phase"] = null;
                        if (audioErr != null)
                        {
                            QueueState["audioError"] = audioErr;
                            StudioBridgePlugin.Logger.LogWarning("Render: the audio wasn't added to " + video + ": " + audioErr);
                        }
                    }
                    if (video != null)
                    {
                        var named = suffix.Length > 0 ? RenderApi.NameVideo(video, suffix) : video;
                        ((List<object>)QueueState["files"]).Add(named);
                    }
                    RenderApi.RestoreSize(size);
                    size = null;
                    QueueState["done"] = i + 1;
                }
            }
            finally
            {
                AudioTrack.Silenced = false;
                RenderFraming.Active = preview;
                RenderApi.RestoreSize(size);
                RenderApi.RestoreSizeSettings(sizeSettings);
                RenderApi.RestoreLimit(limit);
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
                SetExtendedData(_shots.Count == 0 ? null : new PluginData { version = 1, data = new Dictionary<string, object> { { "shots", Json.Serialize(_shots) }, { "liveCuts", _liveCuts } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation == SceneOperationKind.Import) return;
                Clear();
                var d = GetExtendedData();
                if (d?.data == null || !d.data.TryGetValue("shots", out var j) || !(j is string json)) return;
                try
                {
                    _shots = (Json.Parse(json) as List<object> ?? new List<object>()).OfType<Dictionary<string, object>>().ToList();
                    _liveCuts = d.data.TryGetValue("liveCuts", out var lc) && lc is bool on && on;
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene shots not loaded: " + e.Message); }
                Broadcast();
            }
        }
    }
}
