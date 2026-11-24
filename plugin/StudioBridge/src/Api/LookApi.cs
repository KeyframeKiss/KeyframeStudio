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
        public static readonly string[] Groups = { "effects", "toon", "lights", "materials", "fx", "projectors", "xukmi" };

        private static string Folder => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/looks"));

        public static void Register(CommandRouter r)
        {
            r.Add("look.get", a => Get());
            r.Add("look.set", a =>
            {
                string keys = string.Join(",", a.Keys.SelectMany(g => a.GetObject(g)?.Keys.Select(k => g + "." + k) ?? new[] { g }).OrderBy(k => k).ToArray());
                if (!a.GetBool("noUndo")) UndoStack.Push(new LookUndo(Snapshot(), keys));
                a.Remove("noUndo");
                Apply(a, 1f);
                return Get();
            });
            r.Add("look.presets", a => ListPresets());
            r.Add("look.savePreset", SavePreset);
            r.Add("look.applyPreset", ApplyPreset);
            r.Add("look.deletePreset", DeletePreset);
            // Thumbnail of the current view for a look that has none (the built-in starters), taken right
            // after it's applied. Only writes the .jpg next to an existing look; never touches its settings.
            r.Add("look.thumb", a =>
            {
                string path = Path.Combine(Folder, SafeFile(a.GetString("file") ?? "") + ".json");
                if (!File.Exists(path)) throw new BridgeException("Look not found");
                var thumb = CameraApi.Snapshot(240);
                if (thumb == null) throw new BridgeException("Couldn't capture the view");
                File.WriteAllBytes(Path.ChangeExtension(path, ".jpg"), Convert.FromBase64String(thumb.Substring(thumb.IndexOf(',') + 1)));
                return ListPresets();
            });
            // a look's picture off again (it shows its colours), or every look's with all: true
            r.Add("look.clearThumb", a =>
            {
                var files = a.GetBool("all")
                    ? Directory.GetFiles(Folder, "*.jpg")
                    : new[] { Path.Combine(Folder, SafeFile(a.GetString("file") ?? "") + ".jpg") };
                foreach (var f in files) if (File.Exists(f)) File.Delete(f);
                return ListPresets();
            });
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
                        { "mapColor", C(Color.white) }, { "mapIntensity", 1d },
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
                Apply(Only(_state, _keys), 1f);
                return inverse;
            }

            /// <summary>
            /// Just the settings this edit changed ("effects.bloomIntensity,toon.lineWidth"): a fog colour picked in
            /// Studio's own window since then stays. Presets and resets change everything, so they restore all.
            /// </summary>
            private static Dictionary<string, object> Only(Dictionary<string, object> state, string keys)
            {
                if (keys == "reset" || keys.StartsWith("preset")) return state;
                var outd = new Dictionary<string, object>();
                foreach (var k in keys.Split(','))
                {
                    int dot = k.IndexOf('.');
                    if (dot < 0) { if (state.ContainsKey(k)) outd[k] = state[k]; continue; }
                    string g = k.Substring(0, dot), f = k.Substring(dot + 1);
                    if (!(state.GetObject(g) is Dictionary<string, object> grp) || !grp.ContainsKey(f)) return state;
                    if (!(outd.GetObject(g) is Dictionary<string, object> o)) outd[g] = o = new Dictionary<string, object>();
                    o[f] = grp[f];
                }
                return outd;
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

        // ---- built-in looks ----
        // Each is a whole look: Studio's settings from its defaults plus the look's own, and Keyframe Studio's
        // effects (all but depth of field, which belongs to the shot) off unless the look uses them, so one look
        // applied after another doesn't stack. New built-ins reach existing installs; one the user deleted stays
        // deleted (".starters" lists the ones this install has had), and one they saved over (no "builtin") is theirs.
        private const int StarterVersion = 4;
        private static readonly string[] FirstStarters = { "Studio Default", "Soft Pastel", "Cinematic Warm", "Moonlight", "Punchy Anime", "Dreamy Glow" };
        private static bool _startersChecked;

        private static void EnsureStarterPresets()
        {
            bool fresh = !Directory.Exists(Folder);
            if (_startersChecked && !fresh) return;
            _startersChecked = true;
            Directory.CreateDirectory(Folder);
            string marker = Path.Combine(Folder, ".starters");
            var had = new HashSet<string>();
            if (File.Exists(marker))
            {
                foreach (var line in File.ReadAllLines(marker, Encoding.UTF8))
                    if (line.Trim().Length > 0) had.Add(line.Trim());
            }
            else if (!fresh) had.UnionWith(FirstStarters); // made before the list existed: these six were written then
            foreach (var look in Starters())
            {
                string name = (string)look["name"];
                string file = Path.Combine(Folder, SafeFile(name) + ".json");
                if (had.Contains(name))
                {
                    if (!File.Exists(file)) continue; // deleted by the user
                    try
                    {
                        var old = Json.Parse(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
                        if (old == null || !old.GetBool("builtin") || old.GetInt("starter") >= StarterVersion) continue;
                    }
                    catch { continue; }
                    // an untouched built-in from an older version: the new settings, and a new picture when next used
                    if (File.Exists(Path.ChangeExtension(file, ".jpg"))) File.Delete(Path.ChangeExtension(file, ".jpg"));
                }
                else if (File.Exists(file)) { had.Add(name); continue; }
                File.WriteAllText(file, Json.Serialize(look), new UTF8Encoding(false));
                had.Add(name);
            }
            try { File.WriteAllLines(marker, had.OrderBy(x => x).ToArray(), new UTF8Encoding(false)); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Couldn't note the built-in looks: " + e.Message); }
        }

        private static Dictionary<string, object> D(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1] is int n ? (object)(double)n : kv[i + 1];
            return d;
        }

        private static Dictionary<string, object> Merge(Dictionary<string, object> baseline, Dictionary<string, object> look)
        {
            var d = new Dictionary<string, object>(baseline);
            if (look != null) foreach (var kv in look) d[kv.Key] = kv.Value;
            return d;
        }

        private static List<Dictionary<string, object>> Starters()
        {
            Color c(int r, int g, int b) => new Color(r / 255f, g / 255f, b / 255f, 1f);
            List<object> col(int r, int g, int b) => C(c(r, g, b));
            List<object> rot(double x, double y) => new List<object> { x, y };
            float[] f(float r, float g, float b, float a = 1f) => new[] { r, g, b, a };
            var def = Defaults();
            Dictionary<string, object> L(string name, string note, string swatch, Dictionary<string, object> effects, Dictionary<string, object> toon, Dictionary<string, object> lights, Dictionary<string, Dictionary<string, object>> fx) =>
                new Dictionary<string, object>
                {
                    { "version", 1 }, { "name", name }, { "note", note }, { "builtin", true }, { "starter", StarterVersion },
                    { "swatch", swatch.Split(' ').Cast<object>().ToList() },
                    { "effects", Merge(def.GetObject("effects"), effects) },
                    { "toon", Merge(def.GetObject("toon"), toon) },
                    { "lights", Merge(def.GetObject("lights"), lights) },
                    { "fx", FxApi.LookEffects(fx) },
                };
            var none = new Dictionary<string, Dictionary<string, object>>();
            Dictionary<string, Dictionary<string, object>> Fx(params object[] kv)
            {
                var d = new Dictionary<string, Dictionary<string, object>>();
                for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = (Dictionary<string, object>)kv[i + 1];
                return d;
            }

            return new List<Dictionary<string, object>>
            {
                // ---- the first six (now whole looks) ----
                L("Studio Default", "Studio's out-of-the-box look", "#f3efe9 #c9cbd3 #8a8f9c", null, null, null, none),
                L("Soft Pastel", "Low contrast, gentle glow, light outlines", "#fff1f6 #e6cfe6 #b9a0c4",
                    D("bloom", true, "bloomIntensity", 0.9, "bloomThreshold", 0.55, "bloomBlur", 2.2, "ssaoRadius", 0.06, "ssaoColor", col(205, 190, 210), "vignette", false),
                    D("lineColor", 0.25, "lineWidth", 0.35, "ambientShadow", col(196, 170, 196), "ambientShadowG", 0.35),
                    D("charaColor", col(255, 244, 248), "charaIntensity", 1.05),
                    Fx("grade", D("contrast", 0.92, "saturation", 0.95, "lift", f(0.03f, 0.02f, 0.03f)))),
                L("Cinematic Warm", "Golden key light, shallow depth of field, strong vignette", "#ffd6aa #c98a62 #3a2a24",
                    D("bloomIntensity", 0.7, "bloomThreshold", 0.65, "bloomBlur", 1.4, "dof", true, "dofFocal", 0.6, "dofAperture", 0.75, "ssaoRadius", 0.12, "ssaoColor", col(150, 110, 90)),
                    D("ambientShadow", col(170, 120, 105), "ambientShadowG", 0.6, "lineColor", 0.55),
                    D("charaColor", col(255, 214, 170), "charaIntensity", 1.15, "charaRot", rot(25, -35)),
                    Fx("grade", D("contrast", 1.08, "temperature", 0.15, "saturation", 1.05))),
                L("Moonlight", "Cool blue night, soft fog", "#aac3ff #4a5a8c #141a30",
                    D("bloomIntensity", 0.6, "bloomThreshold", 0.7, "fog", true, "fogColor", col(70, 90, 140), "fogHeight", 3, "fogStart", 2, "ssaoColor", col(60, 70, 110)),
                    D("ambientShadow", col(95, 110, 170), "ambientShadowG", 0.7),
                    D("charaColor", col(170, 195, 255), "charaIntensity", 0.8, "charaRot", rot(40, 30), "mapColor", col(120, 140, 210), "mapIntensity", 0.7),
                    Fx("grade", D("exposure", -0.25, "temperature", -0.3, "saturation", 0.85))),
                L("Punchy Anime", "Crisp outlines, strong shadows, no blur", "#ffffff #5aa9ff #1b1d26",
                    D("bloomIntensity", 0.3, "bloomThreshold", 0.8, "vignette", false, "ssaoRadius", 0.15),
                    D("lineColor", 0.9, "lineWidth", 0.7, "ambientShadowG", 0.75, "faceShadow", true),
                    D("charaIntensity", 1.2),
                    Fx("grade", D("contrast", 1.1, "vibrance", 0.25), "sharpen", D("amount", 0.4))),
                L("Dreamy Glow", "Heavy bloom, sun shafts, pink haze", "#fff0f6 #ffcde1 #d4a3d0",
                    D("bloomIntensity", 1.6, "bloomThreshold", 0.5, "bloomBlur", 3.5, "sunShafts", true, "sunColor", col(255, 220, 235), "fog", true, "fogColor", col(255, 205, 225), "fogHeight", 2, "fogStart", 4),
                    D("lineColor", 0.3, "ambientShadow", col(220, 170, 200)),
                    D("charaColor", col(255, 236, 244)),
                    none),

                // ---- times of day and weather ----
                L("Golden Hour", "Low warm sun from the side, long glow", "#ffe2a8 #ff9a4d #6b3a2a",
                    D("bloomIntensity", 0.8, "bloomThreshold", 0.6, "bloomBlur", 1.8, "sunShafts", true, "sunColor", col(255, 200, 140), "ssaoColor", col(150, 110, 80)),
                    D("ambientShadow", col(175, 125, 100), "ambientShadowG", 0.55),
                    D("charaColor", col(255, 215, 170), "charaIntensity", 1.05, "charaRot", rot(15, -60), "mapColor", col(255, 220, 180)),
                    Fx("grade", D("exposure", -0.1, "temperature", 0.22, "contrast", 1.1, "saturation", 1.05, "vibrance", 0.15, "gain", f(1.03f, 0.98f, 0.92f)))),
                L("Overcast", "Soft, even light and muted colour", "#e6eaf0 #b4bac4 #6f7684",
                    D("bloomIntensity", 0.25, "bloomThreshold", 0.8, "ssaoRadius", 0.08, "ssaoColor", col(160, 165, 175), "vignette", false),
                    D("ambientShadow", col(150, 155, 165), "ambientShadowG", 0.35, "lineColor", 0.4),
                    D("charaColor", col(225, 232, 240), "charaIntensity", 0.95, "charaRot", rot(50, 0)),
                    Fx("grade", D("contrast", 0.92, "saturation", 0.85, "temperature", -0.12, "lift", f(0.03f, 0.03f, 0.04f)))),
                L("Bright Summer", "High sun, vivid colour, crisp edges", "#fffbe8 #5fd0ff #2a7bd8",
                    D("bloomIntensity", 0.5, "bloomThreshold", 0.7, "ssaoRadius", 0.12, "vignette", false),
                    D("lineColor", 0.7, "ambientShadow", col(120, 140, 175), "ambientShadowG", 0.5),
                    D("charaColor", col(255, 250, 240), "charaIntensity", 1.1, "charaRot", rot(55, 20), "mapColor", col(255, 252, 240)),
                    Fx("grade", D("contrast", 1.15, "saturation", 1.2, "vibrance", 0.3, "temperature", 0.05), "sharpen", D("amount", 0.35))),
                L("Rainy Day", "Cool, grey and quiet, with a light mist", "#c9d2de #8c99ad #3f4a5c",
                    D("bloomIntensity", 0.3, "bloomThreshold", 0.8),
                    D("ambientShadow", col(130, 140, 160), "ambientShadowG", 0.45),
                    D("charaColor", col(205, 215, 235), "charaIntensity", 0.85, "charaRot", rot(60, -10), "mapColor", col(200, 210, 230), "mapIntensity", 0.8),
                    Fx("grade", D("exposure", -0.25, "saturation", 0.65, "contrast", 0.95, "temperature", -0.3, "lift", f(0.02f, 0.03f, 0.05f)),
                       "fog", D("near", f(0.7f, 0.75f, 0.8f, 0.35f), "far", f(0.55f, 0.6f, 0.68f, 0.6f), "density", 0.06, "start", 1.5, "split", 0.5))),

                // ---- mood lighting ----
                L("Sunset Romance", "Pink and orange light, soft haze", "#ffc6a8 #ff8fa8 #6a4a8c",
                    D("bloomIntensity", 1.0, "bloomThreshold", 0.55, "bloomBlur", 2.5, "ssaoColor", col(170, 110, 120)),
                    D("ambientShadow", col(190, 120, 150), "ambientShadowG", 0.5, "lineColor", 0.35),
                    D("charaColor", col(255, 205, 190), "charaIntensity", 1.0, "charaRot", rot(10, 70), "mapColor", col(255, 190, 200)),
                    Fx("grade", D("exposure", -0.1, "temperature", 0.18, "tint", 0.14, "saturation", 1.05, "contrast", 1.0, "lift", f(0.03f, 0.01f, 0.03f)),
                       "fog", D("near", f(1f, 0.6f, 0.55f, 0.35f), "far", f(0.55f, 0.35f, 0.6f, 0.55f), "density", 0.05, "start", 2))),
                L("Candlelight", "Dim, deep orange light, dark corners", "#ffc078 #c2561e #2a120a",
                    D("bloomIntensity", 0.9, "bloomThreshold", 0.6),
                    D("ambientShadow", col(120, 70, 50), "ambientShadowG", 0.8),
                    D("charaColor", col(255, 185, 120), "charaIntensity", 0.85, "charaRot", rot(5, 40), "mapColor", col(255, 160, 90), "mapIntensity", 0.6),
                    Fx("grade", D("exposure", -0.35, "temperature", 0.4, "contrast", 1.1, "saturation", 0.95), "vignette", D("intensity", 0.45, "smoothness", 0.5))),
                L("Neon Night", "Magenta and cyan, glowing lights", "#ff4fd8 #3b1f6e #22d3ff",
                    D("bloomIntensity", 1.4, "bloomThreshold", 0.55, "bloomBlur", 2.5, "ssaoColor", col(60, 40, 90)),
                    D("ambientShadow", col(90, 70, 160), "ambientShadowG", 0.75),
                    D("charaColor", col(255, 165, 230), "charaIntensity", 0.95, "charaRot", rot(20, -70), "mapColor", col(80, 190, 255), "mapIntensity", 0.8),
                    Fx("grade", D("exposure", -0.35, "contrast", 1.15, "saturation", 1.1, "temperature", -0.2, "tint", 0.12, "lift", f(0.02f, 0f, 0.05f)), "aberration", D("amount", 0.25))),

                // ---- film and camera styles ----
                L("Film Vintage", "Faded warm film with grain", "#f1e2c6 #b89b7a #5b4a3e",
                    D("bloomIntensity", 0.5),
                    D("ambientShadow", col(160, 135, 115), "ambientShadowG", 0.5),
                    D("charaColor", col(255, 236, 210)),
                    Fx("grade", D("contrast", 0.9, "saturation", 0.8, "temperature", 0.2, "lift", f(0.07f, 0.06f, 0.05f), "gain", f(0.97f, 0.95f, 0.9f)),
                       "grain", D("amount", 0.25, "size", 1.6), "vignette", D("intensity", 0.3))),
                L("Noir", "Black and white, hard shadows, grain", "#f0f0f0 #7a7a7a #101010",
                    D("bloomIntensity", 0.3, "bloomThreshold", 0.75),
                    D("ramp", 1, "lineColor", 1.0, "ambientShadow", col(90, 90, 90), "ambientShadowG", 0.85),
                    D("charaIntensity", 1.25, "charaRot", rot(30, -55)),
                    Fx("grade", D("saturation", 0.0, "contrast", 1.45, "exposure", -0.4), "grain", D("amount", 0.3, "size", 1.4), "vignette", D("intensity", 0.5))),
                L("Retro VHS", "Washed colour, colour fringes, grain", "#ff7ac6 #7a5cff #2ae0d0",
                    D("bloomIntensity", 0.8, "bloomThreshold", 0.6, "bloomBlur", 2),
                    null,
                    null,
                    Fx("grade", D("saturation", 1.15, "contrast", 0.85, "tint", 0.15, "temperature", -0.05, "lift", f(0.05f, 0.02f, 0.07f)),
                       "aberration", D("amount", 0.55), "grain", D("amount", 0.35, "size", 2.2))),

                // ---- special ----
                L("Eerie", "Sickly green, dark fog, heavy shadows", "#9ad1a8 #3f6b55 #0e1a14",
                    D("bloomIntensity", 0.3, "ssaoRadius", 0.15, "ssaoColor", col(40, 60, 50)),
                    D("ambientShadow", col(70, 95, 85), "ambientShadowG", 0.85),
                    D("charaColor", col(190, 230, 200), "charaIntensity", 0.75, "charaRot", rot(-20, 0)),
                    Fx("grade", D("exposure", -0.3, "saturation", 0.6, "tint", -0.3, "temperature", -0.15, "contrast", 1.15),
                       "fog", D("near", f(0.2f, 0.28f, 0.24f, 0.5f), "far", f(0.08f, 0.12f, 0.1f, 0.85f), "density", 0.12, "start", 1))),
                L("Underwater", "Teal light and a deep blue haze", "#9ee8ff #1f8fb0 #08243d",
                    D("bloomIntensity", 0.7, "bloomThreshold", 0.6, "sunShafts", true, "sunColor", col(170, 230, 255)),
                    D("ambientShadow", col(70, 120, 150), "ambientShadowG", 0.6),
                    D("charaColor", col(130, 200, 235), "charaIntensity", 0.85, "charaRot", rot(70, 0), "mapColor", col(90, 180, 220), "mapIntensity", 0.8),
                    Fx("grade", D("exposure", -0.35, "temperature", -0.6, "tint", -0.1, "saturation", 0.95, "contrast", 1.0, "lift", f(0f, 0.04f, 0.1f), "gain", f(0.62f, 0.9f, 1f)),
                       "fog", D("near", f(0.25f, 0.6f, 0.65f, 0.4f), "far", f(0.05f, 0.2f, 0.35f, 0.9f), "density", 0.15, "start", 0.5), "aberration", D("amount", 0.15))),
                L("Cel Shaded", "Flat colour, bold outlines, sharp shadow edges", "#ffffff #ffb3c7 #2b2b38",
                    D("bloom", false, "ssao", false, "vignette", false),
                    D("ramp", 1, "lineColor", 1.0, "lineWidth", 0.8, "ambientShadowG", 0.6),
                    D("charaIntensity", 1.15),
                    Fx("grade", D("saturation", 1.2, "contrast", 1.12), "sharpen", D("amount", 0.6))),
            };
        }

        /// <summary>Colours for a look without a picture: its light, its shadow tint, and its fog or a darker shadow.</summary>
        private static List<object> Swatch(Dictionary<string, object> look)
        {
            string Hex(List<object> c) => c.Count >= 3
                ? "#" + string.Concat(c.Take(3).Select(v => ((int)Mathf.Clamp(Convert.ToSingle(v) * 255f, 0, 255)).ToString("x2")).ToArray())
                : null;
            var lights = look.GetObject("lights");
            var toon = look.GetObject("toon");
            var eff = look.GetObject("effects");
            string a = lights != null ? Hex(lights.GetList("charaColor")) : null;
            string b = toon != null ? Hex(toon.GetList("ambientShadow")) : null;
            string c = eff != null && eff.GetBool("fog") ? Hex(eff.GetList("fogColor")) : null;
            var list = new[] { a ?? "#e8e4de", b ?? "#8a8f9c", c ?? "#23252c" };
            return list.Cast<object>().ToList();
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
                    item["swatch"] = d.GetList("swatch").Count >= 2 ? d.GetList("swatch") : Swatch(d);
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
                if (g == "fx") { d["fx"] = FxApi.Effects(); continue; }
                if (g == "projectors") { var p = LightsApi.CaptureProjectors(Anchor(null)); if (p.Count > 0) d["projectors"] = p; continue; }
                if (g == "xukmi") { var x = XukmiFx.CaptureItems(); if (x.Count > 0) d["xukmi"] = x; continue; }
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
            // everything the look touches is one undo step
            UndoStack.BeginGroup();
            try { ApplyFiltered(filtered, strength, a); }
            finally { UndoStack.EndGroup("Apply look"); }
            return Get();
        }

        /// <summary>The character looks are placed around: the first one asked for, else the first in the scene.</summary>
        private static Transform Anchor(List<object> ids)
        {
            var s = Singleton<Studio.Studio>.Instance;
            var c = (ids ?? new List<object>()).Select(i => SceneApi.FindOci(Convert.ToInt32(i)) as OCIChar).FirstOrDefault(x => x != null)
                ?? s.dicObjectCtrl.OrderBy(kv => kv.Key).Select(kv => kv.Value as OCIChar).FirstOrDefault(x => x != null);
            return c?.charInfo != null ? c.charInfo.transform : null;
        }

        private static void ApplyFiltered(Dictionary<string, object> filtered, float strength, Dictionary<string, object> a)
        {
            if (filtered.GetObject("fx") is Dictionary<string, object> fx) FxApi.ApplyEffects(fx, strength);
            if (filtered.ContainsKey("projectors") && filtered["projectors"] is List<object> pl && strength >= 0.5f) LightsApi.AddProjectors(pl, Anchor(a.GetList("ids")));
            if (filtered.ContainsKey("xukmi") && filtered["xukmi"] is List<object> xl) XukmiFx.ApplyItems(xl, strength);
            filtered.Remove("fx");
            filtered.Remove("projectors");
            filtered.Remove("xukmi");
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
