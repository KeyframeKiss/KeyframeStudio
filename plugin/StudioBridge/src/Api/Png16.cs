using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// A 16-bit-per-channel PNG writer (Unity 5.6 only writes 8 bits): RGB or RGBA from floats 0..1 (already in the
    /// picture's gamma), top row first, with optional text notes (tEXt) such as the settings it was made with.
    /// </summary>
    internal static class Png16
    {
        public static byte[] Encode(int width, int height, Func<int, int, int, float> sample, bool alpha, IDictionary<string, string> notes = null)
        {
            int ch = alpha ? 4 : 3;
            int stride = width * ch * 2 + 1;
            var raw = new byte[stride * height];
            for (int y = 0; y < height; y++)
            {
                int o = y * stride;
                raw[o++] = 0; // filter: none
                for (int x = 0; x < width; x++)
                    for (int c = 0; c < ch; c++)
                    {
                        float v = sample(x, y, c);
                        int q = (int)(Math.Max(0f, Math.Min(1f, v)) * 65535f + 0.5f);
                        raw[o++] = (byte)(q >> 8);
                        raw[o++] = (byte)q;
                    }
            }
            using (var ms = new MemoryStream())
            {
                ms.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
                var ihdr = new byte[13];
                BE(ihdr, 0, width);
                BE(ihdr, 4, height);
                ihdr[8] = 16;                    // bits per channel
                ihdr[9] = (byte)(alpha ? 6 : 2); // RGBA / RGB
                Chunk(ms, "IHDR", ihdr);
                if (notes != null)
                    foreach (var kv in notes)
                    {
                        var t = Encoding.GetEncoding("ISO-8859-1").GetBytes(kv.Key + "\0" + kv.Value);
                        Chunk(ms, "tEXt", t);
                    }
                Chunk(ms, "IDAT", Zlib(raw));
                Chunk(ms, "IEND", new byte[0]);
                return ms.ToArray();
            }
        }

        private static void BE(byte[] b, int at, int v)
        {
            b[at] = (byte)(v >> 24);
            b[at + 1] = (byte)(v >> 16);
            b[at + 2] = (byte)(v >> 8);
            b[at + 3] = (byte)v;
        }

        /// <summary>zlib = 2-byte header, deflate data, Adler-32 of the raw bytes.</summary>
        private static byte[] Zlib(byte[] raw)
        {
            using (var ms = new MemoryStream())
            {
                ms.WriteByte(0x78);
                ms.WriteByte(0x9C);
                long start = ms.Position;
                try
                {
                    using (var d = new DeflateStream(ms, CompressionMode.Compress, true)) d.Write(raw, 0, raw.Length);
                }
                catch (Exception)
                {
                    // the game's Mono may lack the native deflate: stored (uncompressed) blocks are valid too, just bigger
                    ms.SetLength(start);
                    ms.Position = start;
                    for (int at = 0; at < raw.Length || raw.Length == 0; at += 65535)
                    {
                        int n = Math.Min(65535, raw.Length - at);
                        ms.WriteByte((byte)(at + n >= raw.Length ? 1 : 0));
                        ms.WriteByte((byte)n);
                        ms.WriteByte((byte)(n >> 8));
                        ms.WriteByte((byte)~n);
                        ms.WriteByte((byte)(~n >> 8));
                        ms.Write(raw, at, n);
                        if (raw.Length == 0) break;
                    }
                }
                uint a = 1, b = 0;
                foreach (var x in raw)
                {
                    a = (a + x) % 65521;
                    b = (b + a) % 65521;
                }
                uint adler = (b << 16) | a;
                ms.WriteByte((byte)(adler >> 24));
                ms.WriteByte((byte)(adler >> 16));
                ms.WriteByte((byte)(adler >> 8));
                ms.WriteByte((byte)adler);
                return ms.ToArray();
            }
        }

        private static readonly uint[] Crc = MakeCrc();

        private static uint[] MakeCrc()
        {
            var t = new uint[256];
            for (uint n = 0; n < 256; n++)
            {
                uint c = n;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                t[n] = c;
            }
            return t;
        }

        private static void Chunk(Stream s, string type, byte[] data)
        {
            var len = new byte[4];
            BE(len, 0, data.Length);
            s.Write(len, 0, 4);
            var tb = Encoding.ASCII.GetBytes(type);
            s.Write(tb, 0, 4);
            s.Write(data, 0, data.Length);
            uint c = 0xFFFFFFFFu;
            foreach (var x in tb) c = Crc[(c ^ x) & 0xFF] ^ (c >> 8);
            foreach (var x in data) c = Crc[(c ^ x) & 0xFF] ^ (c >> 8);
            c ^= 0xFFFFFFFFu;
            var cb = new byte[4];
            BE(cb, 0, (int)c);
            s.Write(cb, 0, 4);
        }
    }
}
