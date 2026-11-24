import {
  AtmosphericSounding,
  saturationMixingRatioIce,
  saturationMixingRatioLiquid,
} from './thermodynamics';
import { AtmosphereConfig, ConvectiveCell, PHYS, PrecipitationType } from './types';

export interface CellMicrophysicsStepOutput {
  latentHeatingKPerS: number;
  subCloudCoolingKPerS: number;
  precipLoadingDragMS2: number;
  rimingRateGKgPerS: number; // feeds Takahashi non-inductive charging!
  /** Net vapor -> condensate supply (g/kg of column air per s). Bounded by the sounding. */
  condensateSupplyGKgPerS: number;
  /** Condensate returned to vapor by entrainment mixing + sub-cloud evaporation. */
  evaporatedGKgPerS: number;
  /** Total hydrometeor mass leaving the column base (g/kg per s), before sub-cloud evaporation. */
  precipFalloutGKgPerS: number;
  /** Mass-weighted terminal fall speed of the precipitating categories (m/s). */
  bulkFallSpeedMS: number;
  /** Mass-weighted terminal fall speed of rain alone (m/s) — drives streak rendering. */
  rainFallSpeedMS: number;
  /** Fraction of falling rain that evaporates below cloud base (virga). */
  subCloudEvapFraction: number;
  totalSuspendedGKg: number;
  totalPrecipGKg: number;
  /** Mean droplet/ice effective radius (µm) implied by the condensate — used for optics. */
  effectiveRadiusUm: number;
  /** Liquid mass flux actually reaching the surface (kg m^-2 s^-1); 1 kg m^-2 h^-1 == 1 mm/h. */
  surfaceLiquidFluxKgM2S: number;
  /** Frozen mass flux reaching the surface (kg m^-2 s^-1). */
  surfaceFrozenFluxKgM2S: number;
  /** q_ceiling / q_adiabatic: how much of the adiabatic condensate survives entrainment. */
  condensateEfficiency: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Bulk terminal fall speeds (mass-weighted, air-density corrected).
 * Follows the standard Lin-et-al. style power laws V_t = a (rho q)^b with the
 * (rho_0/rho)^0.5 expansion correction, clamped to observed hydrometeor ranges.
 */
export function terminalFallSpeedRainMS(qGKg: number, rho: number): number {
  if (qGKg <= 1e-5) return 0;
  const v = 14.34 * Math.pow(Math.max(1e-7, qGKg * 1e-3 * rho), 0.135);
  return clamp(v, 0.8, 11.0);
}

export function terminalFallSpeedSnowMS(qGKg: number, rho: number): number {
  if (qGKg <= 1e-5) return 0;
  const v = 1.15 * Math.pow(Math.max(1e-7, qGKg * 1e-3 * rho), 0.09) * Math.sqrt(1.2 / rho);
  return clamp(v, 0.3, 2.6);
}

export function terminalFallSpeedGraupelMS(qGKg: number, rho: number): number {
  if (qGKg <= 1e-5) return 0;
  const v = 6.0 * Math.pow(Math.max(1e-7, qGKg * 1e-3 * rho), 0.11) * Math.sqrt(1.2 / rho);
  return clamp(v, 1.2, 9.0);
}

export function terminalFallSpeedHailMS(qGKg: number, rho: number): number {
  if (qGKg <= 1e-5) return 0;
  const v = 18.0 * Math.pow(Math.max(1e-7, qGKg * 1e-3 * rho), 0.12) * Math.sqrt(1.2 / rho);
  return clamp(v, 4.0, 26.0);
}

/**
 * Melting fraction of an ice hydrometeor falling from `sourceHeightM` through the
 * sub-freezing isotherm: first-order in the warm-layer temperature excess and the
 * time the particle actually spends below 0 °C.
 */
function meltFraction(sourceHeightM: number, fallSpeedMS: number, freezeZ: number, warmDeltaK: number, kMelt: number): number {
  if (freezeZ <= 60 || fallSpeedMS <= 0.05 || warmDeltaK <= 0.05) return 0;
  const warmPathM = Math.min(sourceHeightM, freezeZ);
  const timeInWarmLayer = warmPathM / fallSpeedMS;
  return 1.0 - Math.exp(-kMelt * warmDeltaK * timeInWarmLayer);
}

/**
 * Steps the 8-compartment bulk cloud microphysics of one convective column.
 *
 * Design notes (why this version cannot run away):
 *  - The condensate reservoirs (cloud water, supercooled water, cloud ice) relax toward a
 *    ceiling derived from the sounding itself: the adiabatic condensate a saturated parcel
 *    would carry from cloud base to cloud top, multiplied by the entrainment dilution
 *    factor exp(-eps * depth). That ceiling is a few g/kg for a deep convective column,
 *    matching aircraft observations, instead of being an open-ended source term.
 *  - Every precipitating category is fed only by first-order conversions out of those
 *    reservoirs. For a reservoir relaxed with time constant tau and drained at rate k,
 *    the steady-state throughput is ceiling / (tau + 1/k) <= ceiling / tau, i.e. no
 *    downstream flux can ever exceed the vapor supply. Rain rates therefore stay in the
 *    observed 0.1-150 mm/h range instead of diverging.
 *  - Sedimentation is a mass flux q * V_t / H, and the surface rain rate is computed from
 *    that same flux, so the reported rain rate is consistent with the mass actually
 *    leaving the column (and with the cold-pool source term).
 */
export function stepCellMicrophysics(
  cell: ConvectiveCell,
  dt: number,
  sounding: AtmosphericSounding,
  cfg: AtmosphereConfig,
  /**
   * Height over which the condensation supply is evaluated. Defaults to the visible cloud top;
   * the cell manager passes the plume's top instead, because the air rising through the cell
   * has already been processed over the plume's depth even when the visible tower has not yet
   * grown into it.
   */
  supplyTopM?: number
): CellMicrophysicsStepOutput {
  const inst = sounding.instability;
  const freezeZ = inst.freezingLevel;
  const homoZ = inst.homogeneousFreezeLevel;
  const baseZ = cell.cloudBaseM;
  const topZ = cell.cloudTopM;
  const depth = Math.max(200, topZ - baseZ);
  const stepDt = Math.max(1e-4, dt);

  // ---------------- 0. No condensed cloud yet: residual condensate evaporates ----------------
  if (topZ <= baseZ + 60) {
    const rhMid = clamp(sounding.relativeHumidityAt(Math.max(120, baseZ)), 0.05, 1.0);
    const evapRate = 0.010 + 0.085 * (1.0 - rhMid); // 1/s
    const evapFrac = 1.0 - Math.exp(-evapRate * stepDt);
    // Each reservoir is drained by its own fraction of the *combined* ice mass, and the split
    // is taken in proportion to what is actually there. Scaling cloud ice by the total
    // (ice + snow) removed more ice than the reservoir held and drove it negative while snow
    // absorbed the whole loss.
    const iceTotal = cell.cloudIceGKg + cell.snowGKg;
    const goneIce = iceTotal > 1e-9 ? iceTotal * evapFrac : 0;
    const iceShare = iceTotal > 1e-9 ? cell.cloudIceGKg / iceTotal : 0;
    const goneCloudIce = goneIce * iceShare;
    const goneSnow = goneIce * (1.0 - iceShare);
    const goneCloud = cell.cloudWaterGKg * evapFrac;
    const goneSlw = cell.supercooledWaterGKg * evapFrac;
    cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg - goneCloud);
    cell.supercooledWaterGKg = Math.max(0, cell.supercooledWaterGKg - goneSlw);
    cell.cloudIceGKg = Math.max(0, cell.cloudIceGKg - goneCloudIce);
    cell.snowGKg = Math.max(0, cell.snowGKg - goneSnow);

    const rhoLow = Math.max(0.2, sounding.densityAt(Math.max(60, baseZ * 0.4)));
    const vRain = terminalFallSpeedRainMS(cell.rainGKg, rhoLow);
    const rainGone = cell.rainGKg * (1.0 - Math.exp(-(0.004 + vRain / Math.max(700, baseZ)) * stepDt));
    cell.rainGKg = Math.max(0, cell.rainGKg - rainGone);

    const evaporatedTotal = goneCloud + goneSlw + goneIce + rainGone;
    cell.cumEvaporatedGKg += evaporatedTotal;
    cell.vaporExcessGKg = Math.max(0, sounding.qSatGKgAt(baseZ) * (1.0 - rhMid));
    cell.surfaceRainRateMMHr = 0;
    cell.virgaFraction = 0;
    cell.precipType = 'None';

    const latentJPerKg = evaporatedTotal * 1e-3 * PHYS.L_V;
    return {
      latentHeatingKPerS: -latentJPerKg / PHYS.CP / stepDt,
      subCloudCoolingKPerS: 0,
      precipLoadingDragMS2: PHYS.G * (cell.rainGKg + cell.graupelGKg + cell.hailGKg) * 1e-3,
      rimingRateGKgPerS: 0,
      condensateSupplyGKgPerS: 0,
      evaporatedGKgPerS: evaporatedTotal / stepDt,
      precipFalloutGKgPerS: 0,
      bulkFallSpeedMS: vRain,
      rainFallSpeedMS: vRain,
      subCloudEvapFraction: 0,
      totalSuspendedGKg: cell.cloudWaterGKg + cell.supercooledWaterGKg + cell.cloudIceGKg,
      totalPrecipGKg: cell.rainGKg + cell.snowGKg + cell.graupelGKg + cell.hailGKg,
      effectiveRadiusUm: 8,
      surfaceLiquidFluxKgM2S: 0,
      surfaceFrozenFluxKgM2S: 0,
      condensateEfficiency: 0,
    };
  }

