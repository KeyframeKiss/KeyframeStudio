using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Small named presets whose content only the app understands (e.g. saved outfits): one JSON file each in
    /// UserData/StudioEX/&lt;kind&gt;/, with favorite, tags and last use. Kinds are a fixed list.
    /// </summary>
    internal static class PresetStore
    {
        private static readonly HashSet<string> Kinds = new HashSet<string> { "outfits", "templates", "easings" };

        public static void Register(CommandRouter r)
        {
            r.Add("store.list", a => List(Kind(a)));
            r.Add("store.save", Save);
            r.Add("store.update", Update);
            r.Add("store.delete", Delete);
        }

        private static string Kind(Dictionary<string, object> a)
        {
            var k = a.GetString("kind");
            if (k == null || !Kinds.Contains(k)) throw new BridgeException("Unknown preset kind: " + k);
            return k;
        }

        private static string Dir(string kind) => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/" + kind));

        private static string FileFor(string kind, string name)
        {
            var bad = Path.GetInvalidFileNameChars();
            var s = new string((name ?? "").Trim().Select(ch => Array.IndexOf(bad, ch) >= 0 ? '_' : ch).ToArray()).Trim('.', ' ');
            if (s.Length == 0) throw new BridgeException("Give it a name");
            return Path.Combine(Dir(kind), s + ".json");
        }

        private static double Now() => (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

        private static List<object> List(string kind)
        {
            var list = new List<object>();
            if (!Directory.Exists(Dir(kind))) return list;
            foreach (var f in Directory.GetFiles(Dir(kind), "*.json").OrderBy(x => x))
            {
                try
                {
                    var d = Json.Parse(File.ReadAllText(f, System.Text.Encoding.UTF8)) as Dictionary<string, object>;
                    if (d == null) continue;
                    d["file"] = Path.GetFileNameWithoutExtension(f);
                    list.Add(d);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Bad preset " + f + ": " + e.Message); }
            }
            return list;
        }

        /// <summary>args: {kind, name, data, note?} — overwriting keeps favorite, tags and created.</summary>
        private static object Save(Dictionary<string, object> a)
        {
            string kind = Kind(a), name = (a.GetString("name") ?? "").Trim();
            var path = FileFor(kind, name);
            Directory.CreateDirectory(Dir(kind));
            Dictionary<string, object> old = null;
            try { if (File.Exists(path)) old = Json.Parse(File.ReadAllText(path, System.Text.Encoding.UTF8)) as Dictionary<string, object>; } catch { }
            var d = new Dictionary<string, object>
            {
                { "name", name },
                { "note", a.GetString("note") ?? "" },
                { "created", old != null && old.Has("created") ? old.GetDouble("created") : Now() },
                { "favorite", old != null && old.GetBool("favorite") },
                { "tags", old?.GetList("tags") ?? new List<object>() },
                { "data", a.GetObject("data") ?? new Dictionary<string, object>() },
            };
            File.WriteAllText(path, Json.Serialize(d), new System.Text.UTF8Encoding(false));
            return List(kind);
        }

        /// <summary>args: {kind, file, favorite?, tags?, used?: true}</summary>
        private static object Update(Dictionary<string, object> a)
        {
            string kind = Kind(a);
            var path = FileFor(kind, a.GetString("file"));
            if (!File.Exists(path)) throw new BridgeException("Preset not found");
            var d = Json.Parse(File.ReadAllText(path, System.Text.Encoding.UTF8)) as Dictionary<string, object>;
            if (a.Has("favorite")) d["favorite"] = a.GetBool("favorite");
            if (a.Has("tags")) d["tags"] = a.GetList("tags").Select(x => (x as string ?? "").Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).Take(20).Cast<object>().ToList();
            if (a.GetBool("used")) d["lastUsed"] = Now();
            File.WriteAllText(path, Json.Serialize(d), new System.Text.UTF8Encoding(false));
            return List(kind);
        }

        private static object Delete(Dictionary<string, object> a)
        {
            string kind = Kind(a);
            var path = FileFor(kind, a.GetString("file"));
            if (File.Exists(path)) File.Delete(path);
            return List(kind);
        }
    }
}
