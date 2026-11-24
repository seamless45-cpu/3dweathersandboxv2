/**
 * Guards the terrain height field against out-of-range values.
 *
 * The rendered ground reaches out to 200 km while the simulated domain is only 24 km in radius,
 * and a rim term scaled on the *domain* radius grew quadratically with distance: at the mesh
 * edge it returned 148 km. That produced thousands of near-vertical white triangles standing in
 * the sky around the simulation -- the "white geometry artifacting" that read as a rendering bug
 * but was really an arithmetic one. This test samples the same coordinate ramp the mesh uses and
 * fails if any vertex leaves the physical envelope.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { build } = await import('esbuild').catch(() => ({ build: null }));
if (!build) {
  console.error('esbuild is required for this test');
  process.exit(1);
}
const outfile = path.join(root, 'dist', 'terrainField.test.mjs');
await build({
  entryPoints: [path.join(root, 'src', 'sim', 'terrainField.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'error',
});
const { getTerrainHeight } = await import(`file://${outfile}`);

// Mirror src/render/terrainRenderer.ts buildTerrainCoords exactly.
const innerHalf = 24000 + 2000;
const innerStep = 250;
const outerHalf = 200000;
const pos = [];
for (let x = 0; x <= innerHalf + 1e-6; x += innerStep) pos.push(x);
let cur = pos[pos.length - 1];
let step = innerStep;
while (cur < outerHalf) {
  step *= 1.32;
  cur += step;
  pos.push(Math.min(cur, outerHalf));
  if (cur >= outerHalf) break;
}
const coords = pos.slice(1).reverse().map((v) => -v).concat(pos);

// The highest legitimate feature is a foothill; 2500 m is the documented hard ceiling and
// anything approaching it is already suspicious.
const LIMIT = 2500;
let failures = 0;
let maxSeen = -Infinity;
let maxAt = null;
for (const x of coords) {
  for (const z of coords) {
    const h = getTerrainHeight(x, z);
    if (!Number.isFinite(h)) {
      if (failures++ < 5) console.error(`non-finite height at (${x}, ${z}): ${h}`);
      continue;
    }
    if (h > maxSeen) { maxSeen = h; maxAt = [x, z]; }
    if (h < 0) {
      if (failures++ < 5) console.error(`negative height at (${x}, ${z}): ${h}`);
    }
  }
}
if (maxSeen > LIMIT) {
  console.error(`terrain exceeds ${LIMIT} m with a maximum of ${maxSeen.toFixed(1)} m at (${maxAt})`);
  failures++;
}

if (failures) {
  console.error(`\n${failures} terrain bound failure(s)`);
  process.exit(1);
}
console.log(`\nterrain bounds OK — ${coords.length ** 2} mesh vertices, max height ${maxSeen.toFixed(1)} m`);
