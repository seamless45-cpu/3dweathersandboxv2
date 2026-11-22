import {
  AtmosphereConfig,
  DOMAIN_MAX_ALT,
  InstabilityTelemetry,
  PHYS,
  SoundingProfileLevel,
} from './types';

/**
 * Convective mixed-layer depth (m) and its potential-temperature offset over the free
 * troposphere. A well-developed daytime boundary layer is 800-1200 m deep and sits 0.5-1.5 K
 * above the air it is entraining from aloft, which is what makes the capping inversion a
 * *stable jump* rather than an absence of one.
 */
const MIXED_LAYER_NOMINAL_TOP = 800;

export interface SoundingPreset {
  id: string;
  label: string;
  description: string;
  config: Partial<AtmosphereConfig>;
}

export const SOUNDING_PRESETS: SoundingPreset[] = [
  {
    id: 'multicell_plains',
    label: 'Unstable Plains (Multicell)',
    description: 'Warm moist boundary layer, moderate shear — evolves from clear sky into cumulus, multicells & cold-pool lines.',
    config: {
      surfaceTempC: 29.5,
      surfacePressureHPa: 1010,
      surfaceRelHumidity: 66,
      envLapseRateKPerKm: 6.55,
      cappingInversionStrengthK: 0.8,
      surfaceWindSpeedMS: 6.0,
      surfaceWindDirDeg: 155,
      bulkWindShear06kmMS: 17.5,
      directionalShearDeg: 65,
      solarHeatingFactor: 1.15,
    },
  },
  {
    id: 'supercell_alley',
    label: 'High-Shear Supercell',
    description: 'High CAPE + strong veering hodograph (SRH > 250 m²/s²) — supports rotating mesocyclones, splitting & intense lightning.',
    config: {
      surfaceTempC: 30.5,
      surfacePressureHPa: 1006,
      surfaceRelHumidity: 68,
      envLapseRateKPerKm: 6.85,
      cappingInversionStrengthK: 1.0,
      surfaceWindSpeedMS: 9.5,
      surfaceWindDirDeg: 135,
      bulkWindShear06kmMS: 29.0,
      directionalShearDeg: 115,
      solarHeatingFactor: 1.25,
    },
  },
  {
    id: 'pulse_summer',
    label: 'Weak-Shear Pulse Storms',
    description: 'Humid airmass with light winds — single-cell pulse thunderstorms that collapse via their own downdrafts.',
    config: {
      surfaceTempC: 29.5,
      surfacePressureHPa: 1014,
      surfaceRelHumidity: 69,
      envLapseRateKPerKm: 6.45,
      cappingInversionStrengthK: 0.4,
      surfaceWindSpeedMS: 2.5,
      surfaceWindDirDeg: 190,
      bulkWindShear06kmMS: 5.5,
      directionalShearDeg: 20,
      solarHeatingFactor: 1.15,
    },
  },
  {
    id: 'fair_weather_cu',
    label: 'Fair-Weather Cumulus',
    description: 'Modest moisture & warm mid-levels — forms shallow fair-weather cumulus humilis with no deep storms.',
    config: {
      surfaceTempC: 24.5,
      surfacePressureHPa: 1018,
      surfaceRelHumidity: 54,
      envLapseRateKPerKm: 5.65,
      cappingInversionStrengthK: 3.1,
      surfaceWindSpeedMS: 4.5,
      surfaceWindDirDeg: 210,
      bulkWindShear06kmMS: 9.0,
      directionalShearDeg: 25,
      solarHeatingFactor: 1.0,
    },
  },
  {
    id: 'dry_capped_clear',
    label: 'Arid / Capped Stable Sky',
    description: 'Dry desert boundary layer & strong cap — atmosphere remains clear or produces rare high-base virga.',
    config: {
      surfaceTempC: 32.0,
      surfacePressureHPa: 1016,
      surfaceRelHumidity: 24,
      envLapseRateKPerKm: 5.8,
      cappingInversionStrengthK: 4.5,
      surfaceWindSpeedMS: 6.0,
      surfaceWindDirDeg: 230,
      bulkWindShear06kmMS: 12.0,
      directionalShearDeg: 15,
      solarHeatingFactor: 1.0,
    },
  },
];

export const DEFAULT_ATMOSPHERE_CONFIG: AtmosphereConfig = {
  surfaceTempC: 29.5,
  surfacePressureHPa: 1010,
  surfaceRelHumidity: 66,
  envLapseRateKPerKm: 6.55,
  cappingInversionStrengthK: 0.8,
  surfaceWindSpeedMS: 5.5,
  surfaceWindDirDeg: 155,
  bulkWindShear06kmMS: 16.5,
  directionalShearDeg: 55,
  solarHeatingFactor: 1.15,
  sunElevationDeg: 34,
  ccnConcentration: 1.0,
  rimingEfficiency: 1.0,
  chargeSeparationGain: 1.0,
  cloudDetailScale: 1.05,
  turbulenceIntensity: 1.0,
};

/** Bolton (1980) saturation vapor pressure over liquid water in Pascals */
export function saturationVaporPressureLiquidPa(tempK: number): number {
  const tc = Math.max(-80, Math.min(60, tempK - 273.15));
  return 611.2 * Math.exp((17.67 * tc) / (tc + 243.5));
}

/** Saturation vapor pressure over ice in Pascals */
export function saturationVaporPressureIcePa(tempK: number): number {
  const tc = Math.max(-95, Math.min(0, tempK - 273.15));
  return 611.15 * Math.exp((22.46 * tc) / (tc + 272.62));
}

/** Saturation mixing ratio q_vs (kg/kg) over liquid water */
export function saturationMixingRatioLiquid(tempK: number, pressurePa: number): number {
  const es = saturationVaporPressureLiquidPa(tempK);
  const denom = Math.max(es * 1.05, pressurePa - es);
  return 0.62198 * (es / denom);
}

