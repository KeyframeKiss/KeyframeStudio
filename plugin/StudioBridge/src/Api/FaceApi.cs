using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Face Studio (roadmap Phase 5): fine face adjustments for characters already in the scene, stored as
    /// KKPE bone edits so they save with the scene and stay editable in KKPE itself.
    ///
    /// KKPE has no public API: its BonesEditor keeps a private Dictionary&lt;GameObject, TransformData&gt;
    /// (_dirtyBones) of absolute local transforms, applied every frame. We drive it through the same private
    /// setters its own Timeline integration uses (SetBonePosition / SetBoneRotation / SetBoneScale and
    /// ResetBonePos / Rot / Scale). Values travel as offsets from each bone's original transform:
    /// position delta, rotation delta (euler degrees) and a scale multiplier.
    ///
    /// face.view renders an on-demand close-up of the face with a dedicated camera (no real-time stream).
    /// </summary>
    internal static class FaceApi
    {
        // ---------------- KKPE reflection (resolved lazily) ----------------
        private static bool _resolved;
        private static Type _pcType, _beType;
        private static FieldInfo _fBones, _fDirty;
        private static MethodInfo _setPos, _setRot, _setScale, _resetPos, _resetRot, _resetScale;
        private static FieldInfo _tdPos, _tdRot, _tdScale, _tdOPos, _tdORot, _tdOScale;

        private static bool Resolve()
        {
            if (_resolved) return _pcType != null && _setPos != null && _fDirty != null;
            _resolved = true;
            try
            {
                _pcType = AccessTools.TypeByName("HSPE.PoseController");
                _beType = AccessTools.TypeByName("HSPE.AMModules.BonesEditor");
                if (_pcType == null || _beType == null) return false;
                _fBones = AccessTools.Field(_pcType, "_bonesEditor");
                _fDirty = AccessTools.Field(_beType, "_dirtyBones");
                _setPos = AccessTools.Method(_beType, "SetBonePosition", new[] { typeof(Transform), typeof(Vector3) });
                _setRot = AccessTools.Method(_beType, "SetBoneRotation", new[] { typeof(Transform), typeof(Quaternion) });
                _setScale = AccessTools.Method(_beType, "SetBoneScale", new[] { typeof(Transform), typeof(Vector3) });
                var resetArgs = new[] { typeof(Transform), typeof(Transform), typeof(bool), typeof(int) };
                _resetPos = AccessTools.Method(_beType, "ResetBonePos", resetArgs);
                _resetRot = AccessTools.Method(_beType, "ResetBoneRot", resetArgs);
                _resetScale = AccessTools.Method(_beType, "ResetBoneScale", resetArgs);
                var td = _beType.GetNestedType("TransformData", BindingFlags.NonPublic | BindingFlags.Public);
                if (td != null)
                {
                    _tdPos = AccessTools.Field(td, "position"); _tdRot = AccessTools.Field(td, "rotation"); _tdScale = AccessTools.Field(td, "scale");
                    _tdOPos = AccessTools.Field(td, "originalPosition"); _tdORot = AccessTools.Field(td, "originalRotation"); _tdOScale = AccessTools.Field(td, "originalScale");
                }
                bool ok = _fBones != null && _fDirty != null && _setPos != null && _setRot != null && _setScale != null &&
                          _resetPos != null && _resetRot != null && _resetScale != null && _tdPos != null && _tdOScale != null;
                if (!ok) { _pcType = null; StudioBridgePlugin.Logger.LogWarning("Face Studio: unsupported KKPE version (members not found)"); }
                return ok;
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("Face Studio: KKPE not usable: " + e.Message);
                _pcType = null;
                return false;
            }
        }

        public static void Register(CommandRouter r)
        {
            r.Add("face.get", a => Get(a));
            r.Add("face.set", a => Set(a));
            r.Add("face.reset", a => Reset(a));
            r.Add("face.view", a => View(a));
            r.Add("face.presets", a => ListPresets());
            r.Add("face.savePreset", a => SavePreset(a));
            r.Add("face.applyPreset", a => ApplyPreset(a));
            r.Add("face.deletePreset", a => DeletePreset(a));
            r.Add("face.updatePreset", a => UpdatePreset(a));
        }

        // ---------------- helpers ----------------

        private sealed class Target
        {
            public OCIChar Chara;
            public object Bones; // KKPE BonesEditor
            public Transform Root;
        }

        private static Target GetTarget(Dictionary<string, object> a)
        {
            if (!Resolve()) throw new BridgeException("Face Studio needs KKPE (KK Pose Editor), which isn't installed or isn't a supported version");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("That character isn't loaded");
            var pc = c.guideObject.transformTarget.GetComponent(_pcType);
            if (pc == null) throw new BridgeException("KKPE hasn't attached to this character yet — select it once in Studio");
            var be = _fBones.GetValue(pc);
            if (be == null) throw new BridgeException("KKPE's bone editor isn't ready for this character");
            return new Target { Chara = c, Bones = be, Root = c.charInfo.transform };
        }

        private static readonly Dictionary<int, Dictionary<string, Transform>> BoneCache = new Dictionary<int, Dictionary<string, Transform>>();

        private static Transform Bone(Target t, string name)
        {
            int key = t.Root.GetInstanceID();
            if (!BoneCache.TryGetValue(key, out var map) || map.Values.Any(x => x == null))
            {
                map = new Dictionary<string, Transform>();
                foreach (var tr in t.Root.GetComponentsInChildren<Transform>(true))
                    if (!map.ContainsKey(tr.name)) map[tr.name] = tr;
                BoneCache[key] = map;
            }
            return map.TryGetValue(name, out var b) ? b : null;
        }

        private static string Twin(string name) =>
            name.EndsWith("_L") ? name.Substring(0, name.Length - 2) + "_R" :
            name.EndsWith("_R") ? name.Substring(0, name.Length - 2) + "_L" : null;

        private static object Entry(Target t, Transform bone)
        {
            var dict = (IDictionary)_fDirty.GetValue(t.Bones);
            return dict.Contains(bone.gameObject) ? dict[bone.gameObject] : null;
        }

        /// <summary>Read an EditableValue&lt;T&gt; field of a TransformData (boxed struct).</summary>
        private static bool Ev<T>(object td, FieldInfo f, out T value) where T : struct
        {
            value = default(T);
            if (td == null || f == null) return false;
            var ev = f.GetValue(td);
            var t = ev.GetType();
            if (!(bool)t.GetProperty("hasValue").GetValue(ev, null)) return false;
            value = (T)t.GetProperty("value").GetValue(ev, null);
            return true;
        }

        private struct BoneState
        {
            public bool HasPos, HasRot, HasScale;
            public Vector3 Pos, Scale;
            public Quaternion Rot;
            public Vector3 BasePos, BaseScale;
            public Quaternion BaseRot;
        }

        private static BoneState Read(Target t, Transform bone)
        {
            var td = Entry(t, bone);
            var s = new BoneState();
            s.HasPos = Ev(td, _tdPos, out s.Pos);
            s.HasRot = Ev(td, _tdRot, out s.Rot);
            s.HasScale = Ev(td, _tdScale, out s.Scale);
            if (!Ev(td, _tdOPos, out s.BasePos)) s.BasePos = bone.localPosition;
            if (!Ev(td, _tdORot, out s.BaseRot)) s.BaseRot = bone.localRotation;
            if (!Ev(td, _tdOScale, out s.BaseScale)) s.BaseScale = bone.localScale;
            if (!s.HasPos) s.Pos = s.BasePos;
            if (!s.HasRot) s.Rot = s.BaseRot;
            if (!s.HasScale) s.Scale = s.BaseScale;
            return s;
        }

        private static List<object> V(Vector3 v) => new List<object> { (double)v.x, (double)v.y, (double)v.z };

        private static Vector3 Signed(Vector3 e) => new Vector3(Mathf.DeltaAngle(0, e.x), Mathf.DeltaAngle(0, e.y), Mathf.DeltaAngle(0, e.z));

        private static Dictionary<string, object> Describe(Target t, Transform bone)
        {
            var s = Read(t, bone);
            var drot = Signed((Quaternion.Inverse(s.BaseRot) * s.Rot).eulerAngles);
            var mul = new Vector3(Div(s.Scale.x, s.BaseScale.x), Div(s.Scale.y, s.BaseScale.y), Div(s.Scale.z, s.BaseScale.z));
            return new Dictionary<string, object>
            {
                { "name", bone.name },
                { "pos", V(s.Pos - s.BasePos) },
                { "rot", V(drot) },
                { "scale", V(mul) },
                { "edited", s.HasPos || s.HasRot || s.HasScale },
            };
        }

        private static float Div(float a, float b) => Mathf.Abs(b) < 1e-6f ? 1f : a / b;

        // ---------------- commands ----------------

        private static object Get(Dictionary<string, object> a)
        {
            var t = GetTarget(a);
            var list = new List<object>();
            foreach (var o in a.GetList("bones"))
            {
                var b = Bone(t, o as string);
                if (b != null) list.Add(Describe(t, b));
            }
            return new Dictionary<string, object> { { "bones", list } };
        }

        /// <summary>args: {id, bone, pos?:[dx,dy,dz], rot?:[dx,dy,dz] deg, scale?:[mx,my,mz], mirror?:bool}</summary>
        private static object Set(Dictionary<string, object> a)
        {
            var t = GetTarget(a);
            string name = a.GetString("bone");
            var bone = Bone(t, name);
            if (bone == null) throw new BridgeException("This character has no " + name);
            var targets = new List<KeyValuePair<Transform, bool>> { new KeyValuePair<Transform, bool>(bone, false) };
            string twin = a.GetBool("mirror", true) ? Twin(name) : null;
            var tb = twin != null ? Bone(t, twin) : null;
            if (tb != null) targets.Add(new KeyValuePair<Transform, bool>(tb, true));

            UndoStack.Push(new FaceUndo(t, targets.Select(x => x.Key).ToList(), name, a.Keys.Where(k => k == "pos" || k == "rot" || k == "scale").ToArray()));
            foreach (var kv in targets)
            {
                var s = Read(t, kv.Key);
                bool mirrored = kv.Value;
                if (a.Has("pos"))
                {
                    var d = Vec(a.GetList("pos"), Vector3.zero);
                    if (mirrored) d.x = -d.x;
                    _setPos.Invoke(t.Bones, new object[] { kv.Key, s.BasePos + d });
                }
                if (a.Has("rot"))
                {
                    var e = Vec(a.GetList("rot"), Vector3.zero);
                    if (mirrored) { e.y = -e.y; e.z = -e.z; }
                    _setRot.Invoke(t.Bones, new object[] { kv.Key, s.BaseRot * Quaternion.Euler(e) });
                }
                if (a.Has("scale"))
                {
                    var m = Vec(a.GetList("scale"), Vector3.one);
                    _setScale.Invoke(t.Bones, new object[] { kv.Key, Vector3.Scale(s.BaseScale, m) });
                }
            }
            return Describe(t, bone);
        }

        private static Vector3 Vec(List<object> l, Vector3 def)
        {
            if (l == null || l.Count < 3) return def;
            Func<object, float, float> f = (o, d) => o == null ? d : Convert.ToSingle(o, System.Globalization.CultureInfo.InvariantCulture);
            return new Vector3(f(l[0], def.x), f(l[1], def.y), f(l[2], def.z));
        }

        /// <summary>args: {id, bones:[names], what?: "pos"|"rot"|"scale"|"all", mirror?:bool}</summary>
        private static object Reset(Dictionary<string, object> a)
        {
            var t = GetTarget(a);
            string what = a.GetString("what") ?? "all";
            var bones = new List<Transform>();
            foreach (var o in a.GetList("bones"))
            {
                var b = Bone(t, o as string);
                if (b == null) continue;
                bones.Add(b);
                var tw = a.GetBool("mirror", true) ? Twin(b.name) : null;
                var tb = tw != null ? Bone(t, tw) : null;
                if (tb != null && !bones.Contains(tb)) bones.Add(tb);
            }
            if (bones.Count == 0) return 0;
            UndoStack.Push(new FaceUndo(t, bones, "reset", null));
            foreach (var b in bones) ResetBone(t, b, what);
            return bones.Count;
        }

        private static void ResetBone(Target t, Transform b, string what)
        {
            var args = new object[] { b, null, false, 0 };
            if (what == "all" || what == "pos") _resetPos.Invoke(t.Bones, args);
            if (what == "all" || what == "rot") _resetRot.Invoke(t.Bones, args);
            if (what == "all" || what == "scale") _resetScale.Invoke(t.Bones, args);
        }

        // ---------------- saved faces (presets) ----------------
        //
        // A saved face is a set of per-bone offsets from each bone's original transform (position delta,
        // rotation delta in degrees, scale multiplier), only for the channels that were actually edited.
        // Offsets make a face portable: applied to another character it changes their face the same way.
        // Files: UserData/StudioEX/faces/<name>.json (+ <name>.jpg thumbnail).

        private static string PresetFolder
        {
            get
            {
                var dir = System.IO.Path.GetFullPath(System.IO.Path.Combine(UserData.Path, "StudioEX/faces"));
                System.IO.Directory.CreateDirectory(dir);
                return dir;
            }
        }

        private static string SafeFile(string name)
        {
            var bad = System.IO.Path.GetInvalidFileNameChars();
            var s = new string((name ?? "").Trim().Select(ch => Array.IndexOf(bad, ch) >= 0 ? '_' : ch).ToArray()).Trim('.', ' ');
            return s.Length == 0 ? "Face" : s;
        }

        private static object ListPresets()
        {
            var list = new List<object>();
            foreach (var f in System.IO.Directory.GetFiles(PresetFolder, "*.json").OrderBy(f => f))
            {
                try
                {
                    var d = Json.Parse(System.IO.File.ReadAllText(f, System.Text.Encoding.UTF8)) as Dictionary<string, object>;
                    var bones = d?.GetObject("bones");
                    if (bones == null) continue;
                    var item = new Dictionary<string, object>
                    {
                        { "file", System.IO.Path.GetFileNameWithoutExtension(f) },
                        { "name", d.GetString("name") ?? System.IO.Path.GetFileNameWithoutExtension(f) },
                        { "bones", bones.Keys.Cast<object>().ToList() },
                        { "tags", d.GetList("tags").Where(x => x is string).ToList() },
                        { "favorite", d.GetBool("favorite") },
                        { "from", d.GetString("from") ?? "" },
                        { "created", d.Has("created") ? d.GetDouble("created") : (System.IO.File.GetCreationTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                        { "lastUsed", d.GetDouble("lastUsed") },
                        { "modified", (System.IO.File.GetLastWriteTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                    };
                    var jpg = System.IO.Path.ChangeExtension(f, ".jpg");
                    if (System.IO.File.Exists(jpg)) item["thumb"] = "data:image/jpeg;base64," + Convert.ToBase64String(System.IO.File.ReadAllBytes(jpg));
                    list.Add(item);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Bad saved face " + f + ": " + e.Message); }
            }
            return list;
        }

        /// <summary>args: {id, name, bones:[names to consider]} — saves the edited ones.</summary>
        private static object SavePreset(Dictionary<string, object> a)
        {
            string name = (a.GetString("name") ?? "").Trim();
            if (name.Length == 0) throw new BridgeException("Give the face a name");
            var t = GetTarget(a);
            var bones = new Dictionary<string, object>();
            foreach (var o in a.GetList("bones"))
            {
                var b = Bone(t, o as string);
                if (b == null) continue;
                var st = Read(t, b);
                if (!st.HasPos && !st.HasRot && !st.HasScale) continue;
                var e = new Dictionary<string, object>();
                if (st.HasPos) e["pos"] = V(st.Pos - st.BasePos);
                if (st.HasRot) e["rot"] = V(Signed((Quaternion.Inverse(st.BaseRot) * st.Rot).eulerAngles));
                if (st.HasScale) e["scale"] = V(new Vector3(Div(st.Scale.x, st.BaseScale.x), Div(st.Scale.y, st.BaseScale.y), Div(st.Scale.z, st.BaseScale.z)));
                bones[b.name] = e;
            }
            if (bones.Count == 0) throw new BridgeException("This face has no adjustments to save yet");
            string file = System.IO.Path.Combine(PresetFolder, SafeFile(name) + ".json");
            var old = System.IO.File.Exists(file) ? ReadPreset(file) : null; // overwrite keeps tags, favorite, dates
            var d = new Dictionary<string, object>
            {
                { "version", 1 },
                { "name", name },
                { "from", t.Chara.treeNodeObject != null ? t.Chara.treeNodeObject.textName : "" },
                { "created", old != null && old.Has("created") ? old.GetDouble("created") : NowMs() },
                { "tags", old != null ? old.GetList("tags") : new List<object>() },
                { "favorite", old != null && old.GetBool("favorite") },
                { "bones", bones },
            };
            System.IO.File.WriteAllText(file, Json.Serialize(d), new System.Text.UTF8Encoding(false));
            try
            {
                var thumb = View(new Dictionary<string, object> { { "id", a.GetInt("id") }, { "size", 256 }, { "plain", true }, { "zoom", 1.05 } }) as string;
                if (thumb != null) System.IO.File.WriteAllBytes(System.IO.Path.ChangeExtension(file, ".jpg"), Convert.FromBase64String(thumb.Substring(thumb.IndexOf(',') + 1)));
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Saved face thumbnail failed: " + e.Message); }
            return ListPresets();
        }

        /// <summary>
        /// args: {ids:[characters], file, bones:[scope: parts this apply may change], strength?: 0..1, clear?: bool}
        /// clear = parts in scope that the saved face doesn't adjust go back to default (a clean switch).
        /// One undo step for all characters.
        /// </summary>
        private static object ApplyPreset(Dictionary<string, object> a)
        {
            string path = System.IO.Path.Combine(PresetFolder, SafeFile(a.GetString("file")) + ".json");
            if (!System.IO.File.Exists(path)) throw new BridgeException("Saved face not found");
            var doc = ReadPreset(path);
            var preset = doc?.GetObject("bones") ?? new Dictionary<string, object>();
            var n = ApplyBones(a, preset);
            try { doc["lastUsed"] = NowMs(); WritePreset(path, doc); } catch { } // for "recently used" sorting
            return n;
        }

        private static object ApplyBones(Dictionary<string, object> a, Dictionary<string, object> preset)
        {
            var ids = a.GetList("ids");
            if (ids.Count == 0 && a.Has("id")) ids.Add(a["id"]);
            float k = Mathf.Clamp01(a.Has("strength") ? a.GetFloat("strength") : 1f);
            bool clear = a.GetBool("clear", true);
            var scope = new HashSet<string>(a.GetList("bones").Select(o => o as string).Where(n => n != null));
            if (scope.Count == 0) scope = new HashSet<string>(preset.Keys);

            var undo = new List<FaceUndo>();
            var work = new List<KeyValuePair<Target, List<Transform>>>();
            foreach (var o in ids)
            {
                var t = GetTarget(new Dictionary<string, object> { { "id", o } });
                var bones = scope.Select(n => Bone(t, n)).Where(b => b != null).ToList();
                undo.Add(new FaceUndo(t, bones, "preset", null));
                work.Add(new KeyValuePair<Target, List<Transform>>(t, bones));
            }
            if (work.Count == 0) throw new BridgeException("Select one or more characters first");
            UndoStack.Push(new FaceMultiUndo(undo, "Apply saved face"));

            foreach (var kv in work)
            {
                var t = kv.Key;
                foreach (var b in kv.Value)
                {
                    var e = preset.GetObject(b.name);
                    if (e == null) { if (clear) ResetBone(t, b, "all"); continue; }
                    ResetBone(t, b, "all");
                    var st = Read(t, b);
                    if (e.ContainsKey("pos")) _setPos.Invoke(t.Bones, new object[] { b, st.BasePos + Vec(e.GetList("pos"), Vector3.zero) * k });
                    if (e.ContainsKey("rot")) _setRot.Invoke(t.Bones, new object[] { b, st.BaseRot * Quaternion.Euler(Vec(e.GetList("rot"), Vector3.zero) * k) });
                    if (e.ContainsKey("scale"))
                    {
                        var m = Vec(e.GetList("scale"), Vector3.one);
                        m = Vector3.one + (m - Vector3.one) * k;
                        _setScale.Invoke(t.Bones, new object[] { b, Vector3.Scale(st.BaseScale, m) });
                    }
                }
            }
            return work.Count;
        }

        private static double NowMs() => (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

        private static Dictionary<string, object> ReadPreset(string path) =>
            Json.Parse(System.IO.File.ReadAllText(path, System.Text.Encoding.UTF8)) as Dictionary<string, object>;

        private static void WritePreset(string path, Dictionary<string, object> d) =>
            System.IO.File.WriteAllText(path, Json.Serialize(d), new System.Text.UTF8Encoding(false));

        /// <summary>args: {file, name?: rename, tags?: [..], favorite?: bool}</summary>
        private static object UpdatePreset(Dictionary<string, object> a)
        {
            string path = System.IO.Path.Combine(PresetFolder, SafeFile(a.GetString("file")) + ".json");
            if (!System.IO.File.Exists(path)) throw new BridgeException("Saved face not found");
            var d = ReadPreset(path);
            if (a.Has("tags"))
                d["tags"] = a.GetList("tags").Select(o => (o as string ?? "").Trim()).Where(x => x.Length > 0)
                             .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).Cast<object>().ToList();
            if (a.Has("favorite")) d["favorite"] = a.GetBool("favorite");
            if (a.Has("name"))
            {
                string name = (a.GetString("name") ?? "").Trim();
                if (name.Length == 0) throw new BridgeException("Give the face a name");
                string to = System.IO.Path.Combine(PresetFolder, SafeFile(name) + ".json");
                if (!string.Equals(to, path, StringComparison.OrdinalIgnoreCase))
                {
                    if (System.IO.File.Exists(to)) throw new BridgeException("A saved face called “" + name + "” already exists");
                    System.IO.File.Move(path, to);
                    var jpg = System.IO.Path.ChangeExtension(path, ".jpg");
                    if (System.IO.File.Exists(jpg)) System.IO.File.Move(jpg, System.IO.Path.ChangeExtension(to, ".jpg"));
                    path = to;
                }
                d["name"] = name;
            }
            WritePreset(path, d);
            return ListPresets();
        }

        private static object DeletePreset(Dictionary<string, object> a)
        {
            var files = a.GetList("files").Select(o => o as string).Where(f => f != null).ToList();
            if (a.Has("file")) files.Add(a.GetString("file"));
            foreach (var f in files)
            {
                string path = System.IO.Path.Combine(PresetFolder, SafeFile(f) + ".json");
                if (!System.IO.File.Exists(path)) continue;
                System.IO.File.Delete(path);
                var jpg = System.IO.Path.ChangeExtension(path, ".jpg");
                if (System.IO.File.Exists(jpg)) System.IO.File.Delete(jpg);
            }
            return ListPresets();
        }

        private sealed class FaceMultiUndo : IUndoEntry
        {
            private readonly List<FaceUndo> _parts;
            public FaceMultiUndo(List<FaceUndo> parts, string label) { _parts = parts; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore() => new FaceMultiUndo(_parts.Select(p => (FaceUndo)p.Restore()).ToList(), Label);
        }

        // ---------------- undo ----------------

        private sealed class FaceUndo : IUndoEntry
        {
            private readonly Target _t;
            private readonly List<KeyValuePair<Transform, BoneState>> _states;
            private readonly string _key;

            public FaceUndo(Target t, List<Transform> bones, string bone, string[] channels)
            {
                _t = t;
                _states = bones.Select(b => new KeyValuePair<Transform, BoneState>(b, Read(t, b))).ToList();
                _key = bone + "|" + (channels == null ? "reset" : string.Join(",", channels));
            }

            public string Label => "Face edit";

            public bool Absorbs(IUndoEntry newer) => newer is FaceUndo n && n._t.Bones == _t.Bones && n._key == _key && !_key.EndsWith("reset");

            public IUndoEntry Restore()
            {
                if (_t.Root == null) throw new InvalidOperationException("character deleted");
                var inverse = new FaceUndo(_t, _states.Select(s => s.Key).Where(b => b != null).ToList(), _key.Split('|')[0], null);
                foreach (var kv in _states)
                {
                    var b = kv.Key;
                    if (b == null) continue;
                    var s = kv.Value;
                    ResetBone(_t, b, "all");
                    if (s.HasPos) _setPos.Invoke(_t.Bones, new object[] { b, s.Pos });
                    if (s.HasRot) _setRot.Invoke(_t.Bones, new object[] { b, s.Rot });
                    if (s.HasScale) _setScale.Invoke(_t.Bones, new object[] { b, s.Scale });
                }
                return inverse;
            }
        }

        // ---------------- close-up view ----------------

        private static Camera _cam;
        private static RenderTexture _rt;
        private static Texture2D _tex;

        /// <summary>args: {id, angle: degrees around the face (0 = front), pitch?: degrees, zoom?: 1 = whole face, size?: px}</summary>
        private static object View(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("That character isn't loaded");
            var t = new Target { Chara = c, Root = c.charInfo.transform };
            var head = Bone(t, "cf_j_head") ?? Bone(t, "cf_J_FaceRoot");
            if (head == null) throw new BridgeException("Couldn't find this character's head");

            // The framing is worked out once and stored relative to the head bone: the camera follows the head
            // when the pose changes, but NOT the face bones being edited (moving the eyes must not move the camera).
            int key = head.GetInstanceID();
            if (a.GetBool("recenter") || !Frames.TryGetValue(key, out var fr)) Frames[key] = fr = MakeFrame(t, head, a.GetFloat("frame", 5.6f));
            Vector3 center = head.TransformPoint(fr.CenterLocal);
            float faceH = fr.Size * Mathf.Abs(head.lossyScale.y);
            var rot = head.rotation * fr.RotLocal;
            Vector3 up = rot * Vector3.up, fwd = rot * Vector3.forward;

            float angle = a.GetFloat("angle", 0f), pitch = a.GetFloat("pitch", 0f), zoom = Mathf.Clamp(a.GetFloat("zoom", 1f), 0.25f, 8f);
            int size = Mathf.Clamp(a.GetInt("size", 640), 128, 1024);
            const float fov = 20f;
            // distance to the face surface sets the framing; the pivot sits Depth behind it
            float dist = faceH * 0.5f / Mathf.Tan(fov * 0.5f * Mathf.Deg2Rad) / zoom + fr.Depth * Mathf.Abs(head.lossyScale.y);
            var dir = Quaternion.AngleAxis(angle, up) * Quaternion.AngleAxis(-pitch, Vector3.Cross(up, fwd)) * fwd;

            EnsureCamera(size);
            _cam.transform.position = center + dir * dist;
            _cam.transform.rotation = Quaternion.LookRotation(center - _cam.transform.position, up);
            // Pan: slide the camera sideways/up in its own plane, in face-height units (0.5 = half a face).
            float panX = a.GetFloat("panX"), panY = a.GetFloat("panY");
            if (panX != 0f || panY != 0f)
                _cam.transform.position += (_cam.transform.right * panX + _cam.transform.up * panY) * faceH;
            _cam.fieldOfView = fov;
            // Clip everything between the camera and the head (furniture, walls) instead of rendering it.
            _cam.nearClipPlane = Mathf.Max(0.01f, dist - faceH * 0.75f);
            _cam.farClipPlane = dist * 20f + 10f;

            // Isolate: hide this character's body and other characters for this one render, so hands, hair
            // of others or a nearby character don't cover the face. Head, hair and head accessories stay.
            // Plain background: only the character layer, on a neutral backdrop (items hidden as well).
            bool plain = a.GetBool("plain", false);
            var hidden = a.GetBool("isolate", true) || plain ? HideAllButHead(c, plain) : new List<Renderer>();
            if (plain)
            {
                _cam.clearFlags = CameraClearFlags.SolidColor;
                _cam.backgroundColor = new Color(0.16f, 0.17f, 0.19f);
                var smr = c.charInfo.GetComponentInChildren<SkinnedMeshRenderer>();
                _cam.cullingMask = 1 << (smr != null ? smr.gameObject.layer : 10); // characters render on their own layer
            }
            var prev = RenderTexture.active;
            try
            {
                _cam.targetTexture = _rt;
                _cam.Render();
                RenderTexture.active = _rt;
                _tex.ReadPixels(new Rect(0, 0, size, size), 0, 0, false);
                return "data:image/jpeg;base64," + Convert.ToBase64String(_tex.EncodeToJPG(88));
            }
            finally
            {
                RenderTexture.active = prev;
                _cam.targetTexture = null;
                foreach (var r in hidden) if (r != null) r.enabled = true;
            }
        }

        private static List<Renderer> HideAllButHead(OCIChar c, bool items)
        {
            var hidden = new List<Renderer>();
            var t = new Target { Chara = c, Root = c.charInfo.transform };
            var headBone = Bone(t, "cf_j_head") ?? Bone(t, "cf_J_FaceRoot");
            var headObj = c.charInfo.objHead != null ? c.charInfo.objHead.transform : null;
            foreach (var r in c.charInfo.GetComponentsInChildren<Renderer>(false))
            {
                if (!r.enabled) continue;
                var tr = r.transform;
                bool head = (headBone != null && tr.IsChildOf(headBone)) || (headObj != null && tr.IsChildOf(headObj));
                if (head) continue;
                r.enabled = false;
                hidden.Add(r);
            }
            foreach (var oci in Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values)
            {
                GameObject go = null;
                if (oci is OCIChar other && other != c && other.charInfo != null) go = other.charInfo.gameObject;
                else if (items && oci is OCIItem item && item.objectItem != null) go = item.objectItem;
                if (go == null) continue;
                foreach (var r in go.GetComponentsInChildren<Renderer>(false))
                    if (r.enabled) { r.enabled = false; hidden.Add(r); }
            }
            return hidden;
        }

        private sealed class Frame
        {
            public Vector3 CenterLocal; // face centre in head-bone space
            public float Size;          // face height / head scale
            public Quaternion RotLocal; // camera basis (forward = out of the face, up = up the face) in head space
            public float Depth;         // how far the pivot sits behind the face surface (/ head scale)
        }

        private static readonly Dictionary<int, Frame> Frames = new Dictionary<int, Frame>();

        /// <summary>
        /// Straight-on framing. "Up" and "forward" are the head bone's own axes (whichever of its six axis
        /// directions best match eyes-above-chin and nose-in-front), so the front view is level with the face
        /// rather than tilted by where individual face bones sit. Centre and size come from the eye/chin bones.
        /// </summary>
        private static Frame MakeFrame(Target t, Transform head, float frameFactor)
        {
            Transform eye = Bone(t, "cf_J_Eye_tz"), chin = Bone(t, "cf_J_Chin_Base") ?? Bone(t, "cf_J_ChinLow"), nose = Bone(t, "cf_J_Nose_tip") ?? Bone(t, "cf_J_NoseBase");
            if (eye == null || chin == null || nose == null) throw new BridgeException("Couldn't find this character's face bones");
            Vector3 faceUp = eye.position - chin.position;
            Vector3 up = BestAxis(head, faceUp);
            Vector3 fwd = BestAxis(head, Vector3.ProjectOnPlane(nose.position - eye.position, up), up);
            float faceH = faceUp.magnitude * frameFactor;
            // Pivot in the middle of the head, not on the face surface, so side and 3/4 views orbit around the
            // head (the shift is along the viewing axis, so the front view is unchanged).
            Vector3 center = eye.position + (chin.position - eye.position) * 0.02f - fwd * (faceH * 0.3f);
            return new Frame
            {
                CenterLocal = head.InverseTransformPoint(center),
                Size = faceH / Mathf.Max(1e-4f, Mathf.Abs(head.lossyScale.y)),
                RotLocal = Quaternion.Inverse(head.rotation) * Quaternion.LookRotation(fwd, up),
                Depth = faceH * 0.3f / Mathf.Max(1e-4f, Mathf.Abs(head.lossyScale.y)),
            };
        }

        /// <summary>The head-bone axis direction (±right/up/forward) closest to <paramref name="v"/>, optionally excluding one axis.</summary>
        private static Vector3 BestAxis(Transform head, Vector3 v, Vector3? not = null)
        {
            var axes = new[] { head.right, -head.right, head.up, -head.up, head.forward, -head.forward };
            Vector3 best = v.normalized;
            float bestDot = -2f;
            foreach (var ax in axes)
            {
                if (not.HasValue && Mathf.Abs(Vector3.Dot(ax, not.Value)) > 0.5f) continue;
                float d = Vector3.Dot(ax, v.normalized);
                if (d > bestDot) { bestDot = d; best = ax; }
            }
            return best;
        }

        private static void EnsureCamera(int size)
        {
            var main = Camera.main;
            if (_cam == null)
            {
                var go = new GameObject("StudioEX.FaceCamera") { hideFlags = HideFlags.HideAndDontSave };
                UnityEngine.Object.DontDestroyOnLoad(go);
                _cam = go.AddComponent<Camera>();
                _cam.enabled = false; // rendered manually, on request
            }
            if (main != null)
            {
                _cam.clearFlags = main.clearFlags;
                _cam.backgroundColor = main.backgroundColor;
                _cam.cullingMask = main.cullingMask;
                _cam.renderingPath = main.renderingPath;
                _cam.allowHDR = main.allowHDR;
            }
            if (_rt == null || _rt.width != size)
            {
                if (_rt != null) { _rt.Release(); UnityEngine.Object.Destroy(_rt); }
                if (_tex != null) UnityEngine.Object.Destroy(_tex);
                _rt = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 4, name = "StudioEX.FaceView" };
                _tex = new Texture2D(size, size, TextureFormat.RGB24, false);
            }
        }

        /// <summary>Scene reset: cached bone lookups point at destroyed characters.</summary>
        public static void ClearCache()
        {
            BoneCache.Clear();
            Frames.Clear();
        }
    }
}
