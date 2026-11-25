using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using RootMotion.FinalIK;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Character › Posing: how each limb is posed (joints = FK, a target = IK, or the animation), switched without the
    /// pose jumping; and KKPE's advanced posing, driven from outside its window: IK strength per effector and bend
    /// goals (elbows / knees), joint correction, copy a limb to the other side, bust and hair / skirt physics.
    /// KKPE keeps its own values (saved with the character) and applies them every frame; we call its setters. Every
    /// change here is one step in our undo. Bones by number reuse face.get / face.set / face.reset (any bone).
    /// </summary>
    internal static class PosingApi
    {
        // ------------------------------------------------------------------ limbs and modes

        // Studio's IK parts: 0 body, 1 right leg, 2 left leg, 3 right arm, 4 left arm
        private static readonly string[] Limbs = { "body", "legR", "legL", "armR", "armL" };
        // a bone of each limb, to hand over to FK from the pose on screen
        // Studio's FK parts, in FKCtrl.parts order
        private static readonly string[] FkNames = { "hair", "neck", "chest", "body", "handR", "handL", "skirt" };
        private static readonly string[] LimbBone = { "cf_j_hips", "cf_j_thigh00_R", "cf_j_thigh00_L", "cf_j_arm00_R", "cf_j_arm00_L" };

        public static void Register(CommandRouter r)
        {
            r.Add("posing.get", a => Get(CharaApi.Chara(a.GetInt("id"))));
            r.Add("posing.mode", a => SetMode(a));
            r.Add("posing.ik", a => SetIk(a));
            r.Add("posing.joints", a => SetJoints(a));
            r.Add("posing.copy", a => CopyLimb(a));
            r.Add("posing.bones", a => Bones(CharaApi.Chara(a.GetInt("id"))));
            r.Add("posing.bust", a => SetBust(a));
            r.Add("posing.dyn", a => SetDyn(a));
            r.Add("posing.kkpeOn", a =>
            {
                var pc = Pc(CharaApi.Chara(a.GetInt("id")), true);
                ((Behaviour)pc).enabled = true;
                return true;
            });
        }

        private static string ModeOf(OCIChar c, int part)
        {
            if (ViewportGizmos.IkOn(c, part)) return "ik";
            int body = Array.IndexOf(FKCtrl.parts, OIBoneInfo.BoneGroup.Body);
            return ViewportGizmos.FkOn(c, body) ? "fk" : "anim";
        }

        private static object SetMode(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            string mode = a.GetString("mode");
            // the other FK parts (neck, fingers, hair, bust, skirt): by joints from the pose on screen, or not
            int extra = Array.IndexOf(FkNames, a.GetString("part"));
            if (extra >= 0)
            {
                UndoStack.Push(new SnapUndo("Pose " + a.GetString("part") + (mode == "fk" ? " by its joints" : " by the animation"), null, () => PoseRestorer(c)));
                if (mode == "fk")
                {
                    int idx = c.listBones.FindIndex(b => ViewportGizmos.FkPart(b.boneGroup) == extra);
                    if (idx >= 0) ViewportGizmos.EnsureFk(c, idx);
                }
                else if (ViewportGizmos.FkOn(c, extra)) c.ActiveFK(FKCtrl.parts[extra], false, false);
                return Get(c);
            }
            var limbs = a.Has("limb") ? new[] { Array.IndexOf(Limbs, a.GetString("limb")) } : Enumerable.Range(0, 5).ToArray();
            if (limbs.Any(i => i < 0)) throw new BridgeException("Unknown limb");
            UndoStack.Push(new SnapUndo(mode == "anim" ? "Let the animation play" : "Pose " + (a.GetString("limb") ?? "every limb") + (mode == "ik" ? " by a target" : " by its joints"), null, () => PoseRestorer(c)));
            if (mode == "anim")
            {
                // the animation drives everything again: FK and IK off for the whole character
                if (c.oiCharInfo.enableFK) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, false, false);
                if (c.oiCharInfo.enableIK) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, false, false);
                return Get(c);
            }
            foreach (int part in limbs)
            {
                if (mode == "ik")
                {
                    int idx = c.listIKTarget.FindIndex(t => ViewportGizmos.IkPart(t.boneGroup) == part);
                    if (idx >= 0) ViewportGizmos.EnsureIk(c, idx);
                }
                else if (mode == "fk")
                {
                    int idx = c.listBones.FindIndex(b => b.guideObject?.transformTarget != null && b.guideObject.transformTarget.name == LimbBone[part]);
                    if (idx >= 0) ViewportGizmos.EnsureFk(c, idx); // from the pose on screen (IK's result: IK → FK)
                    // the body isn't a limb EnsureFk hands over: its target lets go here
                    if (part == 0 && ViewportGizmos.IkOn(c, 0)) c.ActiveIK((OIBoneInfo.BoneGroup)1, false, false);
                }
                else throw new BridgeException("Unknown mode " + mode);
            }
            return Get(c);
        }

        // ------------------------------------------------------------------ KKPE plumbing

        private static bool _resolved;
        private static Type _pcType, _cpcType;
        private static FieldInfo _fIk, _fBones, _fDyn, _fBust, _fIks, _fDirtyIks, _fChild, _fAliases, _fDirtyBones, _fDirtyBust, _fDirtyDyn, _fDynList;
        private static MethodInfo _mSetDirty, _mSetPosW, _mSetRotW, _mSetBend, _mCopyLimb, _mCopyHand;
        private static PropertyInfo _pCrotch, _pAnkleL, _pAnkleR, _pOptimize;

        private static bool Resolve()
        {
            if (_resolved) return _pcType != null;
            _resolved = true;
            try
            {
                _pcType = AccessTools.TypeByName("HSPE.PoseController");
                _cpcType = AccessTools.TypeByName("HSPE.CharaPoseController");
                var ik = AccessTools.TypeByName("HSPE.AMModules.IKEditor");
                var be = AccessTools.TypeByName("HSPE.AMModules.BonesEditor");
                var dyn = AccessTools.TypeByName("HSPE.AMModules.DynamicBonesEditor");
                var bust = AccessTools.TypeByName("HSPE.AMModules.BoobsEditor");
                if (_pcType == null || _cpcType == null || ik == null) { _pcType = null; return false; }
                _fIk = AccessTools.Field(_pcType, "_ikEditor");
                _fBones = AccessTools.Field(_pcType, "_bonesEditor");
                _fDyn = AccessTools.Field(_pcType, "_dynamicBonesEditor");
                _fBust = AccessTools.Field(_cpcType, "_boobsEditor");
                _fChild = AccessTools.Field(_pcType, "_childObjects");
                _fIks = AccessTools.Field(ik, "_iks");
                _fDirtyIks = AccessTools.Field(ik, "_dirtyIks");
                _mSetDirty = AccessTools.Method(ik, "SetIKDirty");
                _mSetPosW = AccessTools.Method(ik, "SetEffectorPositionWeight");
                _mSetRotW = AccessTools.Method(ik, "SetEffectorRotationWeight");
                _mSetBend = AccessTools.Method(ik, "SetConstraintBendWeight");
                _mCopyLimb = AccessTools.Method(_cpcType, "CopyLimbToTwin");
                _mCopyHand = AccessTools.Method(_cpcType, "CopyHandToTwin");
                _pCrotch = AccessTools.Property(_cpcType, "crotchJointCorrection");
                _pAnkleL = AccessTools.Property(_cpcType, "leftFootJointCorrection");
                _pAnkleR = AccessTools.Property(_cpcType, "rightFootJointCorrection");
                _pOptimize = AccessTools.Property(_cpcType, "optimizeIK");
                if (be != null) { _fAliases = AccessTools.Field(be, "_boneAliases"); _fDirtyBones = AccessTools.Field(be, "_dirtyBones"); }
                if (bust != null) _fDirtyBust = AccessTools.Field(bust, "_dirtyDynamicBones");
                if (dyn != null) { _fDirtyDyn = AccessTools.Field(dyn, "_dirtyDynamicBones"); _fDynList = AccessTools.Field(dyn, "_dynamicBones"); }
                return true;
            }
            catch (Exception e)
            {
                StudioBridgePlugin.Logger.LogWarning("Posing: KKPE not usable: " + e.Message);
                _pcType = null;
                return false;
            }
        }

        private static Component Pc(OCIChar c, bool required)
        {
            if (!Resolve())
            {
                if (required) throw new BridgeException("This needs KKPE (KK Pose Editor), which isn't installed or isn't a supported version");
                return null;
            }
            var pc = c.guideObject?.transformTarget != null ? c.guideObject.transformTarget.GetComponent(_pcType) : null;
            if (pc == null && required) throw new BridgeException("KKPE hasn't attached to this character yet — select it once in Studio");
            return pc;
        }

        private static Component Ready(OCIChar c)
        {
            var pc = Pc(c, true);
            if (!((Behaviour)pc).enabled) throw new BridgeException("KKPE is switched off for this character (its Disable button). Turn it back on here first.");
            return pc;
        }

        // EditableValue<T> is a struct: boxed copies, hasValue / value
        private static bool EvHas(object ev) => ev != null && (bool)(ev.GetType().GetProperty("hasValue")?.GetValue(ev, null) ?? ev.GetType().GetField("hasValue")?.GetValue(ev) ?? false);
        private static object EvVal(object ev) => ev.GetType().GetProperty("value")?.GetValue(ev, null) ?? ev.GetType().GetField("value")?.GetValue(ev);
        private static void EvClear(object owner, string field)
        {
            var f = AccessTools.Field(owner.GetType(), field);
            if (f != null) f.SetValue(owner, Activator.CreateInstance(f.FieldType));
        }

        // ------------------------------------------------------------------ IK strength and bend goals

        private sealed class Eff
        {
            public string Key, Label, Data;
            public int Part;
            public bool Rot;
            public Func<IKSolverFullBodyBiped, IKEffector> Get;
        }
        private static readonly Eff[] Effectors =
        {
            new Eff { Key = "body", Label = "Body", Data = "body", Part = 0, Get = s => s.bodyEffector },
            new Eff { Key = "shoulderL", Label = "Left shoulder", Data = "leftShoulder", Part = 4, Get = s => s.leftShoulderEffector },
            new Eff { Key = "handL", Label = "Left hand", Data = "leftHand", Part = 4, Rot = true, Get = s => s.leftHandEffector },
            new Eff { Key = "shoulderR", Label = "Right shoulder", Data = "rightShoulder", Part = 3, Get = s => s.rightShoulderEffector },
            new Eff { Key = "handR", Label = "Right hand", Data = "rightHand", Part = 3, Rot = true, Get = s => s.rightHandEffector },
            new Eff { Key = "thighL", Label = "Left thigh", Data = "leftThigh", Part = 2, Get = s => s.leftThighEffector },
            new Eff { Key = "footL", Label = "Left foot", Data = "leftFoot", Part = 2, Rot = true, Get = s => s.leftFootEffector },
            new Eff { Key = "thighR", Label = "Right thigh", Data = "rightThigh", Part = 1, Get = s => s.rightThighEffector },
            new Eff { Key = "footR", Label = "Right foot", Data = "rightFoot", Part = 1, Rot = true, Get = s => s.rightFootEffector },
        };
        private sealed class Bend
        {
            public string Key, Label, Data;
            public int Part;
            public Func<IKSolverFullBodyBiped, IKConstraintBend> Get;
        }
        private static readonly Bend[] Bends =
        {
            new Bend { Key = "elbowL", Label = "Left elbow", Data = "leftArm", Part = 4, Get = s => s.leftArmChain.bendConstraint },
            new Bend { Key = "elbowR", Label = "Right elbow", Data = "rightArm", Part = 3, Get = s => s.rightArmChain.bendConstraint },
            new Bend { Key = "kneeL", Label = "Left knee", Data = "leftLeg", Part = 2, Get = s => s.leftLegChain.bendConstraint },
            new Bend { Key = "kneeR", Label = "Right knee", Data = "rightLeg", Part = 1, Get = s => s.rightLegChain.bendConstraint },
        };

        private static IKSolverFullBodyBiped Solver(OCIChar c) => c.finalIK != null ? c.finalIK.solver : null;

        /// <summary>KKPE's stored IK values for this character (null when nothing was changed yet).</summary>
        private static object IkData(Component pc, OCIChar c, bool create)
        {
            var ed = _fIk.GetValue(pc);
            if (ed == null) return null;
            var iks = (IDictionary)_fIks.GetValue(ed);
            if (iks == null || c.finalIK == null || !iks.Contains(c.finalIK)) return null;
            var wrap = iks[c.finalIK];
            if (create) return _mSetDirty.Invoke(ed, new[] { wrap });
            var dirty = (IDictionary)_fDirtyIks.GetValue(ed);
            return dirty != null && dirty.Contains(wrap) ? dirty[wrap] : null;
        }

        private static object Field(object o, string name) => o == null ? null : AccessTools.Field(o.GetType(), name)?.GetValue(o);

        private static List<object> IkList(Component pc, OCIChar c)
        {
            var s = Solver(c);
            var list = new List<object>();
            if (s == null) return list;
            var data = pc != null ? IkData(pc, c, false) : null;
            foreach (var e in Effectors)
            {
                var ef = e.Get(s);
                var d = Field(data, e.Data);
                list.Add(new Dictionary<string, object>
                {
                    { "key", e.Key }, { "label", e.Label }, { "kind", "effector" }, { "limb", Limbs[e.Part] },
                    { "pos", (double)ef.positionWeight }, { "rot", e.Rot ? (object)(double)ef.rotationWeight : null },
                    { "edited", EvHas(Field(d, "originalPositionWeight")) || EvHas(Field(d, "originalRotationWeight")) },
                });
            }
            foreach (var b in Bends)
            {
                var con = b.Get(s);
                var d = Field(data, b.Data);
                list.Add(new Dictionary<string, object>
                {
                    { "key", b.Key }, { "label", b.Label }, { "kind", "bend" }, { "limb", Limbs[b.Part] },
                    { "bend", (double)con.weight }, { "edited", EvHas(Field(d, "originalWeight")) },
                });
            }
            return list;
        }

        /// <summary>args: {id, key, pos?, rot?, bend?, reset?}</summary>
        private static object SetIk(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            var pc = Ready(c);
            var s = Solver(c) ?? throw new BridgeException("This character has no IK");
            string key = a.GetString("key");
            var e = Effectors.FirstOrDefault(x => x.Key == key);
            var b = Bends.FirstOrDefault(x => x.Key == key);
            if (e == null && b == null) throw new BridgeException("Unknown IK part " + key);
            UndoStack.Push(new SnapUndo("IK strength", a.GetBool("reset") ? null : "ik|" + c.GetHashCode() + "|" + key + "|" + string.Join(",", a.Keys.ToArray()), () => IkRestorer(pc, c, key)));
            ApplyIk(pc, c, key, a.GetBool("reset"), a.Has("pos") ? a.GetFloat("pos") : (float?)null, a.Has("rot") ? a.GetFloat("rot") : (float?)null, a.Has("bend") ? a.GetFloat("bend") : (float?)null);
            return IkList(pc, c);
        }

        private static void ApplyIk(Component pc, OCIChar c, string key, bool reset, float? pos, float? rot, float? bend)
        {
            var s = Solver(c);
            var ed = _fIk.GetValue(pc);
            var e = Effectors.FirstOrDefault(x => x.Key == key);
            var b = Bends.FirstOrDefault(x => x.Key == key);
            if (reset)
            {
                var data = IkData(pc, c, false);
                if (data == null) return;
                if (e != null)
                {
                    var d = Field(data, e.Data);
                    var ef = e.Get(s);
                    var op = Field(d, "originalPositionWeight");
                    if (EvHas(op)) { ef.positionWeight = Convert.ToSingle(EvVal(op)); EvClear(d, "originalPositionWeight"); }
                    var or = Field(d, "originalRotationWeight");
                    if (EvHas(or)) { ef.rotationWeight = Convert.ToSingle(EvVal(or)); EvClear(d, "originalRotationWeight"); }
                }
                else
                {
                    var d = Field(data, b.Data);
                    var ow = Field(d, "originalWeight");
                    if (EvHas(ow)) { b.Get(s).weight = Convert.ToSingle(EvVal(ow)); EvClear(d, "originalWeight"); }
                }
                return;
            }
            var dd = IkData(pc, c, true) ?? throw new BridgeException("KKPE hasn't set up IK for this character yet");
            if (e != null)
            {
                var d = Field(dd, e.Data);
                var ef = e.Get(s);
                if (pos != null) { _mSetPosW.Invoke(ed, new object[] { Mathf.Clamp01(pos.Value), ef, d }); ef.positionWeight = Mathf.Clamp01(pos.Value); }
                if (rot != null && e.Rot) { _mSetRotW.Invoke(ed, new object[] { Mathf.Clamp01(rot.Value), ef, d }); ef.rotationWeight = Mathf.Clamp01(rot.Value); }
            }
            else if (bend != null)
            {
                var con = b.Get(s);
                _mSetBend.Invoke(ed, new object[] { Mathf.Clamp01(bend.Value), con, Field(dd, b.Data) });
                con.weight = Mathf.Clamp01(bend.Value);
            }
        }

        private static Action IkRestorer(Component pc, OCIChar c, string key)
        {
            var row = (Dictionary<string, object>)IkList(pc, c).First(x => (string)((Dictionary<string, object>)x)["key"] == key);
            bool edited = (bool)row["edited"];
            var pos = row.ContainsKey("pos") && row["pos"] != null ? (float?)Convert.ToSingle(row["pos"]) : null;
            var rot = row.ContainsKey("rot") && row["rot"] != null ? (float?)Convert.ToSingle(row["rot"]) : null;
            var bend = row.ContainsKey("bend") ? (float?)Convert.ToSingle(row["bend"]) : null;
            return () =>
            {
                if (pc == null) return;
                ApplyIk(pc, c, key, true, null, null, null);
                if (edited) ApplyIk(pc, c, key, false, pos, rot, bend);
            };
        }

        // ------------------------------------------------------------------ joint correction

        private static Dictionary<string, object> Joints(Component pc)
        {
            if (pc == null || !_cpcType.IsInstanceOfType(pc)) return null;
            Func<PropertyInfo, object> g = p => p != null ? p.GetValue(pc, null) : null;
            return new Dictionary<string, object> { { "crotch", g(_pCrotch) }, { "ankleL", g(_pAnkleL) }, { "ankleR", g(_pAnkleR) }, { "optimizeIK", g(_pOptimize) } };
        }

        private static object SetJoints(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            var pc = Ready(c);
            UndoStack.Push(new SnapUndo("Joint correction", null, () => { var b = Joints(pc); return () => WriteJoints(pc, b); }));
            WriteJoints(pc, a);
            return Joints(pc);
        }

        private static void WriteJoints(Component pc, Dictionary<string, object> a)
        {
            if (pc == null || a == null) return;
            if (a.Has("crotch") && a["crotch"] != null) _pCrotch?.SetValue(pc, a.GetBool("crotch"), null);
            if (a.Has("ankleL") && a["ankleL"] != null) _pAnkleL?.SetValue(pc, a.GetBool("ankleL"), null);
            if (a.Has("ankleR") && a["ankleR"] != null) _pAnkleR?.SetValue(pc, a.GetBool("ankleR"), null);
            if (a.Has("optimizeIK") && a["optimizeIK"] != null) _pOptimize?.SetValue(pc, a.GetBool("optimizeIK"), null);
        }

        // ------------------------------------------------------------------ copy a limb to the other side

        /// <summary>args: {id, what: "arm"|"leg"|"hand", from: "L"|"R"} — KKPE mirrors FK and IK of that limb (fingers for a hand).</summary>
        private static object CopyLimb(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            var pc = Ready(c);
            if (!_cpcType.IsInstanceOfType(pc)) throw new BridgeException("Not a character");
            string what = a.GetString("what"), from = a.GetString("from");
            bool left = from == "L";
            UndoStack.Push(new SnapUndo("Copy " + (left ? "left " : "right ") + what + " to the other side", null, () => PoseRestorer(c)));
            var groupType = typeof(OIBoneInfo.BoneGroup);
            if (what == "hand")
                _mCopyHand.Invoke(pc, new[] { Enum.ToObject(groupType, left ? 64 : 32) });
            else
            {
                int chain = what == "arm" ? (left ? 0 : 1) : (left ? 2 : 3);
                int group = what == "arm" ? (left ? 16 : 8) : (left ? 4 : 2);
                var chainType = _mCopyLimb.GetParameters()[0].ParameterType;
                _mCopyLimb.Invoke(pc, new[] { Enum.ToObject(chainType, chain), Enum.ToObject(groupType, group) });
            }
            return true;
        }

        // ------------------------------------------------------------------ bones (the list; values go through face.*)

        private static object Bones(OCIChar c)
        {
            var pc = Pc(c, true);
            var root = c.charInfo != null ? c.charInfo.transform : pc.transform;
            var child = _fChild?.GetValue(pc) as IEnumerable;
            var skip = new HashSet<GameObject>();
            if (child != null) foreach (var o in child) if (o is GameObject go) skip.Add(go);
            var aliases = _fAliases?.GetValue(null) as IDictionary;
            var dirty = _fBones != null && _fDirtyBones != null ? _fDirtyBones.GetValue(_fBones.GetValue(pc)) as IDictionary : null;
            var fk = new Dictionary<Transform, bool>();
            foreach (var b in c.listBones)
                if (b.guideObject?.transformTarget != null) fk[b.guideObject.transformTarget] = ViewportGizmos.FkOn(c, ViewportGizmos.FkPart(b.boneGroup));
            var list = new List<object>();
            var seen = new HashSet<string>();
            void Walk(Transform t, int depth)
            {
                foreach (Transform ch in t)
                {
                    if (skip.Contains(ch.gameObject) || (ch.GetComponent(_pcType) != null)) continue;
                    if (seen.Add(ch.name))
                    {
                        string alias = aliases != null && aliases.Contains(ch.name) ? aliases[ch.name] as string : null;
                        list.Add(new Dictionary<string, object>
                        {
                            { "name", ch.name }, { "label", alias }, { "depth", depth },
                            { "edited", dirty != null && dirty.Contains(ch.gameObject) },
                            { "fk", fk.TryGetValue(ch, out var on) && on },
                        });
                    }
                    Walk(ch, depth + 1);
                }
            }
            Walk(root, 0);
            return list;
        }

        // ------------------------------------------------------------------ bust (KKPE BoobsEditor)

        private static readonly string[] BustIds = { "BreastL", "BreastR", "HipL", "HipR" };
        private static readonly string[] BustLabels = { "Left breast", "Right breast", "Left buttock", "Right buttock" };

        private static List<object> BustList(Component pc)
        {
            var list = new List<object>();
            var ed = pc != null && _fBust != null && _cpcType.IsInstanceOfType(pc) ? _fBust.GetValue(pc) : null;
            if (ed == null) return list;
            var dirty = _fDirtyBust?.GetValue(ed) as IDictionary;
            for (int i = 0; i < BustIds.Length; i++)
            {
                var db = Traverse.Create(ed).Method("GetDynamicBone", BustIds[i]).GetValue();
                if (db == null) continue;
                var t = Traverse.Create(ed);
                list.Add(new Dictionary<string, object>
                {
                    { "id", BustIds[i] }, { "label", BustLabels[i] },
                    { "enabled", t.Method("GetEnabled", new[] { db.GetType() }, new[] { db }).GetValue() },
                    { "gravity", V((Vector3)t.Method("GetGravity", new[] { db.GetType() }, new[] { db }).GetValue()) },
                    { "force", V((Vector3)t.Method("GetForce", new[] { db.GetType() }, new[] { db }).GetValue()) },
                    { "edited", dirty != null && dirty.Contains(db) },
                });
            }
            return list;
        }

        /// <summary>args: {id, which, enabled?, gravity?:[x,y,z], force?:[x,y,z], reset?}</summary>
        private static object SetBust(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            var pc = Ready(c);
            var ed = _fBust?.GetValue(pc) ?? throw new BridgeException("This character has no bust settings");
            var db = Traverse.Create(ed).Method("GetDynamicBone", a.GetString("which")).GetValue() ?? throw new BridgeException("No " + a.GetString("which"));
            UndoStack.Push(new SnapUndo("Bust physics", a.GetBool("reset") ? null : "bust|" + c.GetHashCode() + "|" + a.GetString("which") + "|" + string.Join(",", a.Keys.ToArray()), () => BustRestorer(ed, db)));
            WriteBust(ed, db, a);
            return BustList(pc);
        }

        private static void WriteBust(object ed, object db, Dictionary<string, object> a)
        {
            var t = Traverse.Create(ed);
            var dt = db.GetType();
            if (a.GetBool("reset")) { t.Method("SetNotDirty", new[] { dt }, new[] { db }).GetValue(); return; }
            if (a.Has("enabled")) t.Method("SetEnabled", new[] { dt, typeof(bool) }, new[] { db, (object)a.GetBool("enabled") }).GetValue();
            if (a.Has("gravity")) t.Method("SetGravity", new[] { dt, typeof(Vector3) }, new[] { db, (object)Vec(a.GetList("gravity")) }).GetValue();
            if (a.Has("force")) t.Method("SetForce", new[] { dt, typeof(Vector3) }, new[] { db, (object)Vec(a.GetList("force")) }).GetValue();
        }

        private static Action BustRestorer(object ed, object db)
        {
            var t = Traverse.Create(ed);
            var dt = db.GetType();
            var dirty = _fDirtyBust?.GetValue(ed) as IDictionary;
            bool was = dirty != null && dirty.Contains(db);
            var en = (bool)t.Method("GetEnabled", new[] { dt }, new[] { db }).GetValue();
            var gr = (Vector3)t.Method("GetGravity", new[] { dt }, new[] { db }).GetValue();
            var fo = (Vector3)t.Method("GetForce", new[] { dt }, new[] { db }).GetValue();
            return () =>
            {
                t.Method("SetNotDirty", new[] { dt }, new[] { db }).GetValue();
                if (!was) return;
                t.Method("SetEnabled", new[] { dt, typeof(bool) }, new[] { db, (object)en }).GetValue();
                t.Method("SetGravity", new[] { dt, typeof(Vector3) }, new[] { db, (object)gr }).GetValue();
                t.Method("SetForce", new[] { dt, typeof(Vector3) }, new[] { db, (object)fo }).GetValue();
            };
        }

        // ------------------------------------------------------------------ hair / skirt / accessory physics (DynamicBonesEditor)

        private static readonly string[] DynFloats = { "weight", "damping", "elasticity", "stiffness", "inertia", "radius" };

        private static IEnumerable<DynamicBone> DynBones(object ed)
        {
            var list = _fDynList?.GetValue(ed) as IEnumerable;
            if (list == null) yield break;
            foreach (var o in list) if (o is DynamicBone db && db != null && db.m_Root != null) yield return db;
        }

        private static List<object> DynList(Component pc)
        {
            var list = new List<object>();
            var ed = pc != null ? _fDyn?.GetValue(pc) : null;
            if (ed == null) return list;
            var dirty = _fDirtyDyn?.GetValue(ed) as IDictionary;
            var aliases = _fAliases?.GetValue(null) as IDictionary;
            foreach (var db in DynBones(ed))
            {
                string path = Traverse.Create(ed).Method("CalculateRoot", new[] { typeof(DynamicBone) }, new object[] { db }).GetValue() as string;
                string name = db.m_Root.name;
                list.Add(new Dictionary<string, object>
                {
                    { "path", path }, { "name", name }, { "label", aliases != null && aliases.Contains(name) ? aliases[name] : null },
                    { "enabled", db.enabled }, { "weight", (double)db.GetWeight() }, { "damping", (double)db.m_Damping },
                    { "elasticity", (double)db.m_Elasticity }, { "stiffness", (double)db.m_Stiffness }, { "inertia", (double)db.m_Inert },
                    { "radius", (double)db.m_Radius }, { "gravity", V(db.m_Gravity) }, { "force", V(db.m_Force) },
                    { "edited", dirty != null && dirty.Contains(db) },
                });
            }
            return list;
        }

        private static DynamicBone FindDyn(object ed, string path) =>
            DynBones(ed).FirstOrDefault(db => (Traverse.Create(ed).Method("CalculateRoot", new[] { typeof(DynamicBone) }, new object[] { db }).GetValue() as string) == path);

        /// <summary>args: {id, path, enabled?, weight?, damping?, elasticity?, stiffness?, inertia?, radius?, gravity?, force?, reset?}</summary>
        private static object SetDyn(Dictionary<string, object> a)
        {
            var c = CharaApi.Chara(a.GetInt("id"));
            var pc = Ready(c);
            var ed = _fDyn?.GetValue(pc) ?? throw new BridgeException("KKPE's physics editor isn't ready for this character");
            string path = a.GetString("path");
            var db = FindDyn(ed, path) ?? throw new BridgeException("That physics bone is gone (the outfit changed?)");
            UndoStack.Push(new SnapUndo("Physics", a.GetBool("reset") ? null : "dyn|" + c.GetHashCode() + "|" + path + "|" + string.Join(",", a.Keys.ToArray()), () => DynRestorer(ed, path)));
            WriteDyn(ed, db, a);
            return DynList(pc);
        }

        private static void WriteDyn(object ed, DynamicBone db, Dictionary<string, object> a)
        {
            var t = Traverse.Create(ed);
            var dt = typeof(DynamicBone);
            if (a.GetBool("reset")) { t.Method("SetDynamicBoneNotDirty", new[] { dt }, new object[] { db }).GetValue(); return; }
            if (a.Has("enabled")) t.Method("SetDynamicBoneEnabled", new[] { dt, typeof(bool) }, new object[] { db, a.GetBool("enabled") }).GetValue();
            if (a.Has("weight")) t.Method("SetDynamicBoneWeight", new[] { dt, typeof(float) }, new object[] { db, Mathf.Clamp01(a.GetFloat("weight")) }).GetValue();
            if (a.Has("gravity")) t.Method("SetDynamicBoneGravity", new[] { dt, typeof(Vector3) }, new object[] { db, Vec(a.GetList("gravity")) }).GetValue();
            if (a.Has("force")) t.Method("SetDynamicBoneForce", new[] { dt, typeof(Vector3) }, new object[] { db, Vec(a.GetList("force")) }).GetValue();
            string[] keys = { "damping", "elasticity", "stiffness", "inertia", "radius" };
            string[] methods = { "SetDynamicBoneDamping", "SetDynamicBoneElasticity", "SetDynamicBoneStiffness", "SetDynamicBoneInertia", "SetDynamicBoneRadius" };
            for (int i = 0; i < keys.Length; i++)
                if (a.Has(keys[i])) t.Method(methods[i], new[] { dt, typeof(float), typeof(bool) }, new object[] { db, Mathf.Clamp01(a.GetFloat(keys[i])), false }).GetValue();
        }

        private static Action DynRestorer(object ed, string path)
        {
            var db = FindDyn(ed, path);
            if (db == null) return () => { };
            var dirty = _fDirtyDyn?.GetValue(ed) as IDictionary;
            bool was = dirty != null && dirty.Contains(db);
            var snap = new Dictionary<string, object>
            {
                { "enabled", db.enabled }, { "weight", db.GetWeight() }, { "damping", db.m_Damping }, { "elasticity", db.m_Elasticity },
                { "stiffness", db.m_Stiffness }, { "inertia", db.m_Inert }, { "radius", db.m_Radius }, { "gravity", V(db.m_Gravity) }, { "force", V(db.m_Force) },
            };
            return () =>
            {
                var now = FindDyn(ed, path);
                if (now == null) return;
                WriteDyn(ed, now, new Dictionary<string, object> { { "reset", true } });
                if (was) WriteDyn(ed, now, snap);
            };
        }

        // ------------------------------------------------------------------ everything for the Posing page

        private static object Get(OCIChar c)
        {
            var pc = Pc(c, false);
            var limbs = new List<object>();
            for (int i = 0; i < 5; i++) limbs.Add(new Dictionary<string, object> { { "limb", Limbs[i] }, { "mode", ModeOf(c, i) } });
            var extras = new List<object>();
            for (int i = 0; i < FKCtrl.parts.Length && i < FkNames.Length; i++)
                if (FkNames[i] != "body") extras.Add(new Dictionary<string, object> { { "part", FkNames[i] }, { "on", ViewportGizmos.FkOn(c, i) } });
            string kkpe = !Resolve() ? "missing" : pc == null ? "notAttached" : !((Behaviour)pc).enabled ? "off" : "ok";
            return new Dictionary<string, object>
            {
                { "limbs", limbs }, { "fkExtras", extras }, { "fk", c.oiCharInfo.enableFK }, { "ik", c.oiCharInfo.enableIK },
                { "kkpe", kkpe },
                { "ikWeights", kkpe == "ok" ? IkList(pc, c) : new List<object>() },
                { "joints", kkpe == "ok" ? Joints(pc) : null },
                { "bust", kkpe == "ok" ? BustList(pc) : new List<object>() },
                { "dyn", kkpe == "ok" ? DynList(pc) : new List<object>() },
            };
        }

        // ------------------------------------------------------------------ undo helpers

        /// <summary>FK / IK modes and every FK bone and IK target as they are now, to put back.</summary>
        internal static Action PoseRestorer(OCIChar c)
        {
            var kin = ViewportGizmos.KinematicsRestorer(c);
            var fk = c.listBones.Where(b => b.guideObject != null).Select(b => new KeyValuePair<ChangeAmount, Vector3>(b.guideObject.changeAmount, b.guideObject.changeAmount.rot)).ToList();
            var ik = c.listIKTarget.Where(t => t.guideObject != null).Select(t => new KeyValuePair<ChangeAmount, KeyValuePair<Vector3, Vector3>>(t.guideObject.changeAmount, new KeyValuePair<Vector3, Vector3>(t.guideObject.changeAmount.pos, t.guideObject.changeAmount.rot))).ToList();
            return () =>
            {
                if (c?.charInfo == null) return;
                kin();
                foreach (var kv in fk) kv.Key.rot = kv.Value;
                foreach (var kv in ik) { kv.Key.pos = kv.Value.Key; kv.Key.rot = kv.Value.Value; }
            };
        }

        private static List<object> V(Vector3 v) => new List<object> { (double)v.x, (double)v.y, (double)v.z };

        private static Vector3 Vec(List<object> l)
        {
            if (l == null || l.Count < 3) return Vector3.zero;
            Func<object, float> f = o => Convert.ToSingle(o, System.Globalization.CultureInfo.InvariantCulture);
            return new Vector3(f(l[0]), f(l[1]), f(l[2]));
        }
    }

    /// <summary>
    /// A generic undo step: <c>capture</c> records the state now and returns how to put it back. Undo runs that and
    /// records the state it replaces for redo. Steps with the same non-null key within a second merge (a slider drag).
    /// </summary>
    internal sealed class SnapUndo : IUndoEntry
    {
        private readonly Func<Action> _capture;
        private readonly Action _restore;
        private readonly string _key;

        public SnapUndo(string label, string key, Func<Action> capture)
        {
            Label = label;
            _key = key;
            _capture = capture;
            _restore = capture();
        }

        public string Label { get; }

        public bool Absorbs(IUndoEntry newer) => _key != null && newer is SnapUndo s && s._key == _key;

        public IUndoEntry Restore()
        {
            var inverse = new SnapUndo(Label, null, _capture);
            _restore();
            return inverse;
        }
    }
}
