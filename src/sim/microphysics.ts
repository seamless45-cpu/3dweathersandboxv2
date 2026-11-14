import { AtmosphericSounding, saturationMixingRatioIce, saturationMixingRatioLiquid } from './thermodynamics';
import { AtmosphereConfig, ConvectiveCell, PHYS, PrecipitationType } from './types';

export interface CellMicrophysicsStepOutput {
  latentHeatingKPerS: number;
  subCloudCoolingKPerS: number;
  precipLoadingDragMS2: number;
  rimingRateGKgPerS: number; // feeds Takahashi non-inductive charging!
}

/**
 * Steps the 8-compartment bulk cloud microphysics within a developing/mature/dissipating
 * convective cell column, coupling directly with updraft transport, sounding temperature,
 * CCN concentration, riming efficiency, and sub-cloud relative humidity.
 */
export function stepCellMicrophysics(
  cell: ConvectiveCell,
  dt: number,
  sounding: AtmosphericSounding,
  cfg: AtmosphereConfig
): CellMicrophysicsStepOutput {
  const lcl = sounding.instability.lcl;
  const freezeZ = sounding.instability.freezingLevel;
  const homoZ = sounding.instability.homogeneousFreezeLevel;

  // If cell hasn't reached condensation level yet, evaporate any residual condensate
  if (cell.cloudTopM <= cell.cloudBaseM + 60) {
    const evap = Math.min(cell.cloudWaterGKg, dt * 0.05);
    cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg - evap);
    cell.rainGKg = Math.max(0, cell.rainGKg * (1 - 0.08 * dt));
    cell.surfaceRainRateMMHr = 0;
    cell.precipType = 'None';
    return {
      latentHeatingKPerS: -evap * 0.001 * (PHYS.L_V / PHYS.CP),
      subCloudCoolingKPerS: 0,
      precipLoadingDragMS2: 0,
      rimingRateGKgPerS: 0,
    };
  }

  const midCloudZ = 0.45 * cell.cloudBaseM + 0.55 * cell.cloudTopM;
  const upperCloudZ = 0.22 * cell.cloudBaseM + 0.78 * cell.cloudTopM;
  const midLvl = sounding.sampleAtAltitude(midCloudZ);
  const upperLvl = sounding.sampleAtAltitude(upperCloudZ);
  const baseLvl = sounding.sampleAtAltitude(Math.max(200, cell.cloudBaseM * 0.5));

  // 1. Condensation driven by adiabatic ascent above LCL (w * dq_vs/dz) minus lateral entrainment drying
  const qvsBase = saturationMixingRatioLiquid(
    sounding.sampleAtAltitude(cell.cloudBaseM).tempK,
    sounding.sampleAtAltitude(cell.cloudBaseM).p
  );
  const qvsMid = saturationMixingRatioLiquid(midLvl.tempK, midLvl.p);
  const availableCondensatePotentialGKg = Math.max(0, (qvsBase - qvsMid) * 1000.0);

  const updraftSupply = Math.max(0, cell.updraftMaxMS);
  const depthFactor = Math.min(1.5, (cell.cloudTopM - lcl) / 3500.0);
  const condensationRate =
    updraftSupply *
    0.0055 *
    Math.max(0.25, depthFactor) *
    (1.0 + 0.12 * ( availableCondensatePotentialGKg - (cell.cloudWaterGKg + cell.supercooledWaterGKg) ));

  const entrainmentEvap =
    cell.entrainmentRate *
    (1.15 - sounding.levels[0].qvEnv * 40.0) *
    0.045 *
    (cell.cloudWaterGKg + cell.supercooledWaterGKg);

  // Partition newly condensed water into warm cloud droplets (z < freezeZ) vs supercooled water (freezeZ < z < homoZ)
  const warmDepthFrac =
    cell.cloudTopM <= freezeZ
      ? 1.0
      : Math.max(0.08, Math.min(1.0, (freezeZ - cell.cloudBaseM) / Math.max(200, cell.cloudTopM - cell.cloudBaseM)));
  const mixedDepthFrac =
    cell.cloudTopM <= freezeZ
      ? 0.0
      : Math.max(
          0.0,
          Math.min(
            1.0,
            (Math.min(cell.cloudTopM, homoZ) - Math.max(cell.cloudBaseM, freezeZ)) /
              Math.max(300, cell.cloudTopM - cell.cloudBaseM)
          )
        );
  const glaciatedDepthFrac = Math.max(0, 1.0 - warmDepthFrac - mixedDepthFrac);

  const netCond = Math.max(-0.08, condensationRate - entrainmentEvap);
  const dWarmCond = netCond * warmDepthFrac * dt;
  const dSlwCond = netCond * mixedDepthFrac * dt;
  const dVaporDepDirect = Math.max(0, netCond) * glaciatedDepthFrac * dt;

  cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg + dWarmCond);
  cell.supercooledWaterGKg = Math.max(0, cell.supercooledWaterGKg + dSlwCond);
  cell.cloudIceGKg = Math.max(0, cell.cloudIceGKg + dVaporDepDirect);

  // Upward transport of warm droplets across freezing level into supercooled liquid water
  if (cell.cloudTopM > freezeZ && cell.updraftMaxMS > 1.5) {
    const loftToSupercooled = Math.min(
      cell.cloudWaterGKg * 0.4,
      cell.cloudWaterGKg * (cell.updraftMaxMS / 2800.0) * dt
    );
    cell.cloudWaterGKg -= loftToSupercooled;
    cell.supercooledWaterGKg += loftToSupercooled;
  }

  // 2. Heterogeneous & Homogeneous Freezing + Bergeron-Findeisen Deposition
  let latentFreezeJPerKg = 0;
  if (cell.cloudTopM > freezeZ + 300) {
    const iceSupersat =
      saturationMixingRatioLiquid(upperLvl.tempK, upperLvl.p) /
        Math.max(1e-6, saturationMixingRatioIce(upperLvl.tempK, upperLvl.p)) -
      1.0;
    const bergeronRate =
      Math.max(0, iceSupersat) *
      0.032 *
      Math.sqrt(Math.max(0.02, cell.cloudIceGKg + 0.05)) *
      Math.min(1.0, cell.supercooledWaterGKg * 0.8);
    const dBergeron = Math.min(cell.supercooledWaterGKg * 0.35, bergeronRate * dt);
    cell.supercooledWaterGKg -= dBergeron;
    cell.cloudIceGKg += dBergeron;
    latentFreezeJPerKg += dBergeron * 0.001 * PHYS.L_F;

    // Homogeneous freezing above -38C isotherm
    if (cell.cloudTopM > homoZ) {
      const homoFrac = Math.min(1.0, (cell.cloudTopM - homoZ) / 1800.0);
      const dHomo = Math.min(
        cell.supercooledWaterGKg * 0.65,
        cell.supercooledWaterGKg * homoFrac * 0.18 * dt
      );
      cell.supercooledWaterGKg -= dHomo;
      cell.cloudIceGKg += dHomo;
      latentFreezeJPerKg += dHomo * 0.001 * PHYS.L_F;
    }
  }

  // 3. Ice Crystal Aggregation -> Snow Aggregates
  const aggThreshold = 0.22;
  if (cell.cloudIceGKg > aggThreshold) {
    const dAgg = Math.min(
      (cell.cloudIceGKg - aggThreshold) * 0.5,
      0.028 * (cell.cloudIceGKg - aggThreshold) * dt
    );
    cell.cloudIceGKg -= dAgg;
    cell.snowGKg += dAgg;
  }

  // 4. Riming (Supercooled water colliding with Ice/Snow -> Graupel) & Wet Growth -> Hailstones
  let rimingRateGKgPerS = 0;
  if (cell.supercooledWaterGKg > 0.08 && (cell.snowGKg + cell.cloudIceGKg + cell.graupelGKg) > 0.06) {
    const collectorMass = cell.snowGKg * 0.9 + cell.cloudIceGKg * 0.35 + cell.graupelGKg * 1.15;
    rimingRateGKgPerS =
      0.038 *
      cfg.rimingEfficiency *
      cell.supercooledWaterGKg *
      Math.min(3.5, collectorMass) *
      Math.min(1.8, 0.35 + cell.updraftMaxMS / 14.0);

    const dRime = Math.min(cell.supercooledWaterGKg * 0.55, rimingRateGKgPerS * dt);
    cell.supercooledWaterGKg -= dRime;
    // Also convert a portion of snow embryo into graupel
    const snowConvert = Math.min(cell.snowGKg * 0.35, dRime * 0.45);
    cell.snowGKg -= snowConvert;
    cell.graupelGKg += dRime + snowConvert;
    latentFreezeJPerKg += dRime * 0.001 * PHYS.L_F;

    // Hailstone growth in strong convective cores (updraft > 16 m/s & abundant supercooled water + graupel embryos)
    if (cell.updraftMaxMS > 15.5 && cell.graupelGKg > 0.45 && cell.supercooledWaterGKg > 0.35) {
      const hailFactor = (cell.updraftMaxMS - 15.5) / 18.0;
      const dHail = Math.min(
        cell.graupelGKg * 0.3,
        0.042 * hailFactor * cell.graupelGKg * cell.supercooledWaterGKg * dt
      );
      const slwAccrete = Math.min(cell.supercooledWaterGKg * 0.25, dHail * 0.5);
      cell.graupelGKg -= dHail;
      cell.supercooledWaterGKg -= slwAccrete;
      cell.hailGKg += dHail + slwAccrete;
      latentFreezeJPerKg += slwAccrete * 0.001 * PHYS.L_F;
    }
  }

  // 5. Kessler Warm-Rain Autoconversion & Collision-Coalescence Accretion
  // Higher CCN suppresses autoconversion threshold slightly, delaying warm rain until deeper cloud water builds
  const autoThresholdGKg = 0.55 * Math.pow(cfg.ccnConcentration, 0.45);
  let dAuto = 0;
  if (cell.cloudWaterGKg > autoThresholdGKg) {
    dAuto = Math.min(
      cell.cloudWaterGKg - autoThresholdGKg,
      0.022 * (cell.cloudWaterGKg - autoThresholdGKg) * dt
    );
  }
  const dAccrete = Math.min(
    cell.cloudWaterGKg - dAuto,
    0.048 * cell.cloudWaterGKg * Math.pow(Math.max(0, cell.rainGKg), 0.875) * dt
  );
  cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg - dAuto - dAccrete);
  cell.rainGKg += dAuto + dAccrete;

  // 6. Sedimentation & Melting of Snow / Graupel / Hail falling below Freezing Level
  const densityFactor = Math.sqrt(1.225 / Math.max(0.25, midLvl.rho));
  const vtRain = 6.8 * Math.pow(Math.max(0.05, cell.rainGKg), 0.18) * densityFactor; // 4 - 10 m/s
  const vtSnow = 1.35 * densityFactor;
  const vtGraupel = 4.9 * Math.pow(Math.max(0.05, cell.graupelGKg), 0.2) * densityFactor;
  const vtHail = 15.5 * Math.pow(Math.max(0.05, cell.hailGKg), 0.25) * densityFactor; // 12 - 26 m/s

  // Warm sub-freezing-level depth determines melting fraction of descending ice hydrometeors
  let latentMeltJPerKg = 0;
  if (freezeZ > 450) {
    const warmLayerFactor = Math.min(1.4, freezeZ / 3400.0);
    const snowMelt = Math.min(cell.snowGKg * 0.5, cell.snowGKg * 0.024 * warmLayerFactor * dt);
    const graupelMelt = Math.min(cell.graupelGKg * 0.45, cell.graupelGKg * 0.032 * warmLayerFactor * dt);
    // Large hail survives partial melting if freezeZ isn't excessively high!
    const hailMelt = Math.min(cell.hailGKg * 0.25, cell.hailGKg * 0.012 * warmLayerFactor * dt);

    cell.snowGKg -= snowMelt;
    cell.graupelGKg -= graupelMelt;
    cell.hailGKg -= hailMelt;
    cell.rainGKg += snowMelt + graupelMelt + hailMelt * 0.7;

    latentMeltJPerKg = (snowMelt + graupelMelt + hailMelt) * 0.001 * PHYS.L_F;
  }

  // 7. Sub-Cloud Rain Evaporation, Virga & Cold-Pool Evaporative Cooling
  const subCloudQvs = saturationMixingRatioLiquid(baseLvl.tempK, baseLvl.p);
  const subCloudDeficit = Math.max(0, 1.0 - baseLvl.qvEnv / Math.max(1e-5, subCloudQvs));
  const subCloudDepthKm = Math.max(0.3, cell.cloudBaseM / 1000.0);

  // Fraction of falling rain that evaporates before hitting ground (Virga when sub-cloud layer is dry & high-based!)
  const virgaEvapPotential = Math.min(
    0.96,
    subCloudDeficit * subCloudDepthKm * (0.48 / Math.max(0.35, Math.sqrt(cell.rainGKg + 0.1)))
  );
  cell.virgaFraction = cell.rainGKg > 0.04 ? virgaEvapPotential : 0;

  const fallOutColumnH = Math.max(1800, cell.cloudTopM - cell.cloudBaseM * 0.35);
  const rainFallout = cell.rainGKg * (vtRain / fallOutColumnH) * dt;
  const hailFallout = cell.hailGKg * (vtHail / fallOutColumnH) * dt;
  const graupelFallout = cell.graupelGKg * (vtGraupel / (fallOutColumnH * 1.4)) * dt;
  const snowFallout = freezeZ < 600 ? cell.snowGKg * (vtSnow / fallOutColumnH) * dt : 0;

  const rainEvaporatedSubCloud = rainFallout * virgaEvapPotential;
  cell.rainGKg = Math.max(0, cell.rainGKg - rainFallout);
  cell.hailGKg = Math.max(0, cell.hailGKg - hailFallout);
  cell.graupelGKg = Math.max(0, cell.graupelGKg - graupelFallout * (freezeZ < 1500 ? 1.0 : 0.25));
  cell.snowGKg = Math.max(0, cell.snowGKg - snowFallout);

  // Dissipative anvil sublimation when updraft weakens
  if (cell.stage === 'dissipating' || cell.updraftMaxMS < 2.0) {
    cell.cloudIceGKg = Math.max(0, cell.cloudIceGKg * (1.0 - 0.008 * dt));
    cell.snowGKg = Math.max(0, cell.snowGKg * (1.0 - 0.011 * dt));
    cell.cloudWaterGKg = Math.max(0, cell.cloudWaterGKg * (1.0 - 0.022 * dt));
    cell.supercooledWaterGKg = Math.max(0, cell.supercooledWaterGKg * (1.0 - 0.025 * dt));
  }

  // Surface rainfall flux: rho_air * q_precip (kg/kg) * v_t (m/s) * 3600 -> kg/(m^2*hr) == mm/hr
  const reachingRainFlux =
    baseLvl.rho * (cell.rainGKg * 0.001) * vtRain * (1.0 - virgaEvapPotential) * 3600.0;
  const reachingHailFlux =
    freezeZ < 4800 ? baseLvl.rho * (cell.hailGKg * 0.001) * vtHail * 0.65 * 3600.0 : 0;
  const reachingGraupelSnowFlux =
    freezeZ < 1400
      ? baseLvl.rho * ((cell.graupelGKg * vtGraupel + cell.snowGKg * vtSnow) * 0.001) * 3600.0
      : 0;

  cell.surfaceRainRateMMHr = Math.max(0, reachingRainFlux + reachingHailFlux + reachingGraupelSnowFlux);

  // Classify precipitation regime physically
  cell.precipType = classifyCellPrecipitation(
    cell.rainGKg,
    cell.hailGKg,
    cell.graupelGKg,
    cell.snowGKg,
    cell.surfaceRainRateMMHr,
    cell.virgaFraction,
    freezeZ
  );

  // Total condensate mass ratio for gravitational precipitation loading drag (-g * q_total)
  const totalHydrometeorKgKg =
    (cell.cloudWaterGKg +
      cell.supercooledWaterGKg +
      cell.cloudIceGKg +
      cell.snowGKg +
      cell.graupelGKg +
      cell.hailGKg +
      cell.rainGKg) *
    0.001;

  const precipLoadingDragMS2 = PHYS.G * totalHydrometeorKgKg;

  const latentCondJPerKg = (dWarmCond + dSlwCond + dVaporDepDirect) * 0.001 * PHYS.L_V;
  const netLatentHeatingKPerS =
    (latentCondJPerKg + latentFreezeJPerKg - latentMeltJPerKg) / (PHYS.CP * Math.max(1e-3, dt));

  const subCloudCoolingKPerS =
    ((rainEvaporatedSubCloud * 0.001 * PHYS.L_V + latentMeltJPerKg * 0.55) /
      (PHYS.CP * Math.max(1e-3, dt))) *
    1.8;

  return {
    latentHeatingKPerS: netLatentHeatingKPerS,
    subCloudCoolingKPerS: Math.max(0, subCloudCoolingKPerS),
    precipLoadingDragMS2,
    rimingRateGKgPerS,
  };
}

