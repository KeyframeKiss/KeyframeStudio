using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using BepInEx.Bootstrap;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Which mods each Keyframe Studio feature hooks into, the versions it was tested with, and whether it works with
    /// what is installed. A feature whose mod is missing or changed in a way Keyframe Studio can't use is switched off
    /// on its own (its commands answer with the reason); everything else keeps working.
    ///
    /// "Works" is checked, not assumed from the version number: each feature probes the exact classes, fields and
    /// methods it reaches into. An untested version that still has them stays on (reported as "untested").
    /// </summary>
    internal static class Compat
    {
        internal sealed class Feature
        {
            public string Id, Label, ModName, Guid;
            public string[] Tested;            // versions verified with Keyframe Studio
            public Func<string> Probe;         // null = usable, otherwise why not
            public string[] Commands = new string[0];
            public string[] Prefixes = new string[0];
            // evaluated
            public string Status = "missing", Reason, Version;
        }

        private static List<Feature> _features;

        private static List<Feature> Features
        {
            get
            {
                if (_features == null) _features = Evaluate(Define());
                return _features;
            }
        }

        private static List<Feature> Define() => new List<Feature>
        {
            new Feature
            {
                Id = "timeline", Label = "Animation (dope sheet, graph, keys, auto-key, ghosts)",
                ModName = "Timeline", Guid = StudioBridgePlugin.TimelineGuid, Tested = new[] { "1.3.0" },
                Probe = TimelineApi.Probe, Prefixes = new[] { "timeline.", "motion." },
            },
            new Feature
            {
                Id = "faceParts", Label = "Face Studio: face parts and saved faces",
                ModName = "KKPE", Guid = "com.joan6694.kkplugins.kkpe", Tested = new[] { "2.17.0" },
                Probe = FaceApi.ProbeBones,
                Commands = new[] { "face.get", "face.set", "face.reset", "face.savePreset", "face.applyPreset" },
            },
            new Feature
            {
                Id = "faceShapes", Label = "Face Studio: shapes (blendshapes)",
                ModName = "KKPE", Guid = "com.joan6694.kkplugins.kkpe", Tested = new[] { "2.17.0" },
                Probe = FaceApi.ProbeShapes, Commands = new[] { "face.shapes", "face.setShape", "face.resetShapes" },
            },
            new Feature
            {
                Id = "abmx", Label = "Bone sliders (ABMX) in the Character panel",
                ModName = "KKABMX", Guid = "KKABMX.Core", Tested = new[] { "5.2" },
                Probe = () => JitProbe(typeof(AbmxApi)), Prefixes = new[] { "abmx." },
            },
            new Feature
            {
                Id = "materials", Label = "Look: material tweaks and material rules in presets",
                ModName = "Material Editor", Guid = "com.deathweasel.bepinex.materialeditor", Tested = new[] { "3.7.0" },
                Probe = () => JitProbe(typeof(MaterialLookApi)), Prefixes = new[] { "material." },
            },
            new Feature
            {
                Id = "twoLut", Label = "Look: second colour LUT",
                ModName = "KK_TwoLut", Guid = "com.deathweasel.bepinex.twolut", Tested = new string[0],
                Probe = LookApi.ProbeTwoLut,
            },
            new Feature
            {
                Id = "translator", Label = "English names (machine and manual translations)",
                ModName = "XUnity AutoTranslator", Guid = "gravydevsupreme.xunity.autotranslator", Tested = new string[0],
                Probe = () => null,
            },
        };

        private static List<Feature> Evaluate(List<Feature> list)
        {
            foreach (var f in list)
            {
                if (!Chainloader.PluginInfos.TryGetValue(f.Guid, out var info))
                {
                    f.Status = "missing";
                    f.Reason = f.ModName + " is not installed";
                    continue;
                }
                f.Version = info.Metadata.Version.ToString();
                string why;
                try { why = f.Probe(); }
                catch (Exception e) { why = e.GetType().Name + ": " + e.Message; }
                if (why != null)
                {
                    f.Status = "off";
                    f.Reason = f.ModName + " " + f.Version + " works differently from the version Keyframe Studio supports" +
                               (f.Tested.Length > 0 ? " (" + string.Join(", ", f.Tested) + ")" : "") + ": " + why;
                    StudioBridgePlugin.Logger.LogWarning("Feature off — " + f.Label + ". " + f.Reason);
                }
                else if (f.Tested.Length > 0 && !f.Tested.Any(v => VersionEquals(v, f.Version)))
                {
                    f.Status = "untested";
                    f.Reason = f.ModName + " " + f.Version + " hasn't been tested with Keyframe Studio (tested: " + string.Join(", ", f.Tested) +
                               "); it looks compatible, so the feature stays on";
                }
                else f.Status = "ok";
            }
            return list;
        }

        private static bool VersionEquals(string a, string b)
        {
            try { return new Version(a).Equals(new Version(b)); } catch { return a == b; }
        }

        /// <summary>Why this command can't run right now (its feature is off or its mod missing), or null.</summary>
        public static string BlockReason(string cmd)
        {
            foreach (var f in Features)
            {
                if (f.Status == "ok" || f.Status == "untested") continue;
                if (f.Commands.Contains(cmd) || f.Prefixes.Any(p => cmd.StartsWith(p)))
                    return f.Label + " is unavailable: " + f.Reason;
            }
            return null;
        }

        public static bool On(string id) => Features.Any(f => f.Id == id && (f.Status == "ok" || f.Status == "untested"));

        public static List<object> Report() => Features.Select(f => (object)new Dictionary<string, object>
        {
            { "id", f.Id },
            { "label", f.Label },
            { "mod", f.ModName },
            { "guid", f.Guid },
            { "version", f.Version },
            { "tested", f.Tested.ToList<object>() },
            { "status", f.Status },
            { "reason", f.Reason },
        }).ToList();

        /// <summary>
        /// For features compiled against a mod's API: compile every method of the class now. A method that calls
        /// something the installed mod no longer has fails here (missing method/type) instead of mid-edit.
        /// </summary>
        private static string JitProbe(Type t)
        {
            const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
            var types = new List<Type> { t };
            types.AddRange(t.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic));
            foreach (var nt in types)
            {
                if (nt.ContainsGenericParameters) continue;
                foreach (var m in nt.GetMethods(all).Cast<MethodBase>().Concat(nt.GetConstructors(all).Cast<MethodBase>()))
                {
                    if (m.IsAbstract || m.ContainsGenericParameters) continue;
                    try { RuntimeHelpers.PrepareMethod(m.MethodHandle); }
                    catch (Exception e) { return nt.Name + "." + m.Name + ": " + (e.InnerException ?? e).Message; }
                }
            }
            return null;
        }
    }
}
