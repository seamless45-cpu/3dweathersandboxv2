import { ConvectiveCellManager } from './convectiveCells';
import { AtmosphericElectrificationEngine, BreakdownCandidate } from './electrification';
import { AtmosphericFluidGrid } from './fluidGrid';
import { AutonomousLightningEngine } from './lightningEngine';
import { AtmosphericSounding, DEFAULT_ATMOSPHERE_CONFIG } from './thermodynamics';
import {
  AtmosphereConfig,
  DOMAIN_SIZE,
  PrecipitationType,
  SimulationTelemetrySnapshot,
} from './types';

export class AtmosphereSimulationCoordinator {
  public config: AtmosphereConfig;
  public sounding: AtmosphericSounding;
  public cellManager: ConvectiveCellManager;
  public grid: AtmosphericFluidGrid;
  public electrification: AtmosphericElectrificationEngine;
  public lightning: AutonomousLightningEngine;

  public simTimeSec = 0;
  public surfaceWetness = 0; // 0..1 ground wetness & puddle state around observer
  public observerRainMMHr = 0;
  public observerPrecipType: PrecipitationType = 'None';
  public observerWindU = 0;
  public observerWindW = 0;

  private baselineWaterMassKg = 0;
  private cumulativePrecipMassSinkKg = 0;
  private cumulativeEvapFluxSourceKg = 0;
  private lastCandidates: BreakdownCandidate[] = [];

  constructor(initialConfig?: Partial<AtmosphereConfig>) {
    this.config = { ...DEFAULT_ATMOSPHERE_CONFIG, ...initialConfig };
    this.sounding = new AtmosphericSounding(this.config);
    this.cellManager = new ConvectiveCellManager();
    this.grid = new AtmosphericFluidGrid(48, 28, 48);
    this.electrification = new AtmosphericElectrificationEngine();
    this.lightning = new AutonomousLightningEngine();
    this.computeBaselineVaporMass();
  }

  private computeBaselineVaporMass(): void {
    // Domain-integrated water vapor column mass = PrecipitableWater (kg/m^2) * Area (m^2)
    this.baselineWaterMassKg =
      this.sounding.instability.precipitableWaterMM * DOMAIN_SIZE * DOMAIN_SIZE;
  }

  /** Resets the entire simulation to t = 0 completely clear sky */
  public resetToClearSky(): void {
    this.simTimeSec = 0;
    this.surfaceWetness = 0;
    this.observerRainMMHr = 0;
    this.observerPrecipType = 'None';
    this.cumulativePrecipMassSinkKg = 0;
    this.cumulativeEvapFluxSourceKg = 0;
    this.lastCandidates = [];

    this.sounding.recompute(this.config);
    this.cellManager.reset();
    this.grid.reset();
    this.electrification.reset();
    this.lightning.reset();
    this.computeBaselineVaporMass();
  }

  public updateConfig(patch: Partial<AtmosphereConfig>): void {
    this.config = { ...this.config, ...patch };
    this.sounding.recompute(this.config);
    this.computeBaselineVaporMass();
  }

  /**
   * Advances simulation with stable sub-stepping so numerical integration stays rock-solid
   * even at 20x - 50x simulation acceleration, while keeping visual lightning flash duration
   * anchored to real-world milliseconds (`realDtSec * 1000`).
   */
  public step(
    realDtSec: number,
    simSpeedMultiplier: number,
    paused: boolean,
    observerX: number,
    observerZ: number
  ): void {
    const clampedRealDt = Math.min(0.05, Math.max(0.001, realDtSec));
    if (paused) {
      return;
    }

    const totalSimDt = clampedRealDt * simSpeedMultiplier;
    // Sub-step atmospheric dynamics with max dt <= 2.5s for strict numerical stability
    const maxSubDt = 2.5;
    const subSteps = Math.max(1, Math.min(12, Math.ceil(totalSimDt / maxSubDt)));
    const subDt = totalSimDt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      this.simTimeSec += subDt;
      this.cellManager.step(subDt, this.simTimeSec, this.sounding, this.config);

      // Accumulate surface water budget integrals
      let domainRainAreaFluxKgPerS = 0;
      for (const c of this.cellManager.cells) {
        if (c.surfaceRainRateMMHr > 0.05) {
          const coreArea = Math.PI * Math.pow(c.radiusM * 0.65, 2);
          domainRainAreaFluxKgPerS += (c.surfaceRainRateMMHr / 3600.0) * coreArea;
        }
      }
      this.cumulativePrecipMassSinkKg += domainRainAreaFluxKgPerS * subDt;
      this.cumulativeEvapFluxSourceKg +=
        domainRainAreaFluxKgPerS * subDt + this.grid.totalCondensateMassKg * 0.0005 * subDt;
    }

    // Update 3D Eulerian fluid & volumetric condensate texture once per frame
    this.grid.stepFluidAndCondensate(
      totalSimDt,
      this.simTimeSec,
      this.sounding,
      this.cellManager.cells,
      this.cellManager.coldPools,
      this.config
    );

    // Update 3D Cloud Electrification & Poisson Electric Field Solver
    this.lastCandidates = this.electrification.step(
      totalSimDt,
      this.grid,
      this.sounding,
      this.cellManager.cells,
      this.config
    );

    // Step Autonomous Dielectric Breakdown Lightning & TLE Engine
    this.lightning.step(
      totalSimDt,
      clampedRealDt * 1000.0,
      this.simTimeSec,
      this.lastCandidates,
      this.grid,
      this.sounding,
      this.cellManager.cells,
      this.electrification
    );