/** Saturation mixing ratio q_vi (kg/kg) over ice */
export function saturationMixingRatioIce(tempK: number, pressurePa: number): number {
  const esi = saturationVaporPressureIcePa(tempK);
  const denom = Math.max(esi * 1.05, pressurePa - esi);
  return 0.62198 * (esi / denom);
}

/** Moist adiabatic lapse rate Gamma_m (K/m) */
export function moistAdiabaticLapseRateKPerM(tempK: number, pressurePa: number): number {
  const qvs = saturationMixingRatioLiquid(tempK, pressurePa);
  // Latent heat blends linearly across the mixed-phase zone (−20..0 °C) instead of switching
  // abruptly at 0 °C: a hard L_V → L_S switch puts a jump in the moist lapse rate, which makes
  // the lifted parcel kink at the freezing level and the buoyancy profile non-monotone there.
  const iceFrac = Math.max(0, Math.min(1, (PHYS.T_FREEZE - tempK) / 20.0));
  const lv = PHYS.L_V * (1.0 - iceFrac) + PHYS.L_S * iceFrac;
  const numerator =
    PHYS.G * (1.0 + (lv * qvs) / (PHYS.R_D * tempK));
  const denominator =
    PHYS.CP + (lv * lv * qvs * 0.62198) / (PHYS.R_D * tempK * tempK);
  return numerator / denominator;
}

export class AtmosphericSounding {
  public levels: SoundingProfileLevel[] = [];
  public dz = 200; // meters per sounding level (91 levels from 0 to 18,000m)

  // Flat structure-of-arrays mirror of `levels`. The per-frame hot loops (fluid grid,
  // microphysics, electrification) read these directly: scalar accessors interpolate
  // without allocating the 11-field SoundingProfileLevel object thousands of times per
  // frame, which was the main source of minor-GC stutter.
  public numLevels = 0;
  public zArr!: Float32Array;
  public pArr!: Float32Array;
  public tArr!: Float32Array;
  public tdArr!: Float32Array;
  public qvArr!: Float32Array;
  public rhoArr!: Float32Array;
  public thetaArr!: Float32Array;
  public uArr!: Float32Array;
  public wArr!: Float32Array;

  /**
   * Saturation mixing ratio q_vs(z) in g/kg along the environmental profile, and the
   * condensate a *saturated parcel* would produce per km of moist-adiabatic ascent
   * (g/kg/km), with its vertical integral. These are the physical ceilings the bulk
   * microphysics relaxes toward, so condensate can never exceed the vapor actually
   * available in the sounding.
   */
  public qSatGKg!: Float32Array;
  public adiabaticCondGKgPerKm!: Float32Array;
  public adiabaticCondIntegralGKg!: Float32Array;
  public tempCAtLevel!: Float32Array;
  /**
   * Parcel buoyancy B(z) in m/s^2 for the mixed-layer + solar-perturbation parcel that CAPE
   * and CIN are integrated from: negative inside the capped layer, positive between LFC and
   * EL, negative again in the stable layer aloft. Cells integrate this directly instead of
   * inferring buoyancy from regime-specific constants.
   */
  public parcelBuoyArr!: Float32Array;
  /** Condensate (g/kg) the CAPE parcel carries at each level. */
  public parcelCondArr!: Float32Array;
  /** Running integral of parcelBuoyArr (J/kg), so layer-mean buoyancy is a two-lookup difference. */
  public parcelBuoyIntegralArr!: Float32Array;

  /**
   * Mixed-layer source state of the CAPE parcel. The plume model lifts exactly this parcel, so
   * the updraft the cell dynamics integrate and the CAPE the HUD reports describe the same air.
   * Without this the two disagreed by thousands of J/kg, which is how a "4200 J/kg" sounding
   * could produce a 55 m/s updraft one frame and a 4 m/s one the next.
   */
  public mlThetaK = 300;
  public mlQvGKg = 12;
  public mlThermalExcessK = 0.4;
  public surfacePressurePa = 101000;

  public instability: InstabilityTelemetry = {
    cape: 0,
    cin: 0,
    lcl: 1200,
    lfc: 1800,
    el: 11000,
    freezingLevel: 4100,
    wetBulbZeroLevel: 2800,
    homogeneousFreezeLevel: 9400,
    lapseRate03km: 7.0,
    lapseRate700500: 7.0,
    bulkShear06km: 15,
    shear01km: 6,
    srh03km: 120,
    liftedIndex: 0,
    dcape: 0,
    stp: 0,
    precipitableWaterMM: 35,
    convectiveTempC: 25,
    bunkersStormU: 6,
    bunkersStormW: -4,
  };

  constructor(config: AtmosphereConfig) {
    this.recompute(config);
  }

