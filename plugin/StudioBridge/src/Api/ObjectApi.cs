using System;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Object panel: transform for any object + item / light / folder / camera properties.
    /// Transform args accept per-axis nulls so multi-selection can change one axis without collapsing positions.
    /// </summary>
    internal static class ObjectApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("object.get", a => Get(Oci(a.GetInt("id"))));
            r.Add("object.set", Set);
        }

        private static ObjectCtrlInfo Oci(int id) => SceneApi.FindOci(id) ?? throw new BridgeException("Object not found");

        private static List<object> V(Vector3 v) => new List<object> { v.x, v.y, v.z };
        private static List<object> C(Color c) => new List<object> { c.r, c.g, c.b, c.a };

        private static Color ToColor(List<object> l, Color fallback)
        {
            if (l == null || l.Count < 3) return fallback;
            float a = l.Count > 3 && l[3] != null ? Convert.ToSingle(l[3]) : fallback.a;
            return new Color(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]), a);
        }

        /// <summary>Per-axis patch: [x|null, y|null, z|null].</summary>
        private static Vector3 Patch(Vector3 cur, List<object> l)
        {
            if (l == null) return cur;
            if (l.Count > 0 && l[0] != null) cur.x = Convert.ToSingle(l[0]);
            if (l.Count > 1 && l[1] != null) cur.y = Convert.ToSingle(l[1]);
            if (l.Count > 2 && l[2] != null) cur.z = Convert.ToSingle(l[2]);
            return cur;
        }

        public static object Get(ObjectCtrlInfo oci)
        {
            var go = oci.guideObject;
            var d = new Dictionary<string, object>
            {
                { "id", oci.objectInfo.dicKey },
                { "type", SceneApi.TypeName(oci) },
                { "name", SceneApi.DisplayName(oci) },
                { "visible", oci.treeNodeObject != null && oci.treeNodeObject.visible },
            };
            if (go != null)
                d["transform"] = new Dictionary<string, object>
                {
                    { "pos", V(go.changeAmount.pos) },
                    { "rot", V(go.changeAmount.rot) },
                    { "scale", V(go.changeAmount.scale) },
                    { "canPos", go.enablePos },
                    { "canRot", go.enableRot },
                    { "canScale", go.enableScale },
                };

            if (oci is OCIItem it)
            {
                var info = it.itemInfo;
                var use = it.useColor ?? new bool[0];
                var colors = new List<object>();
                for (int i = 0; i < info.color.Length && i < 4; i++)
                {
                    bool used = i < 3 ? (i < use.Length && use[i]) : it.useColor4;
                    colors.Add(new Dictionary<string, object> { { "index", i }, { "rgba", C(info.color[i]) }, { "used", used } });
                }
                d["item"] = new Dictionary<string, object>
                {
                    { "colors", colors },
                    { "alpha", info.alpha },
                    { "hasAlpha", it.checkAlpha },
                    { "emissionColor", C(info.emissionColor) },
                    { "emissionPower", info.emissionPower },
                    { "hasEmission", it.checkEmission },
                    { "fk", info.enableFK },
                    { "hasFk", it.isFK },
                    { "animeSpeed", info.animeSpeed },
                    { "hasAnime", it.isAnime },
                };
            }
            else if (oci is OCILight l)
            {
                var info = (OILightInfo)l.objectInfo;
                d["light"] = new Dictionary<string, object>
                {
                    { "kind", l.lightType.ToString() },
                    { "color", C(info.color) },
                    { "intensity", info.intensity },
                    { "range", info.range },
                    { "spotAngle", info.spotAngle },
                    { "shadow", info.shadow },
                    { "enable", info.enable },
                    { "hasRange", l.lightType != LightType.Directional },
                    { "hasSpot", l.lightType == LightType.Spot },
                };
            }
            else if (oci is OCIFolder f) d["folder"] = new Dictionary<string, object> { { "name", f.name } };
            else if (oci is OCICamera cam)
                d["camera"] = new Dictionary<string, object> { { "name", cam.name }, { "active", Singleton<Studio.Studio>.Instance.ociCamera == cam } };
            return d;
        }

        private static object Set(Dictionary<string, object> a)
        {
            var ids = a.GetList("ids");
            if (ids.Count == 0 && a.Has("id")) ids.Add(a["id"]);
            var targets = ids.Select(i => SceneApi.FindOci(Convert.ToInt32(i))).Where(o => o != null).ToList();
            if (targets.Count == 0) throw new BridgeException("Select an object first");
            string keys = string.Join(",", a.Keys.Where(k => k != "ids" && k != "id").OrderBy(k => k).ToArray());
            UndoStack.Push(ObjectUndo.Capture(targets, keys));
            foreach (var oci in targets) Apply(oci, a);
            return targets.Count == 1 ? Get(targets[0]) : (object)targets.Count;
        }

        private static void Apply(ObjectCtrlInfo oci, Dictionary<string, object> a)
        {
            var go = oci.guideObject;
            if (go != null)
            {
                if (a.Has("pos")) go.changeAmount.pos = Patch(go.changeAmount.pos, a.GetList("pos"));
                if (a.Has("rot")) go.changeAmount.rot = Patch(go.changeAmount.rot, a.GetList("rot"));
                if (a.Has("scale")) go.changeAmount.scale = Patch(go.changeAmount.scale, a.GetList("scale"));
            }
            if (a.Has("name"))
            {
                if (oci is OCIFolder f) f.name = a.GetString("name");
                else if (oci is OCICamera cam) cam.name = a.GetString("name");
            }

            var item = a.GetObject("item");
            if (item != null && oci is OCIItem it)
            {
                var col = item.GetObject("color");
                if (col != null)
                {
                    int i = col.GetInt("index");
                    if (i >= 0 && i < it.itemInfo.color.Length) it.SetColor(ToColor(col.GetList("rgba"), it.itemInfo.color[i]), i);
                }
                var colors = item.GetList("colors"); // full restore
                for (int i = 0; i < colors.Count && i < it.itemInfo.color.Length; i++)
                    it.SetColor(ToColor(colors[i] as List<object>, it.itemInfo.color[i]), i);
                if (item.Has("alpha")) it.SetAlpha(Mathf.Clamp01(item.GetFloat("alpha")));
                if (item.Has("emissionColor")) it.SetEmissionColor(ToColor(item.GetList("emissionColor"), it.itemInfo.emissionColor));
                if (item.Has("emissionPower")) it.SetEmissionPower(Mathf.Clamp01(item.GetFloat("emissionPower")));
                if (item.Has("fk") && it.isFK && it.itemInfo.enableFK != item.GetBool("fk")) it.ActiveFK(item.GetBool("fk"));
                if (item.Has("animeSpeed")) it.animeSpeed = Mathf.Clamp(item.GetFloat("animeSpeed"), 0f, 3f);
            }

            var light = a.GetObject("light");
            if (light != null && oci is OCILight l)
            {
                var info = (OILightInfo)l.objectInfo;
                if (light.Has("color")) l.SetColor(ToColor(light.GetList("color"), info.color));
                if (light.Has("intensity")) l.SetIntensity(Mathf.Clamp(light.GetFloat("intensity"), 0f, 10f));
                if (light.Has("range")) l.SetRange(Mathf.Clamp(light.GetFloat("range"), 0.1f, 1000f));
                if (light.Has("spotAngle")) l.SetSpotAngle(Mathf.Clamp(light.GetFloat("spotAngle"), 1f, 179f));
                if (light.Has("shadow")) l.SetShadow(light.GetBool("shadow"));
                if (light.Has("enable")) l.SetEnable(light.GetBool("enable"));
            }

            if (a.Has("cameraActive") && oci is OCICamera c2)
                Singleton<Studio.Studio>.Instance.ChangeCamera(c2, a.GetBool("cameraActive"));
        }

        /// <summary>Captures transform + type-specific state as a restore patch.</summary>
        private sealed class ObjectUndo : IUndoEntry
        {
            private readonly Dictionary<ObjectCtrlInfo, Dictionary<string, object>> _states;
            private readonly string _keys;
            public string Label => "Object change";

            private ObjectUndo(Dictionary<ObjectCtrlInfo, Dictionary<string, object>> states, string keys) { _states = states; _keys = keys; }

            public static ObjectUndo Capture(IEnumerable<ObjectCtrlInfo> ocis, string keys) => new ObjectUndo(ocis.ToDictionary(o => o, Snapshot), keys);

            public bool Absorbs(IUndoEntry newer) =>
                newer is ObjectUndo n && n._keys == _keys && n._states.Count == _states.Count && n._states.Keys.All(_states.ContainsKey);

            public IUndoEntry Restore()
            {
                var alive = _states.Keys.Where(o => Singleton<Studio.Studio>.Instance.dicObjectCtrl.ContainsValue(o)).ToList();
                var inverse = Capture(alive, _keys);
                // Restore only what this edit touched: undoing a light colour must not also snap the light
                // back to where it was (it may have been moved/animated since).
                var edited = new HashSet<string>(_keys.Split(','));
                foreach (var o in alive)
                    Apply(o, _states[o].Where(kv => edited.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value));
                return inverse;
            }

            private static Dictionary<string, object> Snapshot(ObjectCtrlInfo oci)
            {
                var d = new Dictionary<string, object>();
                if (oci.guideObject != null)
                {
                    d["pos"] = V(oci.guideObject.changeAmount.pos);
                    d["rot"] = V(oci.guideObject.changeAmount.rot);
                    d["scale"] = V(oci.guideObject.changeAmount.scale);
                }
                if (oci is OCIFolder f) d["name"] = f.name;
                if (oci is OCICamera cam) d["name"] = cam.name;
                if (oci is OCIItem it)
                    d["item"] = new Dictionary<string, object>
                    {
                        { "colors", it.itemInfo.color.Select(c => (object)C(c)).ToList() },
                        { "alpha", (double)it.itemInfo.alpha },
                        { "emissionColor", C(it.itemInfo.emissionColor) },
                        { "emissionPower", (double)it.itemInfo.emissionPower },
                        { "fk", it.itemInfo.enableFK },
                        { "animeSpeed", (double)it.itemInfo.animeSpeed },
                    };
                if (oci is OCILight l)
                {
                    var info = (OILightInfo)l.objectInfo;
                    d["light"] = new Dictionary<string, object>
                    {
                        { "color", C(info.color) },
                        { "intensity", (double)info.intensity },
                        { "range", (double)info.range },
                        { "spotAngle", (double)info.spotAngle },
                        { "shadow", info.shadow },
                        { "enable", info.enable },
                    };
                }
                return d;
            }
        }
    }
}
