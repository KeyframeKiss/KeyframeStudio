/**
 * Production templates: a scene's staging without its characters (timeline length and frame rate, shots and
 * their cameras, look, lighting rigs, render settings, audio). No UI and no app imports — the bridge request
 * function is passed in, so the live tests run exactly this code.
 */
export type Request = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TemplateData {
  version: 1;
  timeline?: { duration: number; fps: number; speed: number };
  shots?: Record<string, unknown>[];
  look?: Record<string, unknown>;
  rigs?: string[];
  render?: Record<string, unknown>;
  /** Older templates: the one audio clip. */
  audio?: AudioClip;
  /** Every audio clip. */
  audioClips?: AudioClip[];
}
type AudioClip = { file: string; offset: number; volume: number; muted: boolean };
/** A template's audio clips, old (one clip) or new. */
const clipsOf = (d: TemplateData): AudioClip[] => d.audioClips ?? (d.audio ? [d.audio] : []);

export const TEMPLATE_PARTS = [
  { id: 'timeline', label: 'Timeline length & frame rate' },
  { id: 'shots', label: 'Shots and their cameras' },
  { id: 'look', label: 'Look (effects, toon, lights)' },
  { id: 'rigs', label: 'Lighting rigs (on the selected characters)' },
  { id: 'render', label: 'Render settings' },
  { id: 'audio', label: 'Audio clips' },
] as const;
export type TemplatePart = (typeof TEMPLATE_PARTS)[number]['id'];
export const ALL_PARTS = new Set<TemplatePart>(TEMPLATE_PARTS.map((p) => p.id));

/** Read the current scene's staging. Parts whose plugin isn't there (e.g. no VideoExport) are left out. */
export async function gatherTemplate(req: Request): Promise<TemplateData> {
  const quiet = <T,>(cmd: string) => req<T>(cmd).catch(() => undefined);
  const [tl, shots, look, rigs, render, audio] = await Promise.all([
    quiet<{ duration: number; fps: number; speed: number }>('timeline.state'),
    quiet<Record<string, unknown>[]>('shots.get'),
    quiet<Record<string, unknown>>('look.get'),
    quiet<{ name: string }[]>('light.sceneRigs'),
    quiet<{ settings: Record<string, unknown> }>('render.status'),
    quiet<{ clips?: AudioClip[] }>('audio.get'),
  ]);
  const data: TemplateData = { version: 1 };
  if (tl && tl.duration > 0) data.timeline = { duration: tl.duration, fps: tl.fps, speed: tl.speed ?? 1 };
  if (shots?.length) data.shots = shots;
  if (look) data.look = { effects: look.effects, toon: look.toon, lights: look.lights };
  if (rigs?.length) data.rigs = [...new Set(rigs.map((r) => r.name))];
  if (render?.settings) data.render = render.settings;
  if (audio?.clips?.length) data.audioClips = audio.clips.map((c) => ({ file: c.file, offset: c.offset, volume: c.volume, muted: c.muted }));
  return data;
}

/** Put a template's parts into the current scene. `chars`: the characters that get the lighting rigs. */
export async function applyTemplate(req: Request, d: TemplateData, parts: Set<TemplatePart>, chars: number[]): Promise<{ done: string[]; problems: string[] }> {
  const done: string[] = [],
    problems: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      if (!done.includes(label)) done.push(label);
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message}`);
    }
  };
  if (parts.has('timeline') && d.timeline) await step('timeline', () => req('timeline.setSettings', d.timeline));
  if (parts.has('shots') && d.shots) await step('shots', () => req('shots.set', { shots: d.shots }));
  if (parts.has('look') && d.look) await step('look', () => req('look.set', d.look));
  if (parts.has('rigs') && d.rigs?.length) {
    if (!chars.length) problems.push('lighting rigs: select the characters to light first');
    else for (const rig of d.rigs) for (const id of chars) await step('lighting rigs', () => req('light.applyRig', { id, rig }));
  }
  if (parts.has('render') && d.render) await step('render settings', () => req('render.set', d.render));
  const clips = clipsOf(d);
  if (parts.has('audio') && clips.length)
    await step('audio', async () => {
      // the template's clips replace the scene's
      await req('audio.clear');
      for (const a of clips) {
        const r = await req<{ clips: { id: number }[] }>('audio.add', { file: a.file, offset: a.offset });
        const id = r.clips[r.clips.length - 1].id;
        await req('audio.set', { id, volume: a.volume, muted: a.muted });
      }
    });
  return { done, problems };
}

export const templateSummary = (d: TemplateData) =>
  [
    d.timeline && `${d.timeline.duration.toFixed(1)}s @ ${d.timeline.fps} fps`,
    d.shots?.length && `${d.shots.length} shot${d.shots.length > 1 ? 's' : ''}`,
    d.look && 'look',
    d.rigs?.length && `${d.rigs.length} rig${d.rigs.length > 1 ? 's' : ''}`,
    d.render && 'render',
    clipsOf(d).length && (clipsOf(d).length > 1 ? `${clipsOf(d).length} audio clips` : 'audio'),
  ]
    .filter(Boolean)
    .join(' · ');