  public recompute(cfg: AtmosphereConfig): void {
    const numLevels = Math.floor(DOMAIN_MAX_ALT / this.dz) + 1;
    if (this.levels.length !== numLevels) {
      this.levels = new Array(numLevels);
      this.zArr = new Float32Array(numLevels);
      this.pArr = new Float32Array(numLevels);
      this.tArr = new Float32Array(numLevels);
      this.tdArr = new Float32Array(numLevels);
      this.qvArr = new Float32Array(numLevels);
      this.rhoArr = new Float32Array(numLevels);
      this.thetaArr = new Float32Array(numLevels);
      this.parcelBuoyArr = new Float32Array(numLevels);
      this.parcelCondArr = new Float32Array(numLevels);
      this.parcelBuoyIntegralArr = new Float32Array(numLevels);
      this.uArr = new Float32Array(numLevels);
      this.wArr = new Float32Array(numLevels);
      this.qSatGKg = new Float32Array(numLevels);
      this.adiabaticCondGKgPerKm = new Float32Array(numLevels);
      this.adiabaticCondIntegralGKg = new Float32Array(numLevels);
      this.tempCAtLevel = new Float32Array(numLevels);
    }
    this.numLevels = numLevels;

    const t0 = cfg.surfaceTempC + 273.15;
    const p0 = cfg.surfacePressureHPa * 100.0;
    const rh0 = Math.max(0.05, Math.min(0.99, cfg.surfaceRelHumidity / 100.0));
    const qv0 = rh0 * saturationMixingRatioLiquid(t0, p0);

    // Tropopause altitude scales naturally with surface warmth & lapse rate (approx 11.8 - 14.8 km)
    const tropopauseZ = Math.max(
      10800,
      Math.min(15200, 12800 + (cfg.surfaceTempC - 26.0) * 180)
    );

    // -------------------------------------------------------------------------------------
    // Vertical structure, built in POTENTIAL TEMPERATURE and transformed afterwards.
    //
    // Constructing a sounding in temperature and then pasting a "well-mixed boundary layer" on
    // top is a trap: the mixed layer is defined by uniform theta, so the two constructions only
    // agree if a jump is placed exactly at the mixed-layer top, and any misplacement either
    // produces a superadiabatic layer (no parcel is buoyant) or warms the whole troposphere
    // (CAPE inflated two- to threefold). Building theta(z) directly makes the structure exact:
    //
    //   theta(z) = theta_ml                                   z <= h_ml      well-mixed BL
    //            = theta_ml + dCap·exp(-((z-h_ml)/w)²)        capping inversion
    //            = theta_free(z)                              free troposphere
    //   T(z)     = theta(z)·(p/p0)^(R/cp)
    //
    // and continuity is automatic because theta_free(h_ml) = theta_ml by construction.
    // -------------------------------------------------------------------------------------
    const thetaSfc = t0 * Math.pow(100000.0 / p0, PHYS.R_D / PHYS.CP);
    // The mixed layer is a well-mixed layer with a small superadiabatic excess at the ground
    // (0.3 K at full sun), so theta_ml sits just above the surface potential temperature.
    const blSuperadiabaticK = 0.3 * Math.max(0.4, cfg.solarHeatingFactor);
    const thetaMl = thetaSfc + blSuperadiabaticK;
    const mixedLayerTopM = MIXED_LAYER_NOMINAL_TOP;
    // ---- Free-tropospheric temperature profile -----------------------------------------
    // A constant θ-gradient is the wrong way to specify a lapse rate: with dθ/dz fixed the
    // *temperature* lapse (γ = γ_d − dθ/dz) gradually steepens as the air thins, so a preset
    // "6.55 K/km" is really 6.55 at the ground, ~6.8 at 700 hPa and ~7.0 at 500 hPa. That
    // systematically inflates CAPE by a factor of two or more (measured: 9768 J/kg on a
    // sounding whose surface lapse rate implies ~3000).
    //
    // Instead T(z) is specified directly and the pressure follows from the constant-lapse-rate
    // hydrostatic solution, which is closed form:
    //
    //     mixed layer (γ = g/cp):  T = T_s − γ·z,        p = p0·(T/T_s)^(cp/R)
    //     free trop.  (γ = const): T = T_h − γ·(z−h),    p = p_h·(T/T_h)^(g/(R·γ))
    //
    // Both are exact, continuous at the mixed-layer top h, and independent of the vertical
    // discretisation — so the profile does not change when the grid does.
    const dryLapseKPerM = PHYS.G / PHYS.CP;
    const gammaEnv = cfg.envLapseRateKPerKm / 1000.0; // K/m
    const envGamma = Math.max(0.0015, Math.min(dryLapseKPerM - 1.0e-4, gammaEnv));

    // ---- Layered temperature/pressure profile -------------------------------------------
    // Three constant-lapse segments, each with its own closed-form hydrostatic pressure:
    //
    //   1. 0 → h_ml        γ = g/cp   (well-mixed convective boundary layer, dry adiabat)
    //   2. h_ml → 7 km     γ = preset (conditionally unstable; feeding the deep updraft)
    //   3. 7 km → tropo    γ = 0.78·preset (upper-tropospheric stabilization)
    //
    // The third segment matters more than it looks. With a single lapse rate all the way to the
    // tropopause the parcel stays buoyant to 14 km and CAPE comes out at 6-7 kJ/kg with the EL
    // on the tropopause itself — no sounding supports that. Real mid-latitude tropospheres
    // steepen, then flatten, so the EL lands near 11-12 km and CAPE lands in the 1.5-4 kJ/kg
    // range where the presets are supposed to live.
    const upperTropZ = 7000;
    const upperLapseScale = 0.78;
    interface Layer {
      z0: number;
      z1: number;
      t0: number;
      p0: number;
      gamma: number;
    }
    const layers: Layer[] = [];
    const tSfcLayer = thetaMl * Math.pow(p0 / 100000.0, PHYS.R_D / PHYS.CP);
    const mlTopTemp = tSfcLayer - dryLapseKPerM * mixedLayerTopM;
    const mlTopPress = p0 * Math.pow(Math.max(0.05, mlTopTemp / tSfcLayer), PHYS.CP / PHYS.R_D);
    layers.push({ z0: 0, z1: mixedLayerTopM, t0: tSfcLayer, p0, gamma: dryLapseKPerM });
    // Free troposphere, split at 7 km.
    const t7 = mlTopTemp - envGamma * (upperTropZ - mixedLayerTopM);
    const p7 = mlTopPress * Math.pow(t7 / mlTopTemp, PHYS.G / (PHYS.R_D * envGamma));
    layers.push({
      z0: mixedLayerTopM,
      z1: upperTropZ,
      t0: mlTopTemp,
      p0: mlTopPress,
      gamma: envGamma,
    });
    const gammaUpper = Math.max(0.002, envGamma * upperLapseScale);
    const tTrop = Math.max(190, t7 - gammaUpper * (tropopauseZ - upperTropZ));
    layers.push({ z0: upperTropZ, z1: 1e9, t0: t7, p0: p7, gamma: gammaUpper });

    /** Temperature of the (cap-free) environment at height z. */
    const tProfile = (z: number): number => {
      if (z <= tropopauseZ) {
        for (let k = 0; k < layers.length; k++) {
          const L = layers[k];
          if (z <= L.z1) return L.t0 - L.gamma * (z - L.z0);
        }
        return tTrop;
      }
      // Lower stratosphere: isothermal just above the tropopause, warming slowly above.
      return tTrop + 0.0016 * Math.max(0, z - tropopauseZ);
    };
    /** Hydrostatic pressure of the environment profile at height z. */
    const pressureAtM = (z: number): number => {
      let p = p0;
      for (let k = 0; k < layers.length; k++) {
        const L = layers[k];
        if (z <= L.z0) break;
        const zTop = Math.min(z, L.z1);
        const tTop = Math.max(60, L.t0 - L.gamma * (zTop - L.z0));
        p = L.p0 * Math.pow(tTop / L.t0, PHYS.G / (PHYS.R_D * L.gamma));
        if (z <= L.z1) return p;
      }
      // Stratosphere is isothermal, so pressure continues exponentially.
      return p * Math.exp((-PHYS.G * Math.max(0, z - tropopauseZ)) / (PHYS.R_D * Math.max(180, tTrop)));
    };

    // Capping inversion strength in kelvin of theta, spread over ~450 m near 1.65 km.
    const capJumpTheta = cfg.cappingInversionStrengthK;

    const baseDirRad = ((cfg.surfaceWindDirDeg + 180) * Math.PI) / 180.0;
    const dirTurnRad = (cfg.directionalShearDeg * Math.PI) / 180.0;

    let currentP = p0;
    let pwIntegral = 0;
    let freezeZ = 0;
    let homoFreezeZ = 10000;
    let foundFreeze = false;
    let foundHomo = false;

    for (let i = 0; i < numLevels; i++) {
      const z = i * this.dz;

      // ---- Temperature and pressure from the analytic profile ----------------------------
      // Temperature: the dry-adiabatic mixed layer, then the constant-lapse free troposphere,
      // then an isothermal-to-slightly-warming stratosphere that stops an overshooting updraft.
      let tempK: number;
      if (z <= tropopauseZ) {
        tempK = tProfile(z);
      } else {
        // Lower stratosphere: T stops falling, then warms slowly with height.
        tempK = tProfile(z);
      }
      // Capping inversion: a θ (equivalently T, at fixed pressure) bump centred just above the
      // mixed-layer top. This is the lid that a plume has to punch through with its stored
      // kinetic energy, and the reason the sounding runs from suppressed to explosive as the
      // cap erodes through the morning.
      if (z > mixedLayerTopM - 500 && z < mixedLayerTopM + 2600) {
        const capShape = Math.exp(-Math.pow((z - (mixedLayerTopM + 750.0)) / 430.0, 2));
        tempK += capJumpTheta * capShape;
      }
      tempK = Math.max(192.0, tempK);
      currentP = pressureAtM(z);

      if (!foundFreeze && tempK <= PHYS.T_FREEZE) {
        freezeZ = z;
        foundFreeze = true;
      }
      if (!foundHomo && tempK <= PHYS.T_HOMOGENEOUS_ICE) {
        homoFreezeZ = z;
        foundHomo = true;
      }

      // Moisture: the convective boundary layer is well mixed in *mixing ratio* up to ~800 m, then
      // the relative humidity falls off through the free troposphere. The mid-level dry layer this
      // creates is what gives real soundings their entrainment-driven updraft decay and their
      // evaporatively driven downdrafts; a profile with no dry layer above cloud base produces
      // anvils that fill the whole column.
      const qvs = saturationMixingRatioLiquid(tempK, currentP);
      // Free-tropospheric RH profile with the characteristic dry slot at 600-500 hPa: the
      // entrained air at those levels is what stops a deep updraft, and what makes the
      // evaporative downdraft cold. Soundings without it (a smooth exponential decay) hold
      // near-saturation to 8 km, so every parcel stays on the moist adiabat and CAPE reads
      // two to three times what the lapse rate can actually support.
      const midLevelDry =
        z > 1800 && z < 6000
          ? 1.0 - 0.62 * Math.exp(-Math.pow((z - 4200.0) / 1500.0, 2))
          : 1.0;
      const rhFree =
        z <= 800
          ? rh0
          : Math.max(
              0.045,
              rh0 * Math.exp(-(z - 800) / 2600.0) * midLevelDry
            );
      const qvEnv = Math.max(1e-6, Math.min(qvs * 0.98, z <= 800 ? qv0 * (1.0 - 0.04 * (z / 800)) : rhFree * qvs));

      // Dewpoint from vapor pressure
      const ePa = Math.max(1.0, (qvEnv * currentP) / (0.62198 + qvEnv));
      const lnRatio = Math.log(ePa / 611.2);
      const dewC = (243.5 * lnRatio) / (17.67 - lnRatio);
      const dewpointK = Math.min(tempK, dewC + 273.15);

      const tv = tempK * (1.0 + 0.608 * qvEnv);
      const rho = currentP / (PHYS.R_D * tv);
      const thetaEnv = tempK * Math.pow(100000.0 / currentP, PHYS.R_D / PHYS.CP);

      // Curved hodograph in 0-3 km + deep-layer shear up to 9 km
      const turnFrac = Math.min(1.0, z / 3000.0);
      const currentAngle = baseDirRad + dirTurnRad * (1.0 - Math.exp(-turnFrac * 2.2));
      const shearFrac = Math.min(1.35, z / 6000.0);
      // Base vector + unidirectional upper shear vector
      const baseU = cfg.surfaceWindSpeedMS * Math.sin(currentAngle);
      const baseW = cfg.surfaceWindSpeedMS * Math.cos(currentAngle);
      const upperShearAngle = baseDirRad + dirTurnRad;
      const shearU = cfg.bulkWindShear06kmMS * shearFrac * Math.sin(upperShearAngle);
      const shearW = cfg.bulkWindShear06kmMS * shearFrac * Math.cos(upperShearAngle);

      const windU = baseU + shearU;
      const windW = baseW + shearW;

      if (i > 0) {
        pwIntegral += 0.5 * (this.levels[i - 1].qvEnv * this.levels[i - 1].rho + qvEnv * rho) * this.dz;
      }

      this.levels[i] = {
        z,
        p: currentP,
        tempK,
        dewpointK,
        qvEnv,
        rho,
        thetaEnv,
        windU,
        windW,
      };

      this.zArr[i] = z;
      this.pArr[i] = currentP;
      this.tArr[i] = tempK;
      this.tdArr[i] = dewpointK;
      this.qvArr[i] = qvEnv;
      this.rhoArr[i] = rho;
      this.thetaArr[i] = thetaEnv;
      this.uArr[i] = windU;
      this.wArr[i] = windW;
      this.tempCAtLevel[i] = tempK - PHYS.T_FREEZE;
      this.qSatGKg[i] = saturationMixingRatioLiquid(tempK, currentP) * 1000.0;
    }

    // Condensate a saturated parcel yields per km of moist-adiabatic ascent:
    //   dq_c/dz = -d q_vs/dz |_sat  (total water of the parcel is conserved)
    // Evaluated with a 200 m finite difference along the moist adiabat, so the latent
    // heating and every downstream hydrometeor budget is bounded by real vapor supply.
    const probeDz = this.dz;
    let condIntegral = 0;
    for (let i = 0; i < numLevels; i++) {
      const t1 = this.tArr[i];
      const p1 = this.pArr[i];
      const gammaM = moistAdiabaticLapseRateKPerM(t1, p1);
      const t2 = t1 - gammaM * probeDz;
      const p2 = p1 * Math.exp((-PHYS.G * probeDz) / (PHYS.R_D * t1));
      const q1 = saturationMixingRatioLiquid(t1, p1);
      const q2 = saturationMixingRatioLiquid(t2, p2);
      const perKm = Math.max(0, (q1 - q2) * 1000.0 * (1000.0 / probeDz));
      this.adiabaticCondGKgPerKm[i] = perKm;
      if (i > 0) {
        condIntegral += 0.5 * (this.adiabaticCondGKgPerKm[i - 1] + perKm) * (probeDz / 1000.0);
      }
      this.adiabaticCondIntegralGKg[i] = condIntegral;
    }

    // ------------------------------------------------------------------------------------
    // Mixed-layer parcel ascent.
    //
    // The profile was previously lifted from the surface value + a solar perturbation, which
    // systematically inflates CAPE: a superadiabatic skin 30 m deep can add over a thousand
    // J/kg of buoyancy a real 100-hPa mixed-layer parcel would never see. The parcel is now the
    // mean potential temperature and mixing ratio of the lowest 100 hPa (~900 m), which is the
    // quantity forecast soundings report as MLCAPE, then lifted dry-adiabatically to its LCL
    // and moist-adiabatically beyond it. Entrainment is not included; that happens in the plume
    // model downstream, which is where dilution physically belongs.
    // ------------------------------------------------------------------------------------
    // The parcel source is the *mixed layer as the environment actually is*: mean potential
    // temperature through 950 m and the surface-layer mixing ratio. Keeping it consistent with
    // the profile is what makes CAPE, LI and the plume model agree with each other. The only
    // superadiabatic excess is the small thermal perturbation a sunny surface gives a rising
    // parcel (0.4 K at full sun), applied as a potential-temperature offset.
    this.mlThetaK = thetaMl;
    this.mlQvGKg = qv0 * 1000.0;
    this.surfacePressurePa = p0;
    this.mlThermalExcessK = 0.4 * Math.max(0.2, cfg.solarHeatingFactor);
    const thetaParcel = this.mlThetaK;
    const qvParcel = this.mlQvGKg * 1e-3;
    const parcelT0 = thetaParcel * Math.pow(p0 / 100000.0, PHYS.R_D / PHYS.CP) + this.mlThermalExcessK;

    let tp = parcelT0;
    let lcl = DOMAIN_MAX_ALT;
    let lfc = 0;
    let el = 0;
    let foundLCL = false;
    let foundLFC = false;
    let cape = 0;
    let cin = 0;
    let lastPositiveZ = 0;

    // Moist-adiabat integration helper: one 200 m step of the parcel state.
    const stepParcel = (tK: number, pPa: number): number => {
      const gamma = moistAdiabaticLapseRateKPerM(tK, pPa);
      return tK - gamma * this.dz;
    };

    for (let i = 1; i < numLevels; i++) {
      const lvl = this.levels[i];
      const prev = this.levels[i - 1];

      if (!foundLCL) {
        // Dry adiabat: conserve potential temperature (not a fixed lapse), then locate the
        // saturation level explicitly.
        const thetaP = parcelT0 * Math.pow(100000.0 / p0, -PHYS.R_D / PHYS.CP);
        tp = thetaP * Math.pow(lvl.p / 100000.0, PHYS.R_D / PHYS.CP);
        if (qvParcel >= saturationMixingRatioLiquid(tp, lvl.p)) {
          foundLCL = true;
          lcl = prev.z;
        }
      } else {
        tp = stepParcel(tp, prev.p);
      }
      if (!foundLCL) continue;

      const qvCurrent = Math.min(qvParcel, saturationMixingRatioLiquid(tp, lvl.p));
      const tvParcel = tp * (1.0 + 0.608 * qvCurrent);
      const tvEnv = lvl.tempK * (1.0 + 0.608 * lvl.qvEnv);
      const buoy = PHYS.G * ((tvParcel - tvEnv) / tvEnv);

      this.parcelBuoyArr[i] = buoy;
      this.parcelBuoyIntegralArr[i] =
        this.parcelBuoyIntegralArr[i - 1] + 0.5 * (buoy + this.parcelBuoyArr[i - 1]) * this.dz;
      this.parcelCondArr[i] = Math.max(0, (qvParcel - qvCurrent) * 1000.0);

      // CAPE is positive area between the LFC and the EL, not any buoyant patch: a parcel that
      // is briefly buoyant below a cap, then suppressed again, does not contribute. Pockets of
      // positive buoyancy above the EL (a second unstable layer, e.g. above an inversion aloft)
      // are excluded as well.
      if (buoy > 0 && lvl.z >= lcl) {
        if (!foundLFC) {
          foundLFC = true;
          lfc = lvl.z;
        }
        if (!el) {
          cape += buoy * this.dz;
          lastPositiveZ = lvl.z;
        }
      } else if (foundLFC && buoy <= 0 && !el && lvl.z >= lcl) {
        // The first non-buoyant level above the LFC defines the equilibrium level.
        el = lvl.z;
      }
      if (!foundLFC && buoy < 0 && lvl.z < 5500) {
        // Inhibition is only the negative area a parcel must overcome on its way *to* the LFC.
        // Above the tropopause negative buoyancy is the stratosphere doing its job, not a cap.
        cin += Math.abs(buoy) * this.dz;
      }
    }
    if (foundLFC) el = lastPositiveZ;

    // Parcel condensate is only meaningful once the parcel is above its LCL; zero below.
    for (let i = 0; i < numLevels && this.levels[i].z < lcl; i++) this.parcelCondArr[i] = 0;

    if (!foundLCL) {
      lcl = Math.max(800, 125.0 * (cfg.surfaceTempC - (this.levels[0].dewpointK - 273.15)));
      // No LCL found means the column never saturates: keep a dry-adiabatic buoyancy profile so
      // the plume model still has something physically meaningful to integrate.
      for (let i = 1; i < numLevels; i++) {
        const lvl = this.levels[i];
        const thetaP = parcelT0 * Math.pow(100000.0 / p0, -PHYS.R_D / PHYS.CP);
        const tDry = thetaP * Math.pow(lvl.p / 100000.0, PHYS.R_D / PHYS.CP);
        const buoy = PHYS.G * ((tDry - lvl.tempK) / lvl.tempK);
        this.parcelBuoyArr[i] = buoy;
        this.parcelBuoyIntegralArr[i] =
          this.parcelBuoyIntegralArr[i - 1] + 0.5 * (buoy + this.parcelBuoyArr[i - 1]) * this.dz;
      }
    }
    if (!foundLFC) {
      lfc = lcl + 600;
      el = lcl + 1200;
    }

    // ---- Lifted Index (500 hPa) -----------------------------------------------------------
    // LI = T500(env) - T500(parcel), where the parcel is the mixed-layer parcel lifted along
    // the same dry/moist path used above. Negative values indicate instability.
    let liftedIndex = 0;
    {
      const z500 = 5500; // ~500 hPa in a standard atmosphere
      let tParcel = parcelT0;
      let saturated = false;
      for (let z = 0; z < z500; z += this.dz) {
        if (!saturated && foundLCL && z >= lcl) saturated = true;
        if (saturated) {
          tParcel = stepParcel(tParcel, this.pressurePaAt(z));
        } else {
          const thetaP = parcelT0 * Math.pow(100000.0 / p0, -PHYS.R_D / PHYS.CP);
          tParcel = thetaP * Math.pow(this.pressurePaAt(z + this.dz) / 100000.0, PHYS.R_D / PHYS.CP);
        }
      }
      liftedIndex = this.tempKAt(z500) - tParcel;
    }

    // ---- Downdraft CAPE -------------------------------------------------------------------
    // A saturated downdraft descends moist-adiabatically from ~700 hPa; DCAPE is the negative
    // buoyancy it accumulates relative to the environment, and sets how cold a storm's outflow
    // can become. Deep dry layers under cloud base are what make strong gust fronts.
    let dcape = 0;
    {
      const zStart = Math.min(3200, this.levels[numLevels - 1].z * 0.35);
      let tD = this.tempKAt(zStart);
      let z = zStart;
      while (z > 200) {
        const pHere = this.pressurePaAt(z);
        const gamma = moistAdiabaticLapseRateKPerM(tD, pHere);
        tD += gamma * this.dz;
        z -= this.dz;
        const tEnv = this.tempKAt(Math.max(200, z));
        const tvD = tD * (1.0 + 0.608 * saturationMixingRatioLiquid(tD, this.pressurePaAt(z)));
        if (tvD < tEnv) dcape += PHYS.G * ((tEnv - tvD) / tEnv) * this.dz;
      }
    }

    const lvl0 = this.levels[0];

    // ---- 0-1 km shear (supercell / tornado ingredient) ------------------------------------
    const lvl1km = this.sampleAtAltitude(1000);
    const shear01km = Math.hypot(lvl1km.windU - lvl0.windU, lvl1km.windW - lvl0.windW);

    // ---- Wet-bulb zero ------------------------------------------------------------------
    // Hailstone survival is governed by the depth of the layer between the freezing level and
    // the wet-bulb zero, not the dry-bulb 0 °C isotherm alone.
    let wetBulbZero = 0;
    {
      for (let i = 0; i < numLevels; i++) {
        const tw = wetBulbTemperatureK(this.tArr[i], this.tdArr[i], this.pArr[i]);
        if (tw <= PHYS.T_FREEZE) {
          wetBulbZero = this.levels[i].z;
          break;
        }
      }
      if (wetBulbZero <= 0) wetBulbZero = Math.max(0, (foundFreeze ? freezeZ : 4000) - 700);
    }

    // ---- Convective temperature ---------------------------------------------------------
    // Surface temperature needed to warm the mixed layer enough to break the cap. A forecaster
    // reads this straight off the skew-T; here it is estimated from the ML parcel deficit: the
    // CIN has to be made up by ~105 J/kg per K of boundary-layer warming.
    const convectiveTempC = foundLCL && lfc > lcl
      ? cfg.surfaceTempC + Math.min(14, Math.max(0, cin / 105.0))
      : cfg.surfaceTempC;


    // Mid-level lapse rate between 700 and 500 hPa, evaluated between 4.0 and 6.5 km.
    const lapse700500 = Math.max(
      0,
      ((this.tempKAt(4000) - this.tempKAt(6500)) / 2500.0) * 1000.0
    );

    // Compute 0-6 km Bulk Shear, Bunkers Storm Motion, and 0-3 km SRH
    const lvl3km = this.sampleAtAltitude(3000);
    const lvl6km = this.sampleAtAltitude(6000);

    const du06 = lvl6km.windU - lvl0.windU;
    const dw06 = lvl6km.windW - lvl0.windW;
    const bulkShear06km = Math.hypot(du06, dw06);

    // Mean 0-6 km wind
    let meanU = 0;
    let meanW = 0;
    let count6 = 0;
    for (let i = 0; i < numLevels && this.levels[i].z <= 6000; i++) {
      meanU += this.levels[i].windU;
      meanW += this.levels[i].windW;
      count6++;
    }
    meanU /= Math.max(1, count6);
    meanW /= Math.max(1, count6);

    // Bunkers (2000) right-moving supercell deviation D = 7.5 m/s perpendicular to 0-6km shear vector
    const shearMag = Math.max(0.1, bulkShear06km);
    const devMag = 7.5 * Math.min(1.0, shearMag / 14.0);
    const bunkersU = meanU + (dw06 / shearMag) * devMag;
    const bunkersW = meanW - (du06 / shearMag) * devMag;

    // Integrate 0-3 km Storm-Relative Helicity SRH
    let srh = 0;
    for (let i = 1; i < numLevels && this.levels[i].z <= 3000; i++) {
      const a = this.levels[i - 1];
      const b = this.levels[i];
      const sru = 0.5 * (a.windU + b.windU) - bunkersU;
      const srw = 0.5 * (a.windW + b.windW) - bunkersW;
      const du = b.windU - a.windU;
      const dw = b.windW - a.windW;
      // Cross product in meteorological (X=East, Z=South) coordinates
      srh += srw * du - sru * dw;
    }

    // ---- Significant Tornado Parameter --------------------------------------------------
    // Thompson et al. (2003) form: MLCAPE/1500 x (2000-MLLCL)/1000 x SRH/150 x shear01/25 x
    // (200+CIN)/150. Values above ~1 indicate environments that support tornadic supercells.
    let stp = 0;
    {
      const capeTerm = Math.max(0, cape) / 1500;
      const lclTerm = Math.max(0, 2000 - lcl) / 1000;
      const srhTerm = Math.max(0, Math.abs(srh)) / 150;
      const shearTerm = Math.max(0, shear01km) / 25;
      const cinTerm = Math.max(0, 200 - cin) / 150;
      stp = Math.max(0, Math.min(10, capeTerm * lclTerm * srhTerm * shearTerm * cinTerm));
    }

    const lapse03 = ((lvl0.tempK - lvl3km.tempK) / 3000.0) * 1000.0;

    this.instability = {
      cape: Math.max(0, cape),
      cin: Math.max(0, cin),
      lcl,
      lfc,
      el,
      freezingLevel: foundFreeze ? freezeZ : 4000,
      wetBulbZeroLevel: wetBulbZero,
      homogeneousFreezeLevel: foundHomo ? homoFreezeZ : 9500,
      lapseRate03km: lapse03,
      lapseRate700500: lapse700500,
      bulkShear06km,
      shear01km,
      srh03km: Math.max(0, Math.abs(srh)),
      liftedIndex,
      dcape,
      stp,
      precipitableWaterMM: pwIntegral, // 1 kg/m^2 = 1 mm
      convectiveTempC,
      bunkersStormU: bunkersU,
      bunkersStormW: bunkersW,
    };
  }

