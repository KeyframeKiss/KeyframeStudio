using System;
using System.IO;

namespace StudioEX.Bridge.Net
{
    internal static class SafePaths
    {
        /// <summary>
        /// Whether a path is inside a folder, after resolving "..", "." and separators — a plain StartsWith would
        /// accept "…\pose\..\..\elsewhere" and a sibling like "…\pose-other".
        /// </summary>
        public static bool IsInside(string path, string folder)
        {
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(folder)) return false;
            try
            {
                var full = Path.GetFullPath(path);
                var root = Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                return full.StartsWith(root, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }
    }
}
