# Studio EX — Next Development Roadmap

## Vision

Make Studio EX a complete, modern, and flexible creative workspace for Koikatsu CharaStudio.

The goal is not to replace working systems. It is to make existing tools easier to use, add direct visual manipulation, and reduce the steps required to create characters, scenes, and animations.

## How this roadmap is ordered

1. **Stabilize first.** A release people can install, update, and report problems from.
2. **Quick wins next.** Features that don't need new rendering technology ship early.
3. **Cheapest path to direct manipulation.** Overlays and gizmos are drawn in Studio's own viewport, which already runs next to Studio EX with no lag and no extra rendering cost.
4. **Test risky technology before depending on it.** A streamed preview inside Studio EX is built as a small spike with measurable go/no-go criteria, not as a foundation.
5. **Scope decisions are made explicitly** (see *Open Decisions*), not implied by a feature list.

---

## Phase 0 — Finish and Polish the Current Build

**Priority: Critical | Scope: Small–Medium**

### 0.1 Fix Known Issues
- Restore deleted animation tracks to their original folders when undoing.
- Add consistent zoom controls to the graph editor (+, −, Shift+F as in the dope sheet).
- Improve feedback when key edits are deferred to protect unkeyed poses.
- Reduce per-frame allocations in the dope sheet on large scenes.
- Make clickable cards and rows reachable by keyboard.

**Status (2026-11-17): done.** Undo puts deleted tracks back in their folder and position, re-creating a folder that was removed with its last track. The graph editor has the same − / + / Frame / Whole-length buttons and keys as the dope sheet, and the toolbar buttons now act on whichever view is showing. Key edits held back to protect unkeyed changes now show a notice with "Key changes" and "Reset pose to keys". The fix also closed a hole where the next edit silently overwrote those changes. The dope sheet only scans keys in the visible time range and caches object/folder summary rows. Rows and cards are focusable with Tab and open with Enter/Space, with a visible focus ring. Tab switches Dope sheet ↔ Graph only while the pointer is over the timeline. Verified live: 17/17 API checks.

### 0.2 Complete Distribution
- Create a one-click Windows installer (plugin and app together).
- Detect Koikatsu, BepInEx, and supported plugin versions.
- Install or update the Studio EX bridge.
- Add version information and update handling.
- Provide a clean uninstall that removes the bridge and app but keeps user data (looks, translations, settings).
- Plan for Windows SmartScreen: code signing, or clear first-run instructions.
- Publish a source repository with version history.

### 0.3 Test Infrastructure
- Move the API test scripts into the repository.
- Make every suite independent: each test sets up and cleans up its own tracks, so suites pass in any order on a fresh Studio session.
- One command runs all suites and prints a pass/fail summary.

### 0.4 Diagnostics
- Write a Studio EX log (bridge and app) with a "Copy diagnostics" button for bug reports.
- Record plugin and mod versions in the log.

### 0.5 Compatibility Matrix
- List the Timeline, MaterialEditor, KKABMX, KKPE, XUnity AutoTranslator, and KK_TwoLut versions Studio EX hooks into, and which features depend on each.
- On an unknown version, disable only the affected feature and say why, instead of failing.

**Status (2026-11-17): 0.3–0.5 done.**
- **Tests:** `npm test` runs 11 live suites (170 checks, about 2 minutes) with a pass/fail summary. Each suite starts from an empty scene and cleans up its files.
- **Diagnostics:** an app log file, a bridge log buffer and Library › About & diagnostics with "Copy diagnostics". The report hides the Windows user name.
- **Compatibility:** per-feature probes of the exact mod members used, versions tested, and features switched off on their own with the reason (see README).

### 0.6 Test Existing Workflows
- Validate large scenes with many objects and tracks (200+ objects, 100+ tracks, 5,000+ keys).
- Test undo/redo with external plugin changes.
- Verify saving and loading scenes with existing mods.
- Profile communication and UI performance.

