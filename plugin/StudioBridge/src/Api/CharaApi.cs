using System;
using System.Collections.Generic;
using System.Linq;
using Studio;
using StudioEX.Bridge.Net;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>
    /// Character panel: expressions, look, clothing, accessories, hands, body animation, FK/IK.
    /// Mirrors what Studio's own MPCharCtrl does so every mod hook on those methods still fires.
    /// </summary>
    internal static class CharaApi
    {
        private static readonly string[] ClothesSlots = { "Top", "Bottom", "Bra", "Underwear", "Gloves", "Pantyhose", "Socks", "Indoor shoes", "Outdoor shoes" };
        private static readonly string[] Coordinates = { "School uniform", "Going home", "PE", "Swimsuit", "Club", "Casual", "Sleeping" };
        private static readonly string[] FkParts = { "Hair", "Neck", "Chest", "Body", "Right hand", "Left hand", "Skirt" };
        private static readonly string[] IkParts = { "Body", "Right leg", "Left leg", "Right arm", "Left arm" };
        private static readonly string[] EyeLook = { "Forward", "Follow camera", "Look away", "Fixed", "Target" };
        private static readonly int[] NeckLookValues = { 0, 1, 3, 4 };
        private static readonly string[] NeckLook = { "Forward", "Follow camera", "Animation", "Fixed" };

        public static void Register(CommandRouter r)
        {
            Translation.CharaApi_InvalidateCatalog = () => _catalog = null;
            r.Add("chara.get", a => Get(Chara(a.GetInt("id"))));
            r.Add("chara.set", Set);
            r.Add("chara.animations", a => AnimationCatalog());
            r.Add("chara.loadAnime", LoadAnime);
        }

        public static OCIChar Chara(int id)
        {
            if (!(SceneApi.FindOci(id) is OCIChar c) || c.charInfo == null) throw new BridgeException("That object is not a character");
            return c;
        }

        private static IEnumerable<OCIChar> Targets(Dictionary<string, object> a)
        {
            var ids = a.GetList("ids");
            if (ids.Count == 0 && a.Has("id")) ids.Add(a["id"]);
            foreach (var id in ids)
                if (SceneApi.FindOci(Convert.ToInt32(id)) is OCIChar c && c.charInfo != null) yield return c;
        }

        private static string ListName(ChaControl cha, ChaListDefine.CategoryNo cat, int id)
        {
            try { return cha.lstCtrl.GetListInfo(cat, id)?.Name; } catch { return null; }
        }

        private static Dictionary<string, object> Named(string text)
        {
            var d = new Dictionary<string, object> { { "name", text ?? "" } };
            var tr = Translation.Get(text, false, "Character panel");
            if (tr != null) d["nameEn"] = tr;
            return d;
        }

        public static object Get(OCIChar c)
        {
            var cha = c.charInfo;
            var st = cha.fileStatus;
            var info = c.oiCharInfo;

            // Clothes
            var clothes = new List<object>();
            var cparts = cha.nowCoordinate?.clothes?.parts;
            for (int i = 0; i < st.clothesState.Length && i < ClothesSlots.Length; i++)
            {
                int itemId = cparts != null && i < cparts.Length ? cparts[i].id : 0;
                var cat = i >= 7 ? ChaListDefine.CategoryNo.co_shoes : (ChaListDefine.CategoryNo)((int)ChaListDefine.CategoryNo.co_top + i);
                var item = Named(ListName(cha, cat, itemId));
                item["slot"] = i;
                item["label"] = ClothesSlots[i];
                item["state"] = (int)st.clothesState[i];
                item["present"] = itemId != 0 && cha.objClothes != null && i < cha.objClothes.Length && cha.objClothes[i] != null;
                clothes.Add(item);
            }

            // Accessories (MoreAccessories 2.x expands the native arrays)
            var accs = new List<object>();
            var aparts = cha.nowCoordinate?.accessory?.parts;
            if (aparts != null)
                for (int i = 0; i < aparts.Length; i++)
                {
                    var p = aparts[i];
                    if (p == null || p.type == (int)ChaListDefine.CategoryNo.ao_none) continue;
                    var item = Named(ListName(cha, (ChaListDefine.CategoryNo)p.type, p.id));
                    item["slot"] = i;
                    item["parent"] = p.parentKey;
                    item["visible"] = i < st.showAccessory.Length ? st.showAccessory[i] : true;
                    accs.Add(item);
                }

            // Expression
            var eyesNames = new List<object>();
            try
            {
                foreach (var kv in cha.lstCtrl.GetCategoryInfo(ChaListDefine.CategoryNo.cha_eyeset).OrderBy(k => k.Key))
                    eyesNames.Add(Named(kv.Value.Name));
            }
            catch { }

            var hands = new List<object>();
            for (int h = 0; h < 2; h++)
            {
                var names = new List<object>();
                foreach (var kv in Info.Instance.dicHandAnime[h].OrderBy(k => k.Key))
                {
                    var n = Named(kv.Value.name);
                    n["no"] = kv.Key;
                    names.Add(n);
                }
                hands.Add(new Dictionary<string, object> { { "ptn", info.handPtn[h] }, { "options", names } });
            }

            var ai = info.animeInfo;
            string animeName = null;
            try { animeName = Info.Instance.dicAnimeLoadInfo[ai.group][ai.category][ai.no].name; } catch { }
            var anime = Named(animeName);
            anime["group"] = ai.group;
            anime["category"] = ai.category;
            anime["no"] = ai.no;
            anime["speed"] = c.animeSpeed;
            anime["option1"] = c.animeOptionParam1;
            anime["option2"] = c.animeOptionParam2;

            int neckIdx = Array.IndexOf(NeckLookValues, st.neckLookPtn);

            var d = new Dictionary<string, object>
            {
                { "id", info.dicKey },
                { "name", c.treeNodeObject.textName },
                { "sex", c.sex },
                { "coordinate", st.coordinateType },
                { "coordinates", Coordinates.ToList<object>() },
                { "clothes", clothes },
                { "shoesType", (int)st.shoesType },
                { "accessories", accs },
                { "face", new Dictionary<string, object>
                    {
                        { "eyebrowPtn", cha.GetEyebrowPtn() },
                        { "eyebrowCount", cha.eyebrowCtrl.GetMaxPtn() },
                        { "eyesPtn", cha.GetEyesPtn() },
                        { "eyesOptions", eyesNames },
                        { "mouthPtn", cha.GetMouthPtn() },
                        { "mouthCount", cha.mouthCtrl.GetMaxPtn() },
                        { "eyesOpen", st.eyesOpenMax },
                        { "mouthOpen", cha.mouthCtrl.FixedRate },
                        { "blink", st.eyesBlink },
                        { "lipSync", info.lipSync },
                        { "eyesLook", st.eyesLookPtn },
                        { "eyesLookOptions", EyeLook.ToList<object>() },
                        { "neckLook", neckIdx < 0 ? 0 : neckIdx },
                        { "neckLookOptions", NeckLook.ToList<object>() },
                        { "tears", (int)st.tearsLv },
                        { "blush", st.hohoAkaRate },
                        { "nipples", st.nipStandRate },
                    }
                },
                { "hands", hands },
                { "anime", anime },
                { "kinematics", new Dictionary<string, object>
                    {
                        { "fk", info.enableFK },
                        { "ik", info.enableIK },
                        { "fkParts", FkParts.Select((n, i) => (object)new Dictionary<string, object> { { "name", n }, { "on", info.activeFK[i] } }).ToList() },
                        { "ikParts", IkParts.Select((n, i) => (object)new Dictionary<string, object> { { "name", n }, { "on", info.activeIK[i] } }).ToList() },
                    }
                },
                { "abmx", AbmxApi.Available },
            };
            return d;
        }

        /// <summary>args: {ids:[...], ...fields}. Every field is optional; applied to each selected character.</summary>
        private static object Set(Dictionary<string, object> a)
        {
            var targets = Targets(a).ToList();
            if (targets.Count == 0) throw new BridgeException("Select a character first");
            string keys = string.Join(",", a.Keys.Where(k => k != "ids" && k != "id" && k != "noUndo" && k != "undoLabel").OrderBy(k => k).ToArray());
            // noUndo: temporary looks (hold-to-peek) that are put back right away shouldn't fill the history
            if (keys.Length > 0 && keys != "restartAnime" && !a.GetBool("noUndo"))
                UndoStack.Push(CharaUndo.Capture(targets, keys, a.GetString("undoLabel") ?? "Character change"));
            foreach (var c in targets) Apply(c, a);
            return targets.Count == 1 ? Get(targets[0]) : (object)targets.Select(c => (object)c.oiCharInfo.dicKey).ToList();
        }

        // ---------------- undo ----------------

        /// <summary>Full restorable state of a character (everything the panel can change).</summary>
        private static Dictionary<string, object> Snapshot(OCIChar c)
        {
            var cha = c.charInfo;
            var st = cha.fileStatus;
            var info = c.oiCharInfo;
            return new Dictionary<string, object>
            {
                { "coordinate", (double)st.coordinateType },
                { "shoesType", (double)st.shoesType },
                { "clothesStates", st.clothesState.Select(b => (object)(double)b).ToList() },
                { "accessoriesVisible", st.showAccessory.Select(b => (object)b).ToList() },
                { "eyebrowPtn", (double)cha.GetEyebrowPtn() },
                { "eyesPtn", (double)cha.GetEyesPtn() },
                { "mouthPtn", (double)cha.GetMouthPtn() },
                { "eyesOpen", (double)st.eyesOpenMax },
                { "mouthOpen", (double)cha.mouthCtrl.FixedRate },
                { "blink", st.eyesBlink },
                { "lipSync", info.lipSync },
                { "eyesLook", (double)st.eyesLookPtn },
                { "neckLook", (double)Math.Max(0, Array.IndexOf(NeckLookValues, st.neckLookPtn)) },
                { "tears", (double)st.tearsLv },
                { "blush", (double)st.hohoAkaRate },
                { "nipples", (double)st.nipStandRate },
                { "handLeft", (double)info.handPtn[0] },
                { "handRight", (double)info.handPtn[1] },
                { "anime", new List<object> { (double)info.animeInfo.group, (double)info.animeInfo.category, (double)info.animeInfo.no } },
                { "animeSpeed", (double)c.animeSpeed },
                { "option1", (double)c.animeOptionParam1 },
                { "option2", (double)c.animeOptionParam2 },
                { "fk", info.enableFK },
                { "ik", info.enableIK },
                { "fkParts", info.activeFK.Select(b => (object)b).ToList() },
                { "ikParts", info.activeIK.Select(b => (object)b).ToList() },
            };
        }

        private sealed class CharaUndo : IUndoEntry
        {
            private readonly Dictionary<OCIChar, Dictionary<string, object>> _states;
            private readonly string _keys;
            public string Label { get; }

            private CharaUndo(Dictionary<OCIChar, Dictionary<string, object>> states, string keys, string label)
            {
                _states = states;
                _keys = keys;
                Label = label;
            }

            public static CharaUndo Capture(IEnumerable<OCIChar> chars, string keys, string label) =>
                new CharaUndo(chars.ToDictionary(c => c, Snapshot), keys, label);

            // Same characters + same fields within the merge window = one slider drag = one undo step.
            public bool Absorbs(IUndoEntry newer) =>
                newer is CharaUndo n && n._keys == _keys && n._states.Count == _states.Count && n._states.Keys.All(_states.ContainsKey);

            public IUndoEntry Restore()
            {
                var alive = _states.Keys.Where(c => c.charInfo != null && Singleton<Studio.Studio>.Instance.dicObjectCtrl.ContainsValue(c)).ToList();
                var inverse = Capture(alive, _keys, Label);
                // only what this edit changed: a mouth pattern picked in Studio's own window since then stays
                foreach (var c in alive) Apply(c, Only(_states[c], _keys));
                return inverse;
            }
        }

        /// <summary>Request fields → the snapshot fields they change (the rest are named the same).</summary>
        private static readonly Dictionary<string, string[]> SnapshotFields = new Dictionary<string, string[]>
        {
            { "clothes", new[] { "clothesStates" } }, { "clothesAll", new[] { "clothesStates" } },
            { "accessory", new[] { "accessoriesVisible" } }, { "accessoriesAll", new[] { "accessoriesVisible" } },
            { "fkPart", new[] { "fkParts" } }, { "ikPart", new[] { "ikParts" } },
            { "coordinate", new[] { "coordinate", "clothesStates", "accessoriesVisible" } },
            { "anime", new[] { "anime", "animeSpeed", "option1", "option2" } },
        };

        /// <summary>The part of a snapshot that the given edit keys touched (all of it for an unknown key).</summary>
        private static Dictionary<string, object> Only(Dictionary<string, object> snap, string keys)
        {
            var want = new HashSet<string>();
            foreach (var k in keys.Split(','))
            {
                if (k.Length == 0) continue;
                if (SnapshotFields.TryGetValue(k, out var fields)) foreach (var f in fields) want.Add(f);
                else if (snap.ContainsKey(k)) want.Add(k);
                else return snap; // something we don't map: restoring everything is the safe choice
            }
            return snap.Where(kv => want.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
        }

        private static void Apply(OCIChar c, Dictionary<string, object> a)
        {
            {
                var cha = c.charInfo;
                // Restore-only fields (from Snapshot): applied first so later single-field edits win.
                var anime = a.GetList("anime");
                if (anime.Count == 3)
                {
                    var ai = c.oiCharInfo.animeInfo;
                    int g = Convert.ToInt32(anime[0]), ca = Convert.ToInt32(anime[1]), no = Convert.ToInt32(anime[2]);
                    if (ai.group != g || ai.category != ca || ai.no != no) c.LoadAnime(g, ca, no);
                }
                var states = a.GetList("clothesStates");
                var accVis = a.GetList("accessoriesVisible");
                var fkParts = a.GetList("fkParts");
                var ikParts = a.GetList("ikParts");
                if (a.Has("coordinate") && cha.fileStatus.coordinateType != a.GetInt("coordinate"))
                    c.SetCoordinateInfo((ChaFileDefine.CoordinateType)a.GetInt("coordinate"));
                if (a.Has("clothesAll")) c.SetClothesStateAll(a.GetInt("clothesAll"));
                var cl = a.GetObject("clothes");
                if (cl != null) c.SetClothesState(cl.GetInt("slot"), (byte)cl.GetInt("state"));
                if (a.Has("shoesType") && cha.fileStatus.shoesType != a.GetInt("shoesType")) c.SetShoesType(a.GetInt("shoesType"));
                var acc = a.GetObject("accessory");
                if (acc != null) c.ShowAccessory(acc.GetInt("slot"), acc.GetBool("visible", true));
                if (a.Has("accessoriesAll"))
                {
                    bool v = a.GetBool("accessoriesAll", true);
                    for (int i = 0; i < cha.fileStatus.showAccessory.Length; i++) c.ShowAccessory(i, v);
                }

                if (a.Has("eyebrowPtn")) cha.ChangeEyebrowPtn(a.GetInt("eyebrowPtn"));
                if (a.Has("eyesPtn")) cha.ChangeEyesPtn(a.GetInt("eyesPtn"));
                if (a.Has("mouthPtn")) cha.ChangeMouthPtn(a.GetInt("mouthPtn"));
                if (a.Has("eyesOpen")) c.ChangeEyesOpen(Mathf.Clamp01(a.GetFloat("eyesOpen")));
                if (a.Has("mouthOpen")) c.ChangeMouthOpen(Mathf.Clamp01(a.GetFloat("mouthOpen")));
                if (a.Has("blink")) c.ChangeBlink(a.GetBool("blink"));
                if (a.Has("lipSync")) c.ChangeLipSync(a.GetBool("lipSync"));
                if (a.Has("eyesLook")) c.ChangeLookEyesPtn(Mathf.Clamp(a.GetInt("eyesLook"), 0, EyeLook.Length - 1));
                if (a.Has("neckLook")) c.ChangeLookNeckPtn(NeckLookValues[Mathf.Clamp(a.GetInt("neckLook"), 0, NeckLookValues.Length - 1)]);
                if (a.Has("tears")) c.SetTearsLv((byte)Mathf.Clamp(a.GetInt("tears"), 0, 3));
                if (a.Has("blush")) c.SetHohoAkaRate(Mathf.Clamp01(a.GetFloat("blush")));
                if (a.Has("nipples")) c.SetNipStand(Mathf.Clamp01(a.GetFloat("nipples")));
                if (a.Has("handLeft")) c.ChangeHandAnime(0, a.GetInt("handLeft"));
                if (a.Has("handRight")) c.ChangeHandAnime(1, a.GetInt("handRight"));

                if (a.Has("animeSpeed")) c.animeSpeed = Mathf.Clamp(a.GetFloat("animeSpeed"), 0f, 3f);
                if (a.Has("option1")) c.animeOptionParam1 = a.GetFloat("option1");
                if (a.Has("option2")) c.animeOptionParam2 = a.GetFloat("option2");
                if (a.Has("restartAnime")) c.RestartAnime();

                if (a.Has("fk")) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, a.GetBool("fk"), false);
                if (a.Has("ik")) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, a.GetBool("ik"), false);
                var fkp = a.GetObject("fkPart");
                if (fkp != null) c.ActiveFK(FKCtrl.parts[Mathf.Clamp(fkp.GetInt("index"), 0, 6)], fkp.GetBool("on"));
                var ikp = a.GetObject("ikPart");
                if (ikp != null) c.ActiveIK((OIBoneInfo.BoneGroup)(1 << Mathf.Clamp(ikp.GetInt("index"), 0, 4)), ikp.GetBool("on"));

                for (int i = 0; i < states.Count && i < cha.fileStatus.clothesState.Length; i++)
                    if (cha.fileStatus.clothesState[i] != Convert.ToByte(states[i])) c.SetClothesState(i, Convert.ToByte(states[i]));
                for (int i = 0; i < accVis.Count && i < cha.fileStatus.showAccessory.Length; i++)
                    if (cha.fileStatus.showAccessory[i] != (bool)accVis[i]) c.ShowAccessory(i, (bool)accVis[i]);
                for (int i = 0; i < fkParts.Count && i < 7; i++)
                    if (c.oiCharInfo.activeFK[i] != (bool)fkParts[i]) c.ActiveFK(FKCtrl.parts[i], (bool)fkParts[i]);
                for (int i = 0; i < ikParts.Count && i < 5; i++)
                    if (c.oiCharInfo.activeIK[i] != (bool)ikParts[i]) c.ActiveIK((OIBoneInfo.BoneGroup)(1 << i), (bool)ikParts[i]);
            }
        }

        private static List<object> _catalog;

        /// <summary>Whole body-animation catalog (group → category → clip), cached; includes mod animations.</summary>
        private static object AnimationCatalog()
        {
            if (_catalog != null) return _catalog;
            var info = Info.Instance;
            var groups = new List<object>();
            foreach (var g in info.dicAnimeLoadInfo.OrderBy(k => k.Key))
            {
                info.dicAGroupCategory.TryGetValue(g.Key, out var gi);
                var cats = new List<object>();
                foreach (var c in g.Value.OrderBy(k => k.Key))
                {
                    string catName = null;
                    gi?.dicCategory.TryGetValue(c.Key, out catName);
                    var clips = new List<object>();
                    foreach (var clip in c.Value.OrderBy(k => k.Key))
                    {
                        var n = Named(clip.Value.name);
                        n["no"] = clip.Key;
                        clips.Add(n);
                    }
                    var cat = Named(catName ?? ("Category " + c.Key));
                    cat["id"] = c.Key;
                    cat["clips"] = clips;
                    cats.Add(cat);
                }
                var grp = Named(gi?.name ?? ("Group " + g.Key));
                grp["id"] = g.Key;
                grp["categories"] = cats;
                groups.Add(grp);
            }
            if (groups.Count > 0) _catalog = groups; // Studio still loading its lists: don't remember "nothing"
            return groups;
        }

        /// <summary>
        /// args: {ids, group, category, no, letPlay? (default true)}. Picking a clip should show it: FK or IK hold the
        /// body still (they override the animation), so with letPlay they're switched off for those characters, and a
        /// stopped animation (speed 0) gets speed 1 — all in the same undo step as the clip.
        /// → {applied, freed: [names whose FK / IK went off], started: [names whose speed was 0]}
        /// </summary>
        private static object LoadAnime(Dictionary<string, object> a)
        {
            int g = a.GetInt("group"), cat = a.GetInt("category"), no = a.GetInt("no");
            var targets = Targets(a).ToList();
            if (targets.Count == 0) throw new BridgeException("Select a character first");
            bool letPlay = a.GetBool("letPlay", true);
            var held = letPlay ? targets.Where(c => c.oiCharInfo.enableFK || c.oiCharInfo.enableIK).ToList() : new List<OCIChar>();
            var stopped = letPlay ? targets.Where(c => c.animeSpeed <= 0.001f).ToList() : new List<OCIChar>();
            UndoStack.Push(CharaUndo.Capture(targets, held.Count > 0 ? "anime,fk,ik,fkParts,ikParts" : "anime", "Change animation"));
            foreach (var c in targets) c.LoadAnime(g, cat, no);
            foreach (var c in held)
            {
                if (c.oiCharInfo.enableFK) c.ActiveKinematicMode(OICharInfo.KinematicMode.FK, false, false);
                if (c.oiCharInfo.enableIK) c.ActiveKinematicMode(OICharInfo.KinematicMode.IK, false, false);
            }
            foreach (var c in stopped) c.animeSpeed = 1f;
            return new Dictionary<string, object>
            {
                { "applied", targets.Count },
                { "freed", held.Select(c => (object)SceneApi.DisplayName(c)).ToList() },
                { "started", stopped.Select(c => (object)SceneApi.DisplayName(c)).ToList() },
            };
        }
    }
}
