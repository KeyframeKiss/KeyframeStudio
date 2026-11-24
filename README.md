<p align="center">
  <img src="docs/images/logo.png" alt="Keyframe Studio" width="560">
</p>

<p align="center">
  <b>A modern editing window for Koikatsu CharaStudio</b><br>
  Animate, pose, light and render your scenes in a fast, keyboard-friendly app next to Studio —<br>
  with handles and overlays drawn right in Studio's own view.
</p>

<p align="center">
  <a href="../../releases"><img alt="Download" src="https://img.shields.io/badge/download-beta-ff4fa3?style=for-the-badge"></a>
  <a href="../../issues/new/choose"><img alt="Report a bug" src="https://img.shields.io/badge/report-a%20bug-7c5cff?style=for-the-badge"></a>
  <img alt="Windows" src="https://img.shields.io/badge/windows-10%20%7C%2011-3a3f4b?style=for-the-badge">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3a3f4b?style=for-the-badge">
</p>

<p align="center">
  <img src="docs/images/app-animate.png" alt="Keyframe Studio: the Animate workspace with folders of bone tracks, keys and the keyframe panel" width="900">
</p>

> **Beta.** Keyframe Studio works and is tested against a live CharaStudio, but it's new — expect rough edges.
> Your scenes stay ordinary Timeline scenes, so you can always open them without it.
> [Bug reports](../../issues/new/choose) are the most useful thing you can send.

## Why

CharaStudio is great at rendering and at running every mod you own, but animating in it means nested windows,
tiny gizmos and a lot of clicking. Keyframe Studio keeps Studio doing what it's good at and gives you a proper
editor beside it — ideal on a second monitor:

- **A real timeline.** Dope sheet and graph editor, keys you drag and snap, easing curves, folders, search, undo for everything.
- **Longer motions from Studio's own.** The Motion builder strings animations, poses and your clips together, blended, with feet that stay planted.
- **Pose where you look.** Click a joint in Studio's view and turn it on its rings; drag IK targets, props, lights, cameras and accessories.
- **Everything else in one place.** Faces and lip-sync, looks and effects, lighting rigs, cameras and shots, audio, rendering with several versions at once.
- **Nothing locked in.** Animations are stored by the existing **Timeline** plugin, so scenes stay compatible with vanilla Timeline and other people's setups.

## A quick look

### Pose right in Studio's view

<table>
  <tr>
    <td width="58%"><img src="docs/images/viewport-rings.jpg" alt="Skeleton overlay with a bone's rotation rings in Studio's viewport"></td>
    <td>
      <b>Skeleton, joints and handles</b> drawn over Studio's own picture — never in your renders.
      Click a joint and turn it on its rings; drag an IK target and only that limb goes to IK.
      FK and IK work together per limb, and scenes reload that way.
      <br><br>
      <img src="docs/images/viewport-fan.jpg" alt="Overlapping markers fanned out into labelled chips">
      <br><sub>Where markers overlap, rest the pointer and they fan out to pick from.</sub>
      <br><br>
      <img src="docs/images/viewport-modes.jpg" alt="Move, Rotate and Scale chips around an object's handles" width="300">
      <br><sub>Click the handles' middle — or rest on it — to switch Move / Rotate / Scale.</sub>
    </td>
  </tr>
</table>

### Animate like you would in an animation app

<p align="center"><img src="docs/images/app-graph.png" alt="Graph editor showing a head rotation's curves in degrees" width="860"></p>

Dope sheet and graph editor (`Tab`), **Key changes** to key exactly what you moved in Studio, auto-key, snapping
to keys / the playhead / ruler ticks, easing presets and your own saved curves, values you can drag or type, motion
paths and onion-skin ghosts, folders (an eye mutes a whole folder or object), search and a type filter — and one undo history for all of it.