  const w = Math.max(0, cell.updraftMaxMS);

  // ---------------- 1. Entrainment, dilution ceiling and column residence time ----------------
  // Observed lateral entrainment: ~1-3 km^-1 for shallow cumulus, 0.1-0.5 km^-1 for the
  // cores of deep convective towers. eps ~ 0.1 + 0.62/R captures that radius dependence.
  // Must match the plume's own entrainment law, or the two models disagree about how much
  // condensate the column can hold. eps = a/R + floor, with a = 0.055 for a convective core,
  // is 0.11 km⁻¹ at R = 2 km and 0.2 at 500 m — the range observed in deep towers. The old
  // form (0.075 + 0.34/R) is a *shallow cumulus* law and diluted a 3 km core at 0.19 km⁻¹
  // against the plume's 0.04, which let the microphysical ceiling sit ~5x above what the
  // precipitation could drain.
  const radiusKm = Math.max(0.22, cell.radiusM * 1e-3);
  const epsKmInv = clamp(0.04 + 0.055 / radiusKm, 0.06, 1.2);
  cell.entrainmentRate = epsKmInv;

  const supplyTopZ = Math.max(topZ, Math.min(supplyTopM ?? topZ, sounding.levels[sounding.levels.length - 1].z));
  // Transit time through the *supplying* depth, which is what sets how fast the condensate
  // reservoirs fill. Bounded so a stalled cell still relaxes and a fast one does not overshoot.
  const supplyDepth = Math.max(300, supplyTopZ - baseZ);
  // Transit time is ∫dz/w, not (depth / w_at_top). The updraft is *slowest* near cloud base —
  // 2-4 m/s just above the LFC — and accelerates to 20-30 m/s at mid levels, so the layer-mean
  // speed is roughly a third of the peak. Using the top speed made the reservoir fill 2-3x too
  // fast: the condensate ceiling was reached in ~150 s instead of the 6-8 minutes a real
  // updraft takes to process that depth, which left every mature cell with a rain reservoir
  // three times what its own sedimentation could drain.
  const meanUpdraftMS = Math.max(1.2, 0.42 * w);
  const tauResidence = clamp(supplyDepth / meanUpdraftMS, 120, 2400); // s, base -> top transit
  // A convective column does not retain all the condensate it produces: precipitation
  // efficiency (the fraction of the condensate that reaches the ground rather than being
  // re-evaporated by entrained dry air) is 0.4-0.6 in a typical mid-latitude thunderstorm, and
  // only the retained part belongs in the *suspended* reservoirs. Without this factor
  // `qCeiling` is an adiabatic-with-dilution integral, i.e. the mass condensed, not the mass
  // held, and the rain reservoir equilibrates at ~4 g/kg against a 5.2 g/kg cap: every mature
  // cell sat pinned near the ceiling and read 140-160 mm/h regardless of its actual supply.
  const precipEfficiency = clamp(0.30 + 0.5 * (1.0 - Math.exp(-w / 14.0)), 0.32, 0.72);
  const relax = (1.0 - Math.exp(-stepDt / tauResidence)) * precipEfficiency;

