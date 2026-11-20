using System;
using System.Collections.Generic;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// A render version's own camera framing, applied to the main camera just before it renders and undone right after,
    /// so Timeline's camera animation and Studio's camera are never changed: "adjust" slides (a lens shift, in shares of the frame) and zooms
    /// the animated camera (a vertical cut usually wants the subject re-centred), "fixed" holds one view the user set. Also shown
    /// live in Studio's window as a preview.
    /// </summary>
    internal sealed class RenderFraming : MonoBehaviour
    {
        public sealed class Framing
        {
            public string Mode;
            public float X, Y, Zoom = 1f;
            public Vector3 Pos;
            public Quaternion Rot;
            public float Fov;
        }

        /// <summary>The framing in use (a render job's, or the preview); null = the camera as it is.</summary>
        public static Framing Active;

        private Vector3 _pos;
        private Quaternion _rot;
        private float _fov;
        private Camera _applied;
        private bool _shifted;

        private void Awake()
        {
            Camera.onPreCull += Pre;
            Camera.onPostRender += Post;
        }

        private void OnDestroy()
        {
            Camera.onPreCull -= Pre;
            Camera.onPostRender -= Post;
        }

        public static void Register(CommandRouter r)
        {
            // show a framing in Studio's window (null turns it off)
            r.Add("render.framingPreview", a =>
            {
                Active = From(a.ContainsKey("framing") ? a["framing"] as Dictionary<string, object> : null);
                return Active != null;
            });
            // Studio's view right now, for a version's "own view"
            r.Add("render.view", a =>
            {
                var cam = Camera.main ?? throw new BridgeException("No camera");
                var t = cam.transform;
                return new Dictionary<string, object>
                {
                    { "pos", new List<object> { (double)t.position.x, (double)t.position.y, (double)t.position.z } },
                    { "rot", new List<object> { (double)t.rotation.x, (double)t.rotation.y, (double)t.rotation.z, (double)t.rotation.w } },
                    { "fov", (double)cam.fieldOfView },
                };
            });
        }

        /// <summary>{mode: "adjust", x, y, zoom} or {mode: "fixed", pos, rot, fov}; anything else = none.</summary>
        public static Framing From(Dictionary<string, object> f)
        {
            if (f == null) return null;
            string mode = f.GetString("mode");
            if (mode == "adjust")
            {
                var fr = new Framing { Mode = mode, X = f.GetFloat("x"), Y = f.GetFloat("y"), Zoom = Mathf.Clamp(f.GetFloat("zoom", 1f), 0.25f, 4f) };
                return Mathf.Abs(fr.X) < 1e-4f && Mathf.Abs(fr.Y) < 1e-4f && Mathf.Abs(fr.Zoom - 1f) < 1e-4f ? null : fr;
            }
            if (mode == "fixed" && f.GetList("pos").Count >= 3 && f.GetList("rot").Count >= 4)
            {
                var p = f.GetList("pos");
                var q = f.GetList("rot");
                float F(List<object> l, int i) => Convert.ToSingle(l[i]);
                return new Framing { Mode = mode, Pos = new Vector3(F(p, 0), F(p, 1), F(p, 2)), Rot = new Quaternion(F(q, 0), F(q, 1), F(q, 2), F(q, 3)), Fov = Mathf.Clamp(f.GetFloat("fov", 45f), 5f, 150f) };
            }
            return null;
        }

        private void Pre(Camera cam)
        {
            var f = Active;
            if (f == null || _applied != null || cam == null || cam != Camera.main) return;
            var t = cam.transform;
            _pos = t.position;
            _rot = t.rotation;
            _fov = cam.fieldOfView;
            _applied = cam;
            if (f.Mode == "fixed")
            {
                t.position = f.Pos;
                t.rotation = f.Rot;
                cam.fieldOfView = f.Fov;
            }
            else
            {
                // a lens shift, not a camera move: the picture slides like a cut-out moved across a wider frame — no
                // parallax, and the camera can't end up inside something. X / Y are shares of the output frame.
                float fov = Mathf.Clamp(_fov / f.Zoom, 1f, 170f);
                var p = Matrix4x4.Perspective(fov, cam.aspect, cam.nearClipPlane, cam.farClipPlane);
                p[0, 2] = 2f * f.X;
                p[1, 2] = 2f * f.Y;
                cam.projectionMatrix = p;
                _shifted = true;
            }
        }

        private void Post(Camera cam)
        {
            if (_applied == null || cam != _applied) return;
            var t = cam.transform;
            if (_shifted) cam.ResetProjectionMatrix();
            _shifted = false;
            t.position = _pos;
            t.rotation = _rot;
            cam.fieldOfView = _fov;
            _applied = null;
        }
    }
}
