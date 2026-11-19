using System;
using System.Globalization;
using System.Xml;
using Studio;
using UnityEngine;
using TL = Timeline.Timeline;
using InterpolableModel = Timeline.InterpolableModel;

namespace StudioEX.Bridge.Api
{
    /// <summary>Scene-wide Timeline track types for our own values (effects …): one track each, not tied to an object.</summary>
    internal static partial class TimelineImpl
    {
        private static float ReadF(XmlNode n, string a) => float.Parse(n.Attributes[a].Value, CultureInfo.InvariantCulture);
        private static void WriteF(XmlTextWriter w, string a, float v) => w.WriteAttributeString(a, v.ToString("R", CultureInfo.InvariantCulture));

        public static void AddSceneFloatModel(string owner, string id, string name, Func<float> get, Action<float> set)
        {
            TL.AddInterpolableModel(new InterpolableModel(owner, id, null, name,
                (oci, p, l, r, f) => set(Mathf.LerpUnclamped((float)l, (float)r, f)), null,
                oci => oci == null,
                (oci, p) => get(),
                (p, node) => ReadF(node, "value"),
                (p, w, o) => WriteF(w, "value", (float)o),
                null, null, null, false));
        }

        public static void AddSceneColorModel(string owner, string id, string name, Func<Vector4> get, Action<Vector4> set)
        {
            TL.AddInterpolableModel(new InterpolableModel(owner, id, null, name,
                (oci, p, l, r, f) => set(Vector4.LerpUnclamped((Vector4)l, (Vector4)r, f)), null,
                oci => oci == null,
                (oci, p) => get(),
                (p, node) => new Vector4(ReadF(node, "r"), ReadF(node, "g"), ReadF(node, "b"), ReadF(node, "a")),
                (p, w, o) => { var v = (Vector4)o; WriteF(w, "r", v.x); WriteF(w, "g", v.y); WriteF(w, "b", v.z); WriteF(w, "a", v.w); },
                null, null, null, false));
        }

        /// <summary>A value of one object (e.g. a projector on a folder): a track per object, offered only where <paramref name="fits"/>.</summary>
        public static void AddObjectFloatModel(string owner, string id, string name, Func<ObjectCtrlInfo, bool> fits, Func<ObjectCtrlInfo, float> get, Action<ObjectCtrlInfo, float> set)
        {
            TL.AddInterpolableModel(new InterpolableModel(owner, id, null, name,
                (oci, p, l, r, f) => { if (oci != null && fits(oci)) set(oci, Mathf.LerpUnclamped((float)l, (float)r, f)); }, null,
                oci => oci != null && fits(oci),
                (oci, p) => get(oci),
                (p, node) => ReadF(node, "value"),
                (p, w, o) => WriteF(w, "value", (float)o),
                null, null, null, true));
        }

        public static void AddObjectColorModel(string owner, string id, string name, Func<ObjectCtrlInfo, bool> fits, Func<ObjectCtrlInfo, Vector4> get, Action<ObjectCtrlInfo, Vector4> set)
        {
            TL.AddInterpolableModel(new InterpolableModel(owner, id, null, name,
                (oci, p, l, r, f) => { if (oci != null && fits(oci)) set(oci, Vector4.LerpUnclamped((Vector4)l, (Vector4)r, f)); }, null,
                oci => oci != null && fits(oci),
                (oci, p) => get(oci),
                (p, node) => new Vector4(ReadF(node, "r"), ReadF(node, "g"), ReadF(node, "b"), ReadF(node, "a")),
                (p, w, o) => { var v = (Vector4)o; WriteF(w, "r", v.x); WriteF(w, "g", v.y); WriteF(w, "b", v.z); WriteF(w, "a", v.w); },
                null, null, null, true));
        }
    }
}