  // Strict physical ceiling: the adiabatic condensate a saturated parcel produces over the
  // cloud depth. Entrainment dilutes a *parcel* along the path it actually travels, and the
  // condensate that reaches a given level was produced over the layer below it — not over the
  // whole tower. Applying exp(-eps * full depth) to the column integral instead suppressed
  // deep clouds almost completely (0.02 at 13 km), which is why tall towers stopped raining.
  //
  // The physically consistent form weights each layer's production by the dilution it has
  // suffered on the way up:
  //     q_eff = INT_base^top  (dq_c/dz) * exp(-eps * (z - base)) dz
  const qCeilingGKg = dilutedAdiabaticCondensate(sounding, baseZ, supplyTopZ, epsKmInv);
  // Undiluted column condensate, kept for diagnostics (condensation efficiency).
  const qAdiabaticGKg = sounding.adiabaticCondensateGKg(baseZ, supplyTopZ);
  const condensateEfficiency = qAdiabaticGKg > 1e-6 ? clamp(qCeilingGKg / qAdiabaticGKg, 0.02, 1.0) : 1.0;

  // ---------------- 2. Phase partition, weighted by where condensate is actually produced ----
  // The layer that matters is the one the *supply* came from, not the visible tower: `qCeiling`
  // is an integral from cloud base to the plume's top, so partitioning it by the phase
  // distribution over the (lagging, therefore shorter) visible tower mixed two different depths.
  // On a 9 km cell whose top sat at the freezing level that put ~100 % of a 9 g/kg ceiling into
  // warm cloud water, which the rain reservoir's 5.2 g/kg cap could not drain and which therefore
  // saturated every mature cell at the cap.
  const SAMPLES = 6;
  let weightSum = 0;
  let warmWeight = 0;
  let mixedWeight = 0;
  let glaciatedWeight = 0;
  let iceWeightInMixed = 0;
  for (let k = 0; k < SAMPLES; k++) {
    const z = baseZ + (supplyDepth * (k + 0.5)) / SAMPLES;
    const production = sounding.condGKgPerKmAt(z);
    if (production <= 1e-9) continue;
    const tempC = sounding.tempCAt(z);
    weightSum += production;
    if (tempC >= 0) {
      warmWeight += production;
    } else if (tempC > -38) {
      mixedWeight += production;
      // INP activation is strongly nonlinear in temperature (Fletcher-like).
      iceWeightInMixed += production * Math.pow(Math.min(1, -tempC / 38.0), 1.6);
    } else {
      glaciatedWeight += production;
    }
  }
  if (weightSum <= 1e-9) {
    warmWeight = 1;
    weightSum = 1;
  }
  const fracWarm = warmWeight / weightSum;
  const fracMixed = mixedWeight / weightSum;
  const fracGlaciated = glaciatedWeight / weightSum;
  const fracIceOfMixed = fracMixed > 1e-6 ? iceWeightInMixed / mixedWeight : 0;

