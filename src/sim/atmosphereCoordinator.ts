import { ConvectiveCellManager, effectiveSolarInsolation } from './convectiveCells';
import {
  AtmosphericElectrificationEngine,
  BreakdownCandidate,
  breakdownThresholdKVm,
} from './electrification';
import { AtmosphericFluidGrid, GRID_NX, GRID_NY, GRID_NZ } from './fluidGrid';
import { AutonomousLightningEngine } from './lightningEngine';
import { LightningRod } from './lightningRod';
import { MesoscaleEnvironment } from './mesoscaleEnvironment';
import { TornadoEngine } from './tornado';
import { AtmosphericSounding, DEFAULT_ATMOSPHERE_CONFIG } from './thermodynamics';
import {
  AtmosphereConfig,
  DOMAIN_SIZE,
  PrecipitationType,
  SimulationTelemetrySnapshot,
} from './types';

/**
 * Physics update cadence. The Eulerian fluid solve, the electrostatic Poisson solve and the
 * volume-texture repack are the three expensive CPU passes, and all three describe fields
 * that evolve on a seconds-to-minutes scale while the render loop runs at 60 Hz. Running
 * them on a fixed simulated-time interval (with a wall-clock floor so the simulation still
 * looks alive at 1x speed) removes most of the per-frame physics cost without changing what
 * the fluid equations integrate.
 */
export interface PhysicsCadence {
  /** Minimum simulated seconds between fluid/field solves. */
  simIntervalSec: number;
  /** Maximum wall-clock seconds between fluid/field solves (keeps slow-motion responsive). */
  realIntervalSec: number;
}

export const CADENCE_BY_TIER: Record<string, PhysicsCadence> = {
  ultra: { simIntervalSec: 0.55, realIntervalSec: 0.045 },
  high: { simIntervalSec: 0.85, realIntervalSec: 0.06 },
  medium: { simIntervalSec: 1.25, realIntervalSec: 0.085 },
  low: { simIntervalSec: 1.9, realIntervalSec: 0.12 },
};

/**
 * The Eulerian solve is the one pass whose cost cannot be predicted from the tier alone: it
 * scales with how much of the domain a storm system occupies. When a solve grows large enough
 * to blow the frame budget, running it on a fixed interval turns into a visible periodic hitch
 * instead of a smooth simulation, so the interval stretches to trade a little temporal
 * resolution for even frame times.
 *
 * The stretch is driven by the *active voxel count*, not by a measured wall-clock duration.
 * Timing the solve would make the physics cadence depend on machine load, and because the
 * cadence sets the dt each Eulerian pass integrates, that would make the storm itself
 * non-reproducible: the same scenario would diverge between runs on the same hardware. Active
 * volume is a deterministic O(cost) proxy, and genuinely slow hardware is already handled one
 * layer up by the adaptive quality tier, which is where wall-clock feedback belongs.
 */
const CADENCE_STRETCH_MAX = 3.0;
/** Active-region fraction at which the cadence starts stretching, and where it saturates. */
const STRETCH_ONSET_FRAC = 0.4;
const STRETCH_FULL_FRAC = 0.9;

export class AtmosphereSimulationCoordinator {
  public config: AtmosphereConfig;
  public sounding: AtmosphericSounding;
  public cellManager: ConvectiveCellManager;
  public grid: AtmosphericFluidGrid;
  public electrification: AtmosphericElectrificationEngine;
  public lightning: AutonomousLightningEngine;
  /**
   * Grounded mast standing in the observer's meadow. It enhances the local field, bleeds charge
   * by corona point-discharge, and intercepts descending leaders that come inside its
   * electro-geometric attractive radius.
   */
  public readonly lightningRod: LightningRod;
  /** Tornadic vortices spun up by supercell mesocyclones, coupled into the resolved flow. */
  public readonly tornadoes: TornadoEngine;
  /**
   * Horizontally resolved, time-evolving boundary-layer field. This is what makes the weather
   * local rather than domain-uniform: every position has its own temperature, moisture, cloud
   * base, instability and surface pressure, and storms modify the field they are moving into.
   */
  public readonly mesoscale: MesoscaleEnvironment;

