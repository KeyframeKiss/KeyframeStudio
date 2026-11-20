using System;
using System.Collections.Generic;
using System.Linq;
using KKAPI.Maker;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityStandardAssets.ImageEffects;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Overlays and handles drawn in Studio's own viewport (no second render, no lag):
    ///  - skeleton of the selected characters (FK-posed parts tinted), IK targets, accessories, a highlight on what's
    ///    selected, lights (direction, cone, reach), scene cameras (view frame) and the depth of field's focus point;
    ///  - handles: rotation rings on a bone (its own axes + a view ring), move / rotate / scale for objects, IK targets
    ///    and accessories following Studio's own Move / Rotate / Scale mode; Ctrl snaps, Shift is fine control;
    ///  - click to select in the viewport (joints, IK targets, accessories, lights, cameras, items), with filters;
    ///    clicking the same spot again steps to the next thing under the pointer.
    /// Everything is drawn only on the live screen — never into renders, stills or videos. Studio's camera holds still
    /// while the pointer is on a handle. Each drag is one undo step (FK / IK switches included); auto-key /
    /// "unkeyed changes" see it like any Studio edit.
    /// </summary>
    internal sealed class ViewportGizmos : MonoBehaviour
    {
        public static ViewportGizmos Instance;

        // ---------------- settings (from the app) ----------------
        private bool _show, _skeleton = true, _ik = true, _acc = true, _highlight = true, _lights = true, _cameras = true, _focus = true;
        private bool _gizmo, _allChars, _labels = true;
        private bool _pickChars = true, _pickAcc = true, _pickItems = true, _pickLights = true, _pickCameras = true;
        private bool _world; // object handles along the world's axes (else the object's own)
        private float _snapMove = 0.05f, _snapRot = 15f, _snapScale = 0.1f;
        private bool Any => _gizmo || _show && (_skeleton || _ik || _acc || _highlight || _lights || _cameras || _focus);

        // ---------------- what the handles act on ----------------
        private enum Kind { None, Bone, IK, Object, Accessory }
        private Kind _kind;
        private int _ociId = -1, _index = -1; // index: a bone (listBones), an IK target (listIKTarget) or an accessory slot

        private enum H { None, AxisX, AxisY, AxisZ, Free, RingX, RingY, RingZ, RingView, ScaleX, ScaleY, ScaleZ, ScaleAll, Focus }
        private H _hover, _drag;
        private List<Cand> _hoverList = new List<Cand>();
        private string _hoverPick; // the top of _hoverList: "joint:<oci>:<index>", "ik:..", "acc:<oci>:<slot>", "object:<oci>"

        // ---------------- a drag ----------------
        private Vector2 _m0, _downAt, _lastClickAt = new Vector2(-999, -999), _tangent;
        private bool _down, _moved;
        private float _angle, _axisT0, _ringPx;
        private Vector3 _startWorldPos, _startScale, _dragAxis, _grabOffset;
        private Quaternion _startWorldRot;
        private Tgt _dragTgt;
        private IUndoEntry _undo;
        private bool _hidAxis;

        // ---------------- test input (gizmo.simulate) ----------------
        private Vector2? _simMouse;
        private bool _simDown, _simHeld, _simUp;

        private Material _mat;
        private static readonly Color X = new Color(0.94f, 0.33f, 0.36f), Y = new Color(0.45f, 0.85f, 0.35f), Z = new Color(0.33f, 0.6f, 1f);
        private static readonly Color Accent = new Color(1f, 0.62f, 0.18f), Ice = new Color(0.55f, 0.78f, 1f), Bone = new Color(0.92f, 0.93f, 0.96f);
        private static readonly Color IkCol = new Color(1f, 0.85f, 0.35f), AccCol = new Color(0.45f, 0.95f, 0.85f), FocusCol = new Color(0.6f, 1f, 0.72f);

        private void Awake() => Instance = this;

        private void OnDestroy()
        {
            UnhookCamera();
            if (_hidAxis) StudioUiApi.SetAxis(true);
        }

        public static void Register(CommandRouter r)
        {
            r.Add("gizmo.get", a => Instance.State());
            r.Add("gizmo.set", a => Instance.Set(a));
            // pick a target from the app: {kind: bone|ik|object|accessory|none, id, index}
            r.Add("gizmo.target", a =>
            {
                var k = a.GetString("kind") ?? "none";
                Instance._kind = k == "bone" ? Kind.Bone : k == "ik" ? Kind.IK : k == "object" ? Kind.Object : k == "accessory" ? Kind.Accessory : Kind.None;
                Instance._ociId = a.GetInt("id", -1);
                Instance._index = a.GetInt("index", -1);
                return Instance.State();
            });
            // type values for the handles' target: {pos?, rot?, scale?} — one undo step, FK / IK taken over like a drag
            r.Add("gizmo.value", a => Instance.Value(a));
            // tests: feed the mouse — {at:[x,y] (screen pixels, bottom-left origin), press, release}; and look-ups
            r.Add("gizmo.simulate", a => Instance.Simulate(a));
        }

        // ================================================================== state

        private Dictionary<string, object> State()
        {
            return new Dictionary<string, object>
            {
                { "overlays", new Dictionary<string, object> { { "on", _show }, { "skeleton", _skeleton }, { "ik", _ik }, { "accessories", _acc }, { "highlight", _highlight }, { "lights", _lights }, { "cameras", _cameras }, { "focus", _focus }, { "allCharacters", _allChars }, { "labels", _labels } } },
                { "gizmo", new Dictionary<string, object> { { "on", _gizmo }, { "world", _world }, { "snapMove", (double)_snapMove }, { "snapRot", (double)_snapRot }, { "snapScale", (double)_snapScale }, { "mode", StudioMode() } } },
                { "pick", new Dictionary<string, object> { { "characters", _pickChars }, { "accessories", _pickAcc }, { "items", _pickItems }, { "lights", _pickLights }, { "cameras", _pickCameras } } },
                { "target", TargetInfo() },
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
                if (o.Has("accessories")) _acc = o.GetBool("accessories");
                if (o.Has("highlight")) _highlight = o.GetBool("highlight");
                if (o.Has("lights")) _lights = o.GetBool("lights");
                if (o.Has("cameras")) _cameras = o.GetBool("cameras");
                if (o.Has("focus")) _focus = o.GetBool("focus");
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
                if (p.Has("accessories")) _pickAcc = p.GetBool("accessories", true);
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
            var t = Target();
            if (t == null) return null;
            return new Dictionary<string, object>
            {
                { "kind", _kind.ToString().ToLowerInvariant() }, { "id", _ociId }, { "index", _index }, { "label", t.Label },
                { "pos", V(t.Pos) }, { "rot", V(t.Rot) }, { "scale", V(t.Scale) }, { "world", V(t.T.position) },
                { "canMove", t.CanMove }, { "canRotate", t.CanRotate }, { "canScale", t.CanScale },
            };
        }

        private object Value(Dictionary<string, object> a)
        {
            var t = Target();
            if (t == null) throw new Exception("Nothing has the handles — click a joint, IK target, accessory or object first");
            Vector3? Read(string k)
            {
                var l = a.GetList(k);
                if (l.Count < 3) return null;
                return new Vector3(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]));
            }
            var undo = Begin(t);
            // the numbers people typed against: taking over FK / IK may move the target first (to the pose on
            // screen), so only the numbers they changed are applied — the rest keep the fresh values
            Vector3 pos0 = t.Pos, rot0 = t.Rot, scale0 = t.Scale;
            TakeOver(t, undo);
            t = Target() ?? t;
            Vector3 Merge(Vector3 typed, Vector3 was, Vector3 now) =>
                new Vector3(Mathf.Abs(typed.x - was.x) < 1e-4f ? now.x : typed.x, Mathf.Abs(typed.y - was.y) < 1e-4f ? now.y : typed.y, Mathf.Abs(typed.z - was.z) < 1e-4f ? now.z : typed.z);
            var pos = Read("pos");
            var rot = Read("rot");
            var scale = Read("scale");
            if (pos.HasValue && t.CanMove) t.SetPos(Merge(pos.Value, pos0, t.Pos));
            if (rot.HasValue && t.CanRotate) t.SetRot(Merge(rot.Value, rot0, t.Rot));
            if (scale.HasValue && t.CanScale) t.SetScale(Merge(scale.Value, scale0, t.Scale));
            UndoStack.Push(undo);
            return TargetInfo();
        }

        private static List<object> V(Vector3 v) => new List<object> { (double)v.x, (double)v.y, (double)v.z };

        // ================================================================== targets

        /// <summary>What the handles move: one shape for Studio's guide objects (bones, IK targets, objects) and accessories.</summary>
        private abstract class Tgt
        {
            public Transform T;
            public string Label;
            public bool CanMove, CanRotate, CanScale;
            /// <summary>The numbers people see and type (Studio's own units for each kind).</summary>
            public abstract Vector3 Pos { get; }
            public abstract Vector3 Rot { get; }
            public abstract Vector3 Scale { get; }
            public abstract void SetPos(Vector3 v);
            public abstract void SetRot(Vector3 v);
            public abstract void SetScale(Vector3 v);
            /// <summary>Local position / rotation for a place in the world (relative to the transform's parent).</summary>
            public Vector3 LocalPoint(Vector3 world) => T.parent != null ? T.parent.InverseTransformPoint(world) : world;
            public Vector3 LocalEuler(Quaternion world) => (T.parent != null ? Quaternion.Inverse(T.parent.rotation) * world : world).eulerAngles;
            public abstract void MoveWorld(Vector3 world);
            public void TurnWorld(Quaternion world) => SetRot(LocalEuler(world));
            public abstract Edit Snapshot();
        }

        private sealed class GuideTgt : Tgt
        {
            private readonly GuideObject _g;
            public GuideTgt(GuideObject g, Kind k, string label)
            {
                _g = g;
                T = g.transformTarget;
                Label = label;
                CanMove = k != Kind.Bone && g.enablePos;
                CanRotate = g.enableRot;
                CanScale = k == Kind.Object && g.enableScale;
            }
            public override Vector3 Pos => _g.changeAmount.pos;
            public override Vector3 Rot => _g.changeAmount.rot;
            public override Vector3 Scale => _g.changeAmount.scale;
            public override void SetPos(Vector3 v) => _g.changeAmount.pos = v;
            public override void SetRot(Vector3 v) => _g.changeAmount.rot = v;
            public override void SetScale(Vector3 v) => _g.changeAmount.scale = new Vector3(Mathf.Max(0.01f, v.x), Mathf.Max(0.01f, v.y), Mathf.Max(0.01f, v.z));
            public override void MoveWorld(Vector3 world) => SetPos(LocalPoint(world));
            public override Edit Snapshot() => new Edit(new[] { (Action)Restorer() });
            private Action Restorer()
            {
                Vector3 p = Pos, r = Rot, s = Scale;
                var g = _g;
                return () => { if (g == null) return; g.changeAmount.pos = p; g.changeAmount.rot = r; g.changeAmount.scale = s; };
            }
            public Action CaptureNow() => Restorer();
        }

        /// <summary>
        /// An accessory's own adjustment (the "N_move" node the character editor moves): position in hundredths of a
        /// unit, rotation in degrees, scale — written to the outfit being worn and the saved outfit, so it stays.
        /// </summary>
        private sealed class AccTgt : Tgt
        {
            private readonly ChaControl _cha;
            private readonly int _slot;
            public AccTgt(ChaControl cha, int slot, Transform node, string label)
            {
                _cha = cha;
                _slot = slot;
                T = node;
                Label = label;
                CanMove = CanRotate = CanScale = true;
            }
            private IEnumerable<ChaFileAccessory.PartsInfo> Parts()
            {
                var now = _cha.nowCoordinate?.accessory?.parts;
                if (now != null && _slot < now.Length) yield return now[_slot];
                var coords = _cha.chaFile?.coordinate;
                int type = _cha.fileStatus != null ? _cha.fileStatus.coordinateType : 0;
                if (coords != null && type >= 0 && type < coords.Length)
                {
                    var saved = coords[type]?.accessory?.parts;
                    if (saved != null && _slot < saved.Length && !ReferenceEquals(saved, now)) yield return saved[_slot];
                }
            }
            private Vector3 Get(int k)
            {
                var p = Parts().FirstOrDefault();
                if (p != null) return p.addMove[0, k];
                return k == 0 ? T.localPosition * 100f : k == 1 ? T.localEulerAngles : T.localScale;
            }
            private void Put(int k, Vector3 v)
            {
                foreach (var p in Parts()) p.addMove[0, k] = v;
                if (k == 0) T.localPosition = v * 0.01f;
                else if (k == 1) T.localEulerAngles = v;
                else T.localScale = v;
            }
            public override Vector3 Pos => Get(0);
            public override Vector3 Rot => Get(1);
            public override Vector3 Scale => Get(2);
            public override void SetPos(Vector3 v) => Put(0, new Vector3(Mathf.Clamp(v.x, -100f, 100f), Mathf.Clamp(v.y, -100f, 100f), Mathf.Clamp(v.z, -100f, 100f)));
            public override void SetRot(Vector3 v) => Put(1, new Vector3(Mathf.Repeat(v.x, 360f), Mathf.Repeat(v.y, 360f), Mathf.Repeat(v.z, 360f)));
            public override void SetScale(Vector3 v) => Put(2, new Vector3(Mathf.Clamp(v.x, 0.01f, 100f), Mathf.Clamp(v.y, 0.01f, 100f), Mathf.Clamp(v.z, 0.01f, 100f)));
            public override void MoveWorld(Vector3 world) => SetPos(LocalPoint(world) * 100f);
            public override Edit Snapshot()
            {
                Vector3 p = Pos, r = Rot, s = Scale;
                return new Edit(new Action[] { () => { if (T == null) return; Put(0, p); Put(1, r); Put(2, s); } }) { Label = "Move an accessory" };
            }
        }

        private Tgt Target()
        {
            var oci = _ociId >= 0 ? SceneApi.FindOci(_ociId) : null;
            if (oci == null) return null;
            switch (_kind)
            {
                case Kind.Bone:
                    if (oci is OCIChar cb && _index >= 0 && _index < cb.listBones.Count && cb.listBones[_index].guideObject?.transformTarget != null)
                        return new GuideTgt(cb.listBones[_index].guideObject, Kind.Bone, Pretty(cb.listBones[_index].guideObject.transformTarget.name));
                    return null;
                case Kind.IK:
                    if (oci is OCIChar ci && _index >= 0 && _index < ci.listIKTarget.Count && ci.listIKTarget[_index].guideObject?.transformTarget != null)
                        return new GuideTgt(ci.listIKTarget[_index].guideObject, Kind.IK, "IK " + Pretty(ci.listIKTarget[_index].targetObject?.name));
                    return null;
                case Kind.Accessory:
                    if (oci is OCIChar ca)
                    {
                        var acc = AccsOf(ca).FirstOrDefault(x => x.Slot == _index);
                        if (acc != null && acc.Node != null) return new AccTgt(ca.charInfo, acc.Slot, acc.Node, acc.Name);
                    }
                    return null;
                case Kind.Object:
                    if (oci.guideObject?.transformTarget == null) return null;
                    return new GuideTgt(oci.guideObject, Kind.Object, oci.treeNodeObject != null ? oci.treeNodeObject.textName : "object");
            }
            return null;
        }

        /// <summary>"cf_j_forearm01_L" → "Forearm L"; "f_t_hand_R(work)" (an IK target) → "Hand R".</summary>
        private static string Pretty(string n)
        {
            if (string.IsNullOrEmpty(n)) return n;
            var s = n.Replace("(work)", "");
            s = System.Text.RegularExpressions.Regex.Replace(s, @"^(cf|f|cm)_[a-z]{1,2}_", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
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
            public Transform Eyes;
        }
        private readonly Dictionary<OCIChar, Rig> _rigs = new Dictionary<OCIChar, Rig>();

        private Rig RigOf(OCIChar c)
        {
            if (c?.charInfo == null) return null;
            if (_rigs.TryGetValue(c, out var r) && r.Bones.Count > 0 && r.Bones.Values.All(t => t != null)) return r;
            r = new Rig { Chara = c };
            var want = new HashSet<string>(Chains.SelectMany(x => x));
            foreach (var t in c.charInfo.GetComponentsInChildren<Transform>(true))
            {
                if (want.Contains(t.name) && !r.Bones.ContainsKey(t.name)) r.Bones[t.name] = t;
                if (t.name == "cf_J_Eye_tz" && r.Eyes == null) r.Eyes = t;
            }
            for (int i = 0; i < c.listBones.Count; i++)
            {
                var tt = c.listBones[i]?.guideObject?.transformTarget;
                if (tt != null && !r.FkIndex.ContainsKey(tt)) r.FkIndex[tt] = i;
            }
            _rigs[c] = r;
            return r;
        }

        // ---- accessories ----
        private sealed class Acc
        {
            public int Slot;
            public Transform Node;
            public string Name;
        }
        private readonly Dictionary<OCIChar, KeyValuePair<float, List<Acc>>> _accs = new Dictionary<OCIChar, KeyValuePair<float, List<Acc>>>();

        /// <summary>A character's accessories that can be adjusted (the ones with an "N_move" node), refreshed now and then.</summary>
        private List<Acc> AccsOf(OCIChar c)
        {
            if (c?.charInfo == null) return new List<Acc>();
            if (_accs.TryGetValue(c, out var hit) && Time.unscaledTime - hit.Key < 1.5f && hit.Value.All(a => a.Node != null)) return hit.Value;
            var list = new List<Acc>();
            GameObject[] objs;
            try { objs = AccessoriesApi.GetAccessoryObjects(c.charInfo) ?? new GameObject[0]; }
            catch { objs = new GameObject[0]; }
            var parts = c.charInfo.nowCoordinate?.accessory?.parts;
            for (int i = 0; i < objs.Length; i++)
            {
                var go = objs[i];
                if (go == null || !go.activeInHierarchy) continue;
                var node = FindChild(go.transform, "N_move");
                if (node == null) continue;
                string name = null;
                try
                {
                    if (parts != null && i < parts.Length && parts[i].type != 120)
                        name = c.charInfo.lstCtrl.GetListInfo((ChaListDefine.CategoryNo)parts[i].type, parts[i].id)?.Name;
                }
                catch { /* list lookups are best effort */ }
                if (!string.IsNullOrEmpty(name)) name = Translation.Peek(name) ?? name;
                list.Add(new Acc { Slot = i, Node = node, Name = (string.IsNullOrEmpty(name) ? "Accessory" : name) + " (slot " + (i + 1) + ")" });
            }
            _accs[c] = new KeyValuePair<float, List<Acc>>(Time.unscaledTime, list);
            return list;
        }

        private static Transform FindChild(Transform t, string name)
        {
            if (t.name == name) return t;
            for (int i = 0; i < t.childCount; i++)
            {
                var r = FindChild(t.GetChild(i), name);
                if (r != null) return r;
            }
            return null;
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
            var sel = SceneApi.SelectedIds();
            foreach (var id in sel)
                if (SceneApi.FindOci(Convert.ToInt32(id)) is OCIChar c && c.charInfo != null) yield return c;
            // the character whose bone / IK target / accessory has the handles stays shown
            if ((_kind == Kind.Bone || _kind == Kind.IK || _kind == Kind.Accessory) && SceneApi.FindOci(_ociId) is OCIChar t && t.charInfo != null && !sel.Contains(_ociId)) yield return t;
        }

        // ================================================================== FK / IK, without jumps

        private static int FkPart(OIBoneInfo.BoneGroup g)
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

        /// <summary>
        /// Studio's own switch makes FK and IK exclusive: turning one on turns the other off for the whole body, and
        /// every part that was ever ticked comes back with old values — the jumps. Here only the part being touched
        /// changes, the other mode stays on beside it (as KKPE's "FK &amp; IK" does), and each part starts from the pose
        /// on screen.
        /// </summary>
        private static void FkAlongside(OCIChar c)
        {
            c.fkCtrl.enabled = true;
            c.oiCharInfo.enableFK = true;
            for (int i = 0; i < FKCtrl.parts.Length; i++) c.ActiveFK(FKCtrl.parts[i], c.oiCharInfo.activeFK[i], true);
            for (int k = 0; k < 4; k++) c.preparation.pvCopy[k] = false; // what Studio sets while FK is on
        }

        private static void IkAlongside(OCIChar c)
        {
            c.finalIK.enabled = true;
            c.oiCharInfo.enableIK = true;
            for (int j = 0; j < 5; j++) c.ActiveIK((OIBoneInfo.BoneGroup)(1 << j), c.oiCharInfo.activeIK[j], true);
        }

        /// <summary>Before a bone is turned by hand: its part goes to FK from the pose it has now; an IK limb hands over.</summary>
        private static void EnsureFk(OCIChar c, int boneIndex)
        {
            var b = c.listBones[boneIndex];
            int part = FkPart(b.boneGroup);
            if (part < 0) return;
            var handOver = new List<OIBoneInfo.BoneGroup>();
            for (int i = 1; i < 5; i++)
            {
                var bit = (OIBoneInfo.BoneGroup)(1 << i);
                if ((b.boneGroup & bit) != 0 && IkOn(c, i)) handOver.Add(bit);
            }
            if (FkOn(c, part) && handOver.Count == 0) return;
            if (!c.oiCharInfo.enableFK)
            {
                c.fkCtrl.CopyBone(); // every FK bone from the pose on screen
                for (int i = 0; i < c.oiCharInfo.activeFK.Length; i++) c.oiCharInfo.activeFK[i] = i == part; // only this part
                bool ik = c.oiCharInfo.enableIK;
                c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, true, false); // (switches IK off…)
                if (ik) IkAlongside(c); // …so it comes straight back as it was
            }
            else
            {
                c.fkCtrl.CopyBone(FKCtrl.parts[part]);
                if (!FkOn(c, part)) c.ActiveFK(FKCtrl.parts[part], true, false);
            }
            foreach (var bit in handOver) c.ActiveIK(bit, false, false);
        }

        /// <summary>Before an IK target is moved by hand: IK for its limb only, every idle target where its bone is now.</summary>
        private static void EnsureIk(OCIChar c, int index)
        {
            var ik = c.listIKTarget[index];
            int part = IkPart(ik.boneGroup);
            if (part < 0 || IkOn(c, part)) return;
            foreach (var t in c.listIKTarget)
                if (!IkOn(c, IkPart(t.boneGroup))) t.CopyBone();
            if (!c.oiCharInfo.enableIK)
            {
                for (int j = 0; j < c.oiCharInfo.activeIK.Length; j++) c.oiCharInfo.activeIK[j] = j == part;
                bool fk = c.oiCharInfo.enableFK;
                c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, true, false); // (switches FK off…)
                if (fk) FkAlongside(c); // …so it comes straight back as it was
            }
            else c.ActiveIK((OIBoneInfo.BoneGroup)(1 << part), true, false);
        }

        /// <summary>FK / IK switches, so undo puts the character's mode back with the pose.</summary>
        private static Action KinematicsRestorer(OCIChar c)
        {
            bool fk = c.oiCharInfo.enableFK, ik = c.oiCharInfo.enableIK;
            var afk = (bool[])c.oiCharInfo.activeFK.Clone();
            var aik = (bool[])c.oiCharInfo.activeIK.Clone();
            return () =>
            {
                if (c?.charInfo == null) return;
                var info = c.oiCharInfo;
                bool same = info.enableFK == fk && info.enableIK == ik && info.activeFK.SequenceEqual(afk) && info.activeIK.SequenceEqual(aik);
                if (same) return;
                if (info.enableFK && !fk) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, false, false);
                if (info.enableIK && !ik) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, false, false);
                Array.Copy(afk, info.activeFK, Math.Min(afk.Length, info.activeFK.Length));
                Array.Copy(aik, info.activeIK, Math.Min(aik.Length, info.activeIK.Length));
                if (fk && !info.enableFK) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, true, false);
                if (ik && !info.enableIK) { if (info.enableFK) IkAlongside(c); else c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, true, false); }
                if (fk && ik && !info.enableFK) FkAlongside(c);
                if (info.enableFK) for (int i = 0; i < FKCtrl.parts.Length; i++) c.ActiveFK(FKCtrl.parts[i], info.activeFK[i], true);
                if (info.enableIK) for (int j = 0; j < 5; j++) c.ActiveIK((OIBoneInfo.BoneGroup)(1 << j), info.activeIK[j], true);
            };
        }

        /// <summary>A bone or IK target is about to change: record the character's FK / IK state, then take it over.</summary>
        private void TakeOver(Tgt t, Edit undo)
        {
            if (!(SceneApi.FindOci(_ociId) is OCIChar c)) return;
            if (_kind != Kind.Bone && _kind != Kind.IK) return;
            undo.Add(KinematicsRestorer(c), true);
            // the values FK / IK copy from the pose are part of the step too
            var before = new List<Action>();
            foreach (var b in c.listBones) if (b?.guideObject != null) before.Add(new GuideTgt(b.guideObject, Kind.Bone, null).CaptureNow());
            foreach (var k in c.listIKTarget) if (k?.guideObject != null) before.Add(new GuideTgt(k.guideObject, Kind.IK, null).CaptureNow());
            foreach (var a in before) undo.Add(a, false);
            if (_kind == Kind.Bone) EnsureFk(c, _index);
            else EnsureIk(c, _index);
        }

        /// <summary>One step in the shared undo history: put things back, in order (and redo the other way).</summary>
        private sealed class Edit : IUndoEntry
        {
            private readonly List<Action> _first = new List<Action>(), _then = new List<Action>();
            public Func<Edit> Inverse;
            public string Label { get; set; } = "Move in the viewport";
            public Edit(IEnumerable<Action> restore) => _then.AddRange(restore);
            public void Add(Action a, bool first) => (first ? _first : _then).Add(a);
            public IUndoEntry Restore()
            {
                var inv = Inverse?.Invoke();
                foreach (var a in _first) a();
                foreach (var a in _then) a();
                return inv;
            }
            public bool Absorbs(IUndoEntry next) => false;
        }

        /// <summary>The undo step for the target as it is now, able to make its own redo.</summary>
        private Edit Begin(Tgt t)
        {
            var e = t.Snapshot();
            var kind = _kind;
            int id = _ociId, index = _index;
            var me = this;
            e.Inverse = () =>
            {
                // redo: the state just before undoing
                var k0 = me._kind; int i0 = me._ociId, x0 = me._index;
                me._kind = kind; me._ociId = id; me._index = index;
                var now = me.Target();
                var r = now?.Snapshot();
                if (r != null && SceneApi.FindOci(id) is OCIChar c && (kind == Kind.Bone || kind == Kind.IK))
                {
                    r.Add(KinematicsRestorer(c), true);
                    foreach (var b in c.listBones) if (b?.guideObject != null) r.Add(new GuideTgt(b.guideObject, Kind.Bone, null).CaptureNow(), false);
                    foreach (var k in c.listIKTarget) if (k?.guideObject != null) r.Add(new GuideTgt(k.guideObject, Kind.IK, null).CaptureNow(), false);
                }
                me._kind = k0; me._ociId = i0; me._index = x0;
                if (r != null) r.Inverse = e.Inverse;
                return r;
            };
            return e;
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
            try
            {
                HookCamera();
                Step();
            }
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
            if (cam == null || !Any || Time.captureFramerate > 0)
            {
                if (_drag != H.None) EndDrag(true);
                _hover = H.None;
                _hoverList.Clear();
                _hoverPick = null;
                return;
            }
            if (_gizmo && !_hidAxis && Singleton<Studio.Studio>.Instance?.workInfo.visibleAxis == true) SyncStudioHandles();
            var m = Mouse;
            bool overUi = !_simMouse.HasValue && EventSystem.current != null && EventSystem.current.IsPointerOverGameObject();

            if (_drag != H.None)
            {
                if (Held) Drag(cam, m);
                if (Released || !Held) EndDrag(true);
                return;
            }
            // hover: the focus marker, handles, then pickable things
            _hover = overUi ? H.None : FocusHit(cam, m) ? H.Focus : _gizmo ? HitHandle(cam, m) : H.None;
            _hoverList = overUi ? new List<Cand>() : PickAt(cam, m, false);
            // a joint / IK target / accessory right under the pointer wins over a ring or arrow passing behind it
            if (_hover != H.None && _hover != H.Free && _hover != H.ScaleAll && _hover != H.Focus && _hoverList.Count > 0 && _hoverList[0].Tight && _hoverList[0].Key != CurrentKey())
                _hover = H.None;
            _hoverPick = _hover == H.None && _hoverList.Count > 0 ? _hoverList[0].Key : null;

            if (Pressed && !overUi)
            {
                _down = true;
                _moved = false;
                _downAt = m;
                if (_hover != H.None) BeginDrag(cam, m, _hover);
                else if (_hoverPick != null && _gizmo && (_hoverPick.StartsWith("ik:", StringComparison.Ordinal) || _hoverPick.StartsWith("acc:", StringComparison.Ordinal) && StudioMode() == 0))
                {
                    // grab an IK target (or, in Move, an accessory) and drag it straight away
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
                    var list = PickAt(cam, m, true);
                    if (list.Count > 0)
                    {
                        // clicking the same spot again steps to the next thing there (a wrist joint, then its IK target…)
                        int at = 0;
                        string cur = CurrentKey();
                        if ((m - _lastClickAt).magnitude < 8f && list.Count > 1)
                        {
                            int i = list.FindIndex(x => x.Key == cur);
                            if (i >= 0) at = (i + 1) % list.Count;
                        }
                        Select(list[at].Key);
                    }
                    else if (_kind == Kind.Bone || _kind == Kind.IK || _kind == Kind.Accessory) { _kind = Kind.None; Broadcast(); }
                    _lastClickAt = m;
                }
            }
            var sel = SceneApi.SelectedIds();
            // a bone / IK target / accessory stays the handles' target while its character is selected
            if ((_kind == Kind.Bone || _kind == Kind.IK || _kind == Kind.Accessory) && !sel.Contains(_ociId) && sel.Count > 0) { _kind = Kind.None; Broadcast(); }
            // the object gizmo follows Studio's selection unless a bone / IK target / accessory is picked
            if (_kind == Kind.None || _kind == Kind.Object)
            {
                int id = sel.Count == 1 ? Convert.ToInt32(sel[0]) : -1;
                if (id >= 0 && SceneApi.FindOci(id)?.guideObject != null) { _kind = Kind.Object; _ociId = id; }
                else if (_kind == Kind.Object) _kind = Kind.None;
            }
        }

        private string CurrentKey() =>
            _kind == Kind.Bone ? "joint:" + _ociId + ":" + _index : _kind == Kind.IK ? "ik:" + _ociId + ":" + _index : _kind == Kind.Accessory ? "acc:" + _ociId + ":" + _index : _kind == Kind.Object ? "object:" + _ociId : null;

        private void Select(string pick)
        {
            var p = pick.Split(':');
            int id = int.Parse(p[1]);
            var studio = Singleton<Studio.Studio>.Instance;
            var node = SceneApi.FindNode(id);
            if (node != null && !SceneApi.SelectedIds().Contains(id)) studio.treeNodeCtrl.SelectSingle(node, false);
            if (p[0] == "joint") { _kind = Kind.Bone; _ociId = id; _index = int.Parse(p[2]); }
            else if (p[0] == "ik") { _kind = Kind.IK; _ociId = id; _index = int.Parse(p[2]); }
            else if (p[0] == "acc") { _kind = Kind.Accessory; _ociId = id; _index = int.Parse(p[2]); }
            else { _kind = Kind.Object; _ociId = id; _index = -1; }
            Broadcast();
        }

        private void Broadcast() => StudioBridgePlugin.Instance?.Broadcast("gizmo.target", TargetInfo());

        // ---------------- Studio's camera: still while the pointer is on a handle ----------------

        private Studio.CameraControl.NoCtrlFunc _camOrig, _camWrap;
        private Studio.CameraControl _camOf;
        private bool _inWrap;

        /// <summary>
        /// Studio's camera starts turning on the press itself, so holding it only once a drag starts is a frame late:
        /// its "don't take the mouse" check also asks us — yes while the pointer is on a handle, or something is dragged.
        /// </summary>
        private void HookCamera()
        {
            var cc = Singleton<Studio.Studio>.Instance?.cameraCtrl;
            if (cc == null || (cc == _camOf && cc.noCtrlCondition == _camWrap && _camWrap != null)) return;
            _camOf = cc;
            _camOrig = cc.noCtrlCondition;
            _camWrap = () =>
            {
                if (_inWrap) return false;
                _inWrap = true;
                try { return BlockCamera() || (_camOrig != null && _camOrig()); }
                finally { _inWrap = false; }
            };
            cc.noCtrlCondition = _camWrap;
        }

        private void UnhookCamera()
        {
            if (_camOf != null && _camOf.noCtrlCondition == _camWrap) _camOf.noCtrlCondition = _camOrig;
            _camOf = null;
            _camWrap = null;
        }

        private bool BlockCamera()
        {
            if (_drag != H.None) return true;
            if (!Any || Time.captureFramerate > 0) return false;
            if (_hover != H.None) return true;
            // pressing an IK target (or an accessory in Move) grabs it
            return _gizmo && _hoverPick != null && (_hoverPick.StartsWith("ik:", StringComparison.Ordinal) || _hoverPick.StartsWith("acc:", StringComparison.Ordinal) && StudioMode() == 0);
        }

        // ---------------- picking ----------------

        private struct Cand
        {
            public string Key;
            public float Score; // lower is better
            public bool Tight;  // right on it (beats a handle passing behind)
        }

        private static bool OnScreen(Camera cam, Vector3 w, out Vector2 s)
        {
            var p = cam.WorldToScreenPoint(w);
            s = p;
            return p.z > 0.01f;
        }

        /// <summary>
        /// Everything under the pointer, best first: joints, IK targets, accessories, lights, cameras — then, for a
        /// click, items (the smallest outline). An IK target sitting on a joint is a ring around it: the middle picks
        /// the joint, the ring the target.
        /// </summary>
        private List<Cand> PickAt(Camera cam, Vector2 m, bool items)
        {
            var list = new List<Cand>();
            void Add(string key, float score, bool tight) => list.Add(new Cand { Key = key, Score = score, Tight = tight });
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio == null) return list;
            if (_show)
                foreach (var c in Shown())
                {
                    var rig = RigOf(c);
                    if (rig == null) continue;
                    int id = c.objectInfo.dicKey;
                    var joints = new List<Vector2>();
                    foreach (var kv in rig.Bones)
                    {
                        if (!rig.FkIndex.TryGetValue(kv.Value, out int fi) || !OnScreen(cam, kv.Value.position, out var s)) continue;
                        joints.Add(s);
                        if (!_skeleton || !_pickChars) continue;
                        float d = (s - m).magnitude, r = Finger(kv.Key) ? 6f : 8f;
                        if (d < r) Add("joint:" + id + ":" + fi, d, d < 5f);
                    }
                    if (_ik && _pickChars)
                        for (int i = 0; i < c.listIKTarget.Count; i++)
                        {
                            var t = c.listIKTarget[i]?.targetObject;
                            if (t == null || !OnScreen(cam, t.position, out var s)) continue;
                            bool onJoint = IkAnchor(joints, ref s);
                            float d = (s - m).magnitude;
                            if (onJoint)
                            {
                                // the ring around the joint
                                if (d >= 5f && d < 15f) Add("ik:" + id + ":" + i, Mathf.Abs(d - 10f) * 0.5f, true);
                                else if (d < 5f) Add("ik:" + id + ":" + i, 6f + d, false); // second in line (click again)
                            }
                            else if (d < 11f) Add("ik:" + id + ":" + i, d, d < 7f);
                        }
                    if (_acc && _pickAcc)
                        foreach (var a in AccsOf(c))
                        {
                            if (!OnScreen(cam, a.Node.position, out var s)) continue;
                            float d = (s - m).magnitude;
                            if (d < 8f) Add("acc:" + id + ":" + a.Slot, d + 0.5f, d < 5f);
                        }
                }
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                int id = oci.objectInfo.dicKey;
                if (oci is OCILight l && _show && _lights && _pickLights && l.light != null && OnScreen(cam, l.light.transform.position, out var ls) && (ls - m).magnitude < 13f) Add("object:" + id, (ls - m).magnitude, true);
                else if (oci is OCICamera oc && _show && _cameras && _pickCameras && oc.guideObject?.transformTarget != null && OnScreen(cam, oc.guideObject.transformTarget.position, out var cs) && (cs - m).magnitude < 13f) Add("object:" + id, (cs - m).magnitude, true);
            }
            list.Sort((a, b) => a.Score.CompareTo(b.Score));
            // items: inside their outline on screen, the smallest first
            if (_pickItems && items)
            {
                var eye = cam.transform.position;
                var its = new List<KeyValuePair<float, string>>();
                foreach (var oci in studio.dicObjectCtrl.Values)
                    if (oci is OCIItem it && it.objectItem != null && it.objectItem.activeInHierarchy && ScreenRect(cam, it.objectItem, out var r, out var wb) && !wb.Contains(eye) && r.Contains(m))
                        its.Add(new KeyValuePair<float, string>(r.width * r.height, "object:" + oci.objectInfo.dicKey));
                foreach (var kv in its.OrderBy(x => x.Key)) Add(kv.Value, 1000f + list.Count, false);
            }
            return list;
        }

        /// <summary>
        /// An IK target within a few pixels of a joint (a wrist, an ankle) is shown and picked as a ring around that
        /// joint — the joint in the middle, the target on the ring — so the two never fight for the same pixels.
        /// </summary>
        private bool IkAnchor(List<Vector2> joints, ref Vector2 s)
        {
            if (!_skeleton) return false;
            float best = 144f; // 12 px
            Vector2 at = s;
            bool found = false;
            foreach (var j in joints)
            {
                float dd = (j - s).sqrMagnitude;
                if (dd < best) { best = dd; at = j; found = true; }
            }
            s = at;
            return found;
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

        private bool Frame(out Tgt t, out Vector3 c, out Quaternion axes, out int mode)
        {
            t = Target();
            c = default;
            axes = Quaternion.identity;
            mode = StudioMode();
            if (t?.T == null) return false;
            c = t.T.position;
            if (_kind == Kind.Bone) { axes = t.T.rotation; mode = 1; }
            else if (_kind == Kind.IK) axes = _world || mode == 0 ? Quaternion.identity : t.T.rotation;
            else axes = _world ? Quaternion.identity : t.T.rotation;
            // what the target can do (FK bones only turn; some things can't scale)
            if (mode == 0 && !t.CanMove) mode = t.CanRotate ? 1 : -1;
            if (mode == 1 && !t.CanRotate) mode = t.CanMove ? 0 : -1;
            if (mode == 2 && !t.CanScale) mode = -1;
            return mode >= 0;
        }

        private const float Size = 92f, RingPx = 78f, ViewRing = 1.18f;

        /// <summary>An arrow pointing almost at the camera is only a few pixels long: grabbing it would fling things.</summary>
        private static bool AxisUsable(Vector2 sc, Vector2 se) => (se - sc).magnitude > Size * 0.22f;

        private H HitHandle(Camera cam, Vector2 m)
        {
            if (!Frame(out var t, out var c, out var axes, out int mode) || !OnScreen(cam, c, out var sc)) return H.None;
            float L = WorldPerPixel(cam, c, Size);
            if (mode == 0 || mode == 2)
            {
                if ((m - sc).magnitude < 11f) return mode == 0 ? H.Free : H.ScaleAll;
                H best = H.None;
                float bestD = 7f;
                for (int i = 0; i < 3; i++)
                {
                    if (!OnScreen(cam, c + axes * Axis(i) * L, out var se) || !AxisUsable(sc, se)) continue;
                    float d = DistToSegment(m, sc + (se - sc) * 0.12f, se + (se - sc).normalized * 12f);
                    if (d < bestD) { bestD = d; best = (H)((mode == 0 ? (int)H.AxisX : (int)H.ScaleX) + i); }
                }
                return best;
            }
            // rings — the middle moves what can move (a ring seen edge-on runs through it, so it isn't a ring there)
            float fromCentre = (m - sc).magnitude;
            if (fromCentre < 12f) return t.CanMove ? H.Free : H.None;
            float R = WorldPerPixel(cam, c, RingPx);
            float bestR = 7f;
            H ring = H.None;
            if (Mathf.Abs(fromCentre - RingPx * ViewRing) < 6f) { ring = H.RingView; bestR = Mathf.Abs(fromCentre - RingPx * ViewRing); }
            if (fromCentre >= 18f)
                for (int i = 0; i < 3; i++)
                {
                    float d = RingNearest(cam, m, c, axes * Axis(i), R, out _);
                    if (d < bestR) { bestR = d; ring = (H)((int)H.RingX + i); }
                }
            return ring;
        }

        private static Vector3 Axis(int i) => i == 0 ? Vector3.right : i == 1 ? Vector3.up : Vector3.forward;

        /// <summary>Two directions across a ring around `axis` — turning +θ about the axis takes u toward v.</summary>
        private static void RingBasis(Vector3 axis, out Vector3 u, out Vector3 v)
        {
            u = Vector3.Cross(axis, Mathf.Abs(Vector3.Dot(axis, Vector3.up)) > 0.9f ? Vector3.right : Vector3.up).normalized;
            v = Vector3.Cross(axis, u);
        }

        private static float DistToSegment(Vector2 p, Vector2 a, Vector2 b)
        {
            var ab = b - a;
            float t = Mathf.Clamp01(Vector2.Dot(p - a, ab) / Mathf.Max(1e-4f, ab.sqrMagnitude));
            return (a + ab * t - p).magnitude;
        }

        /// <summary>Pixels from the pointer to a ring on screen, and where on the ring (its angle) that is.</summary>
        private static float RingNearest(Camera cam, Vector2 m, Vector3 c, Vector3 axis, float r, out float at)
        {
            RingBasis(axis, out var u, out var v);
            float best = float.MaxValue;
            at = 0;
            Vector2 prev = default;
            bool has = false;
            const int n = 72;
            for (int k = 0; k <= n; k++)
            {
                float t = k / (float)n * Mathf.PI * 2f;
                if (!OnScreen(cam, c + (u * Mathf.Cos(t) + v * Mathf.Sin(t)) * r, out var s)) { has = false; continue; }
                if (has)
                {
                    float d = DistToSegment(m, prev, s);
                    if (d < best) { best = d; at = t; }
                }
                prev = s;
                has = true;
            }
            return best;
        }

        // ---------------- dragging ----------------

        private void BeginDrag(Camera cam, Vector2 m, H h)
        {
            if (h == H.Focus) { BeginFocus(cam, m); return; }
            if (!Frame(out var t, out var c, out var axes, out _)) return;
            var undo = Begin(t);
            TakeOver(t, undo);
            t = Target(); // FK / IK may have rebuilt what it points at
            if (t == null) return;
            _undo = undo;
            _drag = h;
            _dragTgt = t;
            _m0 = m;
            _angle = 0f;
            _startWorldPos = t.T.position;
            _startWorldRot = t.T.rotation;
            _startScale = t.Scale;
            int ax = h >= H.RingX && h <= H.RingZ ? h - H.RingX : h >= H.AxisX && h <= H.AxisZ ? h - H.AxisX : h >= H.ScaleX && h <= H.ScaleZ ? h - H.ScaleX : -1;
            _dragAxis = h == H.RingView ? (cam.transform.position - c).normalized : ax >= 0 ? (axes * Axis(ax)).normalized : Vector3.zero;
            _grabOffset = h == H.Free && Physicsless(cam, m, c, out var hitP) ? c - hitP : Vector3.zero;
            if (h >= H.AxisX && h <= H.AxisZ) _axisT0 = AxisParam(cam, m, c, _dragAxis) ?? 0f;
            if (h >= H.RingX && h <= H.RingView)
            {
                // turning follows the pointer along the ring where it was grabbed: steady, no flips near the middle
                _ringPx = h == H.RingView ? RingPx * ViewRing : RingPx;
                float R = WorldPerPixel(cam, c, _ringPx);
                RingNearest(cam, m, c, _dragAxis, R, out float at);
                RingBasis(_dragAxis, out var u, out var v);
                var p = c + (u * Mathf.Cos(at) + v * Mathf.Sin(at)) * R;
                var tan = -u * Mathf.Sin(at) + v * Mathf.Cos(at);
                OnScreen(cam, p, out var s0);
                OnScreen(cam, p + tan * R * 0.2f, out var s1);
                _tangent = s1 - s0;
                if (_tangent.sqrMagnitude < 1f)
                {
                    // seen edge-on there: go round the centre instead
                    OnScreen(cam, c, out var sc);
                    var r = m - sc;
                    _tangent = new Vector2(-r.y, r.x);
                    if (Vector3.Dot(_dragAxis, cam.transform.position - c) < 0) _tangent = -_tangent;
                }
                _tangent.Normalize();
            }
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

        /// <summary>Where along the line c + axis·t the pointer's ray passes closest (null when they're nearly parallel).</summary>
        private static float? AxisParam(Camera cam, Vector2 m, Vector3 c, Vector3 axis)
        {
            var ray = cam.ScreenPointToRay(m);
            Vector3 d = ray.direction, w0 = c - ray.origin;
            float b = Vector3.Dot(axis, d), dd = Vector3.Dot(axis, w0), e = Vector3.Dot(d, w0);
            float den = 1f - b * b;
            if (den < 0.02f) return null;
            return (b * e - dd) / den;
        }

        private void Drag(Camera cam, Vector2 m)
        {
            if (_drag == H.Focus) { DragFocus(cam, m); return; }
            var t = _dragTgt;
            if (t?.T == null) { EndDrag(false); return; }
            var c = _startWorldPos;
            float fine = Shift ? 0.25f : 1f;
            if (_drag == H.Free)
            {
                if (!Physicsless(cam, m, c, out var p)) return;
                var delta = (p + _grabOffset - c) * fine;
                if (Ctrl) delta = new Vector3(Snap(delta.x, _snapMove), Snap(delta.y, _snapMove), Snap(delta.z, _snapMove));
                t.MoveWorld(c + delta);
            }
            else if (_drag >= H.AxisX && _drag <= H.AxisZ)
            {
                // exactly where the pointer is along the arrow
                var s = AxisParam(cam, m, c, _dragAxis);
                if (!s.HasValue) return;
                float units = (s.Value - _axisT0) * fine;
                // never further than the pointer could mean: a few screens' worth at most
                float cap = WorldPerPixel(cam, c, Screen.height * 3f);
                units = Mathf.Clamp(units, -cap, cap);
                if (Ctrl) units = Snap(units, _snapMove);
                t.MoveWorld(c + _dragAxis * units);
            }
            else if (_drag >= H.RingX && _drag <= H.RingView)
            {
                float deg = Vector2.Dot(m - _m0, _tangent) / _ringPx * Mathf.Rad2Deg * fine;
                if (Ctrl) deg = Snap(deg, _snapRot);
                _angle = deg;
                t.TurnWorld(Quaternion.AngleAxis(deg, _dragAxis) * _startWorldRot);
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
                    f = 1f + Vector2.Dot(d, (s1 - s0).normalized) / 120f * fine;
                }
                f = Mathf.Max(0.01f, f);
                var sc0 = _startScale;
                Vector3 sv = _drag == H.ScaleAll ? sc0 * f : _drag == H.ScaleX ? new Vector3(sc0.x * f, sc0.y, sc0.z) : _drag == H.ScaleY ? new Vector3(sc0.x, sc0.y * f, sc0.z) : new Vector3(sc0.x, sc0.y, sc0.z * f);
                if (Ctrl) sv = new Vector3(Snap(sv.x, _snapScale), Snap(sv.y, _snapScale), Snap(sv.z, _snapScale));
                t.SetScale(sv);
            }
        }

        private static float Snap(float v, float step) => step > 0 ? Mathf.Round(v / step) * step : v;

        private void EndDrag(bool keep)
        {
            if (_drag == H.None) return;
            var was = _drag;
            _drag = H.None;
            if (was == H.Focus) { EndFocus(keep); _down = false; return; }
            if (_undo != null)
            {
                if (keep) UndoStack.Push(_undo);
                else _undo.Restore();
            }
            _undo = null;
            _dragTgt = null;
            _down = false;
            Broadcast();
        }

        // ================================================================== focus point (depth of field)

        private Vector3? _focusAnchor; // where manual focus was dropped (to draw it there, not in the middle)
        private bool _focusDrag;
        private string _focusSnapName;
        private int _focusSnapChara = -1;
        private Vector3 _focusAt;

        private static DepthOfField StudioDof(Camera cam)
        {
            var d = cam.GetComponent<DepthOfField>();
            return d != null && d.enabled ? d : null;
        }

        /// <summary>Where the picture is focused: Keyframe Studio's depth of field (any mode), else Studio's own.</summary>
        private bool FocusWorld(Camera cam, out Vector3 p, out bool ours)
        {
            p = default;
            ours = FxApi.DofOn;
            if (ours)
            {
                int mode = Mathf.RoundToInt(FxApi.Dof("autoFocus"));
                if (mode == 1 && Singleton<Studio.Studio>.Instance?.cameraCtrl != null) { p = Singleton<Studio.Studio>.Instance.cameraCtrl.targetPos; return true; }
                if (mode == 2)
                {
                    var c = SceneApi.FindOci(Mathf.RoundToInt(FxApi.Dof("chara"))) as OCIChar
                        ?? Singleton<Studio.Studio>.Instance?.dicObjectCtrl.OrderBy(kv => kv.Key).Select(kv => kv.Value as OCIChar).FirstOrDefault(x => x != null);
                    var eyes = RigOf(c)?.Eyes;
                    if (eyes != null) { p = eyes.position; return true; }
                }
                float focus = FxApi.Dof("focus");
                var fwd = cam.transform.forward;
                if (_focusAnchor.HasValue && Mathf.Abs(Vector3.Dot(_focusAnchor.Value - cam.transform.position, fwd) - focus) < Mathf.Max(0.01f, focus * 0.01f) && OnScreen(cam, _focusAnchor.Value, out _))
                    p = _focusAnchor.Value;
                else p = cam.transform.position + fwd * focus;
                return true;
            }
            var sd = StudioDof(cam);
            if (sd == null) return false;
            p = sd.focalTransform != null ? sd.focalTransform.position : cam.transform.position + cam.transform.forward * sd.focalLength;
            return true;
        }

        private bool FocusShown => _show && _focus;

        private bool FocusHit(Camera cam, Vector2 m) =>
            FocusShown && FocusWorld(cam, out var p, out bool ours) && ours && OnScreen(cam, p, out var s) && (s - m).magnitude < 17f;

        private void BeginFocus(Camera cam, Vector2 m)
        {
            _drag = H.Focus;
            _focusDrag = true;
            _focusSnapName = null;
            _focusSnapChara = -1;
            DragFocus(cam, m);
        }

        /// <summary>
        /// Dragging the focus marker: over a joint, an eye or an item it snaps to that point's distance; elsewhere it
        /// keeps the distance it has. Blur follows live.
        /// </summary>
        private void DragFocus(Camera cam, Vector2 m)
        {
            float focus = FxApi.Dof("focus");
            var ray = cam.ScreenPointToRay(m);
            var fwd = cam.transform.forward;
            Vector3? best = null;
            float bestD = 26f;
            string name = null;
            int chara = -1;
            var studio = Singleton<Studio.Studio>.Instance;
            foreach (var oci in studio.dicObjectCtrl.Values)
            {
                if (!(oci is OCIChar c) || c.charInfo == null || !c.charInfo.visibleAll) continue;
                var rig = RigOf(c);
                if (rig == null) continue;
                if (rig.Eyes != null && OnScreen(cam, rig.Eyes.position, out var es) && (es - m).magnitude < bestD + 6f)
                {
                    bestD = (es - m).magnitude - 6f; // eyes win a near tie: they're what people focus on
                    best = rig.Eyes.position; name = "Eyes"; chara = c.objectInfo.dicKey;
                }
                foreach (var kv in rig.Bones)
                    if (OnScreen(cam, kv.Value.position, out var s) && (s - m).magnitude < bestD)
                    {
                        bestD = (s - m).magnitude;
                        // the head means the eyes: what a portrait focuses on (and they keep being followed)
                        if ((kv.Key == "cf_j_head" || kv.Key == "cf_j_neck") && rig.Eyes != null) { best = rig.Eyes.position; name = "Eyes"; chara = c.objectInfo.dicKey; }
                        else { best = kv.Value.position; name = Pretty(kv.Key); chara = -1; }
                    }
            }
            if (!best.HasValue)
            {
                float area = float.MaxValue;
                foreach (var oci in studio.dicObjectCtrl.Values)
                    if (oci is OCIItem it && it.objectItem != null && it.objectItem.activeInHierarchy && ScreenRect(cam, it.objectItem, out var r, out var wb) && r.Contains(m) && r.width * r.height < area && !wb.Contains(cam.transform.position))
                    {
                        area = r.width * r.height;
                        best = wb.center;
                        name = oci.treeNodeObject != null ? oci.treeNodeObject.textName : "Item";
                    }
            }
            float depth = best.HasValue ? Vector3.Dot(best.Value - cam.transform.position, fwd) : focus;
            depth = Mathf.Clamp(depth, 0.05f, 500f);
            // the marker sits under the pointer at that distance
            float along = Vector3.Dot(ray.direction, fwd);
            _focusAt = along > 0.01f ? cam.transform.position + ray.direction * (depth / along) : cam.transform.position + fwd * depth;
            _focusSnapName = name;
            _focusSnapChara = chara;
            if (Mathf.RoundToInt(FxApi.Dof("autoFocus")) != 0 || Mathf.Abs(depth - focus) > 0.001f)
                FxApi.SetDof(new Dictionary<string, object> { { "autoFocus", 0.0 }, { "focus", (double)depth } });
            _focusAnchor = _focusAt;
        }

        private void EndFocus(bool keep)
        {
            _focusDrag = false;
            // dropped on the eyes: keep following them as the character moves
            if (keep && _focusSnapName == "Eyes" && _focusSnapChara >= 0)
                FxApi.SetDof(new Dictionary<string, object> { { "autoFocus", 2.0 }, { "chara", (double)_focusSnapChara } });
            _focusSnapName = null;
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
                if (_show && (_skeleton || _ik || _acc)) foreach (var c in Shown()) DrawRig(cam, c);
                if (_gizmo) DrawGizmo(cam);
                if (FocusShown) DrawFocus(cam);
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
        private static void DiamondOutline(Vector2 c, float r, float w, Color col)
        {
            Vector2 t = new Vector2(c.x, c.y + r), rr = new Vector2(c.x + r, c.y), b = new Vector2(c.x, c.y - r), l = new Vector2(c.x - r, c.y);
            Line(t, rr, w, col); Line(rr, b, w, col); Line(b, l, w, col); Line(l, t, w, col);
        }
        private static void DiamondFill(Vector2 c, float r, Color fill)
        {
            GL.Begin(GL.QUADS);
            GL.Color(fill);
            GL.Vertex3(c.x, c.y + r, 0); GL.Vertex3(c.x + r, c.y, 0); GL.Vertex3(c.x, c.y - r, 0); GL.Vertex3(c.x - r, c.y, 0);
            GL.End();
        }
        private static void Square(Vector2 c, float r, Color fill)
        {
            GL.Begin(GL.QUADS);
            GL.Color(fill);
            GL.Vertex3(c.x - r, c.y - r, 0); GL.Vertex3(c.x + r, c.y - r, 0); GL.Vertex3(c.x + r, c.y + r, 0); GL.Vertex3(c.x - r, c.y + r, 0);
            GL.End();
        }
        private static Color A(Color c, float a) => new Color(c.r, c.g, c.b, a);

        /// <summary>A circle in 3D: the half facing the viewer drawn strong, the far half faint.</summary>
        private static void Circle3(Camera cam, Vector3 c, Vector3 axis, float r, float w, Color col, bool hot)
        {
            RingBasis(axis, out var u, out var v);
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

        // ---- skeleton, IK targets, accessories ----
        private void DrawRig(Camera cam, OCIChar c)
        {
            var rig = RigOf(c);
            if (rig == null) return;
            int id = c.objectInfo.dicKey;
            var joints = new List<Vector2>();
            foreach (var kv in rig.Bones)
                if (rig.FkIndex.ContainsKey(kv.Value) && OnScreen(cam, kv.Value.position, out var js)) joints.Add(js);
            if (_skeleton)
            {
                foreach (var chain in Chains)
                    for (int i = 0; i + 1 < chain.Length; i++)
                    {
                        if (!rig.Bones.TryGetValue(chain[i], out var a) || !rig.Bones.TryGetValue(chain[i + 1], out var b)) continue;
                        if (!OnScreen(cam, a.position, out var sa) || !OnScreen(cam, b.position, out var sb)) continue;
                        bool finger = Finger(chain[i + 1]);
                        bool fk = rig.FkIndex.TryGetValue(b, out int bi) && FkOn(c, FkPart(c.listBones[bi].boneGroup));
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
                    bool fk = FkOn(c, FkPart(c.listBones[fi].boneGroup));
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
                    // on a joint: a hollow diamond around it (the joint stays clickable in the middle)
                    bool around = IkAnchor(joints, ref s);
                    float r = around ? (hov ? 12f : 10.5f) : (hov ? 8f : 6.5f);
                    var col = sel ? Accent : hov ? Color.white : A(IkCol, on ? 1f : 0.65f);
                    if (!around) DiamondFill(s, r, sel ? A(Accent, 0.9f) : on ? A(IkCol, 0.85f) : A(IkCol, 0.15f));
                    DiamondOutline(s, r, (hov || sel ? 2.4f : 1.6f) + 2f, new Color(0, 0, 0, 0.45f));
                    DiamondOutline(s, r, hov || sel ? 2.4f : 1.6f, col);
                }
            if (_acc)
                foreach (var a in AccsOf(c))
                {
                    if (!OnScreen(cam, a.Node.position, out var s)) continue;
                    string key = "acc:" + id + ":" + a.Slot;
                    bool sel = _kind == Kind.Accessory && _ociId == id && _index == a.Slot;
                    bool hov = _hoverPick == key;
                    float r = hov || sel ? 5.5f : 4.2f;
                    Square(s, r + 1.5f, new Color(0, 0, 0, 0.5f));
                    Square(s, r, sel ? Accent : hov ? Color.white : A(AccCol, 0.9f));
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

        // ---- the focus point: a camera-style reticle ----
        private void DrawFocus(Camera cam)
        {
            Vector3 p;
            bool ours;
            if (_drag == H.Focus) { p = _focusAt; ours = true; }
            else if (!FocusWorld(cam, out p, out ours)) return;
            if (!OnScreen(cam, p, out var s)) return;
            bool hot = _drag == H.Focus || _hover == H.Focus;
            var col = ours ? A(FocusCol, hot ? 1f : 0.85f) : new Color(0.8f, 0.85f, 0.9f, 0.6f);
            float r = hot ? 16f : 13f;
            Circle2(s, r, 3.5f, new Color(0, 0, 0, 0.35f));
            Circle2(s, r, 1.8f, col);
            for (int k = 0; k < 4; k++)
            {
                var d = new Vector2(Mathf.Cos(k * Mathf.PI / 2), Mathf.Sin(k * Mathf.PI / 2));
                Line(s + d * (r - 5f), s + d * (r + 5f), 2f, col);
            }
            Disc(s, 2f, col);
            if (_drag == H.Focus)
            {
                _tag = "Focus " + FxApi.Dof("focus").ToString("0.00") + " m" + (_focusSnapName != null ? " · " + _focusSnapName : "");
                _tagAt = s;
            }
        }

        // ---- the handles ----
        private void DrawGizmo(Camera cam)
        {
            if (!Frame(out var t, out var c, out var axes, out int mode) || !OnScreen(cam, c, out var sc)) return;
            var active = _drag != H.None ? _drag : _hover;
            if (mode == 1)
            {
                float R = WorldPerPixel(cam, c, RingPx);
                Circle2(sc, RingPx * ViewRing, active == H.RingView ? 3f : 1.6f, active == H.RingView ? Accent : new Color(1, 1, 1, 0.55f));
                for (int i = 0; i < 3; i++)
                {
                    var h = (H)((int)H.RingX + i);
                    var col = i == 0 ? X : i == 1 ? Y : Z;
                    if (_drag != H.None && _drag != h && _drag != H.RingView) col = A(col, 0.2f); // while turning one, the others step back
                    Circle3(cam, c, axes * Axis(i), R, 2.2f, active == h ? Color.Lerp(col, Color.white, 0.35f) : col, active == h);
                }
                if (_drag >= H.RingX && _drag <= H.RingView)
                {
                    Disc(sc, 3f, Color.white);
                    _tag = _angle.ToString("0.0") + "°";
                    _tagAt = sc;
                }
                if (t.CanMove)
                {
                    bool hot = active == H.Free;
                    Disc(sc, hot ? 8f : 6.5f, new Color(0, 0, 0, 0.5f));
                    Circle2(sc, hot ? 7f : 5.5f, 2f, hot ? Accent : Color.white);
                    if (_drag == H.Free) { _tag = (t.T.position - _startWorldPos).magnitude.ToString("0.000") + " m"; _tagAt = sc; }
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
                bool usable = AxisUsable(sc, e);
                if (!usable) col = A(col, 0.18f); // pointing at you: too short to grab
                else if (_drag != H.None && !hot) col = A(col, 0.25f);
                var cc = hot ? Color.Lerp(col, Color.white, 0.35f) : col;
                Line(sc + (e - sc) * 0.12f, e, hot ? 3.5f : 2.5f, cc);
                var dir = (e - sc).normalized;
                var n = new Vector2(-dir.y, dir.x);
                if (mode == 0)
                {
                    GL.Begin(GL.TRIANGLES);
                    GL.Color(cc);
                    GL.Vertex3(e.x + dir.x * 12, e.y + dir.y * 12, 0);
                    GL.Vertex3(e.x + n.x * 5.5f, e.y + n.y * 5.5f, 0);
                    GL.Vertex3(e.x - n.x * 5.5f, e.y - n.y * 5.5f, 0);
                    GL.End();
                }
                else Square(e, 5f, cc);
            }
            var center = mode == 0 ? H.Free : H.ScaleAll;
            bool cHot = active == center;
            Disc(sc, cHot ? 8f : 6.5f, new Color(0, 0, 0, 0.5f));
            Circle2(sc, cHot ? 7f : 5.5f, 2f, cHot ? Accent : Color.white);
            if (_drag != H.None && _drag != H.Focus && !(_drag >= H.RingX && _drag <= H.RingView))
            {
                var s = t.Scale;
                _tag = mode == 2 ? "×" + s.x.ToString("0.00") + (Mathf.Approximately(s.x, s.y) && Mathf.Approximately(s.y, s.z) ? "" : " " + s.y.ToString("0.00") + " " + s.z.ToString("0.00"))
                    : (t.T.position - _startWorldPos).magnitude.ToString("0.000") + " m";
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

        private string LabelOf(string key)
        {
            var p = key.Split(':');
            var oci = SceneApi.FindOci(int.Parse(p[1]));
            if (oci == null) return null;
            if (p[0] == "joint" && oci is OCIChar c && int.Parse(p[2]) < c.listBones.Count) return Pretty(c.listBones[int.Parse(p[2])].guideObject?.transformTarget?.name);
            if (p[0] == "ik" && oci is OCIChar ci && int.Parse(p[2]) < ci.listIKTarget.Count) return "IK " + Pretty(ci.listIKTarget[int.Parse(p[2])].targetObject?.name);
            if (p[0] == "acc" && oci is OCIChar ca) return AccsOf(ca).FirstOrDefault(x => x.Slot == int.Parse(p[2]))?.Name;
            return oci.treeNodeObject != null ? oci.treeNodeObject.textName : null;
        }

        private string HoverLabel()
        {
            if (_hover == H.Focus) return "Focus " + FxApi.Dof("focus").ToString("0.00") + " m — drag onto what should be sharp";
            if (_hoverPick == null) return null;
            var top = LabelOf(_hoverPick);
            // more here: say what a second click gets
            var more = _hoverList.Where(x => x.Score < 1000f && x.Key != _hoverPick).Select(x => LabelOf(x.Key)).FirstOrDefault(x => x != null);
            return more != null ? top + "   (click again: " + more + ")" : top;
        }

        // ================================================================== tests

        private object Simulate(Dictionary<string, object> a)
        {
            var cam = Camera.main;
            if (a.ContainsKey("project") && cam != null)
            {
                var p = a.GetList("project");
                return V(cam.WorldToScreenPoint(new Vector3(Convert.ToSingle(p[0]), Convert.ToSingle(p[1]), Convert.ToSingle(p[2]))));
            }
            // where a character's bone / IK target / accessory is: {id, bone: "cf_j_forearm01_L"} | {id, ik: index} | {id, accessories: true}
            if (a.Has("bone") || a.Has("ik") || a.Has("accessories"))
            {
                if (!(SceneApi.FindOci(a.GetInt("id", -1)) is OCIChar c) || cam == null) throw new Exception("no such character");
                if (a.Has("accessories"))
                    return AccsOf(c).Select(x => (object)new Dictionary<string, object> { { "slot", x.Slot }, { "name", x.Name }, { "screen", V(cam.WorldToScreenPoint(x.Node.position)) }, { "world", V(x.Node.position) } }).ToList();
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
                var hips = RigOf(c)?.Bones.TryGetValue("cf_j_hips", out var h) == true ? h.position : Vector3.zero;
                return new Dictionary<string, object>
                {
                    { "index", index }, { "screen", V(cam.WorldToScreenPoint(t.position)) }, { "world", V(t.position) },
                    { "worldRot", V(t.rotation.eulerAngles) }, { "rot", V(g.changeAmount.rot) }, { "pos", V(g.changeAmount.pos) },
                    { "hips", V(hips) },
                    { "fk", c.oiCharInfo.enableFK }, { "activeFK", c.oiCharInfo.activeFK.Select(x => (object)x).ToList() },
                    { "ik", c.oiCharInfo.enableIK }, { "activeIK", c.oiCharInfo.activeIK.Select(x => (object)x).ToList() },
                };
            }
            if (a.Has("focus") && cam != null)
            {
                bool ok = FocusWorld(cam, out var fp, out bool ours);
                return new Dictionary<string, object> { { "shown", ok }, { "ours", ours }, { "screen", ok ? V(cam.WorldToScreenPoint(fp)) : null }, { "focus", FxApi.DofOn ? (double)FxApi.Dof("focus") : -1.0 }, { "mode", FxApi.DofOn ? (double)FxApi.Dof("autoFocus") : -1.0 } };
            }
            if (a.GetBool("end")) { _simMouse = null; _simHeld = false; _simDown = _simUp = false; return State(); }
            var at = a.GetList("at");
            if (at.Count >= 2) _simMouse = new Vector2(Convert.ToSingle(at[0]), Convert.ToSingle(at[1]));
            if (a.GetBool("press")) { _simDown = true; _simHeld = true; }
            if (a.GetBool("release")) { _simUp = true; _simHeld = false; }
            var st = State();
            st["hover"] = _hover.ToString();
            st["hoverPick"] = _hoverPick;
            st["hoverAll"] = _hoverList.Select(x => (object)x.Key).ToList();
            st["anchor"] = Anchor();
            st["screen"] = new List<object> { Screen.width, Screen.height };
            st["cameraBlocked"] = BlockCamera();
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