  const eqCloudGKg = qCeilingGKg * fracWarm;
  const eqSlwGKg = qCeilingGKg * fracMixed * (1.0 - fracIceOfMixed);
  const eqIceGKg = qCeilingGKg * (fracGlaciated + fracMixed * fracIceOfMixed);

  // ---------------- 3. Condensation / dilution-evaporation of the suspended reservoirs -------
  const dCloud = (eqCloudGKg - cell.cloudWaterGKg) * relax;
  const dSlw = (eqSlwGKg - cell.supercooledWaterGKg) * relax;
  const dIce = (eqIceGKg - cell.cloudIceGKg) * relax;

  const grossCondGKg = Math.max(0, dCloud) + Math.max(0, dSlw) + Math.max(0, dIce);
  const grossDilutionEvapGKg = Math.max(0, -dCloud) + Math.max(0, -dSlw) + Math.max(0, -dIce);

  cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg + dCloud);
  cell.supercooledWaterGKg = Math.max(0, cell.supercooledWaterGKg + dSlw);
  cell.cloudIceGKg = Math.max(0, cell.cloudIceGKg + dIce);

  // Latent heat: vapor->liquid releases L_v, vapor->ice releases L_s, freezing releases L_f.
  let latentJPerKg =
    (Math.max(0, dCloud) + Math.max(0, dSlw)) * 1e-3 * PHYS.L_V +
    Math.max(0, dIce) * 1e-3 * PHYS.L_S -
    (Math.max(0, -dCloud) + Math.max(0, -dSlw)) * 1e-3 * PHYS.L_V -
    Math.max(0, -dIce) * 1e-3 * PHYS.L_S;

  // ---------------- 4. Bergeron-Findeisen + homogeneous freezing ----------------
  const mixedLevelZ = clamp(0.5 * (freezeZ + Math.min(topZ, freezeZ + 3200)), baseZ, topZ);
  const mixedTempK = sounding.tempKAt(mixedLevelZ);
  const mixedPressPa = sounding.pressurePaAt(mixedLevelZ);
  let freezingJPerKg = 0;

  if (cell.supercooledWaterGKg > 1e-4 && cell.cloudTopM > freezeZ + 250) {
    const qsl = saturationMixingRatioLiquid(mixedTempK, mixedPressPa);
    const qsi = Math.max(1e-9, saturationMixingRatioIce(mixedTempK, mixedPressPa));
    const iceSupersaturation = clamp(qsl / qsi - 1.0, 0, 0.35);
    // Dendritic growth window near -15 °C is where ice grows fastest at SLW expense.
    const dendriticBoost = 0.55 + 1.25 * Math.exp(-Math.pow((mixedTempK - 258.15) / 7.5, 2));
    const kBergeron =
      9.0e-4 *
      (0.4 + iceSupersaturation * 9.0) *
      dendriticBoost *
      (cell.cloudIceGKg / (cell.cloudIceGKg + 0.06));
    const dBergeron = Math.min(
      cell.supercooledWaterGKg * 0.5,
      cell.supercooledWaterGKg * (1.0 - Math.exp(-kBergeron * stepDt))
    );
    cell.supercooledWaterGKg -= dBergeron;
    cell.cloudIceGKg += dBergeron;
    freezingJPerKg += dBergeron * 1e-3 * PHYS.L_F;

    // Homogeneous freezing of the remainder above the -38 °C isotherm.
    if (cell.cloudTopM > homoZ) {
      const overShoot = clamp((cell.cloudTopM - homoZ) / 1600.0, 0, 1.6);
      const kHomo = 0.012 + 0.09 * overShoot; // 1/s
      const dHomo = cell.supercooledWaterGKg * (1.0 - Math.exp(-kHomo * stepDt));
      cell.supercooledWaterGKg -= dHomo;
      cell.cloudIceGKg += dHomo;
      freezingJPerKg += dHomo * 1e-3 * PHYS.L_F;
    }
  }

  // ---------------- 5. Ice -> snow aggregation ----------------
  if (cell.cloudIceGKg > 0.03) {
    const aggTempFactor =
      0.45 + 1.35 * Math.exp(-Math.pow((mixedTempK - 258.15) / 9.0, 2));
    const kAgg = 1.35e-3 * aggTempFactor * clamp(cell.cloudIceGKg / 0.18, 0.25, 1.6);
    const dAgg = Math.min(
      cell.cloudIceGKg * 0.55,
      cell.cloudIceGKg * (1.0 - Math.exp(-kAgg * stepDt))
    );
    cell.cloudIceGKg -= dAgg;
    cell.snowGKg += dAgg;
  }

  // ---------------- 6. Riming (SLW + ice/snow -> graupel) and wet hail growth ----------------
  let rimingRateGKgPerS = 0;
  const collectors = cell.snowGKg + cell.graupelGKg * 1.15 + cell.cloudIceGKg * 0.28;
  if (cell.supercooledWaterGKg > 0.03 && collectors > 0.02) {
    // Collision kernel ~ liquid water content x collector surface area, temperature limited.
    const tempWindow = clamp(0.35 + 1.25 * Math.exp(-Math.pow((mixedTempK - 261.15) / 9.0, 2)), 0.2, 1.7);
    const kRime =
      3.4e-3 *
      cfg.rimingEfficiency *
      tempWindow *
      clamp(collectors / 0.5, 0.15, 2.4) *
      clamp(0.4 + w / 16.0, 0.3, 2.0);
    rimingRateGKgPerS = Math.min(cell.supercooledWaterGKg, kRime * cell.supercooledWaterGKg * stepDt) / stepDt;
    const dRime = rimingRateGKgPerS * stepDt;
    cell.supercooledWaterGKg -= dRime;
    // Rimed collectors become graupel; some snow embryos are converted along with the rime.
    const snowConverted = Math.min(cell.snowGKg * 0.4, dRime * 0.55);
    cell.snowGKg -= snowConverted;
    cell.graupelGKg += dRime + snowConverted;
    freezingJPerKg += (dRime + snowConverted) * 1e-3 * PHYS.L_F;

    // Wet growth into hail needs a strong updraft able to suspend growing stones plus
    // abundant supercooled water (the classic 1 g/kg + 15 m/s hail criterion).
    if (w > 12.0 && cell.graupelGKg > 0.22 && cell.supercooledWaterGKg > 0.18) {
      const hailVigor = clamp((w - 12.0) / 20.0, 0, 1.4) * clamp(cell.supercooledWaterGKg / 0.6, 0.15, 1.6);
      const kHail = 2.6e-3 * hailVigor;
      const dHail = Math.min(
        cell.graupelGKg * 0.45,
        cell.graupelGKg * (1.0 - Math.exp(-kHail * stepDt))
      );
      const slwAccreted = Math.min(cell.supercooledWaterGKg * 0.35, dHail * 0.55);
      cell.graupelGKg -= dHail;
      cell.supercooledWaterGKg -= slwAccreted;
      cell.hailGKg += dHail + slwAccreted;
      freezingJPerKg += (dHail + slwAccreted) * 1e-3 * PHYS.L_F;
    }
  }

  // ---------------- 7. Warm rain: Kessler autoconversion + collision-coalescence accretion ----
  // Clean-cloud autoconversion threshold rises with CCN (more, smaller droplets).
  const autoThresholdGKg = 0.52 * Math.pow(clamp(cfg.ccnConcentration, 0.3, 3.0), 0.45);
  let dAuto = 0;
  if (cell.cloudWaterGKg > autoThresholdGKg) {
    dAuto = Math.min(
      cell.cloudWaterGKg - autoThresholdGKg,
      1.5e-3 * (cell.cloudWaterGKg - autoThresholdGKg) * stepDt
    );
  }
  // Kessler accretion in g/kg units: 2.2 (Qr Qc)^(7/8) with Q in kg/kg == 0.0124 (qr qc)^0.875,
  // with a modest convective-collection enhancement.
  let dAccrete =
    cell.rainGKg > 1e-4 && cell.cloudWaterGKg > 1e-4
      ? Math.min(
          cell.cloudWaterGKg - dAuto,
          0.021 * Math.pow(cell.rainGKg * cell.cloudWaterGKg, 0.875) * stepDt
        )
      : 0;
  // ---- Rain-water carrying capacity ------------------------------------------------------
  // A rain shaft has a finite capacity: beyond ~5 g/kg the drops are big enough that
  // collection outruns supply. The ceiling is applied by *throttling production*, not by
  // clamping the reservoir — a clamp has to dump the excess somewhere, and dumping it into
  // the fallout term produced a single-step surface rate of 300,000 mm/h. Throttling keeps the
  // water budget exact (the surplus simply stays as cloud water until it can be collected)
  // and keeps the reservoir inside the renderer's 7 g/kg precipitation LUT.
  const RAIN_MAX_GKG = 5.2;
  const headroom = Math.max(0, RAIN_MAX_GKG - cell.rainGKg);
  const produced = dAuto + dAccrete;
  const accepted = Math.min(produced, headroom);
  const throttle = produced > 1e-9 ? accepted / produced : 1;
  dAuto *= throttle;
  dAccrete *= throttle;
  cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg - dAuto - dAccrete);
  cell.rainGKg += dAuto + dAccrete;

  // Ice crystal sublimation in dry entrained air (anvil edges, dissipating towers).
  const rhIceMid = clamp(sounding.relativeHumidityAt(mixedLevelZ), 0.05, 1.0);
  if (rhIceMid < 0.93 && topZ > freezeZ) {
    const kSub = 2.4e-4 * (1.0 - rhIceMid) * 6.0;
    const dSub = Math.min(cell.cloudIceGKg * 0.4, cell.cloudIceGKg * (1.0 - Math.exp(-kSub * stepDt)));
    cell.cloudIceGKg = Math.max(0, cell.cloudIceGKg - dSub);
    latentJPerKg -= dSub * 1e-3 * PHYS.L_S;
    cell.cumEvaporatedGKg += dSub;
  }

  // ---------------- 8. Sedimentation, melting and sub-cloud evaporation ----------------
  const rhoMid = Math.max(0.18, sounding.densityAt(0.5 * (baseZ + Math.min(topZ, freezeZ + 2000))));
  const rhoSurface = Math.max(0.3, sounding.densityAt(Math.max(30, baseZ * 0.25)));

  const vRain = terminalFallSpeedRainMS(cell.rainGKg, rhoMid);
  const vSnow = terminalFallSpeedSnowMS(cell.snowGKg, rhoMid);
  const vGraupel = terminalFallSpeedGraupelMS(cell.graupelGKg, rhoMid);
  const vHail = terminalFallSpeedHailMS(cell.hailGKg, rhoMid);

  // Fall path length for each category: the distance from where it is *held* to the ground,
  // which is what sets both the fallout time scale and how much of the path lies below the
  // 0 °C isotherm.
  //
  // For rain this is the whole column, not the depth of some mid-level reservoir. Rain is
  // produced aloft and leaves the cell at cloud base; treating it as a well-mixed layer whose
  // bottom sits at 0.42·depth meant a 4 km tower with 4.5 g/kg of rain drained at
  // v/h ≈ 1.7e-3 s⁻¹ — a 10-minute residence time — so the reservoir saturated against its
  // carrying ceiling and stayed there. The shaft then read 5.2 g/kg (the ceiling) with a
  // surface rate that bore no relation to the mass actually in the column.
  const hRain = Math.max(900, baseZ + depth * 0.55);
  const hSnow = Math.max(800, 0.5 * (Math.max(baseZ, freezeZ) + Math.min(topZ, Math.max(baseZ, freezeZ) + 3200)));
  const hGraupel = Math.max(1000, Math.min(topZ - 300, freezeZ + 900));
  const hHail = Math.max(1200, Math.min(topZ - 300, freezeZ + 1400));

  const fallRain = cell.rainGKg * (1.0 - Math.exp(-(vRain / hRain) * stepDt));
  const fallSnow = cell.snowGKg * (1.0 - Math.exp(-(vSnow / hSnow) * stepDt));
  const fallGraupel = cell.graupelGKg * (1.0 - Math.exp(-(vGraupel / hGraupel) * stepDt));
  const fallHail = cell.hailGKg * (1.0 - Math.exp(-(vHail / hHail) * stepDt));

  // Warm-layer temperature excess for melting (mean temperature between ground and 0 °C level).
  const warmDeltaK = Math.max(0, sounding.tempKAt(Math.max(60, freezeZ * 0.45)) - PHYS.T_FREEZE);
  const meltSnow = meltFraction(hSnow, vSnow, freezeZ, warmDeltaK, 7.0e-4);
  const meltGraupel = meltFraction(hGraupel, vGraupel, freezeZ, warmDeltaK, 3.0e-4);
  const meltHail = meltFraction(hHail, vHail, freezeZ, warmDeltaK, 1.2e-4);

  // ---- Convert the reservoir drain into a true column mass flux -------------------------
  // Each category is treated as a well-mixed layer of depth h falling at its own terminal
  // speed, so draining dq (g/kg) out of that layer in stepDt removes
  //     dM = rho * dq/1000 * h      [kg m^-2]
  // of water from the column. Dividing by stepDt gives the mass flux, and since
  // 1 kg m^-2 h^-1 == 1 mm/h, the surface rate is flux * 3600. Getting the h factor right is
  // what makes 6 g/kg of suspended rain read as a torrential shaft instead of a drizzle.
  const invDt = 1.0 / stepDt;
  const columnMassFlux = (dqGKg: number, hM: number, rho: number) =>
    rho * (dqGKg * 1e-3) * hM * invDt; // kg m^-2 s^-1

  const fluxRain = columnMassFlux(fallRain, hRain, rhoSurface);
  // The carrying cap has to hold for *every* source, not only for autoconversion: the ice
  // categories drain into rain via melting in step 9, and a heavy melting shaft can push the
  // reservoir past the ceiling on its own.
  //
  // The overflow is *precipitated out*, not recycled. Returning it to cloud water (the obvious
  // move, since cloud water is the rain reservoir's parent) closes the water budget but creates
  // a positive feedback: the cloud water then re-autoconverts into rain on the next step, which
  // overflows again, and the cell settles with cloud water and rain both pinned at their
  // ceilings — which is exactly the 5.199 g/kg every mature cell was reporting.
  //
  // Physically the truncation represents drops large enough that collection outruns supply, and
  // those drops fall out. So the excess is counted as fallout and leaves the column.
  let rainOverflowGKg = 0;
  if (cell.rainGKg > RAIN_MAX_GKG) {
    rainOverflowGKg = cell.rainGKg - RAIN_MAX_GKG;
    cell.rainGKg = RAIN_MAX_GKG;
  }
  const fluxSnow = columnMassFlux(fallSnow, hSnow, rhoSurface);
  const fluxGraupel = columnMassFlux(fallGraupel, hGraupel, rhoSurface);
  const fluxHail = columnMassFlux(fallHail, hHail, rhoSurface);

  // Ice that melts en route joins the rain shaft; the remainder reaches the ground frozen.
  const meltedFlux = fluxSnow * meltSnow + fluxGraupel * meltGraupel + fluxHail * meltHail;
  const frozenSurfaceFlux =
    fluxSnow * (1.0 - meltSnow) + fluxGraupel * (1.0 - meltGraupel) + fluxHail * (1.0 - meltHail);

  cell.rainGKg = Math.max(0, cell.rainGKg - fallRain);
  cell.snowGKg = Math.max(0, cell.snowGKg - fallSnow);
  cell.graupelGKg = Math.max(0, cell.graupelGKg - fallGraupel);
  cell.hailGKg = Math.max(0, cell.hailGKg - fallHail);

  // Sub-cloud evaporation of the rain shaft: bulk ventilation parameterisation
  //   dqr/dt = -k (1 - RH) qr^0.65, k scaled by vapor diffusivity ~ T^1.8 / p.
  const subCloudZ = Math.max(80, baseZ * 0.5);
  const rhSub = clamp(sounding.relativeHumidityAt(subCloudZ), 0.03, 1.0);
  const tSubK = Math.max(200, sounding.tempKAt(subCloudZ));
  const pSubPa = Math.max(20000, sounding.pressurePaAt(subCloudZ));
  const kEvap =
    1.6e-3 *
    (1.0 - rhSub) *
    Math.pow(tSubK / 293.0, 1.8) *
    (101325.0 / pSubPa) *
    Math.sqrt(1.2 / rhoSurface);
  const subCloudFallTime = baseZ / Math.max(0.7, vRain);
  // Thicker shafts saturate the sub-cloud layer, so the evaporated *fraction* falls as the
  // rain rate rises — that is the difference between virga and a downpour.
  const shaftLoading = clamp((cell.rainGKg + fallRain) / 1.4, 0.05, 1.0);
  const evapFraction = clamp(
    (1.0 - Math.exp(-kEvap * Math.pow(shaftLoading, -0.55) * subCloudFallTime)) *
      (1.15 - 0.45 * shaftLoading),
    0,
    0.985
  );
  const hasRainShaft = cell.rainGKg > 0.008 || fallRain > 1e-4 || meltedFlux > 1e-7;
  cell.virgaFraction = hasRainShaft ? evapFraction : 0;

  // ---------------- 9. Surface precipitation rates (mm/h liquid equivalent) ----------------
  // Only the liquid flux that survives sub-cloud evaporation reaches the ground as rain; the
  // rest returns to vapour and is accounted for as evaporated, never as fallout. Counting it
  // in both terms was what broke the column water budget.
  const evaporatedFlux = (fluxRain + meltedFlux) * evapFraction;
  const reachingLiquidFlux = fluxRain + meltedFlux - evaporatedFlux;
  const reachingTotalFlux = reachingLiquidFlux + frozenSurfaceFlux;

  cell.surfaceRainRateMMHr = Math.max(0, reachingTotalFlux * 3600.0);
  const frozenSurfaceRateMMHr = frozenSurfaceFlux * 3600.0;

  // ---- Cumulative water budget, all in g/kg of column air -------------------------------
  // The reservoirs were drained by (fallRain + fallSnow + fallGraupel + fallHail) g/kg this
  // step. That mass either reaches the surface or evaporates below cloud base; splitting it
  // by the evaporated *fraction of the liquid flux* keeps the two terms exactly complementary
  // so cumCondensed == inventory + cumFallout + cumEvaporated to round-off.
  const drainedGKg = fallRain + fallSnow + fallGraupel + fallHail + rainOverflowGKg;
  const liquidDrainedGKg =
    fallRain + rainOverflowGKg + fallSnow * meltSnow + fallGraupel * meltGraupel + fallHail * meltHail;
  const evaporatedGKg = drainedGKg > 1e-12 ? liquidDrainedGKg * evapFraction : 0;
  cell.cumFalloutGKg += drainedGKg - evaporatedGKg;
  cell.cumEvaporatedGKg += evaporatedGKg + grossDilutionEvapGKg;

  // Evaporation and melting cool the sub-cloud layer of depth ~baseZ, not the whole column.
  const meltJPerKg = meltedFlux * stepDt * PHYS.L_F;
  const evapJPerKg = evaporatedFlux * stepDt * PHYS.L_V;
  const subCloudMassKgM2 = Math.max(60, rhoSurface * Math.max(300, baseZ));
  const subCloudCoolingKPerS = (evapJPerKg + meltJPerKg * 0.85) / (PHYS.CP * subCloudMassKgM2);
  cell.cumCondensedGKg += grossCondGKg;
  cell.vaporExcessGKg = Math.max(0, sounding.qSatGKgAt(baseZ) * (1.0 - rhSub));

  // ---------------- 10. Diagnostics consumed by dynamics, electrification and rendering ------
  const suspendedGKg = cell.cloudWaterGKg + cell.supercooledWaterGKg + cell.cloudIceGKg;
  const precipGKg = cell.rainGKg + cell.snowGKg + cell.graupelGKg + cell.hailGKg;

  // Condensate weighting for effective radius: e-re grows with LWC but saturates (autoconversion).
  const effectiveRadiusUm = clamp(6.5 + 9.0 * Math.pow(clamp(suspendedGKg, 0, 4.0), 0.42), 5, 26);

  // Gravitational loading: precipitating mass loads fully, suspended condensate partially
  // (small droplets are carried by the updraft but still add inertia).
  const precipLoadingDragMS2 =
    PHYS.G * (precipGKg + 0.35 * suspendedGKg + 0.5 * (cell.snowGKg + cell.graupelGKg)) * 1e-3;

  const bulkFallSpeedMS =
    precipGKg > 1e-4
      ? (cell.rainGKg * vRain + cell.snowGKg * vSnow + cell.graupelGKg * vGraupel + cell.hailGKg * vHail) /
        precipGKg
      : 0;

  cell.precipType = classifyCellPrecipitation(
    cell.rainGKg,
    cell.hailGKg,
    cell.graupelGKg,
    cell.snowGKg,
    cell.surfaceRainRateMMHr,
    cell.virgaFraction,
    freezeZ,
    frozenSurfaceRateMMHr
  );

  return {
    latentHeatingKPerS: (latentJPerKg + freezingJPerKg) / PHYS.CP / stepDt,
    subCloudCoolingKPerS: Math.max(0, subCloudCoolingKPerS),
    precipLoadingDragMS2: Math.max(0, precipLoadingDragMS2),
    rimingRateGKgPerS,
    condensateSupplyGKgPerS: grossCondGKg / stepDt,
    evaporatedGKgPerS: (grossDilutionEvapGKg + evaporatedGKg) / stepDt,
    precipFalloutGKgPerS: (drainedGKg - evaporatedGKg) / stepDt,
    surfaceLiquidFluxKgM2S: reachingLiquidFlux,
    surfaceFrozenFluxKgM2S: frozenSurfaceFlux,
    bulkFallSpeedMS,
    rainFallSpeedMS: vRain,
    subCloudEvapFraction: evapFraction,
    totalSuspendedGKg: suspendedGKg,
    totalPrecipGKg: precipGKg,
    effectiveRadiusUm,
    condensateEfficiency,
  };
}

