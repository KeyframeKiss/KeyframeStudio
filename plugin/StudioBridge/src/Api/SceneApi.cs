using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Studio;
using StudioEX.Bridge.Net;

namespace StudioEX.Bridge.Api
{
    /// <summary>Scene outliner: tree, selection, visibility.</summary>
    internal static class SceneApi
    {
        private static readonly FieldInfo NodeListField = AccessTools.Field(typeof(TreeNodeCtrl), "m_TreeNodeObject");
        private static readonly MethodInfo AddSelectNode = AccessTools.Method(typeof(TreeNodeCtrl), "AddSelectNode");
        private static readonly MethodInfo DeselectNode = AccessTools.Method(typeof(TreeNodeCtrl), "DeselectNode");

        public static Studio.Studio Studio
        {
            get
            {
                var s = Singleton<Studio.Studio>.Instance;
                if (s == null) throw new BridgeException("Studio is not ready yet");
                return s;
            }
        }

        internal static string CurrentFile;
        internal static int SaveCount;

        public static void Register(CommandRouter r)
        {
            r.Add("scene.get", a => GetScene());
            r.Add("scene.select", Select);
            r.Add("scene.setVisible", SetVisible);
            r.Add("scene.list", a => ListScenes());
            r.Add("scene.load", LoadScene);
            r.Add("scene.import", ImportScene);
            // Same as Studio's Save button (new timestamped file + notification); mods' save hooks run.
            r.Add("scene.save", a => {
                var before = SaveCount;
                Studio.systemButtonCtrl.OnClickSave();
                if (before == SaveCount) throw new BridgeException("Studio did not confirm the scene save");
                return a.GetBool("returnName") ? (object)CurrentFile : true;
            });
            r.Add("scene.new", a => { Studio.InitScene(); return true; });
            r.Add("scene.rename", Rename);
        }

        /// <summary>
        /// Same per-type naming KK_TreeNodeNaming uses: folders/routes/cameras have real name fields (saved by
        /// Studio); other objects only have the tree text, which TreeNodeNaming persists into the scene.
        /// </summary>
        public static void SetName(ObjectCtrlInfo oci, string name)
        {
            switch (oci)
            {
                case OCIFolder f: f.name = name; break;
                case OCIRoute r: r.name = name; break;
                case OCICamera c: c.name = name; break;
                default: oci.treeNodeObject.textName = name; break;
            }
        }

        public static bool NamesPersist(ObjectCtrlInfo oci) =>
            oci is OCIFolder || oci is OCIRoute || oci is OCICamera || BepInEx.Bootstrap.Chainloader.PluginInfos.ContainsKey("org.njaecha.plugins.treenodenaming");

        private static object Rename(Dictionary<string, object> a)
        {
            var ids = a.GetList("ids");
            if (ids.Count == 0 && a.Has("id")) ids.Add(a["id"]);
            string name = (a.GetString("name") ?? "").Trim();
            if (name.Length == 0) throw new BridgeException("Name can't be empty");
            var targets = ids.Select(i => FindOci(Convert.ToInt32(i))).Where(o => o != null).ToList();
            if (targets.Count == 0) throw new BridgeException("Select an object first");
            UndoStack.Push(new RenameUndo(targets.ToDictionary(o => o, o => o.treeNodeObject.textName)));
            // Several objects: "Name 1", "Name 2", … like Studio's duplicate naming.
            for (int i = 0; i < targets.Count; i++) SetName(targets[i], targets.Count == 1 ? name : name + " " + (i + 1));
            return new Dictionary<string, object> { { "persists", targets.All(NamesPersist) } };
        }

        private sealed class RenameUndo : IUndoEntry
        {
            private readonly Dictionary<ObjectCtrlInfo, string> _names;
            public RenameUndo(Dictionary<ObjectCtrlInfo, string> names) { _names = names; }
            public string Label => "Rename";
            public bool Absorbs(IUndoEntry newer) => false;

            public IUndoEntry Restore()
            {
                var alive = _names.Keys.Where(o => Studio.dicObjectCtrl.ContainsValue(o)).ToList();
                var inverse = new RenameUndo(alive.ToDictionary(o => o, o => o.treeNodeObject.textName));
                foreach (var o in alive) SetName(o, _names[o]);
                return inverse;
            }
        }

        private static object ImportScene(Dictionary<string, object> a)
        {
            string path = a.GetString("path");
            if (string.IsNullOrEmpty(path) || !System.IO.File.Exists(path)) throw new BridgeException("Scene file not found");
            return Studio.ImportScene(path);
        }

        private static string SceneFolder =>
            System.IO.Path.GetFullPath(System.IO.Path.Combine(UserData.Path, "studio/scene"));

        private static object ListScenes()
        {
            var root = SceneFolder;
            var list = new List<object>();
            if (!System.IO.Directory.Exists(root)) return list;
            foreach (var f in System.IO.Directory.GetFiles(root, "*.png", System.IO.SearchOption.AllDirectories))
            {
                var info = new System.IO.FileInfo(f);
                list.Add(new Dictionary<string, object>
                {
                    { "path", f },
                    { "rel", f.Substring(root.Length).TrimStart('\\', '/') },
                    { "size", info.Length },
                    { "modified", (info.LastWriteTimeUtc - new DateTime(1970, 1, 1)).TotalMilliseconds },
                });
            }
            return list;
        }

