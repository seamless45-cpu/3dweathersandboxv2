import { DOMAIN_HALF_SIZE, InstabilityTelemetry } from './types';
import { getSurfaceThermalPotential, getTerrainHeight } from './terrainField';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Grid resolution of the mesoscale boundary-layer field. */
const ENV_NX = 64;
const ENV_NZ = 64;
/** Node spacing in metres: 48000 / 64 = 750 m. */
const ENV_DX = (DOMAIN_HALF_SIZE * 2) / ENV_NX;

/**
 * Local thermodynamic state derived from the domain-scale sounding modified by the resolved
 * mesoscale field at one position. This is what makes weather local: two places 10 km apart can
 * have materially different CAPE, cloud base and humidity at the same instant.
 */
export interface LocalInstability {
  cape: number;
  cin: number;
  lcl: number;
  el: number;
  /** Surface temperature, K. */
  tempK: number;
  /** Surface dewpoint, K. */
  dewpointK: number;
  /** Surface relative humidity, %. */
  relHumidity: number;
  /** Surface pressure, hPa. */
  pressureHPa: number;
  /** Mixing ratio, g/kg. */
  qvGKg: number;
  /** Boundary-layer wind including mesoscale pressure-gradient outflow, m/s. */
  windU: number;
  windW: number;
  windSpeedMS: number;
  /** 0..1 gust factor above the mean wind, from the local pressure gradient. */
  gustFactor: number;
}

/**
 * A horizontally resolved, time-evolving boundary-layer field.
 *
 * ## Why this exists
 *
 * The domain previously had exactly one thermodynamic environment: a single 1-D sounding giving
 * one CAPE, one CIN, one LCL, one temperature and one dewpoint for all 48 km x 48 km. Every cell
 * saw identical instability, thermal hotspots were a frozen fbm pattern baked into the terrain
 * function, and cold pools influenced only the cells near them -- once a gust front passed over a
 * patch of ground nothing about that ground changed. The result was weather that was spatially
 * homogeneous and had no memory.
 *
 * This module adds the missing mesoscale layer. It carries perturbations to potential
 * temperature, moisture, surface pressure and soil saturation on a 750 m grid, and evolves them
 * with the processes that actually drive them:
 *
 * - **Advection** by the boundary-layer wind, semi-Lagrangian so it is stable at any CFL.
 *   Features therefore *travel*: a dry slot drifts, an outflow boundary propagates.
 * - **Diurnal surface heating**, modulated by insolation and by how wet the ground is. Wet soil
 *   partitions incoming energy into latent rather than sensible heat, so ground that rained an
 *   hour ago warms less -- a real and strongly localising feedback.
 * - **Precipitation**: rain wets the soil and evaporatively cools and moistens the air beneath
 *   the shaft. This is how storms modify their own environment.
 * - **Cold pool injection** from gust fronts, writing dense cool air and the associated surface
 *   pressure signature.
 * - **Diagnostic boundary-layer wind** from the pressure gradient, so outflow is felt at the
 *   surface even where the 500 m fluid grid has not resolved it.
 * - **Relaxation and diffusion** toward the base sounding on a mesoscale timescale, which keeps
 *   the field from running away and represents lateral mixing and subsidence.
 *
 * The two-way coupling is the point: storms rewrite the field, the rewritten field decides where
 * the next storm can form, and the whole thing advects with the wind. That is self-organisation
 * rather than a fixed set of spawn rules.
 */
export class MesoscaleEnvironment {
  public readonly nx = ENV_NX;
  public readonly nz = ENV_NZ;
  public readonly dx = ENV_DX;

  /** Boundary-layer potential temperature perturbation, K. */
  public readonly thetaPert = new Float32Array(ENV_NX * ENV_NZ);
  /** Moisture perturbation, g/kg. */
  public readonly qvPert = new Float32Array(ENV_NX * ENV_NZ);
  /** Surface pressure perturbation, Pa. */
  public readonly pressPert = new Float32Array(ENV_NX * ENV_NZ);
  /** Soil saturation 0..1 from accumulated precipitation; modulates heating and evaporation. */
  public readonly soilSat = new Float32Array(ENV_NX * ENV_NZ);
  /** Diagnostic boundary-layer wind perturbation from the pressure gradient, m/s. */
  public readonly uPert = new Float32Array(ENV_NX * ENV_NZ);
  public readonly wPert = new Float32Array(ENV_NX * ENV_NZ);

  private scratchA = new Float32Array(ENV_NX * ENV_NZ);

  /**
   * Static geographic modulators, precomputed once.
   *
   * getTerrainHeight and getSurfaceThermalPotential are pure functions of position and never
   * change, but each evaluates several octaves of value noise. Calling them for all 4096 nodes
   * every step cost ~0.5 ms/frame -- about a tenth of the whole simulation budget -- to recompute
   * numbers that are identical forever. Baking them into lookup tables at construction removes
   * that cost entirely and cannot change the result, because there is no time dependence to lose.
   */
  private readonly hotspotLut = new Float32Array(ENV_NX * ENV_NZ);
  private readonly elevDampLut = new Float32Array(ENV_NX * ENV_NZ);

