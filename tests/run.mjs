#!/usr/bin/env node
// Live test runner: drives a running CharaStudio through the Keyframe Studio bridge plugin.
//
//   node tests/run.mjs                 run every suite
//   node tests/run.mjs face timeline   run suites whose name contains any of the words
//   node tests/run.mjs --list          list suites
//   options: --yes (don't ask before replacing the open scene), --verbose (print every check)
//
// Every suite starts from an empty scene (see freshStudio) and cleans up any files it creates, so suites
// can run alone or in any order. The scene open in Studio is replaced: save your work first.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Studio, freshStudio, makeContext } from './lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const words = args.filter((a) => !a.startsWith('--')).map((w) => w.toLowerCase());
const verbose = flags.has('--verbose');
const SUITE_TIMEOUT = 300000;

const files = fs
  .readdirSync(path.join(here, 'suites'))
  .filter((f) => f.endsWith('.mjs'))
  .sort();
const suites = [];
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(here, 'suites', f)).href);
  suites.push({ file: f, name: mod.name ?? f.replace(/\.mjs$/, ''), run: mod.default, optIn: !!mod.optIn });
}
// opt-in suites (e.g. the slow stress test) only run when named
const chosen = words.length ? suites.filter((s) => words.some((w) => s.file.toLowerCase().includes(w) || s.name.toLowerCase().includes(w))) : suites.filter((s) => !s.optIn);

if (flags.has('--list')) {
  for (const s of suites) console.log(`${s.file.padEnd(28)} ${s.name}${s.optIn ? '  (only when named)' : ''}`);
  process.exit(0);
}
if (!chosen.length) {
  console.log(`No suite matches: ${words.join(' ')}  (use --list)`);
  process.exit(1);
}

const color = process.stdout.isTTY ? (c, s) => `\x1b[${c}m${s}\x1b[0m` : (_c, s) => s;
const green = (s) => color(32, s),
  red = (s) => color(31, s),
  dim = (s) => color(2, s),
  yellow = (s) => color(33, s);

async function confirm() {
  if (flags.has('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.log('The tests replace the scene open in CharaStudio. Re-run with --yes to confirm.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question('The tests replace the scene open in CharaStudio (save your work first). Continue? [y/N] ', r));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

if (!(await confirm())) process.exit(1);

const studio = await Studio.connect({ log: (m) => console.log(dim(m)) }).catch((e) => {
  console.log(red(e.message));
  process.exit(1);
});
const hello = await studio.ok('hello');
console.log(`Keyframe Studio bridge ${hello.plugin} · Unity ${hello.unity} · ${chosen.length} suite${chosen.length > 1 ? 's' : ''}`);
for (const f of hello.features ?? []) if (f.status === 'off' || f.status === 'untested') console.log(yellow(`  ${f.status}: ${f.label} — ${f.reason}`));
console.log('');

// suites change the timeline's length and frame rate: put them back afterwards
const timelineBefore = await studio.ok('timeline.state').catch(() => null);
const summary = [];
const started = Date.now();
for (const s of chosen) {
  const t0 = Date.now();
  const { t, cleanups } = makeContext(studio, hello);
  let crashed = null;
  let timer;
  try {
    await freshStudio(studio);
    // A pending suite can still send commands and write files. Stop the process before cleanup or another reset.
    timer = setTimeout(() => {
      console.error(`${s.name} timed out after ${SUITE_TIMEOUT / 1000}s. Run stopped. Test files and scene settings may need cleanup.`);
      studio.close();
      process.exit(1);
    }, SUITE_TIMEOUT);
    await s.run(t);
  } catch (e) {
    if (!e.skip) crashed = e;
  } finally {
    clearTimeout(timer);
  }
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch (e) {
      t.check('cleanup', false, e.message);
    }
  }
  if (crashed) t.check('suite ran to the end', false, crashed.message);
  const r = t.results;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.skipped) console.log(`${yellow('–')} ${s.name} ${dim(`skipped: ${r.skipped}`)}`);
  else if (r.fail === 0) console.log(`${green('✔')} ${s.name} ${dim(`${r.pass} checks · ${secs}s`)}`);
  else {
    console.log(`${red('✘')} ${s.name} ${dim(`${r.pass} passed · ${secs}s`)} ${red(`${r.fail} failed`)}`);
    for (const f of r.failures) console.log(red(`    ✘ ${f}`));
  }
  for (const m of r.metrics) console.log(`    ${m.label.padEnd(52)} ${typeof m.value === 'number' ? (Math.round(m.value * 10) / 10).toLocaleString('en-US') : m.value} ${m.unit}`);
  if (verbose) for (const l of r.lines) console.log(dim(`    ${l}`));
  summary.push({ name: s.name, ...r });
}

await freshStudio(studio).catch(() => {});
if (timelineBefore) await studio.ok('timeline.setSettings', { duration: timelineBefore.duration, fps: timelineBefore.fps }).catch(() => {});
studio.close();
const pass = summary.reduce((n, s) => n + s.pass, 0);
const fail = summary.reduce((n, s) => n + s.fail, 0);
const skipped = summary.filter((s) => s.skipped).length;
const bad = summary.filter((s) => s.fail > 0).length;
console.log('');
console.log(
  `${bad ? red(`${bad} of ${summary.length} suites failed`) : green(`All ${summary.length - skipped} suites passed`)} · ${pass} checks passed${fail ? `, ${red(fail + ' failed')}` : ''}${skipped ? `, ${skipped} skipped` : ''} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
process.exit(bad ? 1 : 0);