**Deliverable:** A stable baseline release that is easy to install, test, and support.

---

## Phase 1 — Quick Wins (No New Viewport Needed)

**Priority: Very High | Scope: Small–Medium**

### 1.1 Pose Thumbnails
- Batch-render a thumbnail for every saved pose by applying it to a stand-in character and capturing with the existing camera snapshot command (about 1,000 poses in a few minutes).
- Cache thumbnails and regenerate only for new or changed poses.
- Preview a pose on hover before applying it.

### 1.2 Expression Designer
- Visual expression presets with thumbnails.
- Eye direction, blinking, eyebrow, and mouth controls in one panel.
- Expression blending where Koikatsu supports it.
- Save and reuse custom expressions.
- Preview changes without permanently applying them.

### 1.3 Library Organization
- Favorites and recently used items for poses, animations, scenes, and looks.
- Tags and custom collections.
- Improved filtering and search.
- Side-by-side pose comparison.

**Deliverable:** Faster browsing and expression work using systems that already exist.

---

## Phase 2 — In-Studio Overlays and Direct Manipulation

**Priority: Critical | Scope: Large**

Direct manipulation is drawn in CharaStudio's own viewport, extending the system that already draws motion paths and ghosts. This gives zero-latency interaction without rendering the scene twice.

### 2.1 Overlays
- Skeleton and bone overlays for selected characters.
- Highlight selected objects, bones, and accessories.
- Light direction and influence display.
- Camera frustum, focus point, and composition guides.

### 2.2 Gizmos and Handles
- Improved position, rotation, and scale gizmos.
- Clickable control points and handles.
- Snapping and precision adjustment (modifier keys, numeric entry in Studio EX).

### 2.3 Selection
- Click to select bones and objects in Studio's viewport, synchronized with Studio EX.
- Selection filters (bones only, lights only, accessories only).

### 2.4 Shared Editing Framework
- One coordinate and selection model used by every overlay tool.
- All edits go through existing Studio EX commands and the shared undo history.
- Overlay visibility and editing modes controlled from Studio EX.

**Deliverable:** Click-and-drag editing in the viewport users already work in, ready for later tools to build on.

---

## Phase 3 — Streamed Preview Spike (Go/No-Go)

**Priority: Medium | Scope: Small (spike)**

A live preview rendered by Koikatsu and shown inside Studio EX is attractive but risky:

- A second camera re-renders the whole scene, including post-processing.
- Unity 5.6 cannot easily share a GPU texture with Electron, so frames likely travel as compressed images (estimated 10–20 fps, 50–100 ms latency).

### 3.1 Spike
- Build a minimal stream on top of the existing camera snapshot command.
- Measure preview fps, latency, and the game's frame-time cost on a large scene.
- Test resolution and frame-rate settings, and an isolated character view.

### 3.2 Go/No-Go Criteria
- **Go** for interactive use if: preview ≥ 30 fps at 720p, latency ≤ 50 ms, and the game loses ≤ 10% frame rate.
- **Go** for non-interactive use if: ≥ 10 fps and the game loses ≤ 15% frame rate. Use the stream for face close-ups, before/after comparisons, and previews before applying.
- **No-go:** keep all direct manipulation in Studio's viewport (Phase 2) and use snapshots for still previews.

**Deliverable:** A measured decision on whether Studio EX gets its own live viewport.

### 3.3 Results (2026-11-17)

**Status: done. Decision: go for non-interactive use only.**

The spike is built: `PreviewStream` in the bridge (`preview.start / stop / stats / orbit`), an experimental preview panel in the app (Ctrl+K → "Live preview"), and a benchmark script. Frames are rendered from Studio's camera, read back to the CPU, and sent either as JPEG or as raw pixels from a background thread. Dragging in the preview moves Studio's camera, so input→frame times are a real round trip. Test machine: RTX 5060 Ti, Studio at 1600×900.

Heavy scene (537 objects, 171 tracks; Studio 47 fps with no preview):

