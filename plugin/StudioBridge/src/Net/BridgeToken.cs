using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace StudioEX.Bridge.Net
{
    /// <summary>
    /// The secret every connection must present. Browsers let any web page open a WebSocket to 127.0.0.1 (CORS
    /// doesn't apply, and an Origin check alone can be dodged with a sandboxed iframe's "null" origin), so the
    /// bridge only talks to clients that can read this file: Keyframe Studio and local tools running as the same
    /// Windows user. It lives in the app's own data folder (%APPDATA%\studio-ex\bridge-token), made once and kept.
    /// </summary>
    internal static class BridgeToken
    {
        public static string FilePath =>
            Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "studio-ex"), "bridge-token");

        private static string _token;

        public static string Value
        {
            get
            {
                if (_token != null) return _token;
                try
                {
                    if (File.Exists(FilePath))
                    {
                        var t = File.ReadAllText(FilePath).Trim();
                        if (t.Length >= 32) return _token = t;
                    }
                }
                catch { /* make a new one */ }
                var bytes = new byte[32];
                new RNGCryptoServiceProvider().GetBytes(bytes); // (not IDisposable in .NET 3.5)
                var sb = new StringBuilder(64);
                foreach (var b in bytes) sb.Append(b.ToString("x2"));
                _token = sb.ToString();
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                    File.WriteAllText(FilePath, _token);
                }
                catch (Exception e) { StudioBridgePlugin.Logger?.LogWarning("Couldn't save the bridge token (" + e.Message + ") — Keyframe Studio won't be able to connect"); }
                return _token;
            }
        }

        /// <summary>Compares in constant time (no early exit that would leak how much of a guess was right).</summary>
        public static bool Matches(string candidate)
        {
            var expected = Value;
            if (candidate == null || candidate.Length != expected.Length) return false;
            int diff = 0;
            for (int i = 0; i < expected.Length; i++) diff |= candidate[i] ^ expected[i];
            return diff == 0;
        }

        /// <summary>The token from a request line's query: "GET /?token=abc HTTP/1.1".</summary>
        public static string FromRequestLine(string line)
        {
            if (string.IsNullOrEmpty(line)) return null;
            var parts = line.Split(' ');
            if (parts.Length < 2) return null;
            int q = parts[1].IndexOf('?');
            if (q < 0) return null;
            foreach (var kv in parts[1].Substring(q + 1).Split('&'))
            {
                int eq = kv.IndexOf('=');
                if (eq > 0 && kv.Substring(0, eq) == "token") return Uri.UnescapeDataString(kv.Substring(eq + 1));
            }
            return null;
        }
    }
}
