using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Favorites, tags and "last used" for library items that are not Studio EX's own files: scenes,
    /// animation clips and looks. Kept in UserData/StudioEX/library-meta.json as
    /// { kind: { key: { favorite, tags, lastUsed } } }, so the game's files are never touched.
    /// Keys are chosen by the app (scene path relative to the scene folder, "group/category/no", look file).
    /// Poses keep their own pose-meta.json (older, same shape).
    /// </summary>
    internal static class LibraryMeta
    {
        private static readonly HashSet<string> Kinds = new HashSet<string> { "scenes", "animations", "looks" };
        private static Dictionary<string, object> _all;
        private static string FilePath => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/library-meta.json"));

        public static void Register(CommandRouter r)
        {
            r.Add("lib.meta", a => Of(Kind(a)));
            r.Add("lib.setMeta", Set);
        }

        private static string Kind(Dictionary<string, object> a)
        {
            var k = a.GetString("kind");
            if (k == null || !Kinds.Contains(k)) throw new BridgeException("Unknown library: " + k);
            return k;
        }

        private static Dictionary<string, object> All()
        {
            if (_all != null) return _all;
            try { _all = File.Exists(FilePath) ? Json.Parse(File.ReadAllText(FilePath, System.Text.Encoding.UTF8)) as Dictionary<string, object> : null; }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("library-meta.json unreadable: " + e.Message); }
            return _all ?? (_all = new Dictionary<string, object>());
        }

        private static Dictionary<string, object> Of(string kind)
        {
            var all = All();
            if (all.TryGetValue(kind, out var o) && o is Dictionary<string, object> d) return d;
            d = new Dictionary<string, object>();
            all[kind] = d;
            return d;
        }

        private static void Save()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, Json.Serialize(All()), new System.Text.UTF8Encoding(false));
            if (File.Exists(FilePath)) File.Delete(FilePath);
            File.Move(tmp, FilePath);
        }

        /// <summary>args: {kind, key, favorite?, tags?, used?: true, remove?: true} → the item's meta (null when it has none left).</summary>
        private static object Set(Dictionary<string, object> a)
        {
            var map = Of(Kind(a));
            var key = (a.GetString("key") ?? "").Trim();
            if (key.Length == 0 || key.Length > 400) throw new BridgeException("Missing item key");
            if (!(map.TryGetValue(key, out var o) && o is Dictionary<string, object> m)) m = new Dictionary<string, object>();
            if (a.GetBool("remove")) m.Clear(); // forget the item entirely (also its last use)
            if (a.Has("favorite"))
            {
                if (a.GetBool("favorite")) m["favorite"] = true;
                else m.Remove("favorite");
            }
            if (a.Has("tags"))
            {
                var tags = a.GetList("tags").Select(x => (x as string ?? "").Trim()).Where(x => x.Length > 0 && x.Length <= 40)
                            .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).Cast<object>().ToList();
                if (tags.Count > 0) m["tags"] = tags;
                else m.Remove("tags");
            }
            if (a.GetBool("used")) m["lastUsed"] = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            if (m.Count == 0) map.Remove(key);
            else map[key] = m;
            Save();
            return m.Count == 0 ? null : m;
        }
    }
}
