/**
 * Headless physics benchmark harness (dev tool, not part of the shipped bundle).
 *
 * Runs the atmospheric coordinator for a fixed number of virtual frames with no
 * rendering and reports timing plus the physical state, so simulation changes can
 * be compared for both CPU cost and meteorological sanity.
 *
 * Usage: node scripts/runSimBench.mjs [seconds] [preset]
 */
import { AtmosphereSimulationCoordinator } from '../src/sim/atmosphereCoordinator';
import { SOUNDING_PRESETS } from '../src/sim/thermodynamics';
import type { AtmosphereConfig } from '../src/sim/types';

const seconds = Number(process.argv[2] ?? 90);
const presetId = process.argv[3] ?? '';
const simSpeed = Number(process.argv[4] ?? 12);

const preset = SOUNDING_PRESETS.find((p) => p.id === presetId);
const config: Partial<AtmosphereConfig> = preset ? preset.config : {};

const coordinator = new AtmosphereSimulationCoordinator(config);
const inst = coordinator.sounding.instability;

console.log(
  `preset=${preset ? preset.id : 'default'} simSpeed=${simSpeed}x frames=${Math.round(seconds * 60)}\n` +
    `CAPE=${inst.cape.toFixed(0)} J/kg CIN=${inst.cin.toFixed(0)} LCL=${inst.lcl.toFixed(0)}m ` +
    `LFC=${inst.lfc.toFixed(0)}m EL=${inst.el.toFixed(0)}m shear=${inst.bulkShear06km.toFixed(1)}m/s ` +
    `SRH=${inst.srh03km.toFixed(0)} freeze=${inst.freezingLevel.toFixed(0)}m PW=${inst.precipitableWaterMM.toFixed(1)}mm`
);

const FRAME_DT = 1 / 60;
const frames = Math.round(seconds * 60);

const physTimes: number[] = [];
let peakRain = 0;
let peakUpdraft = 0;
let peakCFL = 0;
let peakDiv = 0;
let firstCloudFrame = -1;
let firstPrecipFrame = -1;
let firstFlashFrame = -1;
let peakObserverRain = 0;
const stageCounts = new Map<string, number>();
const typeCounts = new Map<string, number>();

for (let f = 0; f < frames; f++) {
  const t0 = process.hrtime.bigint();
  coordinator.step(FRAME_DT, simSpeed, false, 0, 5200);
  const t1 = process.hrtime.bigint();
  physTimes.push(Number(t1 - t0) / 1e6);

  const snap = coordinator.getTelemetrySnapshot();
  if (snap.maxSurfaceRainMMHr > peakRain) peakRain = snap.maxSurfaceRainMMHr;
  if (snap.observerRainMMHr > peakObserverRain) peakObserverRain = snap.observerRainMMHr;
  if (snap.maxUpdraftMS > peakUpdraft) peakUpdraft = snap.maxUpdraftMS;
  if (snap.validation.maxCFL > peakCFL) peakCFL = snap.validation.maxCFL;
  if (snap.validation.massContinuityResidual > peakDiv) peakDiv = snap.validation.massContinuityResidual;
  if (firstCloudFrame < 0 && snap.activeCellCount > 0) firstCloudFrame = f;
  if (firstPrecipFrame < 0 && snap.maxSurfaceRainMMHr > 0.5) firstPrecipFrame = f;
  if (firstFlashFrame < 0 && snap.totalFlashes > 0) firstFlashFrame = f;

  for (const c of snap.cells) {
    stageCounts.set(c.stage, (stageCounts.get(c.stage) ?? 0) + 1);
    if (c.precipType !== 'None') typeCounts.set(c.precipType, (typeCounts.get(c.precipType) ?? 0) + 1);
  }
}

const sorted = [...physTimes].sort((a, b) => a - b);
const sum = physTimes.reduce((a, b) => a + b, 0);
const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const finalSnap = coordinator.getTelemetrySnapshot();

console.log(`\n--- physics cost per frame (${frames} frames) ---`);
console.log(`mean=${(sum / frames).toFixed(2)}ms p50=${pct(0.5).toFixed(2)}ms p95=${pct(0.95).toFixed(2)}ms p99=${pct(0.99).toFixed(2)}ms max=${sorted[sorted.length - 1].toFixed(2)}ms`);
console.log(`implied fps ceiling (physics only): ${Math.round(1000 / Math.max(0.0001, sum / frames))}`);

console.log('\n--- timeline (sim minutes) ---');
console.log(
  `firstVisibleCell=${firstCloudFrame < 0 ? 'never' : ((firstCloudFrame * FRAME_DT * simSpeed) / 60).toFixed(1)}min ` +
    `firstPrecip=${firstPrecipFrame < 0 ? 'never' : ((firstPrecipFrame * FRAME_DT * simSpeed) / 60).toFixed(1)}min ` +
    `firstFlash=${firstFlashFrame < 0 ? 'never' : ((firstFlashFrame * FRAME_DT * simSpeed) / 60).toFixed(1)}min`
);

console.log('\n--- peak state ---');
console.log(`maxUpdraft=${peakUpdraft.toFixed(1)} m/s  maxSurfaceRain=${peakRain.toFixed(1)} mm/h  observerRain=${peakObserverRain.toFixed(1)} mm/h`);
console.log(`maxCFL=${peakCFL.toFixed(3)}  maxDivResidual=${peakDiv.toExponential(2)} s^-1  waterDrift=${finalSnap.validation.waterConservationDriftPct.toFixed(3)}%`);
console.log(`flashes=${finalSnap.totalFlashes} tles=${finalSnap.totalTLEs} cloudCover=${finalSnap.domainCloudCoverPct.toFixed(1)}% organization=${finalSnap.organization}`);
console.log(`meanCloudWater=${finalSnap.meanCloudWaterGKg.toFixed(2)} g/kg meanIce=${finalSnap.meanIceGKg.toFixed(2)} meanGraupelHail=${finalSnap.meanGraupelHailGKg.toFixed(2)}`);
console.log(`maxE=${finalSnap.maxElectricFieldKVm.toFixed(1)} kV/m breakdownRatio=${finalSnap.maxBreakdownRatio.toFixed(2)}`);

console.log('\n--- cell stage histogram (cell-frames) ---');
for (const [k, v] of [...stageCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('--- precip type histogram ---');
for (const [k, v] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

console.log('\n--- final cells ---');
for (const c of finalSnap.cells) {
  console.log(
    `  ${c.id} ${c.stage} age=${(c.ageSec / 60).toFixed(1)}min top=${(c.cloudTopM / 1000).toFixed(1)}km base=${(c.cloudBaseM / 1000).toFixed(1)}km ` +
      `w=${c.updraftMaxMS.toFixed(1)} down=${c.downdraftMaxMS.toFixed(1)} cw=${c.cloudWaterGKg.toFixed(2)} slw=${c.supercooledWaterGKg.toFixed(2)} ` +
      `ice=${c.cloudIceGKg.toFixed(2)} snow=${c.snowGKg.toFixed(2)} gr=${c.graupelGKg.toFixed(2)} hail=${c.hailGKg.toFixed(2)} rain=${c.rainGKg.toFixed(3)} ` +
      `R=${c.surfaceRainRateMMHr.toFixed(1)}mm/h ${c.precipType} virga=${c.virgaFraction.toFixed(2)} zeta=${c.mesocycloneVorticity.toFixed(4)}`
  );
}
