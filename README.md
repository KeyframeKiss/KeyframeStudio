# Keyframe Studio

A modern, external editor for **Koikatsu CharaStudio**. Studio keeps doing what it's good at
(rendering, characters, every mod and zipmod you have installed); Keyframe Studio gives you a fast,
keyboard-driven editing window next to it — animation, posing, faces, looks, effects, camera, audio and
rendering — ideal on a second monitor. Overlays and handles are drawn right in Studio's own view, so you pose
and place things where you see them.

```
┌───────────────────── CharaStudio (game) ─────────────────────┐        ┌──────────── Keyframe Studio (Electron) ────────────┐
│  BepInEx + all your mods + Timeline + KKPE + …              │        │  Animate · Pose · Look · Shoot · Library     │
│  KKStudioEX.Bridge.dll  ── ws://127.0.0.1:47615 ────────────┼───────▶│  Dope sheet · Graph · Inspector · Undo/redo  │
│  (overlays & handles drawn in Studio's view)                │        │                                              │
└──────────────────────────────────────────────────────────────┘        └──────────────────────────────────────────────┘
```

Nothing is replaced in-game: animations are stored by the existing **Timeline** plugin, so scenes
stay compatible with vanilla Timeline, and you can still open Timeline's own window at any time.

## Layout

| Folder | What |
| --- | --- |
| `plugin/StudioBridge` | BepInEx plugin (C#, .NET 3.5 / Unity 5.6). Local WebSocket server exposing scene + Timeline, plus the in-viewport overlays and handles. |
| `app` | Keyframe Studio desktop app (Electron + React + TypeScript + Vite). |
| `tests` | Live test suites that drive a running CharaStudio through the bridge, and unit tests. |
| `tools` | Packaging (`node tools/package.mjs` → portable zip with the bridge plugin inside). |

## Install / run

**Release (portable zip):** unzip anywhere, start **Keyframe Studio.exe**, then Settings › About & diagnostics ›
**Studio bridge** (or "Set up the bridge" on the waiting screen). It finds your Koikatsu folder, checks BepInEx,
and installs or updates the bridge plugin in one click — even while CharaStudio runs (it loads on Studio's next
start). Your presets live in `Koikatsu\UserData\StudioEX` and app settings in `%APPDATA%\studio-ex`, so updates keep
them.

**Plugin from source** (needs the .NET SDK; builds against your game's own DLLs):

```powershell
cd plugin/StudioBridge
dotnet build -c Release -p:Deploy=true                       # copies to D:\Games\Koikatsu\BepInEx\plugins\KKStudioEX
dotnet build -c Release -p:Deploy=true -p:GameDir="E:\KK"    # other install location
```

**App from source:**

```powershell
cd app
npm install
npm run dev      # hot-reloading dev mode (Vite + Electron)
npm start        # production build + run
node tools/package.mjs   # (repo root) portable release zip in release/
```

Start CharaStudio; Keyframe Studio connects automatically (status dot turns green).
The port is configurable in `BepInEx/config/studioex.bridge.cfg`.

## Workspaces

| Workspace | Left | Center sub-tabs | Right |
| --- | --- | --- | --- |
| **Animate** (`Ctrl+1`) | Scene | Timeline (dope sheet / graph) · **Face** · Motion clips — transport underneath | Keyframe or track details, getting started / shortcuts, Cleanup |
| **Pose** (`Ctrl+2`) | Scene | Pose library · Animations · Face Studio · Outfit | Selected character: animation, FK/IK + hands, body sliders; attachment; transform |
| **Look** (`Ctrl+3`) | Scene | Presets · Settings · Effects · Materials · Lighting | — |
| **Shoot** (`Ctrl+4`) | Scene | Shots & camera (over the dope sheet) · Audio · Render · Stills · Templates | — |
| **Library** (`Ctrl+5`) | Scenes · Characters · Objects · Quick actions | | |
| **Settings** (⚙ menu, `Ctrl+,`) | Mod settings · Studio window · Translations · Shortcuts · About & diagnostics | | |

The right panel is one column of collapsible groups that follows the selection (each remembers if it's open).
Side panels resize by dragging their edge. The ⚙ menu (top right) has Settings, shortcuts, keep-on-top, compact
mode, **mini mode** (`Ctrl+Shift+M`: just the timeline in a small window kept on top of Studio) and saved layouts.

## Animation workflow

1. Select an object or character (Scene list, or click it in Studio — with **Overlays** on, click a joint).
2. Pose it in Studio's view: drag a joint's rings or an IK target with **Handles** on, or use Studio's own tools.
3. Press **Key changes** (`Shift+Enter`, or `K` with nothing selected) to key exactly what you changed — or turn on
   **Auto** (`R`) to key as you go. **+ Track** adds a property by hand, including any **bone** of a character.
4. Move the playhead and repeat. Drag keys to retime (with **Snap**), box-select, **1–5** for easing presets,
   shape the curve or type values in the Keyframe panel.
5. **Ctrl+Z** undoes any edit made from Keyframe Studio — viewport drags included.

**Animating a face:** Animate › Face. Pick the character, move the playhead, change the expression (brows, eyes,
mouth shape and opening, blush, tears, neck) — with *Key as I change* on, each change is keyed there. Lip-sync
from audio (with vowel shapes) and blinks are on the same page.

Press **?** in the app for every shortcut.

## Features

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
| **Folders** | Timeline's own folders in the dope sheet (Objects/Folders switch): create from selected tracks (`Ctrl+G`), rename, move tracks in/out, ungroup, collapse (saved in the scene) |
| **Cleanup** (Animate) | Smooth, retime, make loop, find and fix sudden moves, check foot sliding — each one undo step |
| **Motion clips** (Animate) | Save the selected keys of one character as a clip (body, face, any track type); apply it at the playhead on any character — replace or add on top, strength, blend, speed, repeats; one undo step |
| **Face** (Animate) & **Lip-sync** | Expressions keyed at the playhead; lip-sync from audio (loudness + A/I/U/E/O vowel shapes) with voice per character, part of a clip, style presets, vowel map and all speakers at once; natural blinks |
| **Character** (Pose) | Animation browser (33k+ clips incl. mods, searchable), speed/options, FK/IK + parts, eyebrows/eyes/mouth, eye & neck look, blush/tears, hands, outfit + per-slot clothing state, accessories (MoreAccessories slots), ABMX bone sliders. Multi-select applies to all selected characters |
| **Pose library** (Pose) | Studio-compatible pose library (`.dat` and PNG poses, folders, thumbnails), save, apply, **mirror** (`M`), copy pose between characters |
| **Face Studio** (Pose) | KKPE face parts and shapes on a close-up, saved faces and expressions with tags, before/after |
| **Outfit** (Pose) | Saved outfits, accessories by body area with Solo, clipping checks |
| **Prop attachments** (Pose) | Right-click an item → **Attach to…** a scene object or a character joint; adjust grip, pause, resume, detach. Requires NodesConstraints |
| **Transform / Object** | Transform for any object (multi-select edits only the axis you touch), item colors/alpha/glow/FK/anim speed, light color/intensity/range/spot/shadows, folder & camera names, view-through-camera |
| **Look** | Every render setting in one place (color grade + LUTs, bloom, depth of field, SSAO, vignette, fog, sun shafts, shadows, toon shading, character & map light). **Look presets** (six starters, save your own, apply all or some groups at any strength). **Effects**: two-tone fog, colour correction, sharpening, vignette, lens fringes, grain, bokeh depth of field (or xukmi FX when installed). **Materials** through KK_MaterialEditor. **Lighting**: rigs around a character, projectors (window light, blinds, leaf shadows), lights that aim at a character |
| **Shots & camera** (Shoot) | Shot list with cameras and thumbnails, Studio's 10 saved views, FOV, **Key camera** / **Cut here**, camera moves (orbit, dolly, crane…), first person, follow, frame and composition guides (thirds, golden ratio, diagonals, spiral, safe areas, aspect frames) |
| **Audio** (Shoot) | Any number of clips synced to the timeline, each with volume, balance, speed, fades and trims; lanes in the dope sheet; headphone (Bluetooth) delay; saved with the scene |
| **Render** (Shoot) | Video through VideoExport: plays the timeline, warm-up loops, audio mixed in, other shapes framed (not squished), several **versions** (sizes and framings) from one render, render queue per shot |
| **Stills** (Shoot) | Supersampled pictures, PNG/JPG, transparent background, one per saved view or shot, several versions in one press |
| **Templates** (Shoot) | A scene's staging without its characters — timeline, shots and cameras, look, lighting rigs, render settings, audio — applied to another scene |
| **Library** | Scene browser (`Ctrl+O`), character cards (add / swap), **Objects** (every item and mod with rendered pictures, big preview from any side, add with one click), quick actions (record and replay) |
| **Undo everywhere** | One history for timeline, viewport handles, character panel, ABMX, transform, light, item and look edits; a slider or handle drag is one undo step |
| **Studio window** (Settings) | Hide Studio's menus and other plugins' panels so it's just the picture (HideAllUI when installed) |
| **Mod settings** (Settings) | Every BepInEx plugin setting (100+ plugins) searchable in one window, typed editors, changed-only filter, reset to default |
| **Translations** (Settings) | Every Japanese string Keyframe Studio has shown, tagged Yours / Machine / Game. **Auto-translate** new names with Google, DeepL or a local AI; results are pushed into AutoTranslator so the in-game UI improves too |

## Diagnostics and compatibility

**Settings › About & diagnostics** shows versions and which features work with the installed mods, sets up the
bridge, and **Copy diagnostics** puts a bug-report text on the clipboard. The report has versions, installed
plugins, feature status and the recent bridge and app logs, with the Windows user name hidden. The app log is in
`%APPDATA%\studio-ex\logs\studioex.log`.

Each mod-dependent feature checks the exact classes and members it uses when Studio starts. A feature whose
mod is missing or changed is switched off on its own, and its commands answer with the reason. An untested
version that still matches stays on and is marked "untested". When a popular plugin is installed it does the
job (scenes stay compatible with other users); Keyframe Studio's own version fills in when it's missing.

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

## Tests

Live suites drive a running CharaStudio through the bridge (`tests/suites/*.mjs`). Each suite starts from an
empty scene and removes the files it creates, so they run alone or in any order. **They replace the scene open
in Studio — save first.** Needs Node 22+.

```powershell
npm test                      # every suite, pass/fail summary (asks before touching Studio)
node tests/run.mjs face look  # suites whose name contains a word (or a number: node tests/run.mjs 35)
node tests/run.mjs --list     # what exists · --yes skips the question · --verbose prints every check
node tests/run.mjs stress     # large-scene stress test (200+ objects, 120 tracks, 5,400 keys; not in the default run)
npm run test:unit             # the pure maths (no Studio needed)
```

The viewport overlays and handles are tested with a simulated mouse (`gizmo.simulate`, suite 35). The stress test
prints timings. Start the app with `KF_DEBUG_PORT=9333` (development only) to include the app window's own draw and
refresh times. Commands that take over 50 ms are noted in the bridge log (Copy diagnostics).

## Protocol

JSON over WebSocket. Request `{"id":1,"cmd":"timeline.seek","args":{"t":1.5}}` →
`{"id":1,"ok":true,"result":…}`. Server pushes `{"event":"timeline.tick"|"timeline.changed"|"scene.changed"|"selection"|"scene.reset"|"gizmo.target"|…,"data":…}`.
Commands live in `plugin/StudioBridge/src/Api/*.cs`; wire types in `app/src/bridge/types.ts`.

## Roadmap

What's done and what's next is in [FUTURE_ROADMAP.md](FUTURE_ROADMAP.md). Open items include code signing, an
uninstall button and update checks; foot and hand locking; click-to-light; editing a camera move's path in the
viewport; and thumbnails for animations.
