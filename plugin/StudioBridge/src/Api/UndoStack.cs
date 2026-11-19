using System;
using System.Collections.Generic;
using UnityEngine;

namespace StudioEX.Bridge.Api
{
    /// <summary>One undoable change. Restore() puts the old state back and returns the inverse (for redo).</summary>
    internal interface IUndoEntry
    {
        string Label { get; }
        IUndoEntry Restore();
        /// <summary>
        /// True when <paramref name="newer"/> continues this edit (e.g. the same slider being dragged),
        /// so the newer snapshot is dropped and one undo reverts the whole gesture.
        /// </summary>
        bool Absorbs(IUndoEntry newer);
    }

    /// <summary>Single undo history shared by timeline, character, ABMX and object edits.</summary>
    internal static class UndoStack
    {
        private const int Max = 300;
        private const float MergeWindow = 1.0f;
        private static readonly List<IUndoEntry> Undos = new List<IUndoEntry>();
        private static readonly List<IUndoEntry> Redos = new List<IUndoEntry>();
        private static float _lastPush = -10f;

        public static void Register(CommandRouter r)
        {
            r.Add("undo", a => Undo());
            r.Add("redo", a => Redo());
            r.Add("timeline.undo", a => Undo());
            r.Add("timeline.redo", a => Redo());
        }

        private static List<IUndoEntry> _group;

        /// <summary>Collect everything pushed until <see cref="EndGroup"/> into one undo step (e.g. applying a look).</summary>
        public static void BeginGroup() => _group = new List<IUndoEntry>();

        public static void EndGroup(string label)
        {
            var g = _group;
            _group = null;
            if (g == null || g.Count == 0) return;
            _lastPush = -10f; // a group never merges into the step before it
            Push(g.Count == 1 ? g[0] : new GroupUndo(g, label));
        }

        private sealed class GroupUndo : IUndoEntry
        {
            private readonly List<IUndoEntry> _parts; // in the order they happened
            public GroupUndo(List<IUndoEntry> parts, string label) { _parts = parts; Label = label; }
            public string Label { get; }
            public bool Absorbs(IUndoEntry newer) => false;
            public IUndoEntry Restore()
            {
                // undo last-first; the inverses happen in that order, so they redo in it too
                var inverse = new List<IUndoEntry>();
                for (int i = _parts.Count - 1; i >= 0; i--)
                {
                    var inv = _parts[i].Restore();
                    if (inv != null) inverse.Add(inv);
                }
                return new GroupUndo(inverse, Label);
            }
        }

        public static void Push(IUndoEntry e)
        {
            if (e == null) return;
            if (_group != null) { _group.Add(e); return; }
            float now = Time.unscaledTime;
            if (Undos.Count > 0 && now - _lastPush < MergeWindow && Undos[Undos.Count - 1].Absorbs(e))
            {
                _lastPush = now;
                Redos.Clear();
                return;
            }
            Undos.Add(e);
            if (Undos.Count > Max) Undos.RemoveAt(0);
            Redos.Clear();
            _lastPush = now;
        }

        public static void Clear()
        {
            Undos.Clear();
            Redos.Clear();
        }

        public static object Undo() => Swap(Undos, Redos);
        public static object Redo() => Swap(Redos, Undos);

        private static object Swap(List<IUndoEntry> from, List<IUndoEntry> to)
        {
            if (from.Count == 0) return false;
            var e = from[from.Count - 1];
            from.RemoveAt(from.Count - 1);
            _lastPush = -10f; // never merge across an undo
            IUndoEntry inverse;
            try { inverse = e.Restore(); }
            catch (Exception ex)
            {
                StudioBridgePlugin.Logger.LogWarning("Undo failed for " + e.Label + ": " + ex.Message);
                throw new BridgeException("Couldn't undo “" + e.Label + "” (the object may have been deleted)");
            }
            if (inverse != null) to.Add(inverse);
            // The restored state is "what the user wants now": make it the change-detection baseline,
            // otherwise auto-key would key the undone pose (and wipe the redo history doing so).
            // ...unless there are unkeyed changes elsewhere: a rebase would quietly adopt them (and the next
            // timeline edit would then re-apply the keys over them). They stay pending; the undone value shows as one too.
            if (TimelineApi.Pending() == 0) EventPump.RequestRebase();
            return e.Label;
        }
    }
}
