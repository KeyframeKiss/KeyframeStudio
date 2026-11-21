# Security

## Reporting a problem

Please **don't open a public issue** for a security problem. Use GitHub's private reporting instead:
the repository's **Security** tab → **Report a vulnerability**. Say what you found, how to reproduce it and what an
attacker could do with it. You'll get an answer as soon as possible, and credit if you'd like it once it's fixed.

## How Keyframe Studio is protected

- **The bridge only listens on your own machine** (`127.0.0.1`), never on your network.
- **Every connection needs the bridge token.** Browsers let any web page open a WebSocket to `127.0.0.1`, so the
  bridge asks each client for a random 256-bit token kept in `%APPDATA%\studio-ex\bridge-token`. Only programs
  running as your Windows user can read it, so a website you visit can't drive CharaStudio. Connections from web
  pages are also refused by their Origin.
- **The app window is sandboxed:** context isolation on, no Node.js in the page, a strict Content-Security-Policy
  in release builds, links open only in your browser, and the page can only reach the few functions the app
  exposes (open a file dialog, read a game picture, install the bridge into a Koikatsu folder).
- **Files stay where they belong:** presets, poses and thumbnails are read and written only inside their own
  folders under `UserData`, and names are cleaned of path tricks.
- **Nothing about you is sent anywhere.** The update check asks GitHub for this project's newest release (no ids,
  no settings, a generic User-Agent; it can be turned off in **About & diagnostics**). The optional auto-translate
  sends Japanese names to the translation service you choose (Google, DeepL with your key, or a local AI).
  Diagnostics are only copied to your clipboard, with your Windows user name hidden.

The release isn't code-signed yet, so Windows asks before the first run. Only download it from this repository's
[Releases](../../releases).
