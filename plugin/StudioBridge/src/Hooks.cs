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

        private static void Try(System.Action a)
        {
            try { a(); }
            catch (System.Exception e) { StudioBridgePlugin.Logger.LogWarning("InitScene hook: " + e.Message); }
        }
    }
}