export function classifyCellPrecipitation(
  rainGKg: number,
  hailGKg: number,
  graupelGKg: number,
  snowGKg: number,
  surfaceMMHr: number,
  virgaFrac: number,
  freezeZ: number
): PrecipitationType {
  if (rainGKg > 0.18 && virgaFrac > 0.82 && surfaceMMHr < 0.35) {
    return 'Virga';
  }
  if (surfaceMMHr < 0.12) {
    return 'None';
  }
  if (freezeZ < 650 && snowGKg > 0.25) {
    return rainGKg > 0.2 ? 'Mixed-Phase Precipitation' : 'Snow / Ice Pellets';
  }
  if (hailGKg > 0.42 && surfaceMMHr > 15.0) {
    return 'Hail & Heavy Rain';
  }
  if (graupelGKg > 0.65 && freezeZ < 2400 && surfaceMMHr > 2.0) {
    return 'Graupel Shower';
  }
  if (hailGKg > 0.18 && graupelGKg > 0.4 && surfaceMMHr > 8.0) {
    return 'Mixed-Phase Precipitation';
  }
  if (surfaceMMHr >= 65.0) {
    return 'Torrential Convective Rain';
  }
  if (surfaceMMHr >= 22.0) {
    return 'Heavy Rain';
  }
  if (surfaceMMHr >= 5.5) {
    return 'Moderate Rain';
  }
  if (surfaceMMHr >= 1.0) {
    return 'Light Rain';
  }
  return 'Drizzle';
}
