import { DOMAIN_HALF_SIZE } from './types';

/** Fast deterministic 2D value/gradient hash for terrain & thermal heterogeneity */
function hash2(ix: number, iz: number): number {
  let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295.0;
}

export function smoothNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uz = fz * fz * (3.0 - 2.0 * fz);

  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm2D(x: number, z: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    val += amp * (smoothNoise2D(x * freq, z * freq) * 2.0 - 1.0);
    freq *= 2.03;
    amp *= 0.5;
  }
  return val;
}

/**
 * Returns terrain elevation in meters at world coordinates (x, z) in [-16000, +16000].
 * Observer starts near (0, 5200) looking toward (0, -4000) across open plains & distant foothills.
 */
export function getTerrainHeight(x: number, z: number): number {
  // Distance from observer meadow at (0, 5200)
  const dxObs = x;
  const dzObs = z - 5200;
  const distObs = Math.hypot(dxObs, dzObs);

  // Gentle meadow undulations everywhere (2m - 14m)
  const meadow =
    6.5 * fbm2D(x * 0.00038 + 3.1, z * 0.00038 - 1.7, 3) +
    1.8 * smoothNoise2D(x * 0.0022, z * 0.0022);

  // Distant foothills (> 4.5 km away from observer, stronger toward northern/western horizon)
  const distFactor = Math.max(0, Math.min(1, (distObs - 3500) / 8500));
  const ridgeMask = Math.max(0, Math.min(1, (-z + 6000) / 16000));
  const hills =
    distFactor *
    distFactor *
    (95.0 + 195.0 * ridgeMask) *
    Math.max(0, 0.45 + 0.55 * fbm2D(x * 0.00016 - 2.4, z * 0.00016 + 4.2, 4));

  // Rim: a gentle rise around the *simulated* domain edge, so the ground does not simply stop
  // in a straight line.
  //
  // This is clamped to DOMAIN_HALF_SIZE-and-a-bit on purpose. The rendered terrain mesh reaches
  // out to TERRAIN_HALF_EXTENT (200 km), eight times further than the domain, so an unclamped
  // ramp on `edgeR` grew quadratically with distance and produced a 148 km tall terrain wall at
  // the horizon. That wall is the "white geometry artifacting" seen around the edges of the
  // simulation: thousands of near-vertical white triangles standing in the sky.
  //
  // The rim is therefore confined to a ring just outside the domain and faded out again beyond
  // it, so distant terrain is flat, hazed horizon rather than a skyscraper.
  const edgeR = Math.max(Math.abs(x), Math.abs(z)) / DOMAIN_HALF_SIZE;
  const rimBand = Math.max(0, Math.min(1, (edgeR - 0.82) / 0.18));
  // Fades back to zero over the next domain-width, so the mesh's outer rings sit at meadow level.
  const rimFade = 1.0 - Math.max(0, Math.min(1, (edgeR - 1.0) / 0.55));
  const rim = rimBand * rimBand * rimFade * 85.0;

  // Hard ceiling as a final safety net. Nothing in this scene is legitimately above the meadow
  // plus foothills; if a future term ever misbehaves, this keeps a single bad sample from
  // becoming a spike of white geometry that reaches into the cloud layer.
  return Math.max(0, Math.min(2500, 8.0 + meadow + hills + rim));
}

/**
 * Surface thermal heterogeneity [-1..+1]: dry sunlit patches warm faster under insolation,
 * seeding realistic boundary-layer convective thermals rather than arbitrary random spawns.
 *
 * This is the *geographic* component -- fixed soil, vegetation and albedo contrast. On its own it
 * made convection appear in the same places in every run, because it is the only thing the
 * nucleation search looked at and it never changes: the same fbm hotspots every session, forever.
 * That is exactly the "fixed patterns and fixed locations" behaviour, and it is not physical.
 *
 * Real surface heating is transient. Soil moisture left by earlier storms, cloud shadow drifting
 * across the boundary layer, and gustiness from the previous generation's outflow all move the
 * active hotspots on a timescale of tens of minutes. `getTransientThermalPotential` adds that
 * evolution; this function remains the static substrate it is modulated around.
 */
export function getSurfaceThermalPotential(x: number, z: number): number {
  return fbm2D(x * 0.00045 + 11.3, z * 0.00045 - 7.9, 3);
}

/**
 * Time-evolving surface thermal potential, in [-1..+1].
 *
 * The static field is advected with the boundary-layer flow and superimposed with a slower,
 * independently drifting field, so the pattern of favourable surface heating migrates the way a
 * real boundary layer does instead of being pinned to the terrain. The result is still a smooth
 * field of position and is fully deterministic for a given time, so a fixed seed remains
 * reproducible.
 *
 * `driftX`/`driftZ` should be the boundary-layer wind displacement in metres; `phase` is any
 * monotonically increasing time in seconds.
 */
export function getTransientThermalPotential(
  x: number,
  z: number,
  driftX: number,
  driftZ: number,
  phase: number
): number {
  // Advected static field: the soil-moisture pattern moves with the wind.
  const ax = x - driftX;
  const az = z - driftZ;
  const advected = getSurfaceThermalPotential(ax, az);

  // A second, slower field that drifts on its own. Its wavelength is much longer, so it modulates
  // *regions* of the domain (one valley warm, the next cool) rather than individual cells.
  const slowX = (x * 0.00016 + phase * 0.0000068);
  const slowZ = (z * 0.00016 - phase * 0.0000041);
  const regional = fbm2D(slowX + 3.7, slowZ - 1.2, 2);

  // Gustiness: fine-scale, fast-moving ripples from the previous generation's outflow settling
  // out. Small amplitude, but it is what stops every nucleation from picking a round number of
  // kilometres.
  const gust = fbm2D(x * 0.0011 - phase * 0.0009, z * 0.0011 + phase * 0.0007, 2) * 0.18;

  return Math.max(-1, Math.min(1, advected * 0.68 + regional * 0.34 + gust));
}