export function classifyCellPrecipitation(
  rainGKg: number,
  hailGKg: number,
  graupelGKg: number,
  snowGKg: number,
  surfaceMMHr: number,
  virgaFrac: number,
  freezeZ: number,
  frozenMMHr = 0
): PrecipitationType {
  if (surfaceMMHr < 0.08) {
    return rainGKg > 0.06 && virgaFrac > 0.55 ? 'Virga' : 'None';
  }
  if (surfaceMMHr < 0.35 && virgaFrac > 0.8) {
    return 'Virga';
  }

  const frozenShare = frozenMMHr / Math.max(0.01, surfaceMMHr);

  if (frozenShare > 0.62) {
    if (hailGKg > 0.12 && frozenShare > 0.72) return 'Hail & Heavy Rain';
    if (graupelGKg > 0.2) return 'Graupel Shower';
    return rainGKg > 0.12 && frozenShare < 0.88 ? 'Mixed-Phase Precipitation' : 'Snow / Ice Pellets';
  }

  if (hailGKg > 0.25 && surfaceMMHr > 12.0) return 'Hail & Heavy Rain';
  if (graupelGKg > 0.3 && freezeZ < 2600 && surfaceMMHr > 2.5) return 'Graupel Shower';
  if (hailGKg > 0.1 && graupelGKg > 0.22 && surfaceMMHr > 6.0) return 'Mixed-Phase Precipitation';
  if (freezeZ < 650 && snowGKg > 0.12 && surfaceMMHr < 8) {
    return rainGKg > 0.15 ? 'Mixed-Phase Precipitation' : 'Snow / Ice Pellets';
  }

  // WMO-style intensity bands for liquid precipitation.
  if (surfaceMMHr >= 45.0) return 'Torrential Convective Rain';
  if (surfaceMMHr >= 16.0) return 'Heavy Rain';
  if (surfaceMMHr >= 4.0) return 'Moderate Rain';
  if (surfaceMMHr >= 0.8) return 'Light Rain';
  return 'Drizzle';
}

