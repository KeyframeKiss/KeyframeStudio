using System;
using HarmonyLib;
using UnityEngine;
using TL = Timeline.Timeline;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// A free work camera while the edit plays: with Play the edit on and "In Studio's view too" off, Timeline's camera
    /// keys no longer move Studio's view. Timeline still works the camera out every frame (and on every seek); right
    /// after, that keyed camera is kept for the monitor and the viewport's camera marker, and Studio's view is put back
    /// where the user has it — so they can fly around while it plays. Renders, stills and our own camera tools that
    /// need the keyed camera in Studio's view hold it off (<see cref="Hold"/>).
    /// </summary>
    internal static class FreeView
    {
        private static bool _patched;
        private static int _hold;

        /// <summary>Where Timeline's camera keys put the camera at the playhead (the last time they were applied).</summary>
        public static bool HasKeyed;
        public static Vector3 KeyedPivot, KeyedDist;
        public static Quaternion KeyedRot = Quaternion.identity;
        public static float KeyedFov;
        public static Vector3 KeyedEye => KeyedPivot + KeyedRot * KeyedDist;

        public static bool On => ShotApi.FreeViewWanted && _hold == 0 && Time.captureFramerate == 0 && !StillsApi.Capturing && !DirectRender.Recording && !RenderBusy();

        private static bool RenderBusy()
        {
            try { return RenderApi.Busy(); } catch { return false; }
        }

        /// <summary>using (FreeView.Hold()) { … } — camera keys move Studio's view inside (camera moves, bakes).</summary>
        public static IDisposable Hold() => new Holder();

        private sealed class Holder : IDisposable
        {
            private bool _done;
            public Holder() { _hold++; }
            public void Dispose()
            {
                if (_done) return;
                _done = true;
                _hold--;
            }
        }

        public static void EnsurePatched()
        {
            if (_patched || !TimelineApi.Available) return;
            _patched = true;
            try { PatchImpl(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Free work camera unavailable: " + e.Message); }
        }

        private static void PatchImpl()
        {
            var m = AccessTools.Method(typeof(TL), "Interpolate", new[] { typeof(bool) }) ?? throw new Exception("Timeline.Interpolate not found");
            new Harmony(StudioBridgePlugin.GUID + ".freeview").Patch(m,
                prefix: new HarmonyMethod(typeof(FreeView), nameof(Prefix)),
                postfix: new HarmonyMethod(typeof(FreeView), nameof(Postfix)));
        }

        private sealed class Saved
        {
            public Studio.CameraControl.CameraData Data;
            public float Fov;
        }

        // Timeline interpolates in two passes; camera tracks apply in the first ("before"), so only that one counts
        private static void Prefix(bool before, out Saved __state)
        {
            __state = null;
            try
            {
                if (!before || !On) return;
                var cc = Singleton<Studio.Studio>.Instance?.cameraCtrl;
                if (cc == null || Singleton<Studio.Studio>.Instance.ociCamera != null) return;
                __state = new Saved { Data = cc.Export(), Fov = cc.fieldOfView };
            }
            catch { __state = null; }
        }

        private static void Postfix(Saved __state)
        {
            if (__state == null) return;
            try
            {
                var cc = Singleton<Studio.Studio>.Instance?.cameraCtrl;
                if (cc == null) return;
                var keyed = cc.Export();
                float fov = cc.fieldOfView;
                bool moved = (keyed.pos - __state.Data.pos).sqrMagnitude > 1e-10f || (keyed.rotate - __state.Data.rotate).sqrMagnitude > 1e-8f
                    || (keyed.distance - __state.Data.distance).sqrMagnitude > 1e-10f || Mathf.Abs(fov - __state.Fov) > 1e-4f;
                // what Timeline's camera keys made of the camera (unchanged when the keys say "where it is")
                HasKeyed = true;
                KeyedPivot = keyed.pos;
                KeyedRot = Quaternion.Euler(keyed.rotate);
                KeyedDist = keyed.distance;
                KeyedFov = fov;
                if (!moved) return;
                cc.Import(__state.Data);
                cc.fieldOfView = __state.Fov;
            }
            catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("Free work camera: " + e.Message); }
        }

        /// <summary>A new scene: no keyed camera known yet.</summary>
        public static void Clear() => HasKeyed = false;
    }
}
