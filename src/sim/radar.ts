import type { AtmosphericFluidGrid } from './fluidGrid';
import { AtmosphericSounding } from './thermodynamics';
import { DOMAIN_HALF_SIZE, DOMAIN_MAX_ALT, PHYS } from './types';

/**
 * Weather radar: a physically-based reflectivity product derived from the model's own
 * condensate fields.
 *
 * ## What this is not
 *
 * A radar picture is not a picture of the cloud. It is a measurement of the sixth moment of
 * the hydrometeor size distribution, integrated along a beam, attenuated on the way out and
 * back, and then quantised by a receiver. Getting those four things in the right order is what
 * makes the result look like radar rather than like a weather map: the bright ring around the
 * radar, the notch behind a hail core, the speckle at the edge of the echo, and the way the
 * lowest elevation sweeps show ground clutter while the upper ones show the anvil are all
 * consequences of the physics, not of a stylised colour ramp.
 *
 * ## Reflectivity from bulk condensate
 *
 * The model carries bulk mass mixing ratios, so the reflectivity factor has to be recovered
 * from the mass with an assumed drop-size distribution. Using a Marshall–Palmer exponential
 * spectrum with intercept N0 and the mass-diameter relation for liquid water,
 *
 *     Z = 3.6e18 · (ρ_air · q_r / (π ρ_w N0))^(7/4)     [mm⁶ m⁻³, q_r in kg/kg]
 *
 * which for q_r in g/kg becomes Z = 2.16e4 · (ρ q_r / N0)^(7/4). The 7/4 exponent is the whole
 * reason radar looks the way it does: doubling the rain rate raises reflectivity by a factor of
 * 3.4, so a moderate shower and a downpour differ by 20 dBZ, not 3.
 *
 * Ice is handled separately because the ice particle size distribution is very different: snow
 * and graupel are larger, less dense and scatter less efficiently per unit mass, and a wet
 * melting layer is far more reflective than the dry snow above it — that is the radar
 * bright band. Hail is treated as a very large, high-reflectivity scatterer, and its presence
 * is why a hail core appears as an intense, *small* maximum rather than a broad bright area.
 *
 * ## Beam geometry and attenuation
 *
 * The beam is modelled as a 4/3-Earth refracted ray, so a low-elevation sweep stops seeing the
 * boundary layer at long range (the classic "cone of silence" and the reason a distant storm
 * is sampled at mid-levels). Attenuation follows a k = a·Z^b specific-attenuation law for rain
 * plus a smaller hail term, and is accumulated out and back through the same beam, which is why
 * a strong core casts a shadow behind it on the far side of the radar.
 */

export interface RadarConfig {
  /** Radar site on the ground, metres, in world coordinates. */
  siteX: number;
  siteZ: number;
  /** Elevation angles of the sweeps, degrees. */
  elevationDeg: number;
  /** Maximum range, metres. */
  rangeM: number;
  /** Range gate spacing, metres. */
  gateSpacingM: number;
  /** Radial resolution, degrees. */
  azSpacingDeg: number;
  /** Beam half-power width, degrees. */
  beamwidthDeg: number;
  /** Receiver noise floor, dBZ. Below this the pixel is clear air. */
  noiseFloorDbz: number;
}

export const DEFAULT_RADAR_CONFIG: RadarConfig = {
  siteX: 0,
  siteZ: 0,
  // 2.4° puts the beam at ~1.0 km at 24 km range: the base-scan elevation a real WSR-88D uses
  // for its lowest slice, high enough to see a storm's inflow and low-level mesocyclone rather
  // than the ground clutter of 0.5°, low enough to stay under the anvil.
  elevationDeg: 2.4,
  rangeM: 24000,
  gateSpacingM: 220,
  azSpacingDeg: 0.7,
  beamwidthDeg: 0.9,
  noiseFloorDbz: -6,
};

/** A precomputed PPI sweep: polar grid of dBZ values, row-major by azimuth. */
export interface RadarSweep {
  /** Reflectivity in dBZ per gate; NaN means no return. */
  dbz: Float32Array;
  /** Number of azimuth rays. */
  rays: number;
  /** Number of range gates. */
  gates: number;
  azSpacingDeg: number;
  gateSpacingM: number;
  elevationDeg: number;
  /** Beam-centre height at each gate, metres. */
  beamHeightM: Float32Array;
  /** Composite (column maximum) reflectivity, dBZ, per gate — used for the plan view. */
  compositeDbz: Float32Array;
  /** Echo-top height (18 dBZ), metres, per gate. */
  echoTopM: Float32Array;
  /** Vertically integrated liquid, kg/m², per gate. */
  vilKgM2: Float32Array;
}

