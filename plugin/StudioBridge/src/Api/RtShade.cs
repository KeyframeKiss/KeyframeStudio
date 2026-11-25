using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Ray-traced shade for quality stills (Shoot › Output › Pictures › Quality): the scene's triangles as they are this
    /// frame (characters' skinned meshes baked, props and the map when their meshes can be read), a bounding-volume
    /// tree over them, and a compute shader that casts a few short rays per pixel per averaged render. Takes the place
    /// of the on-screen ambient occlusion while the still renders, with that effect's radius, strength and colour.
    /// </summary>
    internal sealed class RtShade : IDisposable
    {
        public static RtShade Active; // set while a quality still renders with it

        private ComputeBuffer _nodes, _tris;
        private readonly ComputeShader _cs;
        private readonly int _kernel;
        public int Triangles { get; private set; }
        public int Rays = 4;
        /// <summary>Which winding is a triangle's front (Unity: clockwise as seen from the front).</summary>
        public static float FrontSign = -1f; // checked on the sample scene: +1 shaded boxed-in insides black
        private int _seed;

        private RtShade(ComputeShader cs)
        {
            _cs = cs;
            _kernel = cs.FindKernel("Trace");
        }

        /// <summary>Gather and build (a second or two in a big scene); null when compute shaders aren't available.</summary>
        public static RtShade Build(Camera cam, out string why)
        {
            why = null;
            var cs = FxApi.GetCompute("KfRtao");
            if (cs == null) { why = "this graphics card can't run compute shaders"; return null; }
            var tris = Gather(cam);
            if (tris.Count == 0) { why = "nothing to trace"; return null; }
            var rt = new RtShade(cs);
            rt.Upload(tris);
            return rt;
        }

        // ------------------------------------------------------------------ geometry

        private static List<Vector3> Gather(Camera cam)
        {
            var v = new List<Vector3>(1 << 20);
            var mesh = new Mesh();
            int mask = cam.cullingMask;
            foreach (var r in UnityEngine.Object.FindObjectsOfType<Renderer>())
            {
                if (r == null || !r.enabled || !r.gameObject.activeInHierarchy || (mask & (1 << r.gameObject.layer)) == 0) continue;
                if (!(r is MeshRenderer) && !(r is SkinnedMeshRenderer)) continue; // not particles, lines, sprites
                // solid things only (cut-out like hair counts; glass and other see-through materials don't)
                var mats = r.sharedMaterials;
                if (mats.Length == 0 || mats.All(m => m == null || m.renderQueue > 2500)) continue;
                try
                {
                    Mesh src;
                    Matrix4x4 m;
                    if (r is SkinnedMeshRenderer sk)
                    {
                        if (sk.sharedMesh == null) continue;
                        sk.BakeMesh(mesh);
                        src = mesh;
                        m = Matrix4x4.TRS(sk.transform.position, sk.transform.rotation, Vector3.one); // the bake has the scale in it
                    }
                    else
                    {
                        var mf = r.GetComponent<MeshFilter>();
                        src = mf != null ? mf.sharedMesh : null;
                        if (src == null || !src.isReadable) continue;
                        m = r.transform.localToWorldMatrix;
                    }
                    var verts = src.vertices;
                    for (int sub = 0; sub < src.subMeshCount; sub++)
                    {
                        if (sub < mats.Length && (mats[sub] == null || mats[sub].renderQueue > 2500)) continue;
                        if (src.GetTopology(sub) != MeshTopology.Triangles) continue;
                        var idx = src.GetTriangles(sub);
                        for (int i = 0; i + 2 < idx.Length; i += 3)
                        {
                            v.Add(m.MultiplyPoint3x4(verts[idx[i]]));
                            v.Add(m.MultiplyPoint3x4(verts[idx[i + 1]]));
                            v.Add(m.MultiplyPoint3x4(verts[idx[i + 2]]));
                        }
                    }
                }
                catch (Exception e) { StudioBridgePlugin.Logger.LogDebug("Ray-traced shade: skipped " + r.name + ": " + e.Message); }
            }
            UnityEngine.Object.Destroy(mesh);
            return v;
        }

        // ------------------------------------------------------------------ the tree (midpoint split, leaves of up to 4)

        private void Upload(List<Vector3> v)
        {
            int n = v.Count / 3;
            Triangles = n;
            var cen = new Vector3[n];
            var order = new int[n];
            for (int i = 0; i < n; i++) { cen[i] = (v[i * 3] + v[i * 3 + 1] + v[i * 3 + 2]) / 3f; order[i] = i; }
            var nodes = new List<float>(n * 4);
            // node: min.xyz, first (child or triangle), max.xyz, count (0 = inner); children of a node sit side by side
            var work = new Stack<int[]>(); // {node, start, count}
            AddNode(nodes);
            work.Push(new[] { 0, 0, n });
            while (work.Count > 0)
            {
                var w = work.Pop();
                int node = w[0], start = w[1], count = w[2];
                Vector3 mn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue), mx = -mn, cmn = mn, cmx = mx;
                for (int i = start; i < start + count; i++)
                {
                    int t = order[i];
                    for (int k = 0; k < 3; k++) { mn = Vector3.Min(mn, v[t * 3 + k]); mx = Vector3.Max(mx, v[t * 3 + k]); }
                    cmn = Vector3.Min(cmn, cen[t]);
                    cmx = Vector3.Max(cmx, cen[t]);
                }
                SetBounds(nodes, node, mn, mx);
                if (count <= 4)
                {
                    SetLeaf(nodes, node, start, count);
                    continue;
                }
                var ext = cmx - cmn;
                int axis = ext.x > ext.y && ext.x > ext.z ? 0 : ext.y > ext.z ? 1 : 2;
                float mid = (cmn[axis] + cmx[axis]) * 0.5f;
                int a = start, b = start + count - 1;
                while (a <= b)
                {
                    if (cen[order[a]][axis] < mid) a++;
                    else { int tmp = order[a]; order[a] = order[b]; order[b] = tmp; b--; }
                }
                int left = a - start;
                if (left == 0 || left == count) left = count / 2; // all on one side: halve
                int child = nodes.Count / 8;
                AddNode(nodes);
                AddNode(nodes);
                SetInner(nodes, node, child);
                work.Push(new[] { child, start, left });
                work.Push(new[] { child + 1, start + left, count - left });
            }
            // triangles in leaf order: v0, edge 1, edge 2
            var tri = new float[n * 12];
            for (int i = 0; i < n; i++)
            {
                int t = order[i];
                Vector3 v0 = v[t * 3], e1 = v[t * 3 + 1] - v0, e2 = v[t * 3 + 2] - v0;
                int o = i * 12;
                tri[o] = v0.x; tri[o + 1] = v0.y; tri[o + 2] = v0.z;
                tri[o + 4] = e1.x; tri[o + 5] = e1.y; tri[o + 6] = e1.z;
                tri[o + 8] = e2.x; tri[o + 9] = e2.y; tri[o + 10] = e2.z;
            }
            _nodes = new ComputeBuffer(nodes.Count / 4, 16);
            _nodes.SetData(nodes.ToArray());
            _tris = new ComputeBuffer(n * 3, 16);
            _tris.SetData(tri);
        }

        private static void AddNode(List<float> l) { for (int i = 0; i < 8; i++) l.Add(0f); }
        private static void SetBounds(List<float> l, int n, Vector3 mn, Vector3 mx)
        {
            l[n * 8] = mn.x; l[n * 8 + 1] = mn.y; l[n * 8 + 2] = mn.z;
            l[n * 8 + 4] = mx.x; l[n * 8 + 5] = mx.y; l[n * 8 + 6] = mx.z;
        }
        private static float Bits(int i) => BitConverter.ToSingle(BitConverter.GetBytes(i), 0);
        private static void SetLeaf(List<float> l, int n, int first, int count) { l[n * 8 + 3] = Bits(first); l[n * 8 + 7] = Bits(count); }
        private static void SetInner(List<float> l, int n, int child) { l[n * 8 + 3] = Bits(child); l[n * 8 + 7] = Bits(0); }

        // ------------------------------------------------------------------ one view

        /// <summary>The shade for the view just rendered: depth (metres, per pixel) in, openness 0..1 out.</summary>
        public void Trace(Camera cam, RenderTexture depth, RenderTexture output, float radius, float strength)
        {
            _cs.SetBuffer(_kernel, "_Nodes", _nodes);
            _cs.SetBuffer(_kernel, "_Tris", _tris);
            _cs.SetTexture(_kernel, "_Depth", depth);
            _cs.SetTexture(_kernel, "_AoOut", output);
            var p = cam.projectionMatrix;
            // (the lens's sheared view, when set); Unity 5.6 compute shaders take a matrix as 16 floats, column by column
            var c2w = cam.worldToCameraMatrix.inverse;
            var f = new float[16];
            for (int i = 0; i < 16; i++) f[i] = c2w[i];
            _cs.SetFloats("_CamToWorld", f);
            _cs.SetVector("_Proj", new Vector4(1f / p[0, 0], 1f / p[1, 1], output.width, output.height));
            _cs.SetVector("_Params", new Vector4(Mathf.Max(0.01f, radius), Rays, (_seed++ * 7919) % 100003, cam.farClipPlane * 0.9f));
            _cs.SetVector("_Params2", new Vector4(Mathf.Max(0f, strength), FrontSign, 0, 0));
            _cs.Dispatch(_kernel, (output.width + 7) / 8, (output.height + 7) / 8, 1);
        }

        public void Dispose()
        {
            _nodes?.Release();
            _tris?.Release();
            _nodes = _tris = null;
        }
    }
}
