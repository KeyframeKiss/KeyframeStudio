// Shared test harness for the live Keyframe Studio suites: one WebSocket connection to the bridge plugin,
// request helpers, checks, cleanups and a "fresh Studio" reset so every suite starts from the same state.
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

export class Studio {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return; // binary preview frames
      const m = JSON.parse(e.data);
      if (m.event) {
        this.events.push(m);
        if (this.events.length > 5000) this.events.splice(0, 1000);
        for (const fn of this.listeners) fn(m);
        return;
      }
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.resolve({ ok: false, error: 'connection closed' });
      this.pending.clear();
    };
  }

  /** Connects, retrying until the bridge answers and Studio/Timeline are ready (Studio may still be starting). */
  static async connect({ url = 'ws://127.0.0.1:47615', timeoutMs = 180000, log = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    let warned = false;
    for (;;) {
      try {
        const ws = await new Promise((res, rej) => {
          const w = new WebSocket(url);
          w.onopen = () => res(w);
          w.onerror = () => rej(new Error('connect failed'));
        });
        const s = new Studio(ws);
        for (;;) {
          const a = await s.req('scene.get');
          if (a.ok) return s;
          if (Date.now() > deadline) throw new Error('Studio did not become ready');
          await sleep(2000);
        }
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`Can't reach the Keyframe Studio bridge at ${url} — is CharaStudio running with the plugin?`);
        if (!warned) log('Waiting for CharaStudio…');
        warned = true;
        await sleep(3000);
      }
    }
  }

  req(cmd, args = {}, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `${cmd}: no answer in ${timeoutMs / 1000}s` });
      }, timeoutMs);
      if (this.ws.readyState !== 1) {
        clearTimeout(timer);
        resolve({ ok: false, error: `${cmd}: not connected to CharaStudio` });
        return;
      }
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  async ok(cmd, args, timeoutMs) {
    const r = await this.req(cmd, args, timeoutMs);
    if (!r.ok) throw new Error(`${cmd}: ${r.error}`);
    return r.result;
  }

  /** Last value of an event since `since` (index into events), or undefined. */
  last(name, since = 0) {
    for (let i = this.events.length - 1; i >= since; i--) if (this.events[i].event === name) return this.events[i].data;
    return undefined;
  }

  waitFor(name, pred = () => true, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`timed out waiting for "${name}"`));
      }, timeoutMs);
      const fn = (m) => {
        if (m.event !== name || !pred(m.data)) return;
        clearTimeout(timer);
        this.listeners.delete(fn);
        resolve(m.data);
      };
      this.listeners.add(fn);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Puts Studio in a known state: auto-key off, playback stopped, an empty scene and no leftover scene-wide
 * tracks (Studio's "new scene" keeps those). Called before every suite.
 */
export async function freshStudio(studio) {
  await studio.req('timeline.setAutoKey', { on: false });
  await studio.req('timeline.stop');
  await studio.ok('scene.new');
  await sleep(1200);
  const tl = await studio.req('timeline.get');
  if (tl.ok && tl.result.tracks.length) await studio.req('timeline.removeTracks', { tracks: tl.result.tracks.map((t) => t.id) });
  await studio.req('timeline.resetPose');
}

/** The context a suite receives: checks, helpers and cleanups. */
export function makeContext(studio, hello) {
  const results = { pass: 0, fail: 0, failures: [], skipped: null, lines: [], metrics: [] };
  const cleanups = [];
  const say = (line) => results.lines.push(line);
  const t = {
    studio,
    hello,
    paths: hello.paths ?? { game: 'D:\\Games\\Koikatsu', userData: 'D:\\Games\\Koikatsu\\UserData' },
    req: (c, a, ms) => studio.req(c, a, ms),
    ok: (c, a, ms) => studio.ok(c, a, ms),
    sleep,
    near,
    results,
    say,
    /** Record a measurement (always printed by the runner). */
    metric(label, value, unit = 'ms') {
      results.metrics.push({ label, value, unit });
      return value;
    },
    /** Record a check. */
    check(label, cond, detail = '') {
      if (cond) results.pass++;
      else {
        results.fail++;
        results.failures.push(detail ? `${label} — ${detail}` : label);
      }
      say(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  ' + detail : ''}`);
      return !!cond;
    },
    /** Run a group of checks; an exception fails the group instead of the whole suite. */
    async step(label, fn) {
      try {
        await fn();
      } catch (e) {
        if (e.skip) throw e;
        t.check(`${label}`, false, `threw: ${e.message}`);
      }
    },
    /** Register a cleanup; they run last-in first-out after the suite, even when it fails. */
    defer(fn) {
      cleanups.push(fn);
    },
    skip(reason) {
      results.skipped = reason;
      const e = new Error(reason);
      e.skip = true;
      throw e;
    },
    /** Whether a feature is usable with the installed mods (see Library › About & diagnostics). */
    has(featureId) {
      const f = hello.features?.find((x) => x.id === featureId);
      return !f || f.status === 'ok' || f.status === 'untested';
    },
    /** Skip the whole suite when a feature isn't usable with the installed mods. */
    needs(featureId) {
      const f = hello.features?.find((x) => x.id === featureId);
      if (!t.has(featureId)) t.skip(`${f.label}: ${f.reason}`);
    },
    file: (...parts) => path.join(...parts),
    /** Load the sample scene and select its character. */
    async loadSample() {
      const scenes = await studio.ok('scene.list');
      const sample = scenes.find((s) => /sample_00\.png$/i.test(s.rel)) ?? scenes[0];
      if (!sample) t.skip('no scenes in UserData\\studio\\scene');
      await studio.ok('scene.load', { path: sample.path });
      let scene;
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        scene = await studio.ok('scene.get');
        if (scene.nodes.length) break;
      }
      await sleep(1500);
      const chara = scene.nodes.find((n) => n.type === 'Char');
      if (chara) {
        await studio.ok('scene.select', { ids: [chara.id] });
        await sleep(1000); // KKPE attaches its editors on selection
      }
      return {
        scene,
        chara,
        items: scene.nodes.filter((n) => n.type === 'Item'),
        light: scene.nodes.find((n) => n.type === 'Light'),
      };
    },
  };
  return { t, cleanups };
}