| Setting | Shown fps | Input→frame ms (p95) | Studio main-thread ms/frame | Studio fps (drop) |
| --- | --- | --- | --- | --- |
| 720p@10 raw | 9.0 | 114 (161) | 7.4 | 43.9 (7%) |
| 480p@15 raw | 14.0 | 87 (122) | 6.6 | 42.3 (11%) |
| 720p@15 raw | 13.3 | 102 (217) | 7.4 | 39.2 (17%) |
| 720p@30 raw | 19.2 | 95 (310) | 7.4 | 37.5 (21%) |
| 720p@30 JPEG | 24.8 | 68 (91) | 16.6 | 25.0 (48%) |
| 1080p@30 raw | 18.7 | 95 (200) | 9.2 | 32.8 (31%) |

Light scene (bundled sample, Studio 144 fps): 720p@60 raw reached 49 fps shown, 42 ms input→frame (p95 241), and a 4% drop.

What the numbers say:
- **Interactive viewport: no-go.** On a real scene, every setting misses the 50 ms / 10% bar (input→frame 68–136 ms, drops of 21–57%). It only passes on near-empty scenes.
- **Non-interactive preview: go**, at 720p@10 or 480p@15 with raw frames (≤ 11% drop).
- **JPEG is the wrong format.** Encoding costs ~7.5 ms at 720p and ~16 ms at 1080p on Studio's main thread. Raw pixels sent from a background thread cost ~0.2 ms, at 2.7 MB per 720p frame (fine on the local connection).
- **The GPU→CPU readback (~5 ms at 720p) is the remaining main-thread cost.** Delaying it by one game frame saved only ~1 ms. Unity 5.6 has no asynchronous readback.
- **Direct manipulation stays in Studio's viewport** (Phase 2), as planned.

