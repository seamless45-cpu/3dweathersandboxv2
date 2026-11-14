import {
  AtmosphereConfig,
  DOMAIN_MAX_ALT,
  InstabilityTelemetry,
  PHYS,
  SoundingProfileLevel,
} from './types';

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
  const lv = tempK < PHYS.T_FREEZE ? PHYS.L_S : PHYS.L_V;
  const numerator =
    PHYS.G * (1.0 + (lv * qvs) / (PHYS.R_D * tempK));
  const denominator =
    PHYS.CP + (lv * lv * qvs * 0.62198) / (PHYS.R_D * tempK * tempK);
  return numerator / denominator;
}

export class AtmosphericSounding {
  public levels: SoundingProfileLevel[] = [];
  public dz = 200; // meters per sounding level (91 levels from 0 to 18,000m)
  public instability: InstabilityTelemetry = {
    cape: 0,
    cin: 0,
    lcl: 1200,
    lfc: 1800,
    el: 11000,
    freezingLevel: 4100,
    homogeneousFreezeLevel: 9400,
    lapseRate03km: 7.0,
    bulkShear06km: 15,
    srh03km: 120,
    precipitableWaterMM: 35,
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
    }

    const t0 = cfg.surfaceTempC + 273.15;
    const p0 = cfg.surfacePressureHPa * 100.0;
    const rh0 = Math.max(0.05, Math.min(0.99, cfg.surfaceRelHumidity / 100.0));
    const qv0 = rh0 * saturationMixingRatioLiquid(t0, p0);

    // Tropopause altitude scales naturally with surface warmth & lapse rate (approx 11.8 - 14.8 km)
    const tropopauseZ = Math.max(
      10800,
      Math.min(15200, 12800 + (cfg.surfaceTempC - 26.0) * 180)
    );

    const gammaEnv = cfg.envLapseRateKPerKm / 1000.0; // K/m
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

      // Environmental temperature profile with boundary-layer mixing, optional capping inversion around 1.65 km, and stratospheric inversion above tropopause
      let tempK: number;
      if (z <= tropopauseZ) {
        // Slight super-adiabatic / well-mixed lowest 600 m during solar heating
        const blBoost =
          cfg.solarHeatingFactor * 1.15 * Math.exp(-z / 450.0);
        // Capping inversion Gaussian bump centered at z = 1650 m (830 hPa lid)
        const capBump =
          cfg.cappingInversionStrengthK *
          Math.exp(-Math.pow((z - 1650.0) / 420.0, 2));
        tempK = t0 - gammaEnv * z + blBoost + capBump;
      } else {
        const tempAtTrop =
          t0 -
          gammaEnv * tropopauseZ +
          cfg.cappingInversionStrengthK *
            Math.exp(-Math.pow((tropopauseZ - 1650.0) / 420.0, 2));
        // Lower stratosphere warms at ~2.4 K/km, strongly braking convective updrafts
        tempK = tempAtTrop + 0.0024 * (z - tropopauseZ);
      }

      tempK = Math.max(192.0, tempK);

      if (!foundFreeze && tempK <= PHYS.T_FREEZE) {
        freezeZ = z;
        foundFreeze = true;
      }
      if (!foundHomo && tempK <= PHYS.T_HOMOGENEOUS_ICE) {
        homoFreezeZ = z;
        foundHomo = true;
      }

      // Hydrostatic pressure step using virtual temperature
      if (i > 0) {
        const prev = this.levels[i - 1];
        const tMean = 0.5 * (prev.tempK + tempK);
        const tvMean = tMean * (1.0 + 0.608 * prev.qvEnv);
        currentP = prev.p * Math.exp((-PHYS.G * this.dz) / (PHYS.R_D * tvMean));
      }

      // Moisture vertical profile: well-mixed boundary layer decaying exponentially above 1.5 km
      const rhProfile =
        z < 1200
          ? rh0 * (1.0 - 0.06 * (z / 1200))
          : rh0 * 0.94 * Math.exp(-(z - 1200) / 3600.0);
      const qvs = saturationMixingRatioLiquid(tempK, currentP);
      const qvEnv = Math.max(1e-6, Math.min(qvs * 0.98, z < 900 ? qv0 * (1.0 - 0.08 * (z / 900)) : rhProfile * qvs));

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
    }

    // Compute Parcel Ascent (Mixed-layer + solar surface warm perturbation parcel)
    const parcelT0 = t0 + 0.8 * cfg.solarHeatingFactor;
    const parcelQv = qv0;
    const dryLapse = PHYS.G / PHYS.CP; // 0.00976 K/m

    let tp = parcelT0;
    let lcl = DOMAIN_MAX_ALT;
    let lfc = 0;
    let el = 0;
    let foundLCL = false;
    let foundLFC = false;
    let cape = 0;
    let cin = 0;

    for (let i = 1; i < numLevels; i++) {
      const lvl = this.levels[i];
      const prev = this.levels[i - 1];
      const qvsParcel = saturationMixingRatioLiquid(tp, prev.p);

      if (!foundLCL && parcelQv < qvsParcel) {
        tp -= dryLapse * this.dz;
        const qvsNext = saturationMixingRatioLiquid(tp, lvl.p);
        if (parcelQv >= qvsNext) {
          foundLCL = true;
          lcl = lvl.z;
        }
      } else {
        if (!foundLCL) {
          foundLCL = true;
          lcl = prev.z;
        }
        const gammaM = moistAdiabaticLapseRateKPerM(tp, prev.p);
        tp -= gammaM * this.dz;
      }

      const qvCurrent = foundLCL
        ? Math.min(parcelQv, saturationMixingRatioLiquid(tp, lvl.p))
        : parcelQv;
      const tvParcel = tp * (1.0 + 0.608 * qvCurrent);
      const tvEnv = lvl.tempK * (1.0 + 0.608 * lvl.qvEnv);
      const buoy = PHYS.G * ((tvParcel - tvEnv) / tvEnv);

      if (buoy > 0 && lvl.z >= lcl) {
        if (!foundLFC) {
          foundLFC = true;
          lfc = lvl.z;
        }
        cape += buoy * this.dz;
        el = lvl.z;
      } else if (!foundLFC && buoy < 0 && lvl.z < 5000) {
        cin += Math.abs(buoy) * this.dz;
      }
    }

    if (!foundLCL) {
      lcl = Math.max(800, 125.0 * (cfg.surfaceTempC - (this.levels[0].dewpointK - 273.15)));
    }
    if (!foundLFC) {
      lfc = lcl + 600;
      el = lcl + 1200;
    }

    // Compute 0-6 km Bulk Shear, Bunkers Storm Motion, and 0-3 km SRH
    const lvl0 = this.levels[0];
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

    const lapse03 = ((lvl0.tempK - lvl3km.tempK) / 3000.0) * 1000.0;

    this.instability = {
      cape: Math.max(0, cape),
      cin: Math.max(0, cin),
      lcl,
      lfc,
      el,
      freezingLevel: foundFreeze ? freezeZ : 4000,
      homogeneousFreezeLevel: foundHomo ? homoFreezeZ : 9500,
      lapseRate03km: lapse03,
      bulkShear06km,
      srh03km: Math.max(0, Math.abs(srh)),
      precipitableWaterMM: pwIntegral, // 1 kg/m^2 = 1 mm
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
}
