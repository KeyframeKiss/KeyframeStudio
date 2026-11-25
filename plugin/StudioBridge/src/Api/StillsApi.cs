using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx.Bootstrap;
using HarmonyLib;
using UnityStandardAssets.ImageEffects;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Still images of Studio's camera: supersampled (rendered larger, scaled down), PNG or JPG, optionally with a
    /// transparent background. Screencap (Screenshot Manager, in BepisPlugins) does the capture when installed —
    /// it's needed for transparency; ours renders the camera itself otherwise. Batches take one picture per saved
    /// view or per shot and put the camera and playhead back afterwards.
    /// </summary>
    internal static class StillsApi
    {
        private const string ScreencapGuid = "com.bepis.bepinex.screenshotmanager";
        private static bool _useScreencap = true;

        // a running batch
        private static bool _running;
        internal static bool Capturing => _running;
        private static int _done, _total;
        private static string _current, _error;
        private static readonly List<object> _results = new List<object>();

        public static void Register(CommandRouter r)
        {
            r.Add("still.status", a => Status());
            // with "versions": one picture per version (its size and framing), returned as a list
            r.Add("still.capture", a =>
            {
                if (_running) throw new BridgeException("A batch of pictures is being taken");
                var o = Options(a);
                var versions = ShotApi.Versions(a);
                if (versions == null || versions.Count == 0) return Capture(o, a.GetString("name"));
                return versions.Select(v => (object)CaptureVersion(o, v, a.GetString("name"), versions.Count > 1)).ToList();
            });
            r.Add("still.batch", StartBatch);
            // tests: which triangle winding ray-traced shade treats as the front (+1 / -1)
            r.Add("still.rtFront", a => { if (a.Has("sign")) RtShade.FrontSign = a.GetFloat("sign") < 0 ? -1f : 1f; return (double)RtShade.FrontSign; });
            r.Add("still.set", a => { if (a.Has("useScreencap")) _useScreencap = a.GetBool("useScreencap", true); return Status(); });
        }

        private static bool ScreencapInstalled => Chainloader.PluginInfos.ContainsKey(ScreencapGuid);

        private static string Folder => Path.GetFullPath(Path.Combine(UserData.Path, "cap"));

        private static Dictionary<string, object> Status() => new Dictionary<string, object>
        {
            { "screencap", ScreencapInstalled }, { "useScreencap", _useScreencap }, { "folder", Folder },
            { "screen", new List<object> { Screen.width, Screen.height } },
            { "batch", new Dictionary<string, object> { { "running", _running }, { "done", _done }, { "total", _total }, { "current", _current }, { "error", _error }, { "results", _results.ToList() } } },
        };

        private sealed class Opts
        {
            public int Width, Height, Supersample = 2, Quality = 95;
            public bool Transparent, Jpg;
            // quality stills: renders averaged (1 = one render), real lens blur (f-stop), 16 bits per channel (PNG)
            public int Samples = 1;
            public bool Lens, Bits16, RtShade;
            public float FStop = 2.8f;
            public float Focus2, Tilt; // a second sharp distance (m, 0 = none); the focus plane tilted (degrees, + = the top further away)
            public bool Quality2 => Samples > 1 || Lens || Bits16 || RtShade;
        }

        private static Opts Options(Dictionary<string, object> a)
        {
            var o = new Opts
            {
                Width = a.GetInt("width", Screen.width),
                Height = a.GetInt("height", Screen.height),
                Supersample = Mathf.Clamp(a.GetInt("supersample", 2), 1, 4),
                Transparent = a.GetBool("transparent"),
                Jpg = a.GetString("format") == "jpg",
                Quality = Mathf.Clamp(a.GetInt("quality", 95), 50, 100),
                Samples = Mathf.Clamp(a.GetInt("samples", 1), 1, 1024),
                Lens = a.GetBool("lens"),
                FStop = Mathf.Clamp(a.GetFloat("fstop", 2.8f), 0.7f, 32f),
                Bits16 = a.GetBool("bits16"),
                RtShade = a.GetBool("rtshade"),
                Focus2 = Mathf.Clamp(a.GetFloat("focus2", 0f), 0f, 1000f),
                Tilt = Mathf.Clamp(a.GetFloat("tilt", 0f), -45f, 45f),
            };
            if (o.Lens && o.Samples < 16) o.Samples = 64; // a lens needs many views to look smooth
            if (o.Bits16 && o.Jpg) throw new BridgeException("16-bit pictures are PNG only");
            if (o.Width < 16 || o.Height < 16) throw new BridgeException("That size is too small");
            if (!Fits(o)) throw new BridgeException("Too big for this graphics card: lower the size or the supersampling");
            if (o.Transparent && o.Jpg) throw new BridgeException("JPG can't be transparent — use PNG");
            if (o.Transparent && !ScreencapInstalled) throw new BridgeException("Transparent pictures need Screencap (Screenshot Manager from BepisPlugins)");
            return o;
        }

        // ------------------------------------------------------------------ one picture

        /// <summary>One picture as a version: its size (0 = the window) and camera framing; named after it when there are several.</summary>
        private static object CaptureVersion(Opts baseOpts, Dictionary<string, object> v, string name, bool nameIt)
        {
            int w = v.GetInt("width", 0), h = v.GetInt("height", 0);
            var o = new Opts { Width = w >= 16 ? w : Screen.width, Height = h >= 16 ? h : Screen.height, Supersample = baseOpts.Supersample, Quality = baseOpts.Quality, Transparent = baseOpts.Transparent, Jpg = baseOpts.Jpg, Samples = baseOpts.Samples, Lens = baseOpts.Lens, FStop = baseOpts.FStop, Bits16 = baseOpts.Bits16, Focus2 = baseOpts.Focus2, Tilt = baseOpts.Tilt, RtShade = baseOpts.RtShade };
            while (o.Supersample > 1 && !Fits(o)) o.Supersample--;
            if (!Fits(o)) throw new BridgeException("Too big for this graphics card: " + o.Width + " × " + o.Height);
            var before = RenderFraming.Active;
            RenderFraming.Active = RenderFraming.From(v.ContainsKey("framing") ? v["framing"] as Dictionary<string, object> : null);
            try
            {
                string label = v.GetString("label") ?? "";
                string full = string.Join(" ", new[] { name, nameIt ? label : null }.Where(x => !string.IsNullOrEmpty(x)).ToArray());
                return Capture(o, full);
            }
            finally { RenderFraming.Active = before; }
        }

        private static object Capture(Opts o, string name)
        {
            if (RenderApi.Busy()) throw new BridgeException("VideoExport is recording");
            Texture2D tex = null;
            string provider;
            bool theirs = ScreencapInstalled && (_useScreencap || o.Transparent) && !o.Quality2; // quality stills are ours
            if (theirs && (tex = ScreencapCapture(o)) != null) provider = "Screencap";
            else
            {
                if (o.Transparent) throw new BridgeException("Screencap couldn't take the picture");
                tex = OurCapture(o);
                provider = "Keyframe Studio";
            }
            try
            {
                Directory.CreateDirectory(Folder);
                string safe = string.IsNullOrEmpty(name) ? "" : "-" + new string(name.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch).ToArray());
                string file = Path.Combine(Folder, "KeyframeStudio-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + safe + (o.Jpg ? ".jpg" : ".png"));
                if (_last16 != null && o.Bits16 && !o.Jpg) File.WriteAllBytes(file, _last16);
                else File.WriteAllBytes(file, o.Jpg ? tex.EncodeToJPG(o.Quality) : tex.EncodeToPNG());
                _last16 = null;
                return new Dictionary<string, object>
                {
                    { "path", file }, { "folder", Folder }, { "provider", provider },
                    { "width", tex.width }, { "height", tex.height }, { "thumb", Thumb(tex, 240) },
                };
            }
            finally { UnityEngine.Object.Destroy(tex); }
        }

        private static Texture2D ScreencapCapture(Opts o)
        {
            try
            {
                var inst = Chainloader.PluginInfos[ScreencapGuid].Instance;
                var m = AccessTools.Method(inst.GetType(), "Capture", new[] { typeof(int), typeof(int), typeof(int), typeof(bool) });
                return m?.Invoke(inst, new object[] { o.Width, o.Height, o.Supersample, o.Transparent }) as Texture2D;
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("Screencap: " + (e.InnerException ?? e).Message);
                return null;
            }
        }

        /// <summary>Studio's camera at this size (supersampled), for straight-to-video renders without Screencap.</summary>
        internal static Texture2D RenderCamera(int width, int height, int supersample) =>
            OurCapture(new Opts { Width = width, Height = height, Supersample = Mathf.Clamp(supersample, 1, 4) });

        private static byte[] _last16; // the 16-bit PNG of the picture just taken (written instead of the 8-bit one)

        /// <summary>
        /// Whether this picture fits the graphics card: each side within its largest texture, and the render targets
        /// within about 60% of its memory (quality stills keep float pictures: more per pixel).
        /// </summary>
        private static bool Fits(Opts o)
        {
            long w = (long)o.Width * o.Supersample, h = (long)o.Height * o.Supersample;
            int max = Math.Max(4096, SystemInfo.maxTextureSize);
            if (w > max || h > max) return false;
            long perPixel = o.Quality2 ? (o.Focus2 > 0f ? 16 + 16 + 16 + 8 + 4 + 4 : 16 + 8 + 4) : 4 + 4 + 4;
            long vram = Math.Max(2048L, SystemInfo.graphicsMemorySize) * 1024L * 1024L;
            return w * h * perPixel < vram * 6 / 10;
        }

        /// <summary>The distance a still's lens focuses at: depth of field's focus setting (eyes, view centre or fixed).</summary>
        private static float StillFocus(Camera cam) => FxApi.FocusDistance(cam);

        private static float Halton(int i, int b)
        {
            float f = 1f, r = 0f;
            while (i > 0) { f /= b; r += f * (i % b); i /= b; }
            return r;
        }

        /// <summary>
        /// A quality still: Studio's camera rendered many times in this one frame (so nothing moves between them), each
        /// nudged within its pixel and, with a lens, seen from another point of the lens opening with the view sheared so
        /// that the focus plane stays put — sharp there, blurring with distance from it, like a real lens. The plane can
        /// be tilted; with a second distance, a second lens picture is made and each pixel taken from the one focused
        /// nearer to it (focus stacking). Averaged in floats, then scaled down; a 16-bit PNG is kept if asked.
        /// </summary>
        private static float _lastFocus;
        private static string _lastRt; // what the ray-traced shade traced (for the picture's note)

        /// <summary>The camera's renders for one focus distance, averaged into a float picture (caller releases it).</summary>
        private static RenderTexture Accumulate(Opts o, Camera cam, Material mat, int w, int h, float focus)
        {
            int s = o.Supersample;
            var acc = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGBFloat);
            var one = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGBHalf);
            var prevActive = RenderTexture.active;
            RenderTexture.active = acc;
            GL.Clear(false, true, Color.clear);
            RenderTexture.active = prevActive;
            int n = o.Samples;
            mat.SetFloat("_KfWeight", 1f / n);
            var view0 = cam.worldToCameraMatrix;
            var proj0 = cam.projectionMatrix;
            // a full-frame lens of this field of view: focal length (m), and the opening's radius at this f-stop
            float fl = 0.012f / Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
            float radius = o.Lens ? fl / o.FStop * 0.5f : 0f;
            // the plane kept sharp, in view space (the camera looks down -z), tilted about the horizontal axis
            float tilt = -o.Tilt * Mathf.Deg2Rad;
            var nrm = new Vector3(0f, Mathf.Sin(tilt), -Mathf.Cos(tilt));
            float dist = focus * Mathf.Cos(tilt);
            float spin = UnityEngine.Random.value * 6.2831853f;
            try
            {
                for (int k = 0; k < n; k++)
                {
                    float jx = (Halton(k + 1, 2) - 0.5f) * s, jy = (Halton(k + 1, 3) - 0.5f) * s;
                    var view = view0;
                    if (radius > 0f)
                    {
                        float r = Mathf.Sqrt((k + 0.5f) / n) * radius, a = spin + k * 2.39996323f;
                        // seen from e on the lens, with the plane's points left where they are: X' = X - e (n · X) / d
                        var e = new Vector3(Mathf.Cos(a) * r, Mathf.Sin(a) * r, 0f);
                        var shear = Matrix4x4.identity;
                        for (int row = 0; row < 3; row++)
                            for (int col = 0; col < 3; col++)
                                shear[row, col] -= e[row] * nrm[col] / dist;
                        view = shear * view0;
                    }
                    cam.worldToCameraMatrix = view;
                    var m = proj0;
                    m[0, 2] += -2f * jx / w;
                    m[1, 2] += -2f * jy / h;
                    cam.projectionMatrix = m;
                    cam.targetTexture = one;
                    cam.Render();
                    Graphics.Blit(one, acc, mat, 0);
                }
            }
            finally
            {
                cam.ResetWorldToCameraMatrix();
                cam.ResetProjectionMatrix();
                RenderTexture.ReleaseTemporary(one);
            }
            return acc;
        }

        private static Texture2D QualityCapture(Opts o, Camera cam)
        {
            int s = o.Supersample, w = o.Width * s, h = o.Height * s;
            var mat = new Material(FxApi.GetShader("Accum")) { hideFlags = HideFlags.HideAndDontSave };
            var prevTarget = cam.targetTexture;
            var depthWas = cam.depthTextureMode;
            float focus = StillFocus(cam);
            float focus2 = o.Lens && o.Focus2 > 0.05f ? o.Focus2 : 0f;
            var dof = cam.GetComponent<DepthOfField>();
            bool dofWas = dof != null && dof.enabled;
            if (o.Lens) { FxApi.HoldDof = true; if (dof != null) dof.enabled = false; } // the lens makes the blur itself
            RenderTexture acc = null, accB = null, depth = null;
            RtShade rt = null;
            _lastRt = null;
            try
            {
                if (o.RtShade)
                {
                    var t0 = Time.realtimeSinceStartup;
                    rt = RtShade.Build(cam, out string why);
                    if (rt == null) throw new BridgeException("Ray-traced shade isn't available: " + why);
                    // a few rays per pixel in each render; the renders average them (more renders, fewer rays each)
                    rt.Rays = Mathf.Clamp(128 / Math.Max(1, o.Samples), 1, 8);
                    cam.depthTextureMode |= DepthTextureMode.Depth;
                    RtShade.Active = rt;
                    FxApi.Refresh(); // our effects on the camera, even with every effect off
                    _lastRt = rt.Triangles.ToString("N0") + " triangles, tree in " + (Time.realtimeSinceStartup - t0).ToString("0.0") + " s";
                }
                acc = Accumulate(o, cam, mat, w, h, focus);
                if (focus2 > 0f)
                {
                    accB = Accumulate(o, cam, mat, w, h, focus2);
                    // the scene's depth, from one plain render
                    cam.depthTextureMode |= DepthTextureMode.Depth;
                    var plain = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGBHalf);
                    cam.targetTexture = plain;
                    cam.Render();
                    depth = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.RFloat);
                    Graphics.Blit(plain, depth, mat, 1);
                    RenderTexture.ReleaseTemporary(plain);
                    var joined = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGBFloat);
                    mat.SetTexture("_KfTexB", accB);
                    mat.SetTexture("_KfDepth", depth);
                    mat.SetVector("_KfStack", new Vector4(focus, focus2, 0.15f, 0f));
                    Graphics.Blit(acc, joined, mat, 2);
                    RenderTexture.ReleaseTemporary(acc);
                    acc = joined;
                }
            }
            catch
            {
                if (acc != null) RenderTexture.ReleaseTemporary(acc);
                throw;
            }
            finally
            {
                RtShade.Active = null;
                if (rt != null) FxApi.Refresh();
                rt?.Dispose();
                cam.targetTexture = prevTarget;
                cam.depthTextureMode = depthWas;
                cam.ResetAspect();
                FxApi.HoldDof = false;
                if (dof != null) dof.enabled = dofWas;
                UnityEngine.Object.Destroy(mat);
                if (accB != null) RenderTexture.ReleaseTemporary(accB);
                if (depth != null) RenderTexture.ReleaseTemporary(depth);
            }
            _lastFocus = focus;
            // scale down in floats
            var cur = acc;
            while (cur.width / 2 >= o.Width && cur.height / 2 >= o.Height)
            {
                var half = RenderTexture.GetTemporary(cur.width / 2, cur.height / 2, 0, RenderTextureFormat.ARGBFloat);
                half.filterMode = cur.filterMode = FilterMode.Bilinear;
                Graphics.Blit(cur, half);
                RenderTexture.ReleaseTemporary(cur);
                cur = half;
            }
            var fin = RenderTexture.GetTemporary(o.Width, o.Height, 0, RenderTextureFormat.ARGBFloat);
            cur.filterMode = FilterMode.Bilinear;
            Graphics.Blit(cur, fin);
            RenderTexture.ReleaseTemporary(cur);
            bool linear = QualitySettings.activeColorSpace == ColorSpace.Linear;
            var prev = RenderTexture.active;
            try
            {
                RenderTexture.active = fin;
                var ft = new Texture2D(o.Width, o.Height, TextureFormat.RGBAFloat, false, true);
                ft.ReadPixels(new Rect(0, 0, o.Width, o.Height), 0, 0);
                var px = ft.GetPixels();
                UnityEngine.Object.Destroy(ft);
                Func<float, float> enc = v => linear ? Mathf.LinearToGammaSpace(Mathf.Clamp01(v)) : Mathf.Clamp01(v);
                if (o.Bits16 && !o.Jpg)
                {
                    int W = o.Width, H = o.Height;
                    var notes = new Dictionary<string, string>
                    {
                        { "Software", "Keyframe Studio" },
                        { "Comment", "samples " + o.Samples + (o.Lens ? ", lens f/" + o.FStop.ToString("0.#") + " focused at " + _lastFocus.ToString("0.00") + " m" + (o.Focus2 > 0.05f ? " and " + o.Focus2.ToString("0.00") + " m" : "") + (Mathf.Abs(o.Tilt) > 0.01f ? ", tilted " + o.Tilt.ToString("0.#") + "°" : "") : "") + (_lastRt != null ? ", ray-traced shade (" + _lastRt + ")" : "") },
                    };
                    _last16 = Png16.Encode(W, H, (x, y, c) => { var p = px[(H - 1 - y) * W + x]; return enc(c == 0 ? p.r : c == 1 ? p.g : p.b); }, false, notes);
                }
                var tex = new Texture2D(o.Width, o.Height, TextureFormat.RGB24, false);
                var c8 = new Color32[px.Length];
                for (int i = 0; i < px.Length; i++)
                    c8[i] = new Color32((byte)(enc(px[i].r) * 255f + 0.5f), (byte)(enc(px[i].g) * 255f + 0.5f), (byte)(enc(px[i].b) * 255f + 0.5f), 255);
                tex.SetPixels32(c8);
                tex.Apply();
                return tex;
            }
            finally
            {
                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(fin);
            }
        }

        /// <summary>Render Studio's camera at (size × supersample) and scale down in halving steps (smooth, no shimmer).</summary>
        private static Texture2D OurCapture(Opts o)
        {
            var cam = Camera.main ?? throw new BridgeException("No camera");
            if (o.Quality2) return QualityCapture(o, cam);
            int w = o.Width * o.Supersample, h = o.Height * o.Supersample;
            var big = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32);
            var prevTarget = cam.targetTexture;
            var dof = cam.GetComponent<DepthOfField>();
            float blur = dof != null ? dof.maxBlurSize : 0;
            if (dof != null) dof.maxBlurSize = blur * w / Mathf.Max(1, Screen.width); // the same blur at the bigger size
            try
            {
                cam.targetTexture = big;
                cam.Render();
            }
            finally
            {
                cam.targetTexture = prevTarget;
                cam.ResetAspect();
                if (dof != null) dof.maxBlurSize = blur;
            }
            var cur = big;
            while (cur.width / 2 >= o.Width && cur.height / 2 >= o.Height)
            {
                var half = RenderTexture.GetTemporary(cur.width / 2, cur.height / 2, 0, RenderTextureFormat.ARGB32);
                half.filterMode = FilterMode.Bilinear;
                cur.filterMode = FilterMode.Bilinear;
                Graphics.Blit(cur, half);
                RenderTexture.ReleaseTemporary(cur);
                cur = half;
            }
            var fin = RenderTexture.GetTemporary(o.Width, o.Height, 0, RenderTextureFormat.ARGB32);
            cur.filterMode = FilterMode.Bilinear;
            Graphics.Blit(cur, fin);
            RenderTexture.ReleaseTemporary(cur);
            var prev = RenderTexture.active;
            RenderTexture.active = fin;
            var tex = new Texture2D(o.Width, o.Height, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, o.Width, o.Height), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(fin);
            return tex;
        }

        private static string Thumb(Texture2D src, int size)
        {
            try
            {
                float aspect = (float)src.width / src.height;
                int w = aspect >= 1 ? size : Mathf.RoundToInt(size * aspect), h = aspect >= 1 ? Mathf.RoundToInt(size / aspect) : size;
                var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(src, rt);
                var prev = RenderTexture.active;
                RenderTexture.active = rt;
                var t = new Texture2D(w, h, TextureFormat.RGB24, false);
                t.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                t.Apply();
                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(rt);
                var jpg = t.EncodeToJPG(80);
                UnityEngine.Object.Destroy(t);
                return "data:image/jpeg;base64," + Convert.ToBase64String(jpg);
            }
            catch { return null; }
        }

        // ------------------------------------------------------------------ batches

        /// <summary>args: {kind: "views" | "shots", …options} — one picture per saved view or per shot (at its start, through its camera).</summary>
        private static object StartBatch(Dictionary<string, object> a)
        {
            if (_running) throw new BridgeException("Already taking pictures");
            var o = Options(a);
            var versions = ShotApi.Versions(a);
            string kind = a.GetString("kind");
            var s = Singleton<Studio.Studio>.Instance;
            var jobs = new List<KeyValuePair<string, Action>>();
            if (kind == "views")
            {
                var reset = s.cameraCtrl.ExportResetData();
                for (int i = 0; i < s.sceneInfo.cameraData.Length; i++)
                {
                    var d = s.sceneInfo.cameraData[i];
                    if (!CameraApi.Used(d, reset)) continue;
                    int idx = i;
                    jobs.Add(new KeyValuePair<string, Action>("view " + (i + 1), () => s.cameraCtrl.Import(s.sceneInfo.cameraData[idx])));
                }
                if (jobs.Count == 0) throw new BridgeException("No saved views yet — save some in Shoot › Shots & camera");
            }
            else if (kind == "shots")
            {
                var shots = (ShotApi.All ?? new List<Dictionary<string, object>>()).ToList();
                if (shots.Count == 0) throw new BridgeException("No shots yet — add some in Shoot › Shots & camera");
                foreach (var shot in shots)
                {
                    var sh = shot;
                    jobs.Add(new KeyValuePair<string, Action>(sh.GetString("name") ?? "shot", () =>
                    {
                        TimelineApi.SeekTo((float)sh.GetDouble("start"));
                        ShotApi.ApplyCamera(sh);
                    }));
                }
            }
            else throw new BridgeException("Pick saved views or shots");
            _running = true;
            _done = 0;
            _total = jobs.Count * Math.Max(1, versions?.Count ?? 0);
            _error = null;
            _results.Clear();
            StudioBridgePlugin.Instance.StartCoroutine(RunBatch(jobs, o, versions));
            return Status();
        }

        private static IEnumerator RunBatch(List<KeyValuePair<string, Action>> jobs, Opts o, List<Dictionary<string, object>> versions)
        {
            var s = Singleton<Studio.Studio>.Instance;
            var camBack = s.cameraCtrl.Export();
            float fovBack = s.cameraCtrl.fieldOfView;
            float timeBack = TimelineApi.PlaybackTime();
            try
            {
                foreach (var job in jobs)
                {
                    _current = job.Key;
                    try { job.Value(); }
                    catch (Exception e) { _error = job.Key + ": " + e.Message; continue; }
                    // let the pose / camera settle (Timeline applies on the next frames)
                    yield return null;
                    yield return null;
                    yield return new WaitForEndOfFrame();
                    if (versions == null || versions.Count == 0)
                    {
                        try { _results.Add(Capture(o, job.Key)); }
                        catch (Exception e) { _error = job.Key + ": " + e.Message; }
                        _done++;
                    }
                    else
                        foreach (var v in versions)
                        {
                            try { _results.Add(CaptureVersion(o, v, job.Key, versions.Count > 1)); }
                            catch (Exception e) { _error = job.Key + " " + v.GetString("label") + ": " + e.Message; }
                            _done++;
                        }
                }
            }
            finally
            {
                s.cameraCtrl.Import(camBack);
                s.cameraCtrl.fieldOfView = fovBack;
                if (TimelineApi.Available) TimelineApi.SeekTo(timeBack);
                _running = false;
                _current = null;
                StudioBridgePlugin.Instance?.Broadcast("still.batchDone", Status());
            }
        }
    }
}
