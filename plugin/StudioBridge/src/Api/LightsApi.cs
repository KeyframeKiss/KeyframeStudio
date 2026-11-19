using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using BepInEx.Bootstrap;
using ExtensibleSaveFormat;
using HarmonyLib;
using KKAPI.Studio.SaveLoad;
using KKAPI.Utilities;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Projectors (light / shadow shapes cast onto characters and the set) and lights that keep aiming at a
    /// character. A projector lives on a Studio folder, so it's moved and rotated with Studio's own handles,
    /// animated like any object, and deleted like one. Both are saved with the scene and undoable.
    /// LightManager (when installed) does the aiming at a character's body in its own saved format.
    /// </summary>
    internal static class LightsApi
    {
        private const string LightManagerGuid = "keelhauled.lightmanager";
        public static readonly string[] Shapes = { "circle", "ring", "heart", "star", "blinds", "window", "leaves" };
        public static readonly string[] Modes = { "light", "shadow", "paint" };

        public static void Register(CommandRouter r)
        {
            r.Add("proj.list", a => List());
            r.Add("proj.add", Add);
            r.Add("proj.set", SetProj);
            // shader debug view: 0 off, 1 solid, 2 projected uv, 3 distance, 4 facing
            r.Add("proj.debug", a => { foreach (var kv in ProjectorFolders()) ProjectorOf(kv.Value).Debug(a.GetFloat("mode")); return true; });
            r.Add("aim.list", a => AimList());
            r.Add("aim.set", SetAim);
            if (TimelineApi.Available)
            {
                try { RegisterTracks(); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Projectors can't be animated (Timeline): " + e.Message); }
            }
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Projectors / aimed lights won't be saved with scenes (KKAPI): " + e.Message); }
        }

        private static Studio.Studio S => Singleton<Studio.Studio>.Instance;

        // ================================================================== projectors

        internal sealed class ProjData
        {
            public string Shape = "circle", Mode = "light", Target = "all";
            public float[] Color = { 1f, 0.85f, 0.6f, 0.8f };
            public float Angle = 30f, Range = 12f, Soft = 0.3f, Falloff = 0.4f, Count = 6f, Spin = 0f;

            public ProjData Copy() { var d = (ProjData)MemberwiseClone(); d.Color = (float[])Color.Clone(); return d; }

            public Dictionary<string, object> Wire() => new Dictionary<string, object>
            {
                { "shape", Shape }, { "mode", Mode }, { "target", Target },
                { "color", Color.Select(x => (object)(double)x).ToList() },
                { "angle", (double)Angle }, { "range", (double)Range }, { "soft", (double)Soft }, { "falloff", (double)Falloff },
                { "count", (double)Count }, { "spin", (double)Spin },
            };

            public void Read(Dictionary<string, object> v)
            {
                float F(string k, float cur, float lo, float hi) => v.ContainsKey(k) ? Mathf.Clamp(Convert.ToSingle(v[k], CultureInfo.InvariantCulture), lo, hi) : cur;
                if (v.ContainsKey("shape")) Shape = Shapes.Contains(Convert.ToString(v["shape"])) ? Convert.ToString(v["shape"]) : throw new BridgeException("Unknown shape");
                if (v.ContainsKey("mode")) Mode = Modes.Contains(Convert.ToString(v["mode"])) ? Convert.ToString(v["mode"]) : throw new BridgeException("Unknown mode");
                if (v.ContainsKey("target")) Target = new[] { "all", "chars", "set" }.Contains(Convert.ToString(v["target"])) ? Convert.ToString(v["target"]) : throw new BridgeException("Unknown target");
                if (v.ContainsKey("color") && v["color"] is List<object> c && c.Count >= 3)
                    Color = Enumerable.Range(0, 4).Select(i => i < c.Count ? Convert.ToSingle(c[i], CultureInfo.InvariantCulture) : Color[i]).ToArray();
                Angle = F("angle", Angle, 2, 120);
                Range = F("range", Range, 0.5f, 100);
                Soft = F("soft", Soft, 0, 1);
                Falloff = F("falloff", Falloff, 0, 1);
                Count = F("count", Count, 2, 24);
                Spin = F("spin", Spin, -360, 360);
            }
        }

        /// <summary>The projector on a folder's object (a child, so the folder's own transform stays Studio's).</summary>
        internal sealed class KfProjector : MonoBehaviour
        {
            public ProjData Data = new ProjData();
            public OCIFolder Folder;
            private Projector _p;
            private Material _m;

            private void Awake()
            {
                _p = gameObject.AddComponent<Projector>();
                _m = new Material(FxApi.GetShader("Projector")) { hideFlags = HideFlags.DontSave };
                _p.material = _m;
                _p.nearClipPlane = 0.05f;
                Apply();
            }

            private void OnDestroy() { if (_m != null) Destroy(_m); }

            // Studio folders don't hide anything themselves: follow the folder's eye in the scene list
            private void LateUpdate()
            {
                if (_p == null) return;
                bool on = Folder?.treeNodeObject == null || Folder.treeNodeObject.visible;
                if (_p.enabled != on) _p.enabled = on;
                if (on) _m.SetVector("_KfProjDir", transform.forward);
                // Unity skips projectors on layers the camera doesn't draw, and Studio's camera leaves out Default
                var cam = Camera.main;
                if (cam != null && (cam.cullingMask & (1 << gameObject.layer)) == 0)
                    for (int i = 0; i < 32; i++)
                        if ((cam.cullingMask & (1 << i)) != 0 && i != 10) { gameObject.layer = i; break; }
            }

            public Dictionary<string, object> Diag() => new Dictionary<string, object>
            {
                { "active", isActiveAndEnabled }, { "projector", _p != null && _p.isActiveAndEnabled },
                { "pos", new List<object> { (double)transform.position.x, (double)transform.position.y, (double)transform.position.z } },
                { "fwd", new List<object> { (double)transform.forward.x, (double)transform.forward.y, (double)transform.forward.z } },
                { "shader", _m != null && _m.shader != null ? _m.shader.name + (_m.shader.isSupported ? "" : " (unsupported)") : "none" },
                { "layer", gameObject.layer },
            };

            public void Debug(float mode)
            {
                if (_m == null) return;
                _m.SetFloat("_KfDebug", mode);
                if (mode > 0.5) { _m.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One); _m.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.Zero); }
                else Apply();
            }

            public void Apply()
            {
                if (_p == null) return;
                _p.fieldOfView = Data.Angle;
                _p.farClipPlane = Data.Range;
                _p.aspectRatio = 1;
                // characters are on layer 10
                _p.ignoreLayers = Data.Target == "chars" ? ~(1 << 10) : Data.Target == "set" ? 1 << 10 : 0;
                _m.SetColor("_KfColor", new Color(Data.Color[0], Data.Color[1], Data.Color[2], Data.Color[3]));
                _m.SetFloat("_KfShape", Array.IndexOf(Shapes, Data.Shape));
                _m.SetFloat("_KfSoft", Data.Soft);
                _m.SetFloat("_KfFalloff", Data.Falloff);
                _m.SetFloat("_KfCount", Data.Count);
                _m.SetFloat("_KfSpin", Data.Spin * Mathf.Deg2Rad);
                bool mul = Data.Mode == "shadow";
                _m.SetFloat("_KfMul", mul ? 1 : 0);
                // light: add; shadow: multiply; paint: alpha blend
                _m.SetFloat("_SrcBlend", (float)(mul ? UnityEngine.Rendering.BlendMode.DstColor : Data.Mode == "paint" ? UnityEngine.Rendering.BlendMode.SrcAlpha : UnityEngine.Rendering.BlendMode.One));
                _m.SetFloat("_DstBlend", (float)(mul ? UnityEngine.Rendering.BlendMode.Zero : Data.Mode == "paint" ? UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha : UnityEngine.Rendering.BlendMode.One));
            }
        }

        private static KfProjector ProjectorOf(OCIFolder f) => f?.objectItem != null ? f.objectItem.GetComponentInChildren<KfProjector>(true) : null;

        private static KfProjector Attach(OCIFolder f, ProjData d)
        {
            var existing = ProjectorOf(f);
            if (existing != null) { existing.Data = d.Copy(); existing.Apply(); return existing; }
            var go = new GameObject("KF Projector");
            go.transform.SetParent(f.objectItem.transform, false);
            var p = go.AddComponent<KfProjector>();
            p.Folder = f;
            p.Data = d.Copy();
            p.Apply();
            return p;
        }

        private static IEnumerable<KeyValuePair<int, OCIFolder>> ProjectorFolders() =>
            S.dicObjectCtrl.Where(kv => kv.Value is OCIFolder f && ProjectorOf(f) != null).Select(kv => new KeyValuePair<int, OCIFolder>(kv.Key, (OCIFolder)kv.Value));

        private static object List() => new Dictionary<string, object>
        {
            { "items", ProjectorFolders().Select(kv => (object)new Dictionary<string, object>
                {
                    { "id", kv.Key }, { "name", kv.Value.name },
                    { "visible", kv.Value.treeNodeObject != null && kv.Value.treeNodeObject.visible },
                    { "values", ProjectorOf(kv.Value).Data.Wire() },
                    { "diag", ProjectorOf(kv.Value).Diag() },
                }).ToList() },
            { "shapes", Shapes.Cast<object>().ToList() },
            { "modes", Modes.Cast<object>().ToList() },
        };

        // ------------------------------------------------------------------ for looks: relative to a character

        /// <summary>Projectors in the scene, positioned relative to <paramref name="anchor"/> (or the world when null).</summary>
        public static List<object> CaptureProjectors(Transform anchor)
        {
            var list = new List<object>();
            foreach (var kv in ProjectorFolders())
            {
                var t = kv.Value.objectItem.transform;
                var pos = anchor != null ? Quaternion.Inverse(Yaw(anchor)) * (t.position - anchor.position) : t.position;
                var rot = anchor != null ? Quaternion.Inverse(Yaw(anchor)) * t.rotation : t.rotation;
                list.Add(new Dictionary<string, object>
                {
                    { "values", ProjectorOf(kv.Value).Data.Wire() }, { "visible", kv.Value.treeNodeObject == null || kv.Value.treeNodeObject.visible },
                    { "pos", new List<object> { (double)pos.x, (double)pos.y, (double)pos.z } }, { "rot", new List<object> { (double)rot.eulerAngles.x, (double)rot.eulerAngles.y, (double)rot.eulerAngles.z } },
                    { "relative", anchor != null },
                });
            }
            return list;
        }

        /// <summary>Same settings and (within a centimetre / half a degree) the same place.</summary>
        private static bool SameProjector(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            if (Json.Serialize(a["values"]) != Json.Serialize(b["values"])) return false;
            float[] V(Dictionary<string, object> d, string k) => ((List<object>)d[k]).Select(x => Convert.ToSingle(x, CultureInfo.InvariantCulture)).ToArray();
            var pa = V(a, "pos"); var pb = V(b, "pos");
            var ra = Quaternion.Euler(V(a, "rot")[0], V(a, "rot")[1], V(a, "rot")[2]);
            var rb = Quaternion.Euler(V(b, "rot")[0], V(b, "rot")[1], V(b, "rot")[2]);
            return Vector3.Distance(new Vector3(pa[0], pa[1], pa[2]), new Vector3(pb[0], pb[1], pb[2])) < 0.01f && Quaternion.Angle(ra, rb) < 0.5f;
        }

        private static Quaternion Yaw(Transform t) => Quaternion.Euler(0, t.eulerAngles.y, 0);

        /// <summary>Add a look's projectors (skipping ones already there with the same values and place). Undoable.</summary>
        public static int AddProjectors(List<object> list, Transform anchor)
        {
            int n = 0;
            var existing = CaptureProjectors(anchor).OfType<Dictionary<string, object>>().ToList();
            foreach (var o in list.OfType<Dictionary<string, object>>())
            {
                if (existing.Any(e => SameProjector(e, o))) continue; // applying a look twice shouldn't double it
                var d = new ProjData();
                if (o["values"] is Dictionary<string, object> v) d.Read(v);
                var p = (o["pos"] as List<object>)?.Select(x => Convert.ToSingle(x, CultureInfo.InvariantCulture)).ToArray() ?? new float[3];
                var r = (o["rot"] as List<object>)?.Select(x => Convert.ToSingle(x, CultureInfo.InvariantCulture)).ToArray() ?? new float[3];
                Vector3 pos = new Vector3(p[0], p[1], p[2]);
                Quaternion rot = Quaternion.Euler(r[0], r[1], r[2]);
                if (o.GetBool("relative") && anchor != null) { pos = anchor.position + Yaw(anchor) * pos; rot = Yaw(anchor) * rot; }
                var f = AddObjectFolder.Add();
                f.name = Title(d);
                f.objectInfo.changeAmount.pos = pos;
                f.objectInfo.changeAmount.rot = rot.eulerAngles;
                Attach(f, d);
                if (!o.GetBool("visible", true) && f.treeNodeObject != null) f.treeNodeObject.SetVisible(false);
                UndoStack.Push(new ProjAddUndo(f, d));
                n++;
            }
            return n;
        }

        private static string Title(ProjData d) =>
            "Projector · " + char.ToUpperInvariant(d.Shape[0]) + d.Shape.Substring(1) + (d.Mode == "light" ? "" : " " + d.Mode);

        /// <summary>args: {values?} — a new projector above and in front of what the camera looks at, aimed at it.</summary>
        private static object Add(Dictionary<string, object> a)
        {
            var d = new ProjData();
            if (a.ContainsKey("values") && a["values"] is Dictionary<string, object> v) d.Read(v);
            FxApi.GetShader("Projector"); // fail before creating anything
            var f = AddObjectFolder.Add() ?? throw new BridgeException("Studio couldn't add a folder");
            f.name = Title(d);
            var cam = S.cameraCtrl;
            Vector3 target = cam != null ? cam.targetPos : Vector3.zero;
            Vector3 toCam = Camera.main != null ? Camera.main.transform.position - target : Vector3.back;
            toCam.y = 0;
            if (toCam.sqrMagnitude < 1e-4f) toCam = Vector3.back;
            var pos = target + toCam.normalized * 1.2f + Vector3.up * 2.6f;
            var rot = Quaternion.LookRotation(target - pos);
            f.objectInfo.changeAmount.pos = pos;
            f.objectInfo.changeAmount.rot = rot.eulerAngles;
            Attach(f, d);
            UndoStack.Push(new ProjAddUndo(f, d));
            return f.objectInfo.dicKey;
        }

        /// <summary>args: {id, values}</summary>
        private static object SetProj(Dictionary<string, object> a)
        {
            var f = SceneApi.FindOci(a.GetInt("id")) as OCIFolder;
            var p = ProjectorOf(f) ?? throw new BridgeException("That projector isn't in the scene any more");
            var prev = p.Data.Copy();
            if (!(a.ContainsKey("values") && a["values"] is Dictionary<string, object> v)) throw new BridgeException("No values");
            p.Data.Read(v);
            p.Apply();
            string oldTitle = Title(prev);
            if (f.name == oldTitle) f.name = Title(p.Data); // keep the automatic name in step (not a name the user gave)
            UndoStack.Push(new ProjSetUndo(f, prev, f.objectInfo.dicKey + "|" + string.Join(",", v.Keys.OrderBy(k => k).ToArray())));
            return p.Data.Wire();
        }

        private sealed class ProjSetUndo : IUndoEntry
        {
            private readonly OCIFolder _f;
            private readonly ProjData _d;
            private readonly string _key;
            public ProjSetUndo(OCIFolder f, ProjData d, string key) { _f = f; _d = d; _key = key; }
            public string Label => "Projector";
            public bool Absorbs(IUndoEntry newer) => newer is ProjSetUndo n && n._key == _key;
            public IUndoEntry Restore()
            {
                var p = ProjectorOf(_f);
                if (p == null) return new ProjSetUndo(_f, _d, _key);
                var now = p.Data.Copy();
                if (_f.name == Title(now)) _f.name = Title(_d);
                p.Data = _d.Copy();
                p.Apply();
                return new ProjSetUndo(_f, now, _key + "|undo");
            }
        }

        private sealed class ProjAddUndo : IUndoEntry
        {
            private readonly OCIFolder _f;
            private readonly ProjData _d;
            public ProjAddUndo(OCIFolder f, ProjData d) { _f = f; _d = d; }
            public string Label => "Add projector";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var pos = _f.objectInfo.changeAmount.pos;
                var rot = _f.objectInfo.changeAmount.rot;
                var d = ProjectorOf(_f)?.Data.Copy() ?? _d;
                if (_f.treeNodeObject != null) S.treeNodeCtrl.DeleteNode(_f.treeNodeObject);
                return new ProjReAddUndo(d, pos, rot);
            }
        }

        private sealed class ProjReAddUndo : IUndoEntry
        {
            private readonly ProjData _d;
            private readonly Vector3 _pos, _rot;
            public ProjReAddUndo(ProjData d, Vector3 pos, Vector3 rot) { _d = d; _pos = pos; _rot = rot; }
            public string Label => "Add projector";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var f = AddObjectFolder.Add();
                f.name = Title(_d);
                f.objectInfo.changeAmount.pos = _pos;
                f.objectInfo.changeAmount.rot = _rot;
                Attach(f, _d);
                return new ProjAddUndo(f, _d);
            }
        }

        // ------------------------------------------------------------------ Timeline tracks (one per projector folder)

        private static KfProjector Proj(ObjectCtrlInfo oci) => ProjectorOf(oci as OCIFolder);

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterTracks()
        {
            Func<ObjectCtrlInfo, bool> fits = oci => Proj(oci) != null;
            void F(string id, string name, Func<ProjData, float> get, Action<ProjData, float> set) =>
                TimelineImpl.AddObjectFloatModel("Keyframe Studio", "proj." + id, "Projector " + name, fits,
                    oci => get(Proj(oci).Data),
                    (oci, v) => { var p = Proj(oci); set(p.Data, v); p.Apply(); });
            F("angle", "size", d => d.Angle, (d, v) => d.Angle = Mathf.Clamp(v, 2, 120));
            F("soft", "softness", d => d.Soft, (d, v) => d.Soft = Mathf.Clamp01(v));
            F("spin", "turn", d => d.Spin, (d, v) => d.Spin = v);
            F("count", "slats / points", d => d.Count, (d, v) => d.Count = Mathf.Clamp(v, 2, 24));
            F("range", "reach", d => d.Range, (d, v) => d.Range = Mathf.Clamp(v, 0.5f, 100));
            F("falloff", "distance fade", d => d.Falloff, (d, v) => d.Falloff = Mathf.Clamp01(v));
            TimelineImpl.AddObjectColorModel("Keyframe Studio", "proj.color", "Projector colour", fits,
                oci => { var c = Proj(oci).Data.Color; return new Vector4(c[0], c[1], c[2], c[3]); },
                (oci, v) => { var p = Proj(oci); p.Data.Color = new[] { v.x, v.y, v.z, Mathf.Clamp01(v.w) }; p.Apply(); });
        }

        // ================================================================== aiming lights

        internal sealed class KfAim : MonoBehaviour
        {
            public int TargetId;
            public string Bone = "head";
            public float Speed = 4f;
            public Transform Target;
            public Quaternion Original;

            private void LateUpdate()
            {
                if (Target == null) return;
                var dir = Target.position - transform.position;
                if (dir.sqrMagnitude < 1e-6f) return;
                transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(dir), 1 - Mathf.Exp(-Speed * Time.deltaTime));
            }
        }

        private static readonly Dictionary<string, string> AimBones = new Dictionary<string, string>
        {
            { "body", null }, { "head", "cf_j_head" }, { "chest", "cf_j_spine03" }, { "hips", "cf_j_hips" },
        };

        private static float OffAngle(Transform light, Transform target) =>
            target == null ? -1f : Vector3.Angle(light.forward, target.position - light.position);

        private static bool LightManagerInstalled => Chainloader.PluginInfos.ContainsKey(LightManagerGuid);
        private static bool _useLightManager = true;

        private static Transform AimTransform(OCIChar c, string bone)
        {
            if (bone == "body" || !AimBones.TryGetValue(bone, out var n) || n == null) return c.charInfo.objBody != null ? c.charInfo.objBody.transform : c.charInfo.transform;
            return c.charInfo.GetComponentsInChildren<Transform>(true).FirstOrDefault(t => t.name == n) ?? c.charInfo.transform;
        }

        private static Component TheirAim(OCILight l)
        {
            var t = AccessTools.TypeByName("LightManager.Core.TrackTransform");
            return t != null && l.light != null ? l.light.gameObject.GetComponent(t) : null;
        }

        private static object AimList()
        {
            var lights = new List<object>();
            foreach (var kv in S.dicObjectCtrl)
                if (kv.Value is OCILight l && l.light != null && l.lightType != LightType.Point)
                {
                    var ours = l.light.GetComponent<KfAim>();
                    var theirs = TheirAim(l);
                    int target = ours != null ? ours.TargetId : theirs != null ? (int)AccessTools.Field(theirs.GetType(), "targetKey").GetValue(theirs) : -1;
                    lights.Add(new Dictionary<string, object>
                    {
                        { "id", kv.Key }, { "name", SceneApi.DisplayName(l) }, { "type", l.lightType.ToString() },
                        { "target", target }, { "bone", ours != null ? ours.Bone : theirs != null ? "body" : "" },
                        { "speed", (double)(ours != null ? ours.Speed : theirs != null ? (float)AccessTools.Field(theirs.GetType(), "rotationSpeed").GetValue(theirs) : 4f) },
                        { "provider", ours != null ? "Keyframe Studio" : theirs != null ? "LightManager" : "" },
                        // how far off target it points (degrees), for checks
                        { "offAngle", (double)OffAngle(l.light.transform, ours != null ? ours.Target : theirs != null ? AccessTools.Field(theirs.GetType(), "target").GetValue(theirs) as Transform : null) },
                    });
                }
            return new Dictionary<string, object>
            {
                { "lights", lights }, { "bones", AimBones.Keys.Cast<object>().ToList() },
                { "lightManager", LightManagerInstalled }, { "useLightManager", _useLightManager },
            };
        }

        /// <summary>args: {id, target (-1 = stop), bone, speed} or {useLightManager}</summary>
        private static object SetAim(Dictionary<string, object> a)
        {
            if (a.Has("useLightManager")) _useLightManager = a.GetBool("useLightManager", true);
            if (!a.Has("id")) return AimList();
            var l = SceneApi.FindOci(a.GetInt("id")) as OCILight ?? throw new BridgeException("Pick a light");
            if (l.lightType == LightType.Point) throw new BridgeException("Point lights shine every way — aim a spot or directional light");
            var before = Snapshot(l);
            int target = a.Has("target") ? a.GetInt("target") : before.Target;
            string bone = a.Has("bone") ? a.GetString("bone") : before.Bone ?? "head";
            float speed = a.Has("speed") ? Mathf.Clamp(a.GetFloat("speed"), 0.2f, 30f) : before.Speed;
            if (!AimBones.ContainsKey(bone)) throw new BridgeException("Unknown body part: " + bone);
            ApplyAim(l, new AimState { Target = target, Bone = bone, Speed = speed });
            UndoStack.Push(new AimUndo(l, before, l.objectInfo.dicKey + "|aim|" + string.Join(",", a.Keys.OrderBy(k => k).ToArray())));
            return AimList();
        }

        private struct AimState
        {
            public int Target;
            public string Bone;
            public float Speed;
            public bool Theirs;
        }

        private static AimState Snapshot(OCILight l)
        {
            var ours = l.light.GetComponent<KfAim>();
            if (ours != null) return new AimState { Target = ours.TargetId, Bone = ours.Bone, Speed = ours.Speed };
            var theirs = TheirAim(l);
            if (theirs != null) return new AimState { Target = (int)AccessTools.Field(theirs.GetType(), "targetKey").GetValue(theirs), Bone = "body", Speed = (float)AccessTools.Field(theirs.GetType(), "rotationSpeed").GetValue(theirs), Theirs = true };
            return new AimState { Target = -1, Bone = "head", Speed = 4f };
        }

        private static void ApplyAim(OCILight l, AimState st)
        {
            var ours = l.light.GetComponent<KfAim>();
            var theirs = TheirAim(l);
            Quaternion? original = ours != null ? ours.Original : (Quaternion?)null;
            if (ours != null) UnityEngine.Object.DestroyImmediate(ours);
            if (theirs != null) UnityEngine.Object.DestroyImmediate(theirs);
            var chara = st.Target >= 0 ? SceneApi.FindOci(st.Target) as OCIChar : null;
            if (chara == null)
            {
                if (original.HasValue) l.light.transform.localRotation = original.Value; // back to where Studio had it
                return;
            }
            bool useTheirs = st.Bone == "body" && LightManagerInstalled && _useLightManager && l.lightType == LightType.Spot;
            if (useTheirs)
            {
                var t = AccessTools.TypeByName("LightManager.Core.TrackTransform");
                if (t != null)
                {
                    var c = l.light.gameObject.AddComponent(t);
                    AccessTools.Field(t, "target").SetValue(c, chara.charInfo.objBody.transform);
                    AccessTools.Field(t, "targetKey").SetValue(c, chara.objectInfo.dicKey);
                    AccessTools.Field(t, "targetName").SetValue(c, chara.charInfo.chaFile.parameter.fullname);
                    AccessTools.Field(t, "rotationSpeed").SetValue(c, st.Speed);
                    return;
                }
            }
            var aim = l.light.gameObject.AddComponent<KfAim>();
            aim.Original = original ?? l.light.transform.localRotation;
            aim.TargetId = chara.objectInfo.dicKey;
            aim.Bone = st.Bone;
            aim.Speed = st.Speed;
            aim.Target = AimTransform(chara, st.Bone);
        }

        private sealed class AimUndo : IUndoEntry
        {
            private readonly OCILight _l;
            private readonly AimState _st;
            private readonly string _key;
            public AimUndo(OCILight l, AimState st, string key) { _l = l; _st = st; _key = key; }
            public string Label => "Aim light";
            public bool Absorbs(IUndoEntry newer) => newer is AimUndo n && n._key == _key;
            public IUndoEntry Restore()
            {
                if (_l?.light == null) return new AimUndo(_l, _st, _key);
                var now = Snapshot(_l);
                ApplyAim(_l, _st);
                return new AimUndo(_l, now, _key + "|undo");
            }
        }

        // ================================================================== saved with the scene

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<LightsSceneData>(StudioBridgePlugin.GUID + ".lights");

        private sealed class LightsSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                var projs = ProjectorFolders().Select(kv => (object)new Dictionary<string, object> { { "id", kv.Key }, { "values", ProjectorOf(kv.Value).Data.Wire() } }).ToList();
                var aims = new List<object>();
                foreach (var kv in S.dicObjectCtrl)
                    if (kv.Value is OCILight l && l.light != null && l.light.GetComponent<KfAim>() is KfAim aim)
                        aims.Add(new Dictionary<string, object> { { "id", kv.Key }, { "target", aim.TargetId }, { "bone", aim.Bone }, { "speed", (double)aim.Speed } });
                if (projs.Count == 0 && aims.Count == 0) { SetExtendedData(null); return; }
                SetExtendedData(new PluginData { version = 1, data = new Dictionary<string, object> { { "json", Json.Serialize(new Dictionary<string, object> { { "projectors", projs }, { "aims", aims } }) } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                var d = GetExtendedData();
                if (d?.data == null || !d.data.TryGetValue("json", out var raw) || !(raw is string json)) return;
                try
                {
                    if (!(Json.Parse(json) is Dictionary<string, object> all)) return;
                    if (all.TryGetValue("projectors", out var ps) && ps is List<object> pl)
                        foreach (var o in pl.OfType<Dictionary<string, object>>())
                            if (loadedItems.TryGetValue(Convert.ToInt32(o["id"]), out var oci) && oci is OCIFolder f && o["values"] is Dictionary<string, object> v)
                            {
                                var pd = new ProjData();
                                pd.Read(v);
                                Attach(f, pd);
                            }
                    if (all.TryGetValue("aims", out var ai) && ai is List<object> al)
                        foreach (var o in al.OfType<Dictionary<string, object>>())
                            if (loadedItems.TryGetValue(Convert.ToInt32(o["id"]), out var oci) && oci is OCILight l
                                && loadedItems.TryGetValue(Convert.ToInt32(o["target"]), out var t))
                                ApplyAim(l, new AimState { Target = t.objectInfo.dicKey, Bone = Convert.ToString(o["bone"]), Speed = Convert.ToSingle(o["speed"], CultureInfo.InvariantCulture) });
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Couldn't read the scene's projectors / aimed lights: " + e.Message); }
            }
        }
    }
}
