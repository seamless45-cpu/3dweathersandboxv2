/**
 * Verifies that the surface thermal potential used for nucleation is *time-evolving* rather than
 * a fixed geographic pattern. A static field ranks candidate sites identically at every time, which
 * is what made convection appear in the same places in every run.
 */
import { getSurfaceThermalPotential, getTransientThermalPotential } from '../src/sim/terrainField';

const HALF = 24000;
// Representative boundary-layer wind, ~8 m/s.
const U = 8, W = 4;

function hotspotsAt(tSec: number): Array<{ x: number; z: number; v: number }> {
  const out: Array<{ x: number; z: number; v: number }> = [];
  const driftX = U * tSec;
  const driftZ = W * tSec;
  for (let z = -HALF; z < HALF; z += 2000) {
    for (let x = -HALF; x < HALF; x += 2000) {
      out.push({ x, z, v: getTransientThermalPotential(x, z, driftX, driftZ, tSec) });
    }
  }
  return out;
}
function staticAt(): Array<{ x: number; z: number; v: number }> {
  const out: Array<{ x: number; z: number; v: number }> = [];
  for (let z = -HALF; z < HALF; z += 2000)
    for (let x = -HALF; x < HALF; x += 2000) out.push({ x, z, v: getSurfaceThermalPotential(x, z) });
  return out;
}

function topSites(sites: Array<{ x: number; z: number; v: number }>, n: number) {
  return [...sites].sort((a, b) => b.v - a.v).slice(0, n);
}

const stat = staticAt();
console.log('Static field (what nucleation used to see):');
const st = topSites(stat, 5);
for (const s of st) console.log(`   (${s.x}, ${s.z})  v=${s.v.toFixed(3)}`);
const staticSpread = Math.max(...stat.map((s) => s.v)) - Math.min(...stat.map((s) => s.v));
console.log(`   value spread = ${staticSpread.toFixed(3)}`);

console.log('\nTransient field at successive times:');
const times = [0, 900, 1800, 2700, 3600];
const topSets: Array<Set<string>> = [];
for (const t of times) {
  const sites = hotspotsAt(t);
  const top = topSites(sites, 5);
  topSets.push(new Set(top.map((s) => `${s.x},${s.z}`)));
  const spread = Math.max(...sites.map((s) => s.v)) - Math.min(...sites.map((s) => s.v));
  console.log(`   t=${String(t).padStart(4)}s  best=(${top[0].x},${top[0].z}) v=${top[0].v.toFixed(3)}  spread=${spread.toFixed(3)}`);
}

// How much do successive hotspot sets overlap? If the field is static they are identical.
let overlapSum = 0;
let pairs = 0;
for (let i = 1; i < topSets.length; i++) {
  let inter = 0;
  for (const k of topSets[i]) if (topSets[i - 1].has(k)) inter++;
  overlapSum += inter / 5;
  pairs++;
}
const overlap = overlapSum / pairs;
console.log(`\nhotspot-set overlap between successive samples: ${(overlap * 100).toFixed(0)}%`);
console.log(overlap < 0.6 ? '  -> nucleation sites MOVE over time  OK' : '  -> sites are pinned  FAIL');

// Same-position temporal change: a fixed point should see its potential vary as the field moves.
const probe = { x: 6000, z: -4000 };
const series = times.map((t) => getTransientThermalPotential(probe.x, probe.z, U * t, W * t, t));
const range = Math.max(...series) - Math.min(...series);
console.log(`\nfixed point (${probe.x}, ${probe.z}) across 1 h:`);
console.log(`   values = ${series.map((v) => v.toFixed(2)).join(', ')}`);
console.log(`   range  = ${range.toFixed(3)}  ${range > 0.15 ? 'OK (varies)' : 'too static'}`);
