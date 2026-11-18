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
            r.Add("light.saveRig", Save);
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
            light.guideObject.changeAmount.pos = pos;
            light.guideObject.changeAmount.rot = rot.eulerAngles;
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
            Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values.OfType<OCIFolder>().Where(f => (f.name ?? "").StartsWith(Prefix));

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
                var p = l.objectLight.transform.position;
                var off = p - an.Head;
                float dist = off.magnitude / an.Height;
                var flat = Vector3.ProjectOnPlane(off, Vector3.up);
                float az = flat.sqrMagnitude < 1e-8f ? 0f : SignedAngle(an.Forward, flat.normalized);
                float el = Mathf.Asin(Mathf.Clamp(off.normalized.y, -1f, 1f)) * Mathf.Rad2Deg;
                string type = l.lightType == LightType.Spot ? "spot" : l.lightType == LightType.Point ? "point" : "directional";
                var info = l.lightInfo;
                specs.Add(L("Light", type, az, el, dist, new[] { info.color.r, info.color.g, info.color.b }, info.intensity, info.range / an.Height, info.spotAngle, info.shadow));
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
