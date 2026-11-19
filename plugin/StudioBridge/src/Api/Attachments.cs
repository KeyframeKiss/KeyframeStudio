using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using BepInEx.Bootstrap;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    internal static class Attachments
    {
        internal const string Guid = "com.joan6694.illusionplugins.nodesconstraints";
        private const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        private static Type linkType;
        private static FieldInfo linksField;
        private static MethodInfo add, remove, enable;
        private static object Mod => Chainloader.PluginInfos[Guid].Instance;
        private static IList Links => (IList)linksField.GetValue(Mod);
        private static FieldInfo Field(string name) => linkType.GetField(name, Members);
        private static T Read<T>(object link, string name) => (T)Field(name).GetValue(link);

        internal static string Probe()
        {
            var type = Mod.GetType();
            linkType = type.GetNestedType("Constraint", BindingFlags.NonPublic | BindingFlags.Public);
            linksField = type.GetField("_constraints", Members);
            add = type.GetMethod("AddConstraint", Members, null, new[] { typeof(bool), typeof(Transform), typeof(Transform),
                typeof(bool), typeof(Vector3), typeof(bool), typeof(Quaternion), typeof(bool), typeof(Vector3), typeof(string) }, null);
            remove = type.GetMethod("RemoveConstraintAt", Members, null, new[] { typeof(int) }, null);
            enable = linkType == null ? null : type.GetMethod("SetConstraintEnabled", Members, null, new[] { linkType, typeof(bool) }, null);
            return linksField != null && add != null && remove != null && enable != null &&
                new[] { "parentTransform", "childTransform", "positionOffset", "rotationOffset", "enabled", "alias",
                    "resetOriginalPosition", "resetOriginalRotation" }.All(n => Field(n) != null) ? null : "Unsupported NodesConstraints interface";
        }

        internal static void Register(CommandRouter r)
        {
            r.Add("attachment.get", a => State(Item(a)));
            r.Add("attachment.create", Create);
            r.Add("attachment.edit", Edit);
        }

        private static Transform Item(Dictionary<string, object> a)
        {
            var item = SceneApi.FindOci(a.GetInt("id", -1)) as OCIItem;
            var child = item?.guideObject?.transformTarget;
            if (child == null) throw new BridgeException("Select a scene item first.");
            if (a.Has("instance") && child.GetInstanceID() != a.GetInt("instance"))
                throw new BridgeException("The scene item changed. Open its attachment again.");
            return child;
        }

        private static readonly Dictionary<string, string> Bones = new Dictionary<string, string>
        {
            { "Right hand", "cf_j_hand_R" }, { "Left hand", "cf_j_hand_L" }, { "Head", "cf_j_head" },
            { "Chest", "cf_j_spine03" }, { "Hips", "cf_j_hips" }
        };

        private static float[] Values(Vector3 v) => new[] { v.x, v.y, v.z };
        private static object State(Transform child)
        {
            var rows = new List<object>();
            foreach (var link in Links)
            {
                if (Read<Transform>(link, "childTransform") != child) continue;
                var parent = Read<Transform>(link, "parentTransform");
                var owner = parent;
                ObjectCtrlInfo target = null;
                while (owner != null && target == null)
                {
                    target = SceneApi.Studio.dicObjectCtrl.Values.FirstOrDefault(o => o.guideObject?.transformTarget == owner);
                    if (target == null) owner = owner.parent;
                }
                var bone = parent == null ? "" : Bones.FirstOrDefault(b => b.Value == parent.name).Key ?? parent.name;
                var label = target == null ? bone : SceneApi.DisplayName(target) + (owner == parent ? "" : " / " + bone);
                rows.Add(new Dictionary<string, object> {
                    { "key", RuntimeHelpers.GetHashCode(link) }, { "label", label }, { "enabled", Read<bool>(link, "enabled") },
                    { "managed", Read<string>(link, "alias") == "Keyframe Studio attachment" },
                    { "position", Values(Read<Vector3>(link, "positionOffset")) },
                    { "rotation", Values(Read<Quaternion>(link, "rotationOffset").eulerAngles) }
                });
            }
            return new Dictionary<string, object> { { "instance", child.GetInstanceID() }, { "links", rows } };
        }

        // Follow both Unity hierarchy edges and mod links, including paused links that may resume later.
        private static bool DependsOn(Transform parent, Transform child)
        {
            var pending = new Stack<Transform>();
            var seen = new HashSet<Transform>();
            pending.Push(parent);
            while (pending.Count > 0)
            {
                var node = pending.Pop();
                if (node == null || !seen.Add(node)) continue;
                if (node == child) return true;
                pending.Push(node.parent);
                foreach (var link in Links)
                    if (Read<Transform>(link, "childTransform") == node) pending.Push(Read<Transform>(link, "parentTransform"));
            }
            return false;
        }

        private static object Create(Dictionary<string, object> a)
        {
            var child = Item(a);
            var target = SceneApi.FindOci(a.GetInt("parent", -1));
            var parent = target?.guideObject?.transformTarget;
            var bone = a.GetString("bone", "");
            if (parent == null) throw new BridgeException("Choose a target in this scene.");
            if (bone.Length > 0)
            {
                if (!(target is OCIChar character) || !Bones.TryGetValue(bone, out var name))
                    throw new BridgeException("Choose a character joint.");
                parent = character.charInfo.GetComponentsInChildren<Transform>(true).FirstOrDefault(t => t.name == name && t.IsChildOf(parent));
                if (parent == null) throw new BridgeException("This character does not have that joint.");
            }
            if (Links.Cast<object>().Any(l => Read<Transform>(l, "childTransform") == child))
                throw new BridgeException("This item already has a constraint.");
            if (DependsOn(parent, child)) throw new BridgeException("This attachment would form a loop.");
            var link = add.Invoke(Mod, new object[] { true, parent, child, true, parent.InverseTransformPoint(child.position),
                true, Quaternion.Inverse(parent.rotation) * child.rotation, false, Vector3.one, "Keyframe Studio attachment" });
            if (link == null) throw new BridgeException("NodesConstraints could not create this attachment.");
            Field("resetOriginalPosition").SetValue(link, false);
            Field("resetOriginalRotation").SetValue(link, false);
            return State(child);
        }

        private static object Edit(Dictionary<string, object> a)
        {
            var child = Item(a);
            var links = Links;
            var link = links.Cast<object>().FirstOrDefault(l => Read<Transform>(l, "childTransform") == child &&
                RuntimeHelpers.GetHashCode(l) == a.GetInt("key") && Read<string>(l, "alias") == "Keyframe Studio attachment");
            if (link == null) throw new BridgeException("The attachment changed. Reopen the panel.");
            switch (a.GetString("action"))
            {
                case "detach": remove.Invoke(Mod, new object[] { links.IndexOf(link) }); break;
                case "enabled": enable.Invoke(Mod, new object[] { link, a.GetBool("value") }); break;
                case "position":
                case "rotation":
                    var numbers = a.GetList("value").Select(Convert.ToSingle).ToArray();
                    if (numbers.Length != 3 || numbers.Any(v => float.IsInfinity(v) || float.IsNaN(v)))
                        throw new BridgeException("Enter three finite numbers.");
                    var vector = new Vector3(numbers[0], numbers[1], numbers[2]);
                    if (a.GetString("action") == "position") Field("positionOffset").SetValue(link, vector);
                    else Field("rotationOffset").SetValue(link, Quaternion.Euler(vector));
                    break;
                default: throw new BridgeException("Unknown attachment action.");
            }
            return State(child);
        }
    }
}
