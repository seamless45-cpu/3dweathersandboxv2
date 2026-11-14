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

export class ConvectiveCellManager {
  public cells: ConvectiveCell[] = [];
  public coldPools: ColdPool[] = [];
  public organization: StormOrganizationMode = 'Clear Sky';

  private nextCellNum = 1;
  private nextPoolNum = 1;
  private boundaryLayerThermalEnergy = 0; // Builds naturally from 0 at t=0 via solar heating
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

    // 3. Evaluate natural convective parcel nucleation (solar thermals + gust front convergence)
    this.nucleationCheckTimer += dt;
    if (this.nucleationCheckTimer >= 3.5) {
      this.evaluateNaturalNucleation(this.nucleationCheckTimer, simTimeSec, sounding, cfg);
      this.nucleationCheckTimer = 0;
    }

    // 4. Step each individual Convective Cell's dynamics, vertical growth, shear, microphysics & electrification inputs
    const newSplitCells: ConvectiveCell[] = [];

    for (let i = this.cells.length - 1; i >= 0; i--) {
      const cell = this.cells[i];
      cell.ageSec += dt;

      // Sample steering flow across cloud depth + Bunkers propagation if rotating/mature
      const steerZ = Math.min(6500, 0.55 * cell.cloudBaseM + 0.45 * Math.max(cell.cloudBaseM + 500, cell.cloudTopM));
      const steerWind = sounding.sampleAtAltitude(steerZ);
      const upperWind = sounding.sampleAtAltitude(Math.min(12500, Math.max(8500, inst.el * 0.9)));
      const lowWind = sounding.sampleAtAltitude(500);

      // Upper-level storm-relative anvil shear vector
      const dAnvX = upperWind.windU - steerWind.windU;
      const dAnvZ = upperWind.windW - steerWind.windW;
      const dAnvMag = Math.hypot(dAnvX, dAnvZ);
      if (dAnvMag > 0.5) {
        cell.anvilAxisX = dAnvX / dAnvMag;
        cell.anvilAxisZ = dAnvZ / dAnvMag;
      }

      // Compute gust-front convergence support vs cold-pool undercutting
      let gustFrontLiftBoost = 0;
      let coldPoolUndercutPenalty = 0;
      for (const pool of this.coldPools) {
        const d = Math.hypot(cell.x - pool.x, cell.z - pool.z);
        const distFromFront = Math.abs(d - pool.radiusM);
        if (distFromFront < 1400 && pool.sourceCellId !== cell.id) {
          gustFrontLiftBoost += pool.strength * 2.2 * (1.0 - distFromFront / 1400);
        } else if (d < pool.radiusM * 0.65 && pool.tempDeficitK > 2.2) {
          // Deep cold air beneath updraft stabilizes inflow unless strong wind shear keeps inflow ahead of front
          const shearProtection = Math.min(0.88, inst.bulkShear06km / 24.0);
          coldPoolUndercutPenalty +=
            (pool.tempDeficitK * 0.35) * (1.0 - shearProtection);
        }
      }

      // Microphysics update (condensation, ice, riming, hail, rain, latent heating, drag)
      const mpOut = stepCellMicrophysics(cell, dt, sounding, cfg);

      // Parcel Buoyancy & Vertical Momentum Integration
      // Entrainment scales inversely with updraft radius: narrow thermals dilute fast in dry mid-levels!
      cell.entrainmentRate = 0.24 / Math.max(0.55, cell.radiusM / 1000.0);

      // Effective parcel buoyancy from CAPE, latent heating, CIN below LFC, entrainment dilution, and precip drag
      const aboveLFC = cell.cloudTopM > inst.lfc;
      const capeScale = Math.sqrt(Math.max(0, inst.cape)) / 42.0; // ~0 to 1.4
      let thermalBuoyancy = 0;

      if (cell.cloudTopM < inst.lcl) {
        // Dry boundary-layer thermal rising toward LCL
        thermalBuoyancy =
          0.052 * cfg.solarHeatingFactor * Math.min(1.3, this.boundaryLayerThermalEnergy) -
          0.00022 * inst.cin +
          0.03 * gustFrontLiftBoost;
      } else if (!aboveLFC) {
        // Between LCL and LFC: fighting capping inversion (CIN)!
        const capResistance = 0.00042 * inst.cin + 0.0095 * cfg.cappingInversionStrengthK;
        thermalBuoyancy =
          0.046 * (cfg.solarHeatingFactor * Math.min(1.25, this.boundaryLayerThermalEnergy) + gustFrontLiftBoost) +
          mpOut.latentHeatingKPerS * 1.15 -
          capResistance -
          cell.entrainmentRate * 0.032;
      } else if (cell.cloudTopM <= inst.el && inst.cape > 120) {
        // Free convection zone (LFC -> EL): full CAPE release!
        const zNorm =
          (cell.cloudTopM - inst.lfc) / Math.max(1000, inst.el - inst.lfc);
        const verticalShape = Math.sin(Math.min(1.0, Math.max(0.08, zNorm)) * Math.PI * 0.88);
        thermalBuoyancy =
          0.165 * capeScale * (0.48 + 0.85 * verticalShape) +
          mpOut.latentHeatingKPerS * 0.9 -
          cell.entrainmentRate * 0.042;
      } else {
        // Above Equilibrium Level (EL): strong stratospheric negative buoyancy decelerates overshoot!
        const overshootDepth = cell.cloudTopM - inst.el;
        thermalBuoyancy = -0.00045 * overshootDepth;
      }

      // Mesocyclone rotational dynamics when vertical shear & SRH tilt horizontal vorticity into updraft
      if (cell.cloudTopM > inst.lfc + 1200 && cell.updraftMaxMS > 8.0 && inst.bulkShear06km > 13.0) {
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

      // Dynamic non-hydrostatic vertical pressure gradient boost in rotating mesocyclones
      const dynamicPressureBoost =
        Math.abs(cell.mesocycloneVorticity) > 0.008
          ? Math.min(0.11, Math.abs(cell.mesocycloneVorticity) * 4.2)
          : 0;

      // Weak-shear pulse storm self-choking: if shear is low, precip drag acts directly on updraft!
      const shearSeparationFactor = Math.min(1.0, inst.bulkShear06km / 18.0);
      const effectivePrecipDragOnUpdraft =
        mpOut.precipLoadingDragMS2 * (1.0 - 0.72 * shearSeparationFactor);

      // Mature storm lifecycle aging & cold pool undercutting
      const lifecycleExhaustion =
        cell.ageSec > 1500 && Math.abs(cell.mesocycloneVorticity) < 0.012
          ? 0.00008 * (cell.ageSec - 1500)
          : 0;

      cell.buoyancyAccel =
        thermalBuoyancy +
        dynamicPressureBoost -
        effectivePrecipDragOnUpdraft -
        0.025 * coldPoolUndercutPenalty -
        lifecycleExhaustion;

      // Update peak updraft velocity w_max
      const aerodynamicDrag = 0.00018 * cell.updraftMaxMS * Math.abs(cell.updraftMaxMS);
      cell.updraftMaxMS += (cell.buoyancyAccel - aerodynamicDrag) * dt;
      cell.updraftMaxMS = Math.max(-2.5, Math.min(58.0, cell.updraftMaxMS));

      // Downdraft driven by precipitation loading + sub-cloud evaporative & melting cooling
      const downdraftForcing =
        mpOut.precipLoadingDragMS2 * 1.45 + mpOut.subCloudCoolingKPerS * 14.0;
      const targetDowndraft = Math.min(
        28.0,
        Math.sqrt(Math.max(0, downdraftForcing * 950.0))
      );
      cell.downdraftMaxMS += (targetDowndraft - cell.downdraftMaxMS) * Math.min(1.0, 0.04 * dt);

      // Update Cloud Base, Cloud Top, Tower Radius, Overshooting Top & Anvil Spread
      cell.cloudBaseM += (inst.lcl - cell.cloudBaseM) * Math.min(1.0, 0.05 * dt);

      if (cell.updraftMaxMS > 0.3) {
        // Cloud top rises at ~0.48 * peak updraft speed (plume cap ascent velocity)
        const capRise = cell.updraftMaxMS * 0.48;
        const maxPhysicalTop =
          inst.cape > 80
            ? inst.el + Math.min(2600, cell.updraftMaxMS * 48.0)
            : inst.lcl + 1600;
        if (cell.cloudTopM < maxPhysicalTop) {
          cell.cloudTopM += capRise * dt;
        } else {
          cell.cloudTopM += (maxPhysicalTop - cell.cloudTopM) * Math.min(1.0, 0.04 * dt);
        }
      } else {
        // Subsidence & cloud top collapse during dissipation
        cell.cloudTopM = Math.max(
          cell.cloudBaseM,
          cell.cloudTopM - (1.8 + Math.max(0, -cell.updraftMaxMS) * 0.8) * dt
        );
      }

      // Overshooting dome height above Equilibrium Level
      cell.overshootingTopM =
        inst.cape > 400 && cell.cloudTopM > inst.el
          ? Math.max(0, cell.cloudTopM - inst.el)
          : 0;

      // Convective tower horizontal radius grows with cloud depth and mass continuity
      const targetRadius =
        cell.stage === 'dissipating'
          ? cell.radiusM * (1.0 - 0.002 * dt)
          : Math.min(
              4800,
              650 + Math.max(0, cell.cloudTopM - cell.cloudBaseM) * 0.26 * (1.0 + Math.abs(cell.mesocycloneVorticity) * 14.0)
            );
      cell.radiusM += (targetRadius - cell.radiusM) * Math.min(1.0, 0.035 * dt);

      // Upper tropospheric anvil divergence near Equilibrium Level (Cb capillatus!)
      if (cell.cloudTopM > inst.el * 0.84 && (cell.cloudIceGKg + cell.snowGKg) > 0.25) {
        const anvilOutflowSpeed = Math.max(4.0, cell.updraftMaxMS * 0.55 + dAnvMag * 0.45);
        cell.anvilRadiusM = Math.min(13500, cell.anvilRadiusM + anvilOutflowSpeed * dt);
      } else if (cell.stage === 'dissipating') {
        cell.anvilRadiusM = Math.max(0, cell.anvilRadiusM - 1.2 * dt);
      }

      // Precipitation Core & Rear-Flank Downdraft (RFD) spatial offsets from updraft center
      const ffdShiftX = (steerWind.windU - lowWind.windU) * 75.0;
      const ffdShiftZ = (steerWind.windW - lowWind.windW) * 75.0;
      cell.precipCoreOffsetX += (ffdShiftX - cell.precipCoreOffsetX) * Math.min(1.0, 0.04 * dt);
      cell.precipCoreOffsetZ += (ffdShiftZ - cell.precipCoreOffsetZ) * Math.min(1.0, 0.04 * dt);

      if (Math.abs(cell.mesocycloneVorticity) > 0.009) {
        // Hook-echo / RFD wraps cyclonically around southwest/rear flank of mesocyclone
        const wrapAngle = Math.atan2(ffdShiftZ, ffdShiftX) + 2.35;
        cell.rfdOffsetX = Math.cos(wrapAngle) * cell.radiusM * 0.72;
        cell.rfdOffsetZ = Math.sin(wrapAngle) * cell.radiusM * 0.72;
      } else {
        cell.rfdOffsetX = -cell.precipCoreOffsetX * 0.25;
        cell.rfdOffsetZ = -cell.precipCoreOffsetZ * 0.25;
      }

      // Storm Cell Translation: Steering Wind + Bunkers Deviation for Supercells + Gust Front Propagation
      const supercellFrac = Math.min(1.0, Math.abs(cell.mesocycloneVorticity) / 0.014);
      const targetVx =
        cell.rightMoverBias >= 0
          ? steerWind.windU * (1.0 - supercellFrac) + inst.bunkersStormU * supercellFrac
          : steerWind.windU * 1.05 - (inst.bunkersStormU - steerWind.windU) * 0.85;
      const targetVz =
        cell.rightMoverBias >= 0
          ? steerWind.windW * (1.0 - supercellFrac) + inst.bunkersStormW * supercellFrac
          : steerWind.windW * 1.05 - (inst.bunkersStormW - steerWind.windW) * 0.85;

      cell.vx += (targetVx - cell.vx) * Math.min(1.0, 0.08 * dt);
      cell.vz += (targetVz - cell.vz) * Math.min(1.0, 0.08 * dt);
      cell.x += cell.vx * dt;
      cell.z += cell.vz * dt;

      // Spawn or reinforce surface Cold Pool when evaporative downdraft & rain reach surface
      if (cell.downdraftMaxMS > 5.5 && (cell.surfaceRainRateMMHr > 3.5 || cell.virgaFraction > 0.45)) {
        this.feedOrCreateColdPool(cell, mpOut.subCloudCoolingKPerS, dt);
      }

      // Supercell Splitting when strong unidirectional/curved shear stretches vigorous updraft
      if (
        !cell.splitCandidateDone &&
        inst.bulkShear06km > 21.0 &&
        inst.cape > 1400 &&
        cell.updraftMaxMS > 22.0 &&
        cell.ageSec > 260 &&
        this.cells.length < 14
      ) {
        cell.splitCandidateDone = true;
        cell.rightMoverBias = 1;
        const leftMover = this.createSplitLeftMover(cell);
        newSplitCells.push(leftMover);
      }

      // Classify individual cell stage physically
      cell.stage = this.classifyCellStage(cell, inst.lcl, inst.freezingLevel, inst.el);

      // Remove completely dissipated cells or cells advected far outside domain
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
          cell.updraftMaxMS < 0.2 &&
          totalHydrometeors < 0.03 &&
          cell.anvilRadiusM < 400)
      ) {
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

    // Candidate 1: Gust Front & Cold Pool Collision Triggering (Multicell / Squall regeneration!)
    for (let i = 0; i < this.coldPools.length; i++) {
      const p1 = this.coldPools[i];
      if (p1.strength < 0.22 || p1.radiusM < 1200) continue;

      // Sample downshear edge of cold pool where warm low-level inflow converges head-on with gust front
      const lowWind = sounding.sampleAtAltitude(400);
      const inflowAngle = Math.atan2(-lowWind.windW, -lowWind.windU) + (this.rand() - 0.5) * 0.9;
      const candX = p1.x + Math.cos(inflowAngle) * p1.radiusM;
      const candZ = p1.z + Math.sin(inflowAngle) * p1.radiusM;

      if (Math.abs(candX) > DOMAIN_HALF_SIZE - 2200 || Math.abs(candZ) > DOMAIN_HALF_SIZE - 2200) {
        continue;
      }

      // Check collision with another cold pool for enhanced lifting!
      let collisionBoost = 0;
      for (let j = 0; j < this.coldPools.length; j++) {
        if (i === j) continue;
        const p2 = this.coldPools[j];
        const dFront2 = Math.abs(Math.hypot(candX - p2.x, candZ - p2.z) - p2.radiusM);
        if (dFront2 < 1500) {
          collisionBoost += p2.strength * 1.6;
        }
      }

      // Mechanical gust-front lifting w_gust ~ 0.6 * c_gust overcomes much stronger CIN than solar thermals alone
      const gustKineticEnergy = 0.5 * Math.pow(p1.expansionSpeedMS * (1.0 + collisionBoost * 0.5), 2);
      if (
        gustKineticEnergy + 28.0 * cfg.solarHeatingFactor > inst.cin * 0.75 &&
        rh0 > 38 &&
        !this.isNearExistingUpdraft(candX, candZ, 3400)
      ) {
        const triggerProb = Math.min(0.65, (0.08 + 0.16 * collisionBoost) * checkDt);
        if (this.rand() < triggerProb) {
          this.spawnNucleatingThermal(candX, candZ, sounding, 950 + collisionBoost * 350, 2.8 + p1.expansionSpeedMS * 0.35);
          if (this.cells.length >= 14) return;
        }
      }
    }

    // Candidate 2: Solar Boundary-Layer Thermal Plumes over sunlit terrain hotspots
    if (rh0 < 29 || inst.lcl > 4100 || cfg.solarHeatingFactor < 0.15) {
      // Too dry or no surface heating -> clear sky persists naturally!
      return;
    }

    // Thermal kinetic energy vs CIN barrier
    const thermalEnergyJPerKg =
      (38.0 * cfg.solarHeatingFactor * this.boundaryLayerThermalEnergy) +
      Math.max(0, (rh0 - 50) * 0.9);
    if (thermalEnergyJPerKg < inst.cin * 0.55) {
      return;
    }

    const attempts = 5;
    for (let a = 0; a < attempts; a++) {
      // Favor field of view in front of observer (-11km..+11km X, -11km..+3.5km Z) while covering whole domain
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
    const lowWind = sounding.sampleAtAltitude(700);
    const upperWind = sounding.sampleAtAltitude(9500);
    const dx = upperWind.windU - lowWind.windU;
    const dz = upperWind.windW - lowWind.windW;
    const dMag = Math.max(0.1, Math.hypot(dx, dz));

    const lcl = sounding.instability.lcl;
    // Start parcel slightly below LCL so condensation grows visibly from thin wisps at LCL!
    const startTop = Math.max(350, lcl - 120);

    this.cells.push({
      id,
      numericId: num,
      x,
      z,
      vx: lowWind.windU,
      vz: lowWind.windW,
      ageSec: 0,
      stage: 'nucleating',
      radiusM,
      cloudBaseM: lcl,
      cloudTopM: startTop,
      anvilRadiusM: 0,
      anvilAxisX: dx / dMag,
      anvilAxisZ: dz / dMag,
      overshootingTopM: 0,
      updraftMaxMS: initUpdraftMS,
      downdraftMaxMS: 0,
      buoyancyAccel: 0.02,
      entrainmentRate: 0.25,
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
    // Conserve water & charge by partitioning 62% to right-mover and 38% to left-mover
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
        // Don't immediately re-merge freshly split opposite-vorticity pair
        if (a.rightMoverBias * b.rightMoverBias < 0 && Math.abs(a.ageSec - b.ageSec) < 120) {
          continue;
        }
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        const mergeDist = 0.62 * (a.radiusM + b.radiusM);
        if (dist < mergeDist && a.cloudTopM > a.cloudBaseM + 600 && b.cloudTopM > b.cloudBaseM + 600) {
          // Merge smaller cell into stronger cell conserving mass & charge weighted by volume
          const volA = a.radiusM * a.radiusM * Math.max(200, a.cloudTopM - a.cloudBaseM);
          const volB = b.radiusM * b.radiusM * Math.max(200, b.cloudTopM - b.cloudBaseM);
          const totVol = volA + volB;
          const wA = volA / totVol;
          const wB = volB / totVol;

          a.x = a.x * wA + b.x * wB;
          a.z = a.z * wA + b.z * wB;
          a.vx = a.vx * wA + b.vx * wB;
          a.vz = a.vz * wA + b.vz * wB;
          a.radiusM = Math.min(5200, Math.sqrt(a.radiusM * a.radiusM + b.radiusM * b.radiusM * 0.65));
          a.cloudTopM = Math.max(a.cloudTopM, b.cloudTopM);
          a.anvilRadiusM = Math.max(a.anvilRadiusM, b.anvilRadiusM);
          a.updraftMaxMS = Math.min(56, Math.max(a.updraftMaxMS, b.updraftMaxMS) * 1.06);

          a.cloudWaterGKg = a.cloudWaterGKg * wA + b.cloudWaterGKg * wB * 1.15;
          a.supercooledWaterGKg = a.supercooledWaterGKg * wA + b.supercooledWaterGKg * wB * 1.15;
          a.cloudIceGKg = a.cloudIceGKg * wA + b.cloudIceGKg * wB * 1.15;
          a.snowGKg = a.snowGKg * wA + b.snowGKg * wB * 1.15;
          a.graupelGKg = a.graupelGKg * wA + b.graupelGKg * wB * 1.15;
          a.hailGKg = a.hailGKg * wA + b.hailGKg * wB * 1.15;
          a.rainGKg = a.rainGKg * wA + b.rainGKg * wB * 1.15;

          a.upperPosChargeNCm3 = a.upperPosChargeNCm3 * wA + b.upperPosChargeNCm3 * wB;
          a.mainNegChargeNCm3 = a.mainNegChargeNCm3 * wA + b.mainNegChargeNCm3 * wB;
          a.lowerPosChargeNCm3 = a.lowerPosChargeNCm3 * wA + b.lowerPosChargeNCm3 * wB;

          this.cells.splice(j, 1);
          j--;
        }
      }
    }
  }

  private feedOrCreateColdPool(
    cell: ConvectiveCell,
    coolingRateKPerS: number,
    dt: number
  ): void {
    const poolCenterX = cell.x + cell.precipCoreOffsetX;
    const poolCenterZ = cell.z + cell.precipCoreOffsetZ;

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
        tempDeficitK: 2.2,
        ageSec: 0,
        strength: 0.5,
      };
      this.coldPools.push(existing);
    } else {
      existing.tempDeficitK = Math.min(
        9.5,
        existing.tempDeficitK + (coolingRateKPerS * 12.0 + cell.surfaceRainRateMMHr * 0.0012) * dt
      );
      existing.depthM = Math.min(1450, existing.depthM + cell.downdraftMaxMS * 0.25 * dt);
    }
  }

  private stepColdPools(dt: number, sounding: AtmosphericSounding): void {
    const t0 = sounding.levels[0].tempK;
    for (let i = this.coldPools.length - 1; i >= 0; i--) {
      const p = this.coldPools[i];
      p.ageSec += dt;
      // Benjamin (1968) gravity current propagation speed: c = Froude * sqrt(g * H * dT / T0)
      p.expansionSpeedMS =
        0.78 * Math.sqrt((PHYS.G * p.depthM * Math.max(0.2, p.tempDeficitK)) / t0);
      p.radiusM += p.expansionSpeedMS * dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;

      // Surface warming & radial spreading gradually thin the cold pool
      p.tempDeficitK *= Math.max(0, 1.0 - 0.0018 * dt);
      p.depthM = Math.max(220, p.depthM * (1.0 - 0.0009 * dt));
      p.strength = Math.max(0, Math.min(1.0, (p.tempDeficitK / 6.5) * (1.0 - p.radiusM / 15000)));

      if (p.tempDeficitK < 0.45 || p.radiusM > 15500) {
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
    if (cell.cloudTopM <= lcl + 80 || (cell.cloudWaterGKg + cell.cloudIceGKg) < 0.03) {
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
    if (cell.anvilRadiusM > cell.radiusM * 1.35 || cell.cloudTopM > el * 0.88) {
      return 'mature';
    }
    if (cell.cloudTopM > freezeZ + 1600 && (cell.cloudIceGKg + cell.graupelGKg) > 0.25) {
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
      // Check linear alignment (PCA / aspect ratio of cell centers) for Squall Line vs Multicell Cluster
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
