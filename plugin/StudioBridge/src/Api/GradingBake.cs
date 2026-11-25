using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Look › Picture › Grading, baked into a 33³ colour table the LUT pass applies (in gamma, like a photo editor):
    /// curves (all / red / green / blue), colour by colour (eight hue bands: hue, saturation, lightness), split toning
    /// (shadows and highlights each tinted), bleach bypass and density. Rebaked only when a value changes.
    /// </summary>
    internal static class GradingBake
    {
        public const int Size = 33;
        public static readonly string[] Bands = { "red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta" };
        private static readonly float[] BandHue = { 0f, 30f, 60f, 120f, 180f, 240f, 270f, 300f };

        private static Texture3D _tex;
        private static string _sig;

        /// <summary>The defaults Look › Picture's Grading starts from (nothing changed).</summary>
        public static Dictionary<string, object> Defaults()
        {
            var d = new Dictionary<string, object> { { "on", false } };
            foreach (var b in Bands) { d[b + "Hue"] = 0f; d[b + "Sat"] = 0f; d[b + "Lum"] = 0f; }
            d["curveAll"] = "0,0 1,1";
            d["curveRed"] = "0,0 1,1";
            d["curveGreen"] = "0,0 1,1";
            d["curveBlue"] = "0,0 1,1";
            d["shadowHue"] = 220f;
            d["shadowAmount"] = 0f;
            d["highlightHue"] = 40f;
            d["highlightAmount"] = 0f;
            d["balance"] = 0f;
            d["bleach"] = 0f;
            d["density"] = 0f;
            return d;
        }

        /// <summary>The table for these values (made again only when they change).</summary>
        public static Texture3D Get(Dictionary<string, object> v)
        {
            string sig = string.Join("|", v.OrderBy(kv => kv.Key).Select(kv => kv.Key + "=" + Convert.ToString(kv.Value, CultureInfo.InvariantCulture)).ToArray());
            if (_tex != null && sig == _sig) return _tex;
            _sig = sig;
            if (_tex == null)
                _tex = new Texture3D(Size, Size, Size, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear, hideFlags = HideFlags.HideAndDontSave };
            _tex.SetPixels(Bake(v));
            _tex.Apply(false);
            return _tex;
        }

        private static float F(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o is float f ? f : 0f;

        public static Color[] Bake(Dictionary<string, object> v)
        {
            var all = Curve.Parse(v.TryGetValue("curveAll", out var a) ? a as string : null);
            var cr = Curve.Parse(v.TryGetValue("curveRed", out var r) ? r as string : null);
            var cg = Curve.Parse(v.TryGetValue("curveGreen", out var g) ? g as string : null);
            var cb = Curve.Parse(v.TryGetValue("curveBlue", out var b) ? b as string : null);
            var hue = new float[8];
            var sat = new float[8];
            var lum = new float[8];
            bool bands = false;
            for (int i = 0; i < 8; i++)
            {
                hue[i] = F(v, Bands[i] + "Hue");
                sat[i] = F(v, Bands[i] + "Sat");
                lum[i] = F(v, Bands[i] + "Lum");
                bands |= hue[i] != 0f || sat[i] != 0f || lum[i] != 0f;
            }
            float sAmt = Mathf.Clamp01(F(v, "shadowAmount")), hAmt = Mathf.Clamp01(F(v, "highlightAmount"));
            var sTint = HueColor(F(v, "shadowHue"));
            var hTint = HueColor(F(v, "highlightHue"));
            float balance = Mathf.Clamp(F(v, "balance"), -1f, 1f);
            float bleach = Mathf.Clamp01(F(v, "bleach")), density = Mathf.Clamp01(F(v, "density"));

            int n = Size;
            var cols = new Color[n * n * n];
            for (int z = 0; z < n; z++)
                for (int y = 0; y < n; y++)
                    for (int x = 0; x < n; x++)
                    {
                        var c = new Vector3(x / (n - 1f), y / (n - 1f), z / (n - 1f));
                        // 1. curves: all channels, then each
                        c = new Vector3(cr.Eval(all.Eval(c.x)), cg.Eval(all.Eval(c.y)), cb.Eval(all.Eval(c.z)));
                        // 2. colour by colour
                        if (bands) c = Bands8(c, hue, sat, lum);
                        // 3. split toning: shadows and highlights tinted, the pivot moved by balance
                        if (sAmt > 0f || hAmt > 0f)
                        {
                            float l = Luma(c);
                            float pivot = 0.5f + balance * 0.35f;
                            float ws = Mathf.Clamp01((pivot - l) / Mathf.Max(0.05f, pivot));
                            float wh = Mathf.Clamp01((l - pivot) / Mathf.Max(0.05f, 1f - pivot));
                            c += (sTint - new Vector3(0.5f, 0.5f, 0.5f)) * (sAmt * ws * 0.5f);
                            c += (hTint - new Vector3(0.5f, 0.5f, 0.5f)) * (hAmt * wh * 0.5f);
                            c += Vector3.one * (l - Luma(c)); // tints, not brightness
                        }
                        // 4. bleach bypass: the picture overlaid with its own greyscale (silver kept in the print)
                        if (bleach > 0f)
                        {
                            float l = Luma(c);
                            var o = new Vector3(Overlay(c.x, l), Overlay(c.y, l), Overlay(c.z, l));
                            var mono = Vector3.Lerp(o, Vector3.one * Luma(o), 0.6f);
                            c = Vector3.Lerp(c, mono, bleach);
                        }
                        // 5. density: rich colours darker, like slide film
                        if (density > 0f)
                        {
                            float s = Mathf.Max(c.x, Mathf.Max(c.y, c.z)) - Mathf.Min(c.x, Mathf.Min(c.y, c.z));
                            c *= 1f - density * s * 0.45f;
                        }
                        cols[x + y * n + z * n * n] = new Color(Mathf.Clamp01(c.x), Mathf.Clamp01(c.y), Mathf.Clamp01(c.z), 1f);
                    }
            return cols;
        }

        private static float Luma(Vector3 c) => 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
        private static float Overlay(float a, float b) => a < 0.5f ? 2f * a * b : 1f - 2f * (1f - a) * (1f - b);

        private static Vector3 HueColor(float deg)
        {
            var c = Color.HSVToRGB(Mathf.Repeat(deg, 360f) / 360f, 1f, 1f);
            return new Vector3(c.r, c.g, c.b);
        }

        /// <summary>How much a hue belongs to each band: smooth, the weights of neighbouring bands adding to 1.</summary>
        private static void BandWeights(float hueDeg, float[] w)
        {
            for (int i = 0; i < 8; i++) w[i] = 0f;
            float h = Mathf.Repeat(hueDeg, 360f);
            for (int i = 0; i < 8; i++)
            {
                float a = BandHue[i], b = i == 7 ? 360f : BandHue[i + 1];
                if (h >= a && h < b)
                {
                    float t = (h - a) / (b - a);
                    t = t * t * (3f - 2f * t);
                    w[i] = 1f - t;
                    w[(i + 1) % 8] = t;
                    return;
                }
            }
        }

        [ThreadStatic] private static float[] _w;

        private static Vector3 Bands8(Vector3 c, float[] hue, float[] sat, float[] lum)
        {
            Color.RGBToHSV(new Color(c.x, c.y, c.z), out float H, out float S, out float V);
            if (S < 1e-4f) return c; // greys have no hue
            var w = _w ?? (_w = new float[8]);
            BandWeights(H * 360f, w);
            float dh = 0f, ds = 0f, dl = 0f;
            for (int i = 0; i < 8; i++) { dh += w[i] * hue[i]; ds += w[i] * sat[i]; dl += w[i] * lum[i]; }
            H = Mathf.Repeat(H + dh * 30f / 360f, 1f); // ±30° at the ends
            S = Mathf.Clamp01(S * (1f + ds));
            var o = Color.HSVToRGB(H, S, V);
            var r = new Vector3(o.r, o.g, o.b);
            // lightness: moves the colour's brightness, more the more colourful it is (greys stay put)
            float l = Luma(r);
            float target = Mathf.Clamp01(l + dl * 0.35f * Mathf.Min(1f, S * 1.5f));
            return l > 1e-4f ? r * (target / l) : r + Vector3.one * target;
        }

        /// <summary>A tone curve through points (x, y in 0..1), smooth and never overshooting (monotone cubic).</summary>
        internal sealed class Curve
        {
            private readonly float[] _x, _y, _m;
            private Curve(float[] x, float[] y)
            {
                _x = x;
                _y = y;
                int n = x.Length;
                var d = new float[n - 1];
                for (int i = 0; i < n - 1; i++) d[i] = (y[i + 1] - y[i]) / Mathf.Max(1e-6f, x[i + 1] - x[i]);
                _m = new float[n];
                _m[0] = d[0];
                _m[n - 1] = d[n - 2];
                for (int i = 1; i < n - 1; i++) _m[i] = d[i - 1] * d[i] <= 0f ? 0f : (d[i - 1] + d[i]) / 2f;
                for (int i = 0; i < n - 1; i++)
                {
                    if (Mathf.Abs(d[i]) < 1e-6f) { _m[i] = 0f; _m[i + 1] = 0f; continue; }
                    float a = _m[i] / d[i], b = _m[i + 1] / d[i];
                    float s = a * a + b * b;
                    if (s > 9f) { float t = 3f / Mathf.Sqrt(s); _m[i] = t * a * d[i]; _m[i + 1] = t * b * d[i]; }
                }
            }

            public static Curve Parse(string s)
            {
                var pts = new List<Vector2>();
                if (!string.IsNullOrEmpty(s))
                    foreach (var p in s.Split(new[] { ' ', ';' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        var xy = p.Split(',');
                        if (xy.Length == 2 && float.TryParse(xy[0], NumberStyles.Float, CultureInfo.InvariantCulture, out float x) && float.TryParse(xy[1], NumberStyles.Float, CultureInfo.InvariantCulture, out float y))
                            pts.Add(new Vector2(Mathf.Clamp01(x), Mathf.Clamp01(y)));
                    }
                pts = pts.OrderBy(p => p.x).ToList();
                // distinct x, at least two points
                var clean = new List<Vector2>();
                foreach (var p in pts) if (clean.Count == 0 || p.x - clean[clean.Count - 1].x > 1e-4f) clean.Add(p);
                if (clean.Count < 2) clean = new List<Vector2> { new Vector2(0, 0), new Vector2(1, 1) };
                return new Curve(clean.Select(p => p.x).ToArray(), clean.Select(p => p.y).ToArray());
            }

            public float Eval(float x)
            {
                int n = _x.Length;
                if (x <= _x[0]) return _y[0];
                if (x >= _x[n - 1]) return _y[n - 1];
                int i = 0;
                while (i < n - 2 && x > _x[i + 1]) i++;
                float h = _x[i + 1] - _x[i];
                float t = (x - _x[i]) / h;
                float t2 = t * t, t3 = t2 * t;
                return Mathf.Clamp01((2 * t3 - 3 * t2 + 1) * _y[i] + (t3 - 2 * t2 + t) * h * _m[i] + (-2 * t3 + 3 * t2) * _y[i + 1] + (t3 - t2) * h * _m[i + 1]);
            }
        }
    }
}