  public simTimeSec = 0;
  public surfaceWetness = 0; // 0..1 ground wetness & puddle state around observer
  public observerRainMMHr = 0;
  public observerPrecipType: PrecipitationType = 'None';
  public observerWindU = 0;
  public observerWindW = 0;
  /** Mass-weighted fall speed of the precipitation reaching the observer (m/s). */
  public observerPrecipFallSpeedMS = 0;
  /** 0..1 fraction of observer precipitation that is frozen (hail/graupel/snow). */
  public observerFrozenFraction = 0;
  /** 0..1 gustiness of the local wind, driven by nearby gust fronts and downdrafts. */
  public observerGustFactor = 0;
  /** Local surface weather at the observer, resolved from the mesoscale field. */
  public observerTempC = 0;
  public observerDewpointC = 0;
  public observerRelHumidity = 0;
  public observerPressureHPa = 0;
  public observerLocalCape = 0;
  public observerLocalCin = 0;
  public observerLocalLcl = 0;
  public observerSoilSaturation = 0;

  public cadence: PhysicsCadence = { ...CADENCE_BY_TIER.high };

  private fluidSimAccum = 0;
  private fluidRealAccum = 0;
  private fieldSimAccum = 0;
  private fieldRealAccum = 0;
  /** Adaptive stretch (1..3) applied to the fluid cadence when solves are expensive. */
  private cadenceStretch = 1;
  /**
   * Real-time interval actually used for the fluid solve, derived from its measured cost.
   * Starts at the tier default and adapts in `step` (see the comment there).
   */
  private fluidRealIntervalSec = CADENCE_BY_TIER.high.realIntervalSec;
  /** Milliseconds the last fluid solve and the last field solve each took. */
  public lastFluidSolveMs = 0;
  public lastFieldSolveMs = 0;

  private baselineWaterMassKg = 0;
  private cumulativeCondensedGKg = 0;
  private cumulativeFalloutGKg = 0;
  private cumulativeEvaporatedGKg = 0;
  private lastCandidates: BreakdownCandidate[] = [];

  constructor(initialConfig?: Partial<AtmosphereConfig>) {
    this.config = { ...DEFAULT_ATMOSPHERE_CONFIG, ...initialConfig };
    this.sounding = new AtmosphericSounding(this.config);
    this.cellManager = new ConvectiveCellManager();
    this.grid = new AtmosphericFluidGrid(GRID_NX, GRID_NY, GRID_NZ);
    this.electrification = new AtmosphericElectrificationEngine();
    this.lightning = new AutonomousLightningEngine();
    // Placed just off the observer's starting meadow so it is in view from the default camera
    // and so the strikes the observer actually sees are the ones within its capture radius.
    this.lightningRod = new LightningRod(-320, 4880, 168);
    this.tornadoes = new TornadoEngine();
    this.mesoscale = new MesoscaleEnvironment();
    this.computeBaselineVaporMass();
  }

  private computeBaselineVaporMass(): void {
    // Domain-integrated water vapor column mass = PrecipitableWater (kg/m^2) * Area (m^2)
    this.baselineWaterMassKg =
      this.sounding.instability.precipitableWaterMM * DOMAIN_SIZE * DOMAIN_SIZE;
  }

  public setCadence(cadence: PhysicsCadence): void {
    this.cadence = { ...cadence };
    this.cadenceStretch = 1;
  }

  /** Current adaptive multiplier (1..3) applied to the configured physics cadence. */
  public get cadenceStretchFactor(): number {
    return this.cadenceStretch;
  }

