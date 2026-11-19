using System;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// xukmi FX Shaders (a popular mod): its effects are Studio items whose material carries an xukmi/Effects/*
    /// shader; their values are MaterialEditor properties. We list them, add them, and show/hide them, so the
    /// Effects page works with them when they're installed. Our own effects (FxApi) work without them.
    /// </summary>
    internal static class XukmiFx
    {
        public static void Register(CommandRouter r)
        {
            r.Add("fx.xukmi", a => State());
            r.Add("fx.addXukmi", a =>
            {
                var hit = Catalog().FirstOrDefault(c => c.Group == a.GetInt("group") && c.Category == a.GetInt("category") && c.No == a.GetInt("no"))
                    ?? throw new BridgeException("That xukmi effect isn't installed");
                var oci = AddObjectItem.Add(hit.Group, hit.Category, hit.No) ?? throw new BridgeException("Studio couldn't add the item");
                UndoStack.Push(new AddUndo(oci, hit));
                return oci.objectInfo.dicKey;
            });
        }

        private sealed class Entry
        {
            public int Group, Category, No;
            public string Name, CategoryName, File;
        }

        private static List<Entry> _catalog;

        /// <summary>Every xukmi FX item Studio knows (found by its asset bundle, so Sideloader's remapped ids are fine).</summary>
        private static List<Entry> Catalog()
        {
            if (_catalog != null) return _catalog;
            var list = new List<Entry>();
            var info = Singleton<Info>.Instance;
            if (info == null) return list;
            foreach (var g in info.dicItemLoadInfo)
                foreach (var c in g.Value)
                    foreach (var i in c.Value)
                        if (i.Value?.bundlePath != null && i.Value.bundlePath.IndexOf("xukmifx", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            string cat = info.dicItemGroupCategory.TryGetValue(g.Key, out var gi) && gi.dicCategory.TryGetValue(c.Key, out var cn) ? cn : "";
                            list.Add(new Entry { Group = g.Key, Category = c.Key, No = i.Key, Name = i.Value.name, CategoryName = cat, File = i.Value.fileName });
                        }
            if (list.Count > 0) _catalog = list; // empty until Studio has read its item lists
            return list;
        }

        /// <summary>The xukmi effect on a scene item (e.g. "TwoToneFog"), or null.</summary>
        private static string EffectOf(OCIItem it)
        {
            if (it?.objectItem == null) return null;
            foreach (var r in it.objectItem.GetComponentsInChildren<Renderer>(true))
                foreach (var m in r.sharedMaterials)
                    if (m != null && m.shader != null && m.shader.name.StartsWith("xukmi/Effects/", StringComparison.Ordinal))
                        return m.shader.name.Substring("xukmi/Effects/".Length);
            return null;
        }

        private static object State()
        {
            var cat = Catalog();
            var items = new List<object>();
            foreach (var kv in Singleton<Studio.Studio>.Instance.dicObjectCtrl)
                if (kv.Value is OCIItem it && EffectOf(it) is string fx)
                    items.Add(new Dictionary<string, object>
                    {
                        { "id", kv.Key }, { "name", SceneApi.DisplayName(it) }, { "effect", fx },
                        { "visible", it.treeNodeObject != null && it.treeNodeObject.visible },
                    });
            return new Dictionary<string, object>
            {
                { "installed", cat.Count > 0 },
                { "items", items },
                { "catalog", cat.Select(c => (object)new Dictionary<string, object> { { "group", c.Group }, { "category", c.Category }, { "no", c.No }, { "name", c.Name }, { "categoryName", c.CategoryName } }).ToList() },
            };
        }

        // ------------------------------------------------------------------ for looks

        private static Entry EntryOf(OCIItem it) =>
            Catalog().FirstOrDefault(c => c.Group == it.itemInfo.group && c.Category == it.itemInfo.category && c.No == it.itemInfo.no);

        /// <summary>The material carrying the xukmi shader: (part, renderer, material) for MaterialEditorApi.</summary>
        private static Dictionary<string, object> Target(int id)
        {
            if (!MaterialLookApi.Available) return null;
            var tree = MeImpl.Tree(new Dictionary<string, object> { { "id", id } }) as Dictionary<string, object>;
            foreach (var part in (tree?["parts"] as List<object> ?? new List<object>()).OfType<Dictionary<string, object>>())
                foreach (var r in ((List<object>)part["renderers"]).OfType<Dictionary<string, object>>())
                    foreach (var m in ((List<object>)r["materials"]).OfType<Dictionary<string, object>>())
                        if (Convert.ToString(m["shader"]).StartsWith("xukmi/Effects/", StringComparison.Ordinal))
                            return new Dictionary<string, object> { { "id", id }, { "part", part["key"] }, { "renderer", r["name"] }, { "material", m["name"] } };
            return null;
        }

        /// <summary>xukmi effect items in the scene with their values (needs MaterialEditor to read them).</summary>
        public static List<object> CaptureItems()
        {
            var list = new List<object>();
            if (Catalog().Count == 0) return list;
            foreach (var kv in Singleton<Studio.Studio>.Instance.dicObjectCtrl)
            {
                if (!(kv.Value is OCIItem it) || EffectOf(it) == null) continue;
                var e = EntryOf(it);
                if (e == null) continue;
                var d = new Dictionary<string, object> { { "file", e.File }, { "name", e.Name }, { "effect", EffectOf(it) }, { "visible", it.treeNodeObject == null || it.treeNodeObject.visible } };
                var tg = Target(kv.Key);
                if (tg != null && MeImpl.Material(tg) is Dictionary<string, object> mat)
                {
                    d["floats"] = ((List<object>)mat["floats"]).OfType<Dictionary<string, object>>().ToDictionary(f => (string)f["name"], f => f["value"]);
                    d["colors"] = ((List<object>)mat["colors"]).OfType<Dictionary<string, object>>().ToDictionary(c => (string)c["name"], c => c["value"]);
                }
                list.Add(d);
            }
            return list;
        }

        /// <summary>Bring a look's xukmi effects back: reuse the scene's item of the same effect or add one, then set its values. Undoable.</summary>
        public static int ApplyItems(List<object> list, float strength)
        {
            int n = 0;
            var cat = Catalog();
            foreach (var o in list.OfType<Dictionary<string, object>>())
            {
                string file = o.GetString("file"), effect = o.GetString("effect");
                var it = Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values.OfType<OCIItem>().FirstOrDefault(x => EffectOf(x) == effect);
                Entry added = null;
                if (it == null)
                {
                    added = cat.FirstOrDefault(c => c.File == file);
                    if (added == null) continue; // not installed here
                    it = AddObjectItem.Add(added.Group, added.Category, added.No);
                    if (it == null) continue;
                }
                var quiet = new List<KeyValuePair<string, KeyValuePair<string, object>>>();
                bool vis = o.GetBool("visible", true);
                if (it.treeNodeObject != null && it.treeNodeObject.visible != vis) it.treeNodeObject.SetVisible(vis);
                var tg = Target(it.objectInfo.dicKey);
                if (tg != null && MeImpl.Material(tg) is Dictionary<string, object> mat)
                {
                    var curF = ((List<object>)mat["floats"]).OfType<Dictionary<string, object>>().ToDictionary(f => (string)f["name"], f => Convert.ToSingle(f["value"]));
                    var curC = ((List<object>)mat["colors"]).OfType<Dictionary<string, object>>().ToDictionary(c => (string)c["name"], c => ((List<object>)c["value"]).Select(x => Convert.ToSingle(x)).ToArray());
                    if (o.GetObject("floats") is Dictionary<string, object> fl)
                        foreach (var f in fl)
                            if (curF.TryGetValue(f.Key, out var cur))
                            {
                                object val = (double)Mathf.Lerp(cur, Convert.ToSingle(f.Value), strength);
                                var args = new Dictionary<string, object>(tg) { { "kind", "float" }, { "prop", f.Key }, { "value", val } };
                                if (added != null) { MeImpl.SetQuietly(args); quiet.Add(new KeyValuePair<string, KeyValuePair<string, object>>("float", new KeyValuePair<string, object>(f.Key, val))); }
                                else MeImpl.Set(args);
                            }
                    if (o.GetObject("colors") is Dictionary<string, object> cl)
                        foreach (var c in cl)
                            if (curC.TryGetValue(c.Key, out var cur) && c.Value is List<object> tv)
                            {
                                var col = Enumerable.Range(0, 4).Select(i => (object)(double)Mathf.Lerp(cur[i], Convert.ToSingle(tv[Math.Min(i, tv.Count - 1)]), strength)).ToList();
                                var args = new Dictionary<string, object>(tg) { { "kind", "color" }, { "prop", c.Key }, { "value", col } };
                                if (added != null) { MeImpl.SetQuietly(args); quiet.Add(new KeyValuePair<string, KeyValuePair<string, object>>("color", new KeyValuePair<string, object>(c.Key, col))); }
                                else MeImpl.Set(args);
                            }
                }
                if (added != null) UndoStack.Push(new AddUndo(it, added, quiet)); // one step: the item with its values
                n++;
            }
            return n;
        }

        private sealed class AddUndo : IUndoEntry
        {
            private readonly OCIItem _oci;
            private readonly Entry _e;
            private readonly List<KeyValuePair<string, KeyValuePair<string, object>>> _values;
            public AddUndo(OCIItem oci, Entry e, List<KeyValuePair<string, KeyValuePair<string, object>>> values = null) { _oci = oci; _e = e; _values = values; }
            public string Label => "Add " + _e.Name;
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                // the values edited on it go with the item: a redo re-creates a new object, and edits recorded
                // against the old one can't reach it
                var edits = _values ?? (_oci?.objectInfo != null ? EditedValues(_oci.objectInfo.dicKey) : null);
                if (_oci?.treeNodeObject != null) Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(_oci.treeNodeObject);
                return new RemoveUndo(_e, edits);
            }
        }

        private sealed class RemoveUndo : IUndoEntry
        {
            private readonly Entry _e;
            private readonly List<KeyValuePair<string, KeyValuePair<string, object>>> _edits; // kind → (prop, value)
            public RemoveUndo(Entry e, List<KeyValuePair<string, KeyValuePair<string, object>>> edits) { _e = e; _edits = edits; }
            public string Label => "Add " + _e.Name;
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                var it = AddObjectItem.Add(_e.Group, _e.Category, _e.No);
                if (it != null && _edits != null && _edits.Count > 0)
                {
                    var tg = Target(it.objectInfo.dicKey);
                    if (tg != null)
                        foreach (var ed in _edits)
                        {
                            try { MeImpl.SetQuietly(new Dictionary<string, object>(tg) { { "kind", ed.Key }, { "prop", ed.Value.Key }, { "value", ed.Value.Value } }); }
                            catch (Exception ex) { StudioBridgePlugin.Logger.LogDebug("xukmi redo value: " + ex.Message); }
                        }
                }
                return new AddUndo(it, _e, _edits);
            }
        }

        /// <summary>The values MaterialEditor holds as edits on an item's xukmi material.</summary>
        private static List<KeyValuePair<string, KeyValuePair<string, object>>> EditedValues(int id)
        {
            var list = new List<KeyValuePair<string, KeyValuePair<string, object>>>();
            try
            {
                var tg = Target(id);
                if (tg == null || !(MeImpl.Material(tg) is Dictionary<string, object> mat)) return list;
                foreach (var f in ((List<object>)mat["floats"]).OfType<Dictionary<string, object>>())
                    if (f["edited"] is bool e && e) list.Add(new KeyValuePair<string, KeyValuePair<string, object>>("float", new KeyValuePair<string, object>((string)f["name"], f["value"])));
                foreach (var c in ((List<object>)mat["colors"]).OfType<Dictionary<string, object>>())
                    if (c["edited"] is bool e && e) list.Add(new KeyValuePair<string, KeyValuePair<string, object>>("color", new KeyValuePair<string, object>((string)c["name"], c["value"])));
            }
            catch (Exception ex) { StudioBridgePlugin.Logger.LogDebug("xukmi values: " + ex.Message); }
            return list;
        }
    }
}
