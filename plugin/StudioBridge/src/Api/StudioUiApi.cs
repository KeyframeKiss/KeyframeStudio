using System;
using System.Collections.Generic;
using System.Linq;
using BepInEx.Bootstrap;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Clean Studio window: hide CharaStudio's menus (and other plugins' panels) so only the viewport is left and
    /// Keyframe Studio is the editor. Uses HideAllUI when it's installed (unless told not to); otherwise hides the
    /// same canvases itself, plus panels plugins add later. Everything comes back when the app disconnects, so
    /// Studio is never left without its menus.
    /// </summary>
    internal static class StudioUiApi
    {
        private const string HideAllUiGuid = "keelhauled.hideallui";

        // what HideAllUI hides in Studio (kept the same so both behave alike)
        private static readonly string[] StudioCanvases = { "Canvas", "Canvas Object List", "Canvas Main Menu", "Canvas System Menu", "Canvas Guide Input", "CvsColor", "Canvas Pattern" };

        /// <summary>The wanted state (what the app asked for).</summary>
        private static bool _clean, _timeline = true, _handles = true, _useHideAllUi = true;
        /// <summary>Canvases we switched off (to switch back exactly those) — GameObject.SetActive for Studio's, Canvas.enabled for plugins'.</summary>
        private static readonly List<GameObject> HiddenObjects = new List<GameObject>();
        private static readonly List<Canvas> HiddenCanvases = new List<Canvas>();
        private static bool _hidAxis, _hidTimeline, _drivingHideAllUi;
        private static float _nextSweep;

        public static bool HideAllUiInstalled => Chainloader.PluginInfos.ContainsKey(HideAllUiGuid);

        public static void Register(CommandRouter r)
        {
            r.Add("ui.get", a => State());
            r.Add("ui.set", a =>
            {
                if (a.Has("useHideAllUi")) { Apply(false); _useHideAllUi = a.GetBool("useHideAllUi", true); }
                if (a.Has("timeline")) _timeline = a.GetBool("timeline", true);
                if (a.Has("handles")) _handles = a.GetBool("handles", true);
                if (a.Has("clean")) _clean = a.GetBool("clean");
                Apply(_clean);
                return State();
            });
        }

        private static Dictionary<string, object> State() => new Dictionary<string, object>
        {
            { "clean", _clean },
            { "timeline", _timeline },
            { "handles", _handles },
            { "hideAllUi", HideAllUiInstalled },
            { "useHideAllUi", _useHideAllUi },
            { "provider", Provider() },
            { "hidden", HiddenObjects.Count(o => o != null) + HiddenCanvases.Count(c => c != null) + (_drivingHideAllUi ? 1 : 0) },
        };

        private static string Provider() => _useHideAllUi && HideAllUiInstalled && HideAllUiHandler() != null ? "HideAllUI" : "Keyframe Studio";

        /// <summary>Every frame from the plugin: catch panels opened later, and give Studio its menus back when the app goes away.</summary>
        public static void Tick(int clients)
        {
            if (!_clean) return;
            if (clients == 0)
            {
                // nobody to drive Studio any more: never leave it without menus
                _clean = false;
                Apply(false);
                return;
            }
            if (Time.unscaledTime < _nextSweep) return;
            _nextSweep = Time.unscaledTime + 1f;
            // panels opened since (HideAllUI's own hotkey is left alone: pressing it is the user's choice)
            try { if (Provider() != "HideAllUI") HideOurselves(); } catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("clean window: " + e.Message); }
        }

        private static void Apply(bool clean)
        {
            if (Provider() == "HideAllUI") SetHideAllUi(!clean);
            else
            {
                if (_drivingHideAllUi) SetHideAllUi(true);
                if (clean) HideOurselves(); else ShowOurselves();
            }

            // Timeline's own window
            if (TimelineApi.Available)
            {
                bool hide = clean && !_timeline;
                if (hide && TimelineApi.InterfaceVisible()) { TimelineApi.SetInterfaceVisible(false); _hidTimeline = true; }
                else if (!hide && _hidTimeline) { TimelineApi.SetInterfaceVisible(true); _hidTimeline = false; }
            }

            // move / rotate handles in the viewport
            var studio = Singleton<Studio.Studio>.Instance;
            if (studio != null)
            {
                bool hideAxis = clean && !_handles;
                if (hideAxis && studio.workInfo.visibleAxis) { SetAxis(false); _hidAxis = true; }
                else if (!hideAxis && _hidAxis) { SetAxis(true); _hidAxis = false; }
            }
        }

        private static void SetAxis(bool on)
        {
            var scene = UnityEngine.Object.FindObjectOfType<StudioScene>();
            if (scene != null)
            {
                if (Singleton<Studio.Studio>.Instance.workInfo.visibleAxis != on) scene.OnClickAxis(); // also updates Studio's own button
            }
            else Singleton<Studio.Studio>.Instance.workInfo.visibleAxis = on;
        }

        // ------------------------------------------------------------------ built in

        private static void HideOurselves()
        {
            foreach (var c in UnityEngine.Object.FindObjectsOfType<Canvas>())
            {
                if (c == null || !c.isRootCanvas || c.renderMode == RenderMode.WorldSpace) continue;
                if (StudioCanvases.Contains(c.name))
                {
                    if (c.gameObject.activeSelf && !HiddenObjects.Contains(c.gameObject)) { c.gameObject.SetActive(false); HiddenObjects.Add(c.gameObject); }
                }
                else if (c.enabled && !HiddenCanvases.Contains(c) && IsPluginPanel(c))
                {
                    c.enabled = false;
                    HiddenCanvases.Add(c);
                }
            }
            // HideAllUI also hides this gizmo (KKPE's manipulator)
            var gizmo = Camera.main != null ? Camera.main.transform.Find("CustomManipulatorGizmo") : null;
            if (gizmo != null && gizmo.gameObject.activeSelf) { gizmo.gameObject.SetActive(false); HiddenObjects.Add(gizmo.gameObject); }
        }

        /// <summary>Plugin panels (KKPE, MaterialEditor, QuickAccessBox, …) — screen-space canvases outside Studio's own scene objects.</summary>
        private static bool IsPluginPanel(Canvas c)
        {
            string n = c.name;
            if (n.StartsWith("StudioEX", StringComparison.Ordinal)) return false;
            // Studio's loading / fade / dialog canvases must keep working
            if (n.IndexOf("Fade", StringComparison.OrdinalIgnoreCase) >= 0 || n.IndexOf("Dialog", StringComparison.OrdinalIgnoreCase) >= 0 || n.IndexOf("Check", StringComparison.OrdinalIgnoreCase) >= 0
                || n.IndexOf("Notification", StringComparison.OrdinalIgnoreCase) >= 0 || n.IndexOf("Scene", StringComparison.OrdinalIgnoreCase) >= 0 || n.IndexOf("Load", StringComparison.OrdinalIgnoreCase) >= 0)
                return false;
            return n.EndsWith("(Clone)", StringComparison.Ordinal) || c.transform.root.name.StartsWith("BepInEx", StringComparison.Ordinal);
        }

        private static void ShowOurselves()
        {
            foreach (var o in HiddenObjects) if (o != null) o.SetActive(true);
            foreach (var c in HiddenCanvases) if (c != null) c.enabled = true;
            HiddenObjects.Clear();
            HiddenCanvases.Clear();
        }

        // ------------------------------------------------------------------ HideAllUI (toggle-only: read its state, toggle when it differs)

        private static object HideAllUiHandler()
        {
            try
            {
                var core = AccessTools.TypeByName("HideAllUI.HideAllUICore");
                return core == null ? null : AccessTools.Field(core, "currentUIHandler")?.GetValue(null);
            }
            catch { return null; }
        }

        private static void SetHideAllUi(bool visible)
        {
            var h = HideAllUiHandler();
            if (h == null) { _drivingHideAllUi = false; return; }
            var f = AccessTools.Field(h.GetType(), "visible");
            bool now = f == null || (bool)f.GetValue(h);
            if (now != visible) AccessTools.Method(h.GetType(), "ToggleUI").Invoke(h, null);
            _drivingHideAllUi = !visible;
        }
    }
}
