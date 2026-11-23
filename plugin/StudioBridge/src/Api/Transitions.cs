using System;
using System.Collections.Generic;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>One camera key to bake from the shots: Apply puts Studio's camera there; Glide eases from the key before (else a hard cut).</summary>
    internal struct CutKey
    {
        public float T;
        public Action Apply;
        public bool Glide;
        public bool Smooth;
    }

    /// <summary>
    /// Shot transitions drawn over Studio's picture: dips to black / white and dissolves. Sits last on Studio's main
    /// camera and is only switched on while a transition is showing, so it's part of what renders and the monitor
    /// record, and costs nothing otherwise. A dissolve blends in a picture of the outgoing shot, rendered once more
    /// per frame (at the end of the previous frame) only while the dissolve lasts.
    /// </summary>
    internal sealed class TransitionFx : MonoBehaviour
    {
        /// <summary>What to draw this frame.</summary>
        internal sealed class State
        {
            public string Type;
            public float F;               // how far through the transition (0 … 1)
            public Color Fade;            // dips: the colour
            public float FadeA;           // dips: how much of it
            public float OutA;            // dissolve: how much of the outgoing shot is still showing
            public Dictionary<string, object> Out; // dissolve: the outgoing shot (its camera)
            public Dictionary<string, object> Cam; // glide / dissolve: the camera to show (a "cam" holder)
            public string Id;             // the incoming shot
        }

        /// <summary>From live cuts, every frame (null when nothing is in transition).</summary>
        internal static State Live;
        /// <summary>For one render (the monitor's program view), taking the place of Live.</summary>
        internal static State Override;

        internal static RenderTexture OutRT;
        private static string _outFor;   // the outgoing shot OutRT shows
        private static int _outFrame = -10;
        internal static bool RenderingOut;
        private static Material _mat;
        private static int _calls, _drawn;
        private static string _lastError;

        /// <summary>What the effect is doing (for tests and bug reports).</summary>
        internal static Dictionary<string, object> Diag()
        {
            var cam = Camera.main;
            var fx = cam != null ? cam.GetComponent<TransitionFx>() : null;
            var all = cam != null ? cam.GetComponents<MonoBehaviour>() : new MonoBehaviour[0];
            return new Dictionary<string, object>
            {
                { "camera", cam != null ? cam.name : null },
                { "component", fx != null }, { "enabled", fx != null && fx.enabled },
                { "last", fx != null && all.Length > 0 && all[all.Length - 1] == fx },
                { "shader", Mat != null ? Mat.shader.name : null },
                { "calls", _calls }, { "drawn", _drawn }, { "error", _lastError },
                { "outRT", OutRT != null }, { "outFor", _outFor }, { "outAge", Time.frameCount - _outFrame },
                { "effects", string.Join(", ", Array.ConvertAll(all, b => b.GetType().Name + (b.enabled ? "" : " (off)"))) },
            };
        }

        private static Material Mat
        {
            get
            {
                if (_mat != null) return _mat;
                var sh = Shader.Find("UI/Default") ?? Shader.Find("Sprites/Default");
                if (sh == null) return null;
                _mat = new Material(sh) { hideFlags = HideFlags.HideAndDontSave };
                _mat.SetInt("unity_GUIZTestMode", (int)UnityEngine.Rendering.CompareFunction.Always);
                // UI/Default clips to a rectangle that is empty unless a canvas sets it: everything, here
                _mat.SetVector("_ClipRect", new Vector4(-32767f, -32767f, 32767f, 32767f));
                _mat.SetFloat("_UseUIAlphaClip", 0f);
                return _mat;
            }
        }

        private static bool OutReady(State s) => s?.Out != null && OutRT != null && _outFor == s.Out.GetString("id") && Time.frameCount - _outFrame <= 3;

        private static bool Needs(State s) => s != null && (s.FadeA > 0.002f || (s.OutA > 0.002f && OutReady(s)));

        /// <summary>Switch the effect on Studio's camera on or off for what has to show now.</summary>
        internal static void Sync(Camera cam)
        {
            if (cam == null) return;
            bool need = Needs(Override ?? Live);
            var fx = cam.GetComponent<TransitionFx>();
            if (fx == null)
            {
                if (!need) return;
                fx = cam.gameObject.AddComponent<TransitionFx>();
            }
            if (fx.enabled != need) fx.enabled = need;
        }

        private void OnRenderImage(RenderTexture src, RenderTexture dst)
        {
            Graphics.Blit(src, dst);
            _calls++;
            if (RenderingOut) return; // the outgoing shot's own picture: as it is
            var s = Override ?? Live;
            var m = Mat;
            if (s == null || m == null) return;
            _drawn++;
            var prev = RenderTexture.active;
            RenderTexture.active = dst;
            GL.PushMatrix();
            GL.LoadOrtho();
            try
            {
                if (s.OutA > 0.002f && OutReady(s)) Quad(m, OutRT, new Color(1f, 1f, 1f, s.OutA));
                if (s.FadeA > 0.002f) Quad(m, Texture2D.whiteTexture, new Color(s.Fade.r, s.Fade.g, s.Fade.b, s.FadeA));
            }
            catch (Exception e) { _lastError = e.Message; }
            finally
            {
                GL.PopMatrix();
                RenderTexture.active = prev;
            }
        }

        private static void Quad(Material m, Texture tex, Color c)
        {
            m.mainTexture = tex;
            m.SetPass(0);
            GL.Begin(GL.QUADS);
            GL.Color(c);
            GL.TexCoord2(0, 0); GL.Vertex3(0, 0, 0);
            GL.TexCoord2(0, 1); GL.Vertex3(0, 1, 0);
            GL.TexCoord2(1, 1); GL.Vertex3(1, 1, 0);
            GL.TexCoord2(1, 0); GL.Vertex3(1, 0, 0);
            GL.End();
        }

        /// <summary>A picture through the outgoing shot's camera, the size of Studio's window (Studio's camera is put back).</summary>
        internal static void RenderOutgoing(Camera cam, Dictionary<string, object> outShot)
        {
            if (cam == null || outShot == null) return;
            int w = Mathf.Max(16, Screen.width), h = Mathf.Max(16, Screen.height);
            if (OutRT == null || OutRT.width != w || OutRT.height != h)
            {
                if (OutRT != null) { OutRT.Release(); Destroy(OutRT); }
                OutRT = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32) { name = "StudioEX.Dissolve" };
            }
            var pos = cam.transform.position;
            var rot = cam.transform.rotation;
            float fov = cam.fieldOfView;
            var target = cam.targetTexture;
            try
            {
                if (!ShotApi.PlaceMainCamera(outShot)) return;
                cam.targetTexture = OutRT;
                RenderingOut = true;
                cam.Render();
                _outFor = outShot.GetString("id");
                _outFrame = Time.frameCount;
            }
            finally
            {
                RenderingOut = false;
                cam.targetTexture = target;
                cam.transform.position = pos;
                cam.transform.rotation = rot;
                cam.fieldOfView = fov;
            }
        }

        /// <summary>A scene change: nothing in transition, and the dissolve picture belongs to no shot.</summary>
        internal static void Reset()
        {
            Live = null;
            Override = null;
            _outFor = null;
            Sync(Camera.main);
        }
    }
}
