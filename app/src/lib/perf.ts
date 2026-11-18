/**
 * Tiny performance recorder: the last durations (ms) of hot paths, readable from the developer tools as
 * window.__kfPerf (the stress test reads it over the remote-debugging connection). Costs one array push.
 */
type Samples = Record<string, number[]>;

const samples: Samples = {};
(window as unknown as { __kfPerf: Samples }).__kfPerf = samples;

export function perfRecord(name: string, ms: number) {
  const a = samples[name] ?? (samples[name] = []);
  a.push(ms);
  if (a.length > 600) a.splice(0, a.length - 600);
}
