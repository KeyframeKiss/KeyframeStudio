using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Lighting rigs: several Studio lights placed around a character in one go — positions are relative to the
    /// character's facing and height, so a rig fits any character anywhere. An applied rig is a folder
    /// "Lighting rig: name" with its lights, so it can be switched off (before/after), removed or saved as a
    /// reusable rig (UserData/StudioEX/light-rigs).
    ///
    /// Vanilla Studio allows 2 lights per scene; with IllusionFixes' Unlimited Map Lights there is no limit.
    /// Koikatsu's toon shading responds to extra lights mostly as colour and rim tints (the main character light
    /// shapes the shadows), so the built-in rigs use fairly strong intensities.
    /// </summary>
    internal static class LightRigs
    {
        public const string Prefix = "Lighting rig: ";
        private static string Folder => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/light-rigs"));

        public static void Register(CommandRouter r)
        {
            r.Add("light.rigs", a => ListRigs());
            r.Add("light.applyRig", Apply);
            r.Add("light.sceneRigs", a => SceneRigs());
            r.Add("light.setRigEnabled", SetEnabled);
            r.Add("light.removeRig", Remove);
            // one light (Studio's own delete: not undoable, like deleting it in Studio)
            r.Add("light.remove", a =>
            {
                var l = SceneApi.FindOci(a.GetInt("id")) as OCILight ?? throw new BridgeException("That light is gone");
                Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(l.treeNodeObject);
                return SceneRigs();
            });
            r.Add("light.saveRig", Save);
            // the lighting maker: a rig's lights placed around the character by hand, live
            r.Add("light.rigGet", RigGet);
            r.Add("light.rigPlace", RigPlace);
            r.Add("light.rigAdd", RigAdd);
            r.Add("light.rigRetype", RigRetype);
            r.Add("light.deleteRig", Delete);
        }

        // ---------------- rig definitions ----------------
        // az: degrees around the character from straight in front (positive = the character's right),
        // el: degrees above the aim point, dist / range: × the character's height, aim: head or chest.

        private static Dictionary<string, object> L(string role, string type, float az, float el, float dist, float[] color, float intensity, float range = 2.5f, float angle = 45f, bool shadow = true, string aim = "head") =>
            new Dictionary<string, object>
            {
                { "role", role }, { "type", type }, { "az", (double)az }, { "el", (double)el }, { "dist", (double)dist }, { "aim", aim },
                { "color", color.Select(x => (object)(double)x).ToList() }, { "intensity", (double)intensity }, { "range", (double)range },
                { "angle", (double)angle }, { "shadow", shadow },
            };

        private static readonly float[] Warm = { 1f, 0.92f, 0.82f }, Cool = { 0.78f, 0.86f, 1f }, White = { 1f, 1f, 1f };

        private static List<Dictionary<string, object>> Builtin() => new List<Dictionary<string, object>>
        {
            Rig("Three-point", "Key from the front side, soft fill opposite, rim light behind to separate from the background",
                L("Key", "spot", 40, 30, 1.6f, Warm, 1.8f, 3f, 50f), L("Fill", "point", -50, 10, 1.4f, Cool, 0.7f, 3f, 0, false), L("Rim", "spot", 160, 35, 1.5f, White, 1.6f, 3f, 45f, false)),
            Rig("Rembrandt", "Dramatic: one high key light at 45°, a faint fill — the classic triangle of light on the far cheek",
                L("Key", "spot", 45, 40, 1.5f, Warm, 2f, 3f, 45f), L("Fill", "point", -60, 0, 1.6f, Cool, 0.4f, 3f, 0, false)),
            Rig("Butterfly", "Glamour: key high and straight in front, gentle fill from below",
                L("Key", "spot", 0, 45, 1.5f, White, 1.8f, 3f, 45f), L("Fill", "point", 0, -15, 1.2f, Warm, 0.5f, 2.5f, 0, false, "chest")),
            Rig("Split", "Half the face lit from the side, the other half in shadow",
                L("Key", "spot", 90, 10, 1.4f, Warm, 2f, 3f, 40f)),
            Rig("Rim only", "Silhouette: two lights behind the character outline it",
                L("Rim left", "spot", 140, 25, 1.5f, Cool, 1.8f, 3f, 40f, false), L("Rim right", "spot", -140, 25, 1.5f, Cool, 1.8f, 3f, 40f, false)),
            Rig("Soft front", "Even, flattering light from the front with no harsh shadows",
                L("Front", "point", 0, 15, 1.3f, White, 0.9f, 3.5f, 0, false), L("Top", "point", 0, 70, 1.2f, Warm, 0.6f, 3f, 0, false)),
        };

        private static Dictionary<string, object> Rig(string name, string note, params Dictionary<string, object>[] lights) =>
            new Dictionary<string, object> { { "name", name }, { "note", note }, { "builtin", true }, { "lights", lights.Cast<object>().ToList() } };

        private static object ListRigs()
        {
            var list = Builtin().Cast<object>().ToList();
            if (Directory.Exists(Folder))
                foreach (var f in Directory.GetFiles(Folder, "*.json").OrderBy(x => x))
                {
                    try
                    {
                        var d = Json.Parse(File.ReadAllText(f, System.Text.Encoding.UTF8)) as Dictionary<string, object>;
                        if (d == null) continue;
                        d["file"] = Path.GetFileNameWithoutExtension(f);
                        d["builtin"] = false;
                        list.Add(d);
                    }
                    catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Bad light rig " + f + ": " + e.Message); }
                }
            return list;
        }

        // ---------------- the character anchor ----------------

        private struct Anchor
        {
            public Vector3 Ground, Head, Chest, Forward;
            public float Height;
        }

        private static Anchor AnchorOf(OCIChar c)
        {
            var root = c.charInfo.transform;
            Transform head = null, chest = null;
            foreach (var t in c.charInfo.GetComponentsInChildren<Transform>(true))
            {
                if (t.name == "cf_j_head") head = t;
                else if (t.name == "cf_j_spine03") chest = t;
            }
            var fwd = Vector3.ProjectOnPlane(root.forward, Vector3.up);
            if (fwd.sqrMagnitude < 1e-6f) fwd = Vector3.forward;
            var a = new Anchor { Ground = root.position, Head = head != null ? head.position : root.position + Vector3.up * 1.4f, Forward = fwd.normalized };
            a.Chest = chest != null ? chest.position : Vector3.Lerp(a.Ground, a.Head, 0.75f);
            a.Height = Mathf.Max(0.1f, (a.Head.y - a.Ground.y) * 1.1f);
            return a;
        }

        // ---------------- apply ----------------

        private static int LightNo(string type, bool charaOnly)
        {
            var info = Singleton<Info>.Instance.dicLightLoadInfo;
            string[] words = type == "spot" ? new[] { "spot", "スポット" } : type == "point" ? new[] { "point", "ポイント" } : new[] { "direct", "ディレクショナル", "平行" };
            Func<Info.LightLoadInfo, bool> named = v => words.Any(w => (v.name ?? "").IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0);
            var match = info.Values.Where(named).OrderBy(v => charaOnly ? (v.target == Info.LightLoadInfo.Target.Chara ? 0 : v.target == Info.LightLoadInfo.Target.All ? 1 : 2) : (v.target == Info.LightLoadInfo.Target.All ? 0 : 1)).FirstOrDefault();
            if (match == null) throw new BridgeException("This Studio has no " + type + " light type");
            return match.no;
        }

        /// <summary>args: {id: character, rig: {name, lights:[…]} | name, charaOnly?: true} → {folder, lights}</summary>
        private static object Apply(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("That character isn't loaded");
            var rig = a.GetObject("rig");
            if (rig == null)
            {
                string want = a.GetString("rig") ?? a.GetString("name");
                rig = (ListRigs() as List<object>).Cast<Dictionary<string, object>>().FirstOrDefault(x => string.Equals(x.GetString("name"), want, StringComparison.OrdinalIgnoreCase));
                if (rig == null) throw new BridgeException("No lighting rig called “" + want + "”");
            }
            var folderKey = Build(c, rig, a.GetBool("charaOnly", true));
            UndoStack.Push(new RigUndo(folderKey, c, rig, a.GetBool("charaOnly", true)));
            return new Dictionary<string, object> { { "folder", folderKey }, { "lights", rig.GetList("lights").Count } };
        }

        private static int Build(OCIChar c, Dictionary<string, object> rig, bool charaOnly)
        {
            var specs = rig.GetList("lights").OfType<Dictionary<string, object>>().ToList();
            if (specs.Count == 0) throw new BridgeException("That rig has no lights");
            bool unlimited = BepInEx.Bootstrap.Chainloader.PluginInfos.Keys.Any(k => k.IndexOf("UnlimitedMapLights", StringComparison.OrdinalIgnoreCase) >= 0);
            int existing = Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values.OfType<OCILight>().Count();
            if (!unlimited && existing + specs.Count > 2)
                throw new BridgeException("Studio allows 2 lights per scene and this rig needs " + specs.Count + (existing > 0 ? " more (" + existing + " already used)" : "") + ". Remove lights, pick a smaller rig, or install IllusionFixes' Unlimited Map Lights.");

            var anchor = AnchorOf(c);
            var studio = Singleton<Studio.Studio>.Instance;
            var folder = AddObjectFolder.Add();
            folder.name = Prefix + (rig.GetString("name") ?? "Rig");
            folder.objectInfo.changeAmount.pos = Vector3.zero;
            folder.objectInfo.changeAmount.rot = Vector3.zero;
            foreach (var spec in specs)
            {
                var light = AddObjectLight.Add(LightNo(spec.GetString("type") ?? "point", charaOnly));
                if (light == null) continue;
                studio.treeNodeCtrl.SetParent(light.treeNodeObject, folder.treeNodeObject);
                Place(light, spec, anchor);
                if (!string.IsNullOrEmpty(spec.GetString("role"))) SceneApi.SetName(light, spec.GetString("role"));
            }
            Singleton<UndoRedoManager>.Instance.Clear(); // like Studio's own Add Light: its undo can't remove these
            return folder.objectInfo.dicKey;
        }

        private static void Place(OCILight light, Dictionary<string, object> spec, Anchor an)
        {
            var aim = spec.GetString("aim") == "chest" ? an.Chest : an.Head;
            float az = spec.GetFloat("az"), el = spec.GetFloat("el");
            var dir = Quaternion.AngleAxis(az, Vector3.up) * an.Forward;
            var side = Vector3.Cross(Vector3.up, dir).normalized;
            dir = Quaternion.AngleAxis(-el, side) * dir;
            var pos = aim + dir.normalized * spec.GetFloat("dist", 1.5f) * an.Height;
            var rot = Quaternion.LookRotation((aim - pos).normalized, Vector3.up);
            var parent = light.guideObject.transformTarget != null ? light.guideObject.transformTarget.parent : null;
            light.guideObject.changeAmount.pos = parent != null ? parent.InverseTransformPoint(pos) : pos;
            light.guideObject.changeAmount.rot = (parent != null ? Quaternion.Inverse(parent.rotation) * rot : rot).eulerAngles;
            var col = spec.GetList("color");
            if (col.Count >= 3) light.SetColor(new Color(Convert.ToSingle(col[0]), Convert.ToSingle(col[1]), Convert.ToSingle(col[2])));
            light.SetIntensity(spec.GetFloat("intensity", 1f), true);
            light.SetRange(spec.GetFloat("range", 2.5f) * an.Height, true);
            light.SetSpotAngle(spec.GetFloat("angle", 45f), true);
            light.SetShadow(spec.GetBool("shadow", true), true);
            light.SetEnable(true, true);
        }

        /// <summary>Undo removes the rig's folder (and lights); redo builds it again.</summary>
        private sealed class RigUndo : IUndoEntry
        {
            private readonly int _folder;
            private readonly OCIChar _c;
            private readonly Dictionary<string, object> _rig;
            private readonly bool _charaOnly;
            public RigUndo(int folder, OCIChar c, Dictionary<string, object> rig, bool charaOnly) { _folder = folder; _c = c; _rig = rig; _charaOnly = charaOnly; }
            public string Label => "Lighting rig";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                RemoveFolder(_folder);
                return new RigRedo(_c, _rig, _charaOnly);
            }
        }

        private sealed class RigRedo : IUndoEntry
        {
            private readonly OCIChar _c;
            private readonly Dictionary<string, object> _rig;
            private readonly bool _charaOnly;
            public RigRedo(OCIChar c, Dictionary<string, object> rig, bool charaOnly) { _c = c; _rig = rig; _charaOnly = charaOnly; }
            public string Label => "Lighting rig";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                if (_c.charInfo == null) throw new InvalidOperationException("character deleted");
                return new RigUndo(Build(_c, _rig, _charaOnly), _c, _rig, _charaOnly);
            }
        }

        // ---------------- rigs in the scene ----------------

        private static IEnumerable<OCIFolder> RigFolders() =>
            (Singleton<Studio.Studio>.Instance?.dicObjectCtrl?.Values ?? Enumerable.Empty<ObjectCtrlInfo>()).OfType<OCIFolder>().Where(f => (f.name ?? "").StartsWith(Prefix));

        private static List<OCILight> LightsIn(OCIFolder f) =>
            f.treeNodeObject.child.Select(n => Singleton<Studio.Studio>.Instance.dicInfo.TryGetValue(n, out var oci) ? oci as OCILight : null).Where(l => l != null).ToList();

        private static object SceneRigs() => RigFolders().Select(f =>
        {
            var lights = LightsIn(f);
            return (object)new Dictionary<string, object>
            {
                { "folder", f.objectInfo.dicKey }, { "name", f.name.Substring(Prefix.Length) }, { "lights", lights.Count },
                { "enabled", lights.Any(l => l.lightInfo.enable) },
            };
        }).ToList();

        private static OCIFolder FindFolder(int key) =>
            RigFolders().FirstOrDefault(f => f.objectInfo.dicKey == key) ?? throw new BridgeException("That lighting rig is gone");

        /// <summary>args: {folder, enabled} — switch a rig's lights (before/after).</summary>
        private static object SetEnabled(Dictionary<string, object> a)
        {
            bool on = a.GetBool("enabled", true);
            foreach (var l in LightsIn(FindFolder(a.GetInt("folder")))) l.SetEnable(on, true);
            return SceneRigs();
        }

        private static void RemoveFolder(int key)
        {
            var f = RigFolders().FirstOrDefault(x => x.objectInfo.dicKey == key);
            if (f != null) Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(f.treeNodeObject);
        }

        /// <summary>args: {folder} — delete a rig and its lights (not undoable: Studio's own delete).</summary>
        private static object Remove(Dictionary<string, object> a)
        {
            FindFolder(a.GetInt("folder"));
            RemoveFolder(a.GetInt("folder"));
            return SceneRigs();
        }

        // ---------------- the lighting maker ----------------

        /// <summary>Where a light is around the character and how it's set, in a rig's own terms.</summary>
        private static Dictionary<string, object> SpecOf(OCILight l, Anchor an)
        {
            var t = l.objectLight.transform;
            var p = t.position;
            // what it points at: the head or the chest, whichever its beam passes closer to (a point light: the head)
            string aim = "head";
            if (l.lightType != LightType.Point)
            {
                var f = t.forward;
                float dh = Vector3.Cross(f, an.Head - p).magnitude, dc = Vector3.Cross(f, an.Chest - p).magnitude;
                if (dc < dh * 0.8f) aim = "chest";
            }
            var target = aim == "chest" ? an.Chest : an.Head;
            var off = p - target;
            var flat = Vector3.ProjectOnPlane(off, Vector3.up);
            float az = flat.sqrMagnitude < 1e-8f ? 0f : SignedAngle(an.Forward, flat.normalized);
            float el = off.sqrMagnitude < 1e-8f ? 0f : Mathf.Asin(Mathf.Clamp(off.normalized.y, -1f, 1f)) * Mathf.Rad2Deg;
            string type = l.lightType == LightType.Spot ? "spot" : l.lightType == LightType.Point ? "point" : "directional";
            var info = l.lightInfo;
            var d = L(l.treeNodeObject != null ? l.treeNodeObject.textName : "Light", type, az, el, off.magnitude / an.Height,
                new[] { info.color.r, info.color.g, info.color.b }, info.intensity, info.range / an.Height, info.spotAngle, info.shadow, aim);
            d["id"] = l.objectInfo.dicKey;
            d["name"] = d["role"];
            d["enabled"] = info.enable;
            return d;
        }

        private static OCILight LightOf(Dictionary<string, object> a) =>
            SceneApi.FindOci(a.GetInt("light")) as OCILight ?? throw new BridgeException("That light is gone");

        private static OCIChar CharaOf(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("Select the character to light");
            return c;
        }

        /// <summary>args: {id: character, folder} → the rig's lights around that character, with the measures to show them in metres.</summary>
        private static object RigGet(Dictionary<string, object> a)
        {
            var an = AnchorOf(CharaOf(a));
            var f = FindFolder(a.GetInt("folder"));
            return new Dictionary<string, object>
            {
                { "folder", f.objectInfo.dicKey }, { "name", f.name.Substring(Prefix.Length) },
                { "height", (double)an.Height }, { "head", (double)(an.Head.y - an.Ground.y) }, { "chest", (double)(an.Chest.y - an.Ground.y) },
                { "lights", LightsIn(f).Select(l => (object)SpecOf(l, an)).ToList() },
            };
        }

        /// <summary>args: {id: character, light, spec: {az, el, dist, aim, color, intensity, range, angle, shadow, enabled, name}, drag?}
        /// → the light's spec. Only what's given changes; one drag (same drag key) is one undo step.</summary>
        private static object RigPlace(Dictionary<string, object> a)
        {
            var c = CharaOf(a);
            var l = LightOf(a);
            var an = AnchorOf(c);
            var before = SpecOf(l, an);
            var spec = new Dictionary<string, object>(before);
            var patch = a.GetObject("spec") ?? new Dictionary<string, object>();
            foreach (var kv in patch) spec[kv.Key] = kv.Value;
            Apply1(l, spec, an);
            UndoStack.Push(new PlaceUndo(c, l.objectInfo.dicKey, before, a.GetString("drag") ?? Guid.NewGuid().ToString()));
            return SpecOf(l, an);
        }

        /// <summary>Place and set a light from a spec, its name and on/off too.</summary>
        private static void Apply1(OCILight l, Dictionary<string, object> spec, Anchor an)
        {
            Place(l, spec, an);
            l.SetEnable(spec.GetBool("enabled", true), true);
            string name = spec.GetString("name") ?? spec.GetString("role");
            if (!string.IsNullOrEmpty(name) && l.treeNodeObject != null && l.treeNodeObject.textName != name) SceneApi.SetName(l, name);
        }

        private sealed class PlaceUndo : IUndoEntry
        {
            private readonly OCIChar _c;
            private readonly int _light;
            private readonly Dictionary<string, object> _spec;
            private readonly string _drag;
            public PlaceUndo(OCIChar c, int light, Dictionary<string, object> spec, string drag) { _c = c; _light = light; _spec = spec; _drag = drag; }
            public string Label => "Light";
            public bool Absorbs(IUndoEntry newer) => newer is PlaceUndo n && n._light == _light && n._drag == _drag;
            public IUndoEntry Restore()
            {
                var l = SceneApi.FindOci(_light) as OCILight ?? throw new InvalidOperationException("light deleted");
                if (_c.charInfo == null) throw new InvalidOperationException("character deleted");
                var an = AnchorOf(_c);
                var now = SpecOf(l, an);
                Apply1(l, _spec, an);
                return new PlaceUndo(_c, _light, now, Guid.NewGuid().ToString());
            }
        }

        private static void CheckRoom(int more)
        {
            bool unlimited = BepInEx.Bootstrap.Chainloader.PluginInfos.Keys.Any(k => k.IndexOf("UnlimitedMapLights", StringComparison.OrdinalIgnoreCase) >= 0);
            int existing = Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values.OfType<OCILight>().Count();
            if (!unlimited && existing + more > 2)
                throw new BridgeException("Studio allows 2 lights per scene (" + existing + " used). Remove one, or install IllusionFixes' Unlimited Map Lights.");
        }

        private static OCILight AddLight(Dictionary<string, object> spec, OCIFolder folder, Anchor an, bool charaOnly)
        {
            var light = AddObjectLight.Add(LightNo(spec.GetString("type") ?? "spot", charaOnly)) ?? throw new BridgeException("Studio couldn't add the light");
            Singleton<Studio.Studio>.Instance.treeNodeCtrl.SetParent(light.treeNodeObject, folder.treeNodeObject);
            Apply1(light, spec, an);
            Singleton<UndoRedoManager>.Instance.Clear(); // like Studio's own Add Light: its undo can't remove these
            return light;
        }

        /// <summary>args: {id: character, folder?, name? (a new rig's), spec, charaOnly?} → {folder, light}: a light dropped into a rig
        /// (a new rig "Lighting rig: name" when no folder). Undo removes it.</summary>
        private static object RigAdd(Dictionary<string, object> a)
        {
            var c = CharaOf(a);
            CheckRoom(1);
            var an = AnchorOf(c);
            OCIFolder folder;
            bool made = !a.Has("folder");
            if (made)
            {
                folder = AddObjectFolder.Add();
                folder.name = Prefix + ((a.GetString("name") ?? "").Trim().Length > 0 ? a.GetString("name").Trim() : "My rig");
                folder.objectInfo.changeAmount.pos = Vector3.zero;
                folder.objectInfo.changeAmount.rot = Vector3.zero;
            }
            else folder = FindFolder(a.GetInt("folder"));
            var spec = a.GetObject("spec") ?? L("Key", "spot", 40, 30, 1.6f, Warm, 1.5f, 3f, 45f);
            var light = AddLight(spec, folder, an, a.GetBool("charaOnly", true));
            UndoStack.Push(new AddUndo(light.objectInfo.dicKey, made ? folder.objectInfo.dicKey : -1));
            return new Dictionary<string, object> { { "folder", folder.objectInfo.dicKey }, { "light", light.objectInfo.dicKey } };
        }

        /// <summary>Undo of a dropped light: it goes (with the rig it started); not redone (Studio can't bring a deleted light back).</summary>
        private sealed class AddUndo : IUndoEntry
        {
            private readonly int _light, _folder;
            public AddUndo(int light, int folder) { _light = light; _folder = folder; }
            public string Label => "Add light";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                if (_folder >= 0) RemoveFolder(_folder);
                else if (SceneApi.FindOci(_light) is OCILight l) Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(l.treeNodeObject);
                return null;
            }
        }

        /// <summary>args: {id: character, light, type: spot|point|directional, charaOnly?} → {light}: the same light as another kind
        /// (Studio's lights can't change kind: a new one takes its place, name and settings).</summary>
        private static object RigRetype(Dictionary<string, object> a)
        {
            var c = CharaOf(a);
            var l = LightOf(a);
            var an = AnchorOf(c);
            var spec = SpecOf(l, an);
            spec["type"] = a.GetString("type") ?? "spot";
            var folder = Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values.OfType<OCIFolder>()
                .FirstOrDefault(f => f.treeNodeObject.child.Contains(l.treeNodeObject)) ?? throw new BridgeException("That light isn't in a rig");
            Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(l.treeNodeObject);
            var light = AddLight(spec, folder, an, a.GetBool("charaOnly", true));
            return new Dictionary<string, object> { { "light", light.objectInfo.dicKey } };
        }

        // ---------------- saved rigs ----------------

        /// <summary>args: {name, id: character, folder?: a rig folder (else every light in the scene)}</summary>
        private static object Save(Dictionary<string, object> a)
        {
            string name = (a.GetString("name") ?? "").Trim();
            if (name.Length == 0) throw new BridgeException("Name the rig first");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("Select the character the lights are arranged around");
            var an = AnchorOf(c);
            var lights = a.Has("folder") ? LightsIn(FindFolder(a.GetInt("folder"))) : Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values.OfType<OCILight>().ToList();
            if (lights.Count == 0) throw new BridgeException("There are no lights to save");
            var specs = new List<object>();
            foreach (var l in lights)
            {
                var d = SpecOf(l, an);
                foreach (var k in new[] { "id", "name", "enabled" }) d.Remove(k);
                specs.Add(d);
            }
            Directory.CreateDirectory(Folder);
            var bad = Path.GetInvalidFileNameChars();
            string file = new string(name.Select(ch => Array.IndexOf(bad, ch) >= 0 ? '_' : ch).ToArray()).Trim('.', ' ');
            var doc = new Dictionary<string, object> { { "name", name }, { "note", a.GetString("note") ?? "" }, { "lights", specs } };
            File.WriteAllText(Path.Combine(Folder, file + ".json"), Json.Serialize(doc), new System.Text.UTF8Encoding(false));
            return ListRigs();
        }

        /// <summary>Angle from a to b around world up, signed so that AngleAxis(result, up) * a == b (Unity 5.6 has no SignedAngle).</summary>
        private static float SignedAngle(Vector3 a, Vector3 b) => Vector3.Angle(a, b) * Mathf.Sign(Vector3.Dot(Vector3.up, Vector3.Cross(a, b)));

        private static object Delete(Dictionary<string, object> a)
        {
            var bad = Path.GetInvalidFileNameChars();
            string file = new string((a.GetString("file") ?? "").Select(ch => Array.IndexOf(bad, ch) >= 0 ? '_' : ch).ToArray());
            var path = Path.Combine(Folder, file + ".json");
            if (File.Exists(path)) File.Delete(path);
            return ListRigs();
        }
    }
}
