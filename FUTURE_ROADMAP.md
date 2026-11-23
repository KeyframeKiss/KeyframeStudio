# Keyframe Studio — Next Development Roadmap

## Vision

Make Keyframe Studio a complete, modern, and flexible creative workspace for Koikatsu CharaStudio.

The goal is not to replace working systems. It is to make existing tools easier to use, add direct visual manipulation, and reduce the steps required to create characters, scenes, and animations.

## How this roadmap is ordered

1. **Stabilize first.** A release people can install, update, and report problems from.
2. **Quick wins next.** Features that don't need new rendering technology ship early.
3. **Cheapest path to direct manipulation.** Overlays and gizmos are drawn in Studio's own viewport, which already runs next to Keyframe Studio with no lag and no extra rendering cost.
4. **Test risky technology before depending on it.** A streamed preview inside Keyframe Studio is built as a small spike with measurable go/no-go criteria, not as a foundation.
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
- Install or update the Keyframe Studio bridge.
- Add version information and update handling.
- Provide a clean uninstall that removes the bridge and app but keeps user data (looks, translations, settings).
- Plan for Windows SmartScreen: code signing, or clear first-run instructions.
- Publish a source repository with version history.

**Status (2026-11-20): one-click setup done, without an installer.** The release stays a portable zip (the user's choice). The app carries the bridge plugin inside it. Settings › About › Studio bridge finds the Koikatsu folder (the usual install places, or "Choose…"), checks BepInEx, compares the installed plugin with the app's copy, and installs or updates it in one click. This works while CharaStudio runs: the old DLL is renamed aside and the new one loads on Studio's next start. The "Waiting for CharaStudio" screen offers "Set up the bridge". Still open: code signing / SmartScreen, an uninstall button.

**Update (2026-11-20): update checks done.** The source is public on GitHub (MIT) with beta releases. At start (at most every 6 hours, can be turned off) the app asks GitHub for the newest release from the main process, so the window's Content-Security-Policy still allows only the local bridge, and nothing about the user is sent. A newer version shows a notice in the top bar (red when the release mentions security fixes) and, in About › Updates, the release notes as plain text, the update steps, "Open the download page" and "Skip this version". A second notice appears when the connected bridge's version doesn't match the app. Settings › Help & guide (F1) covers getting started, a first animation, good habits, posing in the viewport, common problems, bug reports and where files are kept.

**Note (2026-11-18):** the effect shaders are compiled with Unity 5.6.2f1 (`npm run build:shaders`) and embedded in the bridge DLL, so the installer ships one DLL and users never need Unity.

### 0.3 Test Infrastructure
- Move the API test scripts into the repository.
- Make every suite independent: each test sets up and cleans up its own tracks, so suites pass in any order on a fresh Studio session.
- One command runs all suites and prints a pass/fail summary.

### 0.4 Diagnostics
- Write a Keyframe Studio log (bridge and app) with a "Copy diagnostics" button for bug reports.
- Record plugin and mod versions in the log.

### 0.5 Compatibility Matrix
- List the Timeline, MaterialEditor, KKABMX, KKPE, XUnity AutoTranslator, and KK_TwoLut versions Keyframe Studio hooks into, and which features depend on each.
- On an unknown version, disable only the affected feature and say why, instead of failing.

**Status (2026-11-17): 0.3–0.5 done.**
- **Tests:** `npm test` runs 11 live suites (170 checks, about 2 minutes) with a pass/fail summary. Each suite starts from an empty scene and cleans up its files.
- **Diagnostics:** an app log file, a bridge log buffer and Library › About & diagnostics with "Copy diagnostics". The report hides the Windows user name.
- **Compatibility:** per-feature probes of the exact mod members used, versions tested, and features switched off on their own with the reason (see README).

### 0.6 Test Existing Workflows

**Status (2026-11-18): done.** Undo next to outside changes: character and look undo restored their whole snapshot, so a change made in Studio's own windows (or by another plugin) between an edit and its undo was reverted too. They now restore only the fields the edit changed, like object undo already did. Save + load keeps tracks, aliases, folders, shots and KKPE face edits (suite 23). Large scenes (earlier): `node tests/run.mjs stress` builds 212 objects, 120 tracks and 5,400 keys. Results:
- The plugin uses 0.3 ms of each Studio frame.
- Change detection takes about 3 ms every 0.4 s. It used to parse XML twice per track per scan; it now compares the raw text once.
- Moving or undoing all 5,280 keys takes under 70 ms.
- The dope sheet draws in 1 ms.
- The graph editor with every key selected went from 29 to 16 ms per draw.
- Saving takes under 1 s.
- Studio's own frame rate (about 30 fps with that many objects) is CharaStudio's rendering, not the bridge.

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

**Status (2026-11-17): Phase 1 done.**
- Favorites, recently used and tags for scenes, animation clips and looks (poses and faces already had them). They are stored in UserData/StudioEX/library-meta.json, so the game's files are never touched.
- **Pose library:** resting the pointer on a pose previews it on the selected character, and moving away puts the character back. Clicking keeps the pose. Loading, copying and mirroring a pose are undoable. Ctrl+click two poses to compare them side by side.
- Saved faces also keep shape (blendshape) edits. "Shapes" is a part you can choose when applying.
- Not done: custom collections beyond tags.

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
- Snapping and precision adjustment (modifier keys, numeric entry in Keyframe Studio).

### 2.3 Selection
- Click to select bones and objects in Studio's viewport, synchronized with Keyframe Studio.
- Selection filters (bones only, lights only, accessories only).

### 2.4 Shared Editing Framework
- One coordinate and selection model used by every overlay tool.
- All edits go through existing Keyframe Studio commands and the shared undo history.
- Overlay visibility and editing modes controlled from Keyframe Studio.

**Deliverable:** Click-and-drag editing in the viewport users already work in, ready for later tools to build on.

**Status (done, `ViewportGizmos.cs` + `ViewportOverlays.tsx`, test suite 35):**
- **Overlays:** skeleton with clickable joints (blue where FK poses them), IK targets as diamonds (solid when IK drives the limb), corner brackets on the selection, lights (bulb, direction, spot cone, point reach), scene cameras (view frame with an up mark), names on hover. Drawn over the finished screen, so depth of field and bloom never blur them and renders, stills and videos never include them.
- **Handles:** rings on a bone (its own axes plus a view ring), arrows / cubes / free-move centre for objects and IK targets, following Studio's Move / Rotate / Scale mode; Local or World axes; constant size on screen; a live value tag while dragging. Turning a bone switches its part to FK keeping the pose, and an IK-driven limb hands over to FK; dragging an IK target turns IK on for its limb. Ctrl snaps (steps set in the app), Shift is fine control. Studio's camera holds still during a drag, and Studio's own handles are hidden while ours are on.
- **Selection:** click to select joints, IK targets, lights, cameras and items (smallest under the pointer), with filters; click empty space to let go of a bone.
- **Shared:** each drag or typed value is one step in the shared undo history; auto-key and "unkeyed changes" see the edits like any Studio edit; numeric entry for the handles' target in the app.
- **Second pass:** IK targets on a joint (wrists, ankles) are rings around it — middle = joint, ring = target — and clicking the same spot again steps to the next thing there (the name tag says what). Only the touched part changes FK / IK (the other mode stays on beside it, KKPE-style), every part starts from the pose on screen, and undo restores the FK / IK state too — no more body jumps. Arrows track the pointer exactly (ray–axis), arrows pointing at the camera fade and can't be grabbed, rings turn along their tangent (no flips near the middle), and Studio's camera holds still while the pointer is on a handle. Typed values apply only the numbers changed.
- **Accessories:** teal squares on the selected character's accessories; click to move / turn / scale their own adjustment (saved to the outfit worn and the saved outfit), with undo and typed values.
- **Focus point:** a reticle where depth of field focuses; drag it onto a joint or item to focus at that distance, or onto a face to keep following the eyes.
- **Composition guides:** golden-ratio lines, diagonals with their reciprocals and a golden spiral (four corners) join thirds, centre, safe areas and the frame.
- **Third pass (2026-11-20):**
  - **FK and IK together:** an IK limb follows its target while FK poses the rest. Studio files every limb bone under FK "Body" and applies FK after IK, so FK now stands down bone by bone on the limbs IK drives, and IK solves again right after FK. Scenes saved this way reload the same: Studio's loader drops IK when FK is on, and KK_FKIK turns body FK off on load, so the saved FK parts are put back afterwards.
  - **Idle IK targets** are drawn and picked on their own joint (Studio leaves them wherever they were last used); grabbing one starts it there.
  - **Overlapping markers fan out:** rest the pointer where several things overlap (a wrist joint and its IK target, knuckles, an accessory) and they spread into labelled chips to hover, click or press-drag. Quick repeated clicks still step through them.
  - **Mode switching on the handles:** click the handles' middle to step Move → Rotate → Scale (only what the target can do), or rest on it for three mode chips. Studio's toolbar and the app follow.
  - **In the app:** the transport bar's "View" group holds Paths, Ghosts, Overlays and Handles as icon toggles with one shared options menu.

---

## Phase 3 — Streamed Preview Spike (Go/No-Go)

**Priority: Medium | Scope: Small (spike)**

A live preview rendered by Koikatsu and shown inside Keyframe Studio is attractive but risky:

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

**Deliverable:** A measured decision on whether Keyframe Studio gets its own live viewport.

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

**Status (2026-11-20): mostly done.**
- **Viewport posing** (Phase 2): click a joint and turn it on its rings, drag IK targets, FK and IK together per limb, numeric entry in the app.
- **Mirroring:** pose mirror (`M`) and copy pose between characters (Pose library).
- **ABMX:** bone sliders in Pose › Character.
- **Foot and hand locking (2026-11-20):** Animate › Cleanup › Lock a foot or hand. The bridge steps through the range frame by frame, works out where the limb's IK target must sit under its moving parent to stay on one world spot, and keys it with the fewest linear keys that stay within 0.2% of the limb's length. It eases back into the limb's own motion afterwards (0–0.5 s), and reports when the body moves further than the limb reaches. A limb posed with FK is converted first: its FK motion over the whole timeline is baked into all of its IK targets, so nothing else changes. Keys, new tracks and the FK/IK switch are one undo step. Each slide found by Check foot sliding has a Lock button. Test suite 36: zero drift while locked, motion unchanged outside the range, no snap on release, undo/redo, reach warning.
- **Not done:** ABMX controls tied to the bone picked in the viewport, bone influence display.

### 4.2 Clothing and Accessory Editor
- Select accessories in the viewport and edit them with gizmos.
- Material and color controls for the selected item.
- Outfit and accessory presets.
- Visibility and clipping-assistance tools.

**Status (2026-11-17): outfits done** (Pose › Outfit).
- **Saved outfits:** the outfit set, clothing states, shoes and accessory visibility, with favorites. Applying one is a single undo step and can dress several characters. Accessory on/off carries over only to the character it was saved from.
- **Accessories:** grouped by body area, each area with an on/off switch, plus search and **Solo** (see one accessory alone, then restore).
- **Clipping checks:** hold to hide all accessories or all clothes. These peeks stay out of undo.
- **Accessories in the viewport (2026-11-20):** teal markers on the selected character's accessories; click one to move, turn or scale its own adjustment with the handles or typed values. Saved to the outfit worn and the saved outfit, with undo.
- **Material Editor (2026-11-18):** Look › Materials edits any material of the selected character or item through KK_MaterialEditor. It covers values, colours, textures (replace, export, tiling), shader, render queue and renderer switches, plus copy and paste. Any value can be a Timeline track. Koikatsu's internal part names are shown in plain English (`cf_O_mayuge` → Eyebrows).

### 4.3 Visual Camera Director
Extends the existing ten camera slots and camera keying.

- Direct camera manipulation, camera paths, and target handles.
- Focus point selection, composition guides, and safe areas.
- Camera movement presets and visual transition editing.

**Status (2026-11-17): camera moves done** (Animate › Camera › Camera moves).
- **Moves:** orbit, dolly, zoom, pan, crane and truck. Each has a direction and an amount, a length, and smooth or linear easing.
- **Keying:** keys are written from the camera as framed at the playhead. Orbits and pans get a key every 45°, because Timeline turns the camera along the shortest path. Moves chain (the next starts where the last ended). Camera keys inside the range are replaced. One undo step per move.
- **In the viewport (2026-11-20, Phase 2):** scene cameras are drawn as view frames, click to select, and move or turn with the handles. Composition guides: thirds, golden ratio, diagonals, golden spiral, centre, safe areas and aspect frames. The depth of field's focus point is a reticle you drag onto what should be sharp. Motion paths include the camera target.
- **Not done:** editing a camera move's path directly in the viewport.

### 4.4 Interactive Lighting
Extends the existing Look workspace.

- Select and reposition lights visually.
- Reusable three-point lighting rigs and interactive presets.
- Before/after lighting comparisons.
- Experimental click-to-light positioning.

**Status (2026-11-17): rigs done** (Look › Lighting).
- **Built-in rigs:** three-point, Rembrandt, butterfly, split, rim only and soft front.
- **Placement:** relative to the selected character's position, facing and height. Each rig is a "Lighting rig: …" folder.
- **Comparing:** switch a rig on or off, or hold to compare without rigs.
- **Removing:** one undo step for apply, or Remove to delete.
- **Your own rigs:** save your own light arrangement, relative to the character, as a reusable rig.
- **Light limit:** vanilla Studio's 2-light limit is respected unless IllusionFixes' Unlimited Map Lights is installed.
- **Caveat:** Koikatsu's toon shading reacts to extra lights mostly as colour and rim tints. The main character light shapes the shadows, so rigs read as subtle.
- **In the viewport (2026-11-20, Phase 2):** lights are drawn (bulb, direction, spot cone, point reach), click to select, and move or aim with the handles.
- **Not done:** click-to-light (placing a light by clicking the spot it should light).

**Deliverable:** Direct character, camera, and lighting editing with fewer menus.

---

## Phase 5 — Face Studio

**Priority: High | Scope: Large**

Face Studio fine-tunes the face of a character already in the scene: eyes, brows, mouth, nose, cheeks, jaw and their shapes. It is not a character creator. It builds on **KKPE** (KK Pose Editor), which already stores per-character bone and blendshape adjustments in the scene, so edits made in Face Studio save, load and stay editable in KKPE as usual.

### 5.1 KKPE Bridge
- Read and write KKPE's per-character bone adjustments (position, rotation, scale offsets) and blendshape values from Keyframe Studio.
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
- **Next:** saved faces could also store blendshape edits; highlight the selected face part in Studio's viewport with the Phase 2 overlays.

---

## Phase 6 — Advanced Animation Workflows

**Priority: High | Scope: Medium–Large**

Builds on the existing Timeline integration.

### 6.1 Animation Layers and Blending
- Investigate independent body, face, and secondary-motion layers.
- Clip-based blending where supported.
- Reusable animation segments.
- Better transition and loop editing.

**Status (2026-11-18): done as motion clips** (Animate › Motion clips). Timeline keeps one key list per track, so there are no true layers; clips with blending cover the same needs.
- **Save:** the selected keys (or tracks) of one character or object become a clip with a thumbnail, in UserData/StudioEX/clips. Tracks are written with Timeline's own interpolable writer, so bones, face parts and any mod's track type keep their parameter.
- **Apply:** at the playhead, on the same or another character (parameters are re-resolved on the target, like Timeline's single-file load). Replace, or add on top (the clip's movement as an offset: a nod over an idle). Strength, blend in/out, speed, repeats. Missing tracks are created. One undo step.
- **Tests:** suite 20 (save, retarget, replace/add/strength/blend, speed and loops, end-of-timeline trim, undo).

### 6.2 Facial Animation and Lip-Sync
Lip-sync needs audio that plays in sync with Timeline inside Studio. Treat that as its own sub-project, and first check which installed mods already handle audio playback.

- Audio import with waveform display, synced to Timeline playback.
- Suggested lip-sync keys from the audio.
- Mouth shapes, expressions, gaze, and blink tracks over time.
- Reusable facial performance clips.

**Status (2026-11-20): done** (Shoot › Audio; lip-sync and blinks in Animate › Face). Reusable facial clips are motion clips (6.1).
- **Audio track:** a WAV plays in sync with Timeline (play, pause, seek, loop, drift corrected), with a start offset, volume and mute. It's saved with the scene through KKAPI scene data. The installed audio mods (KKVMDPlay with Timeline VMD Sync) handle only VMD audio, and Studio's outside sound can't seek, so the plugin plays the clip itself through Studio's WAV loader.
- **Waveform:** shown in the dope sheet's time ruler.
- **Lip-sync:** Mouth Open keys from the loudness, with sensitivity, noise threshold, smoothing, widest opening and keys per second. It replaces earlier lip-sync where the audio plays. Not phoneme-accurate.
- **Face:** "Key face at playhead" (eyes, eyelids, brows, mouth, neck) and natural blinks over the whole timeline.
- **Tests:** the math is unit-tested; suite 17 covers the plugin side.
- **Vowels (2026-11-18):** the plugin computes an LPC spectral envelope of the voice per window (resampled to ~11 kHz); the app finds the first two formants, picks the nearest of A/I/U/E/O (shifted to the speaker's range), smooths the sequence, and keys the character's matching Mouth pattern (found by shape name, e.g. `f00_a_l_op`) along with Mouth Open. Unit tests use synthetic envelopes; suite 21 synthesizes a sung "a i u e o" WAV and checks the recognition end to end.
- **Several clips (2026-11-19):** any number of audio clips, each with volume, left/right balance, speed, fade in/out and trims, drawn as lanes in the dope sheet (drag to move, double-click to listen). A headphone delay setting plays audio early to make up for Bluetooth lag.
- **Lip-sync choices (2026-11-19):** pick which clip (and which part of it) drives which character, all speakers at once, style presets and a vowel map.
- **In renders:** the clips are mixed into the rendered video (trims, speed, balance and fades included); audio stays silent while frames are captured.

### 6.3 Motion Cleanup Tools
Reuses the bone sampling already used for motion paths.

- Detect foot sliding and abrupt movement changes.
- Curve smoothing and retiming tools.
- Preview suggested fixes; undo each one individually.

**Status (2026-11-17): done** (Animate › Cleanup). The tools work on the selected keys, or all keys of the selected tracks. Each fix is one undo step.
- **Smooth:** strength and passes.
- **Retime:** 50–200% or a custom amount, around the first key or the playhead, snapped to frames.
- **Make loop:** each track ends on its starting value.
- **Find sudden moves:** finds the stray key behind each spike. **Fix** puts it back on the line between its neighbours, which stay untouched.
- **Check foot sliding:** samples the feet over the timeline and lists the ranges where a planted foot slides. There's no automatic fix; you key the foot in place.
- The math is unit-tested (`npm run test:unit`). The plugin side is in suite 13.

### 6.4 Timeline Editing (2026-11-20)
- **Bones in Add track:** a character's bones and IK targets, grouped by body part, each with Rotation (and Position for IK targets). Adding one switches its part to FK (its limb to IK) from the pose on screen. The joint picked in the viewport is offered first.
- **Snap you can feel:** dragging keys, scrubbing and moving audio land on a nearby key, the playhead, a ruler tick or a clip edge (within 8 px), with a line and a tag saying what; otherwise on whole frames. Keys can be snapped to on the same track only (default), on all tracks, or not at all. Alt places freely.
- **Key values you can edit:** rotations as degrees around X / Y / Z, positions and scales per axis, any other number on its own. Drag sideways or click to type; Studio follows live and one drag is one undo.
- **My easings:** save the curve you've shaped, apply it to any key, rename or delete it (UserData/StudioEX/easings).

**Deliverable:** Faster animation authoring with less manual keyframe work.

---

## Phase 7 — Production, Library, and Workflow

**Priority: Medium | Scope: Medium**

### 7.1 Shot Sequencer
- Arrange shots on a project-level timeline.
- Assign cameras and animation ranges; store shot-specific settings.
- Shot markers, notes, and reusable shot templates.

**Status (2026-11-18): done** (Shoot › Shots, Shoot › Templates).

**Update (2026-11-23): Shots rebuilt.** A shot track (move, trim, move the shared cut, swap by dragging past a neighbour, split, duplicate, snapping; gaps and overlaps shown), a storyboard view (reorder by dragging, save as one PNG), an inspector (picture, name, status, start / end / length, play and loop, still camera with lens and saved views or camera keys with a camera move across the shot, frame shape, notes), live cuts (Studio's camera switches at each cut while playing, without keys; camera-key shots keep their keys; bake cuts writes them), drag a saved view onto a shot, shots draggable on the dope sheet's ruler, every change one undo step, and the app follows changes made anywhere. Tests: suite 37 and unit tests for the shot maths.

**Update (2026-11-23): the camera side of shots.** The camera column became a **monitor** (the playhead's shot through its own camera, rendered by the preview stream without moving Studio's view; shot badge, timecode, frame mask and guides on top; live or paused) and an **Angles** bin (named camera setups saved with the scene and mirrored in a free saved view; drag onto a shot or onto the empty track for a new shot; import Studio's saved views). Shots have **camera types**: still, camera keys, first person (a character) and follow (a character's body part), switched by live cuts and look through. Camera keys show as diamonds on keyed shots. Studio's own camera tools live in the monitor's Camera and Guides menus.

**Update (2026-11-23): transitions.** Each shot has a transition in: cut, glide (the camera blends between the two shots' cameras: pivot, angle by the shortest turn, distance and lens), dip to black / white, or dissolve. Centred on the cut, never longer than either shot, smooth or linear. Dips and dissolves are drawn by a small image effect added last on Studio's camera and only switched on during a transition, so they show in Studio, on the monitor and in renders; a dissolve renders the outgoing shot once more per frame while it lasts. Bake writes glides as eased camera keys. Track: a marker at every cut (click for the picker) and a shaded window with draggable edges. Suite 37: 55 checks, plus a visual check (black / white / ghosted pictures).

**Fix (2026-11-23): renders and the shots.** Renders now go through the shots whenever the scene has them (Render › Use the shots, on by default), not only with live cuts on; the first recorded frame (taken before playing starts) has the starting shot’s camera; a dissolve’s outgoing picture is made in the same frame (no jump on its first frame); Studio’s own view comes back after the render. The monitor’s stream goes only to the window that asked for it and pauses while a render records. Shot times are kept past the end of a shortened timeline (shown hatched, with Trim or Make the timeline longer). Suite 37 renders 4 s and checks the frames.

**Fix (2026-11-23): one rule for Studio, the monitor and renders.** "Live cuts" became **Play the edit**, one switch that Studio’s playback and scrubbing, the monitor and renders all follow (off: all three play the timeline’s own camera). A still shot with camera keys in it (or a keyed move running through it) plays those keys — the moves you key always win; bake leaves such shots alone. Scrubbing shows the edit; changing the view while paused is free until the playhead moves. Suite 37: 69 checks, including renders traced frame by frame with the switch on and off.
- **Shots:** each has a name, start/end, notes, and a camera it remembers with a thumbnail. Shots are saved with the scene and shown as strips at the top of the dope sheet ruler.
- **Build camera cuts:** keys a hard cut to each shot's camera, in one undo step.
- **Render queue:** see 7.5.
- **Templates:** save a scene's staging without its characters (timeline length and frame rate, shots and cameras, look, lighting rig names, render settings, audio) and apply any part of it to another scene. Suite 22.

### 7.2 Unified Visual Asset Library
Extends the Library workspace and the Phase 1 organization features.

- Thumbnails for characters, animations, items, and scenes.
- Saved production templates.

**Status (2026-11-17): character cards done** (Library › Characters).
- **Browsing:** cards from UserData/chara with their card art, names read in the background (cached), search, female/male, folders, favorites, recent and tags.
- **Using:** **Add** to the scene (undoable), or **Swap** the selected character for another card (pose kept).
- **Objects (2026-11-19):** Library › Objects lists every item Studio can add, mods included, with pictures rendered out of sight (from the front, framed to fit), a big view from any side in the sidebar, search, groups and categories; add with one click. Pictures are cached in UserData/StudioEX/item-thumbs.
- **Production templates:** Shoot › Templates (7.1).
- **Not done:** thumbnails for animations (the game has none to show).

### 7.3 Workspace Layouts
Saved layouts give most of the benefit of dockable panels at a fraction of the cost.

- Saved and switchable layouts per workspace.
- Multi-monitor presets.
- Compact and advanced UI modes.
- Fully dockable or detachable panels only if saved layouts prove insufficient.

**Status (2026-11-17): done** (Layout menu in the header).
- **Panels:** drag a side panel's edge to resize it, double-click to hide it; remembered per workspace.
- **Compact mode** for small screens.
- **Saved layouts** remember panel sizes, hidden panels, every panel's tab, compact mode, and the window's size and position. They're restored only onto a connected monitor.
- **Mini mode (2026-11-20):** just the timeline in a small window kept on top of Studio (`Ctrl+Shift+M`), with its own size and place remembered.

### 7.4 Workflow Automation
- Batch editing commands and repeatable macros.
- User-defined quick actions (via the command palette).
- Optional scripting support.
- Project-specific presets.

**Status (2026-11-17): quick actions done** (Library › Quick actions, Ctrl+K).
- **Recording:** records the changes made in Keyframe Studio. Reads, previews and peeks are skipped.
- **Replaying:** from the page or the command palette, optionally on the current selection. Each step is undoable.
- **Not done:** scripting. Batch edits already happen wherever a panel works on several selected characters.

### 7.5 Render and Export
First check what installed screenshot and recording mods already do; drive them from Keyframe Studio rather than rebuilding them.

- Resolution and frame-rate presets.
- Camera and shot export profiles.
- Frame-sequence export, render queue, and progress tracking.
- Optional video encoding.

**Status (2026-11-20): done** (Shoot › Render), driving the installed VideoExport plugin.
- **Settings:** size presets (720p to 4K, square, vertical), 24/30/60 fps, MP4/WEBM/GIF/AVI.
- **Length:** whole timeline, seconds, or until stopped. Physics warm-up loops.
- **Encoding:** auto-encode, and delete the frames afterwards.
- **Recording:** Start and Stop with progress, and an output-folder button.
- **Render queue:** renders the ticked shots one after another, each as its own video.
- **Compatibility:** probes VideoExport's members and switches Render off with the reason if it changes. Settings changed here last for the session; VideoExport keeps its own saved defaults.
- **Timeline playback (2026-11-19):** every length mode plays the timeline from its start while recording, after optional warm-up loops (VideoExport alone never plays it).
- **Audio in the video:** the audio clips are mixed and added with VideoExport's own ffmpeg.
- **Other shapes are framed, not squished:** a vertical or square render is captured at that size, with an adjustable crop of the view.
- **Versions:** several sizes and framings from one render (for example 16:9, 9:16 and 1:1), each named and saved as its own file; remembered across scenes.

**Stills (2026-11-18):** Shoot › Stills.
- Pictures can be 1–4× supersampled, PNG or JPG, with an optional transparent background.
- Take one picture now, or one per saved view or per shot. Batches put the camera and playhead back afterwards.
- Several versions (sizes and framings) with one press, like render versions.
- Screencap (BepisPlugins) takes the pictures when installed; transparency needs it. Otherwise Keyframe Studio renders the camera itself.

**Deliverable:** A customizable production environment for multi-shot scenes and videos.

---

## Phase 8 — Keyframe Studio as the Editing Window

**Priority: High | Scope: Large | Started 2026-11-18**

The goal: people hide CharaStudio's menus and use Keyframe Studio as the editing window and the enhancement system for their images and videos. Keyframe Studio works *with* the plugins people already have (different kinds and versions). It also ships its own versions of the few that nearly everyone uses, so nobody has to install them.

**Provider rule:** when the original plugin is installed it does the job (scenes stay compatible with other users); ours fills in when it's missing. Each feature has a switch to choose, and the app shows which one is active.

### 8.1 Clean Studio Window
One switch hides Studio's menus, the object list and other plugins' panels, leaving just the viewport. Options keep Timeline's window and the move / rotate handles. HideAllUI does it when installed; ours also catches panels opened later. Only what was hidden comes back, and everything returns on its own if Keyframe Studio closes or disconnects. **Done.**

### 8.2 Effects (Look › Effects)
Built-in post effects run on Studio's camera after its own effects:
- two-tone fog
- colour correction
- contrast-adaptive sharpening
- vignette
- chromatic aberration
- film grain
- bokeh depth of field (focus can follow a character's eyes or the view centre)

They're saved with the scene and undoable, and every value is a Timeline track. When xukmi FX Shaders is installed, its effect items in the scene are listed first: switch them, edit their values (Look › Materials) or add new ones. The page warns when two effects of the same kind are on.

**Done.** Depth of field is verified live (suite 31); its focus point can be dragged in the viewport (Phase 2).

### 8.3 Camera Tools (Shoot › Shots & camera)
- **First person:** from a character's eyes. RealPOV does it when installed.
- **Follow:** keeps a body part centred. LockOnPlugin does it when installed.
- **Frame guides:** thirds, golden ratio, diagonals, golden spiral, centre, safe areas, and aspect frames with the outside dimmed. They're drawn over Studio's window only, never in renders.

**Done.**

### 8.4 Lighting (Look › Lighting)
- **Projectors:** soft circle, ring, heart, star, blinds, window, leaf dapple; as light, shadow or paint. They live on Studio folders, so Studio's handles move them and Timeline animates them. They're saved with the scene. xukmi projectors are offered too.
- **Aim lights:** a spot or directional light keeps pointing at a character's head, chest or hips. LightManager does body aiming when installed.

**Done.**

### 8.5 Complete Looks
Look presets also carry the built-in effects, projectors (placed relative to the character) and xukmi FX items with their values. Applying a look is one undo step. **Done.**

### 8.6 Next
- Projector settings are Timeline tracks too (size, softness, turn, slats / points, reach, fade, colour and strength), as of 2026-11-19. Aimed-light speed is not.
- Other plugins worth the same treatment, chosen from what users actually install.

**Gotchas learned:** Unity skips a projector whose GameObject is on a layer the camera doesn't draw (Studio's camera leaves out Default). Unity's API updater rewrites `_Projector` to `unity_Projector` inside shader sources. Studio's one-argument `SelectSingle` toggles: it deselects an already selected node.

---

## Core Design Requirements

All new features should follow these rules:

1. **Preserve compatibility.** Use existing CharaStudio and plugin APIs where practical.
2. **Keep the interface simple.** Show relevant tools based on the current selection and task.
3. **Use direct interaction.** Prefer clicking and dragging visual elements over searching through menus.
4. **Reuse existing systems.** Extend Keyframe Studio's current commands, state synchronization, and undo history.
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
| Audio for lip-sync (6.2) | Keyframe Studio's own audio track, synced to Timeline and saved with the scene. |
| Plugins vs built-in (Phase 8) | The installed plugin does the job when present; ours fills in otherwise, with a switch per feature. |
| Shaders | Compiled with Unity 5.6.2f1 (Koikatsu's exact version) and embedded in the bridge DLL. |

## Open Decisions

| Decision | Options | Needed before |
| --- | --- | --- |
| Which other plugins get built-in versions | Decide from what users install most | Phase 8.6 |

## Recommended Development Order

1. Phase 0: known issues, installer, test infrastructure, diagnostics, compatibility matrix.
2. Phase 1: pose thumbnails, expression designer, favorites and tags.
3. Phase 2: in-Studio overlays, gizmos, and selection.
4. Phase 3: streamed preview spike and go/no-go decision.
5. Phase 4: body posing, accessories, camera, and lighting tools.
6. Phase 5: Face Studio on top of KKPE.
7. Phase 6: animation layers, lip-sync, and motion cleanup.
8. Phase 7: sequencing, layouts, automation, and export.
9. Phase 8: Keyframe Studio as the editing window (effects, camera tools, lighting, clean Studio window).
10. Phase 0.2: installer, once the feature set settles.

## Success Criteria

Keyframe Studio should make common creative tasks faster, easier to discover, and easier to correct. Measured targets:

| Area | Target |
| --- | --- |
| Animation speed | A new user keys a three-pose animation in under 2 minutes |
| Discoverability | Every action is reachable from the command palette (Ctrl+K) |
| Direct manipulation | Viewport drag latency under 50 ms |
| Performance | No visible frame-rate drop in a 200-object scene with motion paths and ghosts on |
| Reliability | Full test suite passes on a fresh Studio session before every release |
| Installation | Install or update in under 2 minutes with no manual file copying |
| Correctability | Every edit made in Keyframe Studio can be undone |

Users should be able to select and edit characters, construct animations, configure lighting, and manage scenes without repeatedly switching through nested Koikatsu plugin windows. Advanced users keep precise control, and new users have a clear path to their first scene or animation.
