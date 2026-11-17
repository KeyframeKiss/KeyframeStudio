using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Studio;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Snapshot of the head meshes exactly as they were drawn, for Face Studio's picking and highlight.
    ///
    /// Commands run in Update, before face-shape sliders, ABMX and KKPE adjust the bones in LateUpdate; a mesh
    /// baked then is the un-adjusted face (ears/eyes in the wrong place). So while Face Studio is in use, the
    /// head meshes are baked at the end of each frame, after everything has been applied, and the world-space
    /// vertices and normals are kept for the next request.
    /// </summary>
    internal sealed class FaceBaker : MonoBehaviour
    {
        public sealed class Snap
        {
            public SkinnedMeshRenderer Renderer;
            public Vector3[] Pos;     // world space
            public Vector3[] Normal;  // world space
        }

        private static OCIChar _target;
        private static float _until;
        private static readonly Dictionary<int, Mesh> Meshes = new Dictionary<int, Mesh>();
        private static List<Snap> _snaps = new List<Snap>();
        private static OCIChar _snapOf;

        /// <summary>Keep baking this character for a few seconds (renewed by every Face Studio request).</summary>
        public static void Want(OCIChar c)
        {
            _target = c;
            _until = Time.unscaledTime + 4f;
        }

        /// <summary>The latest end-of-frame snapshot for this character (baked now if there is none yet).</summary>
        public static List<Snap> Get(OCIChar c)
        {
            Want(c);
            if (_snapOf != c || _snaps.Count == 0) Bake(c);
            return _snaps;
        }

        private IEnumerator Start()
        {
            var eof = new WaitForEndOfFrame();
            while (true)
            {
                yield return eof;
                if (_target != null && Time.unscaledTime < _until)
                {
                    try { Bake(_target); }
                    catch { _snaps = new List<Snap>(); }
                }
            }
        }

        /// <summary>Head meshes: everything under the head object or the head bone (face, brows, eyes, hair).</summary>
        public static IEnumerable<SkinnedMeshRenderer> HeadMeshes(OCIChar c)
        {
            if (c.charInfo == null) return Enumerable.Empty<SkinnedMeshRenderer>();
            var head = c.charInfo.objHead != null ? c.charInfo.objHead.transform : c.charInfo.transform;
            Transform headBone = null;
            foreach (var t in c.charInfo.GetComponentsInChildren<Transform>(true))
                if (t.name == "cf_j_head") { headBone = t; break; }
            return c.charInfo.GetComponentsInChildren<SkinnedMeshRenderer>(false)
                .Where(r => r.enabled && r.sharedMesh != null && (r.transform.IsChildOf(head) || (headBone != null && r.transform.IsChildOf(headBone))));
        }

        private static void Bake(OCIChar c)
        {
            var list = new List<Snap>();
            if (c != null && c.charInfo != null)
            {
                foreach (var smr in HeadMeshes(c))
                {
                    if (!Meshes.TryGetValue(smr.GetInstanceID(), out var m) || m == null)
                        Meshes[smr.GetInstanceID()] = m = new Mesh { hideFlags = HideFlags.HideAndDontSave };
                    smr.BakeMesh(m);
                    var v = m.vertices;
                    var n = m.normals;
                    // baked vertices are in the renderer's space with its scale already applied
                    var mat = Matrix4x4.TRS(smr.transform.position, smr.transform.rotation, Vector3.one);
                    var rot = smr.transform.rotation;
                    var pos = new Vector3[v.Length];
                    var nrm = new Vector3[v.Length];
                    for (int i = 0; i < v.Length; i++)
                    {
                        pos[i] = mat.MultiplyPoint3x4(v[i]);
                        nrm[i] = i < n.Length ? rot * n[i] : Vector3.zero;
                    }
                    list.Add(new Snap { Renderer = smr, Pos = pos, Normal = nrm });
                }
            }
            _snaps = list;
            _snapOf = c;
        }

        public static void Clear()
        {
            _target = null;
            _snapOf = null;
            _snaps = new List<Snap>();
            foreach (var m in Meshes.Values) if (m != null) Destroy(m);
            Meshes.Clear();
        }
    }
}
