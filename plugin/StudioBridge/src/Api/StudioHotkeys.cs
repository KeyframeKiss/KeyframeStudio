using System.Collections.Generic;
using BepInEx.Configuration;
using StudioEX.Bridge.Net;
using UnityEngine;
using UnityEngine.EventSystems;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Keyframe Studio's keys while CharaStudio is the active window: posing in Studio, Ctrl+K keys it without
    /// switching windows. The bridge only notices the key and tells the app ("hotkey" event); the app does the
    /// keying exactly as its own K would, and sends a short line back ("studio.flash") that shows in Studio's
    /// window for a moment. Rebindable in Mod settings (Keyframe Studio Bridge › Hotkeys in Studio).
    /// </summary>
    internal class StudioHotkeys : MonoBehaviour
    {
        private static readonly List<KeyValuePair<string, ConfigEntry<KeyboardShortcut>>> Keys = new List<KeyValuePair<string, ConfigEntry<KeyboardShortcut>>>();
        private static string _flash;
        private static float _flashUntil;
        private static GUIStyle _style;

        public static void Bind(ConfigFile config)
        {
            const string S = "Hotkeys in Studio";
            Add(config, "key", S, "Key", new KeyboardShortcut(KeyCode.K, KeyCode.LeftControl),
                "While CharaStudio is the active window: key the tracks selected in Keyframe Studio's timeline, or else what you changed in Studio (K in the app).");
            Add(config, "keyAll", S, "Key the whole object", new KeyboardShortcut(KeyCode.K, KeyCode.LeftControl, KeyCode.LeftShift),
                "Key every track of the selected object (Shift+K in the app).");
            Add(config, "autoKey", S, "Auto-key on / off", KeyboardShortcut.Empty, "Auto-key on or off (R in the app). Not set by default.");
            Add(config, "play", S, "Play / pause", KeyboardShortcut.Empty, "Play or pause the timeline (Space in the app). Not set by default: Space hides Studio's UI with HideAllUI.");
            Add(config, "guides", S, "Frame guides on / off", KeyboardShortcut.Empty, "All frame guides off, and back on (G in the app). Not set by default.");
        }

        private static void Add(ConfigFile config, string action, string section, string name, KeyboardShortcut def, string help) =>
            Keys.Add(new KeyValuePair<string, ConfigEntry<KeyboardShortcut>>(action, config.Bind(section, name, def, help)));

        public static void Register(CommandRouter r)
        {
            // a short line in Studio's window (what a hotkey did); never drawn into renders
            // tests: the same as pressing a hotkey's keys in Studio
            r.Add("hotkeys.fire", a =>
            {
                StudioBridgePlugin.Instance.Broadcast("hotkey", new Dictionary<string, object> { { "action", a.GetString("action") } });
                return true;
            });
            r.Add("studio.flash", a =>
            {
                if (a.GetString("text") == null) return Time.unscaledTime < _flashUntil ? _flash : null; // what's showing (tests)
                _flash = a.GetString("text");
                _flashUntil = Time.unscaledTime + Mathf.Clamp(a.GetFloat("seconds", 1.6f), 0.5f, 5f);
                return true;
            });
        }

        private void Update()
        {
            if (StudioBridgePlugin.Instance == null || StudioBridgePlugin.Instance.ClientCount == 0 || Typing()) return;
            foreach (var k in Keys)
            {
                var sc = k.Value.Value;
                if (sc.MainKey == KeyCode.None || !sc.IsDown()) continue;
                StudioBridgePlugin.Instance.Broadcast("hotkey", new Dictionary<string, object> { { "action", k.Key } });
                break;
            }
        }

        /// <summary>A text box in Studio has the keyboard (renaming, a number field): its letters aren't hotkeys.</summary>
        private static bool Typing()
        {
            var es = EventSystem.current;
            var go = es != null ? es.currentSelectedGameObject : null;
            if (go == null) return false;
            var f = go.GetComponent<UnityEngine.UI.InputField>();
            return f != null && f.isFocused;
        }

        private void OnGUI()
        {
            if (_flash == null || Event.current.type != EventType.Repaint || Time.captureFramerate > 0) return;
            if (Time.unscaledTime > _flashUntil)
            {
                _flash = null;
                return;
            }
            if (_style == null)
            {
                _style = new GUIStyle(GUI.skin.box) { fontSize = 15, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter, padding = new RectOffset(16, 16, 8, 8) };
                _style.normal.textColor = Color.white;
            }
            var size = _style.CalcSize(new GUIContent(_flash));
            var rect = new Rect((Screen.width - size.x) / 2f, Screen.height - size.y - 48f, size.x, size.y);
            var fade = Mathf.Clamp01((_flashUntil - Time.unscaledTime) / 0.3f);
            var old = GUI.color;
            GUI.color = new Color(1f, 1f, 1f, fade);
            GUI.Box(rect, _flash, _style);
            GUI.color = old;
        }
    }
}