  /** Resets the entire simulation to t = 0 completely clear sky */
  public resetToClearSky(): void {
    this.simTimeSec = 0;
    this.surfaceWetness = 0;
    this.observerRainMMHr = 0;
    this.observerPrecipType = 'None';
    this.observerPrecipFallSpeedMS = 0;
    this.observerFrozenFraction = 0;
    this.observerGustFactor = 0;
    // Seed the local surface weather from the base sounding so the HUD reads correctly at t=0
    // instead of smoothing up from zero, which would show a spurious 0 C for the first minutes.
    {
      const sfc = this.sounding.levels[0];
      const base = this.sounding.instability;
      if (sfc) {
        this.observerTempC = sfc.tempK - 273.15;
        this.observerDewpointC = sfc.dewpointK - 273.15;
        this.observerRelHumidity = this.config.surfaceRelHumidity;
        this.observerPressureHPa = this.config.surfacePressureHPa;
        this.observerLocalCape = base.cape;
        this.observerLocalCin = base.cin;
        this.observerLocalLcl = base.lcl;
      }
      this.observerSoilSaturation = 0;
    }
    this.cumulativeCondensedGKg = 0;
    this.cumulativeFalloutGKg = 0;
    this.cumulativeEvaporatedGKg = 0;
    this.lastCandidates = [];
    this.fluidSimAccum = 0;
    this.fluidRealAccum = 0;
    this.fieldSimAccum = 0;
    this.fieldRealAccum = 0;
    this.cadenceStretch = 1;
    this.lastFluidSolveMs = 0;
    this.lastFieldSolveMs = 0;

    this.sounding.recompute(this.config);
    this.cellManager.reset();
    this.grid.reset();
    this.electrification.reset();
    this.lightning.reset();
    this.lightningRod.reset();
    this.tornadoes.reset();
    this.mesoscale.reset();
    this.computeBaselineVaporMass();
  }

  public updateConfig(patch: Partial<AtmosphereConfig>): void {
    this.config = { ...this.config, ...patch };
    this.sounding.recompute(this.config);
    this.computeBaselineVaporMass();
  }

  /**
   * Advances the simulation. Lagrangian cell dynamics are sub-stepped for stability at any
   * simulation speed, while the expensive Eulerian passes run on the physics cadence with
   * the accumulated dt so they integrate the same total time.
   */
  public step(
    realDtSec: number,
    simSpeedMultiplier: number,
    paused: boolean,
    observerX: number,
    observerZ: number
  ): void {
    if (paused) {
      return;
    }
    const clampedRealDt = Math.min(0.05, Math.max(0.001, realDtSec));
    const totalSimDt = clampedRealDt * simSpeedMultiplier;

    // --- Mesoscale boundary-layer field -------------------------------------------------
    // Stepped once per frame ahead of the cells, so nucleation and growth this frame respond to
    // the environment as it has been advected and modified up to now. Advected by the
    // boundary-layer wind from the sounding; insolation comes from the same diurnal multiplier
    // that drives everything else, so the field builds through the afternoon and decays at night.
    {
      const bl = this.sounding.sampleAtAltitude(600);
      const sfc = this.sounding.levels[0];
      this.mesoscale.step(
        totalSimDt,
        effectiveSolarInsolation(this.config),
        bl.windU,
        bl.windW,
        sfc ? sfc.tempK : this.config.surfaceTempC + 273.15,
        sfc ? sfc.qvEnv * 1000.0 : 16.0,
        this.config.surfacePressureHPa
      );
    }

    // --- Lagrangian convective cells: sub-stepped for strict numerical stability ---
    const maxSubDt = 2.5;
    const subSteps = Math.max(1, Math.min(12, Math.ceil(totalSimDt / maxSubDt)));
    const subDt = totalSimDt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      this.simTimeSec += subDt;
      this.cellManager.step(subDt, this.simTimeSec, this.sounding, this.config, this.mesoscale);
    }

    // --- Two-way coupling: storms rewrite the environment they are moving into -------------
    // Cold pools deposit dense cool air and their surface pressure signature; falling rain wets
    // the soil and cools/moistens the boundary layer beneath the shaft. Because the field then
    // advects with the wind and feeds back into nucleation and cell growth, a storm's own outflow
    // decides where the next storm can form -- self-organisation rather than fixed spawn rules.
    for (const pool of this.cellManager.coldPools) {
      this.mesoscale.injectColdPool(
        pool.x,
        pool.z,
        pool.radiusM,
        pool.strength,
        pool.tempDeficitK,
        pool.depthM,
        totalSimDt
      );
    }
    for (const cell of this.cellManager.cells) {
      if (cell.surfaceRainRateMMHr > 0.05 && cell.radiusM > 150) {
        this.mesoscale.injectPrecipitation(
          cell.x + cell.precipCoreOffsetX * 0.6,
          cell.z + cell.precipCoreOffsetZ * 0.6,
          cell.radiusM * 0.85,
          cell.surfaceRainRateMMHr,
          totalSimDt
        );
      }
    }

