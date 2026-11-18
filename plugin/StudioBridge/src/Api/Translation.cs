using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using BepInEx;
using BepInEx.Bootstrap;
using HarmonyLib;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Bridges XUnity.AutoTranslator:
    ///  - lookups for names we send to the app (cache hits instantly; optional async request for small sets);
    ///  - user overrides stored in Translation/en/Text/zz_StudioEX_Overrides.txt, which win over
    ///    machine translations and are hot-reloaded into the running game;
    ///  - a "seen" list so the app can show every Japanese string it has displayed.
    /// </summary>
    internal static class Translation
    {
        private static bool? _available;
        private static readonly Dictionary<string, string> Cache = new Dictionary<string, string>();
        private static readonly HashSet<string> Pending = new HashSet<string>();
        private static readonly Dictionary<string, string> Seen = new Dictionary<string, string>(); // text -> context
        private static Dictionary<string, string> _overrides;
        private static Dictionary<string, string> _machine;          // text -> translation (Keyframe Studio engines)
        private static Dictionary<string, string> _machineEngine;    // text -> engine id
        private static bool _injected;

        /// <summary>Set when an async translation arrives. Consumers reset it.</summary>
        public static volatile bool Changed;

        public static bool Available
        {
            get
            {
                if (_available == null)
                {
                    _available = false;
                    foreach (var p in Chainloader.PluginInfos.Values)
                        if (p.Metadata.GUID == "gravydevsupreme.xunity.autotranslator") { _available = true; break; }
                }
                return _available.Value;
            }
        }

        private static string TextDir => Path.Combine(Paths.BepInExRootPath, Path.Combine("Translation", Path.Combine("en", "Text")));
        private static string OverridesPath => Path.Combine(TextDir, "zz_StudioEX_Overrides.txt");
        // Machine translations made by Keyframe Studio's engines (Google batch, DeepL, local AI). Loaded by
        // AutoTranslator too; sorted before the overrides file so your own edits always win.
        private static string MachinePath => Path.Combine(TextDir, "zy_StudioEX_Machine.txt");

        public static void Register(CommandRouter r)
        {
            r.Add("translation.list", a => List(a.GetBool("onlyUntranslated")));
            r.Add("translation.set", a => { SetOverride(a.GetString("text"), a.GetString("value")); return true; });
            r.Add("translation.request", a => { foreach (var t in a.GetList("texts")) Get(t as string, true); return true; });
            r.Add("translation.setMachine", a => SetMachine(a.GetList("items"), a.GetString("engine")));
            r.Add("translation.clearMachine", a => ClearMachine(a.GetList("texts")));
        }

        /// <summary>
        /// Returns translated text, or null. With <paramref name="request"/>, a cache miss queues an online
        /// translation (use only for small sets — never for whole catalogs, to avoid hammering the endpoint).
        /// </summary>
        public static string Get(string text, bool request = false, string context = null)
        {
            if (string.IsNullOrEmpty(text) || !NeedsTranslation(text)) return null;
            lock (Seen) if (!Seen.ContainsKey(text) || context != null) Seen[text] = context ?? (Seen.TryGetValue(text, out var c) ? c : "");
            var ov = Overrides();
            if (ov.TryGetValue(text, out var o)) return o;
            if (Machine().TryGetValue(text, out var mt)) return mt;
            if (!Available) return null;
            EnsureInjected();
            lock (Cache)
                if (Cache.TryGetValue(text, out var cached)) return cached;
            try
            {
                var hit = Lookup(text, false);
                if (hit != null) return hit;
                // "01_おいで" / "[Mod] 名前" style names: translate the part after a numeric/bracket prefix.
                var m = PrefixRx.Match(text);
                if (m.Success && m.Groups[2].Length > 0)
                {
                    var rest = Get(m.Groups[2].Value, request, context);
                    if (rest != null)
                    {
                        var joined = m.Groups[1].Value + rest;
                        lock (Cache) Cache[text] = joined;
                        return joined;
                    }
                    return null; // the remainder was queued if requested
                }
                return request ? Lookup(text, true) : null;
            }
            catch (Exception) { _available = false; return null; }
        }

        private static readonly System.Text.RegularExpressions.Regex PrefixRx =
            new System.Text.RegularExpressions.Regex(@"^((?:\d+[_\-. ]+|\[[^\]]*\]\s*|【[^】]*】\s*)+)(.+)$");

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string Lookup(string text, bool request)
        {
            var t = XUnity.AutoTranslator.Plugin.Core.AutoTranslator.Default;
            if (t == null) return null;
            if (t.TryTranslate(text, out var translated) && translated != text)
            {
                lock (Cache) Cache[text] = translated;
                return translated;
            }
            if (!request) return null;
            lock (Pending)
                if (!Pending.Add(text)) return null;
            t.TranslateAsync(text, result =>
            {
                lock (Pending) Pending.Remove(text);
                if (result != null && result.Succeeded && !string.IsNullOrEmpty(result.TranslatedText))
                {
                    lock (Cache) Cache[text] = result.TranslatedText;
                    Changed = true;
                }
            });
            return null;
        }

        private static bool NeedsTranslation(string s)
        {
            foreach (char c in s)
                if (c >= 0x3000) return true; // CJK, kana, full-width punctuation
            return false;
        }

        // ---------------- overrides ----------------

        private static Dictionary<string, string> Overrides()
        {
            if (_overrides != null) return _overrides;
            _overrides = new Dictionary<string, string>();
            try
            {
                if (File.Exists(OverridesPath))
                    foreach (var line in File.ReadAllLines(OverridesPath, Encoding.UTF8))
                    {
                        if (line.Length == 0 || line.StartsWith("//")) continue;
                        int eq = FindSeparator(line);
                        if (eq <= 0) continue;
                        _overrides[Unescape(line.Substring(0, eq))] = Unescape(line.Substring(eq + 1));
                    }
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Could not read translation overrides: " + e.Message); }
            return _overrides;
        }

        private static int FindSeparator(string line)
        {
            for (int i = 0; i < line.Length; i++)
            {
                if (line[i] == '\\') { i++; continue; }
                if (line[i] == '=') return i;
            }
            return -1;
        }

        // AutoTranslator escaping: \= for '=', \n for newline, \\ for backslash.
        private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("=", "\\=").Replace("\r", "").Replace("\n", "\\n");

        private static string Unescape(string s)
        {
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    char n = s[++i];
                    sb.Append(n == 'n' ? '\n' : n);
                }
                else sb.Append(s[i]);
            }
            return sb.ToString();
        }

        public static void SetOverride(string text, string value)
        {
            if (string.IsNullOrEmpty(text)) throw new BridgeException("Missing source text");
            var ov = Overrides();
            if (string.IsNullOrEmpty(value)) ov.Remove(text);
            else ov[text] = value.Trim();

            var sb = new StringBuilder();
            sb.AppendLine("// Translation overrides written by Keyframe Studio. Format: original=translation");
            foreach (var kv in ov) sb.Append(Escape(kv.Key)).Append('=').AppendLine(Escape(kv.Value));
            Directory.CreateDirectory(Path.GetDirectoryName(OverridesPath));
            File.WriteAllText(OverridesPath, sb.ToString(), new UTF8Encoding(false));

            lock (Cache) Cache.Remove(text);
            Changed = true;
            CharaApi_InvalidateCatalog?.Invoke();
            if (Available) Reload(ov);
        }

        internal static Action CharaApi_InvalidateCatalog;

        /// <summary>Hot-reload AutoTranslator, then force our overrides on top regardless of file order.</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Reload(Dictionary<string, string> ov)
        {
            try
            {
                object plugin = XUnity.AutoTranslator.Plugin.Core.AutoTranslator.Default; // the AutoTranslationPlugin instance
                if (plugin == null) return;
                AccessTools.Method(plugin.GetType(), "ReloadTranslations")?.Invoke(plugin, null);
                var cache = AccessTools.Field(plugin.GetType(), "TextCache")?.GetValue(plugin);
                var add = cache != null ? AccessTools.Method(cache.GetType(), "AddTranslation", new[] { typeof(string), typeof(string), typeof(int) }) : null;
                if (add != null)
                    foreach (var kv in ov) add.Invoke(cache, new object[] { kv.Key, kv.Value, -1 });
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("AutoTranslator reload failed: " + e.Message); }
        }

        // ---------------- machine translations ----------------

        private static Dictionary<string, string> Machine()
        {
            if (_machine != null) return _machine;
            _machine = new Dictionary<string, string>();
            _machineEngine = new Dictionary<string, string>();
            try
            {
                if (File.Exists(MachinePath))
                {
                    string engine = "";
                    foreach (var line in File.ReadAllLines(MachinePath, Encoding.UTF8))
                    {
                        if (line.StartsWith("// engine:")) { engine = line.Substring(10).Trim(); continue; }
                        if (line.Length == 0 || line.StartsWith("//")) continue;
                        int eq = FindSeparator(line);
                        if (eq <= 0) continue;
                        var k = Unescape(line.Substring(0, eq));
                        _machine[k] = Unescape(line.Substring(eq + 1));
                        _machineEngine[k] = engine;
                    }
                }
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Could not read machine translations: " + e.Message); }
            return _machine;
        }

        private static void SaveMachine()
        {
            var byEngine = new SortedDictionary<string, List<KeyValuePair<string, string>>>();
            foreach (var kv in _machine)
            {
                string en;
                _machineEngine.TryGetValue(kv.Key, out en);
                en = en ?? "";
                List<KeyValuePair<string, string>> l;
                if (!byEngine.TryGetValue(en, out l)) byEngine[en] = l = new List<KeyValuePair<string, string>>();
                l.Add(kv);
            }
            var sb = new StringBuilder();
            sb.AppendLine("// Machine translations written by Keyframe Studio (Library > Translations). Format: original=translation");
            sb.AppendLine("// Your own corrections live in zz_StudioEX_Overrides.txt and take priority.");
            foreach (var g in byEngine)
            {
                sb.Append("// engine: ").AppendLine(g.Key);
                foreach (var kv in g.Value) sb.Append(Escape(kv.Key)).Append('=').AppendLine(Escape(kv.Value));
            }
            Directory.CreateDirectory(TextDir);
            File.WriteAllText(MachinePath, sb.ToString(), new UTF8Encoding(false));
        }

        private static object SetMachine(List<object> items, string engine)
        {
            var m = Machine();
            var fresh = new Dictionary<string, string>();
            foreach (var o in items)
            {
                var d = o as Dictionary<string, object>;
                if (d == null) continue;
                object t, v;
                var text = d.TryGetValue("text", out t) ? t as string : null;
                var value = d.TryGetValue("value", out v) ? (v as string) : null;
                if (value != null) value = value.Trim();
                if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(value) || value == text) continue;
                m[text] = value;
                _machineEngine[text] = engine ?? "";
                fresh[text] = value;
                lock (Cache) Cache.Remove(text);
            }
            if (fresh.Count == 0) return 0;
            SaveMachine();
            // Push into the running game as well (your overrides stay on top).
            var ov = Overrides();
            foreach (var k in new List<string>(fresh.Keys)) if (ov.ContainsKey(k)) fresh.Remove(k);
            if (Available && fresh.Count > 0) Inject(fresh);
            Changed = true;
            CharaApi_InvalidateCatalog?.Invoke();
            return fresh.Count;
        }

        private static object ClearMachine(List<object> texts)
        {
            var m = Machine();
            int n = 0;
            foreach (var o in texts)
            {
                var t = o as string;
                if (t != null && m.Remove(t)) { _machineEngine.Remove(t); lock (Cache) Cache.Remove(t); n++; }
            }
            if (n > 0) { SaveMachine(); Changed = true; CharaApi_InvalidateCatalog?.Invoke(); }
            return n;
        }

        /// <summary>Once per session: make AutoTranslator use our machine + override entries in the game UI too.</summary>
        private static void EnsureInjected()
        {
            if (_injected) return;
            _injected = true;
            var all = new Dictionary<string, string>(Machine());
            foreach (var kv in Overrides()) all[kv.Key] = kv.Value;
            if (all.Count > 0) Inject(all);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Inject(Dictionary<string, string> entries)
        {
            try
            {
                object plugin = XUnity.AutoTranslator.Plugin.Core.AutoTranslator.Default;
                var cache = plugin != null ? AccessTools.Field(plugin.GetType(), "TextCache")?.GetValue(plugin) : null;
                var add = cache != null ? AccessTools.Method(cache.GetType(), "AddTranslation", new[] { typeof(string), typeof(string), typeof(int) }) : null;
                if (add == null) return;
                foreach (var kv in entries) add.Invoke(cache, new object[] { kv.Key, kv.Value, -1 });
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("AutoTranslator inject failed: " + e.Message); }
        }

        private static object List(bool onlyUntranslated)
        {
            var ov = Overrides();
            var list = new List<object>();
            KeyValuePair<string, string>[] seen;
            lock (Seen) seen = new List<KeyValuePair<string, string>>(Seen).ToArray();
            var all = new Dictionary<string, string>();
            foreach (var kv in seen) all[kv.Key] = kv.Value;
            foreach (var kv in ov) if (!all.ContainsKey(kv.Key)) all[kv.Key] = "override";
            var m = Machine();
            foreach (var kv in m) if (!all.ContainsKey(kv.Key)) all[kv.Key] = "";
            foreach (var kv in all)
            {
                string current = null;
                bool isOverride = ov.TryGetValue(kv.Key, out current);
                string source = isOverride ? "mine" : null, engine = null;
                if (!isOverride)
                {
                    if (m.TryGetValue(kv.Key, out current)) { source = "machine"; _machineEngine.TryGetValue(kv.Key, out engine); }
                    else { current = Get(kv.Key); if (current != null) source = "game"; }
                }
                if (onlyUntranslated && current != null) continue;
                list.Add(new Dictionary<string, object>
                {
                    { "text", kv.Key },
                    { "translation", current },
                    { "override", isOverride },
                    { "source", source },
                    { "engine", engine },
                    { "context", kv.Value },
                });
            }
            return list;
        }
    }
}
