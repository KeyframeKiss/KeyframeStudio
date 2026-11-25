using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Character card library: the cards in UserData/chara (female/male, sub-folders included) with their names,
    /// to add to the scene or swap onto a selected character. Card PNGs are their own thumbnails. Names come from
    /// the card data, read in the background a few per frame (never freezing Studio) and cached by file date in
    /// UserData/StudioEX/card-names.json.
    /// </summary>
    internal sealed class CardLibrary : MonoBehaviour
    {
        private static CardLibrary _i;
        private static Dictionary<string, object> _cache;
        private static Coroutine _reader;
        private static string Root => Path.GetFullPath(Path.Combine(UserData.Path, "chara"));
        private static string CacheFile => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/card-names.json"));

        private void Awake() => _i = this;

        public static void Register(CommandRouter r)
        {
            r.Add("cards.list", a => List());
            r.Add("cards.add", Add);
            r.Add("cards.swap", Swap);
        }

        private static Dictionary<string, object> Cache()
        {
            if (_cache != null) return _cache;
            try { _cache = File.Exists(CacheFile) ? Json.Parse(File.ReadAllText(CacheFile, System.Text.Encoding.UTF8)) as Dictionary<string, object> : null; }
            catch { _cache = null; }
            return _cache ?? (_cache = new Dictionary<string, object>());
        }

        private static string Key(string path) => path.Substring(Root.Length).TrimStart('\\', '/').Replace('\\', '/') + "|" + File.GetLastWriteTimeUtc(path).Ticks;

        private static IEnumerable<KeyValuePair<string, int>> Files()
        {
            foreach (var kind in new[] { new KeyValuePair<string, int>("female", 1), new KeyValuePair<string, int>("male", 0) })
            {
                var dir = Path.Combine(Root, kind.Key);
                if (!Directory.Exists(dir)) continue;
                foreach (var f in Directory.GetFiles(dir, "*.png", SearchOption.AllDirectories)) yield return new KeyValuePair<string, int>(f, kind.Value);
            }
        }

        /// <summary>→ [{path, rel, sex, folder, modified, name?}] — names still unknown are read in the background
        /// and pushed as the "cards.names" event ({path: name}).</summary>
        private static object List()
        {
            var cache = Cache();
            var list = new List<object>();
            var missing = new List<KeyValuePair<string, int>>();
            foreach (var kv in Files())
            {
                string f = kv.Key, rel = f.Substring(Root.Length).TrimStart('\\', '/');
                var item = new Dictionary<string, object>
                {
                    { "path", f }, { "rel", rel }, { "sex", kv.Value },
                    { "folder", Path.GetDirectoryName(rel) ?? "" },
                    { "modified", (File.GetLastWriteTimeUtc(f) - new DateTime(1970, 1, 1)).TotalMilliseconds },
                };
                if (cache.TryGetValue(Key(f), out var n) && n is string name) item["name"] = name;
                else missing.Add(kv);
                list.Add(item);
            }
            if (missing.Count > 0 && _reader == null) _reader = _i.StartCoroutine(_i.ReadNames(missing));
            return list;
        }

        private IEnumerator ReadNames(List<KeyValuePair<string, int>> files)
        {
            var found = new Dictionary<string, object>();
            var sw = new System.Diagnostics.Stopwatch();
            try
            {
                foreach (var kv in files)
                {
                    sw.Reset();
                    sw.Start();
                    string name = null;
                    try
                    {
                        var cf = new ChaFileControl();
                        if (cf.LoadCharaFile(kv.Key, (byte)kv.Value, true, true)) name = cf.parameter.fullname;
                    }
                    catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("card " + kv.Key + ": " + e.Message); }
                    var key = Key(kv.Key);
                    Cache()[key] = name ?? "";
                    found[kv.Key] = name ?? "";
                    if (found.Count >= 40)
                    {
                        StudioBridgePlugin.Instance?.Broadcast("cards.names", found);
                        found = new Dictionary<string, object>();
                    }
                    yield return null; // one card per frame: Studio stays smooth
                }
            }
            finally
            {
                if (found.Count > 0) StudioBridgePlugin.Instance?.Broadcast("cards.names", found);
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(CacheFile));
                    File.WriteAllText(CacheFile, Json.Serialize(Cache()), new System.Text.UTF8Encoding(false));
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("card-names.json: " + e.Message); }
                _reader = null;
            }
        }

        private static string CheckedCard(Dictionary<string, object> a)
        {
            var p = Path.GetFullPath(a.GetString("path") ?? "");
            if (!Net.SafePaths.IsInside(p, Root) || !p.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || !File.Exists(p))
                throw new BridgeException("Character card not found");
            return p;
        }

        /// <summary>args: {path} → the new character's id. Undo removes it again.</summary>
        private static object Add(Dictionary<string, object> a)
        {
            var path = CheckedCard(a);
            bool male = path.Substring(Root.Length).TrimStart('\\', '/').StartsWith("male", StringComparison.OrdinalIgnoreCase);
            OCIChar c = male ? (OCIChar)AddObjectMale.Add(path) : AddObjectFemale.Add(path);
            Singleton<UndoRedoManager>.Instance.Clear(); // as Studio does after adding
            if (c == null) throw new BridgeException("Studio couldn't load that card");
            UndoStack.Push(new AddUndo(c, path, male));
            return c.objectInfo.dicKey;
        }

        private sealed class AddUndo : IUndoEntry
        {
            private readonly OCIChar _c;
            private readonly string _path;
            private readonly bool _male;
            public AddUndo(OCIChar c, string path, bool male) { _c = c; _path = path; _male = male; }
            public string Label => "Add character";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                if (_c.treeNodeObject != null) Singleton<Studio.Studio>.Instance.treeNodeCtrl.DeleteNode(_c.treeNodeObject);
                return new RedoAdd(_path, _male);
            }
        }

        private sealed class RedoAdd : IUndoEntry
        {
            private readonly string _path;
            private readonly bool _male;
            public RedoAdd(string path, bool male) { _path = path; _male = male; }
            public string Label => "Add character";
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                OCIChar c = _male ? (OCIChar)AddObjectMale.Add(_path) : AddObjectFemale.Add(_path);
                Singleton<UndoRedoManager>.Instance.Clear();
                return new AddUndo(c, _path, _male);
            }
        }

        /// <summary>args: {id, path} — the character takes on another card (pose and animation stay). Not undoable.</summary>
        private static object Swap(Dictionary<string, object> a)
        {
            var path = CheckedCard(a);
            var c = CharaApi.Chara(a.GetInt("id"));
            c.ChangeChara(path);
            // KK_FKIK only clears its "swapping" mark for a character with FK and IK both on; left set, it later turns
            // body FK off on whichever character next switches FK + IK (see ViewportGizmos.ClearStaleFkikSwap)
            if (!(c.oiCharInfo.enableFK && c.oiCharInfo.enableIK)) ViewportGizmos.ClearStaleFkikSwap();
            return true;
        }
    }
}
