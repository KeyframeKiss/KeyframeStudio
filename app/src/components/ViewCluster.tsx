import { useState } from 'react';
import { Icon } from './Icon';
import { Popover } from './Shell';
import { PathsGhostsOptions, PathsGhostsToggles } from './ViewportControls';
import { OverlayOptions, OverlayToggles } from './ViewportOverlays';

type Tab = 'overlays' | 'paths';
const TAB_KEY = 'kf.viewTab';
const readTab = (): Tab => {
  try {
    return localStorage.getItem(TAB_KEY) === 'paths' ? 'paths' : 'overlays';
  } catch {
    return 'overlays';
  }
};

/**
 * What's drawn in Studio's view, in one compact group: motion paths, ghosts, overlays and handles as icon toggles,
 * with one options menu for all four.
 */
export function ViewCluster() {
  const [tab, setTab] = useState<Tab>(readTab);
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="view-cluster" role="group" aria-label="Shown in Studio's view">
      <span className="vc-label">View</span>
      <PathsGhostsToggles />
      <span className="vc-sep" />
      <OverlayToggles />
      <Popover
        align="right"
        width={310}
        trigger={(open, toggle) => (
          <button className={`btn icon vc-more ${open ? 'on' : ''}`} title="Options for paths, ghosts, overlays and handles" onClick={toggle}>
            <Icon name="chevronDown" size={11} />
          </button>
        )}
      >
        <div className="seg vc-tabs">
          <button className={tab === 'overlays' ? 'on' : ''} onClick={() => pick('overlays')}>
            Overlays &amp; handles
          </button>
          <button className={tab === 'paths' ? 'on' : ''} onClick={() => pick('paths')}>
            Paths &amp; ghosts
          </button>
        </div>
        {tab === 'overlays' ? <OverlayOptions /> : <PathsGhostsOptions />}
      </Popover>
    </div>
  );
}
