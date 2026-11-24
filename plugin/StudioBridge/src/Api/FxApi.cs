using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using ExtensibleSaveFormat;
using KKAPI.Studio.SaveLoad;
using KKAPI.Utilities;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Keyframe Studio's own image effects on Studio's camera (shaders compiled with Unity 5.6.2f1, embedded as
    /// res/kfeffects.bundle): two-tone fog, colour grade, sharpening, vignette, chromatic aberration, film grain.
    /// They run after Studio's own effects, are saved with the scene, undoable, and every value can be a Timeline
    /// track ("Keyframe Studio" tracks, scene-wide).
    /// </summary>
    internal static class FxApi
    {
        // effect → value → default. Floats, bools ("on") and colours (float[4]).
        private static readonly Dictionary<string, Dictionary<string, object>> Defaults = new Dictionary<string, Dictionary<string, object>>
        {
            { "fog", new Dictionary<string, object> {
                { "on", false }, { "near", new[] { 0.91f, 0.62f, 0.45f, 0.6f } }, { "far", new[] { 0.25f, 0.4f, 0.65f, 0.75f } },
                { "density", 0.08f }, { "start", 0.5f }, { "split", 0.45f }, { "softness", 0.3f },
                { "height", 0f }, { "heightFalloff", 0f }, { "sky", true }, { "skyDistance", 60f } } },
            { "grade", new Dictionary<string, object> {
                { "on", false }, { "exposure", 0f }, { "contrast", 1f }, { "saturation", 1f }, { "vibrance", 0f },
                { "temperature", 0f }, { "tint", 0f }, { "brightness", 0f }, { "amount", 1f },
                { "filter", new[] { 1f, 1f, 1f, 1f } }, { "lift", new[] { 0f, 0f, 0f, 1f } }, { "gamma", new[] { 1f, 1f, 1f, 1f } }, { "gain", new[] { 1f, 1f, 1f, 1f } } } },
            { "sharpen", new Dictionary<string, object> { { "on", false }, { "amount", 0.5f } } },
            { "vignette", new Dictionary<string, object> { { "on", false }, { "intensity", 0.35f }, { "smoothness", 0.45f }, { "roundness", 1f }, { "color", new[] { 0f, 0f, 0f, 1f } } } },
            { "aberration", new Dictionary<string, object> { { "on", false }, { "amount", 0.3f } } },
            { "grain", new Dictionary<string, object> { { "on", false }, { "amount", 0.2f }, { "size", 1.5f } } },
            // focus: metres from the camera; blur: how quickly things leave focus; maxBlur: biggest blur, in screen heights;
            // autoFocus: 0 manual, 1 the view's centre (Studio's camera target), 2 a character's eyes (chara = its id)
            { "dof", new Dictionary<string, object> { { "on", false }, { "focus", 3f }, { "blur", 0.6f }, { "maxBlur", 0.018f }, { "near", true }, { "autoFocus", 1f }, { "chara", -1f } } },
        };

        private static Dictionary<string, Dictionary<string, object>> _fx = Clone(Defaults);
        private static string _bundleError;
        private static Material _fog, _grade, _sharpen, _lens, _dof;

        // values that are choices, not amounts: no Timeline tracks for them
        private static readonly HashSet<string> NotAnimated = new HashSet<string> { "dof.autoFocus", "dof.chara" };

        private static Dictionary<string, Dictionary<string, object>> Clone(Dictionary<string, Dictionary<string, object>> src) =>
            src.ToDictionary(kv => kv.Key, kv => CloneOne(kv.Value));

        private static Dictionary<string, object> CloneOne(Dictionary<string, object> src) =>
            src.ToDictionary(kv => kv.Key, kv => kv.Value is float[] a ? (object)(float[])a.Clone() : kv.Value);

        public static void Register(CommandRouter r)
        {
            r.Add("fx.get", a => State());
            r.Add("fx.set", Set);
            r.Add("fx.reset", a =>
            {
                string e = a.GetString("effect");
                var keys = e == null ? Defaults.Keys.ToList() : new List<string> { Known(e) };
                UndoStack.BeginGroup();
                try { foreach (var k in keys) Change(k, CloneOne(Defaults[k]), "reset|" + k); }
                finally { UndoStack.EndGroup(e == null ? "Reset effects" : "Reset " + e); }
                return State();
            });
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Effects won't be saved with scenes (KKAPI): " + e.Message); }
            if (TimelineApi.Available)
            {
                try { RegisterTracks(); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Effects can't be animated (Timeline): " + e.Message); }
            }
        }

        private static string Known(string e) => Defaults.ContainsKey(e ?? "") ? e : throw new BridgeException("Unknown effect: " + e);

        // ------------------------------------------------------------------ state

        private static Dictionary<string, object> State()
        {
            var d = new Dictionary<string, object>();
            foreach (var kv in _fx) d[kv.Key] = kv.Value.ToDictionary(x => x.Key, x => Wire(x.Value));
            return new Dictionary<string, object>
            {
                { "effects", d },
                { "ready", Ready() },
                { "error", _bundleError },
                { "camera", Camera.main != null },
                { "focusNow", (double)KfEffects.CurrentFocus },
            };
        }

        /// <summary>For looks: every effect's values (on/off included).</summary>
        public static Dictionary<string, object> Effects() => (Dictionary<string, object>)State()["effects"];

        /// <summary>
        /// For the built-in looks: every effect but depth of field (that belongs to the shot), off and at its
        /// defaults unless the look uses it; a used effect is on with the look's values over the defaults.
        /// </summary>
        public static Dictionary<string, object> LookEffects(Dictionary<string, Dictionary<string, object>> used)
        {
            var d = new Dictionary<string, object>();
            foreach (var kv in Defaults)
            {
                if (kv.Key == "dof") continue;
                var vals = kv.Value.ToDictionary(x => x.Key, x => Wire(x.Value));
                vals["on"] = false;
                if (used != null && used.TryGetValue(kv.Key, out var mine))
                {
                    foreach (var v in mine) vals[v.Key] = Wire(v.Value);
                    vals["on"] = true;
                }
                d[kv.Key] = vals;
            }
            return d;
        }

        /// <summary>For looks: blend towards saved effects (numbers and colours by strength; on/off from the look past halfway). Undoable.</summary>
        public static void ApplyEffects(Dictionary<string, object> all, float strength)
        {
            foreach (var e in all)
            {
                if (!Defaults.ContainsKey(e.Key) || !(e.Value is Dictionary<string, object> vals)) continue;
                var next = CloneOne(_fx[e.Key]);
                foreach (var v in vals)
                {
                    if (!Defaults[e.Key].TryGetValue(v.Key, out var def)) continue;
                    if (e.Key == "dof" && v.Key == "chara") continue; // an object id from another scene
                    var target = Parse(def, v.Value);
                    if (NotAnimated.Contains(e.Key + "." + v.Key)) { if (strength >= 0.5f) next[v.Key] = target; continue; }
                    if (target is float tf) next[v.Key] = Mathf.Lerp((float)next[v.Key], tf, strength);
                    else if (target is float[] tc) { var cur = (float[])next[v.Key]; next[v.Key] = Enumerable.Range(0, 4).Select(i => Mathf.Lerp(cur[i], tc[i], strength)).ToArray(); }
                    else if (strength >= 0.5f) next[v.Key] = target;
                }
                Change(e.Key, next, "look|" + e.Key);
            }
        }

        private static object Wire(object v) => v is float[] a ? a.Select(x => (object)(double)x).ToList() : v is float f ? (double)f : v;

        /// <summary>args: {effect, values: {name: value}} — only the given values change.</summary>
        private static object Set(Dictionary<string, object> a)
        {
            string e = Known(a.GetString("effect"));
            var vals = a.ContainsKey("values") ? a["values"] as Dictionary<string, object> : null;
            if (vals == null) throw new BridgeException("No values");
            var next = CloneOne(_fx[e]);
            foreach (var kv in vals)
            {
                if (!Defaults[e].TryGetValue(kv.Key, out var def)) throw new BridgeException($"Unknown {e} value: {kv.Key}");
                next[kv.Key] = Parse(def, kv.Value);
            }
            Change(e, next, e + "|" + string.Join(",", vals.Keys.OrderBy(k => k).ToArray()));
            return State();
        }

        private static object Parse(object def, object v)
        {
            if (def is bool) return Convert.ToBoolean(v);
            if (def is float) return Convert.ToSingle(v, CultureInfo.InvariantCulture);
            var l = v as List<object> ?? throw new BridgeException("Expected a colour [r, g, b, a]");
            var d = (float[])def;
            return Enumerable.Range(0, 4).Select(i => i < l.Count ? Convert.ToSingle(l[i], CultureInfo.InvariantCulture) : d[i]).ToArray();
        }

        private static void Change(string effect, Dictionary<string, object> next, string undoKey)
        {
            var prev = CloneOne(_fx[effect]);
            _fx[effect] = next;
            UndoStack.Push(new FxUndo(effect, prev, undoKey));
            Ensure();
        }

        private sealed class FxUndo : IUndoEntry
        {
            private readonly string _effect, _key;
            private readonly Dictionary<string, object> _values;
            public FxUndo(string effect, Dictionary<string, object> values, string key) { _effect = effect; _values = values; _key = key; }
            public string Label => "Effect: " + _effect;
            public bool Absorbs(IUndoEntry newer) => newer is FxUndo n && n._effect == _effect && n._key == _key;
            public IUndoEntry Restore()
            {
                var now = CloneOne(_fx[_effect]);
                _fx[_effect] = CloneOne(_values);
                Ensure();
                return new FxUndo(_effect, now, _key + "|undo");
            }
        }

        // ------------------------------------------------------------------ rendering

        private static bool Ready() => _fog != null || LoadShaders();

        private static readonly Dictionary<string, Shader> Shaders = new Dictionary<string, Shader>();

        /// <summary>One of our shaders from the embedded bundle (e.g. "Projector"), or an error saying why not.</summary>
        public static Shader GetShader(string name)
        {
            if (!Ready()) throw new BridgeException("Keyframe Studio's shaders didn't load: " + _bundleError);
            if (!Shaders.TryGetValue("Hidden/KeyframeStudio/" + name, out var sh) || !sh.isSupported) throw new BridgeException("Shader " + name + " isn't available");
            return sh;
        }

        private static bool LoadShaders()
        {
            if (_bundleError != null) return false;
            try
            {
                byte[] bytes;
                using (var s = typeof(FxApi).Assembly.GetManifestResourceStream("KKStudioEX.Bridge.kfeffects.bundle"))
                {
                    if (s == null) throw new Exception("the effect shaders aren't in this build");
                    bytes = new byte[s.Length];
                    s.Read(bytes, 0, bytes.Length);
                }
                var bundle = AssetBundle.LoadFromMemory(bytes) ?? throw new Exception("couldn't open the shader bundle");
                var shaders = bundle.LoadAllAssets<Shader>();
                bundle.Unload(false);
                foreach (var sh in shaders) Shaders[sh.name] = sh;
                Material M(string name)
                {
                    var sh = shaders.FirstOrDefault(x => x.name == "Hidden/KeyframeStudio/" + name);
                    if (sh == null || !sh.isSupported) throw new Exception("shader " + name + " isn't supported on this graphics card");
                    return new Material(sh) { hideFlags = HideFlags.HideAndDontSave };
                }
                _fog = M("Fog");
                _grade = M("Grade");
                _sharpen = M("Sharpen");
                _lens = M("Lens");
                _dof = M("Dof");
                return true;
            }
            catch (Exception e)
            {
                _bundleError = e.Message;
                StudioBridgePlugin.Logger.LogWarning("Keyframe Studio effects unavailable: " + e.Message);
                return false;
            }
        }

        private static bool AnyOn => _fx.Values.Any(v => (bool)v["on"]);

        private static Camera _addedDepth; // the camera we switched the depth texture on for

        /// <summary>Our component on Studio's camera while any effect is on (and only then).</summary>
        public static void Ensure()
        {
            var cam = Camera.main;
            if (cam == null) return;
            var comp = cam.GetComponent<KfEffects>();
            if (AnyOn && Ready())
            {
                if (comp == null) comp = cam.gameObject.AddComponent<KfEffects>();
                comp.enabled = true;
            }
            else if (comp != null) comp.enabled = false;
            bool wantDepth = AnyOn && ((bool)_fx["fog"]["on"] || (bool)_fx["dof"]["on"]);
            if (wantDepth && (cam.depthTextureMode & DepthTextureMode.Depth) == 0) { cam.depthTextureMode |= DepthTextureMode.Depth; _addedDepth = cam; }
            else if (!wantDepth && _addedDepth == cam) { cam.depthTextureMode &= ~DepthTextureMode.Depth; _addedDepth = null; }
        }

        /// <summary>New scene (and before a load): effects off, starting values.</summary>
        public static void Clear()
        {
            _fx = Clone(Defaults);
            Ensure();
            StudioBridgePlugin.Instance?.Broadcast("fx.changed", State());
        }

        private static float _nextCheck;
        /// <summary>From the plugin's Update: follow camera changes (scene loads) cheaply.</summary>
        public static void Tick()
        {
            if (Time.unscaledTime < _nextCheck) return;
            _nextCheck = Time.unscaledTime + 1f;
            if (AnyOn) Ensure();
        }

        private static float F(string e, string k) => (float)_fx[e][k];

        // for the viewport's focus marker
        internal static bool DofOn => B("dof", "on");
        internal static float Dof(string k) => F("dof", k);
        internal static void SetDof(Dictionary<string, object> values) => Set(new Dictionary<string, object> { { "effect", "dof" }, { "values", values } });
        private static bool B(string e, string k) => (bool)_fx[e][k];
        private static Vector4 V(string e, string k) { var a = (float[])_fx[e][k]; return new Vector4(a[0], a[1], a[2], a[3]); }

        internal sealed class KfEffects : MonoBehaviour
        {
            private Camera _cam;
            private void Awake() => _cam = GetComponent<Camera>();

            private Transform _eyes;
            private int _eyesOf = -2;

            /// <summary>Where auto focus points: the view's centre or the character's eyes; null for manual.</summary>
            private Vector3? FocusPoint()
            {
                int mode = Mathf.RoundToInt(F("dof", "autoFocus"));
                if (mode == 1) return Singleton<Studio.Studio>.Instance?.cameraCtrl?.targetPos;
                if (mode != 2) return null;
                int id = Mathf.RoundToInt(F("dof", "chara"));
                if (id != _eyesOf || _eyes == null)
                {
                    _eyesOf = id;
                    // no character chosen (or it's gone): the first one in the scene
                    var c = SceneApi.FindOci(id) as OCIChar
                        ?? Singleton<Studio.Studio>.Instance?.dicObjectCtrl.OrderBy(kv => kv.Key).Select(kv => kv.Value as OCIChar).FirstOrDefault(x => x != null);
                    _eyes = c?.charInfo != null ? c.charInfo.GetComponentsInChildren<Transform>(true).FirstOrDefault(t => t.name == "cf_J_Eye_tz") ?? c.charInfo.objHeadBone?.transform : null;
                }
                return _eyes != null ? _eyes.position : (Vector3?)null;
            }

            /// <summary>The distance auto focus is using right now (for the app and tests).</summary>
            public static float CurrentFocus = -1;

            private void Dof(RenderTexture src, RenderTexture dst)
            {
                var fp = FocusPoint();
                float focus = fp.HasValue ? Mathf.Max(0.05f, Vector3.Dot(fp.Value - _cam.transform.position, _cam.transform.forward)) : F("dof", "focus");
                CurrentFocus = focus;
                if (fp.HasValue) _fx["dof"]["focus"] = focus; // shows (and keys) where it's focusing
                _dof.SetVector("_KfDof", new Vector4(focus, F("dof", "blur") * 4f, F("dof", "maxBlur"), B("dof", "near") ? 1 : 0));
                int w = src.width / 2, h = src.height / 2;
                var half = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGBHalf);
                var bokeh = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGBHalf);
                half.filterMode = bokeh.filterMode = FilterMode.Bilinear;
                Graphics.Blit(src, half, _dof, 0);
                Graphics.Blit(half, bokeh, _dof, 1);
                Graphics.Blit(bokeh, half, _dof, 2);
                _dof.SetTexture("_KfDofTex", half);
                Graphics.Blit(src, dst, _dof, 3);
                RenderTexture.ReleaseTemporary(half);
                RenderTexture.ReleaseTemporary(bokeh);
            }

            /// <summary>Render pixels per window pixel: above 1 for supersampled stills, so per-pixel effects keep their look.</summary>
            private static float PixelScale(RenderTexture src) => Mathf.Max(1f, (float)src.height / Mathf.Max(1, Screen.height));

            private void OnRenderImage(RenderTexture src, RenderTexture dst)
            {
                if (!Ready()) { Graphics.Blit(src, dst); return; }
                var passes = new List<object>(5); // a Material (one pass) or an Action for multi-pass effects
                try
                {
                    if (B("fog", "on"))
                    {
                        _fog.SetMatrix("_KfInvProj", _cam.projectionMatrix.inverse);
                        _fog.SetMatrix("_KfCamToWorld", _cam.cameraToWorldMatrix);
                        _fog.SetVector("_KfColorNear", V("fog", "near"));
                        _fog.SetVector("_KfColorFar", V("fog", "far"));
                        _fog.SetVector("_KfFog", new Vector4(F("fog", "density"), F("fog", "start"), F("fog", "split"), F("fog", "softness")));
                        _fog.SetVector("_KfHeight", new Vector4(F("fog", "height"), F("fog", "heightFalloff"), B("fog", "sky") ? 1 : 0, F("fog", "skyDistance")));
                        passes.Add(_fog);
                    }
                    if (B("dof", "on")) passes.Add((Action<RenderTexture, RenderTexture>)Dof);
                    if (B("sharpen", "on"))
                    {
                        _sharpen.SetFloat("_KfSharpness", F("sharpen", "amount"));
                        _sharpen.SetFloat("_KfPixelScale", PixelScale(src));
                        passes.Add(_sharpen);
                    }
                    if (B("grade", "on"))
                    {
                        _grade.SetVector("_KfGrade", new Vector4(F("grade", "exposure"), F("grade", "contrast"), F("grade", "saturation"), F("grade", "vibrance")));
                        _grade.SetVector("_KfBalance", new Vector4(F("grade", "temperature"), F("grade", "tint"), F("grade", "brightness"), F("grade", "amount")));
                        _grade.SetVector("_KfFilter", V("grade", "filter"));
                        _grade.SetVector("_KfLift", V("grade", "lift"));
                        _grade.SetVector("_KfGamma", V("grade", "gamma"));
                        _grade.SetVector("_KfGain", V("grade", "gain"));
                        passes.Add(_grade);
                    }
                    bool vig = B("vignette", "on"), ca = B("aberration", "on"), grain = B("grain", "on");
                    if (vig || ca || grain)
                    {
                        _lens.SetVector("_KfLens", new Vector4(ca ? F("aberration", "amount") : 0, vig ? F("vignette", "intensity") : 0, F("vignette", "smoothness"), F("vignette", "roundness")));
                        _lens.SetVector("_KfVigColor", V("vignette", "color"));
                        _lens.SetVector("_KfGrain", new Vector4(grain ? F("grain", "amount") : 0, F("grain", "size"), Time.frameCount % 997, PixelScale(src)));
                        passes.Add(_lens);
                    }
                }
                catch (Exception e)
                {
                    StudioBridgePlugin.Logger.LogDebug("fx: " + e.Message);
                }
                if (passes.Count == 0) { Graphics.Blit(src, dst); return; }

                var cur = src;
                for (int i = 0; i < passes.Count; i++)
                {
                    bool last = i == passes.Count - 1;
                    var target = last ? dst : RenderTexture.GetTemporary(src.width, src.height, 0, src.format);
                    if (passes[i] is Material m) Graphics.Blit(cur, target, m);
                    else ((Action<RenderTexture, RenderTexture>)passes[i])(cur, target);
                    if (cur != src) RenderTexture.ReleaseTemporary(cur);
                    cur = target;
                }
            }
        }

        // ------------------------------------------------------------------ saved with the scene

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<FxSceneData>(StudioBridgePlugin.GUID + ".fx");

        private sealed class FxSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                if (!AnyOn) { SetExtendedData(null); return; }
                SetExtendedData(new PluginData { version = 1, data = new Dictionary<string, object> { { "fx", Json.Serialize(State()["effects"]) } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation == SceneOperationKind.Import) return; // importing adds objects, it doesn't take over the look
                var d = GetExtendedData();
                _fx = Clone(Defaults);
                if (d?.data != null && d.data.TryGetValue("fx", out var raw) && raw is string json)
                {
                    try
                    {
                        if (Json.Parse(json) is Dictionary<string, object> all)
                            foreach (var e in all)
                                if (Defaults.ContainsKey(e.Key) && e.Value is Dictionary<string, object> vals)
                                    foreach (var v in vals)
                                        if (Defaults[e.Key].TryGetValue(v.Key, out var def)) _fx[e.Key][v.Key] = Parse(def, v.Value);
                    }
                    catch (Exception ex) { StudioBridgePlugin.Logger.LogWarning("Couldn't read the scene's effects: " + ex.Message); }
                }
                Ensure();
                StudioBridgePlugin.Instance?.Broadcast("fx.changed", State());
            }
        }

        // ------------------------------------------------------------------ Timeline tracks

        public static readonly string Owner = "Keyframe Studio";

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterTracks()
        {
            foreach (var e in Defaults)
                foreach (var v in e.Value)
                {
                    if (v.Value is bool || NotAnimated.Contains(e.Key + "." + v.Key)) continue;
                    string effect = e.Key, name = v.Key;
                    if (v.Value is float) TimelineImpl.AddSceneFloatModel(Owner, "fx." + effect + "." + name, Title(effect, name), () => F(effect, name), x => { _fx[effect][name] = x; Ensure(); });
                    else TimelineImpl.AddSceneColorModel(Owner, "fx." + effect + "." + name, Title(effect, name), () => V(effect, name), c => { _fx[effect][name] = new[] { c.x, c.y, c.z, c.w }; Ensure(); });
                }
        }

        private static string Title(string effect, string value)
        {
            string E(string s) => char.ToUpperInvariant(s[0]) + s.Substring(1);
            return "Effects · " + E(effect) + " " + System.Text.RegularExpressions.Regex.Replace(value, "([a-z])([A-Z])", "$1 $2").ToLowerInvariant();
        }
    }
}
