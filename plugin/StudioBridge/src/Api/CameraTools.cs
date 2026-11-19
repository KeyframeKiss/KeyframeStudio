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
        private bool _thirds, _center, _safe;
        private float _aspect; // 0 = no frame
        private float _dim = 0.6f;

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
            { "guides", new Dictionary<string, object> { { "thirds", _thirds }, { "center", _center }, { "safe", _safe }, { "aspect", (double)_aspect }, { "dim", (double)_dim } } },
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
                if (g.Has("aspect")) _aspect = Mathf.Max(0, g.GetFloat("aspect"));
                if (g.Has("dim")) _dim = Mathf.Clamp01(g.GetFloat("dim"));
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
            _thirds = _center = _safe = false;
            _aspect = 0;
        }

        // The hidden head is a ChaFile setting, which Studio saves with the character: show it while saving.
        public void BeforeSave() { if (_pov && _povProvider == "Keyframe Studio") ApplyHead(false); }
        public void AfterSave() { if (_pov && _povProvider == "Keyframe Studio") ApplyHead(true); }

        // ------------------------------------------------------------------ guides

        private void OnGUI()
        {
            if (Event.current.type != EventType.Repaint) return;
            if (!_thirds && !_center && !_safe && _aspect <= 0) return;
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
                Outline(frame, new Color(1, 1, 1, 0.5f));
            }
            var line = new Color(1, 1, 1, 0.45f);
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
                Outline(Inset(frame, 0.05f), new Color(1, 0.8f, 0.3f, 0.5f)); // action safe (90%)
                Outline(Inset(frame, 0.1f), new Color(1, 0.8f, 0.3f, 0.3f)); // title safe (80%)
            }
        }

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