  public sampleAtAltitude(zMeters: number): SoundingProfileLevel {
    const clampedZ = Math.max(0, Math.min(DOMAIN_MAX_ALT, zMeters));
    const exactIdx = clampedZ / this.dz;
    const i0 = Math.min(this.levels.length - 1, Math.floor(exactIdx));
    const i1 = Math.min(this.levels.length - 1, i0 + 1);
    const f = exactIdx - i0;
    const a = this.levels[i0];
    const b = this.levels[i1];
    if (i0 === i1) return a;
    return {
      z: clampedZ,
      p: a.p + (b.p - a.p) * f,
      tempK: a.tempK + (b.tempK - a.tempK) * f,
      dewpointK: a.dewpointK + (b.dewpointK - a.dewpointK) * f,
      qvEnv: a.qvEnv + (b.qvEnv - a.qvEnv) * f,
      rho: a.rho + (b.rho - a.rho) * f,
      thetaEnv: a.thetaEnv + (b.thetaEnv - a.thetaEnv) * f,
      windU: a.windU + (b.windU - a.windU) * f,
      windW: a.windW + (b.windW - a.windW) * f,
    };
  }

  /** Allocation-free variant of sampleAtAltitude for hot loops: writes into `out`. */
  public sampleInto(out: SoundingProfileLevel, zMeters: number): SoundingProfileLevel {
    const clampedZ = zMeters < 0 ? 0 : zMeters > DOMAIN_MAX_ALT ? DOMAIN_MAX_ALT : zMeters;
    const exactIdx = clampedZ / this.dz;
    const last = this.numLevels - 1;
    let i0 = exactIdx | 0;
    if (i0 > last) i0 = last;
    if (i0 < 0) i0 = 0;
    const i1 = i0 < last ? i0 + 1 : i0;
    const f = exactIdx - i0;
    out.z = clampedZ;
    out.p = this.pArr[i0] + (this.pArr[i1] - this.pArr[i0]) * f;
    out.tempK = this.tArr[i0] + (this.tArr[i1] - this.tArr[i0]) * f;
    out.dewpointK = this.tdArr[i0] + (this.tdArr[i1] - this.tdArr[i0]) * f;
    out.qvEnv = this.qvArr[i0] + (this.qvArr[i1] - this.qvArr[i0]) * f;
    out.rho = this.rhoArr[i0] + (this.rhoArr[i1] - this.rhoArr[i0]) * f;
    out.thetaEnv = this.thetaArr[i0] + (this.thetaArr[i1] - this.thetaArr[i0]) * f;
    out.windU = this.uArr[i0] + (this.uArr[i1] - this.uArr[i0]) * f;
    out.windW = this.wArr[i0] + (this.wArr[i1] - this.wArr[i0]) * f;
    return out;
  }

