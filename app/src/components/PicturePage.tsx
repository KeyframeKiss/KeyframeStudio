import type { ReactNode } from 'react';
import { Help } from './Help';
import { Page, Section } from './Page';
import { LookPanel } from './LookPanel';
import { EffectsPage } from './EffectsPage';
import { bridge } from '../bridge/client';
import { call, showTab } from '../state/store';

/**
 * Look › Picture: everything that shapes the final picture, grouped by what it does rather than by who provides it.
 * Studio's own settings and Keyframe Studio's effects sit side by side, each card tagged with where it comes from.
 * Lights live under Lighting; materials under Materials.
 */
export function PicturePage() {
  return (
    <Page max={1400}>
      <div className="look-page-bar">
        <span style={{ flex: 1 }} />
        <Help text="Changes show in Studio right away, are undoable (Ctrl+Z) and are saved with the scene. Cards tagged Studio are Studio's own settings; Keyframe Studio's effects run after them, and ◆ beside a value adds a Timeline track for it." />
        <button
          className="btn solid"
          title="Studio's settings back to Studio's default look (undoable)"
          onClick={() => call('look.resetDefault').then((r) => r !== undefined && window.dispatchEvent(new Event('studioex:look-changed')))}
        >
          Reset Studio settings
        </button>
        <button className="btn solid" title="Turn every Keyframe Studio effect off and back to its starting values" onClick={() => bridge.request('fx.reset').then(() => window.dispatchEvent(new Event('kf:history')))}>
          Reset effects
        </button>
        <button className="btn solid" title="Save these settings as a look you can apply to other scenes" onClick={() => showTab('look', 'presets')}>
          Save as a look…
        </button>
      </div>
      <Group title="Colour" help="The picture's overall colour, tone and glow">
        <LookPanel cards={['lut', 'bloom']} />
        <EffectsPage only={['grade']} />
      </Group>
      <Group title="Lens" help="What the camera does: focus, darkened corners, colour fringes, sharpness and film grain">
        <LookPanel cards={['dof', 'vignette']} />
        <EffectsPage only={['dof', 'vignette', 'aberration', 'sharpen', 'grain']} />
      </Group>
      <Group title="Atmosphere" help="The air between the camera and the scene, and contact shadows">
        <LookPanel cards={['fog', 'sun', 'ssao']} />
        <EffectsPage only={['fog']} />
      </Group>
      <Group title="Characters" help="How characters are shaded: toon ramp, shadow colour, outlines">
        <LookPanel cards={['toon']} />
      </Group>
      <EffectsPage only={['xukmi']} />
    </Page>
  );
}

function Group({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <Section title={title} help={help}>
      <div className="pic-cards">{children}</div>
    </Section>
  );
}
