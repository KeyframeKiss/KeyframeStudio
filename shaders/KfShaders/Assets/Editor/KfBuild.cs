using System.IO;
using UnityEditor;
using UnityEngine;

/// <summary>Builds the shader bundle the bridge plugin embeds. Run by tools/build-shaders.mjs (Unity 5.6.2f1, batch mode).</summary>
public static class KfBuild
{
    public static void Build()
    {
        const string outDir = "Build";
        Directory.CreateDirectory(outDir);
        var shaders = Directory.GetFiles("Assets/Shaders", "*.shader");
        var build = new AssetBundleBuild { assetBundleName = "kfeffects", assetNames = shaders };
        var manifest = BuildPipeline.BuildAssetBundles(outDir, new[] { build }, BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.ForceRebuildAssetBundle, BuildTarget.StandaloneWindows64);
        if (manifest == null) throw new System.Exception("Bundle build failed");
        foreach (var s in shaders)
        {
            var sh = AssetDatabase.LoadAssetAtPath<Shader>(s);
            if (sh == null || !sh.isSupported) throw new System.Exception("Shader failed to compile: " + s);
            Debug.Log("KF shader ok: " + sh.name);
        }
        Debug.Log("KF bundle built: " + Path.GetFullPath(Path.Combine(outDir, "kfeffects")));
    }
}
