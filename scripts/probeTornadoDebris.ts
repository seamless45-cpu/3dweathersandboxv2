/**
 * Standalone check of the tornado debris kinematics.
 *
 * The renderer integrates particle motion in the vortex's own velocity field with drag + gravity,
 * and those trajectories are invisible to every other test in the repo (no WebGL here). This
 * re-implements the same integrator on the same constants and reports what a viewer would see:
 *
 *   - does the field hold a *distribution* in radius, or collapse to a point?
 *   - does it loft, and how much of it reaches the cloud base?
 *   - does heavy debris sit further out than dust (centrifugal sorting)?
 *   - does anything go non-finite or get stranded?
 *
 * Run: node dist/probeTornadoDebris.mjs
 */

const GRAVITY = 9.80665;
function smoothstep01(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const DEBRIS_COUNT = 640;

interface Params {
  windMS: number;
  radiusM: number;
  heightM: number;
}

function makeField(seed0: number) {
  let seed = seed0;
  const rnd = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 1) | 0;
    return ((seed ^ (seed >>> 13)) >>> 0) / 4294967296;
  };
  const angle = new Float32Array(DEBRIS_COUNT);
  const radius = new Float32Array(DEBRIS_COUNT);
  const height = new Float32Array(DEBRIS_COUNT);
  const vr = new Float32Array(DEBRIS_COUNT);
  const vz = new Float32Array(DEBRIS_COUNT);
  const size = new Float32Array(DEBRIS_COUNT);
  const kind = new Float32Array(DEBRIS_COUNT);
  const opacity = new Float32Array(DEBRIS_COUNT);
  const spin = new Float32Array(DEBRIS_COUNT);
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    angle[i] = rnd() * Math.PI * 2;
    const u = rnd();
    radius[i] = 0.16 + u * u * 1.55;
    height[i] = Math.pow(rnd(), 1.7);
    size[i] = 0.5 + rnd() * rnd() * 5.5;
    kind[i] = rnd() < 0.16 ? 1 : 0;
    opacity[i] = 0.35 + rnd() * 0.5;
    spin[i] = rnd() * Math.PI * 2;
  }
  return { angle, radius, height, vr, vz, size, kind, opacity, spin };
}

/** Mirrors TornadoRenderer.stepDebris, including the constants. */
function step(f: ReturnType<typeof makeField>, p: Params, dt: number): void {
  const vMax = Math.min(62, p.windMS);
  const TAU_LIGHT = 0.16;
  const TAU_HEAVY = 0.48;
  const coreR = Math.max(28, Math.min(420, p.radiusM));

  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const heavy = f.kind[i] > 0.5;
    const tau = heavy ? TAU_HEAVY : TAU_LIGHT;

    const rn = Math.max(0.04, f.radius[i]);
    const hFrac = f.height[i];

    const vt = rn <= 1 ? vMax * rn : vMax * Math.pow(1 / rn, 0.6);

    const coreFrac = Math.exp(-rn * rn * 2.6);
    const heightFalloff = 1 - smoothstep01(0.06, 0.58, hFrac);
    const updraft = vMax * 0.85 * coreFrac * heightFalloff;

    const surfaceLayer = Math.exp(-hFrac * 5);
    const airRadial = -0.55 * vMax * 0.014 * surfaceLayer;

    const radiusM = Math.max(8, rn * coreR);
    const aCent = (vt * vt) / radiusM;
    const centrifugal = Math.min(1.1, tau * aCent * (heavy ? 1.0 : 0.12));

    const coreRadiusM = Math.max(8, coreR);
    const vrTarget = airRadial + centrifugal;
    f.vr[i] += (vrTarget - f.vr[i]) * Math.min(1, dt / Math.max(0.05, tau));
    f.radius[i] = Math.max(0.03, Math.min(3.4, rn + (f.vr[i] * dt) / coreRadiusM));

    const dvz = ((updraft - f.vz[i]) / tau - GRAVITY) * dt;
    f.vz[i] += dvz;
    f.vz[i] = Math.max(-55, Math.min(45, f.vz[i]));
    f.height[i] += (f.vz[i] * dt) / Math.max(120, p.heightM);

    const rNow = f.radius[i];
    const hNow = f.height[i];
    if (
      !Number.isFinite(rNow) ||
      !Number.isFinite(hNow) ||
      !Number.isFinite(f.vz[i]) ||
      hNow < -0.01 ||
      rNow > 3.2
    ) {
      f.height[i] = 0;
      f.vz[i] = 0;
      f.vr[i] = 0;
      f.radius[i] = 0.1 + (i % 17) * 0.004;
    }

    const omega = (vt / radiusM) * 0.3;
    f.angle[i] += omega * dt;
    if (f.angle[i] > Math.PI * 2) f.angle[i] -= Math.PI * 2;
  }
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[idx];
}

