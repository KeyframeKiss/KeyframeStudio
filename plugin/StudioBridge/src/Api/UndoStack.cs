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

        public static void Push(IUndoEntry e)
        {
            if (e == null) return;
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
            EventPump.RequestRebase();
            return e.Label;
        }
    }
}
