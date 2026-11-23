using System;
using System.Collections.Generic;
using System.Linq;
using BepInEx.Bootstrap;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Camera tools: first-person view from a character's eyes (RealPOV when installed, ours otherwise), follow a
    /// body part (LockOnPlugin when installed, ours otherwise), and framing guides drawn over Studio's window
    /// (never in renders or snapshots: they're screen overlays, hidden while VideoExport records).
    /// </summary>
    internal sealed class CameraTools : MonoBehaviour
    {
        public static CameraTools Instance;

        /// <summary>
        /// A shot's camera type (live cuts, look through): "pov" through character `id`'s eyes, "follow" keeping its
        /// `bone` in view, anything else turns both off. Only changes what differs; the app hears about it.
        /// </summary>
        internal static void ShotMode(string mode, int id, string bone)
        {
            var t = Instance;
            if (t == null) return;
            bool changed = false;
            try
            {
                if (mode == "pov")
                {
                    if (!t._pov || t._povId != id) { t.PovOn(id); changed = true; }
                }
                else if (mode == "follow")
                {
                    bool newBone = !string.IsNullOrEmpty(bone) && Bones.ContainsKey(bone) && bone != t._followBone;
                    if (newBone) t._followBone = bone;
                    if (!t._follow || t._followId != id || newBone) { t.FollowOn(id); changed = true; }
                }
                else if (t._pov || t._follow)
                {
                    t.PovOff();
                    t.FollowOff();
                    changed = true;
                }
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Shot camera (" + mode + "): " + e.Message); }
            if (changed) StudioBridgePlugin.Instance?.Broadcast("camtools.changed", null);
        }

        /// <summary>A shot's frame guide (its picture shape) — the app hears about it to update its panel.</summary>
        internal static void SetAspect(float aspect)
        {
            if (Instance == null || Mathf.Abs(Instance._aspect - aspect) < 1e-4f) return;
            Instance._aspect = Mathf.Max(0f, aspect);
            StudioBridgePlugin.Instance?.Broadcast("camtools.changed", null);
        }

        private const string RealPovGuid = "keelhauled.realpov";
        private const string LockOnGuid = "keelhauled.lockonplugin";

        // first-person
        private bool _pov, _povUseTheirs = true, _hideHead = true;
        private int _povId = -1;
        private float _povFov = 70f;
        private string _povProvider = "";
        private bool _prevHeadVisible;
        private float _prevNear = -1, _prevFov = -1;

        // follow
        private bool _follow, _followUseTheirs = true;
        private int _followId = -1;
        private string _followBone = "head", _followProvider = "";
        private float _followSpeed = 8f;

        // guides
        private bool _thirds, _center, _safe, _golden, _diagonals;
        private int _spiral = -1; // golden spiral: -1 off, 0-3 which corner it winds into
        private float _aspect; // 0 = no frame
        private float _dim = 0.6f;
        // the guide lines' colour; alpha = how strongly they show
        private Color _lineColor = new Color(1, 1, 1, 0.5f);

        private static readonly Dictionary<string, string[]> Bones = new Dictionary<string, string[]>
        {
            { "head", new[] { "cf_j_head" } },
            { "eyes", new[] { "cf_J_Eye_tz", "cf_j_head" } },
            { "chest", new[] { "cf_j_spine03", "cf_j_spine02" } },
            { "hips", new[] { "cf_j_hips" } },
            { "handL", new[] { "cf_j_hand_L" } },
            { "handR", new[] { "cf_j_hand_R" } },
            { "feet", new[] { "cf_j_foot_L" } },
        };

        private void Awake()
        {
            Instance = this;
            Camera.onPreCull += PreCull;
        }

        private void OnDestroy() => Camera.onPreCull -= PreCull;

        public static void Register(CommandRouter r)
        {
            r.Add("camtools.get", a => Instance.State());
            r.Add("camtools.set", a => Instance.Set(a));
        }

        private static bool RealPovInstalled => Chainloader.PluginInfos.ContainsKey(RealPovGuid);
        private static bool LockOnInstalled => Chainloader.PluginInfos.ContainsKey(LockOnGuid);

        private Dictionary<string, object> State() => new Dictionary<string, object>
        {
            { "pov", new Dictionary<string, object> { { "on", _pov }, { "id", _povId }, { "fov", (double)_povFov }, { "hideHead", _hideHead }, { "useTheirs", _povUseTheirs }, { "provider", _pov ? _povProvider : (RealPovInstalled && _povUseTheirs ? "RealPOV" : "Keyframe Studio") }, { "theirsInstalled", RealPovInstalled } } },
            { "follow", new Dictionary<string, object> { { "on", _follow }, { "id", _followId }, { "bone", _followBone }, { "speed", (double)_followSpeed }, { "useTheirs", _followUseTheirs }, { "provider", _follow ? _followProvider : (LockOnInstalled && _followUseTheirs ? "LockOnPlugin" : "Keyframe Studio") }, { "theirsInstalled", LockOnInstalled }, { "bones", Bones.Keys.Cast<object>().ToList() } } },
            // for checks: how far the camera is from the eyes (first person) / the view's centre from the followed part
            { "povDistance", _pov && _povProvider == "Keyframe Studio" && _eyes != null && Camera.main != null ? (double)Vector3.Distance(Camera.main.transform.position, _eyes.position) : -1d },
            { "followDistance", _follow && _target != null && Singleton<Studio.Studio>.Instance?.cameraCtrl != null ? (double)Vector3.Distance(Singleton<Studio.Studio>.Instance.cameraCtrl.targetPos, _target.position) : -1d },
            { "guides", new Dictionary<string, object> { { "thirds", _thirds }, { "center", _center }, { "safe", _safe }, { "golden", _golden }, { "diagonals", _diagonals }, { "spiral", _spiral }, { "aspect", (double)_aspect }, { "dim", (double)_dim },
                { "color", new List<object> { (double)_lineColor.r, (double)_lineColor.g, (double)_lineColor.b, (double)_lineColor.a } } } },
        };

        private object Set(Dictionary<string, object> a)
        {
            if (a.ContainsKey("pov") && a["pov"] is Dictionary<string, object> p)
            {
                if (p.Has("fov")) _povFov = Mathf.Clamp(p.GetFloat("fov"), 20, 120);
                if (p.Has("hideHead")) _hideHead = p.GetBool("hideHead", true);
                if (p.Has("useTheirs")) { if (_pov) PovOff(); _povUseTheirs = p.GetBool("useTheirs", true); }
                if (p.Has("on"))
                {
                    bool on = p.GetBool("on");
                    if (on) PovOn(p.Has("id") ? p.GetInt("id") : _povId);
                    else PovOff();
                }
                else if (_pov && p.Has("id") && p.GetInt("id") != _povId) PovOn(p.GetInt("id"));
                else if (_pov && p.Has("hideHead") && _povProvider == "Keyframe Studio") ApplyHead(true);
            }
            if (a.ContainsKey("follow") && a["follow"] is Dictionary<string, object> f)
            {
                if (f.Has("speed")) _followSpeed = Mathf.Clamp(f.GetFloat("speed"), 0.5f, 30f);
                if (f.Has("useTheirs")) { if (_follow) FollowOff(); _followUseTheirs = f.GetBool("useTheirs", true); }
                if (f.Has("bone"))
                {
                    var b = f.GetString("bone");
                    if (!Bones.ContainsKey(b)) throw new BridgeException("Unknown body part: " + b);
                    _followBone = b;
                }
                if (f.Has("on"))
                {
                    if (f.GetBool("on")) FollowOn(f.Has("id") ? f.GetInt("id") : _followId);
                    else FollowOff();
                }
                else if (_follow && (f.Has("bone") || f.Has("id"))) FollowOn(f.Has("id") ? f.GetInt("id") : _followId); // re-target
            }
            if (a.ContainsKey("guides") && a["guides"] is Dictionary<string, object> g)
            {
                if (g.Has("thirds")) _thirds = g.GetBool("thirds");
                if (g.Has("center")) _center = g.GetBool("center");
                if (g.Has("safe")) _safe = g.GetBool("safe");
                if (g.Has("golden")) _golden = g.GetBool("golden");
                if (g.Has("diagonals")) _diagonals = g.GetBool("diagonals");
                if (g.Has("spiral")) _spiral = Mathf.Clamp(g.GetInt("spiral", -1), -1, 3);
                if (g.Has("aspect")) _aspect = Mathf.Max(0, g.GetFloat("aspect"));
                if (g.Has("dim")) _dim = Mathf.Clamp01(g.GetFloat("dim"));
                if (g.ContainsKey("color") && g["color"] is List<object> c && c.Count >= 3)
                {
                    float C(int i, float def) => i < c.Count ? Mathf.Clamp01(Convert.ToSingle(c[i])) : def;
                    _lineColor = new Color(C(0, 1), C(1, 1), C(2, 1), C(3, _lineColor.a));
                }
            }
            return State();
        }

        private static OCIChar Chara(int id) =>
            SceneApi.FindOci(id) as OCIChar ?? throw new BridgeException("Pick a character");

        private static Transform Bone(OCIChar c, string part)
        {
            var all = c.charInfo.GetComponentsInChildren<Transform>(true);
            foreach (var n in Bones[part])
            {
                var t = all.FirstOrDefault(x => x.name == n);
                if (t != null) return t;
            }
            return c.charInfo.objHeadBone != null ? c.charInfo.objHeadBone.transform : c.charInfo.transform;
        }

        // ------------------------------------------------------------------ first-person

        private Transform _eyes, _head;
        private OCIChar _povChara;

        private void PovOn(int id)
        {
            var c = Chara(id);
            if (_pov) PovOff();
            if (_follow) FollowOff(); // the two fight over the camera
            _povId = id;
            _povChara = c;
            if (_povUseTheirs && RealPovInstalled && RealPov(true, c)) _povProvider = "RealPOV";
            else
            {
                _povProvider = "Keyframe Studio";
                _head = c.charInfo.objHeadBone != null ? c.charInfo.objHeadBone.transform : Bone(c, "head");
                _eyes = Bone(c, "eyes");
                var cam = Camera.main;
                if (cam != null) { _prevNear = cam.nearClipPlane; _prevFov = cam.fieldOfView; }
                ApplyHead(true);
            }
            _pov = true;
        }

        private void PovOff()
        {
            if (!_pov) return;
            if (_povProvider == "RealPOV") RealPov(false, _povChara);
            else
            {
                ApplyHead(false);
                var cam = Camera.main;
                if (cam != null && _prevNear > 0) { cam.nearClipPlane = _prevNear; cam.fieldOfView = _prevFov; }
                _prevNear = -1;
                // Studio's own camera puts itself back from its saved view on the next frame
            }
            _pov = false;
            _povChara = null;
        }

        private void ApplyHead(bool pov)
        {
            if (_povChara?.charInfo == null) return;
            var fs = _povChara.charInfo.fileStatus;
            if (pov)
            {
                if (!_headHidden) _prevHeadVisible = fs.visibleHeadAlways;
                fs.visibleHeadAlways = !_hideHead && _prevHeadVisible;
                _headHidden = true;
            }
            else if (_headHidden)
            {
                fs.visibleHeadAlways = _prevHeadVisible;
                _headHidden = false;
            }
        }
        private bool _headHidden;

        /// <summary>Drive RealPOV: it takes Studio's selected character; select ours for the moment.</summary>
        private static bool RealPov(bool on, OCIChar c)
        {
            try
            {
                var inst = Chainloader.PluginInfos[RealPovGuid].Instance;
                var core = inst.GetType();
                bool enabled = (bool)AccessTools.Field(core, "POVEnabled").GetValue(null);
                if (enabled == on) return true;
                if (on && c != null) Singleton<Studio.Studio>.Instance.treeNodeCtrl.SelectSingle(c.treeNodeObject, false); // (true would toggle it off when already selected)
                AccessTools.Method(core, on ? "EnablePov" : "DisablePov").Invoke(inst, null);
                return (bool)AccessTools.Field(core, "POVEnabled").GetValue(null) == on;
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("RealPOV: " + (e.InnerException ?? e).Message);
                return false;
            }
        }

        /// <summary>Right before Studio's camera renders: put it at the character's eyes, looking where the head looks.</summary>
        private void PreCull(Camera cam)
        {
            if (cam == Camera.main) FollowStep();
            if (!_pov || _povProvider != "Keyframe Studio" || cam != Camera.main) return;
            if (_povChara?.charInfo == null || _head == null) { PovOff(); return; }
            var rot = _head.rotation;
            cam.transform.rotation = rot;
            cam.transform.position = (_eyes != null ? _eyes.position : _head.position) + rot * Vector3.forward * 0.03f;
            cam.nearClipPlane = 0.01f;
            cam.fieldOfView = _povFov;
        }

        // ------------------------------------------------------------------ follow

        private Transform _target;

        private void FollowOn(int id)
        {
            var c = Chara(id);
            if (_follow) FollowOff();
            if (_pov) PovOff();
            _followId = id;
            _target = Bone(c, _followBone);
            if (_followUseTheirs && LockOnInstalled && LockOn(_target.gameObject)) _followProvider = "LockOnPlugin";
            else _followProvider = "Keyframe Studio";
            _follow = true;
        }

        private void FollowOff()
        {
            if (!_follow) return;
            if (_followProvider == "LockOnPlugin") LockOn(null);
            _follow = false;
            _target = null;
        }

        private static bool LockOn(GameObject target)
        {
            try
            {
                var type = AccessTools.TypeByName("LockOnPlugin.Koikatu.StudioMono");
                var mono = type != null ? FindObjectOfType(type) : null;
                if (mono == null) return false;
                if (target != null) return (bool)AccessTools.Method(type, "LockOn", new[] { typeof(GameObject), typeof(bool) }).Invoke(mono, new object[] { target, true });
                AccessTools.Method(type, "LockOnRelease").Invoke(mono, null);
                return true;
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("LockOnPlugin: " + (e.InnerException ?? e).Message);
                return false;
            }
        }

        /// <summary>
        /// Read the body part right before the camera renders (after FK / IK / animation have posed it this frame)
        /// and move Studio's view centre towards it; Studio places the camera from that next frame.
        /// </summary>
        private void FollowStep()
        {
            if (!_follow || _followProvider != "Keyframe Studio") return;
            if (_target == null) { FollowOff(); return; }
            var ctrl = Singleton<Studio.Studio>.Instance?.cameraCtrl;
            if (ctrl == null) return;
            float k = 1 - Mathf.Exp(-_followSpeed * Time.unscaledDeltaTime);
            ctrl.targetPos = Vector3.Lerp(ctrl.targetPos, _target.position, k);
        }

        /// <summary>Scene changes: let go of characters that are gone.</summary>
        public void Clear()
        {
            PovOff();
            FollowOff();
        }

        /// <summary>From the plugin's Update: with nobody connected, give Studio its camera back and drop the guides.</summary>
        public void Tick(int clients)
        {
            if (clients > 0) return;
            if (_pov || _follow) Clear();
            _thirds = _center = _safe = _golden = _diagonals = false;
            _spiral = -1;
            _aspect = 0;
        }

        // The hidden head is a ChaFile setting, which Studio saves with the character: show it while saving.
        public void BeforeSave() { if (_pov && _povProvider == "Keyframe Studio") ApplyHead(false); }
        public void AfterSave() { if (_pov && _povProvider == "Keyframe Studio") ApplyHead(true); }

        // ------------------------------------------------------------------ guides

        private void OnGUI()
        {
            if (Event.current.type != EventType.Repaint) return;
            if (!_thirds && !_center && !_safe && !_golden && !_diagonals && _spiral < 0 && _aspect <= 0) return;
            if (RenderApi.Busy()) return;
            float sw = Screen.width, sh = Screen.height;
            var frame = new Rect(0, 0, sw, sh);
            if (_aspect > 0)
            {
                float a = sw / sh;
                if (_aspect > a) { float h = sw / _aspect; frame = new Rect(0, (sh - h) / 2, sw, h); }
                else { float w = sh * _aspect; frame = new Rect((sw - w) / 2, 0, w, sh); }
                var dim = new Color(0, 0, 0, _dim);
                Fill(new Rect(0, 0, sw, frame.yMin), dim);
                Fill(new Rect(0, frame.yMax, sw, sh - frame.yMax), dim);
                Fill(new Rect(0, frame.yMin, frame.xMin, frame.height), dim);
                Fill(new Rect(frame.xMax, frame.yMin, sw - frame.xMax, frame.height), dim);
                Outline(frame, Tone(1.1f));
            }
            var line = Tone(0.9f);
            if (_thirds)
                for (int i = 1; i <= 2; i++)
                {
                    Fill(new Rect(frame.xMin + frame.width * i / 3f, frame.yMin, 1, frame.height), line);
                    Fill(new Rect(frame.xMin, frame.yMin + frame.height * i / 3f, frame.width, 1), line);
                }
            if (_center)
            {
                var c = frame.center;
                Fill(new Rect(c.x - 12, c.y, 25, 1), line);
                Fill(new Rect(c.x, c.y - 12, 1, 25), line);
            }
            if (_safe)
            {
                Outline(Inset(frame, 0.05f), Tone(0.9f)); // action safe (90%)
                Outline(Inset(frame, 0.1f), Tone(0.55f)); // title safe (80%): fainter
            }
            if (_golden)
                foreach (var k in new[] { 0.382f, 0.618f })
                {
                    Fill(new Rect(frame.xMin + frame.width * k, frame.yMin, 1, frame.height), Tone(0.75f));
                    Fill(new Rect(frame.xMin, frame.yMin + frame.height * k, frame.width, 1), Tone(0.75f));
                }
            if (_diagonals || _spiral >= 0) DrawCurves(frame, sh);
        }

        // ---- diagonals and the golden spiral (GL lines; GUI rects can only draw straight across) ----
        private Material _glMat;

        private void DrawCurves(Rect guiFrame, float sh)
        {
            if (_glMat == null)
            {
                _glMat = new Material(Shader.Find("Hidden/Internal-Colored")) { hideFlags = HideFlags.HideAndDontSave };
                _glMat.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
                _glMat.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                _glMat.SetInt("_Cull", 0);
                _glMat.SetInt("_ZWrite", 0);
                _glMat.SetInt("_ZTest", (int)UnityEngine.Rendering.CompareFunction.Always);
            }
            // GL counts y from the bottom
            var f = new Rect(guiFrame.xMin, sh - guiFrame.yMax, guiFrame.width, guiFrame.height);
            _glMat.SetPass(0);
            GL.PushMatrix();
            GL.LoadPixelMatrix(0, Screen.width, 0, sh);
            GL.Begin(GL.LINES);
            if (_diagonals)
            {
                GL.Color(Tone(0.7f));
                Vector2 bl = new Vector2(f.xMin, f.yMin), br = new Vector2(f.xMax, f.yMin), tl = new Vector2(f.xMin, f.yMax), tr = new Vector2(f.xMax, f.yMax);
                Seg(bl, tr);
                Seg(tl, br);
                // from the other corners, square onto each diagonal (the "reciprocal" lines)
                Seg(tl, Foot(tl, bl, tr));
                Seg(br, Foot(br, bl, tr));
                Seg(bl, Foot(bl, tl, br));
                Seg(tr, Foot(tr, tl, br));
            }
            if (_spiral >= 0)
            {
                GL.Color(Tone(0.9f));
                Spiral(f);
            }
            GL.End();
            GL.PopMatrix();
        }

        private static void Seg(Vector2 a, Vector2 b)
        {
            GL.Vertex3(a.x, a.y, 0);
            GL.Vertex3(b.x, b.y, 0);
        }

        /// <summary>The foot of the perpendicular from p onto the line a–b.</summary>
        private static Vector2 Foot(Vector2 p, Vector2 a, Vector2 b)
        {
            var ab = b - a;
            return a + ab * (Vector2.Dot(p - a, ab) / ab.sqrMagnitude);
        }

        /// <summary>
        /// A golden spiral fitted to the frame: quarter circles in ever smaller squares of a golden rectangle, stretched
        /// to the frame's shape. The setting picks the corner it winds into.
        /// </summary>
        private void Spiral(Rect f)
        {
            const float phi = 1.618034f;
            float x = 0, y = 0, w = phi, h = 1;
            bool portrait = f.height > f.width;
            bool flipX = (_spiral & 1) != 0, flipY = (_spiral & 2) != 0;
            Vector2 Map(float px, float py)
            {
                float u = px / phi, v = py;
                if (flipX) u = 1 - u;
                if (flipY) v = 1 - v;
                return portrait ? new Vector2(f.xMin + v * f.width, f.yMin + u * f.height) : new Vector2(f.xMin + u * f.width, f.yMin + v * f.height);
            }
            for (int i = 0; i < 12; i++)
            {
                float s, cx, cy, a0;
                switch (i % 4)
                {
                    case 0: s = h; cx = x + s; cy = y; a0 = 180; x += s; w -= s; break; // square on the left
                    case 1: s = w; cx = x; cy = y + h - s; a0 = 90; h -= s; break; // on top
                    case 2: s = h; cx = x + w - s; cy = y + h; a0 = 0; w -= s; break; // on the right
                    default: s = w; cx = x + w; cy = y + s; a0 = -90; y += s; h -= s; break; // at the bottom
                }
                Vector2 prev = default;
                for (int k = 0; k <= 16; k++)
                {
                    float ang = (a0 - 90f * k / 16f) * Mathf.Deg2Rad;
                    var p = Map(cx + Mathf.Cos(ang) * s, cy + Mathf.Sin(ang) * s);
                    if (k > 0) Seg(prev, p);
                    prev = p;
                }
            }
        }

        /// <summary>The guide colour at a share of its strength.</summary>
        private Color Tone(float k) => new Color(_lineColor.r, _lineColor.g, _lineColor.b, Mathf.Clamp01(_lineColor.a * k));

        private static Rect Inset(Rect r, float f) => new Rect(r.xMin + r.width * f, r.yMin + r.height * f, r.width * (1 - 2 * f), r.height * (1 - 2 * f));

        private static void Fill(Rect r, Color c)
        {
            if (r.width <= 0 || r.height <= 0) return;
            var prev = GUI.color;
            GUI.color = c;
            GUI.DrawTexture(r, Texture2D.whiteTexture);
            GUI.color = prev;
        }

        private static void Outline(Rect r, Color c)
        {
            Fill(new Rect(r.xMin, r.yMin, r.width, 1), c);
            Fill(new Rect(r.xMin, r.yMax - 1, r.width, 1), c);
            Fill(new Rect(r.xMin, r.yMin, 1, r.height), c);
            Fill(new Rect(r.xMax - 1, r.yMin, 1, r.height), c);
        }
    }
}
