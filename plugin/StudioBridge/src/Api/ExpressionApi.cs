using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Saved expressions (Face Studio): named sets of expression values (eyebrow/eye/mouth patterns,
    /// eyes/mouth open, blink, eye/neck direction, tears, blush, ...) with a face close-up thumbnail.
    /// Files: UserData/StudioEX/expressions/&lt;name&gt;.json (+ .jpg). Applying is done through chara.set,
    /// so it has the character panel's undo; this class only stores and lists.
    /// </summary>
    internal static class ExpressionApi
    {
        private static readonly string[] Keys =
            { "eyebrowPtn", "eyesPtn", "mouthPtn", "eyesOpen", "mouthOpen", "blink", "lipSync", "eyesLook", "neckLook", "tears", "blush" };

        private static string Folder
        {
            get
            {
                var dir = Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/expressions"));
                Directory.CreateDirectory(dir);
                return dir;
            }
        }

        public static void Register(CommandRouter r)
        {
            r.Add("expr.presets", a => List());
            r.Add("expr.savePreset", a => Save(a));
            r.Add("expr.updatePreset", a => Update(a));
            r.Add("expr.deletePreset", a => Delete(a));
        }

        private static double NowMs() => (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;

        private static string SafeFile(string name)
        {
            var bad = Path.GetInvalidFileNameChars();
            var s = new string((name ?? "").Trim().Select(ch => Array.IndexOf(bad, ch) >= 0 ? '_' : ch).ToArray()).Trim('.', ' ');
            return s.Length == 0 ? "Expression" : s;
        }

        private static Dictionary<string, object> Read(string path) => Json.Parse(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
        private static void Write(string path, Dictionary<string, object> d) => File.WriteAllText(path, Json.Serialize(d), new UTF8Encoding(false));
        private static string PathOf(string file) => Path.Combine(Folder, SafeFile(file) + ".json");

        private static object List()
        {
            var list = new List<object>();
            foreach (var f in Directory.GetFiles(Folder, "*.json").OrderBy(f => f))
            {
                try
                {
                    var d = Read(f);
                    var values = d?.GetObject("values");
                    if (values == null) continue;
                    var item = new Dictionary<string, object>
                    {
                        { "file", Path.GetFileNameWithoutExtension(f) },
                        { "name", d.GetString("name") ?? Path.GetFileNameWithoutExtension(f) },
                        { "values", values },
                        { "tags", d.GetList("tags").Where(x => x is string).ToList() },
                        { "favorite", d.GetBool("favorite") },
                        { "from", d.GetString("from") ?? "" },
                        { "created", d.Has("created") ? d.GetDouble("created") : (File.GetCreationTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                        { "lastUsed", d.GetDouble("lastUsed") },
                        { "modified", (File.GetLastWriteTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                    };
                    var jpg = Path.ChangeExtension(f, ".jpg");
                    if (File.Exists(jpg)) item["thumb"] = "data:image/jpeg;base64," + Convert.ToBase64String(File.ReadAllBytes(jpg));
                    list.Add(item);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Bad saved expression " + f + ": " + e.Message); }
            }
            return list;
        }

        /// <summary>args: {id: character (for the thumbnail and name), name, values: {..expression fields..}}</summary>
        private static object Save(Dictionary<string, object> a)
        {
            string name = (a.GetString("name") ?? "").Trim();
            if (name.Length == 0) throw new BridgeException("Give the expression a name");
            var src = a.GetObject("values") ?? new Dictionary<string, object>();
            var values = new Dictionary<string, object>();
            foreach (var k in Keys) if (src.ContainsKey(k)) values[k] = src[k];
            if (values.Count == 0) throw new BridgeException("Nothing to save");
            string path = PathOf(name);
            var old = File.Exists(path) ? Read(path) : null;
            var c = CharaApi.Chara(a.GetInt("id"));
            var d = new Dictionary<string, object>
            {
                { "version", 1 },
                { "name", name },
                { "from", c.treeNodeObject != null ? c.treeNodeObject.textName : "" },
                { "created", old != null && old.Has("created") ? old.GetDouble("created") : NowMs() },
                { "tags", old != null ? old.GetList("tags") : new List<object>() },
                { "favorite", old != null && old.GetBool("favorite") },
                { "values", values },
            };
            Write(path, d);
            try
            {
                var thumb = FaceApi.ViewPublic(a.GetInt("id"), 256);
                if (thumb != null) File.WriteAllBytes(Path.ChangeExtension(path, ".jpg"), Convert.FromBase64String(thumb.Substring(thumb.IndexOf(',') + 1)));
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Saved expression thumbnail failed: " + e.Message); }
            return List();
        }

        /// <summary>args: {file, name?: rename, tags?, favorite?, used?: true (stamps lastUsed)}</summary>
        private static object Update(Dictionary<string, object> a)
        {
            string path = PathOf(a.GetString("file"));
            if (!File.Exists(path)) throw new BridgeException("Saved expression not found");
            var d = Read(path);
            if (a.Has("tags"))
                d["tags"] = a.GetList("tags").Select(o => (o as string ?? "").Trim()).Where(x => x.Length > 0)
                             .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).Cast<object>().ToList();
            if (a.Has("favorite")) d["favorite"] = a.GetBool("favorite");
            if (a.GetBool("used")) d["lastUsed"] = NowMs();
            if (a.Has("name"))
            {
                string name = (a.GetString("name") ?? "").Trim();
                if (name.Length == 0) throw new BridgeException("Give the expression a name");
                string to = PathOf(name);
                if (!string.Equals(to, path, StringComparison.OrdinalIgnoreCase))
                {
                    if (File.Exists(to)) throw new BridgeException("A saved expression called “" + name + "” already exists");
                    File.Move(path, to);
                    var jpg = Path.ChangeExtension(path, ".jpg");
                    if (File.Exists(jpg)) File.Move(jpg, Path.ChangeExtension(to, ".jpg"));
                    path = to;
                }
                d["name"] = name;
            }
            Write(path, d);
            return a.GetBool("used") && a.Count <= 2 ? (object)true : List();
        }

        private static object Delete(Dictionary<string, object> a)
        {
            var files = a.GetList("files").Select(o => o as string).Where(f => f != null).ToList();
            if (a.Has("file")) files.Add(a.GetString("file"));
            foreach (var f in files)
            {
                string path = PathOf(f);
                if (!File.Exists(path)) continue;
                File.Delete(path);
                var jpg = Path.ChangeExtension(path, ".jpg");
                if (File.Exists(jpg)) File.Delete(jpg);
            }
            return List();
        }
    }
}
