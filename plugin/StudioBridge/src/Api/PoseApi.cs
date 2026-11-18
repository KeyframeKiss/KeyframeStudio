using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Pose library on top of Studio's own pose files (UserData/studio/pose/*.dat, PauseCtrl),
    /// so poses saved here also show up in Studio's pose list and vice versa.
    /// Adds copy-between-characters and left/right mirroring of FK + IK.
    /// </summary>
    internal static class PoseApi
    {
        public static void Register(CommandRouter r)
        {
            r.Add("pose.list", a => List());
            r.Add("pose.save", Save);
            r.Add("pose.load", Load);
            r.Add("pose.copy", Copy);
            r.Add("pose.mirror", Mirror);
            r.Add("pose.setMeta", SetMeta);
            r.Add("pose.preview", Preview);
            r.Add("pose.previewEnd", a => { EndPreview(); return true; });
            r.Add("pose.fingerprint", a => Fingerprint(CharaApi.Chara(a.GetInt("id"))));
        }

        // ---------------- favorites / tags / last used ----------------
        // Kept in UserData/StudioEX/pose-meta.json (keyed by path relative to the pose folder), so Studio's
        // own pose files are never modified.

        private static Dictionary<string, object> _meta;
        private static string MetaFile => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/pose-meta.json"));

        private static Dictionary<string, object> UserMeta()
        {
            if (_meta != null) return _meta;
            try { _meta = File.Exists(MetaFile) ? Json.Parse(File.ReadAllText(MetaFile, System.Text.Encoding.UTF8)) as Dictionary<string, object> : null; }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("pose-meta.json unreadable: " + e.Message); }
            return _meta ?? (_meta = new Dictionary<string, object>());
        }

        private static void SaveUserMeta()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(MetaFile));
            File.WriteAllText(MetaFile, Json.Serialize(UserMeta()), new System.Text.UTF8Encoding(false));
        }

        private static string Rel(string f) => f.Substring(Folder.Length).TrimStart('\\', '/').Replace('\\', '/');

        private static Dictionary<string, object> MetaFor(string f, bool create)
        {
            var all = UserMeta();
            var key = Rel(f);
            if (all.TryGetValue(key, out var o) && o is Dictionary<string, object> d) return d;
            if (!create) return null;
            d = new Dictionary<string, object>();
            all[key] = d;
            return d;
        }

        /// <summary>args: {path, favorite?: bool, tags?: [..]}</summary>
        private static object SetMeta(Dictionary<string, object> a)
        {
            string path = a.GetString("path");
            if (string.IsNullOrEmpty(path) || !path.StartsWith(Folder, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                throw new BridgeException("Pose not found");
            var m = MetaFor(path, true);
            if (a.Has("favorite")) m["favorite"] = a.GetBool("favorite");
            if (a.Has("tags"))
                m["tags"] = a.GetList("tags").Select(o => (o as string ?? "").Trim()).Where(x => x.Length > 0)
                             .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).Cast<object>().ToList();
            SaveUserMeta();
            return true;
        }

        private static string Folder => Path.GetFullPath(UserData.Path + PauseCtrl.savePath);

        private struct PoseMeta
        {
            public DateTime Stamp;
            public string Name;
            public int Sex;
        }

        private static readonly Dictionary<string, PoseMeta> MetaCache = new Dictionary<string, PoseMeta>();

        /// <summary>
        /// Reads name/sex through PauseCtrl so pose-format mods (e.g. PNG poses with thumbnails, which
        /// patch PauseCtrl) keep working. Cached by write time: large libraries list instantly.
        /// </summary>
        private static bool TryMeta(string f, out PoseMeta meta)
        {
            var stamp = File.GetLastWriteTimeUtc(f);
            if (MetaCache.TryGetValue(f, out meta) && meta.Stamp == stamp) return meta.Name != null;
            meta = new PoseMeta { Stamp = stamp };
            try
            {
                string name = PauseCtrl.LoadName(f);
                if (!string.IsNullOrEmpty(name))
                {
                    meta.Name = name;
                    meta.Sex = PauseCtrl.CheckIdentifyingCode(f, 1) ? 1 : PauseCtrl.CheckIdentifyingCode(f, 0) ? 0 : -1;
                }
            }
            catch { meta.Name = null; }
            MetaCache[f] = meta;
            return meta.Name != null;
        }

        private static object List()
        {
            var list = new List<object>();
            if (!Directory.Exists(Folder)) return list;
            var files = Directory.GetFiles(Folder, "*.dat", SearchOption.AllDirectories)
                .Concat(Directory.GetFiles(Folder, "*.png", SearchOption.AllDirectories));
            foreach (var f in files)
            {
                if (!TryMeta(f, out var meta)) continue;
                string name = meta.Name;
                var d = new Dictionary<string, object>
                {
                    { "path", f },
                    { "name", name },
                    { "sex", meta.Sex },
                    { "png", f.EndsWith(".png", StringComparison.OrdinalIgnoreCase) },
                    { "folder", Path.GetDirectoryName(f).Substring(Folder.Length).TrimStart('\\', '/') },
                    { "modified", (meta.Stamp - new DateTime(1970, 1, 1)).TotalMilliseconds },
                };
                var tr = Translation.Get(name, false, "Pose");
                if (tr != null) d["nameEn"] = tr;
                var thumb = PoseThumbs.ThumbPath(f);
                if (File.Exists(thumb)) d["thumb"] = thumb;
                var um = MetaFor(f, false);
                if (um != null)
                {
                    if (um.GetBool("favorite")) d["favorite"] = true;
                    var tags = um.GetList("tags");
                    if (tags.Count > 0) d["tags"] = tags;
                    if (um.Has("lastUsed")) d["lastUsed"] = um.GetDouble("lastUsed");
                }
                list.Add(d);
            }
            return list;
        }

        // ---------------- undo + hover preview ----------------
        // A pose change is undone by re-applying a full pose snapshot (PauseCtrl.FileInfo: FK/IK, hands, look,
        // animation) taken before it. A hover preview applies the pose temporarily and keeps the original:
        // ending the preview puts it back, clicking (pose.load) keeps the pose and records the original for undo.

        private static readonly Dictionary<OCIChar, PauseCtrl.FileInfo> PreviewOrig = new Dictionary<OCIChar, PauseCtrl.FileInfo>();

        /// <summary>A hover preview is showing (change detection and auto-key wait until it ends).</summary>
        public static bool Previewing => PreviewOrig.Count > 0;

        private static bool Alive(OCIChar c) => c != null && c.charInfo != null && Singleton<Studio.Studio>.Instance.dicObjectCtrl.ContainsValue(c);

        private sealed class PoseUndo : IUndoEntry
        {
            private readonly List<KeyValuePair<OCIChar, PauseCtrl.FileInfo>> _before;
            public PoseUndo(List<KeyValuePair<OCIChar, PauseCtrl.FileInfo>> before, string label) { _before = before; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;

            public IUndoEntry Restore()
            {
                var live = _before.Where(kv => Alive(kv.Key)).ToList();
                var now = Capture(live.Select(kv => kv.Key));
                foreach (var kv in live) kv.Value.Apply(kv.Key);
                return new PoseUndo(now, Label);
            }
        }

        /// <summary>Pose snapshots of these characters as they are "really" (a preview's original, not the preview).</summary>
        private static List<KeyValuePair<OCIChar, PauseCtrl.FileInfo>> Capture(IEnumerable<OCIChar> cs) =>
            cs.Select(c => new KeyValuePair<OCIChar, PauseCtrl.FileInfo>(c, PreviewOrig.TryGetValue(c, out var o) ? o : new PauseCtrl.FileInfo(c))).ToList();

        /// <summary>Called before a pose command changes these characters: ends any preview, returns the undo entry.</summary>
        private static PoseUndo Begin(List<OCIChar> targets, string label)
        {
            var before = Capture(targets);
            foreach (var c in targets) PreviewOrig.Remove(c); // the command's result replaces the preview
            EndPreview();                                      // other characters still previewing go back
            return new PoseUndo(before, label);
        }

        /// <summary>args: {ids, path} — show the pose on the characters until previewEnd (or a pose command).</summary>
        private static object Preview(Dictionary<string, object> a)
        {
            string path = a.GetString("path");
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new BridgeException("Pose file not found");
            int n = 0;
            foreach (var c in Targets(a))
            {
                if (!PreviewOrig.ContainsKey(c)) PreviewOrig[c] = new PauseCtrl.FileInfo(c);
                if (PauseCtrl.Load(c, path)) n++;
            }
            return n;
        }

        public static void ForgetPreview() => PreviewOrig.Clear();

        /// <summary>Short digest of a character's FK rotations and IK targets (tests: "is this the same pose?").</summary>
        private static string Fingerprint(OCIChar c)
        {
            var sb = new System.Text.StringBuilder();
            foreach (var kv in c.oiCharInfo.bones.OrderBy(k => k.Key))
            {
                var r = kv.Value.changeAmount.rot;
                sb.Append(kv.Key).Append(':').Append(Mathf.RoundToInt(r.x)).Append(',').Append(Mathf.RoundToInt(r.y)).Append(',').Append(Mathf.RoundToInt(r.z)).Append(';');
            }
            foreach (var ik in c.listIKTarget)
            {
                if (ik?.targetInfo == null) continue;
                var p = ik.targetInfo.changeAmount.pos;
                sb.Append(Mathf.RoundToInt(p.x * 1000)).Append(',').Append(Mathf.RoundToInt(p.y * 1000)).Append(',').Append(Mathf.RoundToInt(p.z * 1000)).Append(';');
            }
            using (var md5 = System.Security.Cryptography.MD5.Create())
                return BitConverter.ToString(md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes(sb.ToString()))).Replace("-", "").Substring(0, 16);
        }

        /// <summary>Put every previewed character back in its own pose.</summary>
        public static void EndPreview()
        {
            if (PreviewOrig.Count == 0) return;
            foreach (var kv in PreviewOrig.ToList())
            {
                try { if (Alive(kv.Key)) kv.Value.Apply(kv.Key); }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Couldn't end pose preview: " + e.Message); }
            }
            PreviewOrig.Clear();
        }

        private static IEnumerable<OCIChar> Targets(Dictionary<string, object> a)
        {
            foreach (var id in a.GetList("ids"))
                if (SceneApi.FindOci(Convert.ToInt32(id)) is OCIChar c) yield return c;
        }

        private static object Save(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            string name = a.GetString("name");
            if (string.IsNullOrEmpty(name)) name = c.treeNodeObject.textName + " pose";
            // PauseCtrl builds the file path from the name: no path separators / ".." escapes.
            var bad = Path.GetInvalidFileNameChars();
            name = new string(name.Trim().Select(ch => Array.IndexOf(bad, ch) >= 0 ? '_' : ch).ToArray()).Trim('.', ' ');
            if (name.Length == 0) name = "Pose";
            PauseCtrl.Save(c, name);
            return List();
        }

        private static object Load(Dictionary<string, object> a)
        {
            string path = a.GetString("path");
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new BridgeException("Pose file not found");
            int n = 0;
            var targets = Targets(a).ToList();
            var undo = Begin(targets, "Load pose");
            foreach (var c in targets) if (PauseCtrl.Load(c, path)) n++;
            if (n == 0) throw new BridgeException("Select one or more characters first");
            UndoStack.Push(undo);
            if (path.StartsWith(Folder, StringComparison.OrdinalIgnoreCase))
            {
                try { MetaFor(path, true)["lastUsed"] = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; SaveUserMeta(); } catch { }
            }
            return n;
        }

        private static object Copy(Dictionary<string, object> a)
        {
            var src = CharaApi.Chara(a.GetInt("from"));
            var pose = new PauseCtrl.FileInfo(src);
            int n = 0;
            var targets = Targets(a).Where(c => c != src).ToList();
            var undo = Begin(targets, "Copy pose");
            foreach (var c in targets)
            {
                pose.Apply(c);
                n++;
            }
            if (n == 0) throw new BridgeException("Select the characters to copy the pose to");
            UndoStack.Push(undo);
            return n;
        }

        // ------------------------------------------------------------------
        // Mirror: swap left/right FK rotations and IK targets across the body's YZ plane.
        // Illusion rigs have mirrored local axes on L/R bones, so a mirrored local rotation
        // is (x, -y, -z) in euler space, and a mirrored local position is (-x, y, z).
        // ------------------------------------------------------------------

        private static string Counterpart(string name)
        {
            if (name.EndsWith("_L")) return name.Substring(0, name.Length - 2) + "_R";
            if (name.EndsWith("_R")) return name.Substring(0, name.Length - 2) + "_L";
            if (name.Contains("_L_")) return name.Replace("_L_", "_R_");
            if (name.Contains("_R_")) return name.Replace("_R_", "_L_");
            return null;
        }

        private static Vector3 MirrorRot(Vector3 e) => new Vector3(e.x, -e.y, -e.z);
        private static Vector3 MirrorPos(Vector3 p) => new Vector3(-p.x, p.y, p.z);

        private static object Mirror(Dictionary<string, object> a)
        {
            int n = 0;
            bool fk = a.GetBool("fk", true), ik = a.GetBool("ik", true);
            var targets = Targets(a).ToList();
            var undo = Begin(targets, "Mirror pose");
            foreach (var c in targets)
            {
                if (fk) MirrorFk(c);
                if (ik) MirrorIk(c);
                n++;
            }
            if (n == 0) throw new BridgeException("Select one or more characters first");
            UndoStack.Push(undo);
            return n;
        }

        private static void MirrorFk(OCIChar c)
        {
            var info = Info.Instance.dicBoneInfo;
            var byName = new Dictionary<string, OIBoneInfo>();
            foreach (var kv in c.oiCharInfo.bones)
                if (info.TryGetValue(kv.Key, out var bi) && !string.IsNullOrEmpty(bi.bone)) byName[bi.bone] = kv.Value;

            // Snapshot first so swapped pairs read the original values.
            var original = byName.ToDictionary(kv => kv.Key, kv => kv.Value.changeAmount.rot);
            foreach (var kv in byName)
            {
                string other = Counterpart(kv.Key);
                Vector3 src = other != null && original.TryGetValue(other, out var o) ? o : original[kv.Key];
                kv.Value.changeAmount.rot = MirrorRot(src);
            }
        }

        private static void MirrorIk(OCIChar c)
        {
            var byName = new Dictionary<string, OCIChar.IKInfo>();
            foreach (var ik in c.listIKTarget)
                if (ik?.targetObject != null) byName[ik.targetObject.name] = ik;
            var pos = byName.ToDictionary(kv => kv.Key, kv => kv.Value.targetInfo.changeAmount.pos);
            var rot = byName.ToDictionary(kv => kv.Key, kv => kv.Value.targetInfo.changeAmount.rot);
            foreach (var kv in byName)
            {
                string other = Counterpart(kv.Key);
                string src = other != null && pos.ContainsKey(other) ? other : kv.Key;
                kv.Value.targetInfo.changeAmount.pos = MirrorPos(pos[src]);
                kv.Value.targetInfo.changeAmount.rot = MirrorRot(rot[src]);
            }
        }
    }
}
