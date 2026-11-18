using System;
using System.Globalization;
using System.Xml;
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
    }
}