  public tempKAt(z: number): number {
    return this.interp(this.tArr, z);
  }
  public tempCAt(z: number): number {
    return this.interp(this.tArr, z) - PHYS.T_FREEZE;
  }
  public pressurePaAt(z: number): number {
    return this.interp(this.pArr, z);
  }
  public densityAt(z: number): number {
    return this.interp(this.rhoArr, z);
  }
  public qvEnvAt(z: number): number {
    return this.interp(this.qvArr, z);
  }
  /** Environmental saturation mixing ratio (g/kg) — the vapor actually available to a cloud. */
  public qSatGKgAt(z: number): number {
    return this.interp(this.qSatGKg, z);
  }
  /** Environmental potential temperature at altitude z, K. */
  public thetaEnvAt(z: number): number {
    return this.interp(this.thetaArr, z);
  }
  /** Environmental mixing ratio at altitude z, kg/kg. */
  public qvEnvAtScalar(z: number): number {
    return this.interp(this.qvArr, z);
  }
  public windUAt(z: number): number {
    return this.interp(this.uArr, z);
  }
  public windWAt(z: number): number {
    return this.interp(this.wArr, z);
  }
  /** Relative humidity (0..1) of the environment at altitude z. */
  public relativeHumidityAt(z: number): number {
    const qs = this.qSatGKgAt(z);
    return qs > 1e-6 ? Math.min(1.0, this.qvEnvAt(z) / qs) : 1.0;
  }