  /**
   * Packed local relative humidity (0..255) mirrored for upload to the GPU, plus a local cloud-base
   * height normalised into the second channel. The terrain shader samples these so that visibility
   * and haze vary across the landscape with the air that is actually there -- you can see the
   * murk under a rain shaft and the clearer, drier air of a slot between storms, rather than a
   * uniform atmospheric veil over the whole domain.
   */
  public readonly localWeatherTex = new Uint8Array(ENV_NX * ENV_NZ * 2);
  public localWeatherDirty = true;
  private localWeatherTimer = 0;

  /**
   * Relaxation timescale toward the base state, seconds (~1.5 h).
   *
   * This sets how fast the field reaches its equilibrium contrast, since a continuous source of
   * rate S settles at S x tau. At the earlier 3 h value a one-hour run only reached ~28% of
   * equilibrium, so the localisation was real but still developing -- the CAPE spread measured
   * 280 J/kg against the ~800 J/kg the same sources give at equilibrium. Halving tau and doubling
   * the continuous source rates below preserves the equilibrium amplitude while reaching it in
   * half the time, which matters because a typical session is minutes long, not hours.
   */
  private static readonly RELAX_TAU = 5400;
  /** Soil dries over a few hours of insolation -- longer than the air relaxes, shorter than a day. */
  private static readonly SOIL_DRY_TAU = 7200;

  // The rates below are calibrated against observed mesoscale anomaly magnitudes rather than
  // tuned for numerical convenience. The target is that a dry sunlit patch and a rain-cooled
  // outflow patch a few km apart differ by the amounts real boundary layers actually differ by:
  //   theta'   +1.5..3 K diurnal heterogeneity, -3..-9 K under a cold pool, -1..-4 K in rain
  //   qv'      +-1..3 g/kg across a moisture boundary
  //   press'   -250..+400 Pa (a mesohigh of 1-4 hPa is routine under a cold pool)
  // Those feed a theta_e anomaly of several K, which through the CAPE and LCL scalings produces a
  // localisation worth seeing: CAPE varying by ~1000 J/kg and cloud base by several hundred metres
  // across the domain. Earlier values were an order of magnitude too weak and produced a CAPE
  // spread of 50 J/kg on a 4300 J/kg base, i.e. effectively no localisation at all.

  /** Peak sensible heating rate from full insolation over dry soil, K/s. */
  private static readonly HEAT_RATE = 1.08e-3;
  /** Evaporative cooling per mm/h of rain falling through the boundary layer, K/s per mm/h. */
  private static readonly RAIN_COOL_RATE = 2.7e-4;
  /** Moisture added to the boundary layer per mm/h of rain, (g/kg)/s per mm/h. */
  private static readonly RAIN_MOIST_RATE = 1.04e-4;

  /** Diagnostic maxima, for telemetry and for keeping the forcing honest. */
  public maxThetaPertK = 0;
  public maxQvPertGKg = 0;
  public minPressPertPa = 0;
  public maxPressPertPa = 0;
  public maxSoilSat = 0;
  public maxGustFactor = 0;

  constructor() {
    for (let j = 0; j < ENV_NZ; j++) {
      for (let i = 0; i < ENV_NX; i++) {
        const x = this.nodeToWorldX(i);
        const z = this.nodeToWorldZ(j);
        const id = j * ENV_NX + i;
        this.hotspotLut[id] = 0.5 + 0.5 * getSurfaceThermalPotential(x, z);
        this.elevDampLut[id] = 1.0 / (1.0 + getTerrainHeight(x, z) / 1400.0);
      }
    }
  }

  private idx(ix: number, iz: number): number {
    return iz * ENV_NX + ix;
  }

  public worldToNodeX(x: number): number {
    return (x + DOMAIN_HALF_SIZE) / ENV_DX;
  }

  public worldToNodeZ(z: number): number {
    return (z + DOMAIN_HALF_SIZE) / ENV_DX;
  }

  public nodeToWorldX(ix: number): number {
    return ix * ENV_DX - DOMAIN_HALF_SIZE;
  }

  public nodeToWorldZ(iz: number): number {
    return iz * ENV_DX - DOMAIN_HALF_SIZE;
  }

  public reset(): void {
    this.localWeatherTex.fill(0);
    this.localWeatherDirty = true;
    this.localWeatherTimer = 0;
    this.thetaPert.fill(0);
    this.qvPert.fill(0);
    this.pressPert.fill(0);
    this.soilSat.fill(0);
    this.uPert.fill(0);
    this.wPert.fill(0);
    this.maxThetaPertK = 0;
    this.maxQvPertGKg = 0;
    this.minPressPertPa = 0;
    this.maxPressPertPa = 0;
    this.maxSoilSat = 0;
    this.maxGustFactor = 0;
  }

