using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;
using ObjectType = KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType;
using RendererProperties = MaterialEditorAPI.MaterialAPI.RendererProperties;
using ShaderPropertyType = MaterialEditorAPI.MaterialAPI.ShaderPropertyType;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Material Editor: one character's or item's parts → renderers → materials, and every edit MaterialEditor
    /// itself can make — shader values and colours, keywords, textures (import / export / tiling / offset), shader
    /// and render queue, renderer switches, copy / paste of a material's edits — all through KK_MaterialEditor,
    /// so they're saved with the scene/card exactly like edits made in its own window. Value edits are undoable;
    /// any edited value can become a Timeline track (MaterialEditor's own track types).
    /// Safe to call when MaterialEditor isn't installed (the commands say so).
    /// </summary>
    internal static class MaterialEditorApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("me.tree", a => { Require(); return Tree(a); });
            r.Add("me.material", a => { Require(); return Material(a); });
            r.Add("me.set", a => { Require(); return Set(a); });
            r.Add("me.reset", a => { Require(); return Reset(a); });
            r.Add("me.texture", a => { Require(); return Texture(a); });
            r.Add("me.textureExport", a => { Require(); return Export(a); });
            r.Add("me.shaders", a => { Require(); return Shaders(); });
            r.Add("me.copy", a => { Require(); return Copy(a); });
            r.Add("me.paste", a => { Require(); return Paste(a); });
            r.Add("me.animate", a => { Require(); return Animate(a); });
        }

        private static void Require()
        {
            if (!MaterialLookApi.Available) throw new BridgeException("KK_MaterialEditor is not installed");
        }

        [MethodImpl(MethodImplOptions.NoInlining)] private static object Tree(Dictionary<string, object> a) => MeImpl.Tree(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Material(Dictionary<string, object> a) => MeImpl.Material(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Set(Dictionary<string, object> a) => MeImpl.Set(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Reset(Dictionary<string, object> a) => MeImpl.Reset(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Texture(Dictionary<string, object> a) => MeImpl.Texture(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Export(Dictionary<string, object> a) => MeImpl.Export(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Shaders() => MeImpl.Shaders();
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Copy(Dictionary<string, object> a) => MeImpl.Copy(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Paste(Dictionary<string, object> a) => MeImpl.Paste(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object Animate(Dictionary<string, object> a) => MeImpl.Animate(a);
    }

    internal static class MeImpl
    {
        private static readonly string[] ClothesNames = { "Top", "Bottom", "Bra", "Underwear", "Gloves", "Pantyhose", "Socks", "Shoes (indoor)", "Shoes (outdoor)" };
        private static readonly string[] HairNames = { "Back hair", "Front hair", "Side hair", "Extension" };

        /// <summary>One editable piece: the whole character body (Character), a clothing / hair / accessory slot, or an item.</summary>
        private sealed class Part
        {
            public string Key;      // "Character:0", "Clothing:3", "Hair:1", "Accessory:5", "Item:0"
            public string Label;
            public ObjectType Type;
            public int Slot;
            public GameObject Go;
            public KK_Plugins.MaterialEditor.MaterialEditorCharaController Chara;
            public KK_Plugins.MaterialEditor.SceneController Scene;
            public int ItemId;
            public HashSet<Transform> Exclude; // body: not the clothes/hair/accessories under it
        }

        private sealed class Target
        {
            public Part Part;
            public Renderer Renderer;
            public Material Mat; // null when only the renderer is addressed
        }

        private static string Clean(string n) => (n ?? "").Replace("(Instance)", "").Trim();

        private static ObjectCtrlInfo Oci(Dictionary<string, object> a)
        {
            var o = SceneApi.FindOci(a.GetInt("id"));
            if (!(o is OCIChar) && !(o is OCIItem)) throw new BridgeException("Select a character or an item");
            return o;
        }

        private static List<Part> Parts(ObjectCtrlInfo oci)
        {
            var list = new List<Part>();
            if (oci is OCIChar ch && ch.charInfo != null)
            {
                var cha = ch.charInfo;
                var ctrl = KK_Plugins.MaterialEditor.MaterialEditorPlugin.GetCharaController(cha);
                if (ctrl == null) throw new BridgeException("MaterialEditor isn't ready on this character yet");
                var exclude = new HashSet<Transform>();
                var slots = new List<Part>();
                for (int i = 0; cha.objClothes != null && i < cha.objClothes.Length; i++)
                    if (cha.objClothes[i] != null && MaterialEditorAPI.MaterialAPI.GetRendererList(cha.objClothes[i]).Any())
                    {
                        slots.Add(new Part { Key = "Clothing:" + i, Label = i < ClothesNames.Length ? ClothesNames[i] : "Clothes " + (i + 1), Type = ObjectType.Clothing, Slot = i, Go = cha.objClothes[i], Chara = ctrl });
                        exclude.Add(cha.objClothes[i].transform);
                    }
                for (int i = 0; cha.objHair != null && i < cha.objHair.Length; i++)
                    if (cha.objHair[i] != null && MaterialEditorAPI.MaterialAPI.GetRendererList(cha.objHair[i]).Any())
                    {
                        slots.Add(new Part { Key = "Hair:" + i, Label = i < HairNames.Length ? HairNames[i] : "Hair " + (i + 1), Type = ObjectType.Hair, Slot = i, Go = cha.objHair[i], Chara = ctrl });
                        exclude.Add(cha.objHair[i].transform);
                    }
                var accs = KKAPI.Maker.AccessoriesApi.GetAccessoryObjects(cha) ?? new GameObject[0];
                for (int i = 0; i < accs.Length; i++)
                    if (accs[i] != null)
                    {
                        slots.Add(new Part { Key = "Accessory:" + i, Label = "Accessory " + (i + 1) + " · " + Clean(accs[i].name), Type = ObjectType.Accessory, Slot = i, Go = accs[i], Chara = ctrl });
                        exclude.Add(accs[i].transform);
                    }
                list.Add(new Part { Key = "Character:0", Label = "Body", Type = ObjectType.Character, Slot = 0, Go = cha.gameObject, Chara = ctrl, Exclude = exclude });
                list.AddRange(slots);
            }
            else if (oci is OCIItem it && it.objectItem != null)
            {
                var sc = UnityEngine.Object.FindObjectOfType<KK_Plugins.MaterialEditor.SceneController>();
                if (sc == null) throw new BridgeException("MaterialEditor's scene controller isn't there");
                list.Add(new Part { Key = "Item:0", Label = SceneApi.DisplayName(oci), Type = ObjectType.Character, Slot = 0, Go = it.objectItem, Scene = sc, ItemId = it.objectInfo.dicKey });
            }
            return list;
        }

        private static IEnumerable<Renderer> Renderers(Part p) =>
            MaterialEditorAPI.MaterialAPI.GetRendererList(p.Go).Where(r => r != null && (p.Exclude == null || !p.Exclude.Any(x => r.transform.IsChildOf(x))));

        private static Target Find(Dictionary<string, object> a, bool needMaterial = true)
        {
            var oci = Oci(a);
            var part = Parts(oci).FirstOrDefault(p => p.Key == a.GetString("part")) ?? throw new BridgeException("That part isn't on the object any more");
            var r = Renderers(part).FirstOrDefault(x => Clean(x.name) == a.GetString("renderer")) ?? throw new BridgeException("Renderer not found");
            Material m = null;
            if (needMaterial)
                m = MaterialEditorAPI.MaterialAPI.GetMaterials(part.Go, r).FirstOrDefault(x => x != null && Clean(x.name) == a.GetString("material")) ?? throw new BridgeException("Material not found");
            return new Target { Part = part, Renderer = r, Mat = m };
        }

        // ------------------------------------------------------------------ reading

        public static object Tree(Dictionary<string, object> a)
        {
            var oci = Oci(a);
            return new Dictionary<string, object>
            {
                { "name", SceneApi.DisplayName(oci) },
                { "kind", oci is OCIChar ? "Char" : "Item" },
                { "clipboard", _clipboard },
                { "parts", Parts(oci).Select(p => (object)new Dictionary<string, object>
                    {
                        { "key", p.Key }, { "label", p.Label },
                        { "renderers", Renderers(p).Select(r => (object)new Dictionary<string, object>
                            {
                                { "name", Clean(r.name) },
                                { "enabled", r.enabled },
                                { "materials", MaterialEditorAPI.MaterialAPI.GetMaterials(p.Go, r).Where(m => m != null).Select(m => (object)new Dictionary<string, object>
                                    { { "name", Clean(m.name) }, { "shader", m.shader != null ? m.shader.name : "" } }).ToList() },
                            }).ToList() },
                    }).Where(p => ((List<object>)((Dictionary<string, object>)p)["renderers"]).Count > 0).ToList() },
            };
        }

        private static IEnumerable<KeyValuePair<string, MaterialEditorAPI.MaterialEditorPluginBase.ShaderPropertyData>> Props(Material m)
        {
            var db = MaterialEditorAPI.MaterialEditorPluginBase.XMLShaderProperties;
            var seen = new HashSet<string>();
            foreach (var key in new[] { m.shader.name, "default" })
            {
                if (!db.TryGetValue(key, out var props)) continue;
                foreach (var kv in props)
                {
                    if (!seen.Add(kv.Key)) continue;
                    if (kv.Value.Type != ShaderPropertyType.Keyword && !m.HasProperty("_" + kv.Key)) continue;
                    yield return kv;
                }
            }
        }

        private static List<object> C(Color c) => new List<object> { c.r, c.g, c.b, c.a };
        private static List<object> V(Vector2 v) => new List<object> { v.x, v.y };

        public static object Material(Dictionary<string, object> a)
        {
            var t = Find(a);
            var m = t.Mat;
            var floats = new List<object>();
            var colors = new List<object>();
            var textures = new List<object>();
            var keywords = new List<object>();
            foreach (var kv in Props(m))
            {
                string p = kv.Key;
                switch (kv.Value.Type)
                {
                    case ShaderPropertyType.Float:
                        {
                            var d = new Dictionary<string, object> { { "name", p }, { "value", m.GetFloat("_" + p) }, { "edited", GetFloat(t, p) != null } };
                            if (kv.Value.MinValue.HasValue) { d["min"] = kv.Value.MinValue.Value; d["max"] = kv.Value.MaxValue.Value; }
                            floats.Add(d);
                            break;
                        }
                    case ShaderPropertyType.Color:
                        colors.Add(new Dictionary<string, object> { { "name", p }, { "value", C(m.GetColor("_" + p)) }, { "edited", GetColor(t, p) != null } });
                        break;
                    case ShaderPropertyType.Texture:
                        {
                            var tex = m.GetTexture("_" + p);
                            textures.Add(new Dictionary<string, object>
                            {
                                { "name", p }, { "has", tex != null }, { "size", tex != null ? tex.width + "×" + tex.height : "" },
                                { "thumb", tex != null ? Thumb(tex, 96) : null },
                                { "offset", V(m.GetTextureOffset("_" + p)) }, { "scale", V(m.GetTextureScale("_" + p)) },
                                { "edited", GetTex(t, p) != null }, { "offsetEdited", GetOffset(t, p) != null }, { "scaleEdited", GetScale(t, p) != null },
                            });
                            break;
                        }
                    case ShaderPropertyType.Keyword:
                        keywords.Add(new Dictionary<string, object> { { "name", p }, { "on", m.IsKeywordEnabled("_" + p) }, { "edited", GetKeyword(t, p) != null } });
                        break;
                }
            }
            var r = t.Renderer;
            return new Dictionary<string, object>
            {
                { "material", Clean(m.name) },
                { "shader", m.shader.name }, { "shaderEdited", GetShader(t) != null },
                { "renderQueue", m.renderQueue }, { "renderQueueEdited", GetQueue(t) != null },
                { "floats", floats }, { "colors", colors }, { "textures", textures }, { "keywords", keywords },
                { "renderer", new Dictionary<string, object>
                    {
                        { "enabled", r.enabled }, { "shadowCasting", r.shadowCastingMode.ToString() }, { "receiveShadows", r.receiveShadows },
                        { "enabledEdited", GetRenderer(t, RendererProperties.Enabled) != null },
                        { "shadowCastingEdited", GetRenderer(t, RendererProperties.ShadowCastingMode) != null },
                        { "receiveShadowsEdited", GetRenderer(t, RendererProperties.ReceiveShadows) != null },
                    } },
                { "clipboard", _clipboard },
            };
        }

        /// <summary>A small JPEG of any texture (render textures and non-readable ones too).</summary>
        private static string Thumb(Texture tex, int size)
        {
            try
            {
                float aspect = tex.height > 0 ? (float)tex.width / tex.height : 1f;
                int w = aspect >= 1 ? size : Mathf.Max(8, Mathf.RoundToInt(size * aspect)), h = aspect >= 1 ? Mathf.Max(8, Mathf.RoundToInt(size / aspect)) : size;
                var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(tex, rt);
                var prev = RenderTexture.active;
                RenderTexture.active = rt;
                var t2 = new Texture2D(w, h, TextureFormat.RGB24, false);
                t2.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                t2.Apply();
                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(rt);
                var jpg = t2.EncodeToJPG(80);
                UnityEngine.Object.Destroy(t2);
                return "data:image/jpeg;base64," + Convert.ToBase64String(jpg);
            }
            catch { return null; }
        }

        // ------------------------------------------------------------------ MaterialEditor calls (character or item)

        private static float? GetFloat(Target t, string p) => t.Part.Chara != null ? t.Part.Chara.GetMaterialFloatPropertyValue(t.Part.Slot, t.Part.Type, t.Mat, p, t.Part.Go) : t.Part.Scene.GetMaterialFloatPropertyValue(t.Part.ItemId, t.Mat, p);
        private static Color? GetColor(Target t, string p) => t.Part.Chara != null ? t.Part.Chara.GetMaterialColorPropertyValue(t.Part.Slot, t.Part.Type, t.Mat, p, t.Part.Go) : t.Part.Scene.GetMaterialColorPropertyValue(t.Part.ItemId, t.Mat, p);
        private static bool? GetKeyword(Target t, string p) => t.Part.Chara != null ? t.Part.Chara.GetMaterialKeywordPropertyValue(t.Part.Slot, t.Part.Type, t.Mat, p, t.Part.Go) : t.Part.Scene.GetMaterialKeywordPropertyValue(t.Part.ItemId, t.Mat, p);
        private static Texture GetTex(Target t, string p) => t.Part.Chara != null ? t.Part.Chara.GetMaterialTexture(t.Part.Slot, t.Part.Type, t.Mat, p, t.Part.Go) : t.Part.Scene.GetMaterialTexture(t.Part.ItemId, t.Mat, p);
        private static Vector2? GetOffset(Target t, string p) => t.Part.Chara != null ? t.Part.Chara.GetMaterialTextureOffset(t.Part.Slot, t.Part.Type, t.Mat, p, t.Part.Go) : t.Part.Scene.GetMaterialTextureOffset(t.Part.ItemId, t.Mat, p);
        private static Vector2? GetScale(Target t, string p) => t.Part.Chara != null ? t.Part.Chara.GetMaterialTextureScale(t.Part.Slot, t.Part.Type, t.Mat, p, t.Part.Go) : t.Part.Scene.GetMaterialTextureScale(t.Part.ItemId, t.Mat, p);
        private static string GetShader(Target t) => t.Part.Chara != null ? t.Part.Chara.GetMaterialShader(t.Part.Slot, t.Part.Type, t.Mat, t.Part.Go) : t.Part.Scene.GetMaterialShader(t.Part.ItemId, t.Mat);
        private static int? GetQueue(Target t) => t.Part.Chara != null ? t.Part.Chara.GetMaterialShaderRenderQueue(t.Part.Slot, t.Part.Type, t.Mat, t.Part.Go) : t.Part.Scene.GetMaterialShaderRenderQueue(t.Part.ItemId, t.Mat);
        private static string GetRenderer(Target t, RendererProperties rp) => t.Part.Chara != null ? t.Part.Chara.GetRendererPropertyValue(t.Part.Slot, t.Part.Type, t.Renderer, rp, t.Part.Go) : t.Part.Scene.GetRendererPropertyValue(t.Part.ItemId, t.Renderer, rp);

        /// <summary>What an edit of this kind currently overrides (null = not edited), to put it back on undo.</summary>
        private static object Current(Target t, string kind, string p)
        {
            switch (kind)
            {
                case "float": return GetFloat(t, p);
                case "color": return GetColor(t, p);
                case "keyword": return GetKeyword(t, p);
                case "offset": return GetOffset(t, p);
                case "scale": return GetScale(t, p);
                case "shader": return GetShader(t);
                case "queue": return GetQueue(t);
                case "enabled": return GetRenderer(t, RendererProperties.Enabled);
                case "shadowCasting": return GetRenderer(t, RendererProperties.ShadowCastingMode);
                case "receiveShadows": return GetRenderer(t, RendererProperties.ReceiveShadows);
            }
            throw new BridgeException("Unknown setting: " + kind);
        }

        private static RendererProperties RendererProp(string kind) =>
            kind == "enabled" ? RendererProperties.Enabled : kind == "shadowCasting" ? RendererProperties.ShadowCastingMode : RendererProperties.ReceiveShadows;

        private static void Apply(Target t, string kind, string p, object v)
        {
            var c = t.Part.Chara;
            var s = t.Part.Scene;
            int slot = t.Part.Slot, id = t.Part.ItemId;
            var type = t.Part.Type;
            var go = t.Part.Go;
            switch (kind)
            {
                case "float":
                    {
                        float f = Convert.ToSingle(v);
                        if (c != null) c.SetMaterialFloatProperty(slot, type, t.Mat, p, f, go); else s.SetMaterialFloatProperty(id, t.Mat, p, f, true);
                        break;
                    }
                case "color":
                    {
                        var col = v is Color cc ? cc : ToColor(v, t.Mat.GetColor("_" + p));
                        if (c != null) c.SetMaterialColorProperty(slot, type, t.Mat, p, col, go); else s.SetMaterialColorProperty(id, t.Mat, p, col, true);
                        break;
                    }
                case "keyword":
                    {
                        bool on = Convert.ToBoolean(v);
                        if (c != null) c.SetMaterialKeywordProperty(slot, type, t.Mat, p, on, go, true); else s.SetMaterialKeywordProperty(id, t.Mat, p, on, true);
                        break;
                    }
                case "offset":
                case "scale":
                    {
                        var vec = v is Vector2 vv ? vv : ToVec(v);
                        if (kind == "offset") { if (c != null) c.SetMaterialTextureOffset(slot, type, t.Mat, p, vec, go, true); else s.SetMaterialTextureOffset(id, t.Mat, p, vec, true); }
                        else { if (c != null) c.SetMaterialTextureScale(slot, type, t.Mat, p, vec, go, true); else s.SetMaterialTextureScale(id, t.Mat, p, vec, true); }
                        break;
                    }
                case "shader":
                    {
                        string name = Convert.ToString(v);
                        if (!MaterialEditorAPI.MaterialEditorPluginBase.LoadedShaders.ContainsKey(name)) throw new BridgeException("MaterialEditor doesn't have the shader “" + name + "”");
                        if (c != null) c.SetMaterialShader(slot, type, t.Mat, name, go, true); else s.SetMaterialShader(id, t.Mat, name, true);
                        break;
                    }
                case "queue":
                    {
                        int q = Mathf.Clamp(Convert.ToInt32(v), 0, 5000);
                        if (c != null) c.SetMaterialShaderRenderQueue(slot, type, t.Mat, q, go, true); else s.SetMaterialShaderRenderQueue(id, t.Mat, q, true);
                        break;
                    }
                case "enabled":
                case "shadowCasting":
                case "receiveShadows":
                    {
                        // MaterialEditor stores renderer settings as text: "1"/"0" for switches, the mode's number for shadows
                        string str = kind == "shadowCasting" ? ((int)ShadowMode(v)).ToString() : v is string sv && (sv == "0" || sv == "1") ? sv : Convert.ToBoolean(v) ? "1" : "0";
                        if (c != null) c.SetRendererProperty(slot, type, t.Renderer, RendererProp(kind), str, go, true); else s.SetRendererProperty(id, t.Renderer, RendererProp(kind), str, true);
                        break;
                    }
                default: throw new BridgeException("Unknown setting: " + kind);
            }
        }

        private static void Remove(Target t, string kind, string p)
        {
            var c = t.Part.Chara;
            var s = t.Part.Scene;
            int slot = t.Part.Slot, id = t.Part.ItemId;
            var type = t.Part.Type;
            var go = t.Part.Go;
            switch (kind)
            {
                case "float": if (c != null) c.RemoveMaterialFloatProperty(slot, type, t.Mat, p, go); else s.RemoveMaterialFloatProperty(id, t.Mat, p, true); break;
                case "color": if (c != null) c.RemoveMaterialColorProperty(slot, type, t.Mat, p, go); else s.RemoveMaterialColorProperty(id, t.Mat, p, true); break;
                case "keyword": if (c != null) c.RemoveMaterialKeywordProperty(slot, type, t.Mat, p, go, true); else s.RemoveMaterialKeywordProperty(id, t.Mat, p, true); break;
                case "offset": if (c != null) c.RemoveMaterialTextureOffset(slot, type, t.Mat, p, go, true); else s.RemoveMaterialTextureOffset(id, t.Mat, p, true); break;
                case "scale": if (c != null) c.RemoveMaterialTextureScale(slot, type, t.Mat, p, go, true); else s.RemoveMaterialTextureScale(id, t.Mat, p, true); break;
                case "texture": if (c != null) c.RemoveMaterialTexture(slot, type, t.Mat, p, go, false); else s.RemoveMaterialTexture(id, t.Mat, p, false); break;
                case "shader": if (c != null) c.RemoveMaterialShader(slot, type, t.Mat, go, true); else s.RemoveMaterialShader(id, t.Mat, true); break;
                case "queue": if (c != null) c.RemoveMaterialShaderRenderQueue(slot, type, t.Mat, go, true); else s.RemoveMaterialShaderRenderQueue(id, t.Mat, true); break;
                case "enabled":
                case "shadowCasting":
                case "receiveShadows":
                    if (c != null) c.RemoveRendererProperty(slot, type, t.Renderer, RendererProp(kind), go, true); else s.RemoveRendererProperty(id, t.Renderer, RendererProp(kind), true);
                    break;
                default: throw new BridgeException("Unknown setting: " + kind);
            }
        }

        private static UnityEngine.Rendering.ShadowCastingMode ShadowMode(object v)
        {
            if (v is string s)
            {
                if (int.TryParse(s, out var n)) return (UnityEngine.Rendering.ShadowCastingMode)n;
                return (UnityEngine.Rendering.ShadowCastingMode)Enum.Parse(typeof(UnityEngine.Rendering.ShadowCastingMode), s, true);
            }
            return (UnityEngine.Rendering.ShadowCastingMode)Convert.ToInt32(v);
        }

        private static Color ToColor(object o, Color fallback)
        {
            var l = o as List<object>;
            if (l == null || l.Count < 3) return fallback;
            return new Color(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]), l.Count > 3 ? Convert.ToSingle(l[3]) : fallback.a);
        }

        private static Vector2 ToVec(object o)
        {
            var l = o as List<object>;
            if (l == null || l.Count < 2) throw new BridgeException("Expected [x, y]");
            return new Vector2(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]));
        }

        // ------------------------------------------------------------------ editing (undoable)

        private sealed class Change
        {
            public Target Target;
            public string Kind, Prop;
            public object Previous; // null = was not edited
        }

        private sealed class MeUndo : IUndoEntry
        {
            private readonly Change _c;
            private readonly string _key;
            public MeUndo(Change c, string key) { _c = c; _key = key; }
            public string Label => "Material edit";
            // one slider drag = one step
            public bool Absorbs(IUndoEntry newer) => newer is MeUndo n && n._key == _key;
            public IUndoEntry Restore()
            {
                var t = _c.Target;
                if (t.Part.Go == null || t.Renderer == null || (t.Mat == null && _c.Kind != "enabled" && _c.Kind != "shadowCasting" && _c.Kind != "receiveShadows"))
                    return new MeUndo(_c, _key);
                var inverse = new Change { Target = t, Kind = _c.Kind, Prop = _c.Prop, Previous = Current(t, _c.Kind, _c.Prop) };
                if (_c.Previous == null) Remove(t, _c.Kind, _c.Prop);
                else Apply(t, _c.Kind, _c.Prop, _c.Previous);
                return new MeUndo(inverse, _key + "|undo");
            }
        }

        private static bool RendererKind(string k) => k == "enabled" || k == "shadowCasting" || k == "receiveShadows";

        /// <summary>args: {id, part, renderer, material?, kind, prop?, value}</summary>
        public static object Set(Dictionary<string, object> a)
        {
            string kind = a.GetString("kind"), prop = a.GetString("prop");
            var t = Find(a, !RendererKind(kind));
            if (!a.ContainsKey("value")) throw new BridgeException("No value");
            var change = new Change { Target = t, Kind = kind, Prop = prop, Previous = Current(t, kind, prop) };
            Apply(t, kind, prop, a["value"]);
            UndoStack.Push(new MeUndo(change, string.Join("|", new[] { a.GetString("id"), a.GetString("part"), a.GetString("renderer"), a.GetString("material"), kind, prop })));
            return t.Mat != null ? Material(a) : true;
        }

        public static object Reset(Dictionary<string, object> a)
        {
            string kind = a.GetString("kind"), prop = a.GetString("prop");
            var t = Find(a, !RendererKind(kind));
            if (kind != "texture")
            {
                var prev = Current(t, kind, prop);
                if (prev != null) UndoStack.Push(new MeUndo(new Change { Target = t, Kind = kind, Prop = prop, Previous = prev }, "reset"));
            }
            Remove(t, kind, prop);
            return t.Mat != null ? Material(a) : true;
        }

        // ------------------------------------------------------------------ textures

        /// <summary>args: {…target, prop, path} — an image file becomes the material's texture (saved with the scene).</summary>
        public static object Texture(Dictionary<string, object> a)
        {
            var t = Find(a);
            string prop = a.GetString("prop"), path = a.GetString("path");
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new BridgeException("Image file not found");
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext != ".png" && ext != ".jpg" && ext != ".jpeg") throw new BridgeException("Use a PNG or JPG image");
            var data = File.ReadAllBytes(path);
            if (t.Part.Chara != null) t.Part.Chara.SetMaterialTexture(t.Part.Slot, t.Part.Type, t.Mat, prop, data, t.Part.Go);
            else t.Part.Scene.SetMaterialTexture(t.Part.ItemId, t.Mat, prop, data);
            return Material(a);
        }

        /// <summary>args: {…target, prop} → the PNG's path (MaterialEditor's export folder).</summary>
        public static object Export(Dictionary<string, object> a)
        {
            var t = Find(a);
            string prop = a.GetString("prop");
            var tex = t.Mat.GetTexture("_" + prop) ?? throw new BridgeException("No texture there");
            var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0, RenderTextureFormat.ARGB32);
            Graphics.Blit(tex, rt);
            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            var t2 = new Texture2D(tex.width, tex.height, TextureFormat.ARGB32, false);
            t2.ReadPixels(new Rect(0, 0, tex.width, tex.height), 0, 0);
            t2.Apply();
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(rt);
            string dir = MaterialEditorAPI.MaterialEditorPluginBase.ExportPath;
            if (string.IsNullOrEmpty(dir)) dir = Path.Combine(UserData.Path, "MaterialEditor");
            Directory.CreateDirectory(dir);
            string safe = new string((Clean(t.Mat.name) + "_" + prop).Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch).ToArray());
            string file = Path.Combine(dir, safe + "_" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
            File.WriteAllBytes(file, t2.EncodeToPNG());
            UnityEngine.Object.Destroy(t2);
            return new Dictionary<string, object> { { "path", file }, { "folder", dir } };
        }

        public static object Shaders() =>
            MaterialEditorAPI.MaterialEditorPluginBase.LoadedShaders.Keys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase).Cast<object>().ToList();

        // ------------------------------------------------------------------ copy / paste (MaterialEditor's own clipboard)

        private static string _clipboard; // which material was copied (for the app to show)

        public static object Copy(Dictionary<string, object> a)
        {
            var t = Find(a);
            if (t.Part.Chara != null) t.Part.Chara.MaterialCopyEdits(t.Part.Slot, t.Part.Type, t.Mat, t.Part.Go);
            else t.Part.Scene.MaterialCopyEdits(t.Part.ItemId, t.Mat);
            _clipboard = Clean(t.Mat.name);
            return _clipboard;
        }

        public static object Paste(Dictionary<string, object> a)
        {
            if (_clipboard == null) throw new BridgeException("Copy a material's edits first");
            var t = Find(a);
            if (t.Part.Chara != null) t.Part.Chara.MaterialPasteEdits(t.Part.Slot, t.Part.Type, t.Mat, t.Part.Go, true);
            else t.Part.Scene.MaterialPasteEdits(t.Part.ItemId, t.Mat, true);
            return Material(a);
        }

        // ------------------------------------------------------------------ Timeline (MaterialEditor's own track types)

        private static readonly Dictionary<string, KeyValuePair<string, string>> TrackKinds = new Dictionary<string, KeyValuePair<string, string>>
        {
            // our kind → (MaterialEditor's track id, its RowItemType)
            { "float", new KeyValuePair<string, string>("floatProperty", "FloatProperty") },
            { "color", new KeyValuePair<string, string>("colorProperty", "ColorProperty") },
            { "texture", new KeyValuePair<string, string>("textureProperty", "TextureProperty") },
            { "offset", new KeyValuePair<string, string>("textureOffsetProperty", "TextureOffsetScale") },
            { "scale", new KeyValuePair<string, string>("textureScaleProperty", "TextureOffsetScale") },
            { "shader", new KeyValuePair<string, string>("shader", "Shader") },
            { "queue", new KeyValuePair<string, string>("renderQueue", "ShaderRenderQueue") },
            { "enabled", new KeyValuePair<string, string>("targetEnabled", "RendererEnabled") },
            { "shadowCasting", new KeyValuePair<string, string>("shadowCastingMode", "RendererShadowCastingMode") },
            { "receiveShadows", new KeyValuePair<string, string>("receiveShadows", "RendererReceiveShadows") },
        };

        /// <summary>
        /// args: {…target, kind, prop?} → the new track's id, keyed at the playhead. MaterialEditor's tracks take what
        /// to animate from the property selected in its own window; that selection is set for the moment and put back.
        /// </summary>
        public static object Animate(Dictionary<string, object> a)
        {
            if (!TimelineApi.Available) throw new BridgeException("Animating needs Timeline");
            string kind = a.GetString("kind"), prop = a.GetString("prop") ?? "";
            if (!TrackKinds.TryGetValue(kind, out var tk)) throw new BridgeException("That setting can't be animated");
            var t = Find(a, !RendererKind(kind));
            var oci = Oci(a);
            var asm = typeof(MaterialEditorAPI.MaterialAPI).Assembly;
            var uiType = asm.GetType("MaterialEditorAPI.MaterialEditorUI");
            var selType = asm.GetType("MaterialEditorAPI.MaterialEditorUI+SelectedInterpolable");
            var rowType = asm.GetTypes().First(x => x.Name == "RowItemType");
            var field = AccessTools.Field(uiType, "selectedInterpolable");
            if (field == null || selType == null) throw new BridgeException("This MaterialEditor version can't add Timeline tracks from here");
            var before = field.GetValue(null);
            var sel = Activator.CreateInstance(selType, t.Part.Go, Enum.Parse(rowType, tk.Value), t.Mat != null ? Clean(t.Mat.name) : "", prop, Clean(t.Renderer.name));
            field.SetValue(null, sel);
            try
            {
                return TimelineApi.AddModelTrack(tk.Key, "MaterialEditor", oci, TimelineApi.PlaybackTime());
            }
            finally { field.SetValue(null, before); }
        }
    }
}
