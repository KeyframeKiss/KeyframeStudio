using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// A starter set of LUT files, made by Keyframe Studio itself (so they can ship with it): written once into
    /// UserData/StudioEX/luts/Keyframe Studio as 33³ .cube files. A marker file remembers it was done, so deleting one
    /// keeps it deleted; files already there are never overwritten. Each look works on colour as a picture file holds it.
    /// </summary>
    internal static class StarterLuts
    {
        private const int N = 33;

        private static readonly KeyValuePair<string, Func<Vector3, Vector3>>[] Looks =
        {
            Look("Teal and orange", c =>
            {
                c = Contrast(c, 1.08f);
                float l = Luma(c);
                c = Tint(c, new Vector3(0.0f, 0.55f, 0.62f), 0.28f * (1 - Smooth(0.15f, 0.6f, l)));   // teal shadows
                c = Tint(c, new Vector3(1.0f, 0.6f, 0.3f), 0.22f * Smooth(0.45f, 0.95f, l));         // orange highlights
                return Saturate(c, 1.1f);
            }),
            Look("Warm film", c =>
            {
                c = Mul(c, new Vector3(1.04f, 1.0f, 0.92f));
                c = Shoulder(c, 0.9f);
                c = Lift(c, 0.03f);
                return Saturate(Contrast(c, 1.05f), 0.95f);
            }),
            Look("Cool night", c =>
            {
                c = Mul(c, new Vector3(0.82f, 0.92f, 1.08f)) * 0.85f;
                float l = Luma(c);
                c = Tint(c, new Vector3(0.2f, 0.35f, 0.75f), 0.25f * (1 - l));
                return Saturate(Contrast(c, 1.05f), 0.75f);
            }),
            Look("Bleach bypass", c =>
            {
                float l = Luma(c);
                var o = new Vector3(Overlay(c.x, l), Overlay(c.y, l), Overlay(c.z, l));
                return Saturate(Vector3.Lerp(c, o, 0.7f), 0.45f);
            }),
            Look("Black and white", c =>
            {
                // like a red filter on film: skin bright, skies darker
                float g = Vector3.Dot(c, new Vector3(0.42f, 0.46f, 0.12f));
                g = SCurve(g, 0.18f);
                return new Vector3(g, g, g);
            }),
            Look("Sepia", c =>
            {
                float g = SCurve(Vector3.Dot(c, new Vector3(0.3f, 0.59f, 0.11f)), 0.1f);
                var s = new Vector3(g * 1.07f, g * 0.95f, g * 0.78f);
                return Lift(s, 0.03f);
            }),
            Look("Faded vintage", c =>
            {
                c = Saturate(c, 0.72f);
                c = Mul(c, new Vector3(1.03f, 1.01f, 0.9f));
                c = Shoulder(c, 0.92f);
                c = Lift(c, 0.06f);
                return Tint(c, new Vector3(0.45f, 0.6f, 0.4f), 0.08f * (1 - Luma(c)));
            }),
            Look("Pastel", c =>
            {
                c = Lift(Contrast(c, 0.92f), 0.04f);
                c = Saturate(c, 0.85f);
                float l = Luma(c);
                return Tint(c, new Vector3(1.0f, 0.75f, 0.85f), 0.12f * l);
            }),
            Look("Golden hour", c =>
            {
                c = Mul(c, new Vector3(1.08f, 0.98f, 0.82f));
                float l = Luma(c);
                c = Tint(c, new Vector3(1.0f, 0.7f, 0.35f), 0.18f * Smooth(0.3f, 0.9f, l));
                return Saturate(Shoulder(Contrast(c, 1.04f), 0.94f), 1.08f);
            }),
            Look("Matte", c => Lift(Shoulder(Contrast(c, 1.04f), 0.92f), 0.045f)),
        };

        private static KeyValuePair<string, Func<Vector3, Vector3>> Look(string name, Func<Vector3, Vector3> f) =>
            new KeyValuePair<string, Func<Vector3, Vector3>>(name, f);

        /// <summary>Writes the set once (and only files that aren't there).</summary>
        public static void EnsureMade(string folder)
        {
            string marker = Path.Combine(folder, ".keyframe-studio-starters");
            if (File.Exists(marker)) return;
            try
            {
                string dir = Path.Combine(folder, "Keyframe Studio");
                Directory.CreateDirectory(dir);
                foreach (var look in Looks)
                {
                    string file = Path.Combine(dir, look.Key + ".cube");
                    if (!File.Exists(file)) File.WriteAllText(file, Cube(look.Key, look.Value), new UTF8Encoding(false));
                }
                File.WriteAllText(marker, "Keyframe Studio's starter LUTs were made here once; delete this file to make any missing ones again.");
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Starter LUTs not written: " + e.Message); }
        }

        private static string Cube(string title, Func<Vector3, Vector3> f)
        {
            var sb = new StringBuilder(N * N * N * 26);
            sb.Append("TITLE \"").Append(title).Append("\"\n");
            sb.Append("# Made by Keyframe Studio\n");
            sb.Append("LUT_3D_SIZE ").Append(N).Append('\n');
            for (int b = 0; b < N; b++)
                for (int g = 0; g < N; g++)
                    for (int r = 0; r < N; r++)
                    {
                        var o = f(new Vector3(r / (N - 1f), g / (N - 1f), b / (N - 1f)));
                        sb.Append(Mathf.Clamp01(o.x).ToString("0.000000", CultureInfo.InvariantCulture)).Append(' ')
                          .Append(Mathf.Clamp01(o.y).ToString("0.000000", CultureInfo.InvariantCulture)).Append(' ')
                          .Append(Mathf.Clamp01(o.z).ToString("0.000000", CultureInfo.InvariantCulture)).Append('\n');
                    }
            return sb.ToString();
        }

        // ---- small colour tools (0..1, as in a picture file) ----
        private static float Luma(Vector3 c) => 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z;
        private static Vector3 Mul(Vector3 c, Vector3 m) => new Vector3(c.x * m.x, c.y * m.y, c.z * m.z);
        private static Vector3 Saturate(Vector3 c, float s) { float l = Luma(c); return Vector3.one * l + (c - Vector3.one * l) * s; }
        private static Vector3 Contrast(Vector3 c, float k) => (c - Vector3.one * 0.5f) * k + Vector3.one * 0.5f;
        private static Vector3 Lift(Vector3 c, float a) => Vector3.one * a + c * (1 - a);           // black isn't black: faded
        private static Vector3 Shoulder(Vector3 c, float top) => new Vector3(Soft(c.x, top), Soft(c.y, top), Soft(c.z, top));
        /// <summary>Highlights roll off gently to <paramref name="top"/>; shadows and midtones (below 0.55) untouched.</summary>
        private static float Soft(float x, float top)
        {
            const float knee = 0.55f;
            if (x <= knee) return x;
            float range = top - knee, t = (x - knee) / (1f - knee);
            return knee + range * (1f - Mathf.Exp(-t * 2.2f)) / (1f - Mathf.Exp(-2.2f));
        }
        private static float Smooth(float a, float b, float x) { float t = Mathf.Clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
        private static float SCurve(float x, float k) => Mathf.Clamp01(x + k * (x - 0.5f) * (1 - Mathf.Abs(2 * x - 1)) * 2f);
        private static float Overlay(float a, float b) => a < 0.5f ? 2f * a * b : 1f - 2f * (1f - a) * (1f - b);

        /// <summary>Tint toward a colour, keeping brightness.</summary>
        private static Vector3 Tint(Vector3 c, Vector3 col, float amount)
        {
            float l = Luma(c);
            var t = Vector3.Lerp(c, col * (l / Mathf.Max(0.05f, Luma(col))), Mathf.Clamp01(amount));
            return t + Vector3.one * (l - Luma(t));
        }
    }
}
