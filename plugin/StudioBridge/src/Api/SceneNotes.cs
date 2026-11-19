using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using ExtensibleSaveFormat;
using KKAPI.Studio.SaveLoad;
using KKAPI.Utilities;
using Studio;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Small app settings saved with the scene, as JSON values under a key: one per scene, or one per object (a
    /// character's lip-sync voice, say). Per-object notes follow their object when a scene is loaded or imported and
    /// its ids change, and are dropped with it. The app owns what the values mean.
    /// </summary>
    internal static class SceneNotes
    {
        private static readonly Dictionary<string, object> Global = new Dictionary<string, object>();
        private static readonly Dictionary<string, Dictionary<int, object>> PerObject = new Dictionary<string, Dictionary<int, object>>();

        public static void Register(CommandRouter r)
        {
            // {key} → {value, objects: {id: value}}
            r.Add("notes.get", a =>
            {
                string key = a.GetString("key") ?? throw new BridgeException("Which note?");
                Prune();
                return new Dictionary<string, object>
                {
                    { "value", Global.TryGetValue(key, out var v) ? v : null },
                    { "objects", PerObject.TryGetValue(key, out var m) ? m.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value) : new Dictionary<string, object>() },
                };
            });
            // {key, value, id?} — a null value removes it
            r.Add("notes.set", a =>
            {
                string key = a.GetString("key") ?? throw new BridgeException("Which note?");
                object value = a.TryGetValue("value", out var v) ? v : null;
                if (a.Has("id"))
                {
                    int id = a.GetInt("id");
                    if (!PerObject.TryGetValue(key, out var m)) PerObject[key] = m = new Dictionary<int, object>();
                    if (value == null) m.Remove(id);
                    else m[id] = value;
                }
                else if (value == null) Global.Remove(key);
                else Global[key] = value;
                return true;
            });
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene notes won't be saved with scenes (KKAPI): " + e.Message); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<NotesSceneData>(StudioBridgePlugin.GUID + ".notes");

        /// <summary>Forget notes of objects that are gone.</summary>
        private static void Prune()
        {
            var alive = Singleton<Studio.Studio>.Instance?.dicObjectCtrl;
            if (alive == null) return;
            foreach (var m in PerObject.Values)
                foreach (var id in m.Keys.Where(id => !alive.ContainsKey(id)).ToList()) m.Remove(id);
        }

        private sealed class NotesSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                Prune();
                if (Global.Count == 0 && PerObject.All(kv => kv.Value.Count == 0)) { SetExtendedData(null); return; }
                var objects = PerObject.Where(kv => kv.Value.Count > 0).ToDictionary(kv => kv.Key, kv => (object)kv.Value.ToDictionary(x => x.Key.ToString(), x => x.Value));
                var json = Json.Serialize(new Dictionary<string, object> { { "global", Global }, { "objects", objects } });
                SetExtendedData(new PluginData { version = 1, data = new Dictionary<string, object> { { "json", json } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation != SceneOperationKind.Import)
                {
                    Global.Clear();
                    PerObject.Clear();
                }
                var d = GetExtendedData();
                if (operation != SceneOperationKind.Clear && d?.data != null && d.data.TryGetValue("json", out var j) && j is string json)
                {
                    try
                    {
                        var all = Json.Parse(json) as Dictionary<string, object>;
                        // an imported scene's own scene-wide notes don't replace this scene's
                        if (operation != SceneOperationKind.Import && all?.GetValueOrDefault("global") is Dictionary<string, object> g)
                            foreach (var kv in g) Global[kv.Key] = kv.Value;
                        if (all?.GetValueOrDefault("objects") is Dictionary<string, object> objs)
                            foreach (var kv in objs)
                            {
                                if (!(kv.Value is Dictionary<string, object> byId)) continue;
                                if (!PerObject.TryGetValue(kv.Key, out var m)) PerObject[kv.Key] = m = new Dictionary<int, object>();
                                foreach (var e in byId)
                                    // saved id → the object as loaded now (ids can change on load and always do on import)
                                    if (int.TryParse(e.Key, out var oldId) && loadedItems.TryGetValue(oldId, out var oci) && oci?.objectInfo != null)
                                        m[oci.objectInfo.dicKey] = e.Value;
                            }
                    }
                    catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene notes not read: " + e.Message); }
                }
                StudioBridgePlugin.Instance?.Broadcast("notes.changed", null);
            }
        }

        private static object GetValueOrDefault(this Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) ? v : null;
    }
}
