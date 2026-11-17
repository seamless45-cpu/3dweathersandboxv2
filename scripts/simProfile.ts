/**
 * Headless per-subsystem profiler (dev tool). Mirrors AtmosphereSimulationCoordinator.step
 * but times each subsystem separately so optimisation work can be targeted.
 *
 * Usage: node scripts/runSimProfile.mjs [seconds] [presetId] [simSpeed]
 */
import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
import { SOUNDING_PRESETS } from '../src/sim/thermodynamics';
import type { AtmosphereConfig } from '../src/sim/types';

const seconds = Number(process.argv[2] ?? 30);
const presetId = process.argv[3] ?? '';
const simSpeed = Number(process.argv[4] ?? 12);

const preset = SOUNDING_PRESETS.find((p) => p.id === presetId);
const coordinator = new AtmosphereSimulationCoordinator(preset ? (preset.config as Partial<AtmosphereConfig>) : {});

const timers = {
  cells: 0,
  grid: 0,
  electrification: 0,
  lightning: 0,
  observer: 0,
};
const counts = { cells: 0, grid: 0, electrification: 0, lightning: 0 };

const FRAME_DT = 1 / 60;
const frames = Math.round(seconds * 60);
let wall = 0;

for (let f = 0; f < frames; f++) {
  const totalSimDt = FRAME_DT * simSpeed;
  const subSteps = Math.max(1, Math.min(12, Math.ceil(totalSimDt / 2.5)));
  const subDt = totalSimDt / subSteps;

  let t0 = process.hrtime.bigint();
  for (let s = 0; s < subSteps; s++) {
    coordinator.simTimeSec += subDt;
    coordinator.cellManager.step(subDt, coordinator.simTimeSec, coordinator.sounding, coordinator.config);
  }
  let t1 = process.hrtime.bigint();
  timers.cells += Number(t1 - t0) / 1e6;
  counts.cells += subSteps;

  t0 = process.hrtime.bigint();
  coordinator.grid.stepFluidAndCondensate(
    totalSimDt,
    coordinator.simTimeSec,
    coordinator.sounding,
    coordinator.cellManager.cells,
    coordinator.cellManager.coldPools,
    coordinator.config
  );
  t1 = process.hrtime.bigint();
  timers.grid += Number(t1 - t0) / 1e6;
  counts.grid++;

  t0 = process.hrtime.bigint();
  const candidates = coordinator.electrification.step(
    totalSimDt,
    coordinator.grid,
    coordinator.sounding,
    coordinator.cellManager.cells,
    coordinator.config
  );
  t1 = process.hrtime.bigint();
  timers.electrification += Number(t1 - t0) / 1e6;
  counts.electrification++;

  t0 = process.hrtime.bigint();
  coordinator.lightning.step(
    totalSimDt,
    FRAME_DT * 1000,
    coordinator.simTimeSec,
    candidates,
    coordinator.grid,
    coordinator.sounding,
    coordinator.cellManager.cells,
    coordinator.electrification
  );
  t1 = process.hrtime.bigint();
  timers.lightning += Number(t1 - t0) / 1e6;
  counts.lightning++;

  wall += (timers.cells + timers.grid + timers.electrification + timers.lightning) / (f + 1);
}

const perFrame = (v: number) => (v / frames).toFixed(2);
console.log(`frames=${frames} simSpeed=${simSpeed}x cells=${coordinator.cellManager.cells.length} pools=${coordinator.cellManager.coldPools.length}`);
console.log('mean ms per rendered frame:');
for (const [k, v] of Object.entries(timers)) {
  if (k === 'observer') continue;
  const calls = counts[k as keyof typeof counts] ?? frames;
  console.log(`  ${k.padEnd(15)} ${perFrame(v).padStart(7)} ms/frame   (${(v / calls).toFixed(3)} ms/call x ${calls} calls)`);
}
const total = timers.cells + timers.grid + timers.electrification + timers.lightning;
console.log(`  ${'TOTAL'.padEnd(15)} ${perFrame(total).padStart(7)} ms/frame  -> ${Math.round(1000 / (total / frames))} fps ceiling`);
