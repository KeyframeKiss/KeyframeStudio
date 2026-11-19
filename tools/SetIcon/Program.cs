using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

// SetIcon <exe> <ico> [<version> <product name> <description>]
// Replaces the exe's main icon with the .ico's images, using Windows' own resource functions
// (BeginUpdateResource / UpdateResource / EndUpdateResource). The existing icon group keeps its
// name and language, so Explorer, the taskbar and shortcuts all pick the new one up.
// With the extra arguments it also writes the version information (Task Manager, Properties → Details).
internal static class Program
{
    private const int RT_ICON = 3, RT_GROUP_ICON = 14, RT_VERSION = 16;
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32", SetLastError = true)] private static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32", SetLastError = true)] private static extern bool EndUpdateResource(IntPtr h, bool discard);
    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32")] private static extern bool FreeLibrary(IntPtr h);
    private delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    private delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort lang, IntPtr param);
    [DllImport("kernel32")] private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc proc, IntPtr param);
    [DllImport("kernel32")] private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc proc, IntPtr param);

    private static int Main(string[] args)
    {
        if (args.Length != 2 && args.Length != 5) { Console.Error.WriteLine("usage: SetIcon <exe> <ico> [<version> <product name> <description>]"); return 2; }
        string exe = Path.GetFullPath(args[0]), ico = Path.GetFullPath(args[1]);

        // the .ico: header, then a 16-byte entry per image
        var icon = File.ReadAllBytes(ico);
        int count = BitConverter.ToUInt16(icon, 4);
        if (BitConverter.ToUInt16(icon, 2) != 1 || count == 0) { Console.Error.WriteLine("not an .ico"); return 1; }

        // the exe's current main icon group (name + language), and the icon ids already in use
        IntPtr groupName = (IntPtr)1;
        string groupString = null;
        ushort lang = 1033;
        int maxIconId = 0;
        var mod = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (mod != IntPtr.Zero)
        {
            bool first = true;
            EnumResourceNames(mod, (IntPtr)RT_GROUP_ICON, (m, t, n, p) =>
            {
                if (!first) return false;
                first = false;
                if (((long)n >> 16) == 0) groupName = n; else groupString = Marshal.PtrToStringUni(n);
                EnumResourceLanguages(m, t, n, (m2, t2, n2, l, p2) => { lang = l; return false; }, IntPtr.Zero);
                return false;
            }, IntPtr.Zero);
            EnumResourceNames(mod, (IntPtr)RT_ICON, (m, t, n, p) => { if (((long)n >> 16) == 0) maxIconId = Math.Max(maxIconId, (int)n); return true; }, IntPtr.Zero);
            FreeLibrary(mod);
        }

        var h = BeginUpdateResource(exe, false);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("can't open the exe: " + Marshal.GetLastWin32Error()); return 1; }

        // each image as an RT_ICON (new ids after the existing ones, so nothing old is half-overwritten),
        // and an RT_GROUP_ICON listing them (14-byte entries: the .ico entry with its offset replaced by the id)
        var group = new List<byte>();
        group.AddRange(new byte[] { 0, 0, 1, 0 });
        group.AddRange(BitConverter.GetBytes((ushort)count));
        for (int i = 0; i < count; i++)
        {
            int e = 6 + 16 * i;
            int size = BitConverter.ToInt32(icon, e + 8), offset = BitConverter.ToInt32(icon, e + 12);
            var image = new byte[size];
            Buffer.BlockCopy(icon, offset, image, 0, size);
            ushort id = (ushort)(maxIconId + 1 + i);
            if (!UpdateResource(h, (IntPtr)RT_ICON, (IntPtr)id, lang, image, (uint)size)) return Fail(h, "icon image");
            group.AddRange(new[] { icon[e], icon[e + 1], icon[e + 2], (byte)0 });
            group.AddRange(BitConverter.GetBytes((ushort)1)); // planes
            group.AddRange(BitConverter.GetBytes(BitConverter.ToUInt16(icon, e + 6) == 0 ? (ushort)32 : BitConverter.ToUInt16(icon, e + 6)));
            group.AddRange(BitConverter.GetBytes(size));
            group.AddRange(BitConverter.GetBytes(id));
        }
        var g = group.ToArray();
        IntPtr namePtr = groupName;
        if (groupString != null) namePtr = Marshal.StringToHGlobalUni(groupString);
        bool ok = UpdateResource(h, (IntPtr)RT_GROUP_ICON, namePtr, lang, g, (uint)g.Length);
        if (groupString != null) Marshal.FreeHGlobal(namePtr);
        if (!ok) return Fail(h, "icon group");
        if (args.Length == 5)
        {
            var info = VersionInfo(args[2], args[3], args[4], Path.GetFileName(exe));
            if (!UpdateResource(h, (IntPtr)RT_VERSION, (IntPtr)1, lang, info, (uint)info.Length)) return Fail(h, "version information");
        }
        if (!EndUpdateResource(h, false)) { Console.Error.WriteLine("couldn't write the exe: " + Marshal.GetLastWin32Error()); return 1; }
        Console.WriteLine($"icon set: {count} images, group {(groupString ?? ((long)groupName).ToString())}, language {lang}");
        return 0;
    }

    // ------------------------------------------------------------------ VS_VERSIONINFO

    /// <summary>One block: length, value length, type, key, padding, value, padding, children (each 32-bit aligned).</summary>
    private static byte[] Block(string key, byte[] value, ushort valueLength, ushort type, params byte[][] children)
    {
        var b = new List<byte>();
        b.AddRange(new byte[6]); // filled in below
        b.AddRange(System.Text.Encoding.Unicode.GetBytes(key + "\0"));
        while (b.Count % 4 != 0) b.Add(0);
        if (value != null) b.AddRange(value);
        foreach (var c in children)
        {
            while (b.Count % 4 != 0) b.Add(0);
            b.AddRange(c);
        }
        var a = b.ToArray();
        BitConverter.GetBytes((ushort)a.Length).CopyTo(a, 0);
        BitConverter.GetBytes(valueLength).CopyTo(a, 2);
        BitConverter.GetBytes(type).CopyTo(a, 4);
        return a;
    }

    private static byte[] Str(string key, string value)
    {
        var v = System.Text.Encoding.Unicode.GetBytes(value + "\0");
        return Block(key, v, (ushort)(value.Length + 1), 1);
    }

    private static byte[] VersionInfo(string version, string product, string description, string file)
    {
        var parts = (version + ".0.0.0").Split('.');
        ushort P(int i) => ushort.TryParse(parts[i], out var n) ? n : (ushort)0;
        uint ms = (uint)(P(0) << 16 | P(1)), ls = (uint)(P(2) << 16 | P(3));
        var fixedInfo = new List<byte>();
        foreach (var u in new uint[] { 0xFEEF04BD, 0x00010000, ms, ls, ms, ls, 0x3F, 0, 0x00040004, 1, 0, 0, 0 })
            fixedInfo.AddRange(BitConverter.GetBytes(u));
        var table = Block("040904B0", null, 0, 1,
            Str("CompanyName", product),
            Str("FileDescription", description),
            Str("FileVersion", version),
            Str("InternalName", product),
            Str("LegalCopyright", ""),
            Str("OriginalFilename", file),
            Str("ProductName", product),
            Str("ProductVersion", version));
        var strings = Block("StringFileInfo", null, 0, 1, table);
        var translation = Block("Translation", BitConverter.GetBytes(0x04B00409u), 4, 0);
        var vars = Block("VarFileInfo", null, 0, 1, translation);
        return Block("VS_VERSION_INFO", fixedInfo.ToArray(), 52, 0, strings, vars);
    }

    private static int Fail(IntPtr h, string what)
    {
        Console.Error.WriteLine($"couldn't write the {what}: {Marshal.GetLastWin32Error()}");
        EndUpdateResource(h, true);
        return 1;
    }
}