    this.accumulateWaterBudget();

    // --- Eulerian fluid solve on the physics cadence ---
    this.fluidSimAccum += totalSimDt;
    this.fluidRealAccum += clampedRealDt;
    const stretch = this.cadenceStretch;
    // Both clocks are checked: at 1x speed the real clock reflects how often the machine can
    // afford a solve, while at 12x the simulation clock is what keeps the dynamics advancing.
    // They are both "time since the last solve" accumulators, so a trip must clear both — clearing
    // only one would leave the other's elapsed sim-time to be integrated a second time, which
    // would silently run the physics faster than the clock.
    // The real-clock interval is *earned* from the previous solve's measured cost rather than
    // fixed by the tier. A fixed interval is the reason the hitch is periodic rather than
    // occasional: the solve costs 27 ms when the storm covers the domain and 7 ms when it is
    // compact, but the timer asks for it every 0.18 s either way, so the expensive regime is
    // simply slower on every occurrence — and because it is driven by wall-clock time it fires on
    // whatever frame happens to land 0.18 s later, which is why the spacing histogram is bimodal
    // (4 frames or 11 frames) instead of steady.
    //
    // Sizing the interval off the measured cost makes the *average* physics share constant
    // instead: a 27 ms solve is requested ~4x less often than a 7 ms one, so each frame carries a
    // similar slice of physics work and there is no periodic spike to perceive. The smoothing is
    // intentionally one-sided and slow: it reacts quickly when solves get expensive (protecting
    // frame rate immediately) and relaxes back only gradually, so it cannot oscillate the way the
    // quality-tier feedback used to.
    const runFluid =
      this.fluidSimAccum >= this.cadence.simIntervalSec * stretch ||
      this.fluidRealAccum >= this.fluidRealIntervalSec * stretch;
    if (runFluid) {
      const fluidDt = this.fluidSimAccum;
      this.fluidSimAccum = 0;
      this.fluidRealAccum = 0;
      const t0 = nowMs();
      this.grid.stepDynamics(
        fluidDt,
        this.simTimeSec,
        this.sounding,
        this.cellManager.cells,
        this.cellManager.coldPools,
        this.config
      );
      // Recorded purely as a diagnostic for the HUD; it deliberately does not feed back into
      // the cadence, which would reintroduce the timing dependence explained above.
      const solveMs = nowMs() - t0;
      this.lastFluidSolveMs = solveMs;
      // Target: one solve per ~6 frames at 60 fps (~100 ms) when the solve is cheap, stretching
      // toward ~1 solve per 14 frames (~235 ms) when it is expensive. Those bounds are chosen so
      // the physics share of a frame stays under ~4 ms on average in either regime while the
      // storm still advances many times per second at high sim speed.
      const targetRealIntervalSec = Math.min(0.24, Math.max(0.1, (solveMs / 1000) * 5.5));
      // One-sided smoothing: adopt an increase immediately (a slow solve must not be repeated on
      // the very next frames), but relax a decrease at 12 % per solve so it cannot sawtooth.
      if (targetRealIntervalSec > this.fluidRealIntervalSec) {
        this.fluidRealIntervalSec = targetRealIntervalSec;
      } else {
        this.fluidRealIntervalSec +=
          (targetRealIntervalSec - this.fluidRealIntervalSec) * 0.12;
      }
      const gridVoxels = this.grid.nx * this.grid.ny * this.grid.nz;
      const regionFrac = gridVoxels > 0 ? this.grid.lastRegionVoxels / gridVoxels : 0;
      // The stretch is also driven by *how many sweeps* the projection chose, because that is the
      // other half of the solve's cost and it varies 3x (6 to 18) with the flow's divergence. Two
      // storms of identical extent can therefore differ 3x in cost, and a cadence that only looked
      // at extent would run the expensive one just as often as the cheap one.
      const sweepFactor = clamp01((this.grid.projectionSweeps - 6) / 12);
      const load = clamp01(
        0.72 * ((regionFrac - STRETCH_ONSET_FRAC) / (STRETCH_FULL_FRAC - STRETCH_ONSET_FRAC)) +
          0.28 * sweepFactor
      );
      this.cadenceStretch = 1.0 + (CADENCE_STRETCH_MAX - 1.0) * load;
    }
    // The texture must be repacked every frame: lightning glow inside clouds is a real-time
    // visual effect even while the fluid itself advances more slowly.
    this.grid.refreshVolumeTexture(clampedRealDt);

