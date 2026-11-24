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
        /// <summary>still: its own camera · keys: its Timeline camera keys · pov: through a character's eyes · follow: keeps a body part in view</summary>
        private static readonly string[] Modes = { "still", "keys", "pov", "follow" };
        /// <summary>How a shot starts: a hard cut, a glide from the previous shot's camera, a dip to black / white, a dissolve.</summary>
        private static readonly string[] TransTypes = { "cut", "glide", "dipBlack", "dipWhite", "dissolve" };
        private static float _liveT = -1f;
        // a render with the shots: their cameras and transitions, live cuts on or not
        private static bool _rendering, _renderShots;
        /// <summary>A render (one range or the shot queue) is under way.</summary>
        internal static bool Rendering => (bool)QueueState["running"];
        /// <summary>Shots drive the camera: live cuts, or a render that uses the shots.</summary>
        // Studio's view is the user's work camera: the shots move it only while a render records, or when the user
        // asks Studio to show the edit too. Otherwise Play the edit is the monitor and renders.
        private static bool _studioEdit;
        private static bool ShotsActive => _liveCuts && (_rendering || _studioEdit);

        /// <summary>A shot left first person / follow switched on for Studio's camera: let go (the work view is free).</summary>
        private static void ReleaseShotModes()
        {
            if (_shots.Any(s => s.GetString("camMode") == "pov" || s.GetString("camMode") == "follow")) CameraTools.ShotMode(null, -1, null);
            if (TransitionFx.Live != null) { TransitionFx.Live = null; TransitionFx.Sync(Camera.main); }
        }
        private static List<object> _trace;
        private static string _traceShot;
        private static bool _traceApplied;
        /// <summary>Angles: named camera setups to reuse across shots ({id, name, cam, thumb, slot?}).</summary>
        private static List<Dictionary<string, object>> _angles = new List<Dictionary<string, object>>();
        internal static List<Dictionary<string, object>> All => _shots;
        private static Coroutine _queue;
        private static readonly Dictionary<string, object> QueueState = new Dictionary<string, object> { { "running", false } };

        private void Awake()
        {
            _i = this;
            StartCoroutine(OutgoingLoop());
        }

        /// <summary>
        /// At the end of each frame, while a dissolve shows (live, or on the monitor), render the outgoing shot once
        /// more for the next frame to blend in.
        /// </summary>
        private System.Collections.IEnumerator OutgoingLoop()
        {
            var eof = new WaitForEndOfFrame();
            while (true)
            {
                yield return eof;
                try
                {
                    if (_trace != null && _trace.Count < 4000)
                    {
                        var c = Camera.main;
                        _trace.Add(new List<object> { Time.frameCount, Math.Round(TimelineApi.PlaybackTime(), 4), TimelineApi.Playing(), _traceShot, _traceApplied, c != null ? Math.Round(c.fieldOfView, 2) : -1, TransitionFx.Live?.Type, Math.Round(Time.deltaTime, 4), TransitionFx.OutDrawnFrame == Time.frameCount });
                        _traceApplied = false;
                    }
                    if (_shots.Count == 0 || !TimelineApi.Available || ViewportTools.Busy) continue;
                    // live cuts / renders make it in LateUpdate, for the same frame; this is for the monitor alone
                    var st = TransitionFx.Live == null && PreviewStream.ProgramOn ? Compute(TimelineApi.PlaybackTime()) : null;
                    if (st?.Out == null) continue;
                    var studio = Singleton<Studio.Studio>.Instance;
                    if (studio == null || studio.ociCamera != null) continue;
                    TransitionFx.RenderOutgoing(Camera.main, st.Out);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("Dissolve picture: " + e.Message); }
            }
        }

        public static void Register(CommandRouter r)
        {
            r.Add("shots.get", a => _shots);
            r.Add("shots.state", a => State());
            r.Add("shots.set", a =>
            {
                var before = Snap();
                SetAll(a.GetList("shots"));
                Changed(before, a.GetString("label") ?? "Edit shots");
                return _shots;
            });
            r.Add("shots.captureCamera", a =>
            {
                var before = Snap();
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
                ApplyMode(sh);
                if (Mode(sh) == "still") ApplyCamera(sh);
                ApplyAspect(sh);
                _liveId = sh.GetString("id");
                return true;
            });
            r.Add("shots.fromAngle", FromAngle);
            r.Add("shots.fxDiag", a => TransitionFx.Diag());
            // a per-frame trace of live cuts (for finding timing problems in renders): {on} starts, {} returns it
            r.Add("shots.trace", a =>
            {
                var t = _trace;
                _trace = a.GetBool("on") ? new List<object>() : null;
                return t ?? new List<object>();
            });
            r.Add("angles.add", AngleAdd);
            r.Add("angles.update", AngleUpdate);
            r.Add("angles.set", AnglesSet);
            r.Add("angles.view", a => ApplyCamera(FindAngle(a.GetString("id"))));
            r.Add("angles.import", AnglesImport);
            r.Add("shots.setLiveCuts", a =>
            {
                _liveCuts = a.GetBool("on");
                _liveId = null; // the next frame switches to the shot under the playhead
                if (!ShotsActive) ReleaseShotModes();
                Broadcast();
                return State();
            });
            // whether Studio's own view follows the edit too (else only the monitor and renders do)
            r.Add("shots.setStudioEdit", a =>
            {
                _studioEdit = a.GetBool("on");
                _liveId = null;
                if (!ShotsActive) ReleaseShotModes();
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
            _angles = new List<Dictionary<string, object>>();
            _liveCuts = false;
            _liveId = null;
            TransitionFx.Reset();
        }

        private static Dictionary<string, object> State()
        {
            var keyed = _shots.Where(x => x.GetString("camMode") == "still" && Mode(x) == "keys").Select(x => (object)x.GetString("id")).ToList();
            var d = new Dictionary<string, object> { { "shots", _shots }, { "liveCuts", _liveCuts }, { "studioEdit", _studioEdit }, { "angles", _angles }, { "keyed", keyed } };
            var tr = TransitionFx.Live;
            if (tr != null) d["transition"] = new Dictionary<string, object> { { "type", tr.Type }, { "f", Math.Round(tr.F, 4) }, { "fade", Math.Round(tr.FadeA, 4) }, { "out", Math.Round(tr.OutA, 4) }, { "id", tr.Id } };
            return d;
        }

        private static void Broadcast() => StudioBridgePlugin.Instance?.Broadcast("shots.changed", null);

        /// <summary>A deep copy (through JSON), for undo.</summary>
        private static List<Dictionary<string, object>> Copy(List<Dictionary<string, object>> l) =>
            (Json.Parse(Json.Serialize(l)) as List<object> ?? new List<object>()).OfType<Dictionary<string, object>>().ToList();

        /// <summary>The shots and angles as they are, for undo.</summary>
        private sealed class Snapshot
        {
            public List<Dictionary<string, object>> Shots, Angles;
            public string Sig => Json.Serialize(Shots) + "|" + Json.Serialize(Angles);
        }
        private static Snapshot Snap() => new Snapshot { Shots = Copy(_shots), Angles = Copy(_angles) };

        /// <summary>After a change: one undo step back to `before`, and the app hears about it.</summary>
        private static void Changed(Snapshot before, string label)
        {
            if (before.Sig != Snap().Sig) UndoStack.Push(new ShotsUndo(before, label));
            Broadcast();
        }

        private sealed class ShotsUndo : IUndoEntry
        {
            private readonly Snapshot _was;
            public ShotsUndo(Snapshot was, string label) { _was = was; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var inverse = new ShotsUndo(Snap(), Label);
                var slotsBefore = _angles.Where(x => x.Has("slot")).Select(x => x.GetInt("slot")).ToList();
                var camBefore = new Dictionary<string, string>();
                foreach (var x in _angles)
                    if (x.GetString("id") is string aid) camBefore[aid] = Json.Serialize(x.GetObject("cam")) + "|" + (x.Has("slot") ? x.GetInt("slot") : -1);
                _shots = Copy(_was.Shots);
                _angles = Copy(_was.Angles);
                _liveId = null;
                // Studio's saved views follow their angles back: an angle's view gets its camera again, and a view
                // taken by an angle that's gone again (undoing Add angle) is emptied, so importing views doesn't
                // bring it back as "View N"
                try
                {
                    // only views whose angle changed (a view saved in Studio by hand since is left alone otherwise)
                    foreach (var angle in _angles)
                        if (!(angle.GetString("id") is string aid) || !camBefore.TryGetValue(aid, out var was) ||
                            was != Json.Serialize(angle.GetObject("cam")) + "|" + (angle.Has("slot") ? angle.GetInt("slot") : -1))
                            SyncSlot(angle);
                    var s = Singleton<Studio.Studio>.Instance;
                    var reset = s.cameraCtrl.ExportResetData();
                    foreach (int i in slotsBefore)
                        if (i >= 0 && i < s.sceneInfo.cameraData.Length && !_angles.Any(x => x.Has("slot") && x.GetInt("slot") == i))
                        {
                            s.sceneInfo.cameraData[i].Copy(reset);
                            CameraApi.ClearSlotThumb(i);
                        }
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Shots undo: saved views: " + e.Message); }
                Broadcast();
                return inverse;
            }
        }

        private static void SetAll(List<object> list)
        {
            // times are kept as they are, even past the end of the timeline: shortening it and lengthening it again
            // loses nothing (the app shows those shots past the end and offers to trim them or fit the timeline)
            var next = new List<Dictionary<string, object>>();
            foreach (var o in list.OfType<Dictionary<string, object>>())
            {
                float s = Mathf.Max(0f, o.GetFloat("start")), e = Mathf.Max(0f, o.GetFloat("end"));
                if (e - s < 0.05f) throw new BridgeException("Shot “" + o.GetString("name") + "” needs an end after its start");
                var shot = new Dictionary<string, object>
                {
                    { "id", o.GetString("id") ?? Guid.NewGuid().ToString("N").Substring(0, 8) },
                    { "name", (o.GetString("name") ?? "Shot").Trim() }, { "start", (double)s }, { "end", (double)e },
                    { "notes", o.GetString("notes") ?? "" },
                    { "status", Array.IndexOf(Statuses, o.GetString("status")) >= 0 ? o.GetString("status") : "idea" },
                    { "camMode", Array.IndexOf(Modes, o.GetString("camMode")) >= 0 ? o.GetString("camMode") : "still" },
                };
                if (o.Has("who")) shot["who"] = o.GetInt("who"); // the character a first-person / follow shot is about
                if (!string.IsNullOrEmpty(o.GetString("bone"))) shot["bone"] = o.GetString("bone");
                if (!string.IsNullOrEmpty(o.GetString("angle"))) shot["angle"] = o.GetString("angle");
                // how it starts: {type, dur (s), ease: smooth|linear}; a plain cut needs nothing stored
                var tr = o.GetObject("trans");
                if (tr != null && Array.IndexOf(TransTypes, tr.GetString("type")) > 0)
                    shot["trans"] = new Dictionary<string, object>
                    {
                        { "type", tr.GetString("type") },
                        { "dur", (double)Mathf.Clamp(tr.GetFloat("dur", 0.5f), 0.05f, 5f) },
                        { "ease", tr.GetString("ease") == "linear" ? "linear" : "smooth" },
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
            var before = Snap();
            shot["cam"] = CamOf(d, d.parse);
            shot["camMode"] = "still";
            var thumb = ThumbThrough(shot);
            if (thumb != null) shot["thumb"] = thumb;
            Changed(before, "Shot camera from view " + (i + 1));
            return _shots;
        }

        // ---------------- angles ----------------

        private static Dictionary<string, object> FindAngle(string id) =>
            _angles.FirstOrDefault(x => x.GetString("id") == id) ?? throw new BridgeException("Angle not found");

        private static Dictionary<string, object> CamNow()
        {
            var cc = Singleton<Studio.Studio>.Instance.cameraCtrl;
            return CamOf(cc.Export(), cc.fieldOfView);
        }

        /// <summary>A saved view in Studio nobody (no angle) uses yet, or -1.</summary>
        private static int FreeSlot()
        {
            var s = Singleton<Studio.Studio>.Instance;
            var reset = s.cameraCtrl.ExportResetData();
            for (int i = 0; i < s.sceneInfo.cameraData.Length; i++)
                if (!CameraApi.Used(s.sceneInfo.cameraData[i], reset) && !_angles.Any(x => x.Has("slot") && x.GetInt("slot") == i)) return i;
            return -1;
        }

        /// <summary>Keep the angle's saved view in Studio the same as the angle (Studio's own view keys keep working).</summary>
        private static void SyncSlot(Dictionary<string, object> angle)
        {
            if (!angle.Has("slot")) return;
            int i = angle.GetInt("slot");
            var s = Singleton<Studio.Studio>.Instance;
            if (i < 0 || i >= s.sceneInfo.cameraData.Length) return;
            var cc = s.cameraCtrl;
            var keep = cc.Export();
            float fov = cc.fieldOfView;
            try
            {
                ApplyCamera(angle);
                s.sceneInfo.cameraData[i].Copy(cc.Export());
            }
            finally
            {
                cc.Import(keep);
                cc.fieldOfView = fov;
            }
            if (angle.GetString("thumb") is string t) CameraApi.SetSlotThumb(i, t);
        }

        /// <summary>args: {name?} — a new angle from Studio's camera as it is now (also kept in a free saved view).</summary>
        private static object AngleAdd(Dictionary<string, object> a)
        {
            var before = Snap();
            int n = _angles.Count + 1;
            while (_angles.Any(x => x.GetString("name") == "Angle " + n)) n++;
            var angle = new Dictionary<string, object>
            {
                { "id", Guid.NewGuid().ToString("N").Substring(0, 8) },
                { "name", string.IsNullOrEmpty(a.GetString("name")) ? "Angle " + n : a.GetString("name").Trim() },
                { "cam", CamNow() },
            };
            var thumb = CameraApi.Snapshot(320);
            if (thumb != null) angle["thumb"] = thumb;
            int slot = FreeSlot();
            if (slot >= 0) { angle["slot"] = slot; SyncSlot(angle); }
            _angles.Add(angle);
            Changed(before, "Add angle");
            return State();
        }

        /// <summary>args: {id} — the angle takes Studio's camera as it is now. Shots using it are left as they are.</summary>
        private static object AngleUpdate(Dictionary<string, object> a)
        {
            var angle = FindAngle(a.GetString("id"));
            var before = Snap();
            angle["cam"] = CamNow();
            var thumb = CameraApi.Snapshot(320);
            if (thumb != null) angle["thumb"] = thumb;
            SyncSlot(angle);
            Changed(before, "Update angle");
            return State();
        }

        /// <summary>args: {angles:[{id, name}], label?} — rename, reorder or remove angles (their cameras are kept by id).</summary>
        private static object AnglesSet(Dictionary<string, object> a)
        {
            var before = Snap();
            var next = new List<Dictionary<string, object>>();
            foreach (var o in a.GetList("angles").OfType<Dictionary<string, object>>())
            {
                var old = _angles.FirstOrDefault(x => x.GetString("id") == o.GetString("id"));
                if (old == null) continue;
                var copy = new Dictionary<string, object>(old);
                if (!string.IsNullOrEmpty(o.GetString("name"))) copy["name"] = o.GetString("name").Trim();
                next.Add(copy);
            }
            _angles = next;
            Changed(before, a.GetString("label") ?? "Edit angles");
            return State();
        }

        /// <summary>Studio's saved views that no angle has yet, as angles (named "View N").</summary>
        private static object AnglesImport(Dictionary<string, object> a)
        {
            var s = Singleton<Studio.Studio>.Instance;
            var reset = s.cameraCtrl.ExportResetData();
            var before = Snap();
            int added = 0;
            for (int i = 0; i < s.sceneInfo.cameraData.Length; i++)
            {
                var d = s.sceneInfo.cameraData[i];
                if (!CameraApi.Used(d, reset) || _angles.Any(x => x.Has("slot") && x.GetInt("slot") == i)) continue;
                var angle = new Dictionary<string, object>
                {
                    { "id", Guid.NewGuid().ToString("N").Substring(0, 8) }, { "name", "View " + (i + 1) }, { "cam", CamOf(d, d.parse) }, { "slot", i },
                };
                var thumb = ThumbThrough(angle);
                if (thumb != null) angle["thumb"] = thumb;
                _angles.Add(angle);
                added++;
            }
            Changed(before, "Import saved views");
            return added;
        }

        /// <summary>args: {id, angle} — the shot uses the angle's camera (a still camera, with the angle's picture).</summary>
        private static object FromAngle(Dictionary<string, object> a)
        {
            var shot = Find(a.GetString("id"));
            var angle = FindAngle(a.GetString("angle"));
            var before = Snap();
            shot["cam"] = Json.Parse(Json.Serialize(angle.GetObject("cam")));
            shot["camMode"] = "still";
            shot["angle"] = angle.GetString("id");
            var thumb = angle.GetString("thumb") ?? ThumbThrough(shot);
            if (thumb != null) shot["thumb"] = thumb;
            Changed(before, "Shot angle: " + angle.GetString("name"));
            return _shots;
        }

        // ---------------- camera types ----------------

        /// <summary>
        /// First person / follow shots switch Studio's camera mode for the character they're about; any other shot
        /// switches it back off (only when some shot uses one — otherwise your own camera mode is left alone).
        /// </summary>
        private static void ApplyMode(Dictionary<string, object> shot)
        {
            string m = Mode(shot);
            if (m == "pov" || m == "follow")
            {
                if (m == "follow") ApplyCamera(shot); // start from the shot's framing, then keep the body part in view
                CameraTools.ShotMode(m, shot.Has("who") ? shot.GetInt("who") : -1, shot.GetString("bone"));
            }
            else if (_shots.Any(s => s.GetString("camMode") == "pov" || s.GetString("camMode") == "follow")) CameraTools.ShotMode(null, -1, null);
        }

        // ---------------- transitions ----------------

        // which shots have camera moves keyed in them (looked up again when the timeline changes, at most 4× a second)
        private static readonly Dictionary<string, bool> _keyed = new Dictionary<string, bool>();
        private static long _keyedSig = long.MinValue;
        private static float _keyedAt = -10f;

        /// <summary>
        /// How the shot's camera works: a still shot that has camera keys in it (or a keyed camera move running through
        /// it) plays those keys — the moves you keyed always win over a still camera.
        /// </summary>
        internal static string Mode(Dictionary<string, object> s)
        {
            string m = s.GetString("camMode") ?? "still";
            if (m != "still") return m;
            if (Time.unscaledTime - _keyedAt > 0.25f)
            {
                _keyedAt = Time.unscaledTime;
                long sig = TimelineApi.Signature();
                if (sig != _keyedSig) { _keyedSig = sig; _keyed.Clear(); }
            }
            string key = s.GetString("id") + "|" + s.GetFloat("start") + "|" + s.GetFloat("end");
            if (!_keyed.TryGetValue(key, out bool k)) _keyed[key] = k = TimelineApi.CameraAnimatedIn(s.GetFloat("start"), s.GetFloat("end"));
            return k ? "keys" : "still";
        }

        private static bool StillWithCam(Dictionary<string, object> s) => s != null && Mode(s) == "still" && s.GetObject("cam") != null;

        private static Dictionary<string, object> CamHolder(Vector3 pos, Vector3 rot, Vector3 dist, float fov, string id) => new Dictionary<string, object>
        {
            { "id", id }, { "cam", new Dictionary<string, object> { { "pos", V(pos) }, { "rot", V(rot) }, { "dist", V(dist) }, { "fov", (double)fov } } },
        };

        /// <summary>Between two shots' cameras: pivot, distance and lens in a straight line, the angle by the shortest turn.</summary>
        private static Dictionary<string, object> BlendCam(Dictionary<string, object> a, Dictionary<string, object> b, float f)
        {
            var ca = a.GetObject("cam");
            var cb = b.GetObject("cam");
            var rot = Quaternion.Slerp(Quaternion.Euler(V(ca.GetList("rot"))), Quaternion.Euler(V(cb.GetList("rot"))), f).eulerAngles;
            return CamHolder(Vector3.Lerp(V(ca.GetList("pos")), V(cb.GetList("pos")), f), rot, Vector3.Lerp(V(ca.GetList("dist")), V(cb.GetList("dist")), f),
                Mathf.Lerp(ca.GetFloat("fov", 23f), cb.GetFloat("fov", 23f), f), b.GetString("id"));
        }

        /// <summary>
        /// The transition the playhead is in, if any. A shot's transition is centred on its cut; it is never longer
        /// than the shot or the one before it. Glides and dissolves need still cameras on both sides (otherwise the
        /// shot just cuts); dips work with any shot, and on the first shot fade in from the colour.
        /// </summary>
        internal static TransitionFx.State Compute(float t)
        {
            Dictionary<string, object> prev = null;
            foreach (var b in _shots) // kept in start order
            {
                var a = prev;
                prev = b;
                var tr = b.GetObject("trans");
                string type = tr?.GetString("type");
                if (type == null || type == "cut") continue;
                float start = b.GetFloat("start");
                float dur = tr.GetFloat("dur", 0.5f);
                dur = Mathf.Min(dur, b.GetFloat("end") - start);
                if (a != null) dur = Mathf.Min(dur, a.GetFloat("end") - a.GetFloat("start"));
                if (dur < 0.02f) continue;
                float w0 = start - dur / 2f, w1 = start + dur / 2f;
                if (t < w0 - 1e-4f || t >= w1) continue;
                bool needsBoth = type == "glide" || type == "dissolve";
                if (needsBoth && (!StillWithCam(a) || !StillWithCam(b))) continue;
                float f = Mathf.Clamp01((t - w0) / dur);
                float e = tr.GetString("ease") == "linear" ? f : f * f * (3f - 2f * f);
                var st = new TransitionFx.State { Type = type, F = f, Id = b.GetString("id") };
                if (type == "glide") st.Cam = BlendCam(a, b, e);
                else if (type == "dissolve")
                {
                    st.Cam = b; // the incoming shot underneath, the outgoing one fading off it
                    st.Out = a;
                    st.OutA = 1f - e;
                }
                else
                {
                    // dips: into the colour until the cut, out of it after (the camera cuts at the middle)
                    float k = 1f - Mathf.Abs(2f * f - 1f);
                    st.FadeA = tr.GetString("ease") == "linear" ? k : k * k * (3f - 2f * k);
                    st.Fade = type == "dipWhite" ? Color.white : Color.black;
                }
                return st;
            }
            return null;
        }

        /// <summary>
        /// For the monitor: where the playhead's shot looks from — a still shot's camera, a transition's, or a first
        /// person / follow shot worked out from its character (without touching Studio's view). near &lt; 0: keep.
        /// </summary>
        internal static bool ProgramCamera(out Vector3 pos, out Quaternion rot, out float fov, out float near)
        {
            pos = Vector3.zero;
            rot = Quaternion.identity;
            fov = 0f;
            near = -1f;
            if (_shots.Count == 0 || !TimelineApi.Available) return false;
            float t = TimelineApi.PlaybackTime();
            var shot = ShotAt(t);
            var tr = Compute(t);
            if (tr?.Cam == null && shot != null && (Mode(shot) == "pov" || Mode(shot) == "follow"))
                return CameraTools.ShotView(Mode(shot), shot, out pos, out rot, out fov, out near);
            var cam = tr?.Cam != null ? tr.Cam.GetObject("cam") : shot != null && Mode(shot) == "still" ? shot.GetObject("cam") : null;
            if (cam == null) return false;
            rot = Quaternion.Euler(V(cam.GetList("rot")));
            pos = V(cam.GetList("pos")) + rot * V(cam.GetList("dist"));
            fov = cam.GetFloat("fov", 23f);
            return true;
        }

        /// <summary>
        /// Put Unity's camera where the shot's camera looks from, right now (Studio's camera control would only move
        /// it at the end of the frame): its pivot, turned by its angles, out at its distance.
        /// </summary>
        internal static bool PlaceMainCamera(Dictionary<string, object> shot)
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
                if (Mode(shot) != "still" || shot.GetObject("cam") == null) continue;
                var t = ThumbThrough(shot);
                if (t != null) { shot["thumb"] = t; n++; }
            }
            if (n > 0) Broadcast();
            return n;
        }

        /// <summary>
        /// The shot's frame guide. A shot set to Off shows no frame once any shot uses frames (so a 2.39:1 shot's
        /// frame doesn't stay up over the next one); when no shot uses frames, your own guide settings are left alone.
        /// </summary>
        private static void ApplyAspect(Dictionary<string, object> shot)
        {
            float a = shot.Has("aspect") ? shot.GetFloat("aspect") : 0f;
            if (a > 0f) CameraTools.SetAspect(a);
            else if (_shots.Any(s => s.Has("aspect") && s.GetFloat("aspect") > 0f)) CameraTools.SetAspect(0f);
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
            var studio = Singleton<Studio.Studio>.Instance;
            if (!ShotsActive || _shots.Count == 0 || !TimelineApi.Available || ViewportTools.Busy || studio == null || studio.ociCamera != null)
            {
                // sampling / ghost baking jump around on purpose; a scene camera is being looked through
                if (TransitionFx.Live != null) { TransitionFx.Live = null; TransitionFx.Sync(Camera.main); }
                return;
            }
            TimelineApi.LoopTick(StudioBridgePlugin.Instance?.ClientCount ?? 0); // a looping shot wraps before its camera is chosen
            try
            {
                float t = TimelineApi.PlaybackTime();
                bool moved = Mathf.Abs(t - _liveT) > 1e-5f;
                _liveT = t;
                bool playing = TimelineApi.Playing();
                var shot = ShotAt(t);
                string id = shot?.GetString("id");
                bool entered = id != _liveId;
                _liveId = id;
                if (shot != null && entered) { ApplyAspect(shot); ApplyMode(shot); }
                // a transition: its picture effect, and for glides / dissolves the camera it needs
                var tr = Compute(t);
                TransitionFx.Live = tr;
                if (tr?.Cam != null)
                {
                    if (playing || moved || entered)
                    {
                        ApplyCamera(tr.Cam);
                        PlaceMainCamera(tr.Cam);
                    }
                    // a dissolve's outgoing picture for this very frame (its first frame included)
                    if (tr.Out != null) TransitionFx.RequestOutgoing(tr.Out);
                    TransitionFx.Sync(Camera.main);
                    return;
                }
                TransitionFx.Sync(Camera.main);
                _traceShot = shot?.GetString("id");
                if (shot == null) return;
                if (Mode(shot) != "still") return; // camera keys, first person or follow drive it
                // playing, crossing a cut, or the playhead moved (scrubbing): the edit. Orbiting while paused is free.
                if (entered || playing || moved)
                {
                    _traceApplied = true;
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
            _keyedAt = -10f; // which shots play camera keys: read now, not from a moment ago (a bake just before)
            var withCam = _shots.Where(s => s.GetObject("cam") != null && Mode(s) == "still").ToList();
            if (withCam.Count == 0)
            {
                // baked before: every shot with a camera now plays camera keys — nothing new to bake
                if (_shots.Any(s => s.GetObject("cam") != null)) return 0;
                throw new BridgeException("Give the shots a camera first (frame the view, then Set camera)");
            }
            return BuildCutsImpl(withCam);
        }

        /// <summary>
        /// The keys bake writes: a hard cut at each still shot's start, or for a glide a key with the previous shot's
        /// camera where the glide starts and one with this shot's where it ends, eased in between. Dips and dissolves
        /// can't be camera keys: they stay as cuts in the keys and keep playing from live cuts.
        /// </summary>
        private static List<CutKey> CutKeys(List<Dictionary<string, object>> shots)
        {
            var keys = new List<CutKey>();
            Dictionary<string, object> prev = null;
            foreach (var s in _shots)
            {
                var a = prev;
                prev = s;
                if (!shots.Contains(s)) continue;
                var tr = s.GetObject("trans");
                float start = s.GetFloat("start");
                if (tr?.GetString("type") == "glide" && StillWithCam(a) && StillWithCam(s))
                {
                    float dur = Mathf.Min(tr.GetFloat("dur", 0.5f), s.GetFloat("end") - start, a.GetFloat("end") - a.GetFloat("start"));
                    var from = a;
                    keys.Add(new CutKey { T = start - dur / 2f, Apply = () => ApplyCamera(from), Glide = false });
                    keys.Add(new CutKey { T = start + dur / 2f, Apply = () => ApplyCamera(s), Glide = true, Smooth = tr.GetString("ease") != "linear" });
                }
                else keys.Add(new CutKey { T = start, Apply = () => ApplyCamera(s) });
            }
            return keys;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object BuildCutsImpl(List<Dictionary<string, object>> shots) => TimelineImpl.KeyShotCuts(CutKeys(shots));

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
            RenderApi.ApplySpeed(a);
            _renderShots = true; // one video per shot: through the shots' cameras
            _queue = _i.StartCoroutine(_i.RunQueue(Jobs(shots, Versions(a), true), RenderApi.Warmups()));
            return QueueState;
        }

        /// <summary>Render `seconds` of the timeline from `start` as one video per version, playing it while recording
        /// (VideoExport's own modes only record whatever is on screen, so the animation wouldn't move).</summary>
        public static object StartRange(float start, float seconds, int warmups = 0, List<Dictionary<string, object>> versions = null, bool useShots = true)
        {
            if ((bool)QueueState["running"]) throw new BridgeException("A render is already running");
            if (!TimelineApi.Available) throw new BridgeException("Rendering the animation needs Timeline");
            if (TimelineApi.Pending() > 0) throw new BridgeException("Key or reset your unkeyed changes first — rendering plays the timeline");
            if (RenderApi.Probe() != null) throw new BridgeException("Render needs VideoExport");
            if (seconds <= 0.01f) throw new BridgeException("Nothing to render: the playhead is at the end of the timeline");
            var range = new Dictionary<string, object> { { "name", "Timeline" }, { "start", (double)start }, { "end", (double)(start + seconds) } };
            _renderShots = useShots && _shots.Count > 0;
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
            _rendering = true;
            var cc = Singleton<Studio.Studio>.Instance.cameraCtrl;
            Studio.CameraControl.CameraData viewBefore = null; // (the render follows the same switch as Studio)
            float fovBefore = cc.fieldOfView;
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
                    // (only when a video is wanted: "keep the frames, no video" is image files by definition)
                    bool direct = DirectRender.Frames == "direct" && DirectRender.Supports(RenderApi.Format()) && RenderApi.AutoEncode();
                    size = direct ? null : RenderApi.PrepareSize(); // straight to video renders at the size itself
                    RenderFraming.Active = RenderFraming.From(version?.ContainsKey("framing") == true ? version["framing"] as Dictionary<string, object> : null);
                    // warm-up, so hair and clothes physics have settled: quick — the 1.5 s leading into the start played
                    // (what there is of it) and the rest held at the start; play — the range played through first
                    if (RenderApi.Warm == "quick")
                    {
                        QueueState["phase"] = "Warm-up";
                        float lead = Mathf.Min(1.5f, start);
                        TimelineApi.PauseAt(start - lead);
                        _liveId = null;
                        yield return null;
                        float w0 = Time.realtimeSinceStartup;
                        if (lead > 0.05f)
                        {
                            TimelineApi.Play();
                            while (Time.realtimeSinceStartup - w0 < lead && !(bool)QueueState["cancel"]) yield return null;
                        }
                        TimelineApi.PauseAt(start);
                        while (Time.realtimeSinceStartup - w0 < 1.5f && !(bool)QueueState["cancel"]) yield return null;
                    }
                    int plays = RenderApi.Warm == "play" ? Math.Max(1, warmups) : 0;
                    for (int w = 0; w < plays && !(bool)QueueState["cancel"]; w++)
                    {
                        QueueState["phase"] = "Warm-up " + (w + 1) + " of " + plays;
                        TimelineApi.PauseAt(start);
                        _liveId = null; // this frame already shows the starting shot's camera
                        yield return null;
                        TimelineApi.Play();
                        float t0 = Time.realtimeSinceStartup;
                        while (Time.realtimeSinceStartup - t0 < end - start && !(bool)QueueState["cancel"]) yield return null;
                    }
                    QueueState["phase"] = null;
                    if ((bool)QueueState["cancel"]) break;
                    TimelineApi.PauseAt(start);
                    // the very first recorded frame is taken before playing starts: the starting shot's camera has to
                    // be in place already (live cuts would only switch on entering a shot, or while playing)
                    _liveId = null;
                    yield return null;
                    yield return new WaitForEndOfFrame();
                    var startedAt = DateTime.Now;
                    string directVideo = null;
                    if (direct)
                    {
                        // straight to video: frames into ffmpeg as they're rendered (this plays the timeline)
                        string derr = null;
                        var rec = DirectRender.Record(end - start, () => (bool)QueueState["cancel"], (v, e) => { directVideo = v; derr = e; });
                        while (rec.MoveNext()) yield return rec.Current;
                        if (derr != null) { QueueState["error"] = derr; break; }
                    }
                    else
                    {
                        RenderSpeed.Begin(); // JPG frames, Draft, the encoder choice (Screencap's settings come back after)
                        string err = RenderApi.StartSeconds(end - start);
                        if (err != null) { RenderSpeed.End(); QueueState["error"] = err; break; }
                        TimelineApi.Play();
                        // VideoExport takes over the frame clock while recording; wait for recording and encoding
                        yield return null;
                        while (RenderApi.Busy()) yield return null;
                        RenderSpeed.End();
                    }
                    TimelineApi.PauseAt(start);
                    RenderFraming.Active = null;
                    // the finished video: cut to shape if it couldn't be rendered at the size, the scene's audio mixed in
                    // (ffmpeg on a worker thread), and the shot's / version's name on the file
                    var clips = RenderApi.WithAudio ? AudioTrack.ForRender(start, end) : null;
                    bool crop = size != null && size.CropW > 0;
                    string suffix = s.GetString("suffix") ?? "";
                    var video = (bool)QueueState["cancel"] ? null : direct ? directVideo : RenderApi.NewestVideo(startedAt);
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
                RenderSpeed.End();
                _rendering = false;
                if (!ShotsActive) ReleaseShotModes();
                if (viewBefore != null)
                {
                    try
                    {
                        cc.Import(viewBefore);
                        cc.fieldOfView = fovBefore;
                        TransitionFx.Reset();
                    }
                    catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("View after render: " + e.Message); }
                }
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
                SetExtendedData(_shots.Count == 0 && _angles.Count == 0 ? null : new PluginData { version = 1, data = new Dictionary<string, object> { { "shots", Json.Serialize(_shots) }, { "liveCuts", _liveCuts }, { "angles", Json.Serialize(_angles) } } });
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
                    if (d.data.TryGetValue("angles", out var aj) && aj is string ajson)
                        _angles = (Json.Parse(ajson) as List<object> ?? new List<object>()).OfType<Dictionary<string, object>>().ToList();
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene shots not loaded: " + e.Message); }
                Broadcast();
            }
        }
    }
}