/**
 * Converts a rain-water mixing ratio (g/kg) at a given air density into radar reflectivity
 * factor in mm⁶/m³, using a Marshall–Palmer exponential spectrum.
 *
 * The derivation matters because a wrong constant here does not change the picture, it deletes
 * it: with an N₀ of 8e6 the old expression returned 1e-5 mm⁶m⁻³ for 1 g/kg of rain, i.e.
 * −50 dBZ, so *every* echo fell below the noise floor and the radar rendered a blank screen.
 *
 * For an exponential spectrum N(D) = N₀ exp(−ΛD) with the mass relation m = (π/6)ρ_w D³,
 *
 *     Λ = (π ρ_w N₀ / (ρ_a q_r))^(1/4),   Z = N₀·6! / Λ⁷
 *
 * which for q_r in g/kg and ρ_w = 1000 reduces to the closed form used below. It is written
 * from Λ rather than from a fitted power law so the exponent and prefactor cannot drift apart.
 */
export function reflectivityFromRain(rhoAir: number, qrGKg: number, n0M4 = 8.0e6): number {
  if (qrGKg <= 1e-4) return 0;
  const qkg = qrGKg * 1e-3;
  // Λ in m^-1; the mass of a drop is ρ_w·π D³/6. The size distribution's own N₀ widens with
  // rain rate (N₀ ≈ 8e6 m⁻⁴ is a *light* rain value; a convective downpour runs 2–5e7), and
  // without that dependence the 7/4 power law pushes a 5 g/kg core past 70 dBZ, which no
  // S-band radar sees. Cap the intercept growth so the scale reads like a real reflectivity map.
  const n0 = n0M4 * Math.min(4.0, 1.0 + 2.2 * Math.sqrt(Math.max(0, qrGKg)));
  const lambda = Math.pow((Math.PI * 1000.0 * n0) / Math.max(1e-9, rhoAir * qkg), 0.25);
  // Z = N0 · Γ(7) / Λ⁷, with D in metres converted to mm (×1000) for each of the six D factors
  // in D⁶: 1000⁶ = 1e18.
  const zM6 = (n0 * 720.0) / Math.pow(lambda, 7.0);
  return zM6 * 1e18;
}

/**
 * Snow contribution. Snow is low-density aggregate ice: its reflectivity per unit mass is far
 * below liquid, both because the aggregates are less dense (m ∝ ρ_ice) and because the ice
 * dielectric constant is only |K|² = 0.208 against 0.93 for water (−6.5 dB). Snow therefore
 * sits in the 15–30 dBZ band however hard it is snowing, which is exactly what a radar shows.
 */
export function reflectivityFromSnow(rhoAir: number, qsGKg: number): number {
  if (qsGKg <= 1e-4) return 0;
  const qkg = qsGKg * 1e-3;
  // Aggregates: effective density 100 kg/m³, intercept 2e7.
  const lambda = Math.pow((Math.PI * 100.0 * 2.0e7) / Math.max(1e-9, rhoAir * qkg), 0.25);
  const zM6 = (2.0e7 * 720.0) / Math.pow(lambda, 7.0);
  return zM6 * 1e18 * 0.208;
}

/** Graupel: dense, rimed, high density (400 kg/m³) and therefore nearly liquid reflectivity. */
export function reflectivityFromGraupel(rhoAir: number, qgGKg: number): number {
  if (qgGKg <= 1e-4) return 0;
  const qkg = qgGKg * 1e-3;
  const lambda = Math.pow((Math.PI * 400.0 * 8.0e6) / Math.max(1e-9, rhoAir * qkg), 0.25);
  const zM6 = (8.0e6 * 720.0) / Math.pow(lambda, 7.0);
  return zM6 * 1e18 * 0.6;
}

/** dBZ from linear reflectivity, floored at the receiver noise level. */
export function toDbz(z: number): number {
  if (z <= 1e-3) return -Infinity;
  return 10.0 * Math.log10(z);
}

