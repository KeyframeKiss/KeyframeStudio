import { checkForUpdates, compareVersions, setAutoUpdateCheck, skipUpdate, useNewerVersion, useUpdates } from '../lib/updates';
import { openLibrary, useStore } from '../state/store';
import { Icon } from './Icon';

/** The connected bridge's version against this app's: < 0 bridge older, > 0 bridge newer, 0 / null fine or unknown. */
function useBridgeGap(): { gap: number; bridge: string; app: string } | null {
  const plugin = useStore((s) => (s.status === 'open' ? s.hello?.plugin ?? null : null));
  const app = useUpdates((s) => s.appVersion);
  const gap = compareVersions(plugin, app);
  return gap && plugin && app ? { gap, bridge: plugin, app } : null;
}

/** Small header notices: a newer Keyframe Studio is out, or the bridge in Studio doesn't match this app. */
export function UpdateNotices() {
  const newer = useNewerVersion();
  const bridge = useBridgeGap();
  return (
    <>
      {bridge && (
        <button
          className="hdr-notice warn"
          onClick={() => openLibrary('about')}
          title={
            bridge.gap < 0
              ? `The bridge in CharaStudio is ${bridge.bridge}; this app is ${bridge.app}. Click, then “Update the bridge”, and restart CharaStudio.`
              : `The bridge in CharaStudio is ${bridge.bridge}, newer than this app (${bridge.app}). Download the matching app.`
          }
        >
          <Icon name="plug" size={13} />
          {bridge.gap < 0 ? 'Update the bridge' : 'App is older than the bridge'}
        </button>
      )}
      {newer && (
        <button
          className={`hdr-notice ${newer.security ? 'urgent' : ''}`}
          onClick={() => openLibrary('about')}
          title={`${newer.name ?? `Version ${newer.latest}`} is available (you have ${newer.current})${newer.security ? ' — it includes security fixes' : ''}. Click for details.`}
        >
          <Icon name="download" size={13} />
          {newer.latest} available
        </button>
      )}
    </>
  );
}

/** Release notes as short plain text: markdown marks removed, never rendered as HTML. */
function plain(md: string): string {
  return md
    .replace(/\r/g, '')
    .replace(/^>\s?\[!\w+\]\s*$/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** About & diagnostics › Updates: this version, the newest one, check now, check at start, skip. */
export function UpdatesCard() {
  const { info, checking, error, auto, skipped, appVersion } = useUpdates();
  const bridge = useBridgeGap();
  if (!window.studioEx?.checkUpdate) return null;
  const current = appVersion ?? info?.current ?? '…';
  const newer = info?.newer ? info : null;
  const notes = newer ? plain(newer.summary) : '';

  return (
    <section className={`diag-card update-card ${newer ? (newer.security ? 'urgent' : 'has-update') : ''}`}>
      <div className="bridge-setup-head">
        <b>Updates</b>
        <small>Asks the project's GitHub page for the newest release. Nothing about you or your scenes is sent.</small>
      </div>
      <div className="diag-row">
        <span>This version</span>
        <b>{current}</b>
      </div>
      <div className="diag-row">
        <span>Newest</span>
        <b>
          {checking
            ? 'Checking…'
            : error
              ? <span className="update-error">{error}</span>
              : !info?.latest
                ? 'Not checked yet'
                : newer
                  ? `${newer.latest} · ${when(newer.publishedAt)}${newer.security ? ' · security fixes' : ''}`
                  : `${info.latest} — you're up to date`}
        </b>
      </div>

      {newer && (
        <>
          {notes && <div className="update-notes">{notes}</div>}
          <div className="update-steps">
            <b>To update</b>
            <ol>
              <li>Download the new zip from the release page.</li>
              <li>Replace your Keyframe Studio folder with the new one.</li>
              <li>Update the bridge: copy its BepInEx folder into Koikatsu, or use “Update the bridge” above once the new app is running.</li>
              <li>Restart CharaStudio.</li>
            </ol>
          </div>
        </>
      )}
      {bridge && (
        <div className="update-steps warn">
          {bridge.gap < 0
            ? `The bridge in CharaStudio (${bridge.bridge}) is older than this app (${bridge.app}). Use “Update the bridge” above, then restart CharaStudio.`
            : `The bridge in CharaStudio (${bridge.bridge}) is newer than this app (${bridge.app}). Download the matching app from the release page.`}
        </div>
      )}

      <div className="diag-actions">
        {newer ? (
          <a className="btn primary" href={newer.url} target="_blank" rel="noreferrer">
            Open the download page
          </a>
        ) : (
          <button className="btn primary" disabled={checking} onClick={() => void checkForUpdates()}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
        {newer && (
          <button className="btn solid" disabled={checking} onClick={() => void checkForUpdates()}>
            Check again
          </button>
        )}
        {newer && newer.latest !== skipped && (
          <button className="btn solid" onClick={() => skipUpdate(newer.latest)} title="Stop showing this version in the header (it stays listed here)">
            Skip this version
          </button>
        )}
        <a className="btn solid" href={info?.releasesUrl ?? 'https://github.com/KeyframeKiss/KeyframeStudio/releases'} target="_blank" rel="noreferrer">
          All releases
        </a>
      </div>
      <label className="update-auto">
        <input type="checkbox" checked={auto} onChange={(e) => setAutoUpdateCheck(e.target.checked)} /> Check when the app starts (at most every 6 hours)
      </label>
    </section>
  );
}
