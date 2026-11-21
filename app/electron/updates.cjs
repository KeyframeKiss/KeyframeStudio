// Update check: asks GitHub for the project's newest release and compares it with this app's version.
// It runs here, in the main process, so the window's Content-Security-Policy can keep allowing only the local
// bridge. The request carries nothing about the user: no ids, no settings, a generic User-Agent.
const { app, net } = require('electron');

const REPO = 'KeyframeKiss/KeyframeStudio';
const RELEASES = `https://github.com/${REPO}/releases`;

/** "v0.1.2-beta" → [0, 1, 2]; null when it isn't a version. */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function check() {
  const current = app.getVersion();
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KeyframeStudio-update-check' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub is busy — try again later' : `GitHub answered ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('Unexpected answer from GitHub');
  let best = null;
  for (const r of list) {
    if (!r || r.draft) continue;
    const v = parse(r.tag_name);
    if (v && (!best || compare(v, best.v) > 0)) best = { v, r };
  }
  const cur = parse(current);
  const latest = best ? best.v.join('.') : null;
  // only ever hand the window a link into this project's releases
  const url = best && typeof best.r.html_url === 'string' && best.r.html_url.startsWith(RELEASES + '/') ? best.r.html_url : RELEASES;
  return {
    current,
    latest,
    newer: !!(best && cur && compare(best.v, cur) > 0),
    name: best ? String(best.r.name || best.r.tag_name).slice(0, 120) : null,
    publishedAt: best ? best.r.published_at || null : null,
    // the first lines of the notes, as plain text (the window shows them as text, never as HTML)
    summary: best && typeof best.r.body === 'string' ? best.r.body.slice(0, 1500) : '',
    security: !!(best && /\bsecurity\b/i.test(`${best.r.name} ${best.r.body}`)),
    url,
    releasesUrl: RELEASES,
  };
}

function register(ipcMain) {
  ipcMain.handle('update:check', () => check());
}

module.exports = { register, parse, compare };