function report(label: string, p: Params): void {
  const f = makeField(2654435761);
  const dt = 1 / 60;

  // 60 s to reach a steady distribution.
  for (let s = 0; s < 60 * 60; s++) step(f, p, dt);

  const allR: number[] = [];
  const dustR: number[] = [];
  const heavyR: number[] = [];
  const heights: number[] = [];
  let nonFinite = 0;
  let aloft = 0;
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    if (!Number.isFinite(f.radius[i]) || !Number.isFinite(f.height[i])) nonFinite++;
    allR.push(f.radius[i]);
    heights.push(Math.max(0, Math.min(1.6, f.height[i])));
    if (f.height[i] > 0.25) aloft++;
    if (f.kind[i] > 0.5) heavyR.push(f.radius[i]);
    else dustR.push(f.radius[i]);
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const meanDust = mean(dustR);
  const meanHeavy = mean(heavyR);

  // Orbital vs rendered radius, and where the heavy material ends up.
  let hAlive = 0;
  let hAliveR = 0;
  let dAlive = 0;
  let dAliveR = 0;
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    if (f.height[i] < 0.2) continue;
    if (f.kind[i] > 0.5) { hAlive++; hAliveR += f.radius[i]; }
    else { dAlive++; dAliveR += f.radius[i]; }
  }
  const dustAloft = dAlive ? dAliveR / dAlive : 0;
  const heavyAloft = hAlive ? hAliveR / hAlive : 0;
  // A field, not a point: the radius must actually be spread out.
  const spread = pct(allR, 0.9) - pct(allR, 0.1);

  console.log(`\n${label}  (wind ${p.windMS.toFixed(0)} m/s, Rmw ${p.radiusM.toFixed(0)} m)`);
  console.log(`  radius p10/50/90 (Rmw) : ${pct(allR, 0.1).toFixed(2)} / ${pct(allR, 0.5).toFixed(2)} / ${pct(allR, 0.9).toFixed(2)}`);
  console.log(`  radius spread p10-p90  : ${spread.toFixed(2)}  ${spread > 0.35 ? 'OK (a field)' : 'DEGENERATE (a clump)'}`);
  console.log(`  height p50/p90 (frac)  : ${pct(heights, 0.5).toFixed(2)} / ${pct(heights, 0.9).toFixed(2)}`);
  console.log(`  fraction lofted > 0.25 : ${((aloft / DEBRIS_COUNT) * 100).toFixed(0)} %`);
  console.log(`  mean R dust vs heavy   : ${meanDust.toFixed(2)} vs ${meanHeavy.toFixed(2)}  ${meanHeavy > meanDust ? 'OK (heavy outside)' : 'WRONG ORDER'}`);
  console.log(`  aloft R dust vs heavy  : ${dustAloft.toFixed(2)} vs ${heavyAloft.toFixed(2)}  ${heavyAloft > dustAloft ? 'OK' : 'still inverted'}`);
  console.log(`  alive aloft d/h        : ${dAlive} / ${hAlive}`);
  const dustH = heights.filter((_, i) => f.kind[i] <= 0.5);
  const heavyH = heights.filter((_, i) => f.kind[i] > 0.5);
  console.log(`  mean h dust vs heavy   : ${mean(dustH).toFixed(2)} vs ${mean(heavyH).toFixed(2)}  ${mean(dustH) > mean(heavyH) ? 'OK (dust higher)' : 'inverted'}`);
  console.log(`  non-finite particles   : ${nonFinite}`);
  console.log(`  mean revolution rate   : ${(mean(f.angle as unknown as number[]) / (Math.PI * 2)).toFixed(2)} rad-ish`);
}

report('EF0 spin-up', { windMS: 22, radiusM: 260, heightM: 900 });
report('EF1', { windMS: 42, radiusM: 200, heightM: 1100 });
report('EF3', { windMS: 68, radiusM: 150, heightM: 1300 });
report('EF5', { windMS: 96, radiusM: 120, heightM: 1400 });
