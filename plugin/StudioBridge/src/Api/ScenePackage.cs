using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Moving a scene to another PC: what the open scene uses from outside its own file — the audio WAVs, and the
    /// Motion builder's poses and motion clips. The app packs these with the saved scene into one zip (and unpacks
    /// one into the right folders); the bridge only says which files, relative to the game folder.
    /// </summary>
    internal static class ScenePackage
    {
        public static void Register(CommandRouter r) => r.Add("package.collect", a => Collect());

        private static string GameDir => Path.GetFullPath(Path.Combine(UserData.Path, ".."));

        /// <summary>A path inside the game folder as "UserData/…" (forward slashes), or null when it's elsewhere.</summary>
        internal static string Rel(string abs)
        {
            if (string.IsNullOrEmpty(abs)) return null;
            string full = Path.GetFullPath(abs), root = GameDir.TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? full.Substring(root.Length).Replace('\\', '/') : null;
        }

        private static object Collect()
        {
            var files = new List<object>();
            var missing = new List<object>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            void Add(string abs, string what)
            {
                if (string.IsNullOrEmpty(abs) || !seen.Add(abs)) return;
                string rel = Rel(abs);
                if (!File.Exists(abs) || rel == null) { missing.Add(new Dictionary<string, object> { { "path", abs }, { "what", what } }); return; }
                files.Add(new Dictionary<string, object> { { "path", abs }, { "rel", rel }, { "what", what }, { "size", new FileInfo(abs).Length } });
            }
            foreach (var f in AudioTrack.UsedFiles()) Add(f, "audio");
            if (TimelineApi.Available) foreach (var kv in MotionFiles()) Add(kv.Key, kv.Value);
            string scene = SceneApi.CurrentPath;
            return new Dictionary<string, object>
            {
                { "scene", scene != null && File.Exists(scene) ? scene : null },
                { "sceneRel", Rel(scene) },
                { "gameDir", GameDir },
                { "files", files },
                { "missing", missing },
            };
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static List<KeyValuePair<string, string>> MotionFiles() => TimelineImpl.MotionUsedFiles();
    }
}