        private static object LoadScene(Dictionary<string, object> a)
        {
            string path = a.GetString("path");
            if (string.IsNullOrEmpty(path) || !System.IO.File.Exists(path) ||
                !path.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                throw new BridgeException("Scene file not found");
            // Same path Studio's own Load button takes, so every mod's load hooks run.
            StudioBridgePlugin.Instance.StartCoroutine(Studio.LoadSceneCoroutine(path));
            return true;
        }

        /// <summary>
        /// Stable id for a tree node: the object's dicKey (>= 0) when it has an OCI,
        /// otherwise a negative id derived from the Unity instance id.
        /// </summary>
        public static int NodeId(TreeNodeObject node, ObjectCtrlInfo oci)
        {
            if (oci?.objectInfo != null) return oci.objectInfo.dicKey;
            return -(Math.Abs(node.GetInstanceID()) + 1);
        }

        public static ObjectCtrlInfo FindOci(int id)
        {
            if (id < 0) return null;
            Studio.dicObjectCtrl.TryGetValue(id, out var oci);
            return oci;
        }

        public static TreeNodeObject FindNode(int id)
        {
            var studio = Studio;
            if (id >= 0)
            {
                if (studio.dicObjectCtrl.TryGetValue(id, out var oci)) return oci.treeNodeObject;
                return null;
            }
            foreach (var node in AllNodes())
                if (NodeId(node, null) == id) return node;
            return null;
        }

        private static List<TreeNodeObject> AllNodes() =>
            (List<TreeNodeObject>)NodeListField.GetValue(Studio.treeNodeCtrl);

        public static string TypeName(ObjectCtrlInfo oci)
        {
            if (oci == null) return "node";
            if (oci is OCIChar) return "Char"; // OCICharFemale / OCICharMale — sex is sent separately
            string n = oci.GetType().Name;
            return n.StartsWith("OCI") ? n.Substring(3) : n; // Item, Light, Folder, Route, RoutePoint, Camera
        }

        public static string DisplayName(ObjectCtrlInfo oci)
        {
            if (oci?.treeNodeObject != null) return oci.treeNodeObject.textName;
            return oci?.GetType().Name ?? "(none)";
        }

        private static object GetScene()
        {
            var studio = Studio;
            var nodes = new List<object>();
            var roots = new List<object>();
            foreach (var node in AllNodes())
            {
                if (node == null || node.parent != null) continue;
                roots.Add(Visit(studio, node, nodes));
            }
            return new Dictionary<string, object>
            {
                { "fileName", CurrentFile },
                { "roots", roots },
                { "nodes", nodes },
                { "selected", SelectedIds() },
            };
        }

        private static int Visit(Studio.Studio studio, TreeNodeObject node, List<object> outList)
        {
            studio.dicInfo.TryGetValue(node, out var oci);
            int id = NodeId(node, oci);
            var children = new List<object>();
            var entry = new Dictionary<string, object>
            {
                { "id", id },
                { "name", node.textName },
                { "type", TypeName(oci) },
                { "visible", node.visible },
                { "open", node.treeState == TreeNodeObject.TreeState.Open },
                { "children", children },
            };
            string tr = Translation.Get(node.textName, true, "Scene object");
            if (tr != null) entry["nameEn"] = tr;
            if (oci is OCIChar ch && ch.charInfo != null) entry["sex"] = ch.sex;
            outList.Add(entry);
            foreach (var child in node.child)
                if (child != null) children.Add(Visit(studio, child, outList));
            return id;
        }

        public static List<object> SelectedIds()
        {
            var studio = Studio;
            var ids = new List<object>();
            foreach (var node in studio.treeNodeCtrl.selectNodes)
            {
                if (node == null) continue;
                studio.dicInfo.TryGetValue(node, out var oci);
                ids.Add(NodeId(node, oci));
            }
            return ids;
        }

        private static object Select(Dictionary<string, object> a)
        {
            var ctrl = Studio.treeNodeCtrl;
            var ids = a.GetList("ids");
            bool additive = a.GetBool("additive");
            if (ids.Count == 0)
            {
                foreach (var n in ctrl.selectNodes) DeselectNode.Invoke(ctrl, new object[] { n });
                return SelectedIds();
            }
            bool first = true;
            foreach (var raw in ids)
            {
                var node = FindNode(Convert.ToInt32(raw));
                if (node == null) continue;
                // Studio runs every plugin's selection hooks inside these calls; one that throws (a plugin that
                // failed to start, say) mustn't fail the selection, which has happened by then
                try
                {
                    if (first && !additive) ctrl.SelectSingle(node, false);
                    else AddSelectNode.Invoke(ctrl, new object[] { node, true });
                }
                catch (Exception e)
                {
                    var inner = e is System.Reflection.TargetInvocationException t && t.InnerException != null ? t.InnerException : e;
                    StudioBridgePlugin.Logger.LogWarning("Selecting: another plugin's selection handler failed — " + inner.GetType().Name + ": " + inner.Message + Environment.NewLine + inner.StackTrace);
                }
                first = false;
            }
            return SelectedIds();
        }

        private static object SetVisible(Dictionary<string, object> a)
        {
            var node = FindNode(a.GetInt("id"));
            if (node == null) throw new BridgeException("No such object");
            node.SetVisible(a.GetBool("visible", true));
            return node.visible;
        }
    }
}