/**
 * Adiabatic condensate of a saturated parcel weighted by the lateral entrainment dilution it
 * accumulates on the way up:
 *
 *     q_eff = ∫_base^top (dq_c/dz) · exp(-ε (z - base)) dz
 *
 * Each layer keeps the condensate it produced, discounted only by the mixing it has suffered
 * since. Evaluating the production rate at 8 Gauss-ish midpoints keeps this within a fraction
 * of a percent of the analytic result while costing eight table lookups.
 */
function dilutedAdiabaticCondensate(
  sounding: AtmosphericSounding,
  baseZ: number,
  topZ: number,
  epsKmInv: number
): number {
  if (topZ <= baseZ) return 0;
  const depthKm = (topZ - baseZ) / 1000.0;
  const eps = Math.max(0, epsKmInv);
  const SAMPLES = 8;
  let total = 0;
  for (let k = 0; k < SAMPLES; k++) {
    const fMid = (k + 0.5) / SAMPLES;
    const z = baseZ + (topZ - baseZ) * fMid;
    const production = sounding.condGKgPerKmAt(z); // g/kg per km
    if (production <= 1e-9) continue;
    total += production * Math.exp(-eps * depthKm * fMid);
  }
  return Math.max(0, (total * depthKm) / SAMPLES);
}