  private interp(arr: Float32Array, z: number): number {
    const clampedZ = z < 0 ? 0 : z > DOMAIN_MAX_ALT ? DOMAIN_MAX_ALT : z;
    const exactIdx = clampedZ / this.dz;
    const last = this.numLevels - 1;
    let i0 = exactIdx | 0;
    if (i0 > last) i0 = last;
    if (i0 < 0) i0 = 0;
    const i1 = i0 < last ? i0 + 1 : i0;
    const f = exactIdx - i0;
    return arr[i0] + (arr[i1] - arr[i0]) * f;
  }

  /**
   * Parcel buoyancy B(z) in m/s^2 at an arbitrary altitude, linearly interpolated from the
   * stored ascent profile. This is the acceleration a convective updraft actually feels at
   * that level: negative under the cap, strongly positive in the free-convection layer, and
   * negative again above the equilibrium level.
   */
  public parcelBuoyancyAt(zMeters: number): number {
    return this.interp(this.parcelBuoyArr, zMeters);
  }

  /** Condensate (g/kg) carried by the CAPE parcel at altitude z. */
  public parcelCondensateAt(zMeters: number): number {
    return this.interp(this.parcelCondArr, zMeters);
  }

  /**
   * Condensate (g/kg) a saturated parcel would carry after moist-adiabatic ascent from
   * baseZ to topZ — the strict adiabatic ceiling for a cloud column of that depth.
   */
  public adiabaticCondensateGKg(baseZ: number, topZ: number): number {
    if (topZ <= baseZ) return 0;
    const a = this.interp(this.adiabaticCondIntegralGKg, baseZ);
    const b = this.interp(this.adiabaticCondIntegralGKg, topZ);
    return Math.max(0, b - a);
  }

