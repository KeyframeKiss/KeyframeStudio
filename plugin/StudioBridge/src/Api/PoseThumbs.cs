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
    /// Pose thumbnails: applies each pose to a stand-in character (the selected one), renders a full-body
    /// picture on a plain backdrop, and caches it as UserData/StudioEX/pose-thumbs/&lt;key&gt;.jpg, keyed by the
    /// pose file's path and write time (a changed pose gets a fresh thumbnail). Pose files are never touched.
    /// The stand-in's own pose is saved first and restored at the end (also when cancelled or on errors).
    /// While it runs, change detection is paused so auto-key never keys the pose flicking.
    /// </summary>
    internal sealed class PoseThumbs : MonoBehaviour
    {
        public static PoseThumbs Instance;
        public static bool Running { get; private set; }

        private bool _cancel;
        private int _done, _total;
        private Camera _cam;
        private RenderTexture _rt;
        private Texture2D _tex;

        public static string Folder
        {
            get
            {
                var dir = Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/pose-thumbs"));
                Directory.CreateDirectory(dir);
                return dir;
            }
        }

        /// <summary>Cache file for a pose file (changes when the pose file is rewritten).</summary>
        public static string ThumbPath(string poseFile)
        {
            var stamp = File.GetLastWriteTimeUtc(poseFile).Ticks;
            using (var md5 = MD5.Create())
            {
                var h = md5.ComputeHash(Encoding.UTF8.GetBytes(poseFile.ToLowerInvariant() + "|" + stamp));
                var sb = new StringBuilder(32);
                foreach (var b in h) sb.Append(b.ToString("x2"));
                return Path.Combine(Folder, sb + ".jpg");
            }
        }

        public static void Register(CommandRouter r)
        {
            r.Add("pose.thumbs", a => Instance.Start(a));
            r.Add("pose.thumbsCancel", a => { Instance._cancel = true; return true; });
            r.Add("pose.thumbsStatus", a => new Dictionary<string, object> { { "running", Running }, { "done", Instance._done }, { "total", Instance._total } });
        }

        private void Awake() => Instance = this;

        /// <summary>args: {id: stand-in character, files?: [pose paths], missingOnly?: bool (default true), size?: px}</summary>
        private object Start(Dictionary<string, object> a)
        {
            if (Running) throw new BridgeException("Thumbnails are already being made");
            var c = CharaApi.Chara(a.GetInt("id"));
            if (c.charInfo == null) throw new BridgeException("That character isn't loaded");
            var files = a.GetList("files").Select(o => o as string).Where(f => f != null && File.Exists(f)).ToList();
            if (files.Count == 0) throw new BridgeException("No poses to render");
            if (a.GetBool("missingOnly", true)) files = files.Where(f => !File.Exists(ThumbPath(f))).ToList();
            if (files.Count == 0) return 0;
            int size = Mathf.Clamp(a.GetInt("size", 256), 96, 512);
            _cancel = false;
            _done = 0;
            _total = files.Count;
            StartCoroutine(Build(c, files, size));
            return files.Count;
        }

        private void Progress(bool running) =>
            StudioBridgePlugin.Instance?.Broadcast("pose.thumbs", new Dictionary<string, object> { { "running", running }, { "done", _done }, { "total", _total } });

        private IEnumerator Build(OCIChar c, List<string> files, int size)
        {
            Running = true;
            var saved = new PauseCtrl.FileInfo(c); // the stand-in's own pose
            int failed = 0;
            try
            {
                Progress(true);
                foreach (var f in files)
                {
                    if (_cancel || c.charInfo == null) break;
                    bool ok;
                    try { ok = PauseCtrl.Load(c, f); }
                    catch { ok = false; }
                    yield return null;                    // let FK/IK and dynamic bones settle
                    yield return new WaitForEndOfFrame();
                    if (ok)
                    {
                        try { File.WriteAllBytes(ThumbPath(f), Render(c, size)); }
                        catch (Exception e) { failed++; StudioBridgePlugin.Logger.LogDebug("pose thumb " + f + ": " + e.Message); }
                    }
                    else failed++;
                    _done++;
                    if (_done % 4 == 0 || _done == _total) Progress(true);
                }
            }
            finally
            {
                try { if (c.charInfo != null) saved.Apply(c); } catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Couldn't restore pose: " + e.Message); }
                Running = false;
                EventPump.RequestRebase(); // the restored pose is the baseline again
                Progress(false);
                if (failed > 0) StudioBridgePlugin.Logger.LogInfo("Pose thumbnails: " + failed + " pose(s) couldn't be rendered");
            }
        }

        private byte[] Render(OCIChar c, int size)
        {
            var root = c.charInfo.transform;
            var all = new Dictionary<string, Transform>();
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
                if (!all.ContainsKey(t.name)) all[t.name] = t;

            // Bounds of all body joints in the character's own space (camera always faces the character),
            // plus a sphere around the head (the head bone sits at its base, the skull and hair extend past it).
            Vector3 min = Vector3.one * float.MaxValue, max = Vector3.one * float.MinValue;
            int n = 0;
            // Bones that skin the visible meshes (body, clothes, hair): exactly what can be seen.
            var seen = new HashSet<int>();
            foreach (var skin in c.charInfo.GetComponentsInChildren<SkinnedMeshRenderer>(false))
            {
                if (!skin.enabled || skin.bones == null) continue;
                foreach (var b in skin.bones)
                {
                    if (b == null || !seen.Add(b.GetInstanceID())) continue;
                    var p = root.InverseTransformPoint(b.position);
                    min = Vector3.Min(min, p);
                    max = Vector3.Max(max, p);
                    n++;
                }
            }
            if (n == 0) { min = new Vector3(-0.5f, 0, -0.5f); max = new Vector3(0.5f, 1.6f, 0.5f); }
            if (all.TryGetValue("cf_j_head", out var head))
            {
                var hp = root.InverseTransformPoint(head.position);
                float r = all.TryGetValue("cf_j_neck", out var neck) ? Mathf.Max(0.08f, (head.position - neck.position).magnitude * 2.6f) : 0.15f;
                // skull/hair reach above and around the head bone
                var hc = hp + root.InverseTransformDirection(head.up) * r * 0.6f;
                min = Vector3.Min(min, hc - Vector3.one * r);
                max = Vector3.Max(max, hc + Vector3.one * r);
            }
            var pad = (max - min) * 0.04f;
            min -= pad; max += pad;
            var centerLocal = (min + max) * 0.5f;
            float span = Mathf.Max(max.y - min.y, max.x - min.x) * 1.06f;
            float depth = max.z - min.z;

            EnsureCamera(size);
            const float fov = 24f;
            float dist = span * 0.5f / Mathf.Tan(fov * 0.5f * Mathf.Deg2Rad) + depth * 0.5f;
            var center = root.TransformPoint(centerLocal);
            var dir = (root.rotation * Quaternion.Euler(-8f, 0f, 0f) * Vector3.forward).normalized; // slightly from above
            _cam.transform.position = center + dir * dist;
            _cam.transform.rotation = Quaternion.LookRotation(center - _cam.transform.position, root.up);
            _cam.fieldOfView = fov;
            _cam.nearClipPlane = Mathf.Max(0.01f, dist - span - depth); // never clip a limb/head reaching towards the camera
            _cam.farClipPlane = dist + span * 2f;
            var smr = c.charInfo.GetComponentInChildren<SkinnedMeshRenderer>();
            _cam.cullingMask = 1 << (smr != null ? smr.gameObject.layer : 10);

            // Only this character: hide other characters and items for this render.
            var hidden = new List<Renderer>();
            foreach (var oci in Singleton<Studio.Studio>.Instance.dicObjectCtrl.Values)
            {
                GameObject go = oci is OCIChar o && o != c && o.charInfo != null ? o.charInfo.gameObject : oci is OCIItem it && it.objectItem != null ? it.objectItem : null;
                if (go == null) continue;
                foreach (var r in go.GetComponentsInChildren<Renderer>(false))
                    if (r.enabled) { r.enabled = false; hidden.Add(r); }
            }
            var prev = RenderTexture.active;
            try
            {
                _cam.targetTexture = _rt;
                _cam.Render();
                RenderTexture.active = _rt;
                _tex.ReadPixels(new Rect(0, 0, size, size), 0, 0, false);
                return _tex.EncodeToJPG(85);
            }
            finally
            {
                RenderTexture.active = prev;
                _cam.targetTexture = null;
                foreach (var r in hidden) if (r != null) r.enabled = true;
            }
        }

        private void EnsureCamera(int size)
        {
            if (_cam == null)
            {
                var go = new GameObject("StudioEX.PoseThumbCamera") { hideFlags = HideFlags.HideAndDontSave };
                DontDestroyOnLoad(go);
                _cam = go.AddComponent<Camera>();
                _cam.enabled = false;
            }
            var main = Camera.main;
            if (main != null)
            {
                _cam.renderingPath = main.renderingPath;
                _cam.allowHDR = main.allowHDR;
            }
            _cam.clearFlags = CameraClearFlags.SolidColor;
            _cam.backgroundColor = new Color(0.16f, 0.17f, 0.19f);
            if (_rt == null || _rt.width != size)
            {
                if (_rt != null) { _rt.Release(); Destroy(_rt); }
                if (_tex != null) Destroy(_tex);
                _rt = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 4, name = "StudioEX.PoseThumb" };
                _tex = new Texture2D(size, size, TextureFormat.RGB24, false);
            }
        }
    }
}