<table>
  <tr>
    <td width="50%"><img src="docs/images/app-face.png" alt="Animate › Face: expressions keyed at the playhead with a close-up"></td>
    <td width="50%"><img src="docs/images/app-look-effects.png" alt="Look › Effects: fog, colour correction, depth of field, vignette, grain"></td>
  </tr>
  <tr>
    <td><b>Face</b> — expressions keyed at the playhead, lip-sync from audio with vowel shapes, natural blinks.</td>
    <td><b>Look</b> — every render setting, built-in effects (fog, colour, depth of field, grain…), materials, lighting rigs, presets.</td>
  </tr>
  <tr>
    <td><img src="docs/images/app-render.png" alt="Shoot › Render: sizes, frame rate, file type and framing"></td>
    <td><img src="docs/images/app-view-options.png" alt="The View options: overlays, handles, paths and ghosts"></td>
  </tr>
  <tr>
    <td><b>Shoot</b> — shots and cameras, audio clips, video renders (straight to video, several sizes and framings from one render, audio mixed in), stills.</td>
    <td><b>View</b> — overlays, handles, motion paths and ghosts, toggled from the bottom bar.</td>
  </tr>
</table>

### Longer motions from Studio's own animations

<p align="center"><img src="docs/images/app-motion-builder.png" alt="Animate › Motion builder: a walk, a run and a pose in a row on a character's lane, blended, with Feet planted on" width="860"></p>

The **Motion builder** puts Studio's animations, poses and your motion clips in a row on a lane for each character
and blends each into the next. Drag, trim and blend the blocks; set speed, mirror and **Feet planted**, which keeps
a foot still while it's down, so Studio's on-the-spot walks and runs really cross the floor. It's all built into
ordinary keys you can edit, as one undo step.

## Get started

**You need:** Koikatsu (or Koikatsu Party) with CharaStudio, BepInEx 5.4 and KKAPI — any HF Patch or BetterRepack
has them — and the **Timeline** plugin for animation. Other plugins (KKPE, MaterialEditor, KKABMX, VideoExport,
Screencap, NodesConstraints, xukmi FX, RealPOV, LockOnPlugin, LightManager, HideAllUI) are used when you have them;
features that need a missing one say so.

1. **Download** the latest zip from [Releases](../../releases) and unzip it anywhere.
2. Start **Keyframe Studio.exe** and press **Set up the bridge**. It finds your Koikatsu folder (or you choose it),
   checks BepInEx and installs the small bridge plugin in one click.
3. Start **CharaStudio**. Keyframe Studio connects by itself — the dot in the top bar turns green.
4. Load a scene, click a character, open **Animate** and press `?` for the shortcuts.

