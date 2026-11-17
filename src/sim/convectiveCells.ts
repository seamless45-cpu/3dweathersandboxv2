import { stepCellMicrophysics } from './microphysics';
import { getSurfaceThermalPotential, getTerrainHeight } from './terrainField';
import { AtmosphericSounding } from './thermodynamics';
import {
  AtmosphereConfig,
  CellLifecycleStage,
  ColdPool,
  ConvectiveCell,
  DOMAIN_HALF_SIZE,
  PHYS,
  StormOrganizationMode,
} from './types';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class ConvectiveCellManager {
  public cells: ConvectiveCell[] = [];
  public coldPools: ColdPool[] = [];
  public organization: StormOrganizationMode = 'Clear Sky';

  private nextCellNum = 1;
  private nextPoolNum = 1;
  private boundaryLayerThermalEnergy = 0;
  /** Fraction (0..0.86) of the initial CIN mixed away by surface heating and gust fronts. */
  private capErosionFrac = 0;
  /** Transient mixing from active cold-pool fronts, fed by stepColdPools. */
  private gustFrontMixing = 0;
  /**
   * Cumulative water budgets of cells that have already retired. Kept separately so the
   * domain water balance stays closed even after the cell objects are gone.
   */
  public retiredCondensedGKg = 0;
  public retiredFalloutGKg = 0;
  public retiredEvaporatedGKg = 0; // Builds naturally from 0 at t=0 via solar heating
  private nucleationCheckTimer = 0;
  private rngState = 13374209;

  /** Deterministic PRNG for reproducible physical perturbations */
  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState >>> 0) / 4294967295.0;
  }

  public reset(): void {
    this.cells = [];
    this.coldPools = [];
    this.organization = 'Clear Sky';
    this.nextCellNum = 1;
    this.nextPoolNum = 1;
    this.boundaryLayerThermalEnergy = 0;
    this.capErosionFrac = 0;
    this.gustFrontMixing = 0;
    this.retiredCondensedGKg = 0;
    this.retiredFalloutGKg = 0;
    this.retiredEvaporatedGKg = 0;
    this.nucleationCheckTimer = 0;
    this.rngState = 13374209;
  }

  public step(
    dt: number,
    simTimeSec: number,
    sounding: AtmosphericSounding,
    cfg: AtmosphereConfig
  ): void {
    const inst = sounding.instability;

    // 1. Progressive boundary-layer solar warming from t=0 clear sky
    const insolationRate = cfg.solarHeatingFactor * 0.018;
    this.boundaryLayerThermalEnergy = Math.min(
      1.6,
      this.boundaryLayerThermalEnergy + insolationRate * dt
    );

    // 2. Step Cold Pools (evaporatively cooled density currents expanding along surface)
    this.stepColdPools(dt, sounding);

    // 2b. Cap erosion. Insolation and boundary-layer mixing warm/moisten the layer below the
    // inversion, so the effective CIN decays through the run instead of staying pinned at its
    // t=0 value. Without this a modest cap suppresses convection forever, which is why cells
    // never left the nucleating stage.
    const erosionRate =
      (0.028 + 0.052 * cfg.solarHeatingFactor) *
      (0.35 + Math.min(1.4, this.boundaryLayerThermalEnergy)) +
      this.gustFrontMixing * 0.9;
    this.capErosionFrac = Math.min(0.93, this.capErosionFrac + erosionRate * dt * 0.016);
    this.gustFrontMixing = Math.max(0, this.gustFrontMixing - dt * 0.006);

    // 3. Evaluate natural convective parcel nucleation (solar thermals + gust front convergence)
    this.nucleationCheckTimer += dt;
    if (this.nucleationCheckTimer >= 3.5) {
      this.evaluateNaturalNucleation(this.nucleationCheckTimer, simTimeSec, sounding, cfg);
      this.nucleationCheckTimer = 0;
    }

    // 4. Step each individual Convective Cell's dynamics, vertical growth, shear, microphysics
    const newSplitCells: ConvectiveCell[] = [];
    // Fraction of the capping inversion mixed away so far (0 = pristine cap, 1 = fully eroded).
    const capErosionProgress = this.capErosionFrac;

    for (let i = this.cells.length - 1; i >= 0; i--) {
      const cell = this.cells[i];
      cell.ageSec += dt;

      // Sample steering flow across cloud depth + Bunkers propagation if rotating/mature
      const steerZ = Math.min(6500, 0.55 * cell.cloudBaseM + 0.45 * Math.max(cell.cloudBaseM + 500, cell.cloudTopM));
      const upperZ = Math.min(12500, Math.max(8500, inst.el * 0.9));
      const steerU = sounding.windUAt(steerZ);
      const steerW = sounding.windWAt(steerZ);
      const upperU = sounding.windUAt(upperZ);
      const upperW = sounding.windWAt(upperZ);
      const lowU = sounding.windUAt(500);
      const lowW = sounding.windWAt(500);

      // Upper-level storm-relative anvil shear vector
      const dAnvX = upperU - steerU;
      const dAnvZ = upperW - steerW;
      const dAnvMag = Math.hypot(dAnvX, dAnvZ);
      if (dAnvMag > 0.5) {
        cell.anvilAxisX = dAnvX / dAnvMag;
        cell.anvilAxisZ = dAnvZ / dAnvMag;
      }

      // Compute gust-front convergence support vs cold-pool undercutting
      let gustFrontLiftBoost = 0;
      let coldPoolBuoyancyPenalty = 0;
      const shearProtection = Math.min(0.88, inst.bulkShear06km / 24.0);
      for (const pool of this.coldPools) {
        const d = Math.hypot(cell.x - pool.x, cell.z - pool.z);
        const distFromFront = Math.abs(d - pool.radiusM);
        if (distFromFront < 1400 && pool.sourceCellId !== cell.id) {
          const frontWeight = pool.strength * (1.0 - distFromFront / 1400);
          gustFrontLiftBoost += frontWeight * 2.2;
          this.gustFrontMixing = Math.min(0.9, this.gustFrontMixing + frontWeight * dt * 0.05);
        } else if (d < pool.radiusM * 0.65 && pool.tempDeficitK > 1.6) {
          // Cold, dense air beneath the updraft chokes the low-level inflow unless vertical
          // shear keeps the inflow ahead of the gust front.
          const envTempK = Math.max(240, sounding.tempKAt(Math.max(60, pool.depthM * 0.5)));
          coldPoolBuoyancyPenalty +=
            ((PHYS.G * pool.tempDeficitK * 0.55) / envTempK) * (1.0 - shearProtection);
        }
      }
      coldPoolBuoyancyPenalty = Math.min(coldPoolBuoyancyPenalty, 0.22);

      // Microphysics update (condensation ceiling, ice, riming, hail, rain, latent heat, drag).
      // Also sets cell.entrainmentRate (km^-1) from the updraft radius.
      const mpOut = stepCellMicrophysics(cell, dt, sounding, cfg);

      const cloudDepth = Math.max(300, cell.cloudTopM - cell.cloudBaseM);
      const dilutionFactor = Math.exp(-cell.entrainmentRate * (cloudDepth / 1000.0));
      const updraftRadiusEff = Math.min(4200, Math.max(320, cell.radiusM));

      // ---- Vertical momentum balance -------------------------------------------------
      // The parcel buoyancy profile B(z) comes straight from the sounding ascent that CAPE
      // and CIN are integrated from, so the updraft feels the real vertical structure:
      // negative under the cap, strongly positive between LFC and EL, negative aloft. That
      // replaces four hand-tuned regime constants with one measured profile.
      //
      //     dw/dt = B(z) * eta_ent * f_shape  -  loading  -  w|w| / R_eff
      //
      // whose steady state for B > 0 is the classical plume result w = sqrt(B * R).
      const zEval = Math.max(60, 0.5 * (cell.cloudBaseM + cell.cloudTopM));

      // Depth-mean parcel buoyancy over the layer the plume is *currently* working through.
      // The integral window trails the cloud top by one convective depth: an updraft's speed
      // reflects the buoyancy it has accumulated over roughly the layer it occupies, not the
      // whole column from the ground (which would permanently charge an established storm for
      // the sub-cloud CIN it already paid to escape) and not the single midpoint level either
      // (which badly underestimates growth just above the LFC, where B(z) rises steeply).
      const windowDepth = Math.max(900, Math.min(cloudDepth, 6500));
      const integBase = Math.max(60, cell.cloudTopM - windowDepth);
      const envB =
        sounding.parcelBuoyancyIntegral(integBase, cell.cloudTopM) / (cell.cloudTopM - integBase);

      // A shallow cloud still inside the capped layer pays for the negative area above it:
      // integrate from the LCL when the top has not yet reached the LFC.
      const cappedEnvB =
        cell.cloudTopM < inst.lfc
          ? sounding.parcelBuoyancyIntegral(Math.min(cell.cloudBaseM, inst.lcl), inst.lfc) /
            Math.max(300, inst.lfc - Math.min(cell.cloudBaseM, inst.lcl))
          : envB;

      // Entrainment dilution: a plume mixes environmental air in proportion to the depth it
      // has travelled, scaled by how narrow it is (eta -> 1 for a wide, undiluted core).
      const entrainmentEfficiency = clamp(Math.pow(dilutionFactor, 0.45), 0.14, 1.0);

      // Perturbation-pressure drag. Narrow thermals lose most of their buoyancy to the
      // dynamic pressure gradient; a deep, wide tower keeps nearly all of it.
      const depthFrac = clamp(cloudDepth / Math.max(2000, inst.el - inst.lcl), 0.05, 1.0);
      const shapeFactor = clamp(0.40 + 0.62 * depthFrac, 0.34, 1.0);

      // A thermal warmer than the CAPE parcel (solar heating, gust-front forcing) starts with
      // extra buoyancy in the sub-cloud and capped layers, which is what lets convection
      // initiate at all when the mixed-layer parcel is still slightly stable.
      // A thermal warmer than the CAPE parcel (solar heating, gust-front convergence) carries
      // extra buoyancy of its own. This is the perturbation that lets convection initiate when
      // the mixed-layer parcel profile is still marginally stable.
      const thermalExcessK =
        (0.85 + 1.15 * cfg.solarHeatingFactor * Math.min(1.35, this.boundaryLayerThermalEnergy)) *
        (1.0 + 0.5 * gustFrontLiftBoost);
      const excessBuoyancy =
        (PHYS.G * thermalExcessK) / Math.max(240, sounding.tempKAt(zEval));

      // Cap erosion: surface heating and gust-front mixing gradually remove the inversion, so
      // the negative buoyancy between LCL and LFC weakens through the run. Applied only to the
      // negative part of B(z) — CAPE above the LFC is untouched.
      // Surface heating and gust-front mixing erode the inversion, so only the *negative*
      // part of the profile weakens with time; CAPE above the LFC is untouched.
      const cappedB = cappedEnvB < 0 ? cappedEnvB * (1.0 - capErosionProgress) : cappedEnvB;

      const shearSeparation = Math.min(1.0, inst.bulkShear06km / 18.0);
      const loadingDrag =
        mpOut.precipLoadingDragMS2 * (1.0 - 0.72 * shearSeparation);

      // The thermal excess is a near-surface perturbation: it decays with height as the plume
      // entrains, so it matters below the LFC and fades through the deep convective layer.
      const excessDecay = clamp(1.0 - cloudDepth / Math.max(1200, inst.el - inst.lcl), 0.0, 1.0);

      let buoyancyMS2 =
        cappedB * entrainmentEfficiency * shapeFactor +
        excessBuoyancy * shapeFactor * excessDecay * excessDecay -
        loadingDrag -
        coldPoolBuoyancyPenalty;

      // Above the equilibrium level the profile already turns negative, but an overshooting
      // dome also feels the extra static stability of the lower stratosphere.
      if (cell.cloudTopM > inst.el) {
        buoyancyMS2 -= 0.00035 * (cell.cloudTopM - inst.el);
      }

      // Mesocyclone rotational dynamics when vertical shear & SRH tilt horizontal vorticity
      // into the updraft.
      if (cell.cloudTopM > inst.lfc + 1200 && cell.updraftMaxMS > 6.0 && inst.bulkShear06km > 12.0) {
        const tiltingSource =
          (inst.bulkShear06km / 6000.0) *
          (cell.updraftMaxMS / Math.max(1200, cell.radiusM)) *
          (1.0 + inst.srh03km / 220.0) *
          (cell.rightMoverBias >= 0 ? 1.0 : -0.65);
        cell.mesocycloneVorticity += (tiltingSource * 0.45 - cell.mesocycloneVorticity * 0.018) * dt;
      } else {
        cell.mesocycloneVorticity *= Math.max(0, 1.0 - 0.03 * dt);
      }
      cell.rotationPhase += cell.mesocycloneVorticity * dt * 8.0;

      // Non-hydrostatic perturbation pressure deficit in a rotating updraft adds buoyancy.
      const dynamicPressureBoost =
        Math.abs(cell.mesocycloneVorticity) > 0.006
          ? Math.min(0.085, Math.abs(cell.mesocycloneVorticity) * 3.4)
          : 0;

      // Mature-storm ageing: non-rotating cells are eventually choked by their own cold pool.
      const lifecycleExhaustion =
        cell.ageSec > 1500 && Math.abs(cell.mesocycloneVorticity) < 0.01
          ? 0.000075 * (cell.ageSec - 1500)
          : 0;

      cell.buoyancyAccel =
        buoyancyMS2 + dynamicPressureBoost - lifecycleExhaustion;

      // Integrate rather than relax to the equilibrium speed: a thermal that arrives at the
      // capping inversion with kinetic energy keeps rising while it decelerates, which is how
      // real convection punches through a modest cap.
      const w = cell.updraftMaxMS;
      const dragMS2 = (w * Math.abs(w)) / updraftRadiusEff;
      let dw = (cell.buoyancyAccel - dragMS2) * dt;
      // The explicit drag term must never reverse the velocity inside one step.
      if (dragMS2 > 0 && dw < -0.6 * w) dw = -0.6 * w;
      cell.updraftMaxMS = clamp(w + dw, -3.0, 58.0);

      // ---- Downdraft: sub-cloud evaporative/melt cooling plus precipitation loading ----
      const subCloudDepth = Math.max(350, cell.cloudBaseM);
      const subCloudTempK = Math.max(240, sounding.tempKAt(subCloudDepth * 0.5));
      const fallResidenceTime = subCloudDepth / Math.max(1.2, mpOut.bulkFallSpeedMS);
      // Only part of the sub-cloud cooling ends up in the downdraft air (mixing, spreading).
      const downdraftTempDeficitK = mpOut.subCloudCoolingKPerS * fallResidenceTime * 0.62;
      const downdraftBuoyancy =
        (PHYS.G * Math.min(11, downdraftTempDeficitK)) / subCloudTempK +
        mpOut.precipLoadingDragMS2 * 0.85;
      const targetDowndraft = clamp(
        0.62 * Math.sqrt(2.0 * Math.max(0, downdraftBuoyancy) * subCloudDepth),
        0,
        24
      );
      cell.downdraftMaxMS +=
        (targetDowndraft - cell.downdraftMaxMS) * (1.0 - Math.exp(-dt / 150.0));
      cell.downdraftMaxMS = clamp(cell.downdraftMaxMS, 0, 24);

      // ---- Cloud geometry: base, top, radius, overshoot, anvil ----
      // The visible cloud base sits at the LCL once the tower is established; a shallow
      // thermal still has its condensate deck forming, so the base relaxes in only after the
      // top has cleared the LCL. This keeps the sub-LCL dry-thermal branch meaningful.
      const targetBaseM = cell.cloudTopM > inst.lcl + 250 ? inst.lcl : Math.min(inst.lcl, cell.cloudTopM);
      cell.cloudBaseM += (targetBaseM - cell.cloudBaseM) * (1.0 - Math.exp(-dt / 70.0));
      if (cell.cloudTopM < cell.cloudBaseM) cell.cloudBaseM = cell.cloudTopM;

      if (cell.updraftMaxMS > 0.25) {
        // The cloud top rises at the updraft speed *at the top of the cloud*, not at w_max.
        // In a shallow cumulus the peak updraft sits right below the cap, so the top climbs at
        // ~0.88 w; in a deep mature tower w_max is mid-cloud and the top spreads into an anvil,
        // so it climbs at ~0.44 w. Blending on depth reproduces both growth regimes.
        const capRiseFactor = clamp(0.88 - 0.44 * (cloudDepth / 9000.0), 0.4, 0.88);
        const capRise = cell.updraftMaxMS * capRiseFactor;
        const maxPhysicalTop =
          inst.cape > 80
            ? inst.el + Math.min(2400, cell.updraftMaxMS * 42.0)
            : inst.lcl + 900 + cell.updraftMaxMS * 180.0;
        if (cell.cloudTopM < maxPhysicalTop) {
          cell.cloudTopM += capRise * dt;
        } else {
          cell.cloudTopM += (maxPhysicalTop - cell.cloudTopM) * (1.0 - Math.exp(-dt / 26.0));
        }
      } else {
        // Subsidence & cloud top collapse during dissipation
        cell.cloudTopM = Math.max(
          cell.cloudBaseM,
          cell.cloudTopM - (1.6 + Math.max(0, -cell.updraftMaxMS) * 0.9) * dt
        );
      }

      cell.overshootingTopM =
        inst.cape > 400 && cell.cloudTopM > inst.el
          ? Math.max(0, cell.cloudTopM - inst.el)
          : 0;

      // Convective tower radius. Observed updraft cores scale with cloud depth, not with the
      // product of speed and depth: a 2 km shallow cumulus core is ~0.5 km across while a
      // 12 km tower is 3-5 km across. Getting this right matters twice over, because the
      // radius also sets the lateral entrainment rate (eps ~ 0.2/R) that dilutes condensate
      // and the aerodynamic drag that limits the updraft.
      const continuityRadius =
        340 + Math.sqrt(Math.max(0, cell.updraftMaxMS) * Math.max(300, cloudDepth)) * 15.0;
      const depthRadius = cloudDepth * (0.19 + 0.011 * Math.sqrt(Math.max(0, cell.updraftMaxMS)));
      const targetRadius =
        cell.stage === 'dissipating'
          ? cell.radiusM * (1.0 - 0.0016 * dt)
          : clamp(
              Math.max(continuityRadius, depthRadius) *
                (1.0 + Math.min(0.35, Math.abs(cell.mesocycloneVorticity) * 9.0)),
              480,
              4600
            );
      cell.radiusM += (targetRadius - cell.radiusM) * (1.0 - Math.exp(-dt / 240.0));

      // Upper tropospheric anvil divergence near the Equilibrium Level (Cb capillatus).
      if (cell.cloudTopM > inst.el * 0.82 && (cell.cloudIceGKg + cell.snowGKg) > 0.1) {
        const anvilOutflowSpeed = Math.max(3.5, cell.updraftMaxMS * 0.5 + dAnvMag * 0.45);
        cell.anvilRadiusM = Math.min(13500, cell.anvilRadiusM + anvilOutflowSpeed * dt);
      } else if (cell.stage === 'dissipating') {
        cell.anvilRadiusM = Math.max(0, cell.anvilRadiusM - 1.4 * dt);
      } else {
        cell.anvilRadiusM = Math.max(0, cell.anvilRadiusM - 0.15 * dt);
      }

      // Precipitation core & rear-flank downdraft offsets from the updraft center.
      // Falling hydrometeors drift downshear with the low-level flow while they fall.
      const ffdShiftX = (steerU - lowU) * 78.0;
      const ffdShiftZ = (steerW - lowW) * 78.0;
      cell.precipCoreOffsetX += (ffdShiftX - cell.precipCoreOffsetX) * (1.0 - Math.exp(-dt / 45.0));
      cell.precipCoreOffsetZ += (ffdShiftZ - cell.precipCoreOffsetZ) * (1.0 - Math.exp(-dt / 45.0));

      if (Math.abs(cell.mesocycloneVorticity) > 0.008) {
        // Hook-echo / RFD wraps cyclonically around the rear flank of the mesocyclone.
        const wrapAngle = Math.atan2(ffdShiftZ, ffdShiftX) + 2.35;
        cell.rfdOffsetX = Math.cos(wrapAngle) * cell.radiusM * 0.72;
        cell.rfdOffsetZ = Math.sin(wrapAngle) * cell.radiusM * 0.72;
      } else {
        cell.rfdOffsetX = -cell.precipCoreOffsetX * 0.25;
        cell.rfdOffsetZ = -cell.precipCoreOffsetZ * 0.25;
      }

      // Storm translation: steering flow + Bunkers deviation for rotating cells.
      const supercellFrac = Math.min(1.0, Math.abs(cell.mesocycloneVorticity) / 0.014);
      const targetVx =
        cell.rightMoverBias >= 0
          ? steerU * (1.0 - supercellFrac) + inst.bunkersStormU * supercellFrac
          : steerU * 1.05 - (inst.bunkersStormU - steerU) * 0.85;
      const targetVz =
        cell.rightMoverBias >= 0
          ? steerW * (1.0 - supercellFrac) + inst.bunkersStormW * supercellFrac
          : steerW * 1.05 - (inst.bunkersStormW - steerW) * 0.85;

      const steerTau = 1.0 - Math.exp(-dt / 55.0);
      cell.vx += (targetVx - cell.vx) * steerTau;
      cell.vz += (targetVz - cell.vz) * steerTau;
      cell.x += cell.vx * dt;
      cell.z += cell.vz * dt;

      // Spawn or reinforce the surface cold pool when the evaporative downdraft reaches ground.
      if (
        cell.downdraftMaxMS > 2.6 &&
        (cell.surfaceRainRateMMHr > 1.2 || cell.virgaFraction > 0.55)
      ) {
        this.feedOrCreateColdPool(cell, downdraftTempDeficitK, dt);
      }

      // Supercell splitting when strong curved shear stretches a vigorous updraft.
      if (
        !cell.splitCandidateDone &&
        inst.bulkShear06km > 21.0 &&
        inst.cape > 1400 &&
        cell.updraftMaxMS > 20.0 &&
        cell.ageSec > 260 &&
        this.cells.length < 14
      ) {
        cell.splitCandidateDone = true;
        cell.rightMoverBias = 1;
        newSplitCells.push(this.createSplitLeftMover(cell));
      }

      cell.stage = this.classifyCellStage(cell, inst.lcl, inst.freezingLevel, inst.el);

      // Remove completely dissipated cells or cells advected far outside the domain.
      const totalHydrometeors =
        cell.cloudWaterGKg +
        cell.supercooledWaterGKg +
        cell.cloudIceGKg +
        cell.snowGKg +
        cell.graupelGKg +
        cell.hailGKg +
        cell.rainGKg;

      const outOfBounds =
        Math.abs(cell.x) > DOMAIN_HALF_SIZE + 5500 ||
        Math.abs(cell.z) > DOMAIN_HALF_SIZE + 5500;

      if (
        outOfBounds ||
        (cell.ageSec > 90 &&
          cell.updraftMaxMS < 0.25 &&
          totalHydrometeors < 0.035 &&
          cell.anvilRadiusM < 400)
      ) {
        // A retiring cell must not simply delete its water: whatever condensate is still
        // suspended either falls out or evaporates back to vapour, and its cumulative budget
        // history has to survive so the domain water balance stays closed across the whole
        // run. Without this the drift grew every time a cell dissipated.
        this.retiredCondensedGKg += cell.cumCondensedGKg;
        this.retiredFalloutGKg += cell.cumFalloutGKg + totalHydrometeors * (outOfBounds ? 0.5 : 0.0);
        this.retiredEvaporatedGKg +=
          cell.cumEvaporatedGKg + totalHydrometeors * (outOfBounds ? 0.5 : 1.0);
        this.cells.splice(i, 1);
      }
    }

    for (const sc of newSplitCells) {
      this.cells.push(sc);
    }

    // 5. Handle Cell Merging when neighboring updraft cores interact closely
    this.handleCellMerging();

    // 6. Classify Emergent Domain-Scale Storm Organization
    this.organization = this.classifyDomainOrganization(sounding);
  }

  private evaluateNaturalNucleation(
    checkDt: number,
    _simTimeSec: number,
    sounding: AtmosphericSounding,
    cfg: AtmosphereConfig
  ): void {
    if (this.cells.length >= 8) return;

    const inst = sounding.instability;
    const rh0 = cfg.surfaceRelHumidity;

    // Require initial boundary-layer solar warmup from t=0 clear sky so clouds condense progressively!
    if (this.boundaryLayerThermalEnergy < 0.14 && this.coldPools.length === 0) {
      return;
    }

    // Candidate 1: Gust front & cold pool collision triggering (multicell / squall regeneration).
    for (let i = 0; i < this.coldPools.length; i++) {
      const p1 = this.coldPools[i];
      if (p1.strength < 0.22 || p1.radiusM < 1200) continue;

      // Sample the downshear edge of the cold pool where warm low-level inflow converges
      // head-on with the gust front.
      const inflowU = -sounding.windUAt(400);
      const inflowW = -sounding.windWAt(400);
      const inflowAngle = Math.atan2(inflowW, inflowU) + (this.rand() - 0.5) * 0.9;
      const candX = p1.x + Math.cos(inflowAngle) * p1.radiusM;
      const candZ = p1.z + Math.sin(inflowAngle) * p1.radiusM;

      if (Math.abs(candX) > DOMAIN_HALF_SIZE - 2200 || Math.abs(candZ) > DOMAIN_HALF_SIZE - 2200) {
        continue;
      }

      // Collision with a second gust front greatly enhances the forced lift.
      let collisionBoost = 0;
      for (let j = 0; j < this.coldPools.length; j++) {
        if (i === j) continue;
        const p2 = this.coldPools[j];
        const dFront2 = Math.abs(Math.hypot(candX - p2.x, candZ - p2.z) - p2.radiusM);
        if (dFront2 < 1500) {
          collisionBoost += p2.strength * 1.6;
        }
      }

      // Mechanical gust-front lifting w ~ 0.6 c overcomes far more CIN than solar thermals alone.
      const gustKineticEnergy = 0.5 * Math.pow(p1.expansionSpeedMS * (1.0 + collisionBoost * 0.5), 2);
      if (
        gustKineticEnergy + 28.0 * cfg.solarHeatingFactor > inst.cin * 0.75 &&
        rh0 > 38 &&
        !this.isNearExistingUpdraft(candX, candZ, 3400)
      ) {
        const triggerProb = Math.min(0.65, (0.08 + 0.16 * collisionBoost) * checkDt);
        if (this.rand() < triggerProb) {
          this.spawnNucleatingThermal(
            candX,
            candZ,
            sounding,
            950 + collisionBoost * 350,
            2.6 + p1.expansionSpeedMS * 0.3
          );
          if (this.cells.length >= 14) return;
        }
      }
    }

    // Candidate 2: Solar boundary-layer thermal plumes over sunlit terrain hotspots.
    if (rh0 < 29 || inst.lcl > 4100 || cfg.solarHeatingFactor < 0.15) {
      // Too dry or no surface heating -> clear sky persists naturally!
      return;
    }

    const thermalEnergyJPerKg =
      38.0 * cfg.solarHeatingFactor * this.boundaryLayerThermalEnergy +
      Math.max(0, (rh0 - 50) * 0.9);
    if (thermalEnergyJPerKg < inst.cin * 0.55) {
      return;
    }

    const attempts = 5;
    for (let a = 0; a < attempts; a++) {
      // Favor the field of view in front of the observer while still covering the domain.
      const candX = (this.rand() * 2.0 - 1.0) * (DOMAIN_HALF_SIZE - 3000);
      const candZ = (this.rand() * 1.7 - 1.05) * (DOMAIN_HALF_SIZE * 0.72);

      const terrainElev = getTerrainHeight(candX, candZ);
      const thermalSpot = getSurfaceThermalPotential(candX, candZ);
      const orographicBonus = Math.min(0.45, terrainElev / 340.0);

      if (thermalSpot + orographicBonus > 0.03 && !this.isNearExistingUpdraft(candX, candZ, 3900)) {
        const prob =
          0.11 *
          cfg.solarHeatingFactor *
          Math.min(1.5, this.boundaryLayerThermalEnergy) *
          (rh0 / 62.0) *
          checkDt;
        if (this.rand() < prob) {
          const initialRadius = 700 + this.rand() * 440;
          const initialW = 2.2 + cfg.solarHeatingFactor * 1.5;
          this.spawnNucleatingThermal(candX, candZ, sounding, initialRadius, initialW);
          break;
        }
      }
    }
  }

  private spawnNucleatingThermal(
    x: number,
    z: number,
    sounding: AtmosphericSounding,
    radiusM: number,
    initUpdraftMS: number
  ): void {
    const num = this.nextCellNum++;
    const id = `CELL-${String(num).padStart(2, '0')}`;
    const lowU = sounding.windUAt(700);
    const lowW = sounding.windWAt(700);
    const dx = sounding.windUAt(9500) - lowU;
    const dz = sounding.windWAt(9500) - lowW;
    const dMag = Math.max(0.1, Math.hypot(dx, dz));

    const lcl = sounding.instability.lcl;
    // Start the parcel as a shallow surface thermal: it must climb to the LCL under its own
    // buoyancy, so the dry-adiabatic stage is simulated rather than skipped.
    const startTop = Math.max(280, Math.min(lcl * 0.55, 620));

    this.cells.push({
      id,
      numericId: num,
      x,
      z,
      vx: lowU,
      vz: lowW,
      ageSec: 0,
      stage: 'nucleating',
      radiusM,
      cloudBaseM: startTop * 0.42,
      cloudTopM: startTop,
      anvilRadiusM: 0,
      anvilAxisX: dx / dMag,
      anvilAxisZ: dz / dMag,
      overshootingTopM: 0,
      updraftMaxMS: initUpdraftMS,
      downdraftMaxMS: 0,
      buoyancyAccel: 0.02,
      entrainmentRate: 0.6,
      mesocycloneVorticity: 0,
      rotationPhase: this.rand() * Math.PI * 2,
      splitCandidateDone: false,
      rightMoverBias: 0,
      precipCoreOffsetX: 0,
      precipCoreOffsetZ: 0,
      rfdOffsetX: 0,
      rfdOffsetZ: 0,
      vaporExcessGKg: 1.2,
      cloudWaterGKg: 0,
      supercooledWaterGKg: 0,
      cloudIceGKg: 0,
      snowGKg: 0,
      graupelGKg: 0,
      hailGKg: 0,
      rainGKg: 0,
      surfaceRainRateMMHr: 0,
      precipType: 'None',
      virgaFraction: 0,
      cumCondensedGKg: 0,
      cumFalloutGKg: 0,
      cumEvaporatedGKg: 0,
      upperPosChargeNCm3: 0,
      mainNegChargeNCm3: 0,
      lowerPosChargeNCm3: 0,
      anvilScreenChargeNCm3: 0,
      peakElectricFieldKVm: 0,
      breakdownRatio: 0,
      flashCount: 0,
    });
  }

  private createSplitLeftMover(parent: ConvectiveCell): ConvectiveCell {
    const num = this.nextCellNum++;
    const id = `CELL-${String(num).padStart(2, '0')}`;
    // Conserve water & charge by partitioning 62% to the right-mover and 38% to the left-mover.
    const frac = 0.38;
    const keep = 0.62;

    const perpX = -parent.anvilAxisZ;
    const perpZ = parent.anvilAxisX;

    const leftCell: ConvectiveCell = {
      ...parent,
      id,
      numericId: num,
      x: parent.x + perpX * parent.radiusM * 0.75,
      z: parent.z + perpZ * parent.radiusM * 0.75,
      radiusM: parent.radiusM * 0.82,
      anvilRadiusM: parent.anvilRadiusM * 0.7,
      updraftMaxMS: parent.updraftMaxMS * 0.84,
      mesocycloneVorticity: -Math.abs(parent.mesocycloneVorticity) * 0.75, // Anticyclonic left-mover!
      splitCandidateDone: true,
      rightMoverBias: -1,
      cloudWaterGKg: parent.cloudWaterGKg * frac,
      supercooledWaterGKg: parent.supercooledWaterGKg * frac,
      cloudIceGKg: parent.cloudIceGKg * frac,
      snowGKg: parent.snowGKg * frac,
      graupelGKg: parent.graupelGKg * frac,
      hailGKg: parent.hailGKg * frac,
      rainGKg: parent.rainGKg * frac,
      cumCondensedGKg: parent.cumCondensedGKg * frac,
      cumFalloutGKg: parent.cumFalloutGKg * frac,
      cumEvaporatedGKg: parent.cumEvaporatedGKg * frac,
      upperPosChargeNCm3: parent.upperPosChargeNCm3 * frac,
      mainNegChargeNCm3: parent.mainNegChargeNCm3 * frac,
      lowerPosChargeNCm3: parent.lowerPosChargeNCm3 * frac,
      anvilScreenChargeNCm3: parent.anvilScreenChargeNCm3 * frac,
      flashCount: 0,
    };

    parent.cloudWaterGKg *= keep;
    parent.supercooledWaterGKg *= keep;
    parent.cloudIceGKg *= keep;
    parent.snowGKg *= keep;
    parent.graupelGKg *= keep;
    parent.hailGKg *= keep;
    parent.rainGKg *= keep;
    parent.cumCondensedGKg *= keep;
    parent.cumFalloutGKg *= keep;
    parent.cumEvaporatedGKg *= keep;
    parent.upperPosChargeNCm3 *= keep;
    parent.mainNegChargeNCm3 *= keep;
    parent.lowerPosChargeNCm3 *= keep;
    parent.anvilScreenChargeNCm3 *= keep;

    return leftCell;
  }

  private handleCellMerging(): void {
    for (let i = 0; i < this.cells.length; i++) {
      for (let j = i + 1; j < this.cells.length; j++) {
        const a = this.cells[i];
        const b = this.cells[j];
        // Don't immediately re-merge a freshly split opposite-vorticity pair.
        if (a.rightMoverBias * b.rightMoverBias < 0 && Math.abs(a.ageSec - b.ageSec) < 120) {
          continue;
        }
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        const mergeDist = 0.62 * (a.radiusM + b.radiusM);
        if (dist < mergeDist && a.cloudTopM > a.cloudBaseM + 600 && b.cloudTopM > b.cloudBaseM + 600) {
          // Merge the smaller cell into the stronger one. Mixing ratios are *intensive*, so a
          // plain volume-weighted average silently destroys water whenever the two cells
          // differ in size. Conserve mass by construction instead: total mass in, divided by
          // the volume the merged cell actually occupies.
          const depthA = Math.max(200, a.cloudTopM - a.cloudBaseM);
          const depthB = Math.max(200, b.cloudTopM - b.cloudBaseM);
          const volA = a.radiusM * a.radiusM * depthA;
          const volB = b.radiusM * b.radiusM * depthB;
          const totVol = volA + volB;
          const wA = volA / totVol;
          const wB = volB / totVol;

          // Per-cell inventory *before* anything is overwritten. The budget identity
          // C = I + F + E holds per cell, so the merged cell must satisfy it against the SUM
          // of the two inventories, not against their volume-weighted mean.
          const invA =
            a.cloudWaterGKg + a.supercooledWaterGKg + a.cloudIceGKg + a.snowGKg +
            a.graupelGKg + a.hailGKg + a.rainGKg;
          const invB =
            b.cloudWaterGKg + b.supercooledWaterGKg + b.cloudIceGKg + b.snowGKg +
            b.graupelGKg + b.hailGKg + b.rainGKg;

          const mass = (k: (c: ConvectiveCell) => number) => k(a) * volA + k(b) * volB;
          const mCloudWater = mass((c) => c.cloudWaterGKg);
          const mSlw = mass((c) => c.supercooledWaterGKg);
          const mIce = mass((c) => c.cloudIceGKg);
          const mSnow = mass((c) => c.snowGKg);
          const mGraupel = mass((c) => c.graupelGKg);
          const mHail = mass((c) => c.hailGKg);
          const mRain = mass((c) => c.rainGKg);
          const chargeUpper = mass((c) => c.upperPosChargeNCm3);
          const chargeMain = mass((c) => c.mainNegChargeNCm3);
          const chargeLower = mass((c) => c.lowerPosChargeNCm3);

          a.x = a.x * wA + b.x * wB;
          a.z = a.z * wA + b.z * wB;
          a.vx = a.vx * wA + b.vx * wB;
          a.vz = a.vz * wA + b.vz * wB;
          a.radiusM = Math.min(5200, Math.sqrt(a.radiusM * a.radiusM + b.radiusM * b.radiusM * 0.65));
          a.cloudTopM = Math.max(a.cloudTopM, b.cloudTopM);
          a.anvilRadiusM = Math.max(a.anvilRadiusM, b.anvilRadiusM);
          a.updraftMaxMS = Math.min(56, Math.max(a.updraftMaxMS, b.updraftMaxMS) * 1.06);

          // Volume the merged cell now represents; all concentrations are divided by it so the
          // total water and charge inventories are unchanged by the merge.
          const volMerged = Math.max(1, a.radiusM * a.radiusM * Math.max(200, a.cloudTopM - a.cloudBaseM));
          a.cloudWaterGKg = mCloudWater / volMerged;
          a.supercooledWaterGKg = mSlw / volMerged;
          a.cloudIceGKg = mIce / volMerged;
          a.snowGKg = mSnow / volMerged;
          a.graupelGKg = mGraupel / volMerged;
          a.hailGKg = mHail / volMerged;
          a.rainGKg = mRain / volMerged;
          // Integrated budgets are extensive: they simply add. Any mass the geometry change
          // leaves unaccounted for is returned to vapour so the column balance closes exactly.
          const inventoryAfter =
            a.cloudWaterGKg + a.supercooledWaterGKg + a.cloudIceGKg + a.snowGKg +
            a.graupelGKg + a.hailGKg + a.rainGKg;
          const mergeMassDeltaGKg = Math.max(0, invA + invB - inventoryAfter);
          a.cumCondensedGKg += b.cumCondensedGKg;
          a.cumFalloutGKg += b.cumFalloutGKg;
          a.cumEvaporatedGKg += b.cumEvaporatedGKg + mergeMassDeltaGKg;

          a.upperPosChargeNCm3 = chargeUpper / volMerged;
          a.mainNegChargeNCm3 = chargeMain / volMerged;
          a.lowerPosChargeNCm3 = chargeLower / volMerged;

          this.cells.splice(j, 1);
          j--;
        }
      }
    }
  }

  private feedOrCreateColdPool(
    cell: ConvectiveCell,
    downdraftTempDeficitK: number,
    dt: number
  ): void {
    const poolCenterX = cell.x + cell.precipCoreOffsetX;
    const poolCenterZ = cell.z + cell.precipCoreOffsetZ;

    // Cold pool temperature deficit tracks the evaporative deficit of the downdraft air,
    // strengthened a little by heavy rain loading and limited by surface heating.
    const targetDeficitK = clamp(downdraftTempDeficitK * 1.35 + cell.surfaceRainRateMMHr * 0.012, 0.6, 12.0);

    let existing = this.coldPools.find((p) => p.sourceCellId === cell.id);
    if (!existing) {
      if (this.coldPools.length >= 16) {
        this.coldPools.shift();
      }
      existing = {
        id: this.nextPoolNum++,
        sourceCellId: cell.id,
        x: poolCenterX,
        z: poolCenterZ,
        vx: cell.vx * 0.55,
        vz: cell.vz * 0.55,
        radiusM: Math.max(900, cell.radiusM * 0.65),
        expansionSpeedMS: 4.5,
        depthM: 550,
        tempDeficitK: targetDeficitK * 0.55,
        ageSec: 0,
        strength: 0.5,
      };
      this.coldPools.push(existing);
    } else {
      existing.x += (poolCenterX - existing.x) * Math.min(1.0, 0.02 * dt);
      existing.z += (poolCenterZ - existing.z) * Math.min(1.0, 0.02 * dt);
      existing.tempDeficitK +=
        (targetDeficitK - existing.tempDeficitK) * Math.min(1.0, 0.012 * dt);
      existing.depthM = Math.min(
        1450,
        existing.depthM + (Math.max(0, 260 + cell.downdraftMaxMS * 62.0) - existing.depthM) * Math.min(1, 0.01 * dt)
      );
    }
  }

  private stepColdPools(dt: number, sounding: AtmosphericSounding): void {
    const t0 = sounding.tArr[0];
    for (let i = this.coldPools.length - 1; i >= 0; i--) {
      const p = this.coldPools[i];
      p.ageSec += dt;
      // Benjamin (1968) gravity-current speed: c = F * sqrt(g H |dT| / T0)
      p.expansionSpeedMS =
        0.78 * Math.sqrt((PHYS.G * p.depthM * Math.max(0.2, p.tempDeficitK)) / t0);
      p.radiusM += p.expansionSpeedMS * dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;

      // Surface warming and radial spreading gradually thin the cold pool.
      p.tempDeficitK *= Math.max(0, 1.0 - 0.0016 * dt);
      p.depthM = Math.max(220, p.depthM * (1.0 - 0.0009 * dt));
      p.strength = clamp((p.tempDeficitK / 5.5) * (1.0 - p.radiusM / 15000), 0, 1);

      if (p.tempDeficitK < 0.4 || p.radiusM > 15500) {
        this.coldPools.splice(i, 1);
      }
    }
  }

  private isNearExistingUpdraft(x: number, z: number, minDistM: number): boolean {
    for (const c of this.cells) {
      if (Math.hypot(c.x - x, c.z - z) < minDistM) return true;
    }
    return false;
  }

  private classifyCellStage(
    cell: ConvectiveCell,
    lcl: number,
    freezeZ: number,
    el: number
  ): CellLifecycleStage {
    const depth = cell.cloudTopM - cell.cloudBaseM;
    const suspended = cell.cloudWaterGKg + cell.supercooledWaterGKg + cell.cloudIceGKg;
    if (cell.cloudTopM <= lcl + 80 || suspended < 0.02) {
      return 'nucleating';
    }
    if (
      cell.ageSec > 180 &&
      cell.updraftMaxMS < 2.2 &&
      (cell.downdraftMaxMS > cell.updraftMaxMS * 1.2 || depth < 1400)
    ) {
      return 'dissipating';
    }
    if (Math.abs(cell.mesocycloneVorticity) > 0.011 && cell.cloudTopM > freezeZ + 2200) {
      return 'supercell';
    }
    if (cell.anvilRadiusM > cell.radiusM * 1.35 || cell.cloudTopM > el * 0.86) {
      return 'mature';
    }
    if (cell.cloudTopM > freezeZ + 1400 && (cell.cloudIceGKg + cell.graupelGKg) > 0.12) {
      return 'calvus';
    }
    if (depth > 2200) {
      return 'growing';
    }
    if (depth > 950) {
      return 'developing';
    }
    return 'cumulus_humilis';
  }

  private classifyDomainOrganization(sounding: AtmosphericSounding): StormOrganizationMode {
    if (this.cells.length === 0) {
      return this.boundaryLayerThermalEnergy > 0.22 && sounding.instability.cape > 50
        ? 'Boundary-Layer Thermals'
        : 'Clear Sky';
    }

    let visibleClouds = 0;
    let deepTowers = 0;
    let matureStorms = 0;
    let supercells = 0;
    let dissipatingCount = 0;

    for (const c of this.cells) {
      if (c.stage !== 'nucleating') visibleClouds++;
      if (c.stage === 'growing' || c.stage === 'calvus') deepTowers++;
      if (c.stage === 'mature' || c.stage === 'supercell') matureStorms++;
      if (c.stage === 'supercell') supercells++;
      if (c.stage === 'dissipating') dissipatingCount++;
    }

    if (visibleClouds === 0) return 'Boundary-Layer Thermals';
    if (supercells > 0) return 'Supercell Thunderstorm';

    if (matureStorms >= 3) {
      // Linear alignment (aspect ratio of the cell-centre covariance) separates a squall
      // line from a multicell cluster.
      const meanX = this.cells.reduce((s, c) => s + c.x, 0) / this.cells.length;
      const meanZ = this.cells.reduce((s, c) => s + c.z, 0) / this.cells.length;
      let sxx = 0;
      let szz = 0;
      let sxz = 0;
      for (const c of this.cells) {
        const dx = c.x - meanX;
        const dz = c.z - meanZ;
        sxx += dx * dx;
        szz += dz * dz;
        sxz += dx * dz;
      }
      const trace = sxx + szz;
      const det = sxx * szz - sxz * sxz;
      const disc = Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
      const eig1 = trace * 0.5 + disc;
      const eig2 = Math.max(1.0, trace * 0.5 - disc);
      const linearity = Math.sqrt(eig1 / eig2);

      if (linearity > 2.6 && this.coldPools.length >= 2) {
        return 'Squall Line / Multicell Line';
      }
      return matureStorms >= 5 ? 'Organized Convective System' : 'Multicell Cluster';
    }

    if (matureStorms === 2) {
      return 'Multicell Cluster';
    }

    if (matureStorms === 1) {
      return sounding.instability.bulkShear06km < 9.5
        ? 'Pulse Thunderstorm'
        : 'Isolated Single-Cell';
    }

    if (dissipatingCount > 0 && deepTowers === 0) {
      return 'Storm Weakening / Dissipation';
    }

    if (deepTowers > 0) {
      return 'Growing Convection';
    }

    return 'Fair-Weather Cumulus';
  }
}
