using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// LUT files for Look › Picture: 3D colour tables from UserData/StudioEX/luts — .cube (Resolve / Photoshop / most
    /// LUT packs) and PNG (a strip N² wide × N high, or an 8 × 8 grid of 64 × 64 tiles). Loaded into 3D textures,
    /// cached until the file changes.
    /// </summary>
    internal static class LutFiles
    {
        public static string Folder => Path.GetFullPath(Path.Combine(UserData.Path, "StudioEX/luts"));

        private sealed class Entry
        {
            public DateTime Stamp;
            public Texture3D Tex;
            public int Size;
            public string Error;
        }

        private static readonly Dictionary<string, Entry> Cache = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);

        private static bool Known(string f) => f.EndsWith(".cube", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".png", StringComparison.OrdinalIgnoreCase);

        /// <summary>The LUT files there are, by name (relative to the folder, forward slashes).</summary>
        public static List<object> List()
        {
            var list = new List<object>();
            var dir = Folder;
            Directory.CreateDirectory(dir);
            foreach (var f in Directory.GetFiles(dir, "*.*", SearchOption.AllDirectories).Where(Known).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                string name = f.Substring(dir.Length).TrimStart('\\', '/').Replace('\\', '/');
                var e = Load(name);
                list.Add(new Dictionary<string, object> { { "name", name }, { "size", e?.Size ?? 0 }, { "error", e?.Error } });
            }
            return list;
        }

        /// <summary>The 3D texture for a LUT file (null when it's not there or can't be read); its size comes along.</summary>
        public static Texture3D Get(string name, out int size)
        {
            size = 0;
            if (string.IsNullOrEmpty(name)) return null;
            var e = Load(name);
            if (e?.Tex == null) return null;
            size = e.Size;
            return e.Tex;
        }

        private static Entry Load(string name)
        {
            string path = Path.GetFullPath(Path.Combine(Folder, name));
            if (!Net.SafePaths.IsInside(path, Folder) || !File.Exists(path) || !Known(path)) return null;
            var stamp = File.GetLastWriteTimeUtc(path);
            if (Cache.TryGetValue(name, out var hit) && hit.Stamp == stamp) return hit;
            if (hit?.Tex != null) UnityEngine.Object.Destroy(hit.Tex);
            var e = new Entry { Stamp = stamp };
            try
            {
                Color[] cols;
                int n;
                if (path.EndsWith(".cube", StringComparison.OrdinalIgnoreCase)) cols = ReadCube(path, out n);
                else cols = ReadPng(path, out n);
                var tex = new Texture3D(n, n, n, TextureFormat.RGBA32, false)
                {
                    wrapMode = TextureWrapMode.Clamp,
                    filterMode = FilterMode.Bilinear,
                    hideFlags = HideFlags.HideAndDontSave,
                };
                tex.SetPixels(cols);
                tex.Apply(false);
                e.Tex = tex;
                e.Size = n;
            }
            catch (Exception x)
            {
                e.Error = x.Message;
                StudioBridgePlugin.Logger.LogWarning("LUT " + name + ": " + x.Message);
            }
            Cache[name] = e;
            return e;
        }

        /// <summary>.cube: LUT_3D_SIZE n, optional DOMAIN_MIN / DOMAIN_MAX, then n³ lines "r g b" with red changing fastest.</summary>
        private static Color[] ReadCube(string path, out int n)
        {
            n = 0;
            var min = Vector3.zero;
            var max = Vector3.one;
            var vals = new List<Color>();
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                string key = parts[0].ToUpperInvariant();
                if (key == "LUT_3D_SIZE") { n = int.Parse(parts[1], CultureInfo.InvariantCulture); continue; }
                if (key == "LUT_1D_SIZE") throw new Exception("1D LUTs aren't supported (use a 3D .cube)");
                if (key == "DOMAIN_MIN") { min = V3(parts); continue; }
                if (key == "DOMAIN_MAX") { max = V3(parts); continue; }
                if (key == "TITLE" || char.IsLetter(parts[0][0])) continue;
                if (parts.Length < 3) continue;
                var v = V3(parts, 0);
                vals.Add(new Color(
                    Mathf.InverseLerp(min.x, max.x, v.x), Mathf.InverseLerp(min.y, max.y, v.y), Mathf.InverseLerp(min.z, max.z, v.z), 1f));
            }
            if (n < 2 || n > 128) throw new Exception("no LUT_3D_SIZE (2..128)");
            if (vals.Count != n * n * n) throw new Exception("expected " + (n * n * n) + " colours, found " + vals.Count);
            return vals.ToArray(); // red fastest, then green, then blue: Texture3D's x, y, z order
        }

        private static Vector3 V3(string[] p, int from = 1) =>
            new Vector3(float.Parse(p[from], CultureInfo.InvariantCulture), float.Parse(p[from + 1], CultureInfo.InvariantCulture), float.Parse(p[from + 2], CultureInfo.InvariantCulture));

        /// <summary>PNG: a strip (N² × N: blue picks the square, red across it, green up it) or an 8 × 8 grid of 64 × 64 tiles.</summary>
        private static Color[] ReadPng(string path, out int n)
        {
            var img = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            try
            {
                if (!img.LoadImage(File.ReadAllBytes(path))) throw new Exception("not a picture");
                int w = img.width, h = img.height;
                var px = img.GetPixels(); // bottom row first
                Color At(int x, int yFromTop) => px[(h - 1 - yFromTop) * w + x];
                Color[] cols;
                if (w == h * h)
                {
                    n = h;
                    cols = new Color[n * n * n];
                    for (int b = 0; b < n; b++)
                        for (int g = 0; g < n; g++)
                            for (int r = 0; r < n; r++)
                                cols[r + g * n + b * n * n] = At(b * n + r, n - 1 - g); // green up the strip
                }
                else if (w == 512 && h == 512)
                {
                    n = 64;
                    cols = new Color[n * n * n];
                    for (int b = 0; b < n; b++)
                    {
                        int tx = b % 8, ty = b / 8; // tiles left to right, top to bottom
                        for (int g = 0; g < n; g++)
                            for (int r = 0; r < n; r++)
                                cols[r + g * n + b * n * n] = At(tx * 64 + r, ty * 64 + g);
                    }
                }
                else throw new Exception("PNG LUTs must be a strip (e.g. 1024 × 32) or 512 × 512 (8 × 8 tiles)");
                for (int i = 0; i < cols.Length; i++) cols[i].a = 1f;
                return cols;
            }
            finally { UnityEngine.Object.Destroy(img); }
        }
    }
}