Windows may warn about an unknown publisher the first time (the app isn't code-signed yet): choose
**More info → Run anyway**. The app tells you when a new version is out (a notice in the top bar; it only asks
GitHub for the newest release, and you can turn it off). Updating: replace the folder, then **Settings › About &
diagnostics › Update the bridge**, and restart CharaStudio. **Settings › Help & guide** (`F1`) covers getting
started, good habits and common fixes.
Your presets live in `Koikatsu\UserData\StudioEX` and app settings in `%APPDATA%\studio-ex`, so updates keep them.

## Testing and reporting bugs

Thank you for testing! When something goes wrong:

1. In Keyframe Studio open **Settings (⚙) › About & diagnostics** and press **Copy diagnostics**. It copies versions,
   installed plugins, feature status and the recent logs, with your Windows user name hidden.
2. [Open a bug report](../../issues/new/choose), paste it, and say what you did and what happened.
3. Screenshots help — please keep them **safe for work** (crop or blur anything explicit).

Most edits are one `Ctrl+Z` away, and nothing is saved into your scene until you save it in Studio.
Missed a popup? Everything that popped up is kept in **Messages** in the status bar.

## Workspaces

| Workspace | What's there |
| --- | --- |
| **Animate** (`Ctrl+1`) | Timeline (dope sheet / graph) · Motion builder · Face · Motion clips · Cleanup — the transport bar underneath; keyframe or track details on the right |
| **Pose** (`Ctrl+2`) | Pose library · Animations · Face Studio · Outfit — the selected character's animation, FK/IK, hands, body sliders, attachments, transform |
| **Look** (`Ctrl+3`) | Presets · Settings · Effects · Materials · Lighting |
| **Shoot** (`Ctrl+4`) | Shots & camera · Audio · Render · Stills · Templates |
| **Library** (`Ctrl+5`) | Scenes · Characters · Objects (every item with pictures) · Quick actions |
| **Settings** (`Ctrl+,`) | Help & guide (`F1`) · Mod settings · Studio window · Translations · Shortcuts · About & diagnostics (updates, bug reports) |

The ⚙ menu also has keep-on-top, compact mode, **mini mode** (`Ctrl+Shift+M` — just the timeline in a small
window kept on top of Studio) and saved layouts.

<details>
<summary><b>Every feature</b></summary>

| Area | What you get |
| --- | --- |
| **Viewport overlays** (bottom bar › View) | Drawn in Studio's own view, never in renders: skeleton with clickable joints (blue where FK poses them), IK targets (on their joint when idle), accessories, selection outline, lights (direction, cone, reach), scene cameras, the depth-of-field focus point, names on hover. Where markers overlap, rest the pointer and they fan out into labelled chips to pick from |
| **Viewport handles** | Rings to turn a bone (its axes + a view ring), arrows / cubes / free-move to move and scale objects, lights, cameras, IK targets and accessories; Local or World axes; Ctrl snaps, Shift fine; click the middle (or rest on it) to switch Move / Rotate / Scale. Only the touched part goes to FK (a limb to IK) from the pose on screen — FK and IK work together per limb, and scenes reload that way. Studio's camera holds still over a handle; each drag is one undo |
| **Dope sheet** | Tracks grouped per object with summary keys, drag/box select, copy/paste/duplicate, easing hotkeys, context menus, audio lanes, undo/redo. **Snap** lands on keys (this track only / all tracks / none), the playhead, ruler ticks and clip edges, with a line and tag saying what; Alt places freely |
| **Graph editor** (`Tab`) | Real value curves over time. Rotations shown as X/Y/Z degrees (Unity order, unwrapped). Drag keys ↕ to change values, ↔ to retime; double-click a curve to insert a key; normalize mode to overlay different units |
| **Keyframe panel** | Time, and the key's **value to drag or type** (rotations as X/Y/Z degrees; Studio follows live, one drag one undo). Easing to the next key with tangent handles, multi-point curves, presets matching Timeline's, and **My easings** (save your own curves, rename, delete) |
| **Add track** | Every Timeline track type for the selection, plus a **Bones** section: a character's bones and IK targets by body part, each with Rotation / Position — the joint picked in the viewport first |
| **Key changes / Auto-key** | Keyframe Studio notices what you changed in Studio since the last seek (any track type, plus bones/objects without tracks) — **Key changes** keys exactly that; **Auto** (`R`) keys it automatically when you release the mouse. Self-animating things (spinning items, physics bones) are detected and ignored |
| **Motion paths & ghosts** (bottom bar › View) | Paths of hands, feet, head, objects and the camera target over the timeline; onion-skin ghosts at neighbouring keys |
| **Organizing tracks** | Group the list by **Objects** or your own **Folders** (Timeline's, saved in the scene) from the timeline toolbar. **Folder** makes one from the selected tracks and names it; drag tracks onto a folder to move them in, onto the Tracks header to take them out; rename, ungroup, open / close all. **Search** (`Ctrl+F`) matches track, object, folder and type names (several words narrow it down); the **type filter** shows only bones, transform, face, character, camera, lights, items, look & effects or other |
| **Foot & hand locking** (Animate › Cleanup) | Keep a foot or hand on one spot over a time range while the body moves: no sliding feet, a hand that stays on the table. Keys the limb's IK target only where needed (within ~2 mm), eases back into its own motion afterwards (0–0.5 s), and warns when the body moves further than the arm or leg reaches. A limb posed with FK switches to IK with its motion kept. **Check foot sliding** offers **Lock** on each slide it finds. One undo step |
| **Cleanup** (Animate › Cleanup) | Lock a foot or hand, smooth, retime, make loop, find and fix sudden moves, check foot sliding — each one undo step. Works on the keys selected in the timeline, or a character's whole tracks in one click |
| **Motion builder** (Animate) | Longer motions from Studio's animations, poses and your motion clips in a row on a lane per character, blended into each other (smooth or linear). Drag to move, trim either end, blend; edges snap to other blocks, the playhead and the ends; ripple, nudge, zoom. Per block: speed, in-point, **mirror**, and **feet planted** (a foot on the ground stays put; Studio's on-the-spot walks and runs travel across the floor). Built into ordinary keys in a Motion folder as one undo step; your edits to those keys are kept through rebuilds; saved with the scene |
| **Motion clips** (Animate) | Save the selected keys of one character as a clip (body, face, any track type); apply it at the playhead on any character — replace or add on top, strength, blend, speed, repeats; one undo step |
| **Face** (Animate) & **Lip-sync** | Expressions keyed at the playhead; lip-sync from audio (loudness + A/I/U/E/O vowel shapes) with voice per character, part of a clip, style presets, vowel map and all speakers at once; natural blinks |
| **Character** (Pose) | Animation browser (33k+ clips incl. mods, searchable; also Ctrl+K › Change animation, or right-click a character in the scene list — picking a clip makes it play: FK / IK that would hold the body still go off and a stopped animation starts, one undo), speed/options, FK/IK + parts, eyebrows/eyes/mouth, eye & neck look, blush/tears, hands, outfit + per-slot clothing state, accessories (MoreAccessories slots), ABMX bone sliders. Multi-select applies to all selected characters |
| **Pose library** (Pose) | Studio-compatible pose library (`.dat` and PNG poses, folders, thumbnails), save, apply, **mirror** (`M`), copy pose between characters |
| **Face Studio** (Pose) | KKPE face parts and shapes on a close-up, saved faces and expressions with tags, before/after |
| **Outfit** (Pose) | Saved outfits, accessories by body area with Solo, clipping checks |
| **Prop attachments** (Pose) | Right-click an item → **Attach to…** a scene object or a character joint; adjust grip, pause, resume, detach. Requires NodesConstraints |
| **Transform / Object** | Transform for any object (multi-select edits only the axis you touch), item colors/alpha/glow/FK/anim speed, light color/intensity/range/spot/shadows, folder & camera names, view-through-camera |
| **Look** | Every render setting in one place (color grade + LUTs, bloom, depth of field, SSAO, vignette, fog, sun shafts, shadows, toon shading, character & map light). **Look presets**: 19 built-in looks (times of day, weather, mood lighting, film styles, Noir, Neon Night, Underwater…), each a colour gradient until its first use; save your own, apply all or some groups at any strength. **Effects**: two-tone fog, colour correction, sharpening, vignette, lens fringes, grain, bokeh depth of field (or xukmi FX when installed). **Materials** through KK_MaterialEditor. **Lighting**: rigs around a character (each drawn from above and from the side), projectors (window light, blinds, leaf shadows), lights that aim at a character, and one list of everything added to switch off, select or remove |
| **Shots** (Shoot › Shots & camera) | A **shot track** along the timeline: drag shots to move them, drag an edge to trim, drag the edge two shots share to move the cut, drag past a neighbour to swap; split at the playhead, duplicate, snapping to frames, cuts and the playhead; gaps and overlaps shown (one click fixes overlaps). Or a **storyboard** of big pictures with notes, drag to reorder, saved as one picture to share. Each shot has a status (idea, blocked, framed, final), notes, a frame shape, and a camera type: **still** (Studio's view or an angle), **camera keys** (with a camera move across the shot), **first person** through a character's eyes, or **follow** a body part. A **monitor** shows the edit at the playhead through each shot's own camera (your Studio view isn't moved), with the shot's name, timecode, frame and guides. **Angles** keep camera setups to reuse: drag one onto a shot, or onto the empty track for a new shot; each is mirrored in one of Studio's saved views. **Play the edit** (one switch): Studio's view (playing and scrubbing), the monitor and renders all follow the shots — nothing keyed; a shot with camera keys plays its keys. **Transitions** per cut: a hard **cut**, a **glide** (the camera travels between the two shots' cameras; short = a whip pan), a **dip to black / white**, or a **dissolve** — centred on the cut, any length, smooth or linear; shown as a marker and a shaded window on the track, and played in Studio, on the monitor and in renders (Play the edit). **Bake cuts** writes cuts and glides as camera keys (dips and dissolves keep playing from Play the edit). Shots are also draggable on the dope sheet's ruler. Every change is one undo step |
| **Camera** (Shoot › Shots & camera › monitor) | **Camera** menu: Studio's lens, **Key camera** / **Cut here**, camera moves (orbit, dolly, crane…), first person, follow, scene cameras. **Guides** menu: thirds, golden ratio, diagonals, spiral, safe areas, aspect frames — drawn on the monitor and in Studio's window |
| **Audio** (Shoot) | Any number of clips synced to the timeline, each with volume, balance, speed, fades and trims; lanes in the dope sheet; headphone (Bluetooth) delay; saved with the scene |
| **Render** (Shoot) | Video through VideoExport: plays the timeline **through the shots** when Play the edit is on (their cameras, cuts and transitions; shots with camera keys play their keys), audio mixed in, other shapes framed (not squished), several **versions** (sizes and framings) from one render, render queue per shot. **Straight to video** sends frames into the encoder as they render (no image files, no encoding wait); a quick warm-up for physics; **Draft** for fast checks; MP4 encoding balanced, smallest, or on the GPU |
| **Stills** (Shoot) | Supersampled pictures, PNG/JPG, transparent background, one per saved view or shot, several versions in one press |
| **Templates** (Shoot) | A scene's staging without its characters — timeline, shots and cameras, look, lighting rigs, render settings, audio — applied to another scene |
| **Library** | Scene browser (`Ctrl+O`), character cards (add / swap), **Objects** (every item and mod with rendered pictures, big preview from any side, add with one click), quick actions (record and replay) |
| **Undo everywhere** | One history for timeline, viewport handles, character panel, ABMX, transform, light, item and look edits; a slider or handle drag is one undo step |
| **Studio window** (Settings) | Hide Studio's menus and other plugins' panels so it's just the picture (HideAllUI when installed) |
| **Mod settings** (Settings) | Every BepInEx plugin setting (100+ plugins) searchable in one window, typed editors, changed-only filter, reset to default |
| **Translations** (Settings) | Every Japanese string Keyframe Studio has shown, tagged Yours / Machine / Game. **Auto-translate** new names with Google, DeepL or a local AI; results are pushed into AutoTranslator so the in-game UI improves too |