/**
 * Standard radar colour-map index 0..1 from dBZ, over the usual meteorological range.
 *
 * `dbz` is legitimately -Infinity for "no echo" (toDbz of zero reflectivity), and a guard is
 * needed for NaN as well: `Math.max(0, Math.min(1, NaN))` is NaN, which then flows into the
 * colour ramp as an invalid channel value and renders as a black hole rather than as clear air.
 */
export function dbzToNorm(dbz: number): number {
  if (!Number.isFinite(dbz)) return 0;
  return Math.max(0, Math.min(1, (dbz + 10.0) / 85.0));
}

/** Specific attenuation in dB/km from reflectivity factor, rain + hail terms. */
export function specificAttenuationDbPerKm(z: number): number {
  // k = 3.2e-4 Z^0.84 (dB/km, Z in mm6/m3) saturates at ~0.25 dB/km in heavy rain.
  return Math.min(0.6, 3.2e-4 * Math.pow(Math.max(0, z), 0.84));
}

/** 4/3-Earth beam-centre height above the radar site for a given slant range and elevation. */
export function beamHeightM(slantRangeM: number, elevationDeg: number): number {
  const el = (elevationDeg * Math.PI) / 180.0;
  const re = 6371000.0;
  const ke = 4.0 / 3.0;
  const r = slantRangeM;
  return Math.sqrt(r * r + (ke * re) * (ke * re) + 2.0 * r * ke * re * Math.sin(el)) - ke * re;
}

/**
 * Renders one PPI sweep. This is the hot path: it walks every gate of every ray and integrates
 * the beam through the model grid, so the number of range gates and rays is deliberately modest
 * (a 32-bit display does not need more).
 */
