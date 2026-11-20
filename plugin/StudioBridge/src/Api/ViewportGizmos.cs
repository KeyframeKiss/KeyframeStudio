using System;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using UnityEngine.EventSystems;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Overlays and handles drawn in Studio's own viewport (no second render, no lag):
    ///  - skeleton of the selected characters (FK-posed parts tinted), IK targets as diamonds, a highlight on what's
    ///    selected, lights (direction, cone, reach) and scene cameras (view frame);
    ///  - handles: rotation rings on a bone (its own axes + a view ring), move / rotate / scale for objects and IK
    ///    targets following Studio's own Move / Rotate / Scale mode; Ctrl snaps, Shift is fine control;
    ///  - click to select in the viewport (joints, IK targets, lights, cameras, items), with filters.
    /// Everything is drawn only on the live screen — never into renders, stills or videos. While a handle is dragged
    /// Studio's camera holds still. Each drag is one undo step; auto-key / "unkeyed changes" see it like any Studio edit.
    /// </summary>
    internal sealed class ViewportGizmos : MonoBehaviour
    {
        public static ViewportGizmos Instance;

        // ---------------- settings (from the app) ----------------
        private bool _show, _skeleton = true, _ik = true, _highlight = true, _lights = true, _cameras = true, _gizmo, _allChars, _labels = true;
        private bool _pickChars = true, _pickItems = true, _pickLights = true, _pickCameras = true;
        private bool _world; // object handles along the world's axes (else the object's own)
        private float _snapMove = 0.05f, _snapRot = 15f, _snapScale = 0.1f;
        private bool Any => _gizmo || _show && (_skeleton || _ik || _highlight || _lights || _cameras);

        // ---------------- what the handles act on ----------------
        private enum Kind { None, Bone, IK, Object }
        private Kind _kind;
        private int _ociId = -1, _index = -1;

        private enum H { None, AxisX, AxisY, AxisZ, Free, RingX, RingY, RingZ, RingView, ScaleX, ScaleY, ScaleZ, ScaleAll }
        private H _hover, _drag;
        private string _hoverPick; // "joint:<oci>:<index>" etc., for a hover highlight

        // ---------------- a drag ----------------
        private Vector2 _m0, _mPrev, _downAt;
        private bool _down, _moved;
        private float _angle; // accumulated ring angle (degrees, screen)
        private Vector3 _startWorldPos, _startScale, _dragAxis, _grabOffset;
        private Quaternion _startWorldRot;
        private GuideObject _dragGuide;
        private IUndoEntry _undo;
        private Studio.CameraControl.NoCtrlFunc _cameraWas;
        private bool _hidAxis;

        // ---------------- test input (gizmo.simulate) ----------------
        private Vector2? _simMouse;
        private bool _simDown, _simHeld, _simUp;

        private Material _mat;
        private static readonly Color X = new Color(0.94f, 0.33f, 0.36f), Y = new Color(0.45f, 0.85f, 0.35f), Z = new Color(0.33f, 0.6f, 1f);
        private static readonly Color Accent = new Color(1f, 0.62f, 0.18f), Ice = new Color(0.55f, 0.78f, 1f), Bone = new Color(0.92f, 0.93f, 0.96f);

        private void Awake() => Instance = this;

        private void OnDestroy()
        {
            HoldCamera(false);
            if (_hidAxis) StudioUiApi.SetAxis(true);
        }

        public static void Register(CommandRouter r)
        {
            r.Add("gizmo.get", a => Instance.State());
            r.Add("gizmo.set", a => Instance.Set(a));
            // pick a target from the app: {kind: bone|ik|object|none, id, index}
            r.Add("gizmo.target", a =>
            {
                var k = a.GetString("kind") ?? "none";
                Instance._kind = k == "bone" ? Kind.Bone : k == "ik" ? Kind.IK : k == "object" ? Kind.Object : Kind.None;
                Instance._ociId = a.GetInt("id", -1);
                Instance._index = a.GetInt("index", -1);
                return Instance.State();
            });
            // type values for the handles' target: {pos?, rot?, scale?} — one undo step, FK / IK taken over like a drag
            r.Add("gizmo.value", a => Instance.Value(a));
            // tests: feed the mouse — {at:[x,y] (screen pixels, bottom-left origin), press, release}; or {project:[x,y,z]}
            r.Add("gizmo.simulate", a => Instance.Simulate(a));
        }

        // ================================================================== state

        private Dictionary<string, object> State()
        {
            var t = TargetInfo();
            return new Dictionary<string, object>
            {
                { "overlays", new Dictionary<string, object> { { "on", _show }, { "skeleton", _skeleton }, { "ik", _ik }, { "highlight", _highlight }, { "lights", _lights }, { "cameras", _cameras }, { "allCharacters", _allChars }, { "labels", _labels } } },
                { "gizmo", new Dictionary<string, object> { { "on", _gizmo }, { "world", _world }, { "snapMove", (double)_snapMove }, { "snapRot", (double)_snapRot }, { "snapScale", (double)_snapScale }, { "mode", StudioMode() } } },
                { "pick", new Dictionary<string, object> { { "characters", _pickChars }, { "items", _pickItems }, { "lights", _pickLights }, { "cameras", _pickCameras } } },
                { "target", t },
                { "dragging", _drag != H.None },
            };
        }

        private object Set(Dictionary<string, object> a)
        {
            if (a.GetObject("overlays") is Dictionary<string, object> o)
            {
                if (o.Has("on")) _show = o.GetBool("on");
                if (o.Has("skeleton")) _skeleton = o.GetBool("skeleton");
                if (o.Has("ik")) _ik = o.GetBool("ik");
                if (o.Has("highlight")) _highlight = o.GetBool("highlight");
                if (o.Has("lights")) _lights = o.GetBool("lights");
                if (o.Has("cameras")) _cameras = o.GetBool("cameras");
                if (o.Has("allCharacters")) _allChars = o.GetBool("allCharacters");
                if (o.Has("labels")) _labels = o.GetBool("labels", true);
            }
            if (a.GetObject("gizmo") is Dictionary<string, object> g)
            {
                if (g.Has("on")) _gizmo = g.GetBool("on");
                if (g.Has("world")) _world = g.GetBool("world");
                if (g.Has("snapMove")) _snapMove = Mathf.Clamp(g.GetFloat("snapMove"), 0.001f, 10f);
                if (g.Has("snapRot")) _snapRot = Mathf.Clamp(g.GetFloat("snapRot"), 1f, 90f);
                if (g.Has("snapScale")) _snapScale = Mathf.Clamp(g.GetFloat("snapScale"), 0.01f, 1f);
                if (g.Has("mode")) SetStudioMode(g.GetInt("mode"));
            }
            if (a.GetObject("pick") is Dictionary<string, object> p)
            {
                if (p.Has("characters")) _pickChars = p.GetBool("characters", true);
                if (p.Has("items")) _pickItems = p.GetBool("items", true);
                if (p.Has("lights")) _pickLights = p.GetBool("lights", true);
                if (p.Has("cameras")) _pickCameras = p.GetBool("cameras", true);
            }
            SyncStudioHandles();
            return State();
        }

        /// <summary>Our handles replace Studio's while they're on (two sets fight); Studio's come back after.</summary>
        private void SyncStudioHandles()
        {
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) return;
            if (_gizmo && studio.workInfo.visibleAxis) { StudioUiApi.SetAxis(false); _hidAxis = true; }
            else if (!_gizmo && _hidAxis) { StudioUiApi.SetAxis(true); _hidAxis = false; }
        }

        /// <summary>Studio's Move / Rotate / Scale mode (its toolbar and keys): 0, 1, 2.</summary>
        private static int StudioMode() => Singleton<GuideObjectManager>.Instance != null ? Singleton<GuideObjectManager>.Instance.mode : 0;
        private static void SetStudioMode(int m)
        {
            var gm = Singleton<GuideObjectManager>.Instance;
            if (gm != null && m >= 0 && m <= 2) gm.mode = m;
        }

        private object TargetInfo()
        {
            var g = TargetGuide(out var oci, out string label);
            if (g == null) return null;
            return new Dictionary<string, object>
            {
                { "kind", _kind.ToString().ToLowerInvariant() }, { "id", _ociId }, { "index", _index }, { "label", label },
                { "pos", V(g.changeAmount.pos) }, { "rot", V(g.changeAmount.rot) }, { "scale", V(g.changeAmount.scale) },
                { "canMove", _kind != Kind.Bone && g.enablePos }, { "canRotate", g.enableRot }, { "canScale", _kind == Kind.Object && g.enableScale },
            };
        }

        private object Value(Dictionary<string, object> a)
        {
            var g = TargetGuide(out var oci, out _);
            if (g == null) throw new Exception("Nothing has the handles — click a joint, IK target or object first");
            if (_kind == Kind.Bone && oci is OCIChar cb) EnsureFk(cb, _index);
            if (_kind == Kind.IK && oci is OCIChar ci) EnsureIk(ci, _index);
            Vector3? Read(string k)
            {
                var l = a.GetList(k);
                if (l.Count < 3) return null;
                return new Vector3(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]));
            }
            UndoStack.Push(new GuideUndo(new[] { g }));
            var pos = Read("pos");
            var rot = Read("rot");
            var scale = Read("scale");
            if (pos.HasValue && g.enablePos) g.changeAmount.pos = pos.Value;
            if (rot.HasValue && g.enableRot) g.changeAmount.rot = rot.Value;
            if (scale.HasValue && g.enableScale) g.changeAmount.scale = new Vector3(Mathf.Max(0.01f, scale.Value.x), Mathf.Max(0.01f, scale.Value.y), Mathf.Max(0.01f, scale.Value.z));
            return TargetInfo();
        }

        private static List<object> V(Vector3 v) => new List<object> { (double)v.x, (double)v.y, (double)v.z };

        // ================================================================== targets

        private GuideObject TargetGuide(out ObjectCtrlInfo oci, out string label)
        {
            label = null;
            oci = _ociId >= 0 ? SceneApi.FindOci(_ociId) : null;
            if (oci == null) return null;
            switch (_kind)
            {
                case Kind.Bone:
                    if (oci is OCIChar cb && _index >= 0 && _index < cb.listBones.Count)
                    {
                        var b = cb.listBones[_index];
                        label = b.guideObject?.transformTarget != null ? Pretty(b.guideObject.transformTarget.name) : "bone";
                        return b.guideObject;
                    }
                    return null;
                case Kind.IK:
                    if (oci is OCIChar ci && _index >= 0 && _index < ci.listIKTarget.Count)
                    {
                        var ik = ci.listIKTarget[_index];
                        label = ik.targetObject != null ? Pretty(ik.targetObject.name) : "IK target";
                        return ik.guideObject;
                    }
                    return null;
                case Kind.Object:
                    label = oci.treeNodeObject != null ? oci.treeNodeObject.textName : "object";
                    return oci.guideObject;
            }
            return null;
        }

        /// <summary>"cf_j_forearm01_L" → "Forearm L"; "f_t_hand_R" (an IK target) → "Hand R".</summary>
        private static string Pretty(string n)
        {
            if (string.IsNullOrEmpty(n)) return n;
            var s = System.Text.RegularExpressions.Regex.Replace(n, @"^(cf|f|cm)_[a-z]{1,2}_", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            s = System.Text.RegularExpressions.Regex.Replace(s, @"0\d", "");
            s = s.Replace('_', ' ').Trim();
            return s.Length > 0 ? char.ToUpper(s[0]) + s.Substring(1) : n;
        }

        // ================================================================== characters

        /// <summary>The skeleton drawn: (parent, child) bone names.</summary>
        private static readonly string[][] Chains =
        {
            new[] { "cf_j_hips", "cf_j_spine01", "cf_j_spine02", "cf_j_spine03", "cf_j_neck", "cf_j_head" },
            new[] { "cf_j_spine03", "cf_j_shoulder_L", "cf_j_arm00_L", "cf_j_forearm01_L", "cf_j_hand_L" },
            new[] { "cf_j_spine03", "cf_j_shoulder_R", "cf_j_arm00_R", "cf_j_forearm01_R", "cf_j_hand_R" },
            new[] { "cf_j_hips", "cf_j_waist01", "cf_j_waist02" },
            new[] { "cf_j_waist02", "cf_j_thigh00_L", "cf_j_leg01_L", "cf_j_foot_L", "cf_j_toes_L" },
            new[] { "cf_j_waist02", "cf_j_thigh00_R", "cf_j_leg01_R", "cf_j_foot_R", "cf_j_toes_R" },
            new[] { "cf_j_hand_L", "cf_j_thumb01_L", "cf_j_thumb02_L", "cf_j_thumb03_L" },
            new[] { "cf_j_hand_L", "cf_j_index01_L", "cf_j_index02_L", "cf_j_index03_L" },
            new[] { "cf_j_hand_L", "cf_j_middle01_L", "cf_j_middle02_L", "cf_j_middle03_L" },
            new[] { "cf_j_hand_L", "cf_j_ring01_L", "cf_j_ring02_L", "cf_j_ring03_L" },
            new[] { "cf_j_hand_L", "cf_j_little01_L", "cf_j_little02_L", "cf_j_little03_L" },
            new[] { "cf_j_hand_R", "cf_j_thumb01_R", "cf_j_thumb02_R", "cf_j_thumb03_R" },
            new[] { "cf_j_hand_R", "cf_j_index01_R", "cf_j_index02_R", "cf_j_index03_R" },
            new[] { "cf_j_hand_R", "cf_j_middle01_R", "cf_j_middle02_R", "cf_j_middle03_R" },
            new[] { "cf_j_hand_R", "cf_j_ring01_R", "cf_j_ring02_R", "cf_j_ring03_R" },
            new[] { "cf_j_hand_R", "cf_j_little01_R", "cf_j_little02_R", "cf_j_little03_R" },
        };

        private sealed class Rig
        {
            public OCIChar Chara;
            public Dictionary<string, Transform> Bones = new Dictionary<string, Transform>();
            public Dictionary<Transform, int> FkIndex = new Dictionary<Transform, int>(); // bone → index in listBones
        }
        private readonly Dictionary<OCIChar, Rig> _rigs = new Dictionary<OCIChar, Rig>();

        private Rig RigOf(OCIChar c)
        {
            if (c?.charInfo == null) return null;
            if (_rigs.TryGetValue(c, out var r) && r.Bones.Count > 0 && r.Bones.Values.All(t => t != null)) return r;
            r = new Rig { Chara = c };
            var want = new HashSet<string>(Chains.SelectMany(x => x));
            foreach (var t in c.charInfo.GetComponentsInChildren<Transform>(true))
                if (want.Contains(t.name) && !r.Bones.ContainsKey(t.name)) r.Bones[t.name] = t;
            for (int i = 0; i < c.listBones.Count; i++)
            {
                var tt = c.listBones[i]?.guideObject?.transformTarget;
                if (tt != null && !r.FkIndex.ContainsKey(tt)) r.FkIndex[tt] = i;
            }
            _rigs[c] = r;
            return r;
        }

        private IEnumerable<OCIChar> Shown()
        {
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) yield break;
            if (_allChars)
            {
                foreach (var oci in studio.dicObjectCtrl.Values) if (oci is OCIChar c && c.charInfo != null && c.charInfo.visibleAll) yield return c;
                yield break;
            }
            foreach (var id in SceneApi.SelectedIds())
                if (SceneApi.FindOci(Convert.ToInt32(id)) is OCIChar c && c.charInfo != null) yield return c;
            // the character whose bone / IK target has the handles stays shown
            if ((_kind == Kind.Bone || _kind == Kind.IK) && SceneApi.FindOci(_ociId) is OCIChar t && t.charInfo != null && !SceneApi.SelectedIds().Contains(_ociId)) yield return t;
        }

        private static int FkPart(OCIChar c, OIBoneInfo.BoneGroup g)
        {
            for (int i = 0; i < FKCtrl.parts.Length; i++) if ((FKCtrl.parts[i] & g) != 0) return i;
            return -1;
        }
        private static bool FkOn(OCIChar c, int part) => c.oiCharInfo.enableFK && part >= 0 && part < c.oiCharInfo.activeFK.Length && c.oiCharInfo.activeFK[part];
        private static int IkPart(OIBoneInfo.BoneGroup g)
        {
            for (int i = 0; i < 5; i++) if (((OIBoneInfo.BoneGroup)(1 << i) & g) != 0) return i;
            return -1;
        }
        private static bool IkOn(OCIChar c, int part) => c.oiCharInfo.enableIK && part >= 0 && part < c.oiCharInfo.activeIK.Length && c.oiCharInfo.activeIK[part];

        /// <summary>Before a bone is turned by hand: its part goes to FK, taking over the pose it has now (no jump).</summary>
        private static void EnsureFk(OCIChar c, int boneIndex)
        {
            var b = c.listBones[boneIndex];
            int part = FkPart(c, b.boneGroup);
            if (part < 0) return;
            // a limb IK drives would ignore its FK turn: hand that limb to FK, keeping where IK put it
            var handOver = new List<OIBoneInfo.BoneGroup>();
            for (int i = 1; i < 5; i++)
            {
                var bit = (OIBoneInfo.BoneGroup)(1 << i);
                if ((b.boneGroup & bit) != 0 && IkOn(c, i)) handOver.Add(bit);
            }
            if (FkOn(c, part) && handOver.Count == 0) return;
            c.fkCtrl.CopyBone(FKCtrl.parts[part]);
            if (!c.oiCharInfo.enableFK) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, true, false);
            if (!FkOn(c, part)) c.ActiveFK(FKCtrl.parts[part], true, false);
            foreach (var bit in handOver) c.ActiveIK(bit, false, false);
        }

        /// <summary>Before an IK target is moved by hand: IK on for its part, the targets where the limbs are now.</summary>
        private static void EnsureIk(OCIChar c, int index)
        {
            var ik = c.listIKTarget[index];
            int part = IkPart(ik.boneGroup);
            if (part < 0 || IkOn(c, part)) return;
            foreach (var t in c.listIKTarget) if (IkPart(t.boneGroup) == part) t.CopyBone();
            if (!c.oiCharInfo.enableIK) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, true, false);
            c.ActiveIK((OIBoneInfo.BoneGroup)(1 << part), true, false);
        }

        // ================================================================== input

        private Vector2 Mouse => _simMouse ?? (Vector2)Input.mousePosition;
        private bool Pressed => _simMouse.HasValue ? _simDown : Input.GetMouseButtonDown(0);
        private bool Held => _simMouse.HasValue ? _simHeld : Input.GetMouseButton(0);
        private bool Released => _simMouse.HasValue ? _simUp : Input.GetMouseButtonUp(0);
        private static bool Ctrl => Input.GetKey(KeyCode.LeftControl) || Input.GetKey(KeyCode.RightControl);
        private static bool Shift => Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);

        private void Update()
        {
            try { Step(); }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("Viewport handles: " + e.Message);
                EndDrag(false);
            }
            if (_simMouse.HasValue) { _simDown = false; _simUp = false; }
        }

        private void Step()
        {
            var cam = Camera.main;
            if (cam == null || !Any || Time.captureFramerate > 0) { if (_drag != H.None) EndDrag(true); return; }
            if (_gizmo && !_hidAxis && Singleton<Studio.Studio>.Instance?.workInfo.visibleAxis == true) SyncStudioHandles();
            var m = Mouse;
            bool overUi = !_simMouse.HasValue && EventSystem.current != null && EventSystem.current.IsPointerOverGameObject();

            if (_drag != H.None)
            {
                if (Held) Drag(cam, m);
                if (Released || !Held) EndDrag(true);
                return;
            }
            // hover: handles first, then pickable things
            _hover = _gizmo ? HitHandle(cam, m) : H.None;
            _hoverPick = _hover == H.None && !overUi ? PickAt(cam, m, false) : null;

            if (Pressed && !overUi)
            {
                _down = true;
                _moved = false;
                _downAt = m;
                if (_hover != H.None) BeginDrag(cam, m, _hover);
                else if (_hoverPick != null && _hoverPick.StartsWith("ik:", StringComparison.Ordinal) && _gizmo)
                {
                    // grab an IK target and drag it straight away
                    Select(_hoverPick);
                    BeginDrag(cam, m, H.Free);
                }
            }
            if (_down && Held && (m - _downAt).sqrMagnitude > 16f) _moved = true;
            if (_down && Released)
            {
                _down = false;
                // a click (not a camera drag): select what's under the pointer, or let go of the handles' target
                if (!_moved && !overUi)
                {
                    var hit = PickAt(cam, m, true);
                    if (hit != null) Select(hit);
                    else if (_kind == Kind.Bone || _kind == Kind.IK) { _kind = Kind.None; Broadcast(); }
                }
            }
            var sel = SceneApi.SelectedIds();
            // a bone / IK target stays the handles' target while its character is selected
            if ((_kind == Kind.Bone || _kind == Kind.IK) && !sel.Contains(_ociId) && sel.Count > 0) { _kind = Kind.None; Broadcast(); }
            // the object gizmo follows Studio's selection unless a bone / IK target is picked
            if (_kind == Kind.None || _kind == Kind.Object)
            {
                int id = sel.Count == 1 ? Convert.ToInt32(sel[0]) : -1;
                if (id >= 0 && SceneApi.FindOci(id)?.guideObject != null) { _kind = Kind.Object; _ociId = id; }
                else if (_kind == Kind.Object) _kind = Kind.None;
            }
        }

        private void Select(string pick)
        {
            var p = pick.Split(':');
            int id = int.Parse(p[1]);
            var studio = Singleton<Studio.Studio>.Instance;
            var node = SceneApi.FindNode(id);
            if (node != null && !SceneApi.SelectedIds().Contains(id)) studio.treeNodeCtrl.SelectSingle(node, false);
            if (p[0] == "joint") { _kind = Kind.Bone; _ociId = id; _index = int.Parse(p[2]); }
            else if (p[0] == "ik") { _kind = Kind.IK; _ociId = id; _index = int.Parse(p[2]); }
            else { _kind = Kind.Object; _ociId = id; _index = -1; }
            Broadcast();
        }

        private void Broadcast() => StudioBridgePlugin.Instance?.Broadcast("gizmo.target", TargetInfo());

        // ---------------- picking ----------------

        private static bool OnScreen(Camera cam, Vector3 w, out Vector2 s)
        {
            var p = cam.WorldToScreenPoint(w);
            s = p;
            return p.z > 0.01f;
        }

        /// <summary>What's under the pointer: "joint:id:i", "ik:id:i", "object:id". Nearest wins.</summary>
        private string PickAt(Camera cam, Vector2 m, bool items)
        {
            float best = float.MaxValue;
            string hit = null;
            void Try(string what, Vector2 s, float r, float bias = 0f)
            {
                float raw = (s - m).magnitude, d = raw + bias;
                if (raw < r && d < best) { best = d; hit = what; }
            }
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) return null;
            if (_pickChars && _show && (_skeleton || _ik))
                foreach (var c in Shown())
                {
                    var rig = RigOf(c);
                    if (rig == null) continue;
                    int id = c.objectInfo.dicKey;
                    if (_skeleton)
                        foreach (var kv in rig.Bones)
                            if (rig.FkIndex.TryGetValue(kv.Value, out int fi) && OnScreen(cam, kv.Value.position, out var s)) Try("joint:" + id + ":" + fi, s, Finger(kv.Key) ? 6f : 9f);
                    if (_ik)
                        for (int i = 0; i < c.listIKTarget.Count; i++)
                            if (c.listIKTarget[i]?.targetObject != null && OnScreen(cam, c.listIKTarget[i].targetObject.position, out var s)) Try("ik:" + id + ":" + i, s, 10f, IkOn(c, IkPart(c.listIKTarget[i].boneGroup)) ? -4f : 4f); // a live IK target wins over the joint under it
                }
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                int id = oci.objectInfo.dicKey;
                if (oci is OCILight l && _show && _lights && _pickLights && l.light != null && OnScreen(cam, l.light.transform.position, out var ls)) Try("object:" + id, ls, 13f);
                else if (oci is OCICamera oc && _show && _cameras && _pickCameras && oc.guideObject?.transformTarget != null && OnScreen(cam, oc.guideObject.transformTarget.position, out var cs)) Try("object:" + id, cs, 13f);
            }
            if (hit != null) return hit;
            // items: inside their outline on screen, the smallest first
            if (_pickItems && items)
            {
                float area = float.MaxValue;
                var eye = cam.transform.position;
                foreach (var oci in studio.dicObjectCtrl.Values)
                    if (oci is OCIItem it && it.objectItem != null && it.objectItem.activeInHierarchy && ScreenRect(cam, it.objectItem, out var r, out var wb) && !wb.Contains(eye) && r.Contains(m) && r.width * r.height < area)
                    {
                        area = r.width * r.height;
                        hit = "object:" + oci.objectInfo.dicKey;
                    }
            }
            return hit;
        }

        private static bool Finger(string n) => n.Contains("thumb") || n.Contains("index") || n.Contains("middle") || n.Contains("ring") || n.Contains("little");

        /// <summary>The object's outline on screen (its renderers' bounds), if any of it is in front of the camera.</summary>
        private static bool ScreenRect(Camera cam, GameObject go, out Rect rect) => ScreenRect(cam, go, out rect, out _);

        private static bool ScreenRect(Camera cam, GameObject go, out Rect rect, out Bounds b)
        {
            rect = default;
            b = default;
            var rs = go.GetComponentsInChildren<Renderer>(false).Where(r => r.enabled && !(r is ParticleSystemRenderer)).ToList();
            if (rs.Count == 0) return false;
            b = rs[0].bounds;
            foreach (var r in rs.Skip(1)) b.Encapsulate(r.bounds);
            float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
            bool any = false;
            for (int k = 0; k < 8; k++)
            {
                var p = b.center + Vector3.Scale(b.extents, new Vector3((k & 1) == 0 ? -1 : 1, (k & 2) == 0 ? -1 : 1, (k & 4) == 0 ? -1 : 1));
                var s = cam.WorldToScreenPoint(p);
                if (s.z <= 0.01f) continue;
                any = true;
                x0 = Mathf.Min(x0, s.x); y0 = Mathf.Min(y0, s.y); x1 = Mathf.Max(x1, s.x); y1 = Mathf.Max(y1, s.y);
            }
            if (!any) return false;
            rect = Rect.MinMaxRect(x0, y0, x1, y1);
            return rect.width > 2 && rect.height > 2;
        }

        // ---------------- the handles' geometry ----------------

        /// <summary>World length that shows as `px` pixels at `at` (handles keep their size on screen).</summary>
        private static float WorldPerPixel(Camera cam, Vector3 at, float px)
        {
            float d = Mathf.Max(0.01f, Vector3.Dot(at - cam.transform.position, cam.transform.forward));
            return px * 2f * d * Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad) / Mathf.Max(1, cam.pixelHeight);
        }

        private bool Frame(out GuideObject g, out Vector3 c, out Quaternion axes, out int mode)
        {
            g = TargetGuide(out _, out _);
            c = default;
            axes = Quaternion.identity;
            mode = StudioMode();
            if (g?.transformTarget == null) return false;
            c = g.transformTarget.position;
            if (_kind == Kind.Bone) { axes = g.transformTarget.rotation; mode = 1; }
            else if (_kind == Kind.IK) axes = _world || mode == 0 ? Quaternion.identity : g.transformTarget.rotation;
            else axes = _world ? Quaternion.identity : g.transformTarget.rotation;
            // what the target can do (FK bones only turn; some objects can't scale)
            if (mode == 0 && !g.enablePos) mode = g.enableRot ? 1 : -1;
            if (mode == 1 && !g.enableRot) mode = g.enablePos ? 0 : -1;
            if (mode == 2 && !g.enableScale) mode = -1;
            return mode >= 0;
        }

        private const float Size = 92f, RingPx = 78f;

        private H HitHandle(Camera cam, Vector2 m)
        {
            if (!Frame(out var g, out var c, out var axes, out int mode) || !OnScreen(cam, c, out var sc)) return H.None;
            float L = WorldPerPixel(cam, c, Size);
            if (mode == 0 || mode == 2)
            {
                if ((m - sc).magnitude < 11f) return mode == 0 ? H.Free : H.ScaleAll;
                for (int i = 0; i < 3; i++)
                {
                    var a = axes * Axis(i);
                    if (!OnScreen(cam, c + a * L, out var se)) continue;
                    if (DistToSegment(m, sc, se) < 7f) return (H)((mode == 0 ? (int)H.AxisX : (int)H.ScaleX) + i);
                }
                return H.None;
            }
            // rings — the middle moves what can move (a ring seen edge-on runs through it, so it isn't a ring there)
            float fromCentre = (m - sc).magnitude;
            if (fromCentre < 12f) return CanGrab(g) ? H.Free : H.None;
            float R = WorldPerPixel(cam, c, RingPx);
            float bestD = 7f;
            H best = H.None;
            if (Mathf.Abs((m - sc).magnitude - RingPx * 1.18f) < 6f) best = H.RingView;
            for (int i = 0; i < 3; i++)
            {
                float d = fromCentre < 18f ? float.MaxValue : DistToRing(cam, m, c, axes * Axis(i), R);
                if (d < bestD) { bestD = d; best = (H)((int)H.RingX + i); }
            }
            return best;
        }

        /// <summary>IK targets and objects move from the middle of the rings too; a bone only turns.</summary>
        private bool CanGrab(GuideObject g) => _kind != Kind.Bone && g != null && g.enablePos;

        private static Vector3 Axis(int i) => i == 0 ? Vector3.right : i == 1 ? Vector3.up : Vector3.forward;

        private static float DistToSegment(Vector2 p, Vector2 a, Vector2 b)
        {
            var ab = b - a;
            float t = Mathf.Clamp01(Vector2.Dot(p - a, ab) / Mathf.Max(1e-4f, ab.sqrMagnitude));
            return (a + ab * t - p).magnitude;
        }

        private static float DistToRing(Camera cam, Vector2 m, Vector3 c, Vector3 axis, float r)
        {
            var u = Vector3.Cross(axis, Mathf.Abs(Vector3.Dot(axis, Vector3.up)) > 0.9f ? Vector3.right : Vector3.up).normalized;
            var v = Vector3.Cross(axis, u);
            float best = float.MaxValue;
            Vector2 prev = default;
            bool has = false;
            for (int k = 0; k <= 48; k++)
            {
                float t = k / 48f * Mathf.PI * 2f;
                if (!OnScreen(cam, c + (u * Mathf.Cos(t) + v * Mathf.Sin(t)) * r, out var s)) { has = false; continue; }
                if (has) best = Mathf.Min(best, DistToSegment(m, prev, s));
                prev = s;
                has = true;
            }
            return best;
        }

        // ---------------- dragging ----------------

        private void BeginDrag(Camera cam, Vector2 m, H h)
        {
            if (!Frame(out var g, out var c, out var axes, out _)) return;
            var oci = SceneApi.FindOci(_ociId);
            if (_kind == Kind.Bone && oci is OCIChar cb) EnsureFk(cb, _index);
            if (_kind == Kind.IK && oci is OCIChar ci) EnsureIk(ci, _index);
            _drag = h;
            _dragGuide = g;
            _m0 = _mPrev = m;
            _angle = 0f;
            _startWorldPos = g.transformTarget.position;
            _startWorldRot = g.transformTarget.rotation;
            _startScale = g.changeAmount.scale;
            int ax = h >= H.RingX && h <= H.RingZ ? h - H.RingX : h >= H.AxisX && h <= H.AxisZ ? h - H.AxisX : h >= H.ScaleX && h <= H.ScaleZ ? h - H.ScaleX : -1;
            _dragAxis = h == H.RingView ? (cam.transform.position - c).normalized : ax >= 0 ? (axes * Axis(ax)).normalized : Vector3.zero;
            if (h == H.Free && Physicsless(cam, m, c, out var hitP)) _grabOffset = c - hitP;
            else _grabOffset = Vector3.zero;
            _undo = new GuideUndo(new[] { g });
            HoldCamera(true);
        }

        /// <summary>The point under the pointer on the plane through `c` facing the camera.</summary>
        private static bool Physicsless(Camera cam, Vector2 m, Vector3 c, out Vector3 p)
        {
            var ray = cam.ScreenPointToRay(m);
            var plane = new Plane(-cam.transform.forward, c);
            p = default;
            if (!plane.Raycast(ray, out float t)) return false;
            p = ray.GetPoint(t);
            return true;
        }

        private void Drag(Camera cam, Vector2 m)
        {
            var g = _dragGuide;
            if (g?.transformTarget == null) { EndDrag(false); return; }
            var c = _startWorldPos;
            float fine = Shift ? 0.25f : 1f;
            if (_drag == H.Free)
            {
                if (!Physicsless(cam, m, c, out var p)) return;
                var to = p + _grabOffset;
                var delta = (to - c) * fine;
                if (Ctrl) delta = new Vector3(Snap(delta.x, _snapMove), Snap(delta.y, _snapMove), Snap(delta.z, _snapMove));
                MoveTo(g, c + delta);
            }
            else if (_drag >= H.AxisX && _drag <= H.AxisZ)
            {
                float L = WorldPerPixel(cam, c, Size);
                if (!OnScreen(cam, c, out var s0) || !OnScreen(cam, c + _dragAxis * L, out var s1)) return;
                var d2 = s1 - s0;
                float len = d2.magnitude;
                if (len < 3f) return;
                float units = Vector2.Dot(m - _m0, d2 / len) / (len / L) * fine;
                if (Ctrl) units = Snap(units, _snapMove);
                MoveTo(g, c + _dragAxis * units);
            }
            else if (_drag >= H.RingX && _drag <= H.RingView)
            {
                if (!OnScreen(cam, c, out var sc)) return;
                Vector2 a = _mPrev - sc, b = m - sc;
                if (a.sqrMagnitude > 4f && b.sqrMagnitude > 4f)
                    _angle += Mathf.Atan2(a.x * b.y - a.y * b.x, Vector2.Dot(a, b)) * Mathf.Rad2Deg * fine;
                // Unity turns clockwise (seen from the axis' tip) for a positive angle; the screen angle counts
                // anticlockwise — so the sign follows which way the axis faces the viewer
                float facing = Vector3.Dot(_dragAxis, cam.transform.position - c) >= 0 ? 1f : -1f;
                float deg = -_angle * facing;
                if (Ctrl) deg = Snap(deg, _snapRot);
                TurnTo(g, Quaternion.AngleAxis(deg, _dragAxis) * _startWorldRot);
            }
            else if (_drag >= H.ScaleX && _drag <= H.ScaleAll)
            {
                Vector2 d = m - _m0;
                float f;
                if (_drag == H.ScaleAll) f = 1f + (d.x + d.y) / 150f * fine;
                else
                {
                    float L = WorldPerPixel(cam, c, Size);
                    if (!OnScreen(cam, c, out var s0) || !OnScreen(cam, c + _dragAxis * L, out var s1)) return;
                    var d2 = (s1 - s0).normalized;
                    f = 1f + Vector2.Dot(d, d2) / 120f * fine;
                }
                f = Mathf.Max(0.01f, f);
                var sc0 = _startScale;
                Vector3 s = _drag == H.ScaleAll ? sc0 * f : _drag == H.ScaleX ? new Vector3(sc0.x * f, sc0.y, sc0.z) : _drag == H.ScaleY ? new Vector3(sc0.x, sc0.y * f, sc0.z) : new Vector3(sc0.x, sc0.y, sc0.z * f);
                if (Ctrl) s = new Vector3(Snap(s.x, _snapScale), Snap(s.y, _snapScale), Snap(s.z, _snapScale));
                g.changeAmount.scale = new Vector3(Mathf.Max(0.01f, s.x), Mathf.Max(0.01f, s.y), Mathf.Max(0.01f, s.z));
            }
            _mPrev = m;
        }

        private static float Snap(float v, float step) => step > 0 ? Mathf.Round(v / step) * step : v;

        private static void MoveTo(GuideObject g, Vector3 world)
        {
            var parent = g.transformTarget.parent;
            g.changeAmount.pos = parent != null ? parent.InverseTransformPoint(world) : world;
        }

        private static void TurnTo(GuideObject g, Quaternion world)
        {
            var parent = g.transformTarget.parent;
            var local = parent != null ? Quaternion.Inverse(parent.rotation) * world : world;
            g.changeAmount.rot = local.eulerAngles;
        }

        private void EndDrag(bool keep)
        {
            if (_drag == H.None) return;
            _drag = H.None;
            HoldCamera(false);
            if (_undo != null)
            {
                if (keep) UndoStack.Push(_undo);
                else _undo.Restore();
            }
            _undo = null;
            _dragGuide = null;
            _down = false;
            Broadcast();
        }

        /// <summary>While a handle is dragged, Studio's camera ignores the mouse.</summary>
        private void HoldCamera(bool hold)
        {
            var cc = Singleton<Studio.Studio>.Instance?.cameraCtrl;
            if (cc == null) return;
            if (hold)
            {
                _cameraWas = cc.noCtrlCondition;
                cc.noCtrlCondition = () => true;
            }
            else if (_cameraWas != null || cc.noCtrlCondition != null)
            {
                cc.noCtrlCondition = _cameraWas;
                _cameraWas = null;
            }
        }

        /// <summary>One handle drag: the targets' position, rotation and scale before it.</summary>
        private sealed class GuideUndo : IUndoEntry
        {
            private readonly List<KeyValuePair<GuideObject, Vector3[]>> _was;
            public GuideUndo(IEnumerable<GuideObject> gs) => _was = gs.Where(x => x != null).Select(x => new KeyValuePair<GuideObject, Vector3[]>(x, new[] { x.changeAmount.pos, x.changeAmount.rot, x.changeAmount.scale })).ToList();
            public string Label => "Move in the viewport";
            public IUndoEntry Restore()
            {
                var inverse = new GuideUndo(_was.Select(kv => kv.Key));
                foreach (var kv in _was)
                {
                    if (kv.Key == null) continue;
                    kv.Key.changeAmount.pos = kv.Value[0];
                    kv.Key.changeAmount.rot = kv.Value[1];
                    kv.Key.changeAmount.scale = kv.Value[2];
                }
                return inverse;
            }
            public bool Absorbs(IUndoEntry next) => false;
        }

        // ================================================================== drawing

        private Material Mat
        {
            get
            {
                if (_mat != null) return _mat;
                var sh = Shader.Find("Hidden/Internal-Colored");
                _mat = new Material(sh) { hideFlags = HideFlags.HideAndDontSave };
                _mat.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
                _mat.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                _mat.SetInt("_Cull", (int)UnityEngine.Rendering.CullMode.Off);
                _mat.SetInt("_ZWrite", 0);
                _mat.SetInt("_ZTest", (int)UnityEngine.Rendering.CompareFunction.Always);
                return _mat;
            }
        }

        /// <summary>
        /// Drawn on top of the finished screen (OnGUI's repaint) — after depth of field, bloom and the rest, so the
        /// lines stay crisp, and never part of a render, still or video frame (those read the camera, not the screen).
        /// </summary>
        private bool Live(Camera cam) => Any && cam != null && cam.targetTexture == null && Time.captureFramerate == 0 && !StillsApi.Capturing;

        private void Draw(Camera cam)
        {
            if (!Live(cam)) return;
            try
            {
                Mat.SetPass(0);
                GL.PushMatrix();
                GL.LoadPixelMatrix(0, Screen.width, 0, Screen.height);
                if (_show && _highlight) DrawHighlight(cam);
                if (_show && _lights) DrawLights(cam);
                if (_show && _cameras) DrawCameras(cam);
                if (_show && (_skeleton || _ik)) foreach (var c in Shown()) DrawRig(cam, c);
                if (_gizmo) DrawGizmo(cam);
                GL.PopMatrix();
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("overlay: " + e.Message); }
        }

        // ---- primitives (pixel space) ----
        private static void Line(Vector2 a, Vector2 b, float w, Color c)
        {
            var d = b - a;
            if (d.sqrMagnitude < 0.01f) return;
            var n = new Vector2(-d.y, d.x).normalized * (w * 0.5f);
            GL.Begin(GL.QUADS);
            GL.Color(c);
            GL.Vertex3(a.x - n.x, a.y - n.y, 0); GL.Vertex3(a.x + n.x, a.y + n.y, 0);
            GL.Vertex3(b.x + n.x, b.y + n.y, 0); GL.Vertex3(b.x - n.x, b.y - n.y, 0);
            GL.End();
        }
        private static void Disc(Vector2 c, float r, Color col)
        {
            GL.Begin(GL.TRIANGLES);
            GL.Color(col);
            const int n = 16;
            for (int i = 0; i < n; i++)
            {
                float a0 = i * Mathf.PI * 2 / n, a1 = (i + 1) * Mathf.PI * 2 / n;
                GL.Vertex3(c.x, c.y, 0);
                GL.Vertex3(c.x + Mathf.Cos(a0) * r, c.y + Mathf.Sin(a0) * r, 0);
                GL.Vertex3(c.x + Mathf.Cos(a1) * r, c.y + Mathf.Sin(a1) * r, 0);
            }
            GL.End();
        }
        private static void Circle2(Vector2 c, float r, float w, Color col)
        {
            const int n = 40;
            for (int i = 0; i < n; i++)
            {
                float a0 = i * Mathf.PI * 2 / n, a1 = (i + 1) * Mathf.PI * 2 / n;
                Line(c + new Vector2(Mathf.Cos(a0), Mathf.Sin(a0)) * r, c + new Vector2(Mathf.Cos(a1), Mathf.Sin(a1)) * r, w, col);
            }
        }
        private static void Diamond(Vector2 c, float r, Color fill, Color edge)
        {
            GL.Begin(GL.QUADS);
            GL.Color(fill);
            GL.Vertex3(c.x, c.y + r, 0); GL.Vertex3(c.x + r, c.y, 0); GL.Vertex3(c.x, c.y - r, 0); GL.Vertex3(c.x - r, c.y, 0);
            GL.End();
            Line(new Vector2(c.x, c.y + r), new Vector2(c.x + r, c.y), 1.5f, edge);
            Line(new Vector2(c.x + r, c.y), new Vector2(c.x, c.y - r), 1.5f, edge);
            Line(new Vector2(c.x, c.y - r), new Vector2(c.x - r, c.y), 1.5f, edge);
            Line(new Vector2(c.x - r, c.y), new Vector2(c.x, c.y + r), 1.5f, edge);
        }
        private static Color A(Color c, float a) => new Color(c.r, c.g, c.b, a);

        /// <summary>A circle in 3D: the half facing the viewer drawn strong, the far half faint.</summary>
        private static void Circle3(Camera cam, Vector3 c, Vector3 axis, float r, float w, Color col, bool hot)
        {
            var u = Vector3.Cross(axis, Mathf.Abs(Vector3.Dot(axis, Vector3.up)) > 0.9f ? Vector3.right : Vector3.up).normalized;
            var v = Vector3.Cross(axis, u);
            var toCam = (cam.transform.position - c).normalized;
            const int n = 64;
            Vector2 prev = default;
            bool has = false;
            for (int k = 0; k <= n; k++)
            {
                float t = k / (float)n * Mathf.PI * 2f;
                var dir = u * Mathf.Cos(t) + v * Mathf.Sin(t);
                if (!OnScreen(cam, c + dir * r, out var s)) { has = false; continue; }
                if (has)
                {
                    bool front = Vector3.Dot(dir, toCam) >= -0.05f;
                    Line(prev, s, hot ? w + 1.5f : w, front ? col : A(col, 0.18f));
                }
                prev = s;
                has = true;
            }
        }

        // ---- skeleton ----
        private void DrawRig(Camera cam, OCIChar c)
        {
            var rig = RigOf(c);
            if (rig == null) return;
            int id = c.objectInfo.dicKey;
            if (_skeleton)
            {
                foreach (var chain in Chains)
                    for (int i = 0; i + 1 < chain.Length; i++)
                    {
                        if (!rig.Bones.TryGetValue(chain[i], out var a) || !rig.Bones.TryGetValue(chain[i + 1], out var b)) continue;
                        if (!OnScreen(cam, a.position, out var sa) || !OnScreen(cam, b.position, out var sb)) continue;
                        bool finger = Finger(chain[i + 1]);
                        bool fk = rig.FkIndex.TryGetValue(b, out int bi) && FkOn(c, FkPart(c, c.listBones[bi].boneGroup));
                        var col = fk ? Ice : Bone;
                        // a soft dark edge under each bone keeps it readable on any background
                        Line(sa, sb, finger ? 3.5f : 5f, new Color(0, 0, 0, 0.35f));
                        Line(sa, sb, finger ? 1.5f : 2.5f, A(col, 0.85f));
                    }
                foreach (var kv in rig.Bones)
                {
                    if (!rig.FkIndex.TryGetValue(kv.Value, out int fi) || !OnScreen(cam, kv.Value.position, out var s)) continue;
                    bool finger = Finger(kv.Key);
                    string key = "joint:" + id + ":" + fi;
                    bool sel = _kind == Kind.Bone && _ociId == id && _index == fi;
                    bool hov = _hoverPick == key;
                    bool fk = FkOn(c, FkPart(c, c.listBones[fi].boneGroup));
                    float r = (finger ? 2.6f : 4.2f) * (hov ? 1.45f : 1f);
                    Disc(s, r + 1.5f, new Color(0, 0, 0, 0.55f));
                    Disc(s, r, sel ? Accent : hov ? Color.white : fk ? Ice : Bone);
                }
            }
            if (_ik)
                for (int i = 0; i < c.listIKTarget.Count; i++)
                {
                    var t = c.listIKTarget[i]?.targetObject;
                    if (t == null || !OnScreen(cam, t.position, out var s)) continue;
                    bool on = IkOn(c, IkPart(c.listIKTarget[i].boneGroup));
                    string key = "ik:" + id + ":" + i;
                    bool sel = _kind == Kind.IK && _ociId == id && _index == i;
                    bool hov = _hoverPick == key;
                    float r = hov ? 8f : 6f;
                    Diamond(s, r + 1.5f, new Color(0, 0, 0, 0.5f), new Color(0, 0, 0, 0f));
                    Diamond(s, r, sel ? A(Accent, 0.95f) : on ? new Color(1f, 0.85f, 0.35f, 0.9f) : new Color(1f, 0.85f, 0.35f, 0.15f), sel ? Color.white : new Color(1f, 0.85f, 0.35f, on ? 1f : 0.7f));
                }
        }

        // ---- selection highlight: corner brackets around what's selected ----
        private void DrawHighlight(Camera cam)
        {
            foreach (var raw in SceneApi.SelectedIds())
            {
                var oci = SceneApi.FindOci(Convert.ToInt32(raw));
                GameObject go = oci is OCIItem it ? it.objectItem : oci is OCIChar c ? c.charInfo?.gameObject : null;
                if (go == null || !ScreenRect(cam, go, out var r)) continue;
                float k = Mathf.Clamp(Mathf.Min(r.width, r.height) * 0.22f, 6f, 26f);
                var col = A(Accent, 0.9f);
                void Corner(Vector2 p, Vector2 dx, Vector2 dy)
                {
                    Line(p, p + dx * k, 2f, col);
                    Line(p, p + dy * k, 2f, col);
                }
                Corner(new Vector2(r.xMin, r.yMin), Vector2.right, Vector2.up);
                Corner(new Vector2(r.xMax, r.yMin), Vector2.left, Vector2.up);
                Corner(new Vector2(r.xMin, r.yMax), Vector2.right, Vector2.down);
                Corner(new Vector2(r.xMax, r.yMax), Vector2.left, Vector2.down);
            }
        }

        // ---- lights ----
        private void DrawLights(Camera cam)
        {
            var studio = Singleton<Studio.Studio>.Instance;
            var sel = new HashSet<int>(SceneApi.SelectedIds().Select(Convert.ToInt32));
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                if (!(oci is OCILight l) || l.light == null) continue;
                var t = l.light.transform;
                if (!OnScreen(cam, t.position, out var s)) continue;
                bool on = sel.Contains(oci.objectInfo.dicKey);
                bool hov = _hoverPick == "object:" + oci.objectInfo.dicKey;
                var col = A(Color.Lerp(l.light.color, Color.white, 0.25f), on ? 0.95f : 0.55f);
                // the bulb: a disc with rays
                Disc(s, hov ? 7f : 5.5f, new Color(0, 0, 0, 0.5f));
                Disc(s, hov ? 5.5f : 4f, A(col, 1f));
                for (int k = 0; k < 8; k++)
                {
                    var d = new Vector2(Mathf.Cos(k * Mathf.PI / 4), Mathf.Sin(k * Mathf.PI / 4));
                    Line(s + d * 8f, s + d * 12f, 1.5f, col);
                }
                float w = on ? 1.8f : 1.2f;
                if (l.lightType == LightType.Directional)
                {
                    float L = WorldPerPixel(cam, t.position, 70f);
                    if (OnScreen(cam, t.position + t.forward * L, out var e))
                    {
                        Line(s, e, w + 0.5f, col);
                        var dir = (e - s).normalized;
                        var n = new Vector2(-dir.y, dir.x);
                        Line(e, e - dir * 8 + n * 5, w + 0.5f, col);
                        Line(e, e - dir * 8 - n * 5, w + 0.5f, col);
                    }
                }
                else if (l.lightType == LightType.Spot)
                {
                    float range = l.light.range, half = l.light.spotAngle * 0.5f * Mathf.Deg2Rad;
                    var endC = t.position + t.forward * range * Mathf.Cos(half);
                    float rad = range * Mathf.Sin(half);
                    Circle3(cam, endC, t.forward, rad, w, col, false);
                    for (int k = 0; k < 4; k++)
                    {
                        var dir = (t.right * Mathf.Cos(k * Mathf.PI / 2) + t.up * Mathf.Sin(k * Mathf.PI / 2)) * rad;
                        if (OnScreen(cam, endC + dir, out var e)) Line(s, e, w, A(col, col.a * 0.7f));
                    }
                }
                else if (l.lightType == LightType.Point && on)
                {
                    float range = l.light.range;
                    Circle3(cam, t.position, Vector3.up, range, w, A(col, col.a * 0.6f), false);
                    Circle3(cam, t.position, Vector3.right, range, w, A(col, col.a * 0.4f), false);
                    Circle3(cam, t.position, Vector3.forward, range, w, A(col, col.a * 0.4f), false);
                }
            }
        }

        // ---- scene cameras ----
        private void DrawCameras(Camera cam)
        {
            var studio = Singleton<Studio.Studio>.Instance;
            var sel = new HashSet<int>(SceneApi.SelectedIds().Select(Convert.ToInt32));
            float aspect = cam.aspect, fov = cam.fieldOfView * Mathf.Deg2Rad;
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                if (!(oci is OCICamera oc) || oc.guideObject?.transformTarget == null) continue;
                if (studio.ociCamera == oc) continue; // looking through it
                var t = oc.guideObject.transformTarget;
                if (!OnScreen(cam, t.position, out var s)) continue;
                bool on = sel.Contains(oci.objectInfo.dicKey);
                bool hov = _hoverPick == "object:" + oci.objectInfo.dicKey;
                var col = on ? A(Accent, 0.95f) : new Color(0.75f, 0.85f, 1f, hov ? 0.95f : 0.6f);
                float d = WorldPerPixel(cam, t.position, 60f);
                float hh = Mathf.Tan(fov / 2) * d, hw = hh * aspect;
                var f = t.position + t.forward * d;
                Vector3[] q = { f + t.up * hh - t.right * hw, f + t.up * hh + t.right * hw, f - t.up * hh + t.right * hw, f - t.up * hh - t.right * hw };
                var sq = new Vector2[4];
                bool ok = true;
                for (int k = 0; k < 4; k++) ok &= OnScreen(cam, q[k], out sq[k]);
                if (!ok) continue;
                float w = on || hov ? 1.8f : 1.2f;
                for (int k = 0; k < 4; k++)
                {
                    Line(sq[k], sq[(k + 1) % 4], w, col);
                    Line(s, sq[k], w, A(col, col.a * 0.7f));
                }
                // which way is up
                if (OnScreen(cam, f + t.up * hh * 1.45f, out var top)) { Line(sq[0] + (sq[1] - sq[0]) * 0.3f, top, w, col); Line(top, sq[0] + (sq[1] - sq[0]) * 0.7f, w, col); }
                Disc(s, hov ? 5f : 3.5f, col);
            }
        }

        // ---- the handles ----
        private void DrawGizmo(Camera cam)
        {
            if (!Frame(out var g, out var c, out var axes, out int mode) || !OnScreen(cam, c, out var sc)) return;
            var active = _drag != H.None ? _drag : _hover;
            if (mode == 1)
            {
                float R = WorldPerPixel(cam, c, RingPx);
                // the view ring and a faint disc
                Circle2(sc, RingPx * 1.18f, active == H.RingView ? 3f : 1.6f, active == H.RingView ? Accent : new Color(1, 1, 1, 0.55f));
                for (int i = 0; i < 3; i++)
                {
                    var h = (H)((int)H.RingX + i);
                    var col = i == 0 ? X : i == 1 ? Y : Z;
                    if (_drag != H.None && _drag != h && _drag != H.RingView) col = A(col, 0.2f); // while turning one, the others step back
                    Circle3(cam, c, axes * Axis(i), R, 2.2f, active == h ? Color.Lerp(col, Color.white, 0.35f) : col, active == h);
                }
                if (_drag >= H.RingX && _drag <= H.RingView)
                {
                    // how far it's turned, in a small tag by the centre
                    Disc(sc, 3f, Color.white);
                    _tag = Mathf.Abs(_angle) > 0.05f ? (Ctrl ? Snap(-_angle, _snapRot) : -_angle).ToString("0.0") + "°" : null;
                    _tagAt = sc;
                }
                if (CanGrab(g))
                {
                    // the middle: grab and move
                    bool hot = active == H.Free;
                    Disc(sc, hot ? 8f : 6.5f, new Color(0, 0, 0, 0.5f));
                    Circle2(sc, hot ? 7f : 5.5f, 2f, hot ? Accent : Color.white);
                    if (_drag == H.Free)
                    {
                        _tag = (g.transformTarget.position - _startWorldPos).magnitude.ToString("0.000") + " m";
                        _tagAt = sc;
                    }
                }
                return;
            }
            float L = WorldPerPixel(cam, c, Size);
            for (int i = 0; i < 3; i++)
            {
                var h = (H)((mode == 0 ? (int)H.AxisX : (int)H.ScaleX) + i);
                var col = i == 0 ? X : i == 1 ? Y : Z;
                if (!OnScreen(cam, c + axes * Axis(i) * L, out var e)) continue;
                bool hot = active == h;
                if (_drag != H.None && !hot) col = A(col, 0.25f);
                var cc = hot ? Color.Lerp(col, Color.white, 0.35f) : col;
                Line(sc, e, hot ? 3.5f : 2.5f, cc);
                var dir = (e - sc).normalized;
                var n = new Vector2(-dir.y, dir.x);
                if (mode == 0)
                {
                    // an arrow head
                    GL.Begin(GL.TRIANGLES);
                    GL.Color(cc);
                    GL.Vertex3(e.x + dir.x * 12, e.y + dir.y * 12, 0);
                    GL.Vertex3(e.x + n.x * 5.5f, e.y + n.y * 5.5f, 0);
                    GL.Vertex3(e.x - n.x * 5.5f, e.y - n.y * 5.5f, 0);
                    GL.End();
                }
                else
                {
                    // a cube end
                    GL.Begin(GL.QUADS);
                    GL.Color(cc);
                    GL.Vertex3(e.x - 5, e.y - 5, 0); GL.Vertex3(e.x + 5, e.y - 5, 0); GL.Vertex3(e.x + 5, e.y + 5, 0); GL.Vertex3(e.x - 5, e.y + 5, 0);
                    GL.End();
                }
            }
            var center = mode == 0 ? H.Free : H.ScaleAll;
            bool cHot = active == center;
            Disc(sc, cHot ? 8f : 6.5f, new Color(0, 0, 0, 0.5f));
            Circle2(sc, cHot ? 7f : 5.5f, 2f, cHot ? Accent : Color.white);
            if (_drag != H.None && _drag != H.RingView && !(_drag >= H.RingX && _drag <= H.RingZ))
            {
                var p = g.changeAmount;
                _tag = mode == 2 ? "×" + p.scale.x.ToString("0.00") + (Mathf.Approximately(p.scale.x, p.scale.y) && Mathf.Approximately(p.scale.y, p.scale.z) ? "" : " " + p.scale.y.ToString("0.00") + " " + p.scale.z.ToString("0.00"))
                    : (g.transformTarget.position - _startWorldPos).magnitude.ToString("0.000") + " m";
                _tagAt = sc;
            }
        }

        // a small value tag next to the handles while dragging (and a name label on hover)
        private string _tag;
        private Vector2 _tagAt;
        private GUIStyle _tagStyle;

        private void OnGUI()
        {
            if (Event.current.type != EventType.Repaint || !Any || Time.captureFramerate > 0) return;
            var cam = Camera.main;
            if (cam == null) return;
            Draw(cam);
            if (_tagStyle == null)
            {
                _tagStyle = new GUIStyle(GUI.skin.label) { fontSize = 12, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft };
                _tagStyle.normal.textColor = Color.white;
            }
            string text = _drag != H.None ? _tag : _labels ? HoverLabel() : null;
            var at = _drag != H.None ? _tagAt : (Vector2)Mouse;
            if (string.IsNullOrEmpty(text)) return;
            var size = _tagStyle.CalcSize(new GUIContent(text));
            var r = new Rect(at.x + 14, Screen.height - at.y - size.y - 10, size.x + 12, size.y + 4);
            var bg = GUI.color;
            GUI.color = new Color(0.06f, 0.07f, 0.09f, 0.82f);
            GUI.DrawTexture(r, Texture2D.whiteTexture);
            GUI.color = bg;
            GUI.Label(new Rect(r.x + 6, r.y + 2, size.x, size.y), text, _tagStyle);
            if (_drag == H.None) _tag = null;
        }

        private string HoverLabel()
        {
            if (_hoverPick == null) return null;
            var p = _hoverPick.Split(':');
            var oci = SceneApi.FindOci(int.Parse(p[1]));
            if (oci == null) return null;
            if (p[0] == "joint" && oci is OCIChar c && int.Parse(p[2]) < c.listBones.Count) return Pretty(c.listBones[int.Parse(p[2])].guideObject?.transformTarget?.name);
            if (p[0] == "ik" && oci is OCIChar ci && int.Parse(p[2]) < ci.listIKTarget.Count) return "IK " + Pretty(ci.listIKTarget[int.Parse(p[2])].targetObject?.name);
            return oci.treeNodeObject != null ? oci.treeNodeObject.textName : null;
        }

        // ================================================================== tests

        private object Simulate(Dictionary<string, object> a)
        {
            var cam = Camera.main;
            if (a.ContainsKey("project") && cam != null)
            {
                var p = a.GetList("project");
                var s = cam.WorldToScreenPoint(new Vector3(Convert.ToSingle(p[0]), Convert.ToSingle(p[1]), Convert.ToSingle(p[2])));
                return V(s);
            }
            // where a character's bone / IK target is: {id, bone: "cf_j_forearm01_L"} or {id, ik: index}
            if (a.Has("bone") || a.Has("ik"))
            {
                if (!(SceneApi.FindOci(a.GetInt("id", -1)) is OCIChar c) || cam == null) throw new Exception("no such character");
                Transform t = null;
                int index = -1;
                if (a.Has("bone"))
                {
                    var name = a.GetString("bone");
                    for (int i = 0; i < c.listBones.Count; i++)
                        if (c.listBones[i]?.guideObject?.transformTarget?.name == name) { index = i; t = c.listBones[i].guideObject.transformTarget; break; }
                }
                else
                {
                    index = a.GetInt("ik", -1);
                    if (index >= 0 && index < c.listIKTarget.Count) t = c.listIKTarget[index].targetObject;
                }
                if (t == null) throw new Exception("not found");
                var g = a.Has("bone") ? c.listBones[index].guideObject : c.listIKTarget[index].guideObject;
                return new Dictionary<string, object>
                {
                    { "index", index }, { "screen", V(cam.WorldToScreenPoint(t.position)) }, { "world", V(t.position) },
                    { "worldRot", V(t.rotation.eulerAngles) }, { "rot", V(g.changeAmount.rot) }, { "pos", V(g.changeAmount.pos) },
                    { "fk", c.oiCharInfo.enableFK }, { "activeFK", c.oiCharInfo.activeFK.Select(x => (object)x).ToList() },
                    { "ik", c.oiCharInfo.enableIK }, { "activeIK", c.oiCharInfo.activeIK.Select(x => (object)x).ToList() },
                };
            }
            if (a.GetBool("end")) { _simMouse = null; _simHeld = false; _simDown = _simUp = false; return State(); }
            var at = a.GetList("at");
            if (at.Count >= 2) _simMouse = new Vector2(Convert.ToSingle(at[0]), Convert.ToSingle(at[1]));
            if (a.GetBool("press")) { _simDown = true; _simHeld = true; }
            if (a.GetBool("release")) { _simUp = true; _simHeld = false; }
            var st = State();
            st["hover"] = _hover.ToString();
            st["hoverPick"] = _hoverPick;
            st["anchor"] = Anchor();
            st["screen"] = new List<object> { Screen.width, Screen.height };
            return st;
        }

        /// <summary>The handles' target and its anchor on screen (tests aim at it).</summary>
        public object Anchor()
        {
            var cam = Camera.main;
            if (cam == null || !Frame(out _, out var c, out var axes, out int mode)) return null;
            var s = cam.WorldToScreenPoint(c);
            float L = WorldPerPixel(cam, c, Size), R = WorldPerPixel(cam, c, RingPx);
            var ends = Enumerable.Range(0, 3).Select(i => (object)V(cam.WorldToScreenPoint(c + axes * Axis(i) * (mode == 1 ? R : L)))).ToList();
            return new Dictionary<string, object> { { "center", V(s) }, { "ends", ends }, { "mode", mode } };
        }
    }
}
