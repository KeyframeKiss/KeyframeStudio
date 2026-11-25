using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;
using TL = Timeline.Timeline;
using TLKeyframe = Timeline.Keyframe;
using Interpolable = Timeline.Interpolable;

namespace StudioEX.Bridge.Api
{
    internal static partial class TimelineImpl
    {
        /// <summary>
        /// timeline.keyPose {ids:[character ids], extra?:[Timeline model ids, e.g. face], t?}: the whole pose exactly as
        /// it is, as keys at the playhead — the first key of a character that has no tracks yet. Its place (position,
        /// rotation), every joint FK poses and every target IK poses get a track (made when missing) and a key. A pose
        /// only the animation holds is first taken over by joints (body, neck, fingers; from the pose on screen), so the
        /// keys hold exactly what's showing. One undo step, the takeover included.
        /// </summary>
        public static object KeyPose(Dictionary<string, object> a)
        {
            var s = Ready;
            float t = UnityEngine.Mathf.Clamp(a.Has("t") ? a.GetFloat("t") : TL.playbackTime, 0f, TL.duration);
            var chars = a.GetList("ids").Select(o => SceneApi.FindOci(System.Convert.ToInt32(o)) as OCIChar).Where(c => c != null).Distinct().ToList();
            if (chars.Count == 0) throw new BridgeException("Select a character first");
            var extra = (a.GetList("extra") ?? new List<object>()).Select(o => o as string).Where(x => !string.IsNullOrEmpty(x)).ToList();

            EndScan();
            int keyed = 0;
            UndoStack.BeginGroup();
            try
            {
                foreach (var c in chars) UndoStack.Push(new SnapUndo("Key the whole pose", null, () => PosingApi.PoseRestorer(c)));

                var targets = new List<KeyValuePair<ObjectCtrlInfo, KeyValuePair<GuideObject, string>>>();
                foreach (var c in chars)
                {
                    var info = c.oiCharInfo;
                    if (!info.enableFK && !info.enableIK)
                    {
                        // the animation holds this pose: joints take it over where it is, so the keys keep exactly that
                        TakeOver(c, b => b.guideObject?.transformTarget != null && b.guideObject.transformTarget.name == "cf_j_hips");
                        TakeOver(c, b => b.guideObject?.transformTarget != null && b.guideObject.transformTarget.name == "cf_j_neck");
                        TakeOver(c, b => ViewportGizmos.FkPart(b.boneGroup) == System.Array.IndexOf(FKCtrl.parts, OIBoneInfo.BoneGroup.LeftHand));
                        TakeOver(c, b => ViewportGizmos.FkPart(b.boneGroup) == System.Array.IndexOf(FKCtrl.parts, OIBoneInfo.BoneGroup.RightHand));
                    }
                    var root = c.guideObject;
                    if (root != null)
                    {
                        targets.Add(Target(c, root, "guideObjectPos"));
                        targets.Add(Target(c, root, "guideObjectRot"));
                    }
                    if (info.enableFK)
                        foreach (var b in c.listBones)
                            if (b?.guideObject != null && b.active) targets.Add(Target(c, b.guideObject, "guideObjectRot"));
                    if (info.enableIK)
                        foreach (var ik in c.listIKTarget)
                            if (ik?.guideObject != null && ik.active)
                            {
                                targets.Add(Target(c, ik.guideObject, "guideObjectPos"));
                                if (ik.guideObject.enableRot) targets.Add(Target(c, ik.guideObject, "guideObjectRot"));
                            }
                }

                var dict = Interpolables;
                var tracks = new List<Interpolable>();
                var made = new List<Interpolable>();
                foreach (var tg in targets)
                {
                    var model = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == tg.Value.Value);
                    if (model == null) continue;
                    var ip = new Interpolable(tg.Key, tg.Value.Key, model);
                    if (dict.TryGetValue(ip.GetHashCode(), out var already)) ip = already;
                    else
                    {
                        dict[ip.GetHashCode()] = ip;
                        AccessTools.Method(Tree.GetType(), "AddLeaf").Invoke(Tree, new object[] { ip, null });
                        made.Add(ip);
                    }
                    if (!tracks.Contains(ip)) tracks.Add(ip);
                }
                // anything else asked for (the face): Timeline's own tracks for the character
                foreach (var c in chars)
                    foreach (var id in extra)
                    {
                        var model = Models.FirstOrDefault(m => m.owner == "Timeline" && m.id == id);
                        if (model == null) continue;
                        var ip = dict.Values.FirstOrDefault(x => x.oci == c && x.owner == "Timeline" && x.id == id);
                        if (ip == null)
                        {
                            var prev = F_selectedOCI.GetValue(s);
                            F_selectedOCI.SetValue(s, c);
                            try { ip = (Interpolable)M_addInterpolable.Invoke(s, new object[] { model }); }
                            finally { F_selectedOCI.SetValue(s, prev); }
                            if (ip != null) made.Add(ip);
                        }
                        if (ip != null && !tracks.Contains(ip)) tracks.Add(ip);
                    }

                var snap = History.Capture(tracks.Where(x => !made.Contains(x)));
                foreach (var ip in made) snap.Add(new TrackSnapshot { Track = ip, Present = false, Keys = new List<KeyValuePair<float, TLKeyframe>>() });
                foreach (var ip in tracks) { AddOrUpdateKey(ip, t); keyed++; }
                History.Push(snap, "Key the whole pose");
            }
            finally { UndoStack.EndGroup("Key the whole pose"); }
            RefreshView();
            AfterEdit(reapply: false);
            Rebase();
            return keyed;
        }

        private static KeyValuePair<ObjectCtrlInfo, KeyValuePair<GuideObject, string>> Target(ObjectCtrlInfo oci, GuideObject go, string model) =>
            new KeyValuePair<ObjectCtrlInfo, KeyValuePair<GuideObject, string>>(oci, new KeyValuePair<GuideObject, string>(go, model));

        private static void TakeOver(OCIChar c, System.Predicate<OCIChar.BoneInfo> which)
        {
            int idx = c.listBones.FindIndex(which);
            if (idx >= 0) ViewportGizmos.EnsureFk(c, idx);
        }
    }
}
