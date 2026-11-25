using HarmonyLib;
using StudioEX.Bridge.Api;

namespace StudioEX.Bridge
{
    internal static class Hooks
    {
        /// <summary>New/loaded scene: drop undo history that references the old scene's tracks.</summary>
        [HarmonyPostfix, HarmonyPatch(typeof(Studio.Studio), nameof(Studio.Studio.InitScene))]
        private static void InitScenePostfix()
        {
            // Never let our bookkeeping break Studio's own scene load.
            SceneApi.CurrentFile = null;
            SceneApi.CurrentPath = null;
            Try(UndoStack.Clear);
            Try(TimelineApi.ResetVolatility);
            Try(TimelineApi.PruneDeadTracks); // Timeline keeps old tracks when the next scene has no Timeline data
            Try(CameraApi.ClearThumbs);
            Try(FaceApi.ClearCache);
            Try(PoseApi.ForgetPreview); // the previewed characters are gone with the old scene
            Try(AudioTrack.Clear); // a loaded scene brings its own audio back afterwards (KKAPI scene data)
            Try(ShotApi.Clear);
            Try(FxApi.Clear);
            Try(() => CameraTools.Instance?.Clear()); // a loaded scene brings its own effects back afterwards (KKAPI scene data)
            Try(() => ViewportTools.Instance?.ClearAll());
            Try(() => StudioBridgePlugin.Instance?.Broadcast("scene.reset", null));
        }

        [HarmonyPostfix, HarmonyPatch(typeof(Studio.SceneInfo), nameof(Studio.SceneInfo.Load), new[] { typeof(string) })]
        private static void Loaded(Studio.SceneInfo __instance, string __0, bool __result)
        {
            if (__result) Try(() => SetSceneFile(__instance, __0, false));
        }

        /// <summary>A light just added with Studio's Add › Light: it lights characters too (unless switched off in settings).</summary>
        [HarmonyPostfix, HarmonyPatch(typeof(Studio.AddObjectLight), nameof(Studio.AddObjectLight.Add), new[] { typeof(int) })]
        private static void LightAdded(Studio.OCILight __result) =>
            Try(() =>
            {
                if (__result == null || !(LightsApi.NewLightsChara?.Value ?? true)) return;
                LightsApi.ApplyLightsChara(__result, true);
                FxApi.EnsureCharaLight();
            });

        [HarmonyPrefix, HarmonyPatch(typeof(Studio.SceneInfo), nameof(Studio.SceneInfo.Save), new[] { typeof(string) })]
        private static void Saving() => Try(() => Api.CameraTools.Instance?.BeforeSave());

        [HarmonyPostfix, HarmonyPatch(typeof(Studio.SceneInfo), nameof(Studio.SceneInfo.Save), new[] { typeof(string) })]
        private static void Saved(Studio.SceneInfo __instance, string __0, bool __result)
        {
            Try(() => Api.CameraTools.Instance?.AfterSave());
            if (__result) Try(() => SetSceneFile(__instance, __0, true));
        }

        private static void SetSceneFile(Studio.SceneInfo info, string path, bool saved)
        {
            if (info != SceneApi.Studio.sceneInfo) return;
            SceneApi.CurrentFile = System.IO.Path.GetFileName(path);
            try { SceneApi.CurrentPath = System.IO.Path.GetFullPath(path); } catch { SceneApi.CurrentPath = null; }
            if (saved) SceneApi.SaveCount++;
            StudioBridgePlugin.Instance?.Broadcast("scene.file", SceneApi.CurrentFile);
        }

        // A character saved with FK and IK both on (posed in the viewport: a limb in IK, the rest in FK) — Studio's
        // loader turns IK off whenever FK is on, which would drop those limbs back to old FK values. Put IK back.

        [HarmonyPrefix, HarmonyPatch(typeof(Studio.AddObjectFemale), "Add", new[] { typeof(ChaControl), typeof(Studio.OICharInfo), typeof(Studio.ObjectCtrlInfo), typeof(Studio.TreeNodeObject), typeof(bool), typeof(int) })]
        private static void FemaleLoading(Studio.OICharInfo _info, out bool[] __state) => __state = Both(_info);

        [HarmonyPostfix, HarmonyPatch(typeof(Studio.AddObjectFemale), "Add", new[] { typeof(ChaControl), typeof(Studio.OICharInfo), typeof(Studio.ObjectCtrlInfo), typeof(Studio.TreeNodeObject), typeof(bool), typeof(int) })]
        private static void FemaleLoaded(Studio.OCICharFemale __result, bool[] __state) { if (__state != null && __result != null) Try(() => ViewportGizmos.KeepFkAndIk(__result, __state)); }

        [HarmonyPrefix, HarmonyPatch(typeof(Studio.AddObjectMale), "Add", new[] { typeof(ChaControl), typeof(Studio.OICharInfo), typeof(Studio.ObjectCtrlInfo), typeof(Studio.TreeNodeObject), typeof(bool), typeof(int) })]
        private static void MaleLoading(Studio.OICharInfo _info, out bool[] __state) => __state = Both(_info);

        [HarmonyPostfix, HarmonyPatch(typeof(Studio.AddObjectMale), "Add", new[] { typeof(ChaControl), typeof(Studio.OICharInfo), typeof(Studio.ObjectCtrlInfo), typeof(Studio.TreeNodeObject), typeof(bool), typeof(int) })]
        private static void MaleLoaded(Studio.OCICharMale __result, bool[] __state) { if (__state != null && __result != null) Try(() => ViewportGizmos.KeepFkAndIk(__result, __state)); }

        [HarmonyPrefix, HarmonyPatch(typeof(Studio.OCIChar), nameof(Studio.OCIChar.ChangeChara))]
        private static void Swapping(Studio.OCIChar __instance, out bool[] __state) => __state = Both(__instance?.oiCharInfo);

        [HarmonyPostfix, HarmonyPatch(typeof(Studio.OCIChar), nameof(Studio.OCIChar.ChangeChara))]
        private static void Swapped(Studio.OCIChar __instance, bool[] __state) { if (__state != null) Try(() => ViewportGizmos.KeepFkAndIk(__instance, __state)); }

        /// <summary>The FK parts a character was saved with, when it had FK and IK both on (else null).</summary>
        private static bool[] Both(Studio.OICharInfo info) => info != null && info.enableFK && info.enableIK && info.activeFK != null ? (bool[])info.activeFK.Clone() : null;

        // Studio applies FK after IK each frame: with both on, the spine / shoulder turns would carry an IK limb off
        // its target — so IK solves once more right after FK.
        [HarmonyPostfix, HarmonyPatch(typeof(Studio.FKCtrl), "LateUpdate")]
        private static void FkApplied(Studio.FKCtrl __instance) => ViewportGizmos.AfterFk(__instance);

        // A clip whose controller has to be loaded only becomes the animator's current state at its next update. Timeline
        // sets "Animation Time" on the current state straight after switching clips, which would land on the new
        // controller's default state instead — another clip. Making the requested state current at once avoids that.
        [HarmonyPostfix, HarmonyPatch(typeof(Studio.OCIChar), nameof(Studio.OCIChar.LoadAnime))]
        private static void AnimeLoaded(Studio.OCIChar __instance)
        {
            var an = __instance?.charAnimeCtrl?.animator;
            if (an != null && an.isActiveAndEnabled && an.runtimeAnimatorController != null) Try(() => an.Update(0f));
        }

        private static void Try(System.Action a)
        {
            try { a(); }
            catch (System.Exception e) { StudioBridgePlugin.Logger.LogWarning("InitScene hook: " + e.Message); }
        }
    }
}