  /**
   * Integral of parcel buoyancy between two altitudes (J/kg == m^2/s^2). Dividing by the
   * layer depth gives the depth-mean acceleration a plume actually experiences while it
   * traverses that layer — the quantity that sets its equilibrium updraft speed. Using the
   * midpoint value instead badly underestimates growth for shallow clouds, because B(z) rises
   * steeply just above the LFC.
   */
  public parcelBuoyancyIntegral(fromZ: number, toZ: number): number {
    if (toZ <= fromZ) return 0;
    return this.interp(this.parcelBuoyIntegralArr, toZ) - this.interp(this.parcelBuoyIntegralArr, fromZ);
  }

  /** Instantaneous saturated-ascent condensation rate (g/kg per s) for updraft w (m/s) at z. */
  public adiabaticCondensationRateGKgPerS(z: number, wMS: number): number {
    if (wMS <= 0) return 0;
    return this.interp(this.adiabaticCondGKgPerKm, z) * wMS * 0.001;
  }

  /** Condensate a saturated parcel produces per km of ascent at altitude z (g/kg/km). */
  public condGKgPerKmAt(z: number): number {
    return this.interp(this.adiabaticCondGKgPerKm, z);
  }
}

/**
 * Wet-bulb temperature (K) from dry-bulb and dewpoint by the Stull (2011) approximation,
 * inverted from the vapour-pressure form and clamped to the saturated branches. Accurate to
 * ~0.3 K over the ranges this simulation spans, which is far inside the uncertainty of the
 * hail-melting parameterisation that consumes it.
 */
export function wetBulbTemperatureK(tempK: number, dewpointK: number, pressurePa: number): number {
  const tc = tempK - 273.15;
  const rh = Math.max(0.02, Math.min(1, Math.exp((17.625 * (dewpointK - tempK)) / (243.04 + (dewpointK - 273.15)))));
  const p = Math.max(30000, pressurePa) / 100.0; // hPa
  // Stull (2011), eq. 3: Tw = T atan(0.151977 sqrt(RH+8.313659)) + atan(T+RH) - atan(RH-1.676331)
  //     + 0.00391838 RH^1.5 atan(0.023101 RH) - 4.686035, with RH in %.
  const rhPct = rh * 100.0;
  const twC =
    tc * Math.atan(0.151977 * Math.sqrt(rhPct + 8.313659)) +
    Math.atan(tc + rhPct) -
    Math.atan(rhPct - 1.676331) +
    0.00391838 * Math.pow(rhPct, 1.5) * Math.atan(0.023101 * rhPct) -
    4.686035;
  void p;
  return Math.min(tempK, twC + 273.15);
}
