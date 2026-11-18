using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using UnityEngine.Rendering;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// In-viewport animation aids drawn inside Studio:
    ///  • Motion paths — the route of animated positions (objects, characters, bones, the camera target),
    ///    computed from the keys + easing curves, drawn on top of the scene with dots at each key.
    ///  • Onion skin ("ghosts") — translucent copies of the selected characters/items at neighbouring keys
    ///    (or fixed steps), baked by briefly seeking to those times.
    /// Ghosts are only rebuilt when nothing is waiting to be keyed: seeking back re-applies the keyed pose,
    /// which would otherwise throw away the user's unkeyed edits.
    /// </summary>
    internal sealed class ViewportTools : MonoBehaviour
    {
        public sealed class PathInfo
        {
            public GuideObject Guide;
            public bool IsCamera;
            public string Label;
            public List<float> Times;
            public List<Vector3> Values;
            public List<AnimationCurve> Curves;
        }

        public static ViewportTools Instance;
        /// <summary>True while ghosts are being baked (the timeline is jumping around on purpose).</summary>
        public static bool Busy;
        private static float _busySince;
        private Coroutine _bake;
        private float _nextGhostCheck;

        /// <summary>A long job (motion sampling) keeps the bridge paused; call every frame so the watchdog waits.</summary>
        public static void HoldBusy()
        {
            Busy = true;
            _busySince = Time.unscaledTime;
        }

        /// <summary>Safety net: a bake never takes more than a few frames; if Busy sticks, release it.</summary>
        public static void Watchdog()
        {
            if (Busy && Time.unscaledTime - _busySince > 5f)
            {
                StudioBridgePlugin.Logger.LogWarning("Ghost bake stuck; releasing");
                Busy = false;
            }
        }

        public bool Paths;
        public bool PathsCamera = true;
        /// <summary>Also trace where the selected characters' hands / feet / head go (FK, IK or anything else).</summary>
        public bool PathsBody = true;
        public string PathsBones = "hands,feet,head";
        public bool Ghosts;
        public bool GhostsAuto = true;
        public int GhostCount = 2;
        public string GhostMode = "keys"; // keys | step
        public float GhostStep = 0.25f;
        public float GhostOpacity = 0.35f;

        private GameObject _pathRoot, _ghostRoot;
        private Material _lineMat, _dotMat, _ghostPast, _ghostFuture;
        private readonly List<Mesh> _bakedMeshes = new List<Mesh>();
        private readonly List<Material> _ghostMats = new List<Material>();
        private readonly List<KeyValuePair<PathInfo, Transform>> _markers = new List<KeyValuePair<PathInfo, Transform>>();
        private float _nextPathCheck;
        private GameObject _bodyRoot;
        private Coroutine _bodyBake;
        private string _bodySig = "", _bodyWantSig = "";
        private float _bodyWantSince;
        private int _bodyLines;
        private string _pathSig = "";
        private string _ghostSig = "", _ghostWantSig = "";
        private float _ghostWantSince;

        public static void Register(CommandRouter r)
        {
            r.Add("viewport.get", a => Instance.State());
            r.Add("viewport.set", a => Instance.Set(a));
            r.Add("viewport.refreshGhosts", a =>
            {
                if (TimelineApi.Pending() > 0) throw new BridgeException("Key or discard your changes first — rebuilding ghosts would reset the unkeyed pose");
                Instance.RequestGhosts(force: true);
                return true;
            });
        }

        private void Awake() => Instance = this;

        private object State() => new Dictionary<string, object>
        {
            { "paths", Paths }, { "pathsCamera", PathsCamera }, { "pathsBody", PathsBody }, { "pathsBones", PathsBones },
            { "pathsDrawn", _markers.Count + _bodyLines }, { "pathsBaking", _bodyBake != null }, { "pathsNote", Note() },
            { "ghosts", Ghosts }, { "ghostsAuto", GhostsAuto }, { "ghostCount", GhostCount },
            { "ghostMode", GhostMode }, { "ghostStep", GhostStep }, { "ghostOpacity", GhostOpacity },
            { "ghostCountBuilt", _ghostRoot != null ? _ghostRoot.transform.childCount : 0 },
            { "pathCount", _markers.Count },
            { "busy", Busy },
            { "shader", _lineMat != null ? _lineMat.shader.name : "" },
            { "cullingMask", Camera.main != null ? Camera.main.cullingMask : 0 },
            { "pathLayer", _pathRoot != null ? _pathRoot.layer : -1 },
            { "pathDebug", PathDebug() },
        };

        private object PathDebug()
        {
            var cam = Camera.main;
            var list = new List<object>();
            if (_pathRoot == null || cam == null) return list;
            foreach (var lr in _pathRoot.GetComponentsInChildren<LineRenderer>(true))
            {
                if (lr.positionCount == 0) continue;
                var p0 = lr.GetPosition(0);
                var vp = cam.WorldToViewportPoint(p0);
                list.Add(new Dictionary<string, object>
                {
                    { "points", lr.positionCount },
                    { "first", new List<object> { p0.x, p0.y, p0.z } },
                    { "viewport", new List<object> { vp.x, vp.y, vp.z } },
                    { "enabled", lr.enabled && lr.gameObject.activeInHierarchy },
                    { "width", lr.startWidth },
                    { "bounds", lr.bounds.size.ToString() },
                    { "visible", lr.isVisible },
                    { "cam", cam.name + " " + cam.transform.position },
                });
            }
            return list;
        }

        private object Set(Dictionary<string, object> a)
        {
            if (a.Has("paths")) Paths = a.GetBool("paths");
            if (a.Has("pathsCamera")) PathsCamera = a.GetBool("pathsCamera", true);
            if (a.Has("pathsBody")) PathsBody = a.GetBool("pathsBody", true);
            if (a.Has("pathsBones")) PathsBones = a.GetString("pathsBones") ?? "";
            _bodySig = "";
            if (!Paths || !PathsBody) ClearBody();
            if (a.Has("ghosts")) Ghosts = a.GetBool("ghosts");
            if (a.Has("ghostsAuto")) GhostsAuto = a.GetBool("ghostsAuto", true);
            if (a.Has("ghostCount")) GhostCount = Mathf.Clamp(a.GetInt("ghostCount"), 1, 5);
            if (a.Has("ghostMode")) GhostMode = a.GetString("ghostMode") == "step" ? "step" : "keys";
            if (a.Has("ghostStep")) GhostStep = Mathf.Clamp(a.GetFloat("ghostStep"), 1f / 60f, 5f);
            if (a.Has("ghostOpacity")) GhostOpacity = Mathf.Clamp(a.GetFloat("ghostOpacity"), 0.05f, 0.8f);
            _pathSig = "";
            _ghostSig = "";
            if (!Paths) { ClearPaths(); ClearBody(); }
            if (!Ghosts) ClearGhosts();
            else RequestGhosts(force: false);
            UpdateMaterials();
            return State();
        }

        // ------------------------------------------------------------------
        // Materials
        // ------------------------------------------------------------------

        private static Material MakeMat(Color c, bool onTop)
        {
            var shader = Shader.Find("Hidden/Internal-Colored") ?? Shader.Find("Sprites/Default");
            var m = new Material(shader) { hideFlags = HideFlags.HideAndDontSave, color = c };
            m.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
            m.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
            // Ghosts write depth so only each copy's outer surface shows (clean silhouettes instead of
            // body + clothes + hair layers stacking up); overlays (paths) draw on top of everything.
            m.SetInt("_Cull", (int)(onTop ? CullMode.Off : CullMode.Back));
            m.SetInt("_ZWrite", onTop ? 0 : 1);
            m.SetInt("_ZTest", (int)(onTop ? CompareFunction.Always : CompareFunction.LessEqual));
            m.renderQueue = onTop ? 4000 : 3000;
            return m;
        }

        private void UpdateMaterials()
        {
            if (_lineMat == null) _lineMat = MakeMat(new Color(1f, 0.62f, 0.18f, 0.95f), true);
            if (_dotMat == null) _dotMat = MakeMat(new Color(1f, 1f, 1f, 0.95f), true);
            if (_ghostPast == null) _ghostPast = MakeMat(Color.white, false);
            if (_ghostFuture == null) _ghostFuture = MakeMat(Color.white, false);
            _ghostPast.color = new Color(0.35f, 0.62f, 1f, GhostOpacity);
            _ghostFuture.color = new Color(1f, 0.5f, 0.3f, GhostOpacity);
        }

        // ------------------------------------------------------------------
        // Update loop
        // ------------------------------------------------------------------

        private static HashSet<ObjectCtrlInfo> Selected()
        {
            var set = new HashSet<ObjectCtrlInfo>();
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) return set;
            foreach (var oci in studio.treeNodeCtrl.selectObjectCtrl) if (oci != null) set.Add(oci);
            return set;
        }

        /// <summary>Time the last Update took (paths, ghosts, markers), for the bridge's frame budget.</summary>
        internal static double LastFrameMs;
        private readonly System.Diagnostics.Stopwatch _sw = new System.Diagnostics.Stopwatch();

        private void Update()
        {
            _sw.Reset();
            _sw.Start();
            try { UpdateInner(); }
            finally { LastFrameMs = _sw.Elapsed.TotalMilliseconds; }
        }

        private void UpdateInner()
        {
            if (Busy || !TimelineApi.Available) return;
            bool playing = TimelineApi.Playing();

            if (_ghostRoot != null) _ghostRoot.SetActive(!playing);

            if (Paths && Time.unscaledTime >= _nextPathCheck)
            {
                _nextPathCheck = Time.unscaledTime + 0.3f;
                try { RebuildPathsIfChanged(); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("paths: " + e.Message); }
                try { if (PathsBody && !playing) AutoBody(); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("body paths: " + e.Message); }
            }
            if (Paths) UpdateMarkers();

            // The signature walks every key of the timeline: check a few times a second, not every frame.
            if (Ghosts && GhostsAuto && !playing && Time.unscaledTime >= _nextGhostCheck)
            {
                _nextGhostCheck = Time.unscaledTime + 0.15f;
                AutoGhosts();
            }
        }

        // ------------------------------------------------------------------
        // Motion paths
        // ------------------------------------------------------------------

        private static Vector3 ToWorld(PathInfo p, Vector3 local)
        {
            if (p.IsCamera || p.Guide == null) return local; // camera origin is already world space
            var g = p.Guide;
            Transform basis = g.parent != null && g.nonconnect ? g.parent : g.transformTarget != null ? g.transformTarget.parent : null;
            return basis != null ? basis.TransformPoint(local) : local;
        }

        private static Vector3 Sample(PathInfo p, float t)
        {
            var ts = p.Times;
            if (t <= ts[0]) return p.Values[0];
            if (t >= ts[ts.Count - 1]) return p.Values[ts.Count - 1];
            int i = 0;
            while (i < ts.Count - 2 && t > ts[i + 1]) i++;
            float f = (t - ts[i]) / Mathf.Max(1e-6f, ts[i + 1] - ts[i]);
            float e = p.Curves[i] != null ? p.Curves[i].Evaluate(f) : f;
            return Vector3.LerpUnclamped(p.Values[i], p.Values[i + 1], e);
        }

        private void RebuildPathsIfChanged()
        {
            var sel = Selected();
            string sig = TimelineApi.Signature() + "|" + string.Join(",", sel.Select(o => o.objectInfo.dicKey.ToString()).ToArray()) + "|" + PathsCamera;
            if (sig == _pathSig && _pathRoot != null) return;
            _pathSig = sig;
            ClearPaths();
            UpdateMaterials();
            var paths = TimelineApi.PositionPaths(sel, PathsCamera);
            if (paths.Count == 0) return;
            _pathRoot = new GameObject("StudioEX.MotionPaths") { hideFlags = HideFlags.DontSave };
            float duration = TimelineApi.Duration();
            foreach (var p in paths)
            {
                float t0 = 0f, t1 = Mathf.Max(duration, p.Times[p.Times.Count - 1]);
                int n = Mathf.Clamp(Mathf.CeilToInt((t1 - t0) * 30f), 2, 900);
                var pts = new Vector3[n + 1];
                for (int i = 0; i <= n; i++) pts[i] = ToWorld(p, Sample(p, t0 + (t1 - t0) * i / n));

                var go = new GameObject("path " + p.Label);
                go.transform.SetParent(_pathRoot.transform, false);
                var lr = go.AddComponent<LineRenderer>();
                lr.useWorldSpace = true;
                lr.sharedMaterial = _lineMat;
                lr.startWidth = lr.endWidth = 0.014f;
                lr.startColor = new Color(0.35f, 0.62f, 1f, 0.9f);
                lr.endColor = new Color(1f, 0.62f, 0.18f, 0.9f);
                lr.shadowCastingMode = ShadowCastingMode.Off;
                lr.receiveShadows = false;
                lr.positionCount = pts.Length;
                lr.SetPositions(pts);

                for (int i = 0; i < p.Values.Count; i++)
                    Dot(go.transform, ToWorld(p, p.Values[i]), 0.035f);
                var marker = Dot(go.transform, Vector3.zero, 0.05f);
                _markers.Add(new KeyValuePair<PathInfo, Transform>(p, marker));
            }
            SetLayer(_pathRoot, VisibleLayer(sel));
        }

        /// <summary>
        /// Studio's camera only renders certain layers; our helper objects must sit on one it draws.
        /// Prefer the layer the selected objects' renderers use (guaranteed visible), else any culled-in layer.
        /// </summary>
        private static int VisibleLayer(HashSet<ObjectCtrlInfo> sel)
        {
            var cam = Camera.main;
            int mask = cam != null ? cam.cullingMask : ~0;
            foreach (var oci in sel)
            {
                GameObject root = oci is OCIChar ch ? (ch.charInfo != null ? ch.charInfo.gameObject : null) : oci is OCIItem it ? it.objectItem : null;
                var r = root != null ? root.GetComponentInChildren<Renderer>() : null;
                if (r != null && (mask & (1 << r.gameObject.layer)) != 0) return r.gameObject.layer;
            }
            for (int i = 0; i < 32; i++) if ((mask & (1 << i)) != 0) return i;
            return 0;
        }

        private static void SetLayer(GameObject go, int layer)
        {
            go.layer = layer;
            foreach (Transform t in go.transform) SetLayer(t.gameObject, layer);
        }

        private Transform Dot(Transform parent, Vector3 pos, float size)
        {
            var s = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            var col = s.GetComponent<Collider>();
            if (col != null) Destroy(col);
            s.transform.SetParent(parent, false);
            s.transform.position = pos;
            s.transform.localScale = Vector3.one * size;
            var r = s.GetComponent<MeshRenderer>();
            r.sharedMaterial = _dotMat;
            r.shadowCastingMode = ShadowCastingMode.Off;
            r.receiveShadows = false;
            return s.transform;
        }

        private void UpdateMarkers()
        {
            if (_markers.Count == 0) return;
            float t = TimelineApi.PlaybackTime();
            foreach (var kv in _markers)
                if (kv.Value != null) kv.Value.position = ToWorld(kv.Key, Sample(kv.Key, t));
        }

        private void ClearPaths()
        {
            _markers.Clear();
            if (_pathRoot != null) Destroy(_pathRoot);
            _pathRoot = null;
        }

        // ------------------------------------------------------------------
        // Body paths: where a character's hands / feet / head travel, whatever moves them
        // ------------------------------------------------------------------

        private static readonly Dictionary<string, KeyValuePair<string, Color>[]> BodyParts = new Dictionary<string, KeyValuePair<string, Color>[]>
        {
            { "hands", new[] { new KeyValuePair<string, Color>("cf_j_hand_L", new Color(0.36f, 0.63f, 1f, 0.95f)), new KeyValuePair<string, Color>("cf_j_hand_R", new Color(1f, 0.62f, 0.18f, 0.95f)) } },
            { "feet", new[] { new KeyValuePair<string, Color>("cf_j_foot_L", new Color(0.31f, 0.82f, 0.65f, 0.95f)), new KeyValuePair<string, Color>("cf_j_foot_R", new Color(0.88f, 0.82f, 0.29f, 0.95f)) } },
            { "head", new[] { new KeyValuePair<string, Color>("cf_j_head", new Color(1f, 0.44f, 0.69f, 0.95f)) } },
        };

        // The overlay shader takes its colour from the material (not the line's vertex colours): one per colour.
        private readonly Dictionary<Color, Material> _bodyMats = new Dictionary<Color, Material>();
        private Material BodyMat(Color c)
        {
            if (!_bodyMats.TryGetValue(c, out var m) || m == null) _bodyMats[c] = m = MakeMat(c, true);
            return m;
        }

        private void ClearBody()
        {
            if (_bodyRoot != null) Destroy(_bodyRoot);
            _bodyRoot = null;
            _bodyLines = 0;
        }

        /// <summary>
        /// Retrace when the animation, the selection or the chosen parts change — once things have settled, while
        /// paused, and never with unkeyed changes (tracing moves the playhead, which would reset them).
        /// </summary>
        private void AutoBody()
        {
            var chars = Selected().OfType<OCIChar>().Where(c => c.charInfo != null && TimelineApi.Animated(c)).OrderBy(c => c.objectInfo.dicKey).ToList();
            if (chars.Count == 0 || PathsBones.Length == 0)
            {
                if (_bodyRoot != null) ClearBody();
                _bodySig = "";
                return;
            }
            string sig = TimelineApi.Signature() + "|" + string.Join(",", chars.Select(c => c.objectInfo.dicKey.ToString()).ToArray()) + "|" + PathsBones + "|" + TimelineApi.Duration();
            if (sig == _bodySig || _bodyBake != null) return;
            if (TimelineApi.Pending() > 0) return;
            if (sig != _bodyWantSig)
            {
                _bodyWantSig = sig;
                _bodyWantSince = Time.unscaledTime;
                return;
            }
            if (Time.unscaledTime - _bodyWantSince < 0.8f || Busy || MotionSampler.Running) return;
            _bodySig = sig;
            _bodyBake = StartCoroutine(BakeBody(chars));
        }

        private IEnumerator BakeBody(List<OCIChar> chars)
        {
            float dur = Mathf.Max(0.1f, TimelineApi.Duration());
            int n = Mathf.Clamp(Mathf.CeilToInt(dur * 10f) + 1, 2, 160);
            var wanted = PathsBones.Split(',').Select(x => x.Trim()).Where(BodyParts.ContainsKey).SelectMany(x => BodyParts[x]).ToList();
            var bones = new Dictionary<OCIChar, List<KeyValuePair<Transform, Color>>>();
            foreach (var c in chars)
            {
                var all = c.charInfo.GetComponentsInChildren<Transform>(true);
                bones[c] = wanted.Select(w => new KeyValuePair<Transform, Color>(all.FirstOrDefault(t => t.name == w.Key), w.Value)).Where(x => x.Key != null).ToList();
            }
            var pts = bones.ToDictionary(kv => kv.Key, kv => kv.Value.Select(_ => new Vector3[n]).ToList());
            float back = TimelineApi.PlaybackTime();
            bool seeked = false, ok = false;
            try
            {
                for (int i = 0; i < n; i++)
                {
                    HoldBusy(); // requests and change detection wait until we're done
                    TimelineApi.SeekTo(dur * i / (n - 1));
                    seeked = true;
                    yield return new WaitForEndOfFrame(); // FK / IK / animation applied for this time
                    foreach (var kv in bones)
                    {
                        if (kv.Key.charInfo == null) yield break;
                        for (int b = 0; b < kv.Value.Count; b++) pts[kv.Key][b][i] = kv.Value[b].Key.position;
                    }
                }
                ok = true;
            }
            finally
            {
                if (seeked) { try { TimelineApi.SeekTo(back); } catch { } }
                Busy = false;
                EventPump.RequestRebase();
                _bodyBake = null;
                if (!ok) _bodySig = "";
            }
            ClearBody();
            if (!Paths || !PathsBody) yield break;
            UpdateMaterials();
            _bodyRoot = new GameObject("StudioEX.BodyPaths") { hideFlags = HideFlags.DontSave };
            foreach (var kv in bones)
            {
                // dots where the character has keys, so timing shows on the arcs
                var keyTimes = TimelineApi.KeyTimes(new HashSet<ObjectCtrlInfo> { kv.Key });
                for (int b = 0; b < kv.Value.Count; b++)
                {
                    var line = pts[kv.Key][b];
                    var go = new GameObject("body path " + kv.Value[b].Key.name);
                    go.transform.SetParent(_bodyRoot.transform, false);
                    var lr = go.AddComponent<LineRenderer>();
                    lr.useWorldSpace = true;
                    lr.sharedMaterial = BodyMat(kv.Value[b].Value);
                    lr.startWidth = lr.endWidth = 0.012f;
                    lr.shadowCastingMode = ShadowCastingMode.Off;
                    lr.receiveShadows = false;
                    lr.positionCount = line.Length;
                    lr.SetPositions(line);
                    _bodyLines++;
                    foreach (var t in keyTimes)
                    {
                        float f = Mathf.Clamp01(t / dur) * (n - 1);
                        int i0 = Mathf.Min(n - 2, Mathf.FloorToInt(f));
                        Dot(go.transform, Vector3.Lerp(line[i0], line[i0 + 1], f - i0), 0.022f);
                    }
                }
            }
            SetLayer(_bodyRoot, VisibleLayer(new HashSet<ObjectCtrlInfo>(chars.Cast<ObjectCtrlInfo>())));
            StudioBridgePlugin.Instance?.Broadcast("viewport.changed", State());
        }

        /// <summary>Why Paths shows nothing (empty when something is drawn).</summary>
        private string Note()
        {
            if (!Paths || _markers.Count > 0 || _bodyLines > 0) return "";
            if (_bodyBake != null) return "Tracing body paths…";
            var sel = Selected();
            if (sel.Count == 0) return PathsCamera ? "Select something in Studio — paths follow the selection (the camera's path shows once its target moves)" : "Select something in Studio — paths follow the selection";
            if (!sel.Any(TimelineApi.Animated)) return "The selection has no animation yet (a track needs two keys or more)";
            if (TimelineApi.Pending() > 0 && PathsBody && sel.OfType<OCIChar>().Any(TimelineApi.Animated)) return "Key or reset your changes first — tracing body paths moves the playhead";
            if (sel.OfType<OCIChar>().Any() && (!PathsBody || PathsBones.Length == 0)) return "Turn on body paths (hands, feet, head) to trace a character";
            return "Nothing selected moves";
        }

        // ------------------------------------------------------------------
        // Ghosts (onion skin)
        // ------------------------------------------------------------------

        private string GhostSignature() =>
            TimelineApi.Signature() + "|" + TimelineApi.PlaybackTime().ToString("0.###") + "|" +
            string.Join(",", Selected().Select(o => o.objectInfo.dicKey.ToString()).ToArray()) + "|" + GhostMode + GhostCount + GhostStep;

        private void AutoGhosts()
        {
            string want = GhostSignature();
            if (want == _ghostSig) return;
            if (want != _ghostWantSig)
            {
                _ghostWantSig = want;
                _ghostWantSince = Time.unscaledTime;
                return;
            }
            // Wait until things have been still for a moment, the mouse is up, and nothing is unkeyed.
            if (Time.unscaledTime - _ghostWantSince < 0.6f) return;
            if (Input.GetMouseButton(0) || Input.GetMouseButton(1) || Input.GetMouseButton(2)) return;
            if (TimelineApi.Pending() > 0) return;
            RequestGhosts(force: false);
        }

        private void RequestGhosts(bool force)
        {
            if (Busy || TimelineApi.Playing()) return;
            if (!force && TimelineApi.Pending() > 0) return;
            _bake = StartCoroutine(BuildGhosts());
        }

        private List<float> GhostTimes(float t0, HashSet<ObjectCtrlInfo> sel)
        {
            var times = new List<float>();
            float dur = TimelineApi.Duration();
            if (GhostMode == "step")
            {
                for (int i = 1; i <= GhostCount; i++)
                {
                    if (t0 - i * GhostStep >= 0f) times.Add(t0 - i * GhostStep);
                    if (t0 + i * GhostStep <= dur) times.Add(t0 + i * GhostStep);
                }
            }
            else
            {
                var keys = TimelineApi.KeyTimes(sel);
                times.AddRange(keys.Where(k => k < t0 - 1e-3f).Reverse().Take(GhostCount));
                times.AddRange(keys.Where(k => k > t0 + 1e-3f).Take(GhostCount));
            }
            return times;
        }

        private IEnumerator BuildGhosts()
        {
            Busy = true;
            _busySince = Time.unscaledTime;
            var sel = Selected();
            float t0 = TimelineApi.PlaybackTime();
            bool seeked = false;
            try
            {
            var times = GhostTimes(t0, sel);
            ClearGhosts();
            UpdateMaterials();
            if (sel.Count > 0 && times.Count > 0)
            {
                _ghostRoot = new GameObject("StudioEX.Ghosts") { hideFlags = HideFlags.DontSave };
                foreach (var t in times)
                {
                    TimelineApi.SeekTo(t);
                    seeked = true;
                    yield return new WaitForEndOfFrame(); // let IK/FK/animation settle for this time
                    if (_ghostRoot == null) yield break; // scene was cleared mid-bake
                    sel.RemoveWhere(o => o == null || (o is OCIChar oc && oc.charInfo == null) || (o is OCIItem oi && oi.objectItem == null));
                    float dist = Mathf.Abs(t - t0) / Mathf.Max(1e-3f, times.Max(x => Mathf.Abs(x - t0)));
                    var mat = new Material(t < t0 ? _ghostPast : _ghostFuture) { hideFlags = HideFlags.HideAndDontSave };
                    _ghostMats.Add(mat);
                    var c = mat.color;
                    c.a = GhostOpacity * Mathf.Lerp(1f, 0.45f, dist);
                    mat.color = c;
                    foreach (var oci in sel) Bake(oci, mat);
                }
                TimelineApi.SeekTo(t0);
                seeked = false;
                yield return null;
            }
            _ghostSig = GhostSignature();
            _ghostWantSig = _ghostSig;
            }
            finally
            {
                // Runs on completion, on exceptions and on yield break: never leave Studio at a ghost time
                // or the bridge muted.
                if (seeked) { try { TimelineApi.SeekTo(t0); } catch { } }
                Busy = false;
                _bake = null;
            }
        }

        private void Bake(ObjectCtrlInfo oci, Material mat)
        {
            GameObject root = oci is OCIChar ch ? ch.charInfo?.gameObject : oci is OCIItem it ? it.objectItem : null;
            if (root == null || _bakedMeshes.Count > 600) return;
            foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>(false))
            {
                if (!smr.enabled || smr.sharedMesh == null) continue;
                var mesh = new Mesh { hideFlags = HideFlags.HideAndDontSave };
                smr.BakeMesh(mesh);
                _bakedMeshes.Add(mesh);
                Ghost(mesh, smr.transform.position, smr.transform.rotation, Vector3.one, mat, smr.gameObject.layer);
            }
            foreach (var mf in root.GetComponentsInChildren<MeshFilter>(false))
            {
                var mr = mf.GetComponent<MeshRenderer>();
                if (mf.sharedMesh == null || mr == null || !mr.enabled) continue;
                Ghost(mf.sharedMesh, mf.transform.position, mf.transform.rotation, mf.transform.lossyScale, mat, mf.gameObject.layer);
            }
        }

        private void Ghost(Mesh mesh, Vector3 pos, Quaternion rot, Vector3 scale, Material mat, int layer)
        {
            var g = new GameObject("ghost") { layer = layer };
            g.transform.SetParent(_ghostRoot.transform, false);
            g.transform.position = pos;
            g.transform.rotation = rot;
            g.transform.localScale = scale;
            g.AddComponent<MeshFilter>().sharedMesh = mesh;
            var r = g.AddComponent<MeshRenderer>();
            var mats = new Material[Mathf.Max(1, mesh.subMeshCount)];
            for (int i = 0; i < mats.Length; i++) mats[i] = mat;
            r.sharedMaterials = mats;
            r.shadowCastingMode = ShadowCastingMode.Off;
            r.receiveShadows = false;
        }

        private void ClearGhosts()
        {
            if (_ghostRoot != null) Destroy(_ghostRoot);
            _ghostRoot = null;
            foreach (var m in _bakedMeshes) if (m != null) Destroy(m);
            _bakedMeshes.Clear();
            foreach (var m in _ghostMats) if (m != null) Destroy(m);
            _ghostMats.Clear();
        }

        public void ClearAll()
        {
            if (_bake != null) { StopCoroutine(_bake); _bake = null; Busy = false; } // StopCoroutine skips finally
            if (_bodyBake != null) { StopCoroutine(_bodyBake); _bodyBake = null; Busy = false; }
            ClearPaths();
            ClearBody();
            ClearGhosts();
            _pathSig = _ghostSig = _ghostWantSig = _bodySig = _bodyWantSig = "";
        }

        private void OnDestroy() => ClearAll();
    }
}
