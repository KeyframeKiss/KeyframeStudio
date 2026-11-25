using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Camera tools: Studio's 10 saved camera slots (with thumbnails), scene camera objects,
    /// viewport snapshots, and keying the main camera onto the timeline ("shots"/cuts).
    /// </summary>
    internal static class CameraApi
    {
        // Thumbnails we've captured this session, by slot index and by shot time.
        private static readonly Dictionary<int, string> SlotThumbs = new Dictionary<int, string>();
        internal static readonly Dictionary<float, string> ShotThumbs = new Dictionary<float, string>();

        internal static void SetSlotThumb(int i, string thumb) => SlotThumbs[i] = thumb;
        internal static void ClearSlotThumb(int i) => SlotThumbs.Remove(i);

        /// <summary>Thumbnails belong to the scene they were taken in.</summary>
        public static void ClearThumbs()
        {
            SlotThumbs.Clear();
            ShotThumbs.Clear();
        }

        public static void Register(CommandRouter r)
        {
            r.Add("camera.get", a => Get());
            // which saved views (0–9) the camera is at right now (several can hold the same view) — polled by the app
            r.Add("camera.activeSlot", a => ActiveSlots());
            r.Add("camera.saveSlot", a =>
            {
                int i = Slot(a);
                var s = SceneApi.Studio;
                s.sceneInfo.cameraData[i].Copy(s.cameraCtrl.Export());
                var thumb = Snapshot(a.GetInt("width", 256));
                if (thumb != null) SlotThumbs[i] = thumb;
                return Get();
            });
            r.Add("camera.loadSlot", a =>
            {
                int i = Slot(a);
                var s = SceneApi.Studio;
                s.cameraCtrl.Import(s.sceneInfo.cameraData[i]);
                return true;
            });
            r.Add("camera.snapshot", a =>
            {
                // Optional one-off viewpoint (from → lookAt): the camera is moved only for this render.
                var from = a.GetList("from");
                var look = a.GetList("lookAt");
                var cam = Camera.main;
                if (cam == null || from.Count < 3 || look.Count < 3) return Snapshot(a.GetInt("width", 320));
                var pos = cam.transform.position;
                var rot = cam.transform.rotation;
                try
                {
                    var f = new Vector3(Convert.ToSingle(from[0]), Convert.ToSingle(from[1]), Convert.ToSingle(from[2]));
                    var l = new Vector3(Convert.ToSingle(look[0]), Convert.ToSingle(look[1]), Convert.ToSingle(look[2]));
                    cam.transform.position = f;
                    cam.transform.rotation = Quaternion.LookRotation(l - f);
                    return Snapshot(a.GetInt("width", 320));
                }
                finally
                {
                    cam.transform.position = pos;
                    cam.transform.rotation = rot;
                }
            });
            r.Add("camera.view", a =>
            {
                var s = SceneApi.Studio;
                int id = a.GetInt("id", -1);
                if (id < 0) s.ChangeCamera(null, false, true);
                else if (SceneApi.FindOci(id) is OCICamera cam) s.ChangeCamera(cam, true);
                else throw new BridgeException("That object is not a camera");
                return Get();
            });
            r.Add("camera.mean", a => Mean(a.GetInt("width", 96)));
            r.Add("camera.setFov", a => { SceneApi.Studio.cameraCtrl.fieldOfView = Mathf.Clamp(a.GetFloat("fov", 23f), 1f, 179f); return Get(); });
            r.Add("camera.key", a => KeyCamera(a));
            r.Add("camera.shots", a => Shots());
        }

        private static int Slot(Dictionary<string, object> a)
        {
            int i = a.GetInt("index");
            if (i < 0 || i >= 10) throw new BridgeException("Camera slot must be 1–10");
            return i;
        }

        /// <summary>A slot holds a view of its own (empty slots hold Studio's reset view).</summary>
        internal static bool Used(Studio.CameraControl.CameraData d, Studio.CameraControl.CameraData reset) =>
            (d.pos - reset.pos).sqrMagnitude > 1e-6f || (d.rotate - reset.rotate).sqrMagnitude > 1e-6f ||
            (d.distance - reset.distance).sqrMagnitude > 1e-6f || Mathf.Abs(d.parse - reset.parse) > 1e-3f;

        /// <summary>The saved views the camera matches (position, angles, distance, field of view).</summary>
        private static List<object> ActiveSlots()
        {
            var hits = new List<object>();
            var s = SceneApi.Studio;
            var now = s.cameraCtrl.Export();
            var reset = s.cameraCtrl.ExportResetData();
            bool Same(Studio.CameraControl.CameraData a, Studio.CameraControl.CameraData b) =>
                (a.pos - b.pos).sqrMagnitude < 1e-6f &&
                Mathf.Abs(Mathf.DeltaAngle(a.rotate.x, b.rotate.x)) < 0.05f &&
                Mathf.Abs(Mathf.DeltaAngle(a.rotate.y, b.rotate.y)) < 0.05f &&
                Mathf.Abs(Mathf.DeltaAngle(a.rotate.z, b.rotate.z)) < 0.05f &&
                (a.distance - b.distance).sqrMagnitude < 1e-6f &&
                Mathf.Abs(a.parse - b.parse) < 0.01f;
            for (int i = 0; i < s.sceneInfo.cameraData.Length; i++)
            {
                var d = s.sceneInfo.cameraData[i];
                if (!Used(d, reset)) continue; // an empty slot holds the reset view (same test as the slot list)
                if (Same(d, now)) hits.Add(i);
            }
            return hits;
        }

        private static object Get()
        {
            var s = SceneApi.Studio;
            var reset = s.cameraCtrl.ExportResetData();
            var slots = new List<object>();
            for (int i = 0; i < s.sceneInfo.cameraData.Length; i++)
            {
                var d = s.sceneInfo.cameraData[i];
                bool used = Used(d, reset);
                var slot = new Dictionary<string, object> { { "index", i }, { "used", used }, { "fov", d.parse } };
                if (SlotThumbs.TryGetValue(i, out var t)) slot["thumb"] = t;
                slots.Add(slot);
            }
            var cams = s.dicObjectCtrl.Values.OfType<OCICamera>()
                .Select(c => (object)new Dictionary<string, object> { { "id", c.objectInfo.dicKey }, { "name", c.name }, { "active", s.ociCamera == c } })
                .ToList();
            return new Dictionary<string, object>
            {
                { "slots", slots },
                { "cameras", cams },
                { "active", s.ociCamera != null ? s.ociCamera.objectInfo.dicKey : -1 },
                { "fov", s.cameraCtrl.fieldOfView },
                { "activeSlots", ActiveSlots() },
                { "timeline", TimelineApi.Available },
            };
        }

        /// <summary>Renders the main camera into a small JPEG (base64). Includes image effects, not the UI.</summary>
        /// <summary>The average colour of Studio's view with every effect (tests check an effect's direction with it), 0..1.</summary>
        public static object Mean(int width)
        {
            var cam = Camera.main;
            if (cam == null) return null;
            width = Mathf.Clamp(width, 16, 512);
            int height = Mathf.Max(9, Mathf.RoundToInt(width * (float)Screen.height / Mathf.Max(1, Screen.width)));
            var rt = RenderTexture.GetTemporary(width, height, 24);
            var prevTarget = cam.targetTexture;
            var prevActive = RenderTexture.active;
            Texture2D tex = null;
            try
            {
                cam.targetTexture = rt;
                cam.Render();
                RenderTexture.active = rt;
                tex = new Texture2D(width, height, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                double r = 0, g = 0, b = 0;
                var px = tex.GetPixels32();
                foreach (var c in px) { r += c.r; g += c.g; b += c.b; }
                double n = Math.Max(1, px.Length) * 255.0;
                return new List<object> { r / n, g / n, b / n };
            }
            finally
            {
                cam.targetTexture = prevTarget;
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                if (tex != null) UnityEngine.Object.Destroy(tex);
            }
        }

        public static string Snapshot(int width)
        {
            var cam = Camera.main;
            if (cam == null) return null;
            width = Mathf.Clamp(width, 64, 1024);
            int height = Mathf.Max(36, Mathf.RoundToInt(width * (float)Screen.height / Mathf.Max(1, Screen.width)));
            var rt = RenderTexture.GetTemporary(width, height, 24);
            var prevTarget = cam.targetTexture;
            var prevActive = RenderTexture.active;
            Texture2D tex = null;
            try
            {
                cam.targetTexture = rt;
                cam.Render();
                RenderTexture.active = rt;
                tex = new Texture2D(width, height, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                return "data:image/jpeg;base64," + Convert.ToBase64String(tex.EncodeToJPG(80));
            }
            finally
            {
                cam.targetTexture = prevTarget;
                RenderTexture.active = prevActive;
                RenderTexture.ReleaseTemporary(rt);
                if (tex != null) UnityEngine.Object.Destroy(tex);
            }
        }

        private static object KeyCamera(Dictionary<string, object> a)
        {
            if (!TimelineApi.Available) throw new BridgeException("Timeline is required to animate the camera");
            return KeyCameraImpl(a);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object KeyCameraImpl(Dictionary<string, object> a)
        {
            float t = a.Has("t") ? a.GetFloat("t") : Timeline.Timeline.playbackTime;
            var result = TimelineImpl.KeyCamera(t, a.GetBool("cut"));
            var thumb = Snapshot(192);
            if (thumb != null) ShotThumbs[(float)Math.Round(t, 3)] = thumb;
            return result;
        }

        private static object Shots()
        {
            if (!TimelineApi.Available) return new List<object>();
            return ShotsImpl();
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static object ShotsImpl()
        {
            var shots = TimelineImpl.CameraShots();
            foreach (Dictionary<string, object> s in shots)
                if (ShotThumbs.TryGetValue((float)Math.Round(Convert.ToDouble(s["t"]), 3), out var th)) s["thumb"] = th;
            return shots;
        }
    }
}