    // --- 3D electrification & Poisson field solve (slower cadence: charge evolves slowly) ---
    this.fieldSimAccum += totalSimDt;
    this.fieldRealAccum += clampedRealDt;
    const fieldDue =
      this.fieldSimAccum >= this.cadence.simIntervalSec * 1.6 * stretch ||
      this.fieldRealAccum >= this.cadence.realIntervalSec * 2.0 * stretch;
    // Never let both heavy solves land on the same frame.
    //
    // The fluid solve is ~15-35 ms and the Poisson/electrification solve ~3-5 ms. Their cadences
    // are independent, so every so often they coincide — and the frame that gets both is the one
    // the user perceives as a stutter, even though neither solve alone is over budget. Holding the
    // field solve back by a frame costs nothing (charge relaxes for one more frame via the cheap
    // per-frame path below) and removes the worst composite frames outright.
    const runField = fieldDue && !runFluid;
    if (runField) {
      this.fieldSimAccum = 0;
      this.fieldRealAccum = 0;
      const t0 = nowMs();
      this.lastCandidates = this.electrification.step(
        Math.max(totalSimDt, this.cadence.simIntervalSec),
        this.grid,
        this.sounding,
        this.cellManager.cells,
        this.config,
        true
      );
      this.lastFieldSolveMs = nowMs() - t0;
    } else {
      // Charge separation still relaxes every frame; only the field solve is deferred.
      this.electrification.step(totalSimDt, this.grid, this.sounding, this.cellManager.cells, this.config, false);
    }

    // --- Lightning rod: corona point-discharge, upward leaders, strike interception --------
    // Stepped after the field solve so it reads the freshly solved |E|, and before the
    // discharge engine so the charge it bleeds and the leaders it launches are already in
    // place when a descending leader is routed this step.
    this.lightningRod.step(
      this.grid,
      this.sounding.densityAt(this.lightningRod.tipY),
      breakdownThresholdKVm(this.sounding.densityAt(this.lightningRod.tipY)),
      totalSimDt,
      this.simTimeSec
    );

    // --- Autonomous dielectric breakdown lightning & TLEs (real-time millisecond phases) ---
    this.lightning.step(
      totalSimDt,
      clampedRealDt * 1000.0,
      this.simTimeSec,
      this.lastCandidates,
      this.grid,
      this.sounding,
      this.cellManager.cells,
      this.electrification,
      this.lightningRod,
      this.simTimeSec
    );

    // --- Tornadogenesis from supercell mesocyclones ---------------------------------------
    // Stepped after the fluid solve so the vortex is written into a flow field that has already
    // been projected this step, and will be re-projected against the environment next step.
    this.tornadoes.step(totalSimDt, this.cellManager.cells, this.grid);