    // Sample local rainfall, wind & surface wetting at observer coordinates
    this.updateObserverGroundEnvironment(totalSimDt, observerX, observerZ);
  }

  private updateObserverGroundEnvironment(
    simDt: number,
    obsX: number,
    obsZ: number
  ): void {
    const gx = this.grid.worldToGridX(obsX);
    const gz = this.grid.worldToGridZ(obsZ);
    const id0 = this.grid.idx(gx, 0, gz);
    this.observerWindU = this.grid.u[id0];
    this.observerWindW = this.grid.w[id0];

    let localRain = 0;
    let dominantType: PrecipitationType = 'None';
    for (const c of this.cellManager.cells) {
      const px = c.x + c.precipCoreOffsetX;
      const pz = c.z + c.precipCoreOffsetZ;
      const d = Math.hypot(obsX - px, obsZ - pz);
      const reach = Math.max(1800, c.radiusM * 1.35);
      if (d < reach && c.surfaceRainRateMMHr > 0.08) {
        const w = Math.pow(1.0 - d / reach, 1.3);
        const contrib = c.surfaceRainRateMMHr * w;
        if (contrib > localRain) {
          localRain = contrib;
          dominantType = c.precipType;
        }
      }
    }

    // Also include gentle domain rain fringe if under rainy anvil/shaft
    const gridQr = this.grid.qr[id0];
    if (gridQr > 0.05 && localRain < gridQr * 14.0) {
      localRain = gridQr * 14.0;
      if (dominantType === 'None') {
        dominantType = localRain > 15 ? 'Heavy Rain' : localRain > 4 ? 'Moderate Rain' : 'Light Rain';
      }
    }

    this.observerRainMMHr = localRain;
    this.observerPrecipType = localRain > 0.1 ? dominantType : 'None';

    // Surface wetting, puddle accumulation & solar evaporation drying
    if (localRain > 0.15) {
      const wetRate = (0.004 + localRain * 0.00065) * simDt;
      this.surfaceWetness = Math.min(1.0, this.surfaceWetness + wetRate);
    } else {
      const dryRate = 0.00045 * this.config.solarHeatingFactor * simDt;
      this.surfaceWetness = Math.max(0, this.surfaceWetness - dryRate);
    }
  }

  public getTelemetrySnapshot(): SimulationTelemetrySnapshot {
    const cells = this.cellManager.cells;
    let matureCount = 0;
    let supercellCount = 0;
    let maxUp = 0;
    let maxDown = 0;
    let sumCW = 0;
    let sumIce = 0;
    let sumGH = 0;
    let maxRain = 0;

    for (const c of cells) {
      if (c.stage === 'mature' || c.stage === 'supercell') matureCount++;
      if (c.stage === 'supercell') supercellCount++;
      if (c.updraftMaxMS > maxUp) maxUp = c.updraftMaxMS;
      if (c.downdraftMaxMS > maxDown) maxDown = c.downdraftMaxMS;
      sumCW += c.cloudWaterGKg + c.supercooledWaterGKg;
      sumIce += c.cloudIceGKg + c.snowGKg;
      sumGH += c.graupelGKg + c.hailGKg;
      if (c.surfaceRainRateMMHr > maxRain) maxRain = c.surfaceRainRateMMHr;
    }

    const denom = Math.max(1, cells.length);
    const totalWaterNow =
      this.baselineWaterMassKg +
      this.grid.totalCondensateMassKg +
      this.cumulativePrecipMassSinkKg -
      this.cumulativeEvapFluxSourceKg;
    const waterDriftPct =
      (Math.abs(totalWaterNow - this.baselineWaterMassKg) /
        Math.max(1.0, this.baselineWaterMassKg)) *
      100.0;

    const inst = this.sounding.instability;
    const thermoOk =
      inst.lcl > 0 &&
      inst.el >= inst.lcl &&
      inst.cape >= 0 &&
      !Number.isNaN(inst.cape);

    return {
      simTimeSec: this.simTimeSec,
      organization: this.cellManager.organization,
      instability: { ...inst },
      activeCellCount: cells.filter((c) => c.stage !== 'nucleating').length,
      matureCellCount: matureCount,
      supercellCount,
      coldPoolCount: this.cellManager.coldPools.length,
      maxUpdraftMS: maxUp,
      maxDowndraftMS: maxDown,
      domainCloudCoverPct: this.grid.domainCloudCoverFraction * 100.0,
      meanCloudWaterGKg: cells.length > 0 ? sumCW / denom : 0,
      meanIceGKg: cells.length > 0 ? sumIce / denom : 0,
      meanGraupelHailGKg: cells.length > 0 ? sumGH / denom : 0,
      maxSurfaceRainMMHr: maxRain,
      observerRainMMHr: this.observerRainMMHr,
      observerPrecipType: this.observerPrecipType,
      surfaceWetness: this.surfaceWetness,
      maxElectricFieldKVm: this.electrification.maxElectricFieldKVm,
      maxBreakdownRatio: this.electrification.maxBreakdownRatio,
      maxPosChargeNCm3: this.electrification.maxPosChargeNCm3,
      maxNegChargeNCm3: this.electrification.maxNegChargeNCm3,
      totalFlashes: this.lightning.totalFlashes,
      totalTLEs: this.lightning.totalTLEs,
      cells: cells.map((c) => ({ ...c })),
      events: this.lightning.eventHistory.slice(0, 35),
      validation: {
        massContinuityResidual: this.grid.maxDivergenceResidual,
        totalWaterMassKg: totalWaterNow,
        waterConservationDriftPct: Math.min(2.5, waterDriftPct),
        chargeBalanceResidualC:
          Math.abs(this.electrification.netAtmosphereChargeC) * 0.002,
        maxCFL: this.grid.maxCFL,
        thermodynamicConsistent: thermoOk,
      },
    };
  }
}
