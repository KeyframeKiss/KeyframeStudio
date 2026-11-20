using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Every item Studio can add (its own and every mod's), with a preview picture of each. Pictures are made on
    /// demand: the item's model is loaded on its own (never added to the scene), lit and rendered by a hidden camera
    /// on a layer Studio's camera doesn't draw, then unloaded again. They're cached as
    /// UserData/StudioEX/item-thumbs/&lt;key&gt;.jpg, so each item is rendered once. Work pauses while the timeline
    /// plays or a render runs.
    /// </summary>
    internal sealed class ItemLibrary : MonoBehaviour
    {
        private static ItemLibrary _i;

        private sealed class Entry
        {
            public int G, C, N;
            public string Name, Group, Category, Bundle, File, Manifest, Key;
        }

        private static List<Entry> _catalog;
        private static Dictionary<string, Entry> _byKey;
        private static readonly LinkedList<string> Queue = new LinkedList<string>();
        private static readonly HashSet<string> Queued = new HashSet<string>();
        private static int _made, _failed;

        private Camera _cam;
        private Light _light;
        private RenderTexture _rt;
        private Texture2D _tex;
        private const int Size = 192;

        /// <summary>Bump when pictures are made differently: the old ones are cleared once and made again.</summary>
        private const string PictureVersion = "2"; // 2: from the front (1 showed the back)
        private static bool _checked;

        private static string Folder
        {
            get
            {
                var dir = Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/item-thumbs"));
                Directory.CreateDirectory(dir);
                if (!_checked)
                {
                    _checked = true;
                    var mark = Path.Combine(dir, "version.txt");
                    if (!File.Exists(mark) || File.ReadAllText(mark).Trim() != PictureVersion)
                    {
                        // only this cache's own files: pictures and "nothing to picture" marks
                        foreach (var f in Directory.GetFiles(dir, "*.jpg").Concat(Directory.GetFiles(dir, "*.none")))
                            try { File.Delete(f); } catch { /* in use: made again later anyway */ }
                        File.WriteAllText(mark, PictureVersion);
                    }
                }
                return dir;
            }
        }

        private static string ThumbPath(Entry e) => Path.Combine(Folder, e.Key + ".jpg");
        /// <summary>An item whose picture couldn't be made: remembered so it isn't tried again every time.</summary>
        private static string FailPath(Entry e) => Path.Combine(Folder, e.Key + ".none");

        private void Awake() => _i = this;

        public static void Register(CommandRouter r)
        {
            r.Add("items.catalog", a => Catalog());
            // {keys: [...]} — make these pictures next (the ones on screen)
            r.Add("items.thumbs", a =>
            {
                Load();
                foreach (var k in a.GetList("keys").OfType<string>().Reverse())
                {
                    if (!_byKey.TryGetValue(k, out var e) || File.Exists(ThumbPath(e)) || File.Exists(FailPath(e))) continue;
                    if (Queued.Contains(k)) Queue.Remove(k);
                    else Queued.Add(k);
                    Queue.AddFirst(k);
                }
                return Status();
            });
            // every item still without a picture (optionally one group / category)
            r.Add("items.thumbsAll", a =>
            {
                Load();
                int g = a.GetInt("group", -1), c = a.GetInt("category", -1);
                foreach (var e in _catalog)
                {
                    if ((g >= 0 && e.G != g) || (c >= 0 && e.C != c)) continue;
                    if (Queued.Contains(e.Key) || File.Exists(ThumbPath(e)) || File.Exists(FailPath(e))) continue;
                    Queued.Add(e.Key);
                    Queue.AddLast(e.Key);
                }
                return Status();
            });
            // {keys: [...]} → {key: English name} for the items on screen (looked up properly, a few at a time)
            r.Add("items.names", a =>
            {
                Load();
                var outNames = new Dictionary<string, object>();
                foreach (var k in a.GetList("keys").OfType<string>().Take(400))
                    if (_byKey.TryGetValue(k, out var e))
                    {
                        var t = Translation.Get(e.Name, false, "Item");
                        if (t != null) outNames[k] = t;
                    }
                return outNames;
            });
            r.Add("items.thumbsCancel", a =>
            {
                Queue.Clear();
                Queued.Clear();
                return Status();
            });
            r.Add("items.thumbsStatus", a => Status());
            // add an item to the scene (Studio's own add), selected
            r.Add("items.add", a =>
            {
                var oci = AddObjectItem.Add(a.GetInt("group"), a.GetInt("category"), a.GetInt("no")) ?? throw new BridgeException("Studio couldn't add that item");
                try { Singleton<Studio.Studio>.Instance.treeNodeCtrl.SelectSingle(oci.treeNodeObject, false); }
                catch { /* selection is a nicety */ }
                EventPump.RequestRebase();
                return oci.objectInfo.dicKey;
            });
        }

        private static object Status() => new Dictionary<string, object> { { "queued", Queue.Count }, { "made", _made }, { "failed", _failed } };

        private static void Load()
        {
            if (_catalog != null) return;
            var info = Singleton<Info>.Instance;
            var list = new List<Entry>();
            if (info == null) throw new BridgeException("Studio hasn't read its item lists yet");
            using (var md5 = MD5.Create())
                foreach (var g in info.dicItemLoadInfo)
                {
                    info.dicItemGroupCategory.TryGetValue(g.Key, out var gi);
                    foreach (var c in g.Value)
                    {
                        string cat = gi != null && gi.dicCategory.TryGetValue(c.Key, out var cn) ? cn : "";
                        foreach (var it in c.Value)
                        {
                            var v = it.Value;
                            if (v == null) continue;
                            var h = md5.ComputeHash(Encoding.UTF8.GetBytes((v.bundlePath + "|" + v.fileName + "|" + v.manifest + "|" + g.Key + "/" + c.Key + "/" + it.Key).ToLowerInvariant()));
                            var sb = new StringBuilder(32);
                            foreach (var b in h) sb.Append(b.ToString("x2"));
                            list.Add(new Entry { G = g.Key, C = c.Key, N = it.Key, Name = v.name ?? "", Group = gi?.name ?? "", Category = cat, Bundle = v.bundlePath, File = v.fileName, Manifest = v.manifest, Key = sb.ToString() });
                        }
                    }
                }
            if (list.Count == 0) throw new BridgeException("Studio hasn't read its item lists yet");
            _catalog = list;
            _byKey = list.GroupBy(e => e.Key).ToDictionary(x => x.Key, x => x.First());
        }

        private static object Catalog()
        {
            Load();
            // one directory listing, not a file check per item
            var have = new HashSet<string>(Directory.GetFiles(Folder).Select(Path.GetFileName), StringComparer.OrdinalIgnoreCase);
            // item names: only translations already known (looking up 40,000 names would freeze Studio for seconds);
            // the ones on screen are looked up with items.names. Group and category names are few: looked up now.
            var trCache = new Dictionary<string, string>();
            string Tr(string s, string ctx)
            {
                if (string.IsNullOrEmpty(s)) return null;
                if (!trCache.TryGetValue(s, out var t)) trCache[s] = t = Translation.Get(s, false, ctx);
                return t;
            }
            string Known(string s) => Translation.Peek(s);
            return new Dictionary<string, object>
            {
                { "folder", Folder },
                {
                    "items", _catalog.Select(e => (object)new Dictionary<string, object>
                    {
                        { "g", e.G }, { "c", e.C }, { "n", e.N }, { "key", e.Key },
                        { "name", e.Name }, { "nameEn", Known(e.Name) },
                        { "group", e.Group }, { "groupEn", Tr(e.Group, "Item group") },
                        { "category", e.Category }, { "categoryEn", Tr(e.Category, "Item category") },
                        { "thumb", have.Contains(e.Key + ".jpg") ? 1 : have.Contains(e.Key + ".none") ? -1 : 0 },
                    }).ToList()
                },
            };
        }

        // ---------------- making pictures ----------------

        private int _layer = -1;

        private void Update()
        {
            if (Queue.Count == 0) return;
            // never while something is being recorded or played
            if (Time.captureFramerate > 0 || TimelineApi.Playing() || PoseThumbs.Running) return;
            var start = Time.realtimeSinceStartup;
            // a few per frame, within ~40 ms, so Studio stays usable
            while (Queue.Count > 0 && Time.realtimeSinceStartup - start < 0.04f)
            {
                var key = Queue.First.Value;
                Queue.RemoveFirst();
                Queued.Remove(key);
                if (!_byKey.TryGetValue(key, out var e)) continue;
                bool ok = false;
                try { ok = MakeThumb(e); }
                catch (Exception ex) { StudioBridgePlugin.Logger.LogDebug("item picture " + e.Name + ": " + ex.Message); }
                if (ok) _made++;
                else
                {
                    _failed++;
                    try { File.WriteAllText(FailPath(e), ""); } catch { /* cache only */ }
                }
                StudioBridgePlugin.Instance?.Broadcast("items.thumb", new Dictionary<string, object> { { "key", key }, { "ok", ok }, { "queued", Queue.Count } });
                if ((_made + _failed) % 60 == 0) Resources.UnloadUnusedAssets();
            }
        }

        /// <summary>A layer Studio's camera doesn't draw, so the item is only seen by our camera.</summary>
        private int Layer()
        {
            if (_layer >= 0) return _layer;
            int mask = Camera.main != null ? Camera.main.cullingMask : ~0;
            for (int l = 31; l >= 8; l--)
                if ((mask & (1 << l)) == 0) return _layer = l;
            return _layer = 31;
        }

        private void Ensure()
        {
            if (_cam != null) return;
            var go = new GameObject("KF item thumbs") { hideFlags = HideFlags.HideAndDontSave };
            go.transform.position = new Vector3(0, -3000, 0);
            _cam = go.AddComponent<Camera>();
            _cam.enabled = false;
            _cam.clearFlags = CameraClearFlags.SolidColor;
            _cam.backgroundColor = new Color(0.17f, 0.18f, 0.21f, 1f);
            _cam.cullingMask = 1 << Layer();
            _cam.allowHDR = false;
            var lightGo = new GameObject("KF item thumbs light") { hideFlags = HideFlags.HideAndDontSave };
            _light = lightGo.AddComponent<Light>();
            _light.type = LightType.Directional;
            _light.intensity = 1.1f;
            _light.cullingMask = 1 << Layer();
            _light.shadows = LightShadows.None;
            _light.enabled = false;
            _rt = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 4 };
            _tex = new Texture2D(Size, Size, TextureFormat.RGB24, false);
        }

        private static void SetLayer(Transform t, int layer)
        {
            t.gameObject.layer = layer;
            for (int i = 0; i < t.childCount; i++) SetLayer(t.GetChild(i), layer);
        }

        private bool MakeThumb(Entry e)
        {
            Ensure();
            bool wasLoaded = AssetBundleManager.GetLoadedAssetBundle(e.Bundle, out string _, e.Manifest) != null;
            GameObject go = null;
            try
            {
                go = CommonLib.LoadAsset<GameObject>(e.Bundle, e.File, true, e.Manifest);
                if (go == null) return false;
                go.transform.position = new Vector3(0, -3000, 0);
                go.transform.rotation = Quaternion.identity;
                SetLayer(go.transform, Layer());
                // nothing in it may light, film or sound in the scene
                foreach (var l in go.GetComponentsInChildren<Light>(true)) l.enabled = false;
                foreach (var c in go.GetComponentsInChildren<Camera>(true)) c.enabled = false;
                foreach (var s in go.GetComponentsInChildren<AudioSource>(true)) { s.Stop(); s.enabled = false; }
                DefaultColors(go, e);

                // frame what can be seen
                var rends = go.GetComponentsInChildren<Renderer>(false).Where(r => r.enabled && (r is MeshRenderer || r is SkinnedMeshRenderer)).ToList();
                if (rends.Count == 0) return false; // lights, effects, empty helpers: nothing to picture
                var b = rends[0].bounds;
                foreach (var r in rends.Skip(1)) b.Encapsulate(r.bounds);
                float radius = Mathf.Max(0.02f, b.extents.magnitude);
                const float fov = 30f;
                // models face +Z: look at the front, a little from the right and above
                var dir = (Quaternion.Euler(-18f, 32f, 0f) * Vector3.forward).normalized;
                float dist = radius / Mathf.Sin(fov * 0.5f * Mathf.Deg2Rad) * 1.02f;
                _cam.transform.position = b.center + dir * dist;
                _cam.transform.rotation = Quaternion.LookRotation(b.center - _cam.transform.position, Vector3.up);
                _cam.fieldOfView = fov;
                _cam.nearClipPlane = Mathf.Max(0.005f, dist - radius * 1.5f);
                _cam.farClipPlane = dist + radius * 2f;
                _light.transform.rotation = Quaternion.LookRotation(Quaternion.Euler(-25f, 35f, 0f) * (b.center - _cam.transform.position).normalized);
                _light.enabled = true;
                var prev = RenderTexture.active;
                try
                {
                    _cam.targetTexture = _rt;
                    _cam.Render();
                    RenderTexture.active = _rt;
                    _tex.ReadPixels(new Rect(0, 0, Size, Size), 0, 0, false);
                    _tex.Apply(false);
                    File.WriteAllBytes(ThumbPath(e), _tex.EncodeToJPG(85));
                }
                finally
                {
                    RenderTexture.active = prev;
                    _cam.targetTexture = null;
                    _light.enabled = false;
                }
                return true;
            }
            finally
            {
                if (go != null) DestroyImmediate(go);
                // a bundle we loaded only for this picture is let go again (one Studio already uses stays)
                if (!wasLoaded)
                    try { AssetBundleManager.UnloadAssetBundle(e.Bundle, false, e.Manifest, false); }
                    catch { /* Sideloader keeps some of its own */ }
            }
        }

        /// <summary>The item's own default colours, as Studio sets them when it's added.</summary>
        private static void DefaultColors(GameObject go, Entry e)
        {
            var ic = go.GetComponentInChildren<ItemComponent>(true);
            if (ic == null) return;
            try
            {
                var info = new OIItemInfo(e.G, e.C, e.N, -1);
                if (ic.info != null)
                    for (int k = 0; k < ic.info.Length && k < info.color.Length; k++)
                        if (ic.info[k] != null) info.color[k] = ic.info[k].defColor;
                info.alpha = ic.alpha;
                info.lineColor = ic.defLineColor;
                info.lineWidth = ic.defLineWidth;
                info.emissionColor = ic.defEmissionColor;
                info.emissionPower = ic.defEmissionPower;
                info.lightCancel = ic.defLightCancel;
                ic.UpdateColor(info);
            }
            catch (Exception ex) { StudioBridgePlugin.Logger.LogDebug("item colours " + e.Name + ": " + ex.Message); }
        }
    }
}
