using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using BepInEx.Bootstrap;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// "Look" = everything that decides how a scene renders, in one place:
    ///   effects — color grading (LUT + KK_TwoLut second LUT + blend), SSAO, bloom, depth of field, vignette,
    ///             fog, sun shafts, shadows
    ///   toon    — Studio's global character shading: ramp, outline color/width, ambient shadow, face options
    ///   lights  — character light and map light (color, intensity, direction, shadows)
    ///   materials — per-shader property tweaks via MaterialEditor (see MaterialLookApi)
    /// Values go into SceneInfo (so they save with the scene) and are applied through Studio's own
    /// SystemButtonCtrl/CameraLightCtrl refresh, which also keeps Studio's built-in panels in sync.
    /// Presets live in UserData/StudioEX/looks as JSON + JPEG thumbnail and can be applied partially
    /// (choose groups) and at any strength (blend from current look toward the preset).
    /// </summary>
    internal static class LookApi
    {
        public static readonly string[] Groups = { "effects", "toon", "lights", "materials" };

        private static string Folder => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/looks"));

        public static void Register(CommandRouter r)
        {
            r.Add("look.get", a => Get());
            r.Add("look.set", a =>
            {
                string keys = string.Join(",", a.Keys.SelectMany(g => a.GetObject(g)?.Keys.Select(k => g + "." + k) ?? new[] { g }).OrderBy(k => k).ToArray());
                UndoStack.Push(new LookUndo(Snapshot(), keys));
                Apply(a, 1f);
                return Get();
            });
            r.Add("look.presets", a => ListPresets());
            r.Add("look.savePreset", SavePreset);
            r.Add("look.applyPreset", ApplyPreset);
            r.Add("look.deletePreset", DeletePreset);
            r.Add("look.resetDefault", a =>
            {
                UndoStack.Push(new LookUndo(Snapshot(), "reset"));
                Apply(Defaults(), 1f);
                return Get();
            });
        }

        // ------------------------------------------------------------------
        // Read
        // ------------------------------------------------------------------

        private static SceneInfo Info => SceneApi.Studio.sceneInfo;

        private static List<object> C(Color c) => new List<object> { c.r, c.g, c.b, c.a };

        private static Color ToColor(object o, Color fallback)
        {
            var l = o as List<object>;
            if (l == null || l.Count < 3) return fallback;
            return new Color(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]), l.Count > 3 ? Convert.ToSingle(l[3]) : fallback.a);
        }

        private static bool TwoLutAvailable => Chainloader.PluginInfos.ContainsKey("com.deathweasel.bepinex.twolut");

        /// <summary>For Compat: null when the second LUT slot can be read and set.</summary>
        public static string ProbeTwoLut()
        {
            var p = TwoLutProp;
            return p != null && p.CanRead && p.CanWrite && p.PropertyType == typeof(int) ? null : "CurrentLut2LocalSlot not found";
        }

        private static PropertyInfo TwoLutProp
        {
            get
            {
                if (!TwoLutAvailable) return null;
                var t = Chainloader.PluginInfos["com.deathweasel.bepinex.twolut"].Instance?.GetType();
                return t?.GetProperty("CurrentLut2LocalSlot", BindingFlags.Public | BindingFlags.Static);
            }
        }

        /// <summary>Restorable state of all non-material groups.</summary>
        public static Dictionary<string, object> Snapshot()
        {
            var s = Info;
            int lut2 = -1;
            try { if (TwoLutProp != null) lut2 = (int)TwoLutProp.GetValue(null, null); } catch { }
            var effects = new Dictionary<string, object>
            {
                { "lut", (double)s.aceNo }, { "lut2", (double)lut2 }, { "lutBlend", (double)s.aceBlend },
                { "ssao", s.enableAOE }, { "ssaoColor", C(s.aoeColor) }, { "ssaoRadius", (double)s.aoeRadius },
                { "bloom", s.enableBloom }, { "bloomIntensity", (double)s.bloomIntensity }, { "bloomThreshold", (double)s.bloomThreshold }, { "bloomBlur", (double)s.bloomBlur },
                { "dof", s.enableDepth }, { "dofFocal", (double)s.depthFocalSize }, { "dofAperture", (double)s.depthAperture },
                { "vignette", s.enableVignette },
                { "fog", s.enableFog }, { "fogColor", C(s.fogColor) }, { "fogHeight", (double)s.fogHeight }, { "fogStart", (double)s.fogStartDistance },
                { "sunShafts", s.enableSunShafts }, { "sunColor", C(s.sunColor) }, { "sunThreshold", C(s.sunThresholdColor) },
                { "shadow", s.enableShadow },
            };
            var toon = new Dictionary<string, object>
            {
                { "ramp", (double)s.rampG }, { "lineColor", (double)s.lineColorG }, { "lineWidth", (double)s.lineWidthG },
                { "ambientShadow", C(s.ambientShadow) }, { "ambientShadowG", (double)s.ambientShadowG },
                { "faceNormal", s.faceNormal }, { "faceShadow", s.faceShadow },
            };
            var lights = new Dictionary<string, object>
            {
                { "charaColor", C(s.charaLight.color) }, { "charaIntensity", (double)s.charaLight.intensity },
                { "charaRot", new List<object> { (double)s.charaLight.rot[0], (double)s.charaLight.rot[1] } }, { "charaShadow", s.charaLight.shadow },
                { "mapColor", C(s.mapLight.color) }, { "mapIntensity", (double)s.mapLight.intensity },
                { "mapRot", new List<object> { (double)s.mapLight.rot[0], (double)s.mapLight.rot[1] } }, { "mapShadow", s.mapLight.shadow },
            };
            return new Dictionary<string, object> { { "effects", effects }, { "toon", toon }, { "lights", lights } };
        }

        private static object Get()
        {
            var d = Snapshot();
            var luts = Studio.Info.Instance.dicFilterLoadInfo.OrderBy(k => k.Key)
                .Select(kv => (object)new Dictionary<string, object> { { "id", kv.Key }, { "name", kv.Value.name }, { "nameEn", Translation.Get(kv.Value.name, false, "Color grade") } }).ToList();
            var ramps = new List<object>();
            try
            {
                foreach (var kv in Singleton<Manager.Character>.Instance.chaListCtrl.GetCategoryInfo(ChaListDefine.CategoryNo.mt_ramp).OrderBy(k => k.Key))
                    ramps.Add(new Dictionary<string, object> { { "id", kv.Value.Id }, { "name", kv.Value.Name }, { "nameEn", Translation.Get(kv.Value.Name, false, "Shading ramp") } });
            }
            catch { }
            d["luts"] = luts;
            d["ramps"] = ramps;
            d["twoLut"] = TwoLutAvailable;
            d["materialEditor"] = MaterialLookApi.Available;
            return d;
        }

        private static Dictionary<string, object> Defaults()
        {
            var cfg = Manager.Config.EtcData;
            Color c(int r, int g, int b) => new Color(r / 255f, g / 255f, b / 255f, 1f);
            return new Dictionary<string, object>
            {
                { "effects", new Dictionary<string, object>
                    {
                        { "lut", 0d }, { "lutBlend", 0d }, { "ssao", true }, { "ssaoColor", C(c(180, 180, 180)) }, { "ssaoRadius", 0.1d },
                        { "bloom", true }, { "bloomIntensity", 0.4d }, { "bloomThreshold", 0.6d }, { "bloomBlur", 0.8d },
                        { "dof", false }, { "dofFocal", 0.95d }, { "dofAperture", 0.6d }, { "vignette", true },
                        { "fog", false }, { "fogColor", C(c(137, 193, 221)) }, { "fogHeight", 1d }, { "fogStart", 0d },
                        { "sunShafts", false }, { "sunColor", C(Color.white) }, { "sunThreshold", C(c(128, 128, 128)) }, { "shadow", true },
                    }
                },
                { "toon", new Dictionary<string, object>
                    {
                        { "ramp", (double)cfg.rampId }, { "lineColor", (double)cfg.lineDepth }, { "lineWidth", (double)cfg.lineWidth },
                        { "ambientShadow", C(c(128, 128, 128)) }, { "ambientShadowG", (double)cfg.shadowDepth },
                        { "faceNormal", false }, { "faceShadow", false },
                    }
                },
                { "lights", new Dictionary<string, object>
                    {
                        { "charaColor", C(Color.white) }, { "charaIntensity", 1d }, { "charaRot", new List<object> { 0d, 0d } }, { "charaShadow", true },
                    }
                },
            };
        }

        // ------------------------------------------------------------------
        // Write
        // ------------------------------------------------------------------

        private static float Lerp(float a, double b, float s) => Mathf.LerpUnclamped(a, (float)b, s);
        private static Color LerpC(Color a, object b, float s) => Color.LerpUnclamped(a, ToColor(b, a), s);
        private static bool Pick(bool cur, Dictionary<string, object> g, string k, float s) => g.ContainsKey(k) && g[k] is bool b ? (s >= 0.5f ? b : cur) : cur;
        private static int PickInt(int cur, Dictionary<string, object> g, string k, float s) => g.Has(k) && s >= 0.5f ? g.GetInt(k) : cur;

        /// <summary>
        /// Applies any subset of groups/fields. strength &lt; 1 blends numbers and colors from the current
        /// look toward the target; switches and dropdowns flip at 50%.
        /// </summary>
        public static void Apply(Dictionary<string, object> look, float strength)
        {
            var s = Info;
            float k = Mathf.Clamp01(strength);
            var e = look.GetObject("effects");
            if (e != null)
            {
                if (e.Has("lut") && k >= 0.5f) s.aceNo = ResolveLut(e, "lut");
                if (e.Has("lutBlend")) s.aceBlend = Mathf.Clamp01(Lerp(s.aceBlend, e.GetDouble("lutBlend"), k));
                s.enableAOE = Pick(s.enableAOE, e, "ssao", k);
                if (e.Has("ssaoColor")) s.aoeColor = LerpC(s.aoeColor, e["ssaoColor"], k);
                if (e.Has("ssaoRadius")) s.aoeRadius = Mathf.Clamp01(Lerp(s.aoeRadius, e.GetDouble("ssaoRadius"), k));
                s.enableBloom = Pick(s.enableBloom, e, "bloom", k);
                if (e.Has("bloomIntensity")) s.bloomIntensity = Mathf.Clamp(Lerp(s.bloomIntensity, e.GetDouble("bloomIntensity"), k), 0f, 5f);
                if (e.Has("bloomThreshold")) s.bloomThreshold = Mathf.Clamp(Lerp(s.bloomThreshold, e.GetDouble("bloomThreshold"), k), 0.5f, 1f);
                if (e.Has("bloomBlur")) s.bloomBlur = Mathf.Clamp(Lerp(s.bloomBlur, e.GetDouble("bloomBlur"), k), 0.1f, 10f);
                s.enableDepth = Pick(s.enableDepth, e, "dof", k);
                if (e.Has("dofFocal")) s.depthFocalSize = Mathf.Clamp(Lerp(s.depthFocalSize, e.GetDouble("dofFocal"), k), 0f, 2f);
                if (e.Has("dofAperture")) s.depthAperture = Mathf.Clamp01(Lerp(s.depthAperture, e.GetDouble("dofAperture"), k));
                s.enableVignette = Pick(s.enableVignette, e, "vignette", k);
                s.enableFog = Pick(s.enableFog, e, "fog", k);
                if (e.Has("fogColor")) s.fogColor = LerpC(s.fogColor, e["fogColor"], k);
                if (e.Has("fogHeight")) s.fogHeight = Mathf.Clamp(Lerp(s.fogHeight, e.GetDouble("fogHeight"), k), 0f, 50f);
                if (e.Has("fogStart")) s.fogStartDistance = Mathf.Clamp(Lerp(s.fogStartDistance, e.GetDouble("fogStart"), k), 0f, 50f);
                s.enableSunShafts = Pick(s.enableSunShafts, e, "sunShafts", k);
                if (e.Has("sunColor")) s.sunColor = LerpC(s.sunColor, e["sunColor"], k);
                if (e.Has("sunThreshold")) s.sunThresholdColor = LerpC(s.sunThresholdColor, e["sunThreshold"], k);
                s.enableShadow = Pick(s.enableShadow, e, "shadow", k);
                if (e.Has("lut2") && k >= 0.5f && TwoLutProp != null)
                {
                    int lut2 = ResolveLut(e, "lut2");
                    if (lut2 >= 0) try { TwoLutProp.SetValue(null, lut2, null); } catch (Exception ex) { StudioBridgePlugin.Logger.LogDebug("TwoLut: " + ex.Message); }
                }
            }
            var t = look.GetObject("toon");
            if (t != null)
            {
                s.rampG = PickInt(s.rampG, t, "ramp", k);
                if (t.Has("lineColor")) s.lineColorG = Mathf.Clamp01(Lerp(s.lineColorG, t.GetDouble("lineColor"), k));
                if (t.Has("lineWidth")) s.lineWidthG = Mathf.Clamp01(Lerp(s.lineWidthG, t.GetDouble("lineWidth"), k));
                if (t.Has("ambientShadow")) s.ambientShadow = LerpC(s.ambientShadow, t["ambientShadow"], k);
                if (t.Has("ambientShadowG")) s.ambientShadowG = Mathf.Clamp01(Lerp(s.ambientShadowG, t.GetDouble("ambientShadowG"), k));
                s.faceNormal = Pick(s.faceNormal, t, "faceNormal", k);
                s.faceShadow = Pick(s.faceShadow, t, "faceShadow", k);
            }
            var l = look.GetObject("lights");
            if (l != null)
            {
                ApplyLight(s.charaLight, l, "chara", k);
                ApplyLight(s.mapLight, l, "map", k);
            }
            var studio = SceneApi.Studio;
            studio.systemButtonCtrl.UpdateInfo();   // pushes every effect value + refreshes Studio's own panels
            studio.cameraLightCtrl.Reflect();

            var mats = look.GetList("materials");
            if (mats.Count > 0 && MaterialLookApi.Available) MaterialLookApi.ApplyRules(mats, null, k);
        }

        private static void ApplyLight(CameraLightCtrl.LightInfo li, Dictionary<string, object> g, string p, float k)
        {
            if (g.Has(p + "Color")) li.color = LerpC(li.color, g[p + "Color"], k);
            if (g.Has(p + "Intensity")) li.intensity = Mathf.Clamp(Lerp(li.intensity, g.GetDouble(p + "Intensity"), k), 0f, 2f);
            var rot = g.GetList(p + "Rot");
            if (rot.Count >= 2)
            {
                li.rot[0] = Mathf.LerpAngle(li.rot[0], Convert.ToSingle(rot[0]), k);
                li.rot[1] = Mathf.LerpAngle(li.rot[1], Convert.ToSingle(rot[1]), k);
            }
            li.shadow = Pick(li.shadow, g, p + "Shadow", k);
        }

        /// <summary>LUT ids differ between installs (Sideloader); presets also store the name and prefer it.</summary>
        private static int ResolveLut(Dictionary<string, object> e, string key)
        {
            string name = e.GetString(key + "Name");
            if (!string.IsNullOrEmpty(name))
                foreach (var kv in Studio.Info.Instance.dicFilterLoadInfo)
                    if (kv.Value.name == name) return kv.Key;
            int id = e.GetInt(key);
            return Studio.Info.Instance.dicFilterLoadInfo.ContainsKey(id) ? id : (key == "lut" ? 0 : -1);
        }

        private sealed class LookUndo : IUndoEntry
        {
            private readonly Dictionary<string, object> _state;
            private readonly string _keys;
            public LookUndo(Dictionary<string, object> state, string keys) { _state = state; _keys = keys; }
            public string Label => "Look change";
            public bool Absorbs(IUndoEntry newer) => newer is LookUndo n && n._keys == _keys && _keys != "reset" && !_keys.StartsWith("preset");
            public IUndoEntry Restore()
            {
                var inverse = new LookUndo(Snapshot(), _keys);
                Apply(_state, 1f);
                return inverse;
            }
        }

        // ------------------------------------------------------------------
        // Presets
        // ------------------------------------------------------------------

        private static string SafeFile(string name)
        {
            var sb = new StringBuilder();
            foreach (char ch in name.Trim()) sb.Append(Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch);
            var s = sb.ToString();
            return s.Length == 0 ? "Look" : s;
        }

        private static void EnsureStarterPresets()
        {
            if (Directory.Exists(Folder)) return;
            Directory.CreateDirectory(Folder);
            Color c(int r, int g, int b) => new Color(r / 255f, g / 255f, b / 255f, 1f);
            Dictionary<string, object> P(string name, string note, Dictionary<string, object> effects, Dictionary<string, object> toon, Dictionary<string, object> lights)
            {
                var d = new Dictionary<string, object> { { "version", 1 }, { "name", name }, { "note", note }, { "builtin", true } };
                if (effects != null) d["effects"] = effects;
                if (toon != null) d["toon"] = toon;
                if (lights != null) d["lights"] = lights;
                return d;
            }
            var presets = new List<Dictionary<string, object>>
            {
                P("Studio Default", "Studio's out-of-the-box look", Defaults().GetObject("effects"), Defaults().GetObject("toon"), Defaults().GetObject("lights")),
                P("Soft Pastel", "Low contrast, gentle glow, light outlines",
                    new Dictionary<string, object> { { "bloom", true }, { "bloomIntensity", 0.9d }, { "bloomThreshold", 0.55d }, { "bloomBlur", 2.2d }, { "ssao", true }, { "ssaoRadius", 0.06d }, { "ssaoColor", C(c(205, 190, 210)) }, { "vignette", false } },
                    new Dictionary<string, object> { { "lineColor", 0.25d }, { "lineWidth", 0.35d }, { "ambientShadow", C(c(196, 170, 196)) }, { "ambientShadowG", 0.35d } },
                    new Dictionary<string, object> { { "charaColor", C(c(255, 244, 248)) }, { "charaIntensity", 1.05d } }),
                P("Cinematic Warm", "Golden key light, shallow depth of field, strong vignette",
                    new Dictionary<string, object> { { "bloom", true }, { "bloomIntensity", 0.7d }, { "bloomThreshold", 0.65d }, { "bloomBlur", 1.4d }, { "dof", true }, { "dofFocal", 0.6d }, { "dofAperture", 0.75d }, { "vignette", true }, { "ssao", true }, { "ssaoRadius", 0.12d }, { "ssaoColor", C(c(150, 110, 90)) } },
                    new Dictionary<string, object> { { "ambientShadow", C(c(170, 120, 105)) }, { "ambientShadowG", 0.6d }, { "lineColor", 0.55d } },
                    new Dictionary<string, object> { { "charaColor", C(c(255, 214, 170)) }, { "charaIntensity", 1.15d }, { "charaRot", new List<object> { 25d, -35d } } }),
                P("Moonlight", "Cool blue night, soft fog",
                    new Dictionary<string, object> { { "bloom", true }, { "bloomIntensity", 0.6d }, { "bloomThreshold", 0.7d }, { "fog", true }, { "fogColor", C(c(70, 90, 140)) }, { "fogHeight", 3d }, { "fogStart", 2d }, { "vignette", true }, { "ssao", true }, { "ssaoColor", C(c(60, 70, 110)) } },
                    new Dictionary<string, object> { { "ambientShadow", C(c(95, 110, 170)) }, { "ambientShadowG", 0.7d } },
                    new Dictionary<string, object> { { "charaColor", C(c(170, 195, 255)) }, { "charaIntensity", 0.8d }, { "charaRot", new List<object> { 40d, 30d } } }),
                P("Punchy Anime", "Crisp outlines, strong shadows, no blur",
                    new Dictionary<string, object> { { "bloom", true }, { "bloomIntensity", 0.3d }, { "bloomThreshold", 0.8d }, { "dof", false }, { "vignette", false }, { "ssao", true }, { "ssaoRadius", 0.15d } },
                    new Dictionary<string, object> { { "lineColor", 0.9d }, { "lineWidth", 0.7d }, { "ambientShadowG", 0.75d }, { "faceShadow", true } },
                    new Dictionary<string, object> { { "charaIntensity", 1.2d } }),
                P("Dreamy Glow", "Heavy bloom, sun shafts, pink haze",
                    new Dictionary<string, object> { { "bloom", true }, { "bloomIntensity", 1.6d }, { "bloomThreshold", 0.5d }, { "bloomBlur", 3.5d }, { "sunShafts", true }, { "sunColor", C(c(255, 220, 235)) }, { "fog", true }, { "fogColor", C(c(255, 205, 225)) }, { "fogHeight", 2d }, { "fogStart", 4d } },
                    new Dictionary<string, object> { { "lineColor", 0.3d }, { "ambientShadow", C(c(220, 170, 200)) } },
                    new Dictionary<string, object> { { "charaColor", C(c(255, 236, 244)) } }),
            };
            foreach (var p in presets)
                File.WriteAllText(Path.Combine(Folder, SafeFile((string)p["name"]) + ".json"), Json.Serialize(p), new UTF8Encoding(false));
        }

        private static object ListPresets()
        {
            EnsureStarterPresets();
            var list = new List<object>();
            foreach (var f in Directory.GetFiles(Folder, "*.json").OrderBy(f => f))
            {
                try
                {
                    var d = Json.Parse(File.ReadAllText(f, Encoding.UTF8)) as Dictionary<string, object>;
                    if (d == null) continue;
                    var item = new Dictionary<string, object>
                    {
                        { "file", Path.GetFileNameWithoutExtension(f) },
                        { "name", d.GetString("name") ?? Path.GetFileNameWithoutExtension(f) },
                        { "note", d.GetString("note") ?? "" },
                        { "builtin", d.GetBool("builtin") },
                        { "groups", Groups.Where(g => d.ContainsKey(g)).Cast<object>().ToList() },
                        { "modified", (File.GetLastWriteTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                    };
                    var jpg = Path.ChangeExtension(f, ".jpg");
                    if (File.Exists(jpg)) item["thumb"] = "data:image/jpeg;base64," + Convert.ToBase64String(File.ReadAllBytes(jpg));
                    list.Add(item);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Bad look preset " + f + ": " + e.Message); }
            }
            return list;
        }

        private static object SavePreset(Dictionary<string, object> a)
        {
            string name = (a.GetString("name") ?? "").Trim();
            if (name.Length == 0) throw new BridgeException("Give the look a name");
            EnsureStarterPresets();
            var groups = a.GetList("groups").Select(o => o as string).Where(g => g != null).ToList();
            if (groups.Count == 0) groups = new List<string> { "effects", "toon", "lights" };
            var snap = Snapshot();
            var d = new Dictionary<string, object> { { "version", 1 }, { "name", name }, { "note", a.GetString("note") ?? "" } };
            foreach (var g in groups)
            {
                if (g == "materials")
                {
                    var rules = a.GetList("materials");
                    if (rules.Count > 0) d["materials"] = rules;
                    continue;
                }
                if (!snap.ContainsKey(g)) continue;
                d[g] = snap[g];
            }
            // LUT ids are install-specific — remember names too.
            if (d.GetObject("effects") is Dictionary<string, object> eff)
            {
                if (Studio.Info.Instance.dicFilterLoadInfo.TryGetValue(eff.GetInt("lut"), out var l1)) eff["lutName"] = l1.name;
                if (Studio.Info.Instance.dicFilterLoadInfo.TryGetValue(eff.GetInt("lut2", -1), out var l2)) eff["lut2Name"] = l2.name;
            }
            string file = Path.Combine(Folder, SafeFile(name) + ".json");
            File.WriteAllText(file, Json.Serialize(d), new UTF8Encoding(false));
            var thumb = CameraApi.Snapshot(240);
            if (thumb != null) File.WriteAllBytes(Path.ChangeExtension(file, ".jpg"), Convert.FromBase64String(thumb.Substring(thumb.IndexOf(',') + 1)));
            return ListPresets();
        }

        private static Dictionary<string, object> LoadPreset(string file)
        {
            string path = Path.Combine(Folder, SafeFile(file) + ".json");
            if (!File.Exists(path)) throw new BridgeException("Look not found");
            return (Dictionary<string, object>)Json.Parse(File.ReadAllText(path, Encoding.UTF8));
        }

        private static object ApplyPreset(Dictionary<string, object> a)
        {
            var preset = LoadPreset(a.GetString("file"));
            var groups = a.GetList("groups").Select(o => o as string).Where(g => g != null).ToList();
            var filtered = new Dictionary<string, object>();
            foreach (var g in Groups)
                if (preset.ContainsKey(g) && (groups.Count == 0 || groups.Contains(g))) filtered[g] = preset[g];
            if (filtered.ContainsKey("materials") && a.Has("ids")) filtered["materialsTargets"] = a.GetList("ids");
            float strength = a.Has("strength") ? a.GetFloat("strength") : 1f;
            UndoStack.Push(new LookUndo(Snapshot(), "preset:" + a.GetString("file")));
            if (filtered.ContainsKey("materials") && MaterialLookApi.Available)
            {
                // Materials are applied (with their own undo) to the chosen characters/items.
                var mats = (List<object>)filtered["materials"];
                filtered.Remove("materials");
                Apply(filtered, strength);
                MaterialLookApi.ApplyRules(mats, a.GetList("ids"), strength);
            }
            else Apply(filtered, strength);
            return Get();
        }

        private static object DeletePreset(Dictionary<string, object> a)
        {
            string path = Path.Combine(Folder, SafeFile(a.GetString("file") ?? "") + ".json");
            if (!File.Exists(path)) throw new BridgeException("Look not found");
            File.Delete(path);
            var jpg = Path.ChangeExtension(path, ".jpg");
            if (File.Exists(jpg)) File.Delete(jpg);
            return ListPresets();
        }
    }
}