export function renderSweep(
  grid: AtmosphericFluidGrid,
  sounding: AtmosphericSounding,
  cfg: RadarConfig
): RadarSweep {
  const rays = Math.max(16, Math.round(360 / Math.max(0.2, cfg.azSpacingDeg)));
  const gates = Math.max(16, Math.round(cfg.rangeM / Math.max(50, cfg.gateSpacingM)));
  const dbzArr = new Float32Array(rays * gates);
  // Radial products, one value per range gate, shared across all rays.
  const composite = new Float32Array(gates);
  const echoTop = new Float32Array(gates);
  const vil = new Float32Array(gates);
  const beamHeight = new Float32Array(gates);

  // Precompute beam-centre heights: they only depend on range.
  for (let g = 0; g < gates; g++) {
    beamHeight[g] = beamHeightM((g + 0.5) * cfg.gateSpacingM, cfg.elevationDeg);
  }

  const nx = grid.nx;
  const ny = grid.ny;
  const slice = nx * ny;

  // Sample the grid at the three range gates nearest the beam centre, weighted by the beam
  // pattern. Three samples per gate reproduce the beam broadening that makes a distant core
  // look smeared and less intense, instead of a single-sample core that stays knife-edged at
  // 20 km.
  const DZ_OFFSETS = [-0.55, 0.0, 0.55];
  const DZ_WEIGHTS = [0.22, 0.56, 0.22];

  for (let a = 0; a < rays; a++) {
    const az = (a / rays) * Math.PI * 2.0;
    const dxAz = Math.cos(az);
    const dzAz = Math.sin(az);
    let accAtten = 0;

    for (let g = 0; g < gates; g++) {
      const r = (g + 0.5) * cfg.gateSpacingM;
      const groundY = beamHeight[g];
      let zLinear = 0;
      let rhoAt = 1.0;

      for (let s = 0; s < 3; s++) {
        const y = groundY + DZ_OFFSETS[s] * ((cfg.beamwidthDeg * Math.PI) / 180.0) * r;
        if (y < 0 || y > DOMAIN_MAX_ALT) continue;
        const wx = cfg.siteX + dxAz * r;
        const wz = cfg.siteZ + dzAz * r;
        if (Math.abs(wx) > DOMAIN_HALF_SIZE || Math.abs(wz) > DOMAIN_HALF_SIZE) continue;
        const ix = grid.worldToGridX(wx);
        const iy = grid.worldToGridY(y);
        const iz = grid.worldToGridZ(wz);
        const id = ix + nx * iy + slice * iz;
        const qc = grid.qc[id];
        const qi = grid.qi[id];
        const qr = grid.qr[id];
        if (qc + qi + qr < 1e-3) continue;
        rhoAt = sounding.densityAt(Math.max(40, y));

        // Partition: qr holds rain plus the frozen categories, qi the cloud ice. The split is
        // approximate because the model stores mass, not category-resolved spectra; the
        // temperature tells us which frozen species dominates, which is what sets the bright
        // band and the ice-cloud reflectivity floor.
        const tempK = sounding.tempKAt(Math.max(40, y));
        const frozenFrac = Math.max(0, Math.min(1, (PHYS.T_FREEZE + 2 - tempK) / 10.0));
        const rainMass = qr * (1.0 - frozenFrac) + qc * 0.25;
        const snowMass = qr * frozenFrac * 0.7 + qi * 0.85;
        const graupelMass = qr * frozenFrac * 0.3;
        let z = reflectivityFromRain(rhoAt, rainMass) +
          reflectivityFromSnow(rhoAt, snowMass) +
          reflectivityFromGraupel(rhoAt, graupelMass);
        // Melting-layer enhancement (bright band): just below the freezing level, wet snow
        // scatters like liquid. This is the single most recognisable radar signature of a
        // stratiform deck, so it is worth the three lines.
        const dT = PHYS.T_FREEZE - tempK;
        if (dT > -1.2 && dT < 1.6 && snowMass > 0.05) {
          z *= 2.6;
        }
        zLinear += z * DZ_WEIGHTS[s];
      }

      if (zLinear > 0) {
        const dbzAtTen = toDbz(zLinear) - accAtten;
        dbzArr[a * gates + g] = dbzAtTen;
        // Two-way attenuation, accumulated along the ray (out and back).
        accAtten += 2.0 * specificAttenuationDbPerKm(zLinear) * (cfg.gateSpacingM / 1000.0);
        if (dbzAtTen > composite[g]) composite[g] = dbzAtTen;
        if (dbzAtTen >= 18 && beamHeight[g] > echoTop[g]) echoTop[g] = beamHeight[g];
        // VIL: 3.44e-3 · Z^0.571 (Greene & Clark), per gate slab.
        if (dbzAtTen > 8) {
          vil[g] += 3.44e-3 * Math.pow(Math.pow(10, dbzAtTen / 10), 0.571) * (cfg.gateSpacingM / 1000.0);
        }
      } else {
        dbzArr[a * gates + g] = NaN;
      }
    }
  }

  return {
    dbz: dbzArr,
    rays,
    gates,
    azSpacingDeg: 360 / rays,
    gateSpacingM: cfg.gateSpacingM,
    elevationDeg: cfg.elevationDeg,
    beamHeightM: beamHeight,
    compositeDbz: composite,
    echoTopM: echoTop,
    vilKgM2: vil,
  };
}

/**
 * Vertical cross-section (an RHI) along an arbitrary ground track.
 *
 * This is the product that shows storm *structure*: the sloping updraft column, the
 * precipitation shaft curving downshear, the bright band where snow melts, the anvil streaming
 * out at the equilibrium level. A plan view cannot show any of that.
 *
 * The slice is sampled on a distance/height raster and interpolated from the model's 500 m grid
 * with a 3x3x3 stencil, so the result is smooth at display resolution rather than blocky. The
 * vertical velocity is carried alongside the reflectivity because the tower's own motion is what
 * makes the cross-section diagnostic rather than decorative.
 */
