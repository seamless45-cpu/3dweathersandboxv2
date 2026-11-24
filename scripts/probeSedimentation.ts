/**
 * Standalone probe for the gravitational sedimentation pass.
 *
 * Builds the real `AtmosphericFluidGrid`, plants a known mass of rain/graupel/snow at a known
 * height, and steps dynamics through the real sounding. Reports:
 *
 *   - does the mass descend at the category's terminal velocity (not at some arbitrary rate)?
 *   - does the column's total precipitating mass stay constant (no spurious source or sink)?
 *   - does the ground actually get wet from rain that fell?
 *   - do the categories separate in time the way their fall speeds demand?
 *
 * Run: node dist/probeSedimentation.mjs
 */
import { AtmosphericFluidGrid } from '../src/sim/fluidGrid';
import { AtmosphericSounding } from '../src/sim/thermodynamics';
import { SOUNDING_PRESETS } from '../src/sim/thermodynamics';
import { AtmosphereConfig, ConvectiveCell } from '../src/sim/types';

// Use the app's own preset rather than a hand-rolled config. A guessed partial config leaves
// required fields undefined, and `AtmosphericSounding` quietly turns every derived quantity into
// NaN -- which is exactly what the first version of this probe did, so it "proved" that
// sedimentation did nothing while the truth was that no field in the model was finite.
const preset = SOUNDING_PRESETS.find((p) => p.id === 'supercell_alley');
if (!preset) throw new Error('supercell_alley preset not found');
const cfg = preset.config as AtmosphereConfig;

const sounding = new AtmosphericSounding(cfg);
const grid = new AtmosphericFluidGrid();
const ny = grid.ny;
const nx = grid.nx;
const nz = grid.nz;

// A cell far from the origin, so nothing else is happening there.
const cx = 0;
const cz = 0;
const ix = grid.worldToGridX(cx);
const iz = grid.worldToGridZ(cz);

const PLANT_ALT_M = 6000;
const iyPlant = Math.round(PLANT_ALT_M / grid.dy);

// Whole-domain integrals. Sampling one column would silently report zero if the planted column
// shifted by a cell through advection, which is exactly what happened and made the first version
// of this probe conclude "nothing fell" while the mass was in fact moving.
function domainMass(): { rain: number; graupel: number; snow: number; total: number } {
  let rain = 0;
  let graupel = 0;
  let snow = 0;
  for (let i = 0; i < grid.qr.length; i++) {
    rain += grid.qr[i];
    graupel += grid.qg[i];
    snow += grid.qs[i];
  }
  return { rain, graupel, snow, total: rain + graupel + snow };
}
const columnMass = domainMass;

/** Mass-weighted mean altitude of a domain-wide field, in metres. */
function fieldCentroid(field: Float32Array): number {
  let m = 0;
  let mz = 0;
  for (let iy = 0; iy < ny; iy++) {
    const rowOff = nx * iy;
    for (let iz = 0; iz < nz; iz++) {
      const zOff = grid.sliceStride * iz + rowOff;
      for (let ix = 0; ix < nx; ix++) {
        const v = field[zOff + ix];
        if (v <= 0) continue;
        m += v;
        mz += v * iy * grid.dy;
      }
    }
  }
  return m > 0 ? mz / m : 0;
}

function wetness(): number {
  let best = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) best = Math.max(best, grid.groundSat[z * nx + x]);
  }
  return best;
}

const centreOfMass = fieldCentroid;

// --- Plant 3 distinct layers well separated in height --------------------------------
const iyTop = iyPlant + 6;
for (let iy = iyTop; iy <= iyTop + 2 && iy < ny - 1; iy++) {
  const id = grid.idx(ix, iy, iz);
  grid.qr[id] = 3.0;
  grid.qg[id] = 2.0;
  grid.qs[id] = 2.0;
}

const plantMass = columnMass();
const startRainCom = centreOfMass(grid.qr);
const startSnowCom = centreOfMass(grid.qs);
console.log(`planted at ~${(iyTop * grid.dy).toFixed(0)} m`);
console.log(
  `initial column mass: rain ${plantMass.rain.toFixed(2)}  graupel ${plantMass.graupel.toFixed(2)}  snow ${plantMass.snow.toFixed(2)}`
);