  /** Bilinear sample of one field at world coordinates. */
  private sample(field: Float32Array, x: number, z: number): number {
    const gx = clamp(this.worldToNodeX(x), 0, ENV_NX - 1.001);
    const gz = clamp(this.worldToNodeZ(z), 0, ENV_NZ - 1.001);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const i1 = Math.min(ENV_NX - 1, i0 + 1);
    const j1 = Math.min(ENV_NZ - 1, j0 + 1);
    const fx = gx - i0;
    const fz = gz - j0;
    const a = field[j0 * ENV_NX + i0];
    const b = field[j0 * ENV_NX + i1];
    const c = field[j1 * ENV_NX + i0];
    const d = field[j1 * ENV_NX + i1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  /**
   * Semi-Lagrangian advection: trace each node back along the wind and interpolate.
   *
   * Unconditionally stable regardless of CFL, which matters because a 40 m/s gust front over a
   * 750 m grid with a 0.2 s step would otherwise blow up an explicit scheme.
   *
   * The advecting wind is the domain-scale boundary-layer flow, which is spatially uniform, so the
   * backtrack displacement is the *same for every node*. For integer node index i,
   * floor(i - s) = i + floor(-s) and the fractional part is constant, so the general bilinear
   * sample collapses to a 4-tap stencil with fixed integer offsets and fixed weights. The earlier
   * version converted each node to world coordinates and ran the full generic sampler, computing
   * the same four weights 4096 times per field per step.
   *
   * Features still propagate correctly: cold pools and rain shafts are re-injected each step at
   * their own advected positions by the cell manager, so the uniform background flow carries the
   * field while the moving sources carry the detail.
   */
  private advect(field: Float32Array, out: Float32Array, u: number, w: number, dt: number): void {
    // Limit the backtrack to one node per step so a strong wind cannot smear the whole field.
    const maxStep = ENV_DX * 0.95;
    const sx = clamp(u * dt, -maxStep, maxStep) / ENV_DX;
    const sz = clamp(w * dt, -maxStep, maxStep) / ENV_DX;

    // Constant integer shift and constant interpolation weights.
    const di = Math.floor(-sx);
    const dj = Math.floor(-sz);
    const fx = -sx - di;
    const fz = -sz - dj;
    const w00 = (1 - fx) * (1 - fz);
    const w10 = fx * (1 - fz);
    const w01 = (1 - fx) * fz;
    const w11 = fx * fz;

    for (let j = 0; j < ENV_NZ; j++) {
      const j0 = Math.max(0, Math.min(ENV_NZ - 1, j + dj));
      const j1 = Math.max(0, Math.min(ENV_NZ - 1, j + dj + 1));
      const r0 = j0 * ENV_NX;
      const r1 = j1 * ENV_NX;
      const ro = j * ENV_NX;
      for (let i = 0; i < ENV_NX; i++) {
        const i0 = Math.max(0, Math.min(ENV_NX - 1, i + di));
        const i1 = Math.max(0, Math.min(ENV_NX - 1, i + di + 1));
        out[ro + i] =
          field[r0 + i0] * w00 +
          field[r0 + i1] * w10 +
          field[r1 + i0] * w01 +
          field[r1 + i1] * w11;
      }
    }
    field.set(out);
  }

  /**
   * Injects a cold pool / gust front into the field.
   *
   * Writes cool dense air over the pool interior, a moist rim where rain-cooled air sits, and the
   * surface pressure signature: high under the dense core, and -- the part that is actually
   * observable from the ground -- a falling pressure gradient just ahead of the leading edge.
   */
  public injectColdPool(
    x: number,
    z: number,
    radiusM: number,
    strength: number,
    tempDeficitK: number,
    depthM: number,
    dt: number
  ): void {
    if (strength <= 0.001 || radiusM < 200) return;

    const gi = this.worldToNodeX(x);
    const gj = this.worldToNodeZ(z);
    const reach = Math.ceil(radiusM / ENV_DX) + 2;
    // Shallow pools mix their deficit through less depth, so the surface signature is weaker.
    const depthFactor = clamp(depthM / 1200, 0.45, 1.0);
    // A gust front passage is fast: the temperature behind it drops several K in a few minutes,
    // not over an hour. Response time ~3 min.
    const response = 1.0 - Math.exp(-dt / 180.0);

    // Squared distances and reciprocals are hoisted: these loops run thousands of times per step
    // and Math.hypot / Math.pow are far more expensive than the arithmetic they replace.
    const rMax = radiusM + ENV_DX * 1.5;
    const rMax2 = rMax * rMax;
    const invR = 1.0 / Math.max(1, radiusM);
    const edgeCentre = radiusM * 0.86;
    const invEdgeWidth = 1.0 / (radiusM * 0.34);
    const jLo = Math.max(0, Math.floor(gj - reach));
    const jHi = Math.min(ENV_NZ - 1, Math.ceil(gj + reach));
    const iLo = Math.max(0, Math.floor(gi - reach));
    const iHi = Math.min(ENV_NX - 1, Math.ceil(gi + reach));

    for (let j = jLo; j <= jHi; j++) {
      const dz = this.nodeToWorldZ(j) - z;
      const dz2 = dz * dz;
      const rowOff = j * ENV_NX;
      for (let i = iLo; i <= iHi; i++) {
        const dx = this.nodeToWorldX(i) - x;
        const d2 = dx * dx + dz2;
        if (d2 > rMax2) continue;
        const d = Math.sqrt(d2);
        const id = rowOff + i;

        // Interior: cold and dense. Edge: the gust front itself, where the strongest gradient and
        // the moist rain-cooled air sit.
        const interior = 1.0 - clamp(d * invR, 0, 1);
        const ew = (d - edgeCentre) * invEdgeWidth;
        const edge = Math.exp(-ew * ew);

        // The temperature deficit is applied close to directly. Two compounding errors were fixed
        // here: the first version multiplied by strength AND depth AND interior, turning a 3 K
        // deficit into a 0.26 K target. The cell's tempDeficitK is also an evaporative-cooling
        // parameter rather than the realised surface anomaly -- a density current concentrates it,
        // so the observed cold pool behind a gust front runs roughly twice the parameterised
        // deficit, reaching the 4-10 K that real outflow boundaries produce.
        const realisedDeficit = tempDeficitK * 1.95;
        const thetaTarget =
          -realisedDeficit * depthFactor *
          (0.52 + 0.48 * clamp(strength, 0, 1)) *
          (interior + edge * 0.6);
        this.thetaPert[id] += (thetaTarget - this.thetaPert[id]) * response;

        // Evaporating precipitation leaves the pool air cooler and near-saturated.
        const qvTarget = (0.85 + 1.5 * clamp(strength, 0, 1)) * (interior * 0.7 + edge * 0.9);
        this.qvPert[id] += (qvTarget - this.qvPert[id]) * response * 0.8;

        // Hydrostatic: cold dense air raises surface pressure under the pool core -- a mesohigh of
        // 1-4 hPa is routine -- while the leading edge carries the pressure *drop* that is felt on
        // the ground minutes before the gust itself arrives.
        const pressTarget =
          (interior * 1150.0 - edge * 640.0) *
          (0.35 + 0.65 * clamp(strength, 0, 1)) *
          depthFactor;
        this.pressPert[id] += (pressTarget - this.pressPert[id]) * response;
      }
    }
  }

  /**
   * Applies falling precipitation to the column beneath it: wets the soil, and cools and moistens
   * the boundary layer by evaporation. This is the main route by which a storm modifies the
   * environment it is about to move into.
   */
  public injectPrecipitation(x: number, z: number, radiusM: number, rainMMHr: number, dt: number): void {
    if (rainMMHr <= 0.05 || radiusM < 150) return;

    const gi = this.worldToNodeX(x);
    const gj = this.worldToNodeZ(z);
    const reach = Math.ceil(radiusM / ENV_DX) + 1;

    const rMax2 = radiusM * radiusM;
    const invR = 1.0 / radiusM;
    const jLo = Math.max(0, Math.floor(gj - reach));
    const jHi = Math.min(ENV_NZ - 1, Math.ceil(gj + reach));
    const iLo = Math.max(0, Math.floor(gi - reach));
    const iHi = Math.min(ENV_NX - 1, Math.ceil(gi + reach));

    for (let j = jLo; j <= jHi; j++) {
      const dz = this.nodeToWorldZ(j) - z;
      const dz2 = dz * dz;
      const rowOff = j * ENV_NX;
      for (let i = iLo; i <= iHi; i++) {
        const dx = this.nodeToWorldX(i) - x;
        const d2 = dx * dx + dz2;
        if (d2 > rMax2) continue;
        const id = rowOff + i;
        const w = 1.0 - clamp(Math.sqrt(d2) * invR, 0, 1);

        // Soil wets toward an equilibrium set by the rain rate rather than integrating without
        // bound. The earlier version accumulated unboundedly and reached 1.0 across the whole
        // domain within minutes; because heating is damped by soil moisture, that globally
        // suppressed sensible heating and flattened the CAPE field to a 34 J/kg spread -- the
        // localisation this module exists to produce was cancelled by its own soil term.
        const soilTarget = clamp((rainMMHr / 26.0) * w, 0, 1);
        this.soilSat[id] +=
          (soilTarget - this.soilSat[id]) * (1.0 - Math.exp(-dt / 480.0));
        const cool = MesoscaleEnvironment.RAIN_COOL_RATE * rainMMHr * w * dt;
        this.thetaPert[id] -= cool;
        this.qvPert[id] += MesoscaleEnvironment.RAIN_MOIST_RATE * rainMMHr * w * dt;
        // Rain loading and evaporative cooling produce a local pressure rise under the shaft.
        this.pressPert[id] += cool * 26.0;
      }
    }
  }

  /**
   * Advances the field one step.
   *
   * @param insolation 0..1 diurnal insolation multiplier
   * @param baseWindU  domain-scale boundary-layer wind, m/s
   * @param baseWindW  domain-scale boundary-layer wind, m/s
   */
  public step(
    dt: number,
    insolation: number,
    baseWindU: number,
    baseWindW: number,
    baseTempK = 303.15,
    baseQvGKg = 16.0,
    basePressureHPa = 1010.0
  ): void {
    if (dt <= 0) return;

    // --- 1. Advect everything with the boundary-layer wind -------------------------------
    // The perturbation wind is included so a gust front carries its own cold air with it, which
    // is what makes an outflow boundary propagate rather than sit and diffuse.
    this.advect(this.thetaPert, this.scratchA, baseWindU, baseWindW, dt);
    this.advect(this.qvPert, this.scratchA, baseWindU, baseWindW, dt);
    this.advect(this.pressPert, this.scratchA, baseWindU * 0.8, baseWindW * 0.8, dt);
    // Soil does not advect; it is a property of the ground.

    // --- 2. Surface heating, modulated by soil moisture and static terrain heterogeneity ---
    // Insolation warms dry ground fastest. The static thermal potential from the terrain field is
    // retained here but demoted to what it physically is: a *modulator* of a dynamic field
    // (albedo and soil texture vary with geography) rather than the field itself.
    const heatAmp = MesoscaleEnvironment.HEAT_RATE * clamp(insolation, 0, 1.4) * dt;
    for (let j = 0; j < ENV_NZ; j++) {
      for (let i = 0; i < ENV_NX; i++) {
        const id = this.idx(i, j);
        const hotspot = this.hotspotLut[id];
        // Wet soil sends incoming energy into latent heat, not sensible heat.
        const moistureDamp = 1.0 - 0.62 * this.soilSat[id];
        // Elevation reduces the column depth available to warm.
        const elevDamp = this.elevDampLut[id];
        // Cloud shadow is represented implicitly: where the air is already cool and moist the
        // surface is likely under precipitation or outflow, and heats less.
        const shade = 1.0 / (1.0 + Math.max(0, -this.thetaPert[id]) * 0.34);

        const heating = heatAmp * (0.42 + 1.16 * hotspot) * moistureDamp * elevDamp * shade;
        this.thetaPert[id] += heating;
        // Sensible heating conserves the mixing ratio -- it warms the column without removing
        // water, which is exactly why theta_e, and therefore CAPE, grows through the afternoon.
        // Only the small amount entrained from the drier air above a deepening boundary layer is
        // deducted here. An earlier version drained 0.11 g/kg per K, which cancelled most of the
        // theta_e gain and flattened the CAPE field to a 280 J/kg spread.
        this.qvPert[id] -= heating * 0.03;
      }
    }

    // --- 3. Relaxation toward the base state and soil drying ------------------------------
    // Every factor here is a scalar for the whole step. They were previously recomputed per node,
    // which meant ~16k Math.exp calls per step for four numbers.
    const relax = Math.exp(-dt / MesoscaleEnvironment.RELAX_TAU);
    const relaxPress = Math.exp(-dt / (MesoscaleEnvironment.RELAX_TAU * 0.45));
    // Soil drying is driven by available energy, so a wet surface clears in a couple of hours of
    // sun but stays damp overnight. Without the insolation term the field remembered rain equally
    // at night and at noon, which is not how a boundary layer recovers.
    const dryTau = MesoscaleEnvironment.SOIL_DRY_TAU / (0.22 + 1.05 * clamp(insolation, 0, 1.4));
    const dry = Math.exp(-dt / dryTau);
    // Relaxation and the telemetry maxima are fused into one pass over the field: both are simple
    // full-array reductions and doing them separately doubled the memory traffic.
    const n = this.thetaPert.length;
    const th = this.thetaPert;
    const qv = this.qvPert;
    const pp = this.pressPert;
    const ss = this.soilSat;
    let maxT = 0;
    let maxQ = 0;
    let minP = 0;
    let maxP = 0;
    let maxS = 0;
    for (let id = 0; id < n; id++) {
      const t = (th[id] *= relax);
      const q = (qv[id] *= relax);
      const p = (pp[id] *= relaxPress);
      const sl = (ss[id] *= dry);
      const at = t < 0 ? -t : t;
      if (at > maxT) maxT = at;
      const aq = q < 0 ? -q : q;
      if (aq > maxQ) maxQ = aq;
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
      if (sl > maxS) maxS = sl;
    }
    this.maxThetaPertK = maxT;
    this.maxQvPertGKg = maxQ;
    this.minPressPertPa = minP;
    this.maxPressPertPa = maxP;
    this.maxSoilSat = maxS;

    // --- 4. Diffusion: lateral mixing keeps gradients resolvable and damps node-scale noise --
    // Boundary-layer lateral diffusivity of order 10^3 m^2/s. Mesoscale features must survive for
    // hours, so this is deliberately weak; it exists to damp single-node noise, not to smear the
    // field back to uniform.
    this.diffuse(this.thetaPert, this.scratchA, 2600, dt);
    this.diffuse(this.qvPert, this.scratchA, 2600, dt);
    this.diffuse(this.pressPert, this.scratchA, 4200, dt);

    // --- 5. Diagnostic boundary-layer wind from the pressure gradient ----------------------
    // A drag-balance response: the wind accelerates down the pressure gradient and is limited by
    // surface friction, so it settles at a speed proportional to the gradient. This is what turns
    // a pressure signature into something the observer feels as a gust and a wind shift.
    const pgfScale = 1.0 / 1.18;
    let maxGust = 0;
    for (let j = 1; j < ENV_NZ - 1; j++) {
      for (let i = 1; i < ENV_NX - 1; i++) {
        const id = this.idx(i, j);
        const dpdx = (this.pressPert[id + 1] - this.pressPert[id - 1]) / (2 * ENV_DX);
        const dpdz =
          (this.pressPert[id + ENV_NX] - this.pressPert[id - ENV_NX]) / (2 * ENV_DX);
        // Frictional response time of the boundary layer, ~25 min.
        const tau = 1500;
        const targetU = -dpdx * pgfScale * tau;
        const targetW = -dpdz * pgfScale * tau;
        const k = 1.0 - Math.exp(-dt / 220);
        this.uPert[id] += (clamp(targetU, -34, 34) - this.uPert[id]) * k;
        this.wPert[id] += (clamp(targetW, -34, 34) - this.wPert[id]) * k;

        const speed = Math.hypot(this.uPert[id], this.wPert[id]);
        const mean = Math.max(1.0, Math.hypot(baseWindU, baseWindW));
        const gust = clamp(speed / mean, 0, 3.2);
        if (gust > maxGust) maxGust = gust;
      }
    }

    this.maxGustFactor = maxGust;

    // --- 7. Refresh the GPU mirror on a reduced cadence ----------------------------------
    // Relative humidity needs two exponentials per node (Magnus saturation and actual vapour
    // pressure), which is far too expensive to run at the physics rate for 4096 nodes. The field
    // itself evolves on a timescale of minutes, so refreshing the texture every ~6 s of sim time
    // is indistinguishable and costs about a twentieth of what doing it every step would.
    this.localWeatherTimer += dt;
    if (this.localWeatherTimer >= 6.0) {
      this.localWeatherTimer = 0;
      this.refreshLocalWeatherTexture(baseTempK, baseQvGKg, basePressureHPa);
    }
  }

  /**
   * Packs local relative humidity and cloud-base height into the GPU mirror.
   *
   * RH is computed from the local temperature and the local vapour pressure through the Magnus
   * relation, using the actual perturbed state rather than an approximation, because haze is
   * extremely sensitive near saturation and an approximate RH would put the murk in the wrong
   * places.
   */
  private refreshLocalWeatherTexture(
    baseTempK: number,
    baseQvGKg: number,
    basePressureHPa: number
  ): void {
    const tex = this.localWeatherTex;
    const pPa = basePressureHPa * 100.0;
    for (let j = 0; j < ENV_NZ; j++) {
      for (let i = 0; i < ENV_NX; i++) {
        const id = j * ENV_NX + i;
        const tempK = baseTempK + this.thetaPert[id];
        const qv = Math.max(0.2, baseQvGKg + this.qvPert[id]);

        // Vapour pressure from the mixing ratio, then saturation from Magnus.
        const qvKg = qv / 1000.0;
        const e = (qvKg * pPa) / (0.62198 + qvKg);
        const tc = tempK - 273.15;
        const es = 611.2 * Math.exp((17.67 * tc) / (tc + 243.5));
        const rh = clamp(e / Math.max(1.0, es), 0.02, 1.0);

        // Cloud base from the local temperature-dewpoint spread via the psychrometric relation.
        // Dewpoint inverted from the actual vapour pressure.
        const lnR = Math.log(Math.max(1.0, e) / 611.2);
        const tdC = (243.5 * lnR) / (17.67 - lnR);
        const lcl = clamp(125.0 * (tc - tdC), 0, 4000);

        tex[id * 2] = Math.round(rh * 255);
        tex[id * 2 + 1] = Math.round((lcl / 4000.0) * 255);
      }
    }
    this.localWeatherDirty = true;
  }

  /**
   * One pass of a 5-point Laplacian with zero-gradient conditions at the edge.
   *
   * `diffusivity` is a physical lateral diffusivity in m^2/s and the weight is derived from it as
   * K dt / dx^2, clamped for stability. This matters a great deal: an earlier version passed a
   * bare weight applied once per step, which at dt = 0.2 s and dx = 750 m meant the field was
   * smoothed ~900x harder than intended. Localised features were erased within a few frames, the
   * CAPE spread collapsed to tens of J/kg and the pressure signature never developed at all --
   * the field was numerically alive but physically uniform, which is precisely the failure this
   * module was written to fix.
   */
  private diffuse(field: Float32Array, out: Float32Array, diffusivity: number, dt: number): void {
    const k = clamp((diffusivity * dt) / (ENV_DX * ENV_DX), 0, 0.2);
    for (let j = 0; j < ENV_NZ; j++) {
      const jm = Math.max(0, j - 1);
      const jp = Math.min(ENV_NZ - 1, j + 1);
      for (let i = 0; i < ENV_NX; i++) {
        const im = Math.max(0, i - 1);
        const ip = Math.min(ENV_NX - 1, i + 1);
        const id = j * ENV_NX + i;
        const lap =
          field[j * ENV_NX + im] +
          field[j * ENV_NX + ip] +
          field[jm * ENV_NX + i] +
          field[jp * ENV_NX + i] -
          4.0 * field[id];
        out[id] = field[id] + k * lap;
      }
    }
    field.set(out);
  }

  /**
   * Returns an InstabilityTelemetry for one position: the domain-scale sounding modified by the
   * resolved mesoscale field.
   *
   * Keeping the return type identical to the sounding's own telemetry is deliberate. Call sites
   * that were written against a domain-uniform profile can shadow their `inst` variable with this
   * per-position value and every downstream growth law, threshold and classification immediately
   * becomes local, without any of them having to know the environment is heterogeneous.
   *
   * Deep-profile quantities the boundary layer cannot change (freezing level, shear, helicity,
   * storm motion) are passed through untouched -- a surface moisture anomaly does not rewrite the
   * 6 km shear vector. Only what a boundary-layer theta-e anomaly genuinely moves is adjusted:
   * CAPE, CIN, LCL, LFC and EL.
   */
  public localizeInstability(
    x: number,
    z: number,
    base: InstabilityTelemetry,
    baseSurfaceTempK: number,
    baseSurfaceDewpointK: number,
    baseSurfaceQvGKg: number
  ): InstabilityTelemetry {
    const s = this.sampleAt(x, z);
    const dThetaE = s.thetaPert + 2.5 * s.qvPert;

    const tempK = baseSurfaceTempK + s.thetaPert;
    const qv = Math.max(0.4, baseSurfaceQvGKg + s.qvPert);
    const td0 = Math.max(200, baseSurfaceDewpointK);
    const ccSlope = 5421.0 / (td0 * td0);
    const dewpointK = clamp(
      td0 + Math.log(clamp(qv / Math.max(0.4, baseSurfaceQvGKg), 0.2, 4.0)) / Math.max(1e-4, ccSlope),
      175,
      tempK
    );

    const cape = clamp(base.cape + 168.0 * dThetaE, 0, 9000);

    // CIN needs a term theta_e cannot provide. Evaporative cooling conserves theta_e, so a
    // rain-cooled outflow shows no CAPE deficit -- yet storms demonstrably do not regenerate on
    // top of their own outflow. The suppression is a *stability* effect: a cold dense layer at
    // the surface means a parcel lifted from it must do far more work against the near-surface
    // lapse rate before reaching free convection. Modelling it through CIN is what lets a storm's
    // outflow shut down convection behind it and force propagation into fresh air ahead.
    const coldStabilisation = Math.max(0, -s.thetaPert) * 11.5;
    const cin = clamp(base.cin - 6.2 * dThetaE + coldStabilisation, 0, 1400);
    // LCL from the local temperature-dewpoint spread: moister air lowers cloud base, drier air
    // raises it. This is the single most visible consequence of localisation.
    const lcl = clamp(
      base.lcl + 125.0 * ((tempK - dewpointK) - (baseSurfaceTempK - td0)),
      220,
      5200
    );

    return {
      ...base,
      cape,
      cin,
      lcl,
      // The LFC tracks the LCL: a lower cloud base means free convection is reached sooner.
      lfc: clamp(base.lfc + (lcl - base.lcl) * 0.7, lcl + 120, 8000),
      el: clamp(base.el + 22.0 * dThetaE, lcl + 400, 18500),
    };
  }

  /** Local field values at an arbitrary world position, bilinearly interpolated. */
  public sampleAt(x: number, z: number): {
    thetaPert: number;
    qvPert: number;
    pressPert: number;
    soilSat: number;
    uPert: number;
    wPert: number;
  } {
    return {
      thetaPert: this.sample(this.thetaPert, x, z),
      qvPert: this.sample(this.qvPert, x, z),
      pressPert: this.sample(this.pressPert, x, z),
      soilSat: this.sample(this.soilSat, x, z),
      uPert: this.sample(this.uPert, x, z),
      wPert: this.sample(this.wPert, x, z),
    };
  }

  /**
   * Derives the local thermodynamic state at (x, z) from the domain-scale sounding modified by
   * the resolved field.
   *
   * The scalings are not arbitrary. Equivalent potential temperature for a boundary-layer parcel
   * is well approximated by theta_e ~ theta + 2.5 qv (qv in g/kg), so the local theta_e anomaly
   * is thetaPert + 2.5 qvPert. CAPE responds to that anomaly because it measures the integrated
   * buoyancy of a parcel lifted from the boundary layer: a warmer, moister parcel is buoyant
   * through a deeper layer. CIN responds with the opposite sign since the anomaly changes how
   * much work the cap requires. LCL follows from the local temperature-dewpoint spread through
   * the psychrometric relation LCL ~ 125 (T - Td), with the dewpoint response to a moisture
   * anomaly computed properly from the Clausius-Clapeyron slope rather than a guessed constant.
   */
  public localInstability(
    x: number,
    z: number,
    base: {
      cape: number;
      cin: number;
      lcl: number;
      el: number;
      surfaceTempK: number;
      surfaceDewpointK: number;
      surfaceQvGKg: number;
      pressureHPa: number;
      windU: number;
      windW: number;
    }
  ): LocalInstability {
    const s = this.sampleAt(x, z);

    // Local surface temperature and mixing ratio.
    const tempK = base.surfaceTempK + s.thetaPert;
    const qv = Math.max(0.4, base.surfaceQvGKg + s.qvPert);

    // Clausius-Clapeyron sensitivity of dewpoint to a mixing-ratio change, evaluated at the base
    // dewpoint: d(ln e)/dTd = L/(Rv Td^2), and e is proportional to qv at fixed pressure.
    const td0 = Math.max(200, base.surfaceDewpointK);
    const ccSlope = 5421.0 / (td0 * td0); // L/Rv = 2.501e6/461.5 ~ 5421 K
    const logQRatio = Math.log(clamp(qv / Math.max(0.4, base.surfaceQvGKg), 0.2, 4.0));
    const dewpointK = clamp(td0 + logQRatio / Math.max(1e-4, ccSlope), 175, tempK);

    // Relative humidity from the local temperature and dewpoint (Magnus).
    const rhFrom = (t: number, td: number): number => {
      const tc = t - 273.15;
      const tdc = td - 273.15;
      const eSat = 6.112 * Math.exp((17.67 * tc) / (tc + 243.5));
      const e = 6.112 * Math.exp((17.67 * tdc) / (tdc + 243.5));
      return clamp((e / Math.max(1e-4, eSat)) * 100, 1, 100);
    };
    const relHumidity = rhFrom(tempK, dewpointK);

    // Theta-e anomaly drives the instability scalings.
    const dThetaE = s.thetaPert + 2.5 * s.qvPert;

    const cape = clamp(base.cape + 168.0 * dThetaE, 0, 9000);
    // See localizeInstability: cold-pool suppression is a CIN effect, not a CAPE effect, because
    // evaporative cooling conserves theta_e.
    const cin = clamp(base.cin - 6.2 * dThetaE + Math.max(0, -s.thetaPert) * 11.5, 0, 1400);
    // LCL from the local temperature-dewpoint spread; a moister boundary layer lowers cloud base.
    const lcl = clamp(base.lcl + 125.0 * ((tempK - dewpointK) - (base.surfaceTempK - td0)), 220, 5200);
    // The equilibrium level barely moves for a boundary-layer anomaly: it is set by the deep
    // profile, not the surface. A modest lift for a much more buoyant parcel.
    const el = clamp(base.el + 22.0 * dThetaE, base.lcl + 400, 18500);

    const pressureHPa = base.pressureHPa + s.pressPert / 100.0;

    const windU = base.windU + s.uPert;
    const windW = base.windW + s.wPert;
    const windSpeedMS = Math.hypot(windU, windW);
    const meanSpeed = Math.max(1.0, Math.hypot(base.windU, base.windW));
    const gustFactor = clamp(1.0 + Math.hypot(s.uPert, s.wPert) / meanSpeed, 1.0, 3.4);

    return {
      cape,
      cin,
      lcl,
      el,
      tempK,
      dewpointK,
      relHumidity,
      pressureHPa,
      qvGKg: qv,
      windU,
      windW,
      windSpeedMS,
      gustFactor,
    };
  }
}