</details>

## Compatibility

Each mod-dependent feature checks the exact classes and members it uses when Studio starts. If a mod is missing
or has changed, only that feature switches off and tells you why; an untested version that still matches stays on
and is marked "untested". When a popular plugin is installed it does the job (so scenes stay compatible with other
people); Keyframe Studio's own version fills in when it's missing.

| Feature | Mod | Tested with |
| --- | --- | --- |
| Animation (dope sheet, graph, keys, auto-key, ghosts) | Timeline | 1.3.0 |
| Face Studio: face parts, saved faces, shapes | KKPE | 2.17.0 |
| Bone sliders (ABMX) | KKABMX | 5.2 |
| Look: material tweaks, material rules in presets | Material Editor | 3.7.0 |
| Look: second colour LUT | KK_TwoLut | — |
| Render (video) | VideoExport | — |
| Stills (transparent background) | Screencap (BepisPlugins) | — |
| Prop attachments | NodesConstraints | — |
| First person / follow / light aiming / clean window (used when installed) | RealPOV / LockOnPlugin / LightManager / HideAllUI | — |
| FK and IK together on load (kept compatible) | KK_FKIK | — |
| English names | XUnity AutoTranslator | — |

## How it works

```
┌──────────────── CharaStudio ────────────────┐                ┌────────── Keyframe Studio ──────────┐
│ BepInEx · Timeline · KKPE · your mods        │   WebSocket    │ Animate · Pose · Look · Shoot · Lib │
│ KKStudioEX.Bridge.dll (overlays & handles) ──┼── 127.0.0.1 ──▶│ Electron + React + TypeScript       │
└──────────────────────────────────────────────┘     :47615     └─────────────────────────────────────┘
```

