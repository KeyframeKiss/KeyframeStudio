using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using ExtensibleSaveFormat;
using KKAPI.Studio.SaveLoad;
using KKAPI.Utilities;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// One audio track (dialogue, music) that plays in sync with Timeline: Studio's own outside-sound player can't
    /// seek, so the WAV is loaded with Studio's loader and played on our own AudioSource, following the playhead
    /// (play/pause/seek/loop, drift corrected). Files live in UserData/audio like Studio's outside sound; the
    /// choice, offset and volume are saved with the scene. Also serves the waveform and the loudness envelope
    /// the app uses to draw it and to suggest lip-sync keys.
    /// </summary>
    internal sealed class AudioTrack : MonoBehaviour
    {
        private static AudioTrack _i;
        private AudioSource _src;
        private AudioClip _clip;
        private float[] _mono;
        private int _rate;

        public static string File { get; private set; }
        public static float Offset, Volume = 1f;
        public static bool Muted;

        private static string AudioDir => Path.GetFullPath(UserData.Create("audio"));

        private void Awake()
        {
            _i = this;
            _src = gameObject.AddComponent<AudioSource>();
            _src.playOnAwake = false;
            _src.loop = false;
            _src.spatialBlend = 0f;
        }

        public static void Register(CommandRouter r)
        {
            r.Add("audio.files", a => Files());
            r.Add("audio.load", a => { Load(a.GetString("file") ?? a.GetString("path"), a.Has("offset") ? a.GetFloat("offset") : 0f); return Get(); });
            r.Add("audio.get", a => Get());
            r.Add("audio.set", a =>
            {
                if (a.Has("offset")) Offset = a.GetFloat("offset");
                if (a.Has("volume")) Volume = Mathf.Clamp01(a.GetFloat("volume"));
                if (a.Has("muted")) Muted = a.GetBool("muted");
                return Get();
            });
            r.Add("audio.clear", a => { Clear(); return Get(); });
            r.Add("audio.peaks", a => Peaks(Mathf.Clamp(a.GetInt("perSecond", 100), 10, 400)));
            r.Add("audio.envelope", a => Envelope(Mathf.Clamp(a.GetInt("rate", 30), 5, 120)));
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Audio track won't be saved with scenes (KKAPI): " + e.Message); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<AudioSceneData>(StudioBridgePlugin.GUID + ".audio");

        private static object Files()
        {
            var dir = AudioDir;
            return Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*.wav").OrderBy(f => f).Select(f => (object)new Dictionary<string, object> { { "file", Path.GetFileName(f) }, { "size", new FileInfo(f).Length } }).ToList()
                : new List<object>();
        }

        private static object Get() => new Dictionary<string, object>
        {
            { "file", File }, { "offset", (double)Offset }, { "volume", (double)Volume }, { "muted", Muted },
            { "duration", _i._clip != null ? (double)_i._clip.length : 0d }, { "loaded", _i._clip != null },
            { "playing", _i._src.isPlaying },
        };

        /// <summary>A file in UserData/audio, or any .wav path (copied into UserData/audio so scenes can find it).</summary>
        public static void Load(string fileOrPath, float offset)
        {
            if (string.IsNullOrEmpty(fileOrPath)) throw new BridgeException("Pick an audio file");
            string full = Path.IsPathRooted(fileOrPath) ? Path.GetFullPath(fileOrPath) : Path.GetFullPath(Path.Combine(AudioDir, Path.GetFileName(fileOrPath)));
            if (!string.Equals(Path.GetExtension(full), ".wav", StringComparison.OrdinalIgnoreCase)) throw new BridgeException("Use a .wav file (Studio's audio loader reads WAV only)");
            if (!System.IO.File.Exists(full)) throw new BridgeException("Audio file not found: " + Path.GetFileName(full));
            if (!full.StartsWith(AudioDir, StringComparison.OrdinalIgnoreCase))
            {
                var dest = Path.Combine(AudioDir, Path.GetFileName(full));
                if (!System.IO.File.Exists(dest) || new FileInfo(dest).Length != new FileInfo(full).Length) System.IO.File.Copy(full, dest, true);
                full = dest;
            }
            var clip = ExternalAudioClip.Load(full);
            if (clip == null) throw new BridgeException("Couldn't read that WAV — use uncompressed PCM (8/16/24/32-bit)");
            _i._src.Stop();
            if (_i._clip != null) Destroy(_i._clip);
            _i._clip = clip;
            _i._src.clip = clip;
            File = Path.GetFileName(full);
            Offset = offset;
            // mono samples for the waveform and envelope
            var data = new float[clip.samples * clip.channels];
            clip.GetData(data, 0);
            var mono = new float[clip.samples];
            for (int i = 0; i < clip.samples; i++)
            {
                float sum = 0f;
                for (int ch = 0; ch < clip.channels; ch++) sum += data[i * clip.channels + ch];
                mono[i] = sum / clip.channels;
            }
            _i._mono = mono;
            _i._rate = clip.frequency;
        }

        public static void Clear()
        {
            if (_i == null) return;
            _i._src.Stop();
            _i._src.clip = null;
            if (_i._clip != null) Destroy(_i._clip);
            _i._clip = null;
            _i._mono = null;
            File = null;
            Offset = 0f;
            Volume = 1f;
            Muted = false;
        }

        /// <summary>Peak level per bin (0..1), perSecond bins per second of audio.</summary>
        private static object Peaks(int perSecond)
        {
            var m = _i._mono;
            if (m == null) return null;
            int bin = Mathf.Max(1, _i._rate / perSecond);
            int n = (m.Length + bin - 1) / bin;
            var peaks = new List<object>(n);
            for (int b = 0; b < n; b++)
            {
                float p = 0f;
                for (int i = b * bin, e = Mathf.Min(m.Length, i + bin); i < e; i++) { float v = Mathf.Abs(m[i]); if (v > p) p = v; }
                peaks.Add(Math.Round(p, 3));
            }
            return new Dictionary<string, object> { { "perSecond", perSecond }, { "duration", (double)_i._clip.length }, { "offset", (double)Offset }, { "peaks", peaks } };
        }

        /// <summary>Loudness (RMS) per window, `rate` windows per second, plus the maximum (for normalizing).</summary>
        private static object Envelope(int rate)
        {
            var m = _i._mono;
            if (m == null) throw new BridgeException("Load an audio file first");
            int win = Mathf.Max(1, _i._rate / rate);
            int n = (m.Length + win - 1) / win;
            var env = new List<object>(n);
            double max = 0;
            for (int b = 0; b < n; b++)
            {
                double s = 0;
                int i0 = b * win, e = Mathf.Min(m.Length, i0 + win);
                for (int i = i0; i < e; i++) s += m[i] * m[i];
                double rms = Math.Sqrt(s / Mathf.Max(1, e - i0));
                if (rms > max) max = rms;
                env.Add(Math.Round(rms, 4));
            }
            return new Dictionary<string, object> { { "rate", rate }, { "offset", (double)Offset }, { "duration", (double)_i._clip.length }, { "max", Math.Round(max, 4) }, { "values", env } };
        }

        // ---------------- follow the playhead ----------------

        private void Update()
        {
            if (_clip == null) return;
            _src.volume = Volume;
            bool playing = TimelineApi.Playing() && !Muted;
            float t = TimelineApi.PlaybackTime() - Offset;
            if (playing && t >= 0f && t < _clip.length)
            {
                if (!_src.isPlaying)
                {
                    _src.time = Mathf.Clamp(t, 0f, _clip.length - 0.01f);
                    _src.Play();
                }
                else if (Mathf.Abs(_src.time - t) > 0.08f) _src.time = Mathf.Clamp(t, 0f, _clip.length - 0.01f); // seek, loop, drift
            }
            else if (_src.isPlaying) _src.Pause();
        }

        // ---------------- saved with the scene ----------------

        private sealed class AudioSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                if (File == null) { SetExtendedData(null); return; }
                SetExtendedData(new PluginData { version = 1, data = new Dictionary<string, object> { { "file", File }, { "offset", Offset }, { "volume", Volume }, { "muted", Muted } } });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation == SceneOperationKind.Import) return; // merging another scene keeps our audio
                var d = GetExtendedData();
                Clear();
                if (d?.data == null || !d.data.TryGetValue("file", out var f) || !(f is string file)) return;
                try
                {
                    Load(file, d.data.TryGetValue("offset", out var o) ? Convert.ToSingle(o) : 0f);
                    if (d.data.TryGetValue("volume", out var v)) Volume = Convert.ToSingle(v);
                    if (d.data.TryGetValue("muted", out var mu)) Muted = Convert.ToBoolean(mu);
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene audio not loaded: " + e.Message); }
            }
        }
    }
}
