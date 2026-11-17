using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using BepInEx.Bootstrap;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Shader property tweaks across many materials at once, through KK_MaterialEditor so every change
    /// is saved with the scene/card exactly like an edit made in MaterialEditor itself.
    /// A "rule" = {shader, prop, type: float|color, value, parts?} and targets every material using that shader
    /// on the chosen characters/items. Safe to call when MaterialEditor isn't installed.
    /// </summary>
    internal static class MaterialLookApi
    {
        private static bool? _available;
        public static bool Available
        {
            get
            {
                if (_available == null) _available = Chainloader.PluginInfos.ContainsKey("com.deathweasel.bepinex.materialeditor");
                return _available.Value;
            }
        }

        public static void Register(CommandRouter r)
        {
            r.Add("material.list", a => { Require(); return ListImpl(a.GetList("ids")); });
            r.Add("material.set", a => { Require(); return SetImpl(a); });
            r.Add("material.reset", a => { Require(); return ResetImpl(a); });
        }

        private static void Require()
        {
            if (!Available) throw new BridgeException("KK_MaterialEditor is not installed");
        }

        [MethodImpl(MethodImplOptions.NoInlining)] private static object ListImpl(List<object> ids) => MaterialLookImpl.List(ids);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object SetImpl(Dictionary<string, object> a) => MaterialLookImpl.Set(a);
        [MethodImpl(MethodImplOptions.NoInlining)] private static object ResetImpl(Dictionary<string, object> a) => MaterialLookImpl.Reset(a);

        /// <summary>Apply preset rules. ids == null/empty → the selected objects, or every character if nothing is selected.</summary>
        public static void ApplyRules(List<object> rules, List<object> ids, float strength)
        {
            if (Available) ApplyRulesImpl(rules, ids, strength);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ApplyRulesImpl(List<object> rules, List<object> ids, float strength) => MaterialLookImpl.ApplyRules(rules, ids, strength);
    }

    internal static class MaterialLookImpl
    {
        private const string Body = "body", Clothes = "clothes", Hair = "hair", Acc = "accessory", Item = "item";

        private sealed class Target
        {
            public KK_Plugins.MaterialEditor.MaterialEditorCharaController Chara;
            public KK_Plugins.MaterialEditor.SceneController Scene;
            public int ItemId;
            public int Slot;
            public KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType Type;
            public GameObject Go;
            public Material Mat;
            public string Part;
            public string Owner;
        }

        private static KK_Plugins.MaterialEditor.SceneController SceneCtrl => UnityEngine.Object.FindObjectOfType<KK_Plugins.MaterialEditor.SceneController>();

        private static IEnumerable<ObjectCtrlInfo> Resolve(List<object> ids, bool fallbackAllChars)
        {
            var studio = SceneApi.Studio;
            var list = new List<ObjectCtrlInfo>();
            if (ids != null)
                foreach (var id in ids)
                    if (SceneApi.FindOci(Convert.ToInt32(id)) is ObjectCtrlInfo o && (o is OCIChar || o is OCIItem)) list.Add(o);
            if (list.Count == 0)
                list.AddRange(studio.treeNodeCtrl.selectObjectCtrl.Where(o => o is OCIChar || o is OCIItem));
            if (list.Count == 0 && fallbackAllChars)
                list.AddRange(studio.dicObjectCtrl.Values.OfType<OCIChar>().Cast<ObjectCtrlInfo>());
            return list;
        }

        private static IEnumerable<Target> Targets(ObjectCtrlInfo oci)
        {
            if (oci is OCIChar ch && ch.charInfo != null)
            {
                var cha = ch.charInfo;
                var ctrl = KK_Plugins.MaterialEditor.MaterialEditorPlugin.GetCharaController(cha);
                if (ctrl == null) yield break;
                string owner = SceneApi.DisplayName(oci);
                var exclude = new HashSet<Transform>();
                var parts = new List<KeyValuePair<GameObject, KeyValuePair<int, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType>>>();
                for (int i = 0; cha.objClothes != null && i < cha.objClothes.Length; i++)
                    if (cha.objClothes[i] != null) { parts.Add(P(cha.objClothes[i], i, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType.Clothing)); exclude.Add(cha.objClothes[i].transform); }
                for (int i = 0; cha.objHair != null && i < cha.objHair.Length; i++)
                    if (cha.objHair[i] != null) { parts.Add(P(cha.objHair[i], i, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType.Hair)); exclude.Add(cha.objHair[i].transform); }
                var accs = KKAPI.Maker.AccessoriesApi.GetAccessoryObjects(cha) ?? new GameObject[0];
                for (int i = 0; i < accs.Length; i++)
                    if (accs[i] != null) { parts.Add(P(accs[i], i, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType.Accessory)); exclude.Add(accs[i].transform); }

                // Body/face: everything under the character that isn't clothing, hair or an accessory.
                foreach (var r in MaterialEditorAPI.MaterialAPI.GetRendererList(cha.gameObject))
                {
                    if (r == null || exclude.Any(x => r.transform.IsChildOf(x))) continue;
                    foreach (var m in MaterialEditorAPI.MaterialAPI.GetMaterials(cha.gameObject, r))
                        if (m != null) yield return new Target { Chara = ctrl, Slot = 0, Type = KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType.Character, Go = cha.gameObject, Mat = m, Part = Body, Owner = owner };
                }
                foreach (var p in parts)
                {
                    string part = p.Value.Value == KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType.Clothing ? Clothes
                        : p.Value.Value == KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType.Hair ? Hair : Acc;
                    foreach (var r in MaterialEditorAPI.MaterialAPI.GetRendererList(p.Key))
                        foreach (var m in MaterialEditorAPI.MaterialAPI.GetMaterials(p.Key, r))
                            if (m != null) yield return new Target { Chara = ctrl, Slot = p.Value.Key, Type = p.Value.Value, Go = p.Key, Mat = m, Part = part, Owner = owner };
                }
            }
            else if (oci is OCIItem it && it.objectItem != null)
            {
                var sc = SceneCtrl;
                if (sc == null) yield break;
                foreach (var r in MaterialEditorAPI.MaterialAPI.GetRendererList(it.objectItem))
                    foreach (var m in MaterialEditorAPI.MaterialAPI.GetMaterials(it.objectItem, r))
                        if (m != null) yield return new Target { Scene = sc, ItemId = it.objectInfo.dicKey, Go = it.objectItem, Mat = m, Part = Item, Owner = SceneApi.DisplayName(oci) };
            }
        }

        private static KeyValuePair<GameObject, KeyValuePair<int, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType>> P(GameObject go, int slot, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType t) =>
            new KeyValuePair<GameObject, KeyValuePair<int, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType>>(go, new KeyValuePair<int, KK_Plugins.MaterialEditor.MaterialEditorCharaController.ObjectType>(slot, t));

        /// <summary>Known editable properties for a shader, from MaterialEditor's shader database (+ "default").</summary>
        private static IEnumerable<KeyValuePair<string, MaterialEditorAPI.MaterialEditorPluginBase.ShaderPropertyData>> Props(Material m)
        {
            var db = MaterialEditorAPI.MaterialEditorPluginBase.XMLShaderProperties;
            var seen = new HashSet<string>();
            foreach (var key in new[] { m.shader.name, "default" })
            {
                if (!db.TryGetValue(key, out var props)) continue;
                foreach (var kv in props)
                {
                    if (!seen.Add(kv.Key) || !m.HasProperty("_" + kv.Key)) continue;
                    var t = kv.Value.Type;
                    if (t == MaterialEditorAPI.MaterialAPI.ShaderPropertyType.Float || t == MaterialEditorAPI.MaterialAPI.ShaderPropertyType.Color)
                        yield return kv;
                }
            }
        }

        private static List<object> C(Color c) => new List<object> { c.r, c.g, c.b, c.a };

        private static Color ToColor(object o, Color fallback)
        {
            var l = o as List<object>;
            if (l == null || l.Count < 3) return fallback;
            return new Color(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]), l.Count > 3 ? Convert.ToSingle(l[3]) : fallback.a);
        }

        public static object List(List<object> ids)
        {
            var shaders = new Dictionary<string, Dictionary<string, object>>();
            foreach (var oci in Resolve(ids, false))
                foreach (var t in Targets(oci))
                {
                    string sh = t.Mat.shader.name;
                    if (!shaders.TryGetValue(sh, out var entry))
                    {
                        entry = new Dictionary<string, object>
                        {
                            { "shader", sh }, { "materials", 0 }, { "parts", new List<object>() },
                            { "props", new Dictionary<string, object>() },
                        };
                        shaders[sh] = entry;
                    }
                    entry["materials"] = (int)entry["materials"] + 1;
                    var parts = (List<object>)entry["parts"];
                    if (!parts.Contains(t.Part)) parts.Add(t.Part);
                    var props = (Dictionary<string, object>)entry["props"];
                    foreach (var kv in Props(t.Mat))
                    {
                        string prop = kv.Key;
                        bool isColor = kv.Value.Type == MaterialEditorAPI.MaterialAPI.ShaderPropertyType.Color;
                        object value = isColor ? (object)C(t.Mat.GetColor("_" + prop)) : t.Mat.GetFloat("_" + prop);
                        if (!props.TryGetValue(prop, out var po))
                        {
                            var pd = new Dictionary<string, object> { { "name", prop }, { "type", isColor ? "color" : "float" }, { "value", value }, { "mixed", false } };
                            if (kv.Value.MinValue.HasValue) { pd["min"] = kv.Value.MinValue.Value; pd["max"] = kv.Value.MaxValue.Value; }
                            props[prop] = pd;
                        }
                        else
                        {
                            var pd = (Dictionary<string, object>)po;
                            if (!(bool)pd["mixed"] && Json.Serialize(pd["value"]) != Json.Serialize(value)) pd["mixed"] = true;
                        }
                    }
                }
            return shaders.Values.OrderByDescending(s => (int)s["materials"]).Select(s =>
            {
                s["props"] = ((Dictionary<string, object>)s["props"]).Values.OrderBy(p => (string)((Dictionary<string, object>)p)["name"]).ToList();
                return (object)s;
            }).ToList();
        }

        private static bool PartOk(Target t, List<object> parts) => parts.Count == 0 || parts.Contains(t.Part);

        /// <summary>
        /// MaterialEditor stores overrides per (owner, slot, object type, material NAME) and applies them to every
        /// renderer with that material name. Several renderers often share a name, so edits must be grouped the same
        /// way — otherwise the 2nd same-named material sees the 1st one's new value as its "previous" value.
        /// </summary>
        private static string MeKey(Target t)
        {
            string name = t.Mat.name.Replace("(Instance)", "").Trim();
            return t.Chara != null
                ? t.Chara.GetInstanceID() + "|" + (int)t.Type + "|" + t.Slot + "|" + name
                : "item|" + t.ItemId + "|" + name;
        }

        private static List<Target> Distinct(IEnumerable<Target> targets)
        {
            var seen = new HashSet<string>();
            var list = new List<Target>();
            foreach (var t in targets) if (seen.Add(MeKey(t))) list.Add(t);
            return list;
        }

        // ---- MaterialEditor calls (persisted with scene/card) ----
        private static object GetOverride(Target t, string prop, bool color)
        {
            if (t.Chara != null)
                return color ? (object)t.Chara.GetMaterialColorPropertyValue(t.Slot, t.Type, t.Mat, prop, t.Go) : t.Chara.GetMaterialFloatPropertyValue(t.Slot, t.Type, t.Mat, prop, t.Go);
            return color ? (object)t.Scene.GetMaterialColorPropertyValue(t.ItemId, t.Mat, prop) : t.Scene.GetMaterialFloatPropertyValue(t.ItemId, t.Mat, prop);
        }

        private static void SetValue(Target t, string prop, object value)
        {
            if (value is Color c)
            {
                if (t.Chara != null) t.Chara.SetMaterialColorProperty(t.Slot, t.Type, t.Mat, prop, c, t.Go);
                else t.Scene.SetMaterialColorProperty(t.ItemId, t.Mat, prop, c);
            }
            else
            {
                float f = Convert.ToSingle(value);
                if (t.Chara != null) t.Chara.SetMaterialFloatProperty(t.Slot, t.Type, t.Mat, prop, f, t.Go);
                else t.Scene.SetMaterialFloatProperty(t.ItemId, t.Mat, prop, f);
            }
        }

        private static void RemoveValue(Target t, string prop, bool color)
        {
            if (t.Chara != null)
            {
                if (color) t.Chara.RemoveMaterialColorProperty(t.Slot, t.Type, t.Mat, prop, t.Go);
                else t.Chara.RemoveMaterialFloatProperty(t.Slot, t.Type, t.Mat, prop, t.Go);
            }
            else
            {
                if (color) t.Scene.RemoveMaterialColorProperty(t.ItemId, t.Mat, prop);
                else t.Scene.RemoveMaterialFloatProperty(t.ItemId, t.Mat, prop);
            }
        }

        private sealed class Change
        {
            public Target Target;
            public string Prop;
            public bool Color;
            public object Previous; // null = was not overridden
        }

        private sealed class MaterialUndo : IUndoEntry
        {
            private readonly List<Change> _changes;
            private readonly string _key;
            public MaterialUndo(List<Change> changes, string key) { _changes = changes; _key = key; }
            public string Label => "Material change";
            public bool Absorbs(IUndoEntry newer) => newer is MaterialUndo n && n._key == _key;
            public IUndoEntry Restore()
            {
                var inverse = new List<Change>();
                foreach (var c in _changes)
                {
                    if (c.Target.Go == null || c.Target.Mat == null) continue;
                    inverse.Add(new Change { Target = c.Target, Prop = c.Prop, Color = c.Color, Previous = GetOverride(c.Target, c.Prop, c.Color) });
                    if (c.Previous == null) RemoveValue(c.Target, c.Prop, c.Color);
                    else SetValue(c.Target, c.Prop, c.Previous);
                }
                return new MaterialUndo(inverse, _key + "|undo");
            }
        }

        /// <summary>args: {ids, shader, prop, type, value, parts?}</summary>
        public static object Set(Dictionary<string, object> a)
        {
            string shader = a.GetString("shader"), prop = a.GetString("prop");
            bool color = a.GetString("type") == "color";
            var parts = a.GetList("parts");
            var targets = Distinct(Resolve(a.GetList("ids"), false).SelectMany(Targets)
                .Where(t => t.Mat.shader.name == shader && PartOk(t, parts) && t.Mat.HasProperty("_" + prop)));
            // Record every previous value before changing anything.
            var changes = targets.Select(t => new Change { Target = t, Prop = prop, Color = color, Previous = GetOverride(t, prop, color) }).ToList();
            foreach (var t in targets)
                SetValue(t, prop, color ? (object)ToColor(a["value"], t.Mat.GetColor("_" + prop)) : a.GetFloat("value"));
            if (changes.Count == 0) throw new BridgeException("No materials with that shader/property on the selection");
            UndoStack.Push(new MaterialUndo(changes, shader + "/" + prop + "/" + string.Join(",", parts.Select(p => p.ToString()).ToArray())));
            return changes.Count;
        }

        public static object Reset(Dictionary<string, object> a)
        {
            string shader = a.GetString("shader"), prop = a.GetString("prop");
            bool color = a.GetString("type") == "color";
            var targets = Distinct(Resolve(a.GetList("ids"), false).SelectMany(Targets)
                .Where(t => t.Mat.shader.name == shader && t.Mat.HasProperty("_" + prop)));
            var changes = targets.Select(t => new Change { Target = t, Prop = prop, Color = color, Previous = GetOverride(t, prop, color) })
                .Where(c => c.Previous != null).ToList();
            foreach (var c in changes) RemoveValue(c.Target, prop, color);
            if (changes.Count > 0) UndoStack.Push(new MaterialUndo(changes, "reset"));
            return changes.Count;
        }

        public static void ApplyRules(List<object> rules, List<object> ids, float strength)
        {
            var changes = new List<Change>();
            var all = Resolve(ids, true).SelectMany(Targets).ToList();
            foreach (Dictionary<string, object> rule in rules.OfType<Dictionary<string, object>>())
            {
                string shader = rule.GetString("shader"), prop = rule.GetString("prop");
                bool color = rule.GetString("type") == "color";
                var parts = rule.GetList("parts");
                var targets = Distinct(all.Where(t => t.Mat.shader.name == shader && PartOk(t, parts) && t.Mat.HasProperty("_" + prop)));
                var batch = targets.Select(t => new Change { Target = t, Prop = prop, Color = color, Previous = GetOverride(t, prop, color) }).ToList();
                changes.AddRange(batch);
                foreach (var t in targets)
                {
                    if (color)
                    {
                        var cur = t.Mat.GetColor("_" + prop);
                        SetValue(t, prop, Color.LerpUnclamped(cur, ToColor(rule["value"], cur), strength));
                    }
                    else SetValue(t, prop, Mathf.LerpUnclamped(t.Mat.GetFloat("_" + prop), rule.GetFloat("value"), strength));
                }
            }
            if (changes.Count > 0) UndoStack.Push(new MaterialUndo(changes, "preset-materials"));
        }
    }
}