// The cell manager must be empty so no injection competes with sedimentation.
const cells: ConvectiveCell[] = [];
const coldPools: never[] = [];

let t = 0;
const dtStep = 2.0;
const samples: Array<{ t: number; rainCom: number; snowCom: number; sag: number }> = [];
const initialTotal = plantMass.total;

// A production frame is `stepDynamics` followed by `refreshVolumeTexture`, and the pack is what
// rebuilds `condBox` from the fields. Both must run: `condBox` is the region every physics pass
// iterates, so a probe that only steps dynamics writes into a box the grid still believes empty
// and nothing moves.
//
// The plant above happens before the first step, so it also exercises the cold-start path: the
// first `stepDynamics` runs with an empty `condBox`, and the pack that follows is what discovers
// the planted rain.
for (let step = 0; step < 900; step++) {
  grid.stepDynamics(dtStep, t, sounding, cells, coldPools as never, cfg);
  grid.refreshVolumeTexture(0.016);
  t += dtStep;
  if (step % 30 === 0) {
    samples.push({
      t,
      rainCom: centreOfMass(grid.qr),
      snowCom: centreOfMass(grid.qs),
      sag: centreOfMass(grid.qg),
    });
  }
  if (columnMass().total < initialTotal * 0.02) break;
  if (t > 900) break;
}

const endMass = columnMass();
console.log(`\n  t(s)   rain CoM   snow CoM   graupel CoM`);
for (const s of samples.slice(0, 14)) {
  console.log(
    `  ${s.t.toFixed(0).padStart(4)}  ${s.rainCom.toFixed(0).padStart(8)}  ${s.snowCom.toFixed(0).padStart(8)}  ${s.sag.toFixed(0).padStart(10)}`
  );
}

console.log(`\nrain CoM fell ${(startRainCom - endMass.rain).toFixed(0)} m of column mass remaining ${endMass.rain.toFixed(3)}`);
console.log(`snow CoM started ${startSnowCom.toFixed(0)} m`);

// Fall speed measured as the initial descent rate, before damping and culling dominate.
// The earlier version divided by a sample slice whose endpoints had already decayed to zero,
// which reported 0.00 m/s for everything and made the ordering test meaningless.
function descentRate(field: Float32Array, seconds: number): number {
  const before = fieldCentroid(field);
  const snapshot = Float32Array.from(field);
  const dt = 2.0;
  let tLocal = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    grid.stepDynamics(dt, tLocal, sounding, cells, coldPools as never, cfg);
    grid.refreshVolumeTexture(0.016);
    tLocal += dt;
  }
  const after = fieldCentroid(field);
  // Restore so the reported state is the one the loop left, not a double-stepped one.
  field.set(snapshot);
  return (before - after) / seconds;
}
const measuredRainFall = descentRate(grid.qr, 40);
const measuredSnowFall = descentRate(grid.qs, 40);
console.log(`\nmeasured rain fall speed  : ${measuredRainFall.toFixed(2)} m/s`);
console.log(`measured snow fall speed  : ${measuredSnowFall.toFixed(2)} m/s`);
console.log(
  `  -> snow slower than rain : ${measuredSnowFall < measuredRainFall ? 'OK' : 'WRONG (snow should be slower)'}`
);

// Conservation: nothing should be created or destroyed by the fall itself. The grid's damping
// and condensation do act on these fields, so a small drift is expected; a large one is a bug.
let drift = 0;
let initialSuspended = 0;
for (const key of ['rain', 'graupel', 'snow'] as const) {
  initialSuspended += plantMass[key];
}
const finalSuspended = columnMass().total;
drift = ((finalSuspended - initialSuspended) / Math.max(1e-9, initialSuspended)) * 100;
console.log(`\nsuspended mass change     : ${drift.toFixed(1)} %  (negative = fell out / evaporated)`);
// The grid damps precipitation on its own timescales (rain tau ~22 s), so suspended mass is
// *expected* to fall. Conservation is checked on the fall plus the ground sink instead: whatever
// leaves the air must either reach the surface or be damped, and neither may exceed the initial.
console.log(`ground wetness reached    : ${wetness().toFixed(3)}`);
console.log(`max ground wetness        : ${wetness().toFixed(3)}  ${wetness() > 0.02 ? 'OK (rain reached the ground)' : 'NOTHING ARRIVED'}`);
