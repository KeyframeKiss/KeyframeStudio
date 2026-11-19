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
        /// <summary>Playing the clip on its own (Listen), not following the timeline.</summary>
        private static bool _preview;

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
            // listen to the clip by itself: on (from a time in the clip) / off; it stops at the end or when the timeline plays
            r.Add("audio.preview", a =>
            {
                if (_i._clip == null) throw new BridgeException("Load a WAV first");
                _preview = a.GetBool("on", !_preview);
                if (_preview)
                {
                    _i._src.volume = Volume;
                    _i._src.time = Mathf.Clamp(a.GetFloat("from", 0f), 0f, _i._clip.length - 0.01f);
                    _i._src.Play();
                }
                else _i._src.Stop();
                return Get();
            });
            r.Add("audio.peaks", a => Peaks(Mathf.Clamp(a.GetInt("perSecond", 100), 10, 400)));
            r.Add("audio.envelope", a => Envelope(Mathf.Clamp(a.GetInt("rate", 30), 5, 120)));
            r.Add("audio.spectrum", a => Spectrum(Mathf.Clamp(a.GetInt("rate", 60), 10, 120)));
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
            { "previewing", _preview }, { "previewAt", _preview ? (double)_i._src.time : 0d },
        };

        private static bool SameFile(string a, string b)
        {
            var fa = new FileInfo(a);
            var fb = new FileInfo(b);
            if (fa.Length != fb.Length) return false;
            using (var x = System.IO.File.OpenRead(a))
            using (var y = System.IO.File.OpenRead(b))
            {
                var ba = new byte[65536];
                var bb = new byte[65536];
                int na;
                while ((na = x.Read(ba, 0, ba.Length)) > 0)
                {
                    int nb = 0;
                    while (nb < na) { int r = y.Read(bb, nb, na - nb); if (r <= 0) return false; nb += r; }
                    for (int i = 0; i < na; i++) if (ba[i] != bb[i]) return false;
                }
            }
            return true;
        }

        /// <summary>A file in UserData/audio, or any .wav path (copied into UserData/audio so scenes can find it).</summary>
        public static void Load(string fileOrPath, float offset)
        {
            if (string.IsNullOrEmpty(fileOrPath)) throw new BridgeException("Pick an audio file");
            string full = Path.IsPathRooted(fileOrPath) ? Path.GetFullPath(fileOrPath) : Path.GetFullPath(Path.Combine(AudioDir, Path.GetFileName(fileOrPath)));
            if (!string.Equals(Path.GetExtension(full), ".wav", StringComparison.OrdinalIgnoreCase)) throw new BridgeException("Use a .wav file (Studio's audio loader reads WAV only)");
            if (!System.IO.File.Exists(full)) throw new BridgeException("Audio file not found: " + Path.GetFileName(full));
            if (!full.StartsWith(AudioDir, StringComparison.OrdinalIgnoreCase))
            {
                // never overwrite another scene's clip that happens to have the same name: same content is reused,
                // different content gets "name (2).wav"
                string stem = Path.GetFileNameWithoutExtension(full), ext = Path.GetExtension(full);
                var dest = Path.Combine(AudioDir, stem + ext);
                for (int n = 2; System.IO.File.Exists(dest) && !SameFile(dest, full); n++)
                    dest = Path.Combine(AudioDir, stem + " (" + n + ")" + ext);
                if (!System.IO.File.Exists(dest)) System.IO.File.Copy(full, dest, false);
                full = dest;
            }
            var clip = ExternalAudioClip.Load(full);
            if (clip == null) throw new BridgeException("Couldn't read that WAV — use uncompressed PCM (8/16/24/32-bit)");
            _preview = false;
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
            _preview = false;
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

/// <summary>
        /// The voice's spectral envelope per window (`rate` per second), in dB at 40 points 80 Hz apart from 140 Hz:
        /// linear prediction (LPC) on the audio resampled to about 11 kHz, so the peaks are the resonances that
        /// tell vowels apart (formants), not the pitch's harmonics. Values are flat: window after window.
        /// </summary>
        private static object Spectrum(int rate)
        {
            var m = _i._mono;
            if (m == null) throw new BridgeException("Load an audio file first");
            int sr = _i._rate;
            int dec = Mathf.Max(1, Mathf.RoundToInt(sr / 11025f));
            float fs = (float)sr / dec;
            // low-pass (box average over the decimation step) and decimate
            int len = m.Length / dec;
            var x = new float[len];
            for (int i = 0; i < len; i++)
            {
                float sum = 0f;
                for (int k = 0; k < dec; k++) sum += m[i * dec + k];
                x[i] = sum / dec;
            }
            const int bands = 40, order = 12;
            const float from = 100f, width = 80f;
            int win = Mathf.RoundToInt(0.03f * fs);
            int hop = Mathf.Max(1, Mathf.RoundToInt(fs / rate));
            int n = (len + hop - 1) / hop;
            var frame = new double[win];
            var r = new double[order + 1];
            var a = new double[order + 1];
            var tmp = new double[order + 1];
            var outv = new List<object>(n * bands);
            for (int w = 0; w < n; w++)
            {
                int center = w * hop + hop / 2;
                double energy = 0;
                for (int i = 0; i < win; i++)
                {
                    int j = center - win / 2 + i;
                    double v = j >= 1 && j < len ? x[j] - 0.97 * x[j - 1] : 0; // pre-emphasis
                    v *= 0.54 - 0.46 * Math.Cos(2 * Math.PI * i / (win - 1)); // Hamming
                    frame[i] = v;
                    energy += v * v;
                }
                if (energy < 1e-10)
                {
                    for (int b = 0; b < bands; b++) outv.Add(-100.0);
                    continue;
                }
                for (int k = 0; k <= order; k++)
                {
                    double s2 = 0;
                    for (int i = k; i < win; i++) s2 += frame[i] * frame[i - k];
                    r[k] = s2;
                }
                r[0] *= 1.0001; // a touch of white noise keeps Levinson stable
                // Levinson–Durbin
                Array.Clear(a, 0, a.Length);
                a[0] = 1;
                double err = r[0];
                for (int i = 1; i <= order; i++)
                {
                    double acc = r[i];
                    for (int j = 1; j < i; j++) acc += a[j] * r[i - j];
                    double k = -acc / err;
                    Array.Copy(a, tmp, a.Length);
                    for (int j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
                    a[i] = k;
                    err *= 1 - k * k;
                    if (err <= 1e-12) break;
                }
                double gain = 10 * Math.Log10(Math.Max(err, 1e-12));
                for (int b = 0; b < bands; b++)
                {
                    double om = 2 * Math.PI * (from + (b + 0.5) * width) / fs;
                    double re = 0, im = 0;
                    for (int k = 0; k <= order; k++) { re += a[k] * Math.Cos(om * k); im -= a[k] * Math.Sin(om * k); }
                    outv.Add(Math.Round(gain - 10 * Math.Log10(re * re + im * im + 1e-12), 1));
                }
            }
            return new Dictionary<string, object>
            {
                { "rate", rate }, { "offset", (double)Offset }, { "bands", bands }, { "from", (double)from }, { "width", (double)width }, { "values", outv },
            };
        }

        // ---------------- follow the playhead ----------------

        private void Update()
        {
            if (_clip == null) return;
            _src.volume = Volume;
            if (_preview)
            {
                if (_src.isPlaying && !TimelineApi.Playing()) return;
                _preview = false; // finished, or the timeline took over
                _src.Stop();
            }
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
