import { ACCENTS, setAppearance, useAppearance, type ThemeChoice } from '../lib/theme';
import { Page, Section } from './Page';

// Settings › Appearance: theme and accent. Each choice shows a small picture of the app in that look; the previews
// carry their own colours on purpose (they show a theme other than the one in use).
const PREVIEW: Record<'dark' | 'light', { bg: string; panel: string; line: string; text: string; sub: string }> = {
  dark: { bg: '#111216', panel: '#17181d', line: '#2b2e37', text: '#e8eaf0', sub: '#7d828f' },
  light: { bg: '#e9ebf0', panel: '#f5f6f8', line: '#d3d6de', text: '#16181e', sub: '#626876' },
};

function MiniApp({ look, accent }: { look: 'dark' | 'light'; accent: string }) {
  const p = PREVIEW[look];
  return (
    <span className="ap-mini" style={{ background: p.bg, borderColor: p.line }} aria-hidden="true">
      <span className="ap-mini-top" style={{ background: p.panel, borderColor: p.line }}>
        <i style={{ background: accent }} />
        <i style={{ background: p.sub }} />
        <i style={{ background: p.sub }} />
      </span>
      <span className="ap-mini-body">
        <span className="ap-mini-side" style={{ background: p.panel, borderColor: p.line }}>
          <i style={{ background: p.text }} />
          <i style={{ background: p.sub }} />
          <i style={{ background: p.sub }} />
        </span>
        <span className="ap-mini-main">
          <i style={{ background: p.sub }} />
          <i style={{ background: accent, width: '45%' }} />
          <i style={{ background: p.sub, width: '70%' }} />
        </span>
      </span>
    </span>
  );
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match Windows' },
];

export function AppearancePage() {
  const { theme, accent, resolved } = useAppearance();
  const accentHex = (look: 'dark' | 'light') => ACCENTS.find((a) => a.id === accent)![look];
  return (
    <Page max={900}>
      <Section title="Theme" help="Dark suits a dim room and a second monitor beside Studio. Match Windows follows your Windows setting, and changes with it.">
        <div className="ap-themes" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => {
            const look = t.id === 'system' ? resolved : t.id;
            return (
              <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className={`ap-theme ${theme === t.id ? 'on' : ''}`} onClick={() => setAppearance({ theme: t.id })}>
                {t.id === 'system' ? (
                  <span className="ap-split">
                    <MiniApp look="dark" accent={accentHex('dark')} />
                    <MiniApp look="light" accent={accentHex('light')} />
                  </span>
                ) : (
                  <MiniApp look={look} accent={accentHex(look)} />
                )}
                <b>{t.label}</b>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Accent" help="The colour for what's on, selected or next to do: switches, the playhead's tag, primary buttons.">
        <div className="ap-accents" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={accent === a.id} className={`ap-accent ${accent === a.id ? 'on' : ''}`} onClick={() => setAppearance({ accent: a.id })}>
              <i style={{ background: a[resolved] }} />
              {a.label}
            </button>
          ))}
        </div>
      </Section>
    </Page>
  );
}
