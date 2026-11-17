using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Every installed plugin's BepInEx settings in one searchable place (replaces the in-game F1 window).
    /// Values travel as TOML strings so every setting type round-trips, including enums, colors and shortcuts.
    /// </summary>
    internal static class ConfigApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("config.list", a => List());
            r.Add("config.set", Set);
            r.Add("config.reset", a =>
            {
                var e = Find(a);
                e.BoxedValue = e.DefaultValue;
                return Describe(e);
            });
        }

        private static IEnumerable<KeyValuePair<PluginInfo, ConfigFile>> Configs()
        {
            foreach (var pi in Chainloader.PluginInfos.Values)
            {
                ConfigFile cfg = null;
                try { cfg = pi.Instance?.Config; } catch { }
                if (cfg != null && cfg.Count > 0) yield return new KeyValuePair<PluginInfo, ConfigFile>(pi, cfg);
            }
        }

        private static object List()
        {
            var plugins = new List<object>();
            foreach (var kv in Configs().OrderBy(k => k.Key.Metadata.Name, StringComparer.OrdinalIgnoreCase))
            {
                var entries = new List<object>();
                foreach (var e in kv.Value.Select(p => p.Value))
                {
                    try
                    {
                        var d = Describe(e);
                        if (d != null) entries.Add(d);
                    }
                    catch { }
                }
                if (entries.Count == 0) continue;
                plugins.Add(new Dictionary<string, object>
                {
                    { "guid", kv.Key.Metadata.GUID },
                    { "name", kv.Key.Metadata.Name },
                    { "version", kv.Key.Metadata.Version.ToString() },
                    { "entries", entries },
                });
            }
            return plugins;
        }

        private static Dictionary<string, object> Describe(ConfigEntryBase e)
        {
            var tags = e.Description?.Tags ?? new object[0];
            var cm = tags.FirstOrDefault(t => t != null && t.GetType().Name == "ConfigurationManagerAttributes");
            if (cm != null && Field<bool?>(cm, "Browsable") == false) return null;

            var type = e.SettingType;
            string kind = type == typeof(bool) ? "bool"
                : type.IsEnum ? (type.GetCustomAttributes(typeof(FlagsAttribute), false).Length > 0 ? "flags" : "enum")
                : type == typeof(int) || type == typeof(long) || type == typeof(short) || type == typeof(byte) ? "int"
                : type == typeof(float) || type == typeof(double) ? "float"
                : type == typeof(string) ? "string"
                : type == typeof(KeyboardShortcut) ? "shortcut"
                : type == typeof(UnityEngine.Color) ? "color"
                : "text";

            var d = new Dictionary<string, object>
            {
                { "section", e.Definition.Section },
                { "key", e.Definition.Key },
                { "kind", kind },
                { "type", type.Name },
                { "value", TomlTypeConverter.ConvertToString(e.BoxedValue, type) },
                { "default", e.DefaultValue != null ? TomlTypeConverter.ConvertToString(e.DefaultValue, type) : "" },
                { "description", e.Description?.Description ?? "" },
            };
            if (type.IsEnum) d["options"] = Enum.GetNames(type).Cast<object>().ToList();

            var acc = e.Description?.AcceptableValues;
            if (acc != null)
            {
                var at = acc.GetType();
                if (at.Name.StartsWith("AcceptableValueRange"))
                {
                    d["min"] = Convert.ToDouble(at.GetProperty("MinValue").GetValue(acc, null));
                    d["max"] = Convert.ToDouble(at.GetProperty("MaxValue").GetValue(acc, null));
                }
                else if (at.Name.StartsWith("AcceptableValueList"))
                {
                    var vals = at.GetProperty("AcceptableValues").GetValue(acc, null) as Array;
                    if (vals != null) d["options"] = vals.Cast<object>().Select(v => (object)TomlTypeConverter.ConvertToString(v, type)).ToList();
                }
            }
            if (cm != null)
            {
                var disp = Field<string>(cm, "DispName");
                if (!string.IsNullOrEmpty(disp)) d["label"] = disp;
                if (Field<bool?>(cm, "IsAdvanced") == true) d["advanced"] = true;
                if (Field<bool?>(cm, "ReadOnly") == true) d["readOnly"] = true;
                var order = Field<int?>(cm, "Order");
                if (order.HasValue) d["order"] = order.Value;
            }
            return d;
        }

        private static T Field<T>(object o, string name)
        {
            var f = o.GetType().GetField(name, BindingFlags.Public | BindingFlags.Instance);
            if (f == null) return default(T);
            var v = f.GetValue(o);
            return v is T t ? t : default(T);
        }

        private static ConfigEntryBase Find(Dictionary<string, object> a)
        {
            string guid = a.GetString("guid"), section = a.GetString("section"), key = a.GetString("key");
            foreach (var kv in Configs())
            {
                if (kv.Key.Metadata.GUID != guid) continue;
                foreach (var e in kv.Value.Select(p => p.Value))
                    if (e.Definition.Section == section && e.Definition.Key == key) return e;
            }
            throw new BridgeException("Setting not found");
        }

        private static object Set(Dictionary<string, object> a)
        {
            var e = Find(a);
            object value;
            try { value = TomlTypeConverter.ConvertToValue(a.GetString("value") ?? "", e.SettingType); }
            catch (Exception ex) { throw new BridgeException("Invalid value: " + ex.Message); }
            e.BoxedValue = value;
            return Describe(e);
        }
    }
}