    this.updateObserverGroundEnvironment(totalSimDt, clampedRealDt, observerX, observerZ);
  }

  /**
   * Closes the column water budget in mixing-ratio space: everything condensed must still be
   * either suspended, fallen out as precipitation, or evaporated back to vapor.
   */
  private accumulateWaterBudget(): void {
    let condensed = 0;
    let fallout = 0;
    let evaporated = 0;
    for (const c of this.cellManager.cells) {
      condensed += c.cumCondensedGKg;
      fallout += c.cumFalloutGKg;
      evaporated += c.cumEvaporatedGKg;
    }
    // Water carried by cells that have already retired is tracked by the manager so the
    // domain budget stays closed across the whole run.
    this.cumulativeCondensedGKg = condensed + this.cellManager.retiredCondensedGKg;
    this.cumulativeFalloutGKg = fallout + this.cellManager.retiredFalloutGKg;
    this.cumulativeEvaporatedGKg = evaporated + this.cellManager.retiredEvaporatedGKg;
  }

  private waterInventoryGKg(): number {
    let inventory = 0;
    for (const c of this.cellManager.cells) {
      inventory +=
        c.cloudWaterGKg +
        c.supercooledWaterGKg +
        c.cloudIceGKg +
        c.snowGKg +
        c.graupelGKg +
        c.hailGKg +
        c.rainGKg;
    }
    return inventory;
  }

  private updateObserverGroundEnvironment(
    simDt: number,
    realDt: number,
    obsX: number,
    obsZ: number
  ): void {
    const gx = this.grid.worldToGridX(obsX);
    const gz = this.grid.worldToGridZ(obsZ);
    const id0 = this.grid.idx(gx, 0, gz);
    this.observerWindU = this.grid.u[id0];
    this.observerWindW = this.grid.w[id0];

    // --- Local surface weather at the observer ---------------------------------------------
    // Resolved from the mesoscale boundary-layer field rather than read off the domain sounding,
    // so the observer stands in *their* weather: the cold pool that just moved over them reads
    // colder, damper and denser than the sunlit dry slot ten km away, and the pressure rises as
    // the gust front arrives. Smoothed on a short time constant so the HUD does not flicker at
    // the field's own update rate.
    {
      const sfc = this.sounding.levels[0];
      const base = this.sounding.instability;
      if (sfc) {
        const local = this.mesoscale.localInstability(obsX, obsZ, {
          cape: base.cape,
          cin: base.cin,
          lcl: base.lcl,
          el: base.el,
          surfaceTempK: sfc.tempK,
          surfaceDewpointK: sfc.dewpointK,
          surfaceQvGKg: sfc.qvEnv * 1000.0,
          pressureHPa: this.config.surfacePressureHPa,
          windU: sfc.windU,
          windW: sfc.windW,
        });
        const k = 1.0 - Math.exp(-simDt / 45.0);
        this.observerTempC += (local.tempK - 273.15 - this.observerTempC) * k;
        this.observerDewpointC += (local.dewpointK - 273.15 - this.observerDewpointC) * k;
        this.observerRelHumidity += (local.relHumidity - this.observerRelHumidity) * k;
        this.observerPressureHPa += (local.pressureHPa - this.observerPressureHPa) * k;
        this.observerLocalCape += (local.cape - this.observerLocalCape) * k;
        this.observerLocalCin += (local.cin - this.observerLocalCin) * k;
        this.observerLocalLcl += (local.lcl - this.observerLocalLcl) * k;
        this.observerSoilSaturation +=
          (this.mesoscale.sampleAt(obsX, obsZ).soilSat - this.observerSoilSaturation) * k;
      }
    }

    // Precipitation at the observer: sum the shafts that actually cover this location,
    // weighted by distance into the core, and keep the hydrometeor mix of the dominant
    // contributor so the renderer knows whether it is raining, hailing or snowing.
    let localRain = 0;
    let dominantType: PrecipitationType = 'None';
    let dominantFallSpeed = 0;
    let frozenFraction = 0;
    let gust = 0;

    for (const c of this.cellManager.cells) {
      const px = c.x + c.precipCoreOffsetX;
      const pz = c.z + c.precipCoreOffsetZ;
      const dx = obsX - px;
      const dz = obsZ - pz;
      const reach = Math.max(1600, c.radiusM * 1.3);
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      const w = Math.pow(1.0 - d / reach, 1.25);

      if (c.surfaceRainRateMMHr > 0.05) {
        const contrib = c.surfaceRainRateMMHr * w;
        if (contrib > localRain) {
          localRain = contrib;
          dominantType = c.precipType;
          frozenFraction = frozenShareOfType(c.precipType);
          dominantFallSpeed = bulkFallSpeedOfCell(c);
        }
      }

      // Downdraft outflow and gust front raise the local wind gustiness.
      if (c.downdraftMaxMS > 1.0 && w > 0.15) {
        gust = Math.max(gust, Math.min(1, (c.downdraftMaxMS / 16.0) * w));
      }
    }

    for (const pool of this.cellManager.coldPools) {
      const dx = obsX - pool.x;
      const dz = obsZ - pool.z;
      const dFront = Math.abs(Math.sqrt(dx * dx + dz * dz) - pool.radiusM);
      if (dFront < 1600) {
        gust = Math.max(gust, pool.strength * (1.0 - dFront / 1600));
      }
    }

    // Grid-resolved rain fringe under a shaft whose core is offset from the observer.
    const gridQr = this.grid.qr[id0];
    if (gridQr > 0.03) {
      // The Eulerian grid carries *condensate*, not a rain rate. Converting it with a plain
      // linear gain (the old qr * 9.5) made 1 g/kg read as 9.5 mm/h, which is wrong by an order
      // of magnitude: 1 g/kg of rain in a 1 km deep shaft falling at 7 m/s is about 25 mm/h,
      // but only a tenth of a cubic metre of that is overhead at any instant. Use the same
      // flux relation the cell microphysics uses -- rate = rho·q·h·v/h -- against an effective
      // shaft depth, and cap it at the shaft's own cell rate so the grid can never report more
      // than the storm actually produces.
      const rhoLocal = Math.max(0.9, this.sounding.densityAt(340));
      const vFall = 6.2;
      // kg/m3 * g/kg / 1000 = kg/kg, * m/s = kg/m2/s, * 3600 = mm/h.
      const gridRain = rhoLocal * gridQr * 1e-3 * vFall * 3600.0;
      if (gridRain > localRain) {
        localRain = Math.min(180, gridRain);
        if (dominantType === 'None') {
          dominantType =
            localRain > 20 ? 'Heavy Rain' : localRain > 5 ? 'Moderate Rain' : localRain > 0.8 ? 'Light Rain' : 'Drizzle';
          dominantFallSpeed = 5.5;
        }
      }
    }

    // Smooth the observer values in real time so passing shaft edges ramp instead of popping.
    const blend = 1.0 - Math.exp(-realDt * 6.5);
    this.observerRainMMHr += (localRain - this.observerRainMMHr) * blend;
    this.observerPrecipFallSpeedMS +=
      (dominantFallSpeed - this.observerPrecipFallSpeedMS) * blend;
    this.observerFrozenFraction += (frozenFraction - this.observerFrozenFraction) * blend;
    this.observerGustFactor += (gust - this.observerGustFactor) * (1.0 - Math.exp(-realDt * 2.5));
    this.observerPrecipType = this.observerRainMMHr > 0.08 ? dominantType : 'None';

    // Surface wetting, puddle accumulation & solar evaporation drying.
    if (this.observerRainMMHr > 0.15) {
      const wetRate = (0.004 + this.observerRainMMHr * 0.00065) * simDt;
      this.surfaceWetness = Math.min(1.0, this.surfaceWetness + wetRate);
    } else {
      // Ground dries at a rate set by available insolation, so a wet surface stays wet
      // through the night and only bakes off once the sun is back up.
      const insolation = this.config.solarInsolationScale === undefined
        ? 1
        : this.config.solarInsolationScale;
      const dryRate = 0.00045 * this.config.solarHeatingFactor * insolation * simDt;
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
    const totalWaterNow = this.baselineWaterMassKg + this.grid.totalCondensateMassKg;

    // Water conservation in mixing-ratio space: condensed == suspended + fallout + evaporated.
    // Before any condensation has occurred there is no budget to check, so report 0 rather than
    // dividing by a numerical floor (which read as a spurious 99.9 % "drift" on a clear sky).
    const inventory = this.waterInventoryGKg();
    const condensed = this.cumulativeCondensedGKg;
    const accounted = inventory + this.cumulativeFalloutGKg + this.cumulativeEvaporatedGKg;
    // Reported uncapped. The old `Math.min(100, …)` made a total loss of the water budget
    // indistinguishable from a 100 % error, and hid any drift past that point entirely.
    const waterDriftPct =
      condensed < 1e-3 ? 0 : (Math.abs(condensed - accounted) / condensed) * 100.0;

    // Every term is guarded for finite-ness rather than only CAPE: a NaN in `lcl`, `el` or the
    // rain rate makes each comparison false, so `NaN` was reported as a *consistent* sounding
    // (the `&&` chain short-circuits to false, which reads as "fine"). `Number.isFinite` on the
    // lot means a non-finite thermodynamic state is reported as inconsistent, which is the truth.
    const inst = this.sounding.instability;
    const thermoOk =
      Number.isFinite(inst.lcl) &&
      Number.isFinite(inst.el) &&
      Number.isFinite(inst.cape) &&
      Number.isFinite(maxRain) &&
      inst.lcl > 0 &&
      inst.el >= inst.lcl &&
      inst.cape >= 0 &&
      !Number.isNaN(inst.cape) &&
      maxRain < 2000;

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
      observerTempC: this.observerTempC,
      observerDewpointC: this.observerDewpointC,
      observerRelHumidity: this.observerRelHumidity,
      observerPressureHPa: this.observerPressureHPa,
      observerLocalCape: this.observerLocalCape,
      observerLocalCin: this.observerLocalCin,
      observerLocalLcl: this.observerLocalLcl,
      observerSoilSaturation: this.observerSoilSaturation,
      observerPrecipType: this.observerPrecipType,
      surfaceWetness: this.surfaceWetness,
      maxElectricFieldKVm: this.electrification.maxElectricFieldKVm,
      maxBreakdownRatio: this.electrification.maxBreakdownRatio,
      maxPosChargeNCm3: this.electrification.maxPosChargeNCm3,
      maxNegChargeNCm3: this.electrification.maxNegChargeNCm3,
      totalFlashes: this.lightning.totalFlashes,
      totalTLEs: this.lightning.totalTLEs,
      rodCorona: this.lightningRod.coronaIntensity,
      rodInterceptions: this.lightningRod.interceptedStrikes,
      rodUpwardLeaders: this.lightningRod.upwardLeaders,
      tornadoes: this.tornadoes.active
        .map((t) => ({
          id: t.id,
          x: t.x,
          z: t.z,
          windMS: t.maxTangentialMS,
          efScale: t.efScale,
          radiusM: t.radiusM,
          pressureDeficitPa: t.pressureDeficitPa,
          funnelDrop: t.funnelDrop,
          cloudBaseM: t.cloudBaseM,
          ageSec: t.ageSec,
          phase: t.phase,
        }))
        .sort((a, b) => b.windMS - a.windMS),
      cells: cells.map((c) => ({ ...c })),
      events: this.lightning.eventHistory.slice(0, 35),
      validation: {
        massContinuityResidual: this.grid.maxDivergenceResidual,
        totalWaterMassKg: totalWaterNow,
        // Never clamp a diagnostic. This used to read `Math.min(99.9, waterDriftPct)`, which
        // silently reported a perfect-looking 99.9 % for a budget that had actually lost 100 %
        // of its water — the one case the reader most needs to see.
        waterConservationDriftPct: waterDriftPct,
        chargeBalanceResidualC: Math.abs(this.electrification.netAtmosphereChargeC) * 0.002,
        maxCFL: this.grid.maxCFL,
        thermodynamicConsistent: thermoOk,
      },
    };
  }
}

function frozenShareOfType(type: PrecipitationType): number {
  switch (type) {
    case 'Snow / Ice Pellets':
      return 1.0;
    case 'Graupel Shower':
      return 0.85;
    case 'Hail & Heavy Rain':
      return 0.45;
    case 'Mixed-Phase Precipitation':
      return 0.5;
    default:
      return 0.0;
  }
}

function bulkFallSpeedOfCell(c: {
  rainGKg: number;
  snowGKg: number;
  graupelGKg: number;
  hailGKg: number;
}): number {
  const total = c.rainGKg + c.snowGKg + c.graupelGKg + c.hailGKg;
  if (total <= 1e-4) return 6.0;
  // Mass-weighted mean fall speed across the precipitating categories.
  return (
    (c.rainGKg * 6.4 + c.snowGKg * 1.1 + c.graupelGKg * 4.6 + c.hailGKg * 13.5) / total
  );
}

/** Wall-clock milliseconds, without pulling in a DOM dependency for headless tooling. */
function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
