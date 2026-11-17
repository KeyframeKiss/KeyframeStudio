using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using BepInEx.Bootstrap;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>ABMX (bone modifier) editing. Safe to call when KKABMX is not installed.</summary>
    internal static class AbmxApi
    {
        private static bool? _available;

        public static bool Available
        {
            get
            {
                if (_available == null) _available = Chainloader.PluginInfos.ContainsKey("KKABMX.Core");
                return _available.Value;
            }
        }

        public static void Register(CommandRouter r)
        {
            r.Add("abmx.get", a => { Require(); return GetImpl(a.GetInt("id"), a.GetBool("all")); });
            r.Add("abmx.set", a => { Require(); return SetImpl(a); });
        }

        private static void Require()
        {
            if (!Available) throw new BridgeException("ABMX (KKABMX) is not installed");
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object GetImpl(int id, bool all) => AbmxImpl.Get(CharaApi.Chara(id), all);

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object SetImpl(Dictionary<string, object> a) => AbmxImpl.Set(CharaApi.Chara(a.GetInt("id")), a);
    }

    /// <summary>Snapshot of every modifier on a character; restoring swaps the whole set back.</summary>
    internal sealed class AbmxUndo : IUndoEntry
    {
        private readonly Studio.OCIChar _chara;
        private readonly KKABMX.Core.BoneController _ctrl;
        private readonly List<KKABMX.Core.BoneModifier> _mods;
        private readonly string _bone;
        private readonly bool _reset;

        public AbmxUndo(Studio.OCIChar chara, KKABMX.Core.BoneController ctrl, string bone, bool reset)
        {
            _chara = chara;
            _ctrl = ctrl;
            _bone = bone;
            _reset = reset;
            _mods = ctrl.GetAllModifiers().Select(m => m.Clone()).ToList();
        }

        public string Label => "Body slider " + _bone;

        public bool Absorbs(IUndoEntry newer) => newer is AbmxUndo n && n._ctrl == _ctrl && n._bone == _bone && !n._reset && !_reset;

        public IUndoEntry Restore()
        {
            if (_ctrl == null) throw new InvalidOperationException("character deleted");
            var inverse = new AbmxUndo(_chara, _ctrl, _bone, _reset);
            foreach (var m in _ctrl.GetAllModifiers().ToList())
            {
                m.Reset();
                _ctrl.RemoveModifier(m);
            }
            foreach (var m in _mods) _ctrl.AddModifier(m.Clone());
            _ctrl.NeedsFullRefresh = true;
            return inverse;
        }
    }

    internal static class AbmxImpl
    {
        private static KKABMX.Core.BoneController Controller(Studio.OCIChar c)
        {
            var ctrl = c.charInfo.GetComponent<KKABMX.Core.BoneController>();
            if (ctrl == null) throw new BridgeException("ABMX controller not found on this character");
            return ctrl;
        }

        private static List<object> V(Vector3 v) => new List<object> { v.x, v.y, v.z };

        private static Vector3 V(List<object> l, Vector3 fallback)
        {
            if (l == null || l.Count < 3) return fallback;
            return new Vector3(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]));
        }

        private static ChaFileDefine.CoordinateType Coord(Studio.OCIChar c) => (ChaFileDefine.CoordinateType)c.charInfo.fileStatus.coordinateType;

        public static object Get(Studio.OCIChar c, bool includeAllBones)
        {
            var ctrl = Controller(c);
            var coord = Coord(c);
            var mods = new List<object>();
            foreach (var m in ctrl.GetAllModifiers().OrderBy(m => m.BoneLocation).ThenBy(m => m.BoneName))
            {
                if (m.IsEmpty()) continue;
                var d = m.GetModifier(coord);
                mods.Add(new Dictionary<string, object>
                {
                    { "bone", m.BoneName },
                    { "location", (int)m.BoneLocation },
                    { "perCoordinate", m.IsCoordinateSpecific() },
                    { "scale", V(d.ScaleModifier) },
                    { "length", d.LengthModifier },
                    { "position", V(d.PositionModifier) },
                    { "rotation", V(d.RotationModifier) },
                });
            }
            var result = new Dictionary<string, object> { { "modifiers", mods } };
            if (includeAllBones) result["bones"] = ctrl.GetAllPossibleBoneNames().Distinct().OrderBy(n => n).Cast<object>().ToList();
            return result;
        }

        /// <summary>args: {id, bone, location?, scale?, length?, position?, rotation?, reset?}</summary>
        public static object Set(Studio.OCIChar c, Dictionary<string, object> a)
        {
            var ctrl = Controller(c);
            string bone = a.GetString("bone");
            if (string.IsNullOrEmpty(bone)) throw new BridgeException("Missing bone name");
            var location = (KKABMX.Core.BoneLocation)a.GetInt("location", (int)KKABMX.Core.BoneLocation.BodyTop);
            UndoStack.Push(new AbmxUndo(c, ctrl, bone, a.GetBool("reset")));
            if (a.GetBool("reset"))
            {
                var existing = ctrl.GetModifier(bone, location);
                if (existing != null)
                {
                    existing.Reset();
                    ctrl.RemoveModifier(existing);
                }
                ctrl.NeedsFullRefresh = true;
                return Get(c, false);
            }
            var mod = ctrl.GetOrAddModifier(bone, location);
            {
                var d = mod.GetModifier(Coord(c));
                if (a.Has("scale")) d.ScaleModifier = V(a.GetList("scale"), d.ScaleModifier);
                if (a.Has("length")) d.LengthModifier = a.GetFloat("length", 1f);
                if (a.Has("position")) d.PositionModifier = V(a.GetList("position"), d.PositionModifier);
                if (a.Has("rotation")) d.RotationModifier = V(a.GetList("rotation"), d.RotationModifier);
            }
            ctrl.NeedsFullRefresh = true;
            return Get(c, false);
        }
    }
}
