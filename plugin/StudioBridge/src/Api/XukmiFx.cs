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

        private sealed class AddUndo : IUndoEntry
        {
            private readonly OCIItem _oci;
            private readonly Entry _e;
            public AddUndo(OCIItem oci, Entry e) { _oci = oci; _e = e; }
            public string Label => "Add " + _e.Name;
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                if (_oci?.treeNodeObject != null) Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(_oci.treeNodeObject);
                return new RemoveUndo(_e);
            }
        }

        private sealed class RemoveUndo : IUndoEntry
        {
            private readonly Entry _e;
            public RemoveUndo(Entry e) { _e = e; }
            public string Label => "Add " + _e.Name;
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore() => new AddUndo(AddObjectItem.Add(_e.Group, _e.Category, _e.No), _e);
        }
    }
}