export interface RadarSection {
  /** Reflectivity in dBZ, indexed `c * rows + r` for distance column `c`, height row `r`. */
  dbz: Float32Array;
  /** Vertical velocity, m/s, same layout (positive up). */
  w: Float32Array;
  cols: number;
  rows: number;
  /** Ground distance covered, metres. */
  lengthM: number;
  /** Height covered by each row, metres. */
  cellHeightM: number;
  maxHeightM: number;
  /** Ground endpoints, world coordinates. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function renderSection(
  grid: AtmosphericFluidGrid,
  sounding: AtmosphericSounding,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  cols = 220,
  rows = 120,
  maxHeightM = 16000
): RadarSection {
  const dbzArr = new Float32Array(cols * rows);
  const wArr = new Float32Array(cols * rows);
  const len = Math.hypot(x1 - x0, z1 - z0);
  const dxAz = len > 1 ? (x1 - x0) / len : 1;
  const dzAz = len > 1 ? (z1 - z0) / len : 0;
  const cellH = maxHeightM / rows;
  const nx = grid.nx;
  const ny = grid.ny;
  const slice = nx * ny;

  for (let c = 0; c < cols; c++) {
    const dist = ((c + 0.5) / cols) * len;
    const wx = x0 + dxAz * dist;
    const wz = z0 + dzAz * dist;
    if (Math.abs(wx) > DOMAIN_HALF_SIZE || Math.abs(wz) > DOMAIN_HALF_SIZE) continue;
    const ix = grid.worldToGridX(wx);
    const iz = grid.worldToGridZ(wz);
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) * cellH;
      if (y > DOMAIN_MAX_ALT) continue;
      const iy = grid.worldToGridY(y);
      const rho = sounding.densityAt(Math.max(40, y));
      const tempK = sounding.tempKAt(Math.max(40, y));
      const brightBand = PHYS.T_FREEZE - tempK > -1.2 && PHYS.T_FREEZE - tempK < 1.6;
      let zSum = 0;
      let wSum = 0;
      let weight = 0;
      for (let dk = -1; dk <= 1; dk++) {
        const k = iy + dk;
        if (k < 1 || k >= ny - 1) continue;
        const wk = dk === 0 ? 1.0 : 0.45;
        for (let dj = -1; dj <= 1; dj++) {
          const j = iz + dj;
          if (j < 1 || j >= grid.nz - 1) continue;
          const wj = dj === 0 ? 1.0 : 0.45;
          for (let di = -1; di <= 1; di++) {
            const i = ix + di;
            if (i < 1 || i >= nx - 1) continue;
            const wi = di === 0 ? 1.0 : 0.45;
            const wt = wi * wj * wk;
            const id = i + nx * k + slice * j;
            const qc = grid.qc[id];
            const qi = grid.qi[id];
            const qr = grid.qr[id];
            const qs = grid.qs[id];
            const qg = grid.qg[id];
            if (qc + qi + qr + qs + qg < 1e-3) continue;
            let z =
              reflectivityFromRain(rho, qr + qc * 0.25) +
              reflectivityFromSnow(rho, qs + qi * 0.85) +
              reflectivityFromGraupel(rho, qg);
            if (brightBand) z *= 2.6;
            zSum += z * wt;
            wSum += grid.vy[id] * wt;
            weight += wt;
          }
        }
      }
      const idx = c * rows + r;
      // No sample inside the domain in any of the 27 stencil points. This must be the *no echo*
      // sentinel, not NaN: it used to be left at the Float32Array's initial 0, which the
      // colour map reads as 0 dBZ of real echo, painting a band of light rain across every
      // section that crossed the domain edge — up to a third of the image.
      if (weight > 0) {
        const meanZ = zSum / weight;
        dbzArr[idx] = meanZ > 1e-3 ? toDbz(meanZ) : -Infinity;
        wArr[idx] = wSum / weight;
      } else {
        dbzArr[idx] = -Infinity;
        wArr[idx] = 0;
      }
    }
  }

  return {
    dbz: dbzArr,
    w: wArr,
    cols,
    rows,
    lengthM: len,
    cellHeightM: cellH,
    maxHeightM,
    x0,
    z0,
    x1,
    z1,
  };
}

/**
 * Column-maximum composite over the whole domain, as a Cartesian raster. This is the product
 * used by the plan-view panel: the highest reflectivity anywhere in each column, which is what
 * a real "composite reflectivity" map shows and what makes the anvil visible on top of the
 * precipitation core instead of hiding it.
 */
export function renderColumnMax(grid: AtmosphericFluidGrid, sounding: AtmosphericSounding): Float32Array {
  const out = new Float32Array(grid.nx * grid.nz);
  const slice = grid.nx * grid.ny;
  for (let iz = 0; iz < grid.nz; iz++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      let best = -Infinity;
      for (let iy = 0; iy < grid.ny; iy++) {
        const id = ix + grid.nx * iy + slice * iz;
        const qc = grid.qc[id];
        const qi = grid.qi[id];
        const qr = grid.qr[id];
        const qs = grid.qs[id];
        const qg = grid.qg[id];
        if (qc + qi + qr + qs + qg < 2e-3) continue;
        const y = grid.gridToWorldY(iy);
        const rho = sounding.densityAt(Math.max(40, y));
        const z = reflectivityFromRain(rho, qr + qc * 0.25) +
          reflectivityFromSnow(rho, qs + qi * 0.85) +
          reflectivityFromGraupel(rho, qg);
        const dbz = toDbz(z);
        if (dbz > best) best = dbz;
      }
      out[ix + grid.nx * iz] = best;
    }
  }
  return out;
}

