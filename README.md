# Keyframe Studio

A modern, external editor for **Koikatsu CharaStudio**. Studio keeps doing what it's good at
(rendering, characters, every mod and zipmod you have installed); Keyframe Studio gives you a fast,
keyboard-driven animation editor in its own window — ideal on a second monitor.

```
┌───────────────────── CharaStudio (game) ─────────────────────┐        ┌──────────── Keyframe Studio (Electron) ────────────┐
│  BepInEx + all your mods + Timeline + KKPE + …              │        │  Outliner · Dope sheet · Curve editor        │
│  KKStudioEX.Bridge.dll  ── ws://127.0.0.1:47615 ────────────┼───────▶│  Inspector · Track browser · Undo/redo       │
└──────────────────────────────────────────────────────────────┘        └──────────────────────────────────────────────┘
```

Nothing is replaced in-game: animations are stored by the existing **Timeline** plugin, so scenes
stay compatible with vanilla Timeline, and you can still open Timeline's own window at any time.

## Layout

| Folder | What |
| --- | --- |
| `plugin/StudioBridge` | BepInEx plugin (C#, .NET 3.5 / Unity 5.6). Local WebSocket server exposing scene + Timeline. |
| `app` | Keyframe Studio desktop app (Electron + React + TypeScript + Vite). |

## Install / run

**Plugin** (needs the .NET SDK; builds against your game's own DLLs):

```powershell
cd plugin/StudioBridge
dotnet build -c Release -p:Deploy=true                       # copies to D:\Games\Koikatsu\BepInEx\plugins\KKStudioEX
dotnet build -c Release -p:Deploy=true -p:GameDir="E:\KK"    # other install location
```

**App:**

```powershell
cd app
npm install
npm run dev      # hot-reloading dev mode (Vite + Electron)
npm start        # production build + run
```

Start CharaStudio; Keyframe Studio connects automatically (status bar turns green).
The port is configurable in `BepInEx/config/studioex.bridge.cfg`.

## Tests

Live suites drive a running CharaStudio through the bridge (`tests/suites/*.mjs`). Each suite starts from an
empty scene and removes the files it creates, so they run alone or in any order. **They replace the scene open
in Studio — save first.** Needs Node 22+.

```powershell
npm test                      # every suite, pass/fail summary (asks before touching Studio)
node tests/run.mjs face look  # suites whose name contains a word
node tests/run.mjs --list     # what exists · --yes skips the question · --verbose prints every check
node tests/run.mjs stress     # large-scene stress test (200+ objects, 120 tracks, 5,400 keys; not in the default run)
```

The stress test prints timings. Start the app with `KF_DEBUG_PORT=9333` (development only) to include the app
window's own draw and refresh times. Commands that take over 50 ms are noted in the bridge log
(Copy diagnostics).

## Diagnostics and compatibility

**Settings (gear icon) › About & diagnostics** shows versions and which features work with the installed mods, and
**Copy diagnostics** puts a bug-report text on the clipboard. The report has versions, installed plugins,
feature status and the recent bridge and app logs, with the Windows user name hidden. The app log is in
`%APPDATA%\studio-ex\logs\studioex.log`.

Each mod-dependent feature checks the exact classes and members it uses when Studio starts. A feature whose
mod is missing or changed is switched off on its own, and its commands answer with the reason. An untested
version that still matches stays on and is marked "untested".

| Feature | Mod | Tested with |
| --- | --- | --- |
| Animation (dope sheet, graph, keys, auto-key, ghosts) | Timeline | 1.3.0 |
| Face Studio: face parts, saved faces | KKPE | 2.17.0 |
| Face Studio: shapes (blendshapes) | KKPE | 2.17.0 |
| Bone sliders (ABMX) | KKABMX | 5.2 |
| Look: material tweaks, material rules in presets | Material Editor | 3.7.0 |
| Look: second colour LUT | KK_TwoLut | — |
| English names | XUnity AutoTranslator | — |

## Workspaces

| Workspace | Left | Center | Right |
| --- | --- | --- | --- |
| **Animate** (`Ctrl+1`) | Scene | Dope sheet / graph, transport | Keyframe or track inspector, Cleanup, selected object |
| **Pose** (`Ctrl+2`) | Scene | Pose library / Animations / Face Studio | Selected character: animation, FK/IK, expression, clothes, saved outfits, transform |
| **Look** (`Ctrl+3`) | Scene | Look presets | Look settings, lighting rigs |
| **Shoot** (`Ctrl+4`) | Scene | Shots and camera over the dope sheet | Render, audio & lip-sync |
| **Library** (`Ctrl+5`) | Scenes, characters, quick actions | | |
| **Settings** (⚙, `Ctrl+,`) | Mod settings, translations, shortcuts, about & diagnostics | | |

The right panel is one column of collapsible groups that follows the selection (each remembers if it's open).
Side panels resize by dragging their edge; the ⊞ menu saves layouts.

## Animation workflow

1. Select an object (Scene list, or click it in Studio).
2. **+ Track** above the dope sheet → click a property (e.g. a bone, position, expression). It's added with a key at the playhead.
3. Move the playhead, pose in Studio, press **K** (selected tracks) or **Shift+K** (whole object).
4. Drag keys to retime, box-select, **1–5** for easing presets, or shape the curve in the Inspector.
5. **Ctrl+Z** undoes any edit made from Keyframe Studio.

Press **?** in the app for every shortcut.

## Protocol

JSON over WebSocket. Request `{"id":1,"cmd":"timeline.seek","args":{"t":1.5}}` →
`{"id":1,"ok":true,"result":…}`. Server pushes `{"event":"timeline.tick"|"timeline.changed"|"scene.changed"|"selection"|"scene.reset","data":…}`.
Commands live in `plugin/StudioBridge/src/Api/*.cs`; wire types in `app/src/bridge/types.ts`.

## Features

| Area | What you get |
| --- | --- |
| **Dope sheet** | Tracks grouped per object with summary keys, drag/box select, frame snapping, copy/paste/duplicate, easing hotkeys, context menus, undo/redo |
| **Graph editor** (`Tab`) | Real value curves over time. Rotations shown as X/Y/Z degrees (Unity order, unwrapped). Drag keys ↕ to change values, ↔ to retime; double-click a curve to insert a key; normalize mode to overlay different units |
| **Curve editor** | Per-key easing with tangent handles, multi-point curves and presets matching Timeline's |
| **Character** (Pose) | Animation browser (33k+ clips incl. mods, searchable), speed/options, FK/IK + parts, eyebrows/eyes/mouth, eye & neck look, blush/tears, hands, outfit + per-slot clothing state, accessories (MoreAccessories slots), ABMX bone sliders. Multi-select applies to all selected characters |
| **Pose library** (Pose) | Studio-compatible pose library (`.dat` and PNG poses, folders, thumbnails), save, apply, **mirror** (`M`), copy pose between characters |
| **Scene browser** (`Ctrl+O`) | Thumbnail grid of `UserData/studio/scene`, folders, search, load, import (merge), save, new |
| **Folders** | Timeline's own folders in the dope sheet (Objects/Folders switch): create from selected tracks (`Ctrl+G`), rename, move tracks in/out, ungroup, collapse (saved in the scene) |
| **Key changes / Auto-key** | Keyframe Studio notices what you changed in Studio since the last seek (any track type, plus bones/objects without tracks) — `K` with nothing selected or **Key changes** keys exactly that; **Auto** (`R`) keys it automatically when you release the mouse. Self-animating things (spinning items, physics bones) are detected and ignored |
| **Undo everywhere** | One history for timeline, character panel, ABMX, transform, light and item edits; a slider drag is one undo step |
| **Transform / Object** | Transform for any object (multi-select edits only the axis you touch), item colors/alpha/glow/FK/anim speed, light color/intensity/range/spot/shadows, folder & camera names, view-through-camera |
| **Camera** (Shoot) | Viewport snapshot, Studio's 10 saved views with thumbnails, FOV, **Key camera** / **Cut here** (hard cut), shot list with thumbnails, scene cameras |
| **Look** | Every render setting in one place: color grade (LUT + KK_TwoLut second LUT + blend), bloom, depth of field, SSAO, vignette, fog, sun shafts, shadows, global toon shading (ramp, outline darkness/width, shadow color/depth, face options), character & map light. **Look presets** (UserData/StudioEX/looks, JSON + thumbnail): six starters, save your own, apply all or only some groups, at any strength (blend), undoable. **Materials**: bulk-edit any shader property across the selected characters/items through KK_MaterialEditor (saved like MaterialEditor edits) and include those tweaks in presets |
| **Mod settings** (`Ctrl+,` / ⚙) | Every BepInEx plugin setting (100+ plugins) searchable in one window, typed editors, changed-only filter, reset to default |
| **Translations** (Settings) | Every Japanese string Keyframe Studio has shown, tagged Yours / Machine / Game. **Auto-translate** new names in the background with Google (free, no setup), DeepL (free API key) or a local AI (Ollama / LM Studio, any OpenAI-compatible server). Machine results go to `zy_StudioEX_Machine.txt`, your edits to `zz_StudioEX_Overrides.txt` (always win); both are pushed into AutoTranslator so the in-game UI improves too. "Improve all" re-translates Game/Machine rows with a better engine |

## Roadmap

- [x] Motion paths + onion skin (ghosts) in Studio's viewport — top bar **Paths** / **Ghosts**
- [x] Rename objects (F2 / double-click / right-click; multi-select numbers them; persisted via KK_TreeNodeNaming)
- [ ] Git repository + Windows installer (single .exe, plugin bundled)
