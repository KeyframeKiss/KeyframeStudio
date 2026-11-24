import { useRef, type ReactNode } from 'react';
import { openLibrary, setWorkspace, useStore } from '../state/store';
import { Icon } from './Icon';

const ISSUES = 'https://github.com/KeyframeKiss/KeyframeStudio/issues/new/choose';
const SECURITY = 'https://github.com/KeyframeKiss/KeyframeStudio/security/advisories/new';

const K = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;

interface Section {
  id: string;
  title: string;
  body: ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: (
      <>
        <ol>
          <li>
            Open <b>About &amp; diagnostics</b> and press <b>Install the bridge</b>. It finds your Koikatsu folder (or you choose it) and adds the
            small plugin that lets this app talk to CharaStudio.
          </li>
          <li>
            Start <b>CharaStudio</b>. The dot in the top bar turns green and says <b>Studio</b> when it's connected.
          </li>
          <li>Load a scene from <b>Library › Scenes</b> (<K>Ctrl O</K>) or from Studio itself.</li>
          <li>
            Pick a workspace along the top: <b>Animate</b>, <b>Pose</b>, <b>Look</b>, <b>Shoot</b> or <b>Library</b> (<K>Ctrl 1</K>–<K>5</K>).
          </li>
        </ol>
        <p>
          Can't find something? Press <K>Ctrl K</K> and type what you want to do. Every action is listed there.
        </p>
      </>
    ),
  },
  {
    id: 'first',
    title: 'Your first animation',
    body: (
      <>
        <ol>
          <li>Select a character, in Studio's view or the outliner, and open <b>Animate</b>.</li>
          <li>Pose it: click a joint in Studio's view and turn it on its rings, or drag a hand or foot target.</li>
          <li>
            Press <b>Key changes</b> in the bottom bar, or <K>K</K> with no tracks selected. Only what you changed gets a key.
          </li>
          <li>Move the playhead later (click the ruler, or type a time), change the pose and key again.</li>
          <li>
            Press <K>Space</K> to play. Drag keys to change the timing, and press <K>1</K>–<K>5</K> to change how they ease.
          </li>
        </ol>
        <p>
          <K>Tab</K> swaps the dope sheet for the graph editor, where you see and drag the actual curves. Rotations are shown in
          degrees.
        </p>
      </>
    ),
  },
  {
    id: 'habits',
    title: 'Good habits',
    body: (
      <ul className="help-habits">
        <li>
          <b>Save in Studio often.</b> Changes go into the open scene straight away, but they're only kept once you save the
          scene. Use Studio's Save, or <b>Save as new scene file</b> in the scene menu at the top left.
        </li>
        <li>
          <b>Block first, smooth later.</b> Key the main poses with <b>Step</b> easing (<K>5</K>) so you can judge the timing. Then
          switch to <b>In-out</b> (<K>2</K>) and add the in-between keys.
        </li>
        <li>
          <b>Use IK for planted hands and feet</b>, like a hand on a table or feet on the floor, and <b>FK for swings and arcs</b>. Each
          limb can use either one, and scenes reload the same way.
        </li>
        <li>
          <b>Feet sliding?</b> Animate › Cleanup › <b>Lock a foot or hand</b> keeps it on its spot over a time range while the body
          moves. <b>Check foot sliding</b> finds the slides, and each one has a <b>Lock</b> button.
        </li>
        <li>
          <b>Auto-key</b> (<K>R</K>) keys whatever you change as soon as you let go of the mouse. It's quick while you rough out
          poses. Turn it off when you only want to look around.
        </li>
        <li>
          <b>Keep big scenes tidy.</b> Put tracks in <b>Folders</b> (<K>Ctrl G</K>), search them with <K>Ctrl F</K>, and use the type
          filter to see only bones, faces or cameras.
        </li>
        <li>
          <b>Undo is safe.</b> <K>Ctrl Z</K> covers the timeline, the viewport handles, characters and looks. One drag is one undo
          step.
        </li>
        <li>
          <b>Short of screen space?</b> Mini mode (<K>Ctrl Shift M</K>) shrinks the app to just the timeline, kept on top of
          Studio.
        </li>
        <li>
          <b>Plan with shots.</b> In Shoot › Shots &amp; camera, keep each camera position as an <b>angle</b>, then drag angles onto the
          track to lay out the shots. With <b>Play the edit</b> on, the <b>monitor</b> and renders switch cameras at every cut (shots with camera keys play their keys), so you see the
          edit before you render, while Studio's own view stays your work camera. Turn on <b>In Studio's view too</b> to watch the edit in Studio's window. Click the marker at a cut on the track to glide, dip or dissolve into the next shot.
        </li>
        <li>
          <b>Test a render small first.</b> Tick <b>Draft</b> in Shoot › Render for a quick check of the timing, then render the
          full-quality one.
        </li>
      </ul>
    ),
  },
  {
    id: 'motion',
    title: 'Longer motions: the Motion builder',
    body: (
      <>
        <p>
          Animate › <b>Motion builder</b> strings Studio's animations, poses and your saved motion clips into one motion, blended
          into each other, for each character in the scene.
        </p>
        <ol>
          <li>
            Pick the character's lane, then <b>Add a clip</b>, <b>Add a pose</b> or <b>Add a motion clip</b>. Each new block goes on
            after the last one and blends in from it.
          </li>
          <li>
            Drag a block to move it, its right edge to change its length and its left edge to trim its start. Drag the ramp at
            its start to blend in more slowly. Edges snap to the other blocks, the playhead and the ends: hold <K>Shift</K> to
            drag freely.
          </li>
          <li>
            Click a block for its settings: speed, where in the clip it starts, the blend, <b>Feet planted</b>, <b>Mirror</b> (left
            and right swapped), <b>Replace</b>, <b>Duplicate</b> and <b>Remove</b>.
          </li>
          <li>
            <b>Feet planted</b> keeps a foot still while it's on the ground. Studio's walks and runs are on the spot, so with it on
            the character really walks or runs across the floor instead of sliding its feet back.
          </li>
        </ol>
        <ul>
          <li>
            Every change is built straight into ordinary keys in a <b>Motion</b> folder on the timeline, as one undo step. The
            blocks are saved with the scene.
          </li>
          <li>
            You can fine-tune those keys in the dope sheet or by posing and keying. Your edits stay with their block when the
            motion is built again (blocks with edits show ✎; <b>Clear them</b> in the block's settings).
          </li>
          <li>
            <b>Ripple</b> moves the blocks after one along when it gets longer, shorter or is removed. <K>←</K> <K>→</K> nudge the
            selected block a frame (<K>Shift</K>: ten), and <K>Ctrl</K> + the mouse wheel zooms.
          </li>
          <li>
            To have the motion happen somewhere else, move the character in Studio and press <b>Place here</b>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'render',
    title: 'Rendering a video',
    body: (
      <>
        <p>
          Shoot › <b>Render</b> plays the timeline and records it through the VideoExport plugin, with the scene's audio mixed in.
          Pick the whole timeline or your shots, the sizes, and press <b>Render</b>. Leave Studio alone until it finishes.
        </p>
        <ul>
          <li>
            <b>Recording: Straight to video</b> sends each frame into the video as it's drawn, so there's no wait for encoding at
            the end. <b>Image files</b> is VideoExport's own way, and keeps the frames if you want them. GIF and AVI always use
            image files.
          </li>
          <li>
            <b>Warm-up</b> lets hair and clothes settle before recording. <b>Quick</b> is enough for most scenes; <b>Play through</b>{' '}
            plays it all once first, so a looping animation joins up seamlessly.
          </li>
          <li>
            <b>Draft</b> renders much faster with slightly rougher edges. For MP4, <b>Balanced</b> encodes quickly, <b>Smallest
            files</b> takes longer for smaller files, and <b>GPU</b> uses your graphics card (offered when it works on your PC).
          </li>
          <li>
            Tick more than one size to get one video of each, each with its own framing. Videos are saved in VideoExport's
            output folder, named after the shot or size.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'viewport',
    title: "Posing in Studio's view",
    body: (
      <ul>
        <li>The skeleton, joints and handles are drawn over Studio's picture. They never show up in renders or stills.</li>
        <li>Click a joint, then drag one of its rings to turn it. The outer ring turns it around your view.</li>
        <li>
          Click the middle of a handle to switch between <b>Move</b>, <b>Rotate</b> and <b>Scale</b>, or rest the pointer on the
          middle to pick from a ring.
        </li>
        <li>Where markers overlap, rest the pointer on them. They fan out into labelled chips you can pick from.</li>
        <li>
          Hold <K>Ctrl</K> to snap and <K>Shift</K> for fine moves. Studio's camera holds still while you're over a handle.
        </li>
        <li>
          Choose what's drawn from the <b>View</b> button in the bottom bar: skeleton, IK targets, lights, cameras, motion paths
          and ghosts.
        </li>
      </ul>
    ),
  },
  {
    id: 'trouble',
    title: 'When something goes wrong',
    body: (
      <dl className="help-faq">
        <dt>The dot says Offline</dt>
        <dd>
          Check that CharaStudio is running and that <b>About &amp; diagnostics</b> shows the bridge as installed. After installing
          or updating the bridge, restart CharaStudio.
        </dd>
        <dt>“Update the bridge” in the top bar</dt>
        <dd>
          The plugin in Studio doesn't match this app. Open About &amp; diagnostics, press <b>Update the bridge</b> and restart
          CharaStudio. Always update the app and the bridge together.
        </dd>
        <dt>A feature is greyed out or says it's off</dt>
        <dd>
          It needs a mod you don't have, or a version it doesn't recognise. <b>About &amp; diagnostics</b> lists each feature, the mod
          it uses and why it's off.
        </dd>
        <dt>A message disappeared before you could read it</dt>
        <dd>
          Every message is kept in <b>Messages</b>, at the right of the status bar. Messages also stay up while the pointer is
          on them.
        </dd>
        <dt>A character won't play the animation you picked</dt>
        <dd>
          If its motion comes from the Motion builder, change it there: the timeline puts its own clip back. Bone keys also play
          over a clip where they're keyed, so mute them to see the clip on its own.
        </dd>
        <dt>Something moved further than you meant</dt>
        <dd>
          Press <K>Ctrl Z</K>; each drag is one step. If it keeps happening, please report it with diagnostics.
        </dd>
        <dt>Names are in Japanese</dt>
        <dd>
          Settings › <b>Translations</b> can translate them, and you can fix any name yourself.
        </dd>
        <dt>Windows warns about an unknown publisher</dt>
        <dd>
          The app isn't code-signed yet. Choose <b>More info › Run anyway</b>.
        </dd>
      </dl>
    ),
  },
  {
    id: 'report',
    title: 'Reporting a bug',
    body: (
      <>
        <ol>
          <li>
            In <b>About &amp; diagnostics</b>, press <b>Copy diagnostics</b>. It copies the versions, your plugins and recent logs, with
            your Windows user name hidden.
          </li>
          <li>Open a bug report on GitHub, paste the diagnostics, and say what you did and what happened.</li>
          <li>Screenshots help. Please keep them safe for work: crop or blur anything explicit.</li>
        </ol>
        <p>
          Found a security problem? Please don't post it publicly. Use{' '}
          <a href={SECURITY} target="_blank" rel="noreferrer">
            private reporting
          </a>{' '}
          instead.
        </p>
      </>
    ),
  },
  {
    id: 'files',
    title: 'Where your things are kept',
    body: (
      <ul>
        <li>
          <b>Scenes</b> stay where Studio keeps them, and animation is saved inside the scene by the Timeline plugin, so other people
          can open it without Keyframe Studio.
        </li>
        <li>
          <b>Presets</b> (looks, easings, faces, clips) are in <code>Koikatsu\UserData\StudioEX</code>.
        </li>
        <li>
          <b>App settings</b> and the bridge's key are in <code>%APPDATA%\studio-ex</code>. Updating the app keeps both of these.
        </li>
      </ul>
    ),
  },
];

/** Settings › Help & guide: getting started, a first animation, good habits, fixes, bug reports. */
export function HelpGuide() {
  const scroller = useRef<HTMLDivElement>(null);
  const jump = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`#help-${id}`);
    el?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  return (
    <div className="page">
      <div ref={scroller} className="page-inner narrow help-guide" style={{ padding: 20, overflow: 'auto' }}>
        <h2 className="page-title">Help &amp; guide</h2>
        <div className="help-actions">
          <button className="btn primary" onClick={() => setWorkspace('animate')}>
            <Icon name="animate" size={14} /> Start animating
          </button>
          <button className="btn solid" onClick={() => useStore.setState({ helpOpen: true })}>
            <Icon name="keyboard" size={14} /> Shortcuts
          </button>
          <button className="btn solid" onClick={() => openLibrary('about')}>
            <Icon name="pulse" size={14} /> About &amp; diagnostics
          </button>
          <a className="btn solid" href={ISSUES} target="_blank" rel="noreferrer">
            <Icon name="globe" size={14} /> Report a bug
          </a>
        </div>
        <nav className="help-toc" aria-label="On this page">
          {SECTIONS.map((s) => (
            <button key={s.id} className="help-toc-item" onClick={() => jump(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>
        {SECTIONS.map((s) => (
          <section key={s.id} id={`help-${s.id}`} className="help-section">
            <h3>{s.title}</h3>
            {s.body}
          </section>
        ))}
      </div>
    </div>
  );
}
