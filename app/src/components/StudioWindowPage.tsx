import { setStudioUi, useStudioUi } from '../state/studioUi';
import { useStore } from '../state/store';
import { Help } from './Help';
import { Switch } from './LookPanel';

/** Settings › Studio window: how CharaStudio's own window looks while Keyframe Studio drives it. */
export function StudioWindowPage() {
  const ui = useStudioUi((s) => s.ui);
  const status = useStore((s) => s.status);
  return (
    <div className="page">
      <div className="page-inner narrow" style={{ padding: 20, overflow: 'auto' }}>
        <h2 className="page-title">
          Studio window
          <Help text="Hide CharaStudio's menus so its window is just the picture, and do the editing here. Everything comes back by itself when Keyframe Studio closes or loses the connection." />
        </h2>
        {!ui ? (
          <div className="hint">{status === 'open' ? 'This bridge version can’t do this yet — restart CharaStudio with the latest plugin.' : 'Connect to CharaStudio first.'}</div>
        ) : (
          <div className="look-card">
            <div className="look-card-body sw-rows">
              <Row title="Clean Studio window" help="Hides Studio's menus, the object list and other plugins' panels (KKPE, MaterialEditor…). The camera still works with the mouse in Studio's window. Also in the header (the eye button) and Ctrl+K.">
                <Switch on={ui.clean} onChange={(v) => setStudioUi({ clean: v })} />
              </Row>
              <Row title="Keep Timeline's window" help="Timeline's own window stays while clean. Off hides it too — the dope sheet here does the same job.">
                <Switch on={ui.timeline} onChange={(v) => setStudioUi({ timeline: v })} />
              </Row>
              <Row title="Keep move / rotate handles" help="The gizmos on the selected object in Studio's viewport. Off gives a clean picture; you can still move things from here.">
                <Switch on={ui.handles} onChange={(v) => setStudioUi({ handles: v })} />
              </Row>
              {ui.hideAllUi && (
                <Row title="Use HideAllUI" help="HideAllUI is installed: let it do the hiding (its Space hotkey keeps working). Off uses Keyframe Studio's own, which also catches panels plugins open later.">
                  <Switch on={ui.useHideAllUi} onChange={(v) => setStudioUi({ useHideAllUi: v })} />
                </Row>
              )}
              <div className="sw-foot">
                Done by <b>{ui.provider}</b>
                {ui.clean && ui.hidden > 0 && <span> · {ui.hidden} hidden</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <div className="sw-row">
      <span>
        {title}
        <Help text={help} />
      </span>
      {children}
    </div>
  );
}