### 3.4 Follow-ups for the Non-Interactive Preview
- **Only render when something changed** (camera, selection, pose, edits) instead of a fixed rate: a still scene would cost nothing.
- **Smaller targeted views:** a 512×512 face close-up of one character, rendering only that character's layer, for Face Studio and expression previews.
- **Its own camera** for the preview (a separate angle from Studio's view), copying Studio's image effects.
- **Stream automatically pauses** while Studio is playing animation, or when frame time rises above a set budget.

---

## Phase 4 — Interactive Body, Appearance, Camera, and Lighting

**Priority: High | Scope: Large**

Built on the Phase 2 overlays in Studio's viewport; the Phase 3 preview is used only for side-by-side and before/after views.

### 4.1 Visual Body Posing
- Drag IK targets and select bones directly in the viewport.
- Foot and hand locking.
- Pose symmetry and mirroring.
- ABMX controls on the selected bone.
- Optional bone influence visualization.

### 4.2 Clothing and Accessory Editor
- Select accessories in the viewport and edit them with gizmos.
- Material and color controls for the selected item.
- Outfit and accessory presets.
- Visibility and clipping-assistance tools.

### 4.3 Visual Camera Director
Extends the existing ten camera slots and camera keying.

- Direct camera manipulation, camera paths, and target handles.
- Focus point selection, composition guides, and safe areas.
- Camera movement presets and visual transition editing.

### 4.4 Interactive Lighting
Extends the existing Look workspace.

- Select and reposition lights visually.
- Reusable three-point lighting rigs and interactive presets.
- Before/after lighting comparisons.
- Experimental click-to-light positioning.

**Deliverable:** Direct character, camera, and lighting editing with fewer menus.

---

## Phase 5 — Face Studio

**Priority: High | Scope: Large**

Face Studio fine-tunes the face of a character already in the scene: eyes, brows, mouth, nose, cheeks, jaw and their shapes. It is not a character creator. It builds on **KKPE** (KK Pose Editor), which already stores per-character bone and blendshape adjustments in the scene, so edits made in Face Studio save, load and stay editable in KKPE as usual.

### 5.1 KKPE Bridge
- Read and write KKPE's per-character bone adjustments (position, rotation, scale offsets) and blendshape values from Studio EX.
- KKPE has no public API for this: access its internal edit data by reflection, add KKPE to the compatibility matrix (0.5), and disable Face Studio cleanly on an unsupported version.
- Route every change through the shared undo history.

### 5.2 Visual Face Editor
- Face close-up in front, side, and three-quarter views using the non-interactive preview (a small face-only view, see 3.4); handles are dragged in Studio's viewport.
- Click a feature (eye, brow, nose, mouth, cheek, chin, ear) to show its controls; face bones highlighted with the Phase 2 overlays.
- Drag handles mapped to KKPE bone offsets, with left/right mirroring.
- Blendshape sliders grouped by feature, with search.
- Numeric entry for precise values; before/after comparison; reset per feature or for the whole face.

### 5.3 Face Presets
- Save a set of face adjustments as a preset and apply it to other characters.
- Partial apply (eyes only, mouth only) and strength blending, like look presets.

**Deliverable:** Precise visual face editing for characters already in a scene, fully compatible with KKPE.

### 5.4 Status (2026-11-17): first version built
- **Done:** KKPE bridge (`face.get / set / reset`, mirrored left/right, undo/redo), on-demand close-up (`face.view`: front, ¾ and side angles, zoom, body and other characters hidden, optional plain background, objects between camera and face clipped), and the Face Studio tab in the Pose workspace with 9 features and 40 face parts. Verified live: 9/9 API checks, edits visible in the close-up, Ctrl+Z restores both sides.
- **Saved faces (5.3) done:** save the current face with a thumbnail (UserData/StudioEX/faces), switch with one click, "Original" to go back, apply to several selected characters, choose parts and strength, replace or blend; one undo step per apply. Verified live: 9/9 checks. Library tools for large collections: search (names, tags, source character), sort (recently used / newest / name), favorites pinned first, user tags with tag filters, rename, a "Browse all" gallery with multi-select delete, and a collapsible strip. Verified live with 30 test faces (6/6 checks, tag filter, gallery, collapse).
- **Expressions, Shapes, Before/after, click-to-edit done (2026-11-17):** Expression tab (eyebrows, eyes, mouth, blush, tears, look direction) with saved expressions (same library tools as saved faces); Shapes tab for KKPE blendshapes of the head meshes with readable names; hold "Before" to see the face without adjustments; click a part in the close-up to open its controls. Pose thumbnails for the whole library (Phase 1.1) also done.
- **Next:** saved faces could also store blendshape edits; highlight the selected part in Studio's viewport (Phase 2).

---

## Phase 6 — Advanced Animation Workflows

**Priority: High | Scope: Medium–Large**

Builds on the existing Timeline integration.

### 6.1 Animation Layers and Blending
- Investigate independent body, face, and secondary-motion layers.
- Clip-based blending where supported.
- Reusable animation segments.
- Better transition and loop editing.

### 6.2 Facial Animation and Lip-Sync
Lip-sync needs audio that plays in sync with Timeline inside Studio. Treat that as its own sub-project, and first check which installed mods already handle audio playback.

- Audio import with waveform display, synced to Timeline playback.
- Suggested lip-sync keys from the audio.
- Mouth shapes, expressions, gaze, and blink tracks over time.
- Reusable facial performance clips.

### 6.3 Motion Cleanup Tools
Reuses the bone sampling already used for motion paths.

- Detect foot sliding and abrupt movement changes.
- Curve smoothing and retiming tools.
- Preview suggested fixes; undo each one individually.

**Deliverable:** Faster animation authoring with less manual keyframe work.

---

## Phase 7 — Production, Library, and Workflow

**Priority: Medium | Scope: Medium**

### 7.1 Shot Sequencer
- Arrange shots on a project-level timeline.
- Assign cameras and animation ranges; store shot-specific settings.
- Shot markers, notes, and reusable shot templates.

### 7.2 Unified Visual Asset Library
Extends the Library workspace and the Phase 1 organization features.

- Thumbnails for characters, animations, items, and scenes.
- Saved production templates.

### 7.3 Workspace Layouts
Saved layouts give most of the benefit of dockable panels at a fraction of the cost.

- Saved and switchable layouts per workspace.
- Multi-monitor presets.
- Compact and advanced UI modes.
- Fully dockable or detachable panels only if saved layouts prove insufficient.

### 7.4 Workflow Automation
- Batch editing commands and repeatable macros.
- User-defined quick actions (via the command palette).
- Optional scripting support.
- Project-specific presets.

### 7.5 Render and Export
First check what installed screenshot and recording mods already do; drive them from Studio EX rather than rebuilding them.

- Resolution and frame-rate presets.
- Camera and shot export profiles.
- Frame-sequence export, render queue, and progress tracking.
- Optional video encoding.

**Deliverable:** A customizable production environment for multi-shot scenes and videos.

---

## Core Design Requirements

All new features should follow these rules:

1. **Preserve compatibility.** Use existing CharaStudio and plugin APIs where practical.
2. **Keep the interface simple.** Show relevant tools based on the current selection and task.
3. **Use direct interaction.** Prefer clicking and dragging visual elements over searching through menus.
4. **Reuse existing systems.** Extend Studio EX's current commands, state synchronization, and undo history.
5. **Make changes reversible.** Support preview, apply, cancel, and undo where technically possible.
6. **Maintain performance.** Keep preview rendering and editing responsive.
7. **Keep advanced controls available.** Simplification must not remove useful functionality.
8. **Support future plugins.** Design adapters so additional Koikatsu plugins can be integrated without rewriting the interface.
9. **Fail soft.** When a plugin is missing or its version changes, disable only the affected feature and tell the user why.
10. **Every feature ships with tests.** New commands get a test in the shared suite before release.

## Decisions Made

| Decision | Outcome |
| --- | --- |
| Face Studio scope | Fine adjustment of existing characters' faces, built on KKPE's bone and blendshape edits. Not a character creator. |
| Live preview (Phase 3) | Go for non-interactive previews only (720p@10 or 480p@15, raw frames). Interactive editing stays in Studio's viewport. See 3.3. |

## Open Decisions

| Decision | Options | Needed before |
| --- | --- | --- |
| Audio playback for lip-sync | Use an installed mod, or build a Studio EX audio track | Phase 6.2 |

## Recommended Development Order

1. Phase 0: known issues, installer, test infrastructure, diagnostics, compatibility matrix.
2. Phase 1: pose thumbnails, expression designer, favorites and tags.
3. Phase 2: in-Studio overlays, gizmos, and selection.
4. Phase 3: streamed preview spike and go/no-go decision.
5. Phase 4: body posing, accessories, camera, and lighting tools.
6. Phase 5: Face Studio on top of KKPE.
7. Phase 6: animation layers, lip-sync, and motion cleanup.
8. Phase 7: sequencing, layouts, automation, and export.

## Success Criteria

Studio EX should make common creative tasks faster, easier to discover, and easier to correct. Measured targets:

| Area | Target |
| --- | --- |
| Animation speed | A new user keys a three-pose animation in under 2 minutes |
| Discoverability | Every action is reachable from the command palette (Ctrl+K) |
| Direct manipulation | Viewport drag latency under 50 ms |
| Performance | No visible frame-rate drop in a 200-object scene with motion paths and ghosts on |
| Reliability | Full test suite passes on a fresh Studio session before every release |
| Installation | Install or update in under 2 minutes with no manual file copying |
| Correctability | Every edit made in Studio EX can be undone |

Users should be able to select and edit characters, construct animations, configure lighting, and manage scenes without repeatedly switching through nested Koikatsu plugin windows. Advanced users keep precise control, and new users have a clear path to their first scene or animation.