The **bridge** is a BepInEx plugin (C#, .NET 3.5 / Unity 5.6) with a local WebSocket server: it exposes the
scene and Timeline, draws the overlays and handles in Studio's view, and keeps one shared undo history. It only
listens on your own machine (`127.0.0.1`) and only answers clients holding its token, so web pages can't reach it
([SECURITY.md](SECURITY.md)); the port is in `BepInEx/config/studioex.bridge.cfg`.

<details>
<summary><b>Building from source</b></summary>

| Folder | What |
| --- | --- |
| `plugin/StudioBridge` | The bridge plugin. Builds against your game's own DLLs. |
| `app` | The desktop app (Electron + React + TypeScript + Vite). |
| `shaders` | The Unity 5.6.2f1 project the effect shaders are compiled with (embedded in the bridge). |
| `tests` | Live suites that drive a running CharaStudio through the bridge, and unit tests. |
| `tools` | Packaging: `node tools/package.mjs` makes the portable zip with the bridge inside. |

```powershell
# the bridge (needs the .NET SDK)
cd plugin/StudioBridge
dotnet build -c Release -p:Deploy=true                       # copies to D:\Games\Koikatsu\BepInEx\plugins\KKStudioEX
dotnet build -c Release -p:Deploy=true -p:GameDir="E:\KK"    # another install location

# the app (needs Node 22+)
cd app
npm install
npm run dev      # hot-reloading development mode
npm start        # production build + run

# a release zip (repo root)
node tools/package.mjs
```

**Tests.** Live suites (`tests/suites/*.mjs`) drive a running CharaStudio through the bridge. Each starts from an
empty scene and removes the files it creates. **They replace the scene open in Studio — save first.**

```powershell
npm test                      # every suite (asks before touching Studio)
node tests/run.mjs face look  # suites whose name contains a word (or a number: node tests/run.mjs 35)
node tests/run.mjs --list     # what exists · --yes skips the question · --verbose prints every check
node tests/run.mjs stress     # large-scene stress test (not in the default run)
npm run test:unit             # the pure maths (no Studio needed)
```

The viewport overlays and handles are tested with a simulated mouse (`gizmo.simulate`, suite 35).

**Protocol.** JSON over WebSocket at `ws://127.0.0.1:47615/?token=<token>`, where the token is the contents of
`%APPDATA%\studio-ex\bridge-token` (written by the bridge; connections without it are refused — see
[SECURITY.md](SECURITY.md)). Request `{"id":1,"cmd":"timeline.seek","args":{"t":1.5}}` →
`{"id":1,"ok":true,"result":…}`; the bridge pushes `{"event":"timeline.tick"|"scene.changed"|"selection"|"gizmo.target"|…,"data":…}`.
Commands live in `plugin/StudioBridge/src/Api/*.cs`, wire types in `app/src/bridge/types.ts`.

</details>

## Roadmap

What's done and what's next is in [FUTURE_ROADMAP.md](FUTURE_ROADMAP.md). Next up: code signing and an uninstall
button; click-to-light; editing a camera move's path in the viewport.

## License

[MIT](LICENSE). Keyframe Studio is an unofficial fan tool and isn't affiliated with ILLUSION or the authors of the
plugins it works with.