/**
 * Picks the point a cross-section should be drawn through.
 *
 * The section has to cut through the *updraft tower*, not merely the brightest gate. Two things
 * make the obvious choices wrong. A composite maximum is dominated by hail and by the
 * precipitation shaft, which sit downshear of the tower and often belong to a cell that has
 * already collapsed. And in 40 m/s of shear a tower is displaced several kilometres downshear by
 * mid levels, so the surface cell centre is not where the visible column is either.
 *
 * So the focus point is the column of maximum updraft mass flux through the 2.5-7.5 km layer,
 * with the caller's diagnosed cells as the fallback when nothing is rising and the brightest
 * echo as the last resort.
 */
export function findStormCore(
  grid: AtmosphericFluidGrid,
  columnMax: Float32Array,
  candidates: Array<{ x: number; z: number }> = []
): { x: number; z: number; maxDbz: number; found: boolean } {
  const nx = grid.nx;
  const ny = grid.ny;
  const nz = grid.nz;
  const slice = nx * ny;
  const yLo = grid.worldToGridY(2500);
  const yHi = Math.min(ny - 2, grid.worldToGridY(7500));

  const fluxAt = (ix: number, iz: number): number => {
    let flux = 0;
    for (let iy = yLo; iy <= yHi; iy++) {
      const v = grid.vy[ix + nx * iy + slice * iz];
      if (v > 0) flux += v;
    }
    return flux;
  };

  // Coarse sweep for the strongest rising column, then a local refinement.
  let bestFlux = 0;
  let bestIx = -1;
  let bestIz = -1;
  for (let iz = 1; iz < nz - 1; iz += 4) {
    for (let ix = 1; ix < nx - 1; ix += 4) {
      const f = fluxAt(ix, iz);
      if (f > bestFlux) {
        bestFlux = f;
        bestIx = ix;
        bestIz = iz;
      }
    }
  }
  if (bestIx >= 0) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const i = bestIx + dx;
        const j = bestIz + dz;
        if (i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1) continue;
        const f = fluxAt(i, j);
        if (f > bestFlux) {
          bestFlux = f;
          bestIx = i;
          bestIz = j;
        }
      }
    }
  }

  // Nothing is rising: fall back to the diagnosed cells, then to the brightest echo.
  if (bestIx < 0) {
    let best = -Infinity;
    for (const c of candidates) {
      const ix = grid.worldToGridX(c.x);
      const iz = grid.worldToGridZ(c.z);
      if (ix < 1 || iz < 1 || ix >= nx - 1 || iz >= nz - 1) continue;
      let support = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const n = columnMax[ix + dx + nx * (iz + dz)];
          if (Number.isFinite(n) && n >= 20) support++;
        }
      }
      const d = columnMax[ix + nx * iz];
      const score = support * 40 + (Number.isFinite(d) ? d : -99);
      if (score > best) {
        best = score;
        bestIx = ix;
        bestIz = iz;
      }
    }
    if (bestIx < 0) {
      let bestDbz = -Infinity;
      for (let iz = 1; iz < nz - 1; iz++) {
        for (let ix = 1; ix < nx - 1; ix++) {
          const d = columnMax[ix + nx * iz];
          if (Number.isFinite(d) && d > bestDbz) {
            bestDbz = d;
            bestIx = ix;
            bestIz = iz;
          }
        }
      }
    }
  }

  if (bestIx < 0) return { x: 0, z: 0, maxDbz: -99, found: false };
  const peak = columnMax[bestIx + nx * bestIz];
  return {
    x: grid.gridToWorldX(bestIx),
    z: grid.gridToWorldZ(bestIz),
    maxDbz: Number.isFinite(peak) ? peak : -99,
    found: true,
  };
}
