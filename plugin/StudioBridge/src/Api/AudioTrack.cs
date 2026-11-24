using System;
using System.Collections;
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
    /// The scene's audio clips (dialogue, music, effects) that play in sync with Timeline: Studio's own outside-sound
    /// player can't seek, so each WAV is loaded with Studio's loader and played on its own AudioSource, following the
    /// playhead (play/pause/seek/loop, drift corrected). Files live in UserData/audio like Studio's outside sound;
    /// which clips, where they start and their volume are saved with the scene. Also serves each clip's waveform and
    /// loudness envelope, which the app uses to draw it and to suggest lip-sync keys.
    /// Commands without an "id" act on the first clip, so a scene with one clip works as it always did.
    /// </summary>
    internal sealed class AudioTrack : MonoBehaviour
    {
        private sealed class Clip
        {
            public int Id;
            public string File;
            /// <summary>The name shown for it ("" = the file's name).</summary>
            public string Name = "";
            public float Offset, Volume = 1f;
            public bool Muted;
            /// <summary>-1 left … 1 right.</summary>
            public float Pan;
            /// <summary>Playback speed (the pitch follows, like a tape).</summary>
            public float Speed = 1f;
            /// <summary>Seconds of the timeline over which it fades in / out.</summary>
            public float FadeIn, FadeOut;
            /// <summary>Seconds of the file skipped at its start / end.</summary>
            public float TrimIn, TrimOut;
            /// <summary>How long it plays on the timeline.</summary>
            public float Span => Mathf.Max(0.01f, Audio.length - TrimIn - TrimOut) / Speed;
            /// <summary>Loudness at `local` seconds into its span: volume with the fades.</summary>
            public float Gain(float local)
            {
                float g = Volume;
                if (FadeIn > 0.001f) g *= Mathf.Clamp01(local / FadeIn);
                if (FadeOut > 0.001f) g *= Mathf.Clamp01((Span - local) / FadeOut);
                return g;
            }
            public AudioClip Audio;
            public AudioSource Src;
            public float[] Mono;
            public int Rate;
        }

        private static AudioTrack _i;
        private static readonly List<Clip> Clips = new List<Clip>();
        private static int _nextId = 1;
        /// <summary>The clip playing on its own (Listen), not following the timeline.</summary>
        private static Clip _preview;

        private static string AudioDir => Path.GetFullPath(UserData.Create("audio"));

        /// <summary>This PC's output delay (ms): while the timeline plays, clips play this much early so what you hear lines
        /// up with the picture (Bluetooth headphones are heard late). Not used for renders, which mix the audio exactly.</summary>
        public static BepInEx.Configuration.ConfigEntry<int> OutputDelay;
        private static float Lead => OutputDelay == null ? 0f : Mathf.Clamp(OutputDelay.Value, 0, 2000) / 1000f;

        /// <summary>Set while a render runs: no clip plays (the audio is mixed into the video afterwards).</summary>
        public static bool Silenced;

        /// <summary>A clip to mix into a rendered video.</summary>
        public sealed class RenderClip
        {
            public string Path;
            public float Offset, Volume, Length, Pan, Speed, FadeIn, FadeOut, TrimIn, TrimOut, Span;
            public int Rate;
        }

        /// <summary>The clips that sound somewhere in [start, end] of the timeline, for mixing into a render.</summary>
        public static List<RenderClip> ForRender(float start, float end) =>
            Clips.Where(c => c.Offset < end && c.Offset + c.Span > start && c.Volume > 0.001f)
                .Select(c => new RenderClip
                {
                    Path = System.IO.Path.Combine(AudioDir, c.File), Offset = c.Offset, Volume = c.Volume, Length = c.Audio.length, Rate = c.Rate,
                    Pan = c.Pan, Speed = c.Speed, FadeIn = c.FadeIn, FadeOut = c.FadeOut, TrimIn = c.TrimIn, TrimOut = c.TrimOut, Span = c.Span,
                })
                .ToList();

        private void Awake() => _i = this;

        public static void Register(CommandRouter r)
        {
            r.Add("audio.files", a => Files());
            r.Add("audio.get", a => Get());
            // a new clip, on top of the ones there
            r.Add("audio.add", a => { Add(a.GetString("file") ?? a.GetString("path"), a.GetFloat("offset", 0f)); return Changed(); });
            // swap a clip's file (id; or the first clip, adding one when there is none) — keeps where it starts unless given
            r.Add("audio.load", a =>
            {
                var path = a.GetString("file") ?? a.GetString("path");
                var c = a.Has("id") ? Find(a) : Clips.FirstOrDefault();
                if (c == null) Add(path, a.GetFloat("offset", 0f));
                else Replace(c, path, a.Has("offset") ? a.GetFloat("offset") : c.Offset);
                return Changed();
            });
            r.Add("audio.set", a =>
            {
                var c = Find(a);
                if (a.Has("offset")) c.Offset = a.GetFloat("offset");
                if (a.Has("volume")) c.Volume = Mathf.Clamp01(a.GetFloat("volume"));
                if (a.Has("muted")) c.Muted = a.GetBool("muted");
                if (a.Has("name")) c.Name = CleanName(a.GetString("name"));
                Shape(c, a);
                return Changed();
            });
            r.Add("audio.setDelay", a =>
            {
                if (OutputDelay != null) OutputDelay.Value = Mathf.Clamp(a.GetInt("ms"), 0, 2000);
                return Get();
            });
            r.Add("audio.remove", a => { Remove(Find(a)); return Changed(); });
            r.Add("audio.clear", a => { Clear(); return Changed(); });
            // listen to one clip by itself: on (from a time in the clip) / off; it stops at the end or when the timeline plays
            r.Add("audio.preview", a =>
            {
                bool on = a.GetBool("on", _preview == null);
                if (_preview != null) { _preview.Src.Stop(); _preview = null; }
                if (on)
                {
                    var c = Find(a);
                    _preview = c;
                    c.Src.pitch = c.Speed;
                    c.Src.panStereo = c.Pan;
                    // "from" is seconds into the file; it plays only the part between the trims
                    c.Src.time = Mathf.Clamp(a.GetFloat("from", c.TrimIn), c.TrimIn, c.Audio.length - c.TrimOut - 0.01f);
                    c.Src.volume = c.Gain((c.Src.time - c.TrimIn) / c.Speed);
                    c.Src.Play();
                }
                return Get();
            });
            r.Add("audio.peaks", a => Peaks(Find(a), Mathf.Clamp(a.GetInt("perSecond", 100), 10, 400)));
            r.Add("audio.envelope", a => Envelope(Find(a), Mathf.Clamp(a.GetInt("rate", 30), 5, 120)));
            r.Add("audio.spectrum", a => Spectrum(Find(a), Mathf.Clamp(a.GetInt("rate", 60), 10, 120)));
            try { RegisterSceneData(); }
            catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Audio won't be saved with scenes (KKAPI): " + e.Message); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RegisterSceneData() => StudioSaveLoadApi.RegisterExtraBehaviour<AudioSceneData>(StudioBridgePlugin.GUID + ".audio");

        /// <summary>Balance, speed, fades and trims from a command's args (clamped to what makes sense for the file).</summary>
        private static void Shape(Clip c, Dictionary<string, object> a)
        {
            float len = c.Audio.length;
            if (a.Has("pan")) c.Pan = Mathf.Clamp(a.GetFloat("pan"), -1f, 1f);
            if (a.Has("speed")) c.Speed = Mathf.Clamp(a.GetFloat("speed"), 0.25f, 4f);
            if (a.Has("trimIn")) c.TrimIn = Mathf.Clamp(a.GetFloat("trimIn"), 0f, len - 0.05f);
            if (a.Has("trimOut")) c.TrimOut = Mathf.Clamp(a.GetFloat("trimOut"), 0f, len - 0.05f);
            if (c.TrimIn + c.TrimOut > len - 0.05f) c.TrimOut = Mathf.Max(0f, len - 0.05f - c.TrimIn);
            if (a.Has("fadeIn")) c.FadeIn = Mathf.Max(0f, a.GetFloat("fadeIn"));
            if (a.Has("fadeOut")) c.FadeOut = Mathf.Max(0f, a.GetFloat("fadeOut"));
            c.FadeIn = Mathf.Min(c.FadeIn, c.Span);
            c.FadeOut = Mathf.Min(c.FadeOut, c.Span);
        }

        /// <summary>Tells the app the clips changed (whoever changed them: a template, a script, a scene load); returns them.</summary>
        private static object Changed()
        {
            var d = Get();
            StudioBridgePlugin.Instance?.Broadcast("audio.changed", null);
            return d;
        }

        /// <summary>The clip named by "id", or the first one.</summary>
        private static Clip Find(Dictionary<string, object> a)
        {
            if (a.Has("id"))
            {
                int id = a.GetInt("id");
                return Clips.FirstOrDefault(c => c.Id == id) ?? throw new BridgeException("That audio clip is gone");
            }
            return Clips.FirstOrDefault() ?? throw new BridgeException("Load a WAV first");
        }

        private static object Files()
        {
            var dir = AudioDir;
            return Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*.wav").OrderBy(f => f).Select(f => (object)new Dictionary<string, object> { { "file", Path.GetFileName(f) }, { "size", new FileInfo(f).Length } }).ToList()
                : new List<object>();
        }

        private static string CleanName(string s)
        {
            s = (s ?? "").Trim();
            return s.Length > 80 ? s.Substring(0, 80) : s;
        }

        private static Dictionary<string, object> Info(Clip c) => new Dictionary<string, object>
        {
            { "id", c.Id }, { "file", c.File }, { "name", c.Name }, { "offset", (double)c.Offset }, { "volume", (double)c.Volume }, { "muted", c.Muted },
            { "duration", (double)c.Audio.length }, { "playing", c.Src.isPlaying },
            { "pan", (double)c.Pan }, { "speed", (double)c.Speed }, { "fadeIn", (double)c.FadeIn }, { "fadeOut", (double)c.FadeOut },
            { "trimIn", (double)c.TrimIn }, { "trimOut", (double)c.TrimOut }, { "span", (double)c.Span },
        };

        /// <summary>Every clip, plus the first clip's values at the top level (what single-clip callers read).</summary>
        private static object Get()
        {
            var first = Clips.FirstOrDefault();
            var d = first != null ? Info(first) : new Dictionary<string, object> { { "file", null }, { "offset", 0d }, { "volume", 1d }, { "muted", false }, { "duration", 0d }, { "playing", false } };
            d["loaded"] = first != null;
            d["clips"] = Clips.Select(c => (object)Info(c)).ToList();
            d["previewing"] = _preview != null;
            d["previewId"] = _preview?.Id ?? 0;
            d["previewAt"] = _preview != null ? (double)_preview.Src.time : 0d;
            d["outputDelay"] = OutputDelay?.Value ?? 0;
            // Unity's own mixer buffer, for the app's hint (heard this much later even on wired headphones)
            AudioSettings.GetDSPBufferSize(out int len, out int count);
            d["mixerDelay"] = AudioSettings.outputSampleRate > 0 ? Math.Round(1000.0 * len * count / AudioSettings.outputSampleRate) : 0d;
            return d;
        }

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

        /// <summary>A file in UserData/audio, or any .wav path (copied into UserData/audio so scenes can find it); returns the file name and the clip.</summary>
        private static AudioClip Read(string fileOrPath, out string file)
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
            file = Path.GetFileName(full);
            return clip;
        }

        private static void Fill(Clip c, AudioClip clip, string file)
        {
            c.Audio = clip;
            c.Src.clip = clip;
            c.File = file;
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
            c.Mono = mono;
            c.Rate = clip.frequency;
        }

        public static void Add(string fileOrPath, float offset)
        {
            var clip = Read(fileOrPath, out var file);
            var src = _i.gameObject.AddComponent<AudioSource>();
            src.playOnAwake = false;
            src.loop = false;
            src.spatialBlend = 0f;
            var c = new Clip { Id = _nextId++, Offset = offset, Src = src };
            Fill(c, clip, file);
            Clips.Add(c);
        }

        private static void Replace(Clip c, string fileOrPath, float offset)
        {
            var clip = Read(fileOrPath, out var file);
            if (_preview == c) _preview = null;
            c.Src.Stop();
            Destroy(c.Audio);
            Fill(c, clip, file);
            c.Offset = offset;
            c.TrimIn = c.TrimOut = 0f; // another file: its own length
        }

        private static void Remove(Clip c)
        {
            if (_preview == c) _preview = null;
            c.Src.Stop();
            Destroy(c.Src);
            Destroy(c.Audio);
            Clips.Remove(c);
        }

        public static void Clear()
        {
            if (_i == null) return;
            foreach (var c in Clips.ToList()) Remove(c);
            _preview = null;
        }

        /// <summary>Peak level per bin (0..1), perSecond bins per second of audio.</summary>
        private static object Peaks(Clip c, int perSecond)
        {
            var m = c.Mono;
            int bin = Mathf.Max(1, c.Rate / perSecond);
            int n = (m.Length + bin - 1) / bin;
            var peaks = new List<object>(n);
            for (int b = 0; b < n; b++)
            {
                float p = 0f;
                for (int i = b * bin, e = Mathf.Min(m.Length, i + bin); i < e; i++) { float v = Mathf.Abs(m[i]); if (v > p) p = v; }
                peaks.Add(Math.Round(p, 3));
            }
            return new Dictionary<string, object> { { "id", c.Id }, { "perSecond", perSecond }, { "duration", (double)c.Audio.length }, { "offset", (double)c.Offset }, { "peaks", peaks } };
        }

        /// <summary>Loudness (RMS) per window, `rate` windows per second, plus the maximum (for normalizing).</summary>
        private static object Envelope(Clip c, int rate)
        {
            var m = c.Mono;
            int win = Mathf.Max(1, c.Rate / rate);
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
            return new Dictionary<string, object> { { "id", c.Id }, { "rate", rate }, { "offset", (double)c.Offset }, { "duration", (double)c.Audio.length }, { "max", Math.Round(max, 4) }, { "values", env } };
        }

        /// <summary>
        /// The voice's spectral envelope per window (`rate` per second), in dB at 40 points 80 Hz apart from 140 Hz:
        /// linear prediction (LPC) on the audio resampled to about 11 kHz, so the peaks are the resonances that
        /// tell vowels apart (formants), not the pitch's harmonics. Values are flat: window after window.
        /// </summary>
        private static object Spectrum(Clip c, int rate)
        {
            var m = c.Mono;
            int sr = c.Rate;
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
                { "id", c.Id }, { "rate", rate }, { "offset", (double)c.Offset }, { "bands", bands }, { "from", (double)from }, { "width", (double)width }, { "values", outv },
            };
        }

        // ---------------- follow the playhead ----------------

        private void Update()
        {
            // rendering (ours, or VideoExport recording on its own with its fixed frame clock): nothing plays
            if (Silenced || Time.captureFramerate > 0)
            {
                if (_preview != null) { _preview.Src.Stop(); _preview = null; }
                foreach (var c in Clips) if (c.Src.isPlaying) c.Src.Pause();
                return;
            }
            bool tlPlaying = TimelineApi.Playing();
            if (_preview != null)
            {
                var pc = _preview;
                if (!pc.Src.isPlaying || tlPlaying || pc.Src.time >= pc.Audio.length - pc.TrimOut - 0.01f)
                {
                    pc.Src.Stop(); // finished (or reached the trim), or the timeline took over
                    _preview = null;
                }
                else pc.Src.volume = pc.Gain((pc.Src.time - pc.TrimIn) / pc.Speed);
            }
            // playing: run the audio ahead by the output delay so it's heard in step with the picture
            float now = TimelineApi.PlaybackTime() + (tlPlaying ? Lead : 0f);
            foreach (var c in Clips)
            {
                if (c == _preview) continue;
                float local = now - c.Offset; // timeline seconds into the clip's span
                if (tlPlaying && !c.Muted && local >= 0f && local < c.Span)
                {
                    float at = Mathf.Clamp(c.TrimIn + local * c.Speed, 0f, c.Audio.length - 0.01f); // where in the file
                    c.Src.pitch = c.Speed;
                    c.Src.panStereo = c.Pan;
                    c.Src.volume = c.Gain(local);
                    if (!c.Src.isPlaying)
                    {
                        c.Src.time = at;
                        c.Src.Play();
                    }
                    else if (Mathf.Abs(c.Src.time - at) > 0.08f * Mathf.Max(1f, c.Speed)) c.Src.time = at; // seek, loop, drift
                }
                else if (c.Src.isPlaying) c.Src.Pause();
            }
        }

        // ---------------- saved with the scene ----------------

        private static List<object> AsList(Dictionary<string, object> d, string key) =>
            d.TryGetValue(key, out var v) && v is IEnumerable e && !(v is string) ? e.Cast<object>().ToList() : null;

        private sealed class AudioSceneData : SceneCustomFunctionController
        {
            protected override void OnSceneSave()
            {
                if (Clips.Count == 0) { SetExtendedData(null); return; }
                var first = Clips[0];
                // version 2: every clip as parallel arrays; the first clip is also kept in the version-1 fields,
                // so an older Keyframe Studio still loads it
                SetExtendedData(new PluginData
                {
                    version = 2,
                    data = new Dictionary<string, object>
                    {
                        { "file", first.File }, { "offset", first.Offset }, { "volume", first.Volume }, { "muted", first.Muted },
                        { "files", Clips.Select(c => c.File).ToArray() },
                        { "offsets", Clips.Select(c => c.Offset).ToArray() },
                        { "volumes", Clips.Select(c => c.Volume).ToArray() },
                        { "mutes", Clips.Select(c => c.Muted).ToArray() },
                        { "pans", Clips.Select(c => c.Pan).ToArray() },
                        { "speeds", Clips.Select(c => c.Speed).ToArray() },
                        { "fadeIns", Clips.Select(c => c.FadeIn).ToArray() },
                        { "fadeOuts", Clips.Select(c => c.FadeOut).ToArray() },
                        { "trimIns", Clips.Select(c => c.TrimIn).ToArray() },
                        { "trimOuts", Clips.Select(c => c.TrimOut).ToArray() },
                        { "names", Clips.Select(c => c.Name ?? "").ToArray() },
                    },
                });
            }

            protected override void OnSceneLoad(SceneOperationKind operation, ReadOnlyDictionary<int, ObjectCtrlInfo> loadedItems)
            {
                if (operation == SceneOperationKind.Import) return; // merging another scene keeps our audio
                var d = GetExtendedData();
                Clear();
                if (d?.data == null) return;
                var files = AsList(d.data, "files");
                if (files == null)
                {
                    if (!d.data.TryGetValue("file", out var f) || !(f is string one)) return;
                    LoadOne(one, d.data.TryGetValue("offset", out var o) ? o : 0f, d.data.TryGetValue("volume", out var v) ? v : 1f, d.data.TryGetValue("muted", out var mu) && Convert.ToBoolean(mu));
                    Changed();
                    return;
                }
                var offsets = AsList(d.data, "offsets");
                var volumes = AsList(d.data, "volumes");
                var mutes = AsList(d.data, "mutes");
                var names = AsList(d.data, "names");
                var shape = new[] { "pan", "speed", "fadeIn", "fadeOut", "trimIn", "trimOut" }.ToDictionary(k => k, k => AsList(d.data, k + "s"));
                for (int i = 0; i < files.Count; i++)
                {
                    LoadOne(files[i] as string, offsets != null && i < offsets.Count ? offsets[i] : 0f, volumes != null && i < volumes.Count ? volumes[i] : 1f, mutes != null && i < mutes.Count && Convert.ToBoolean(mutes[i]));
                    if (Clips.Count == 0 || !(Clips[Clips.Count - 1].File == System.IO.Path.GetFileName(files[i] as string ?? ""))) continue;
                    var args = new Dictionary<string, object>();
                    foreach (var kv in shape) if (kv.Value != null && i < kv.Value.Count) args[kv.Key] = Convert.ToDouble(kv.Value[i]);
                    Shape(Clips[Clips.Count - 1], args);
                    if (names != null && i < names.Count) Clips[Clips.Count - 1].Name = CleanName(names[i] as string);
                }
                Changed();
            }

            private static void LoadOne(string file, object offset, object volume, bool muted)
            {
                if (string.IsNullOrEmpty(file)) return;
                try
                {
                    Add(file, Convert.ToSingle(offset));
                    var c = Clips[Clips.Count - 1];
                    c.Volume = Convert.ToSingle(volume);
                    c.Muted = muted;
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogWarning("Scene audio \"" + file + "\" not loaded: " + e.Message); }
            }
        }
    }
}
