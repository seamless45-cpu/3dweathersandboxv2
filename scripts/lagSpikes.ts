/**
 * Lag-spike probe (dev tool).
 *
 * The bench reports a single mean per-frame cost, which cannot distinguish "this build is slower"
 * from "this build hitches every twelfth frame". Those are very different experiences, and the
 * second one is what users report as lag spikes, so this tool reports the distribution directly:
 *
 *   - percentiles over the whole run, so p95/p99 outliers are visible next to the median;
 *   - the same percentiles in warm-up buckets, which separates real regressions from JIT
 *     compile cost (the first few hundred frames are always slow and always will be);
 *   - the worst frames by index, so a spike can be reproduced in isolation.
 *
 * A healthy build has a p95 close to its p50: physics that costs roughly the same every frame.
 * A build where p50 is 0.6 ms and p95 is 40 ms is one that stalls, however good its mean looks.
 *
 * Usage: node scripts/runLagSpikes.mjs [frames] [preset] [simSpeed]
 *        (scripts/runLagSpikes.mjs bundles this file and runs it under Node)
 */
import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
import { SOUNDING_PRESETS } from '../src/sim/thermodynamics';
import type { AtmosphereConfig } from '../src/sim/types';

const frames = Number(process.argv[2] ?? 3600);
const presetId = process.argv[3] ?? 'supercell_alley';
const simSpeed = Number(process.argv[4] ?? 12);

const preset = SOUNDING_PRESETS.find((p) => p.id === presetId);
const coord = new AtmosphereSimulationCoordinator(
  preset ? (preset.config as Partial<AtmosphereConfig>) : {}
);

const times: number[] = [];
for (let f = 0; f < frames; f++) {
  const t0 = process.hrtime.bigint();
  coord.step(1 / 60, simSpeed, false, 0, 5200);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

console.log(`preset=${presetId} frames=${frames} speed=${simSpeed}x`);

const pct = (arr: number[], q: number): number =>
  arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;

// Warm-up buckets. The first ~600 frames pay for JIT compilation of the solver's inner loops and
// are not representative of steady state; they are reported separately rather than being allowed
// to inflate the headline numbers (or hidden, which would hide a real regression).
const edges = [0, 200, 600, 1200, frames].filter((e) => e < frames);
if (edges[edges.length - 1] !== frames) edges.push(frames);
console.log('\nframe range      p50     p90     p95     p99     max');
for (let i = 0; i < edges.length - 1; i++) {
  const a = times.slice(edges[i], edges[i + 1]).sort((x, y) => x - y);
  if (!a.length) continue;
  const label = `f${edges[i]}-${edges[i + 1]}`.padEnd(15);
  console.log(
    `${label} ${pct(a, 0.5).toFixed(2).padStart(7)} ${pct(a, 0.9).toFixed(2).padStart(7)} ` +
      `${pct(a, 0.95).toFixed(2).padStart(7)} ${pct(a, 0.99).toFixed(2).padStart(7)} ` +
      `${a[a.length - 1].toFixed(1).padStart(7)}`
  );
}

const all = [...times].sort((x, y) => x - y);
const mean = times.reduce((s, t) => s + t, 0) / Math.max(1, times.length);
console.log(
  `\nwhole run: mean=${mean.toFixed(2)}ms  p50=${pct(all, 0.5).toFixed(2)}  ` +
    `p95=${pct(all, 0.95).toFixed(2)}  p99=${pct(all, 0.99).toFixed(2)}  max=${all[all.length - 1].toFixed(1)}`
);

const worst = times
  .map((ms, f) => ({ f, ms }))
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 5);
console.log('worst frames:', worst.map((w) => `f${w.f}=${w.ms.toFixed(1)}ms`).join(' '));

// A p95 far above p50 means the simulation stutters rather than merely being slow.
const ratio = pct(all, 0.5) > 0 ? pct(all, 0.95) / pct(all, 0.5) : 0;
console.log(
  `spike ratio p95/p50 = ${ratio.toFixed(1)}x ` +
    (ratio > 12 ? '(hitching: cost is concentrated in a few frames)' : '(even: cost is spread across frames)')
);
