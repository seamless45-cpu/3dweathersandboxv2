import { MesoscaleEnvironment } from './mesoscaleEnvironment';
import { stepCellMicrophysics } from './microphysics';
import { buildPlumeProfile, plumeVelocityAt, samplePlume } from './updraftModel';
import { getSurfaceThermalPotential, getTerrainHeight } from './terrainField';
import { AtmosphericSounding } from './thermodynamics';
import {
  AtmosphereConfig,
  CellLifecycleStage,
  CloudMorphology,
  ColdPool,
  ConvectiveCell,
  DOMAIN_HALF_SIZE,
  PHYS,
  StormOrganizationMode,
} from './types';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Surface insolation actually available to the boundary layer right now.
 *
 * The user's solar heating preference is a fixed scaling on how strongly this atmosphere
 * responds to sunshine; the diurnal cycle supplies the time-of-day term on top of it. Keeping
 * them multiplied here rather than writing the product back into the config means the slider
 * keeps showing what the user chose, and night genuinely stops thermals from forming instead of
 * just dimming the lighting.
 */
export function effectiveSolarInsolation(cfg: AtmosphereConfig): number {
  const scale = cfg.solarInsolationScale === undefined ? 1 : cfg.solarInsolationScale;
  return cfg.solarHeatingFactor * scale;
}

export class ConvectiveCellManager {
  public cells: ConvectiveCell[] = [];
  /**
   * Vorticity that counts as "rotating" for this environment, s⁻¹.
   *
   * Mesocyclone strength is not a universal constant — it scales with the streamwise vorticity
   * the hodograph supplies, which is why a 40 m/s SRH sounding produces a 0.02 s⁻¹ vortex and a
   * 60 m²/s² one cannot. Every gate that used to compare against a hard-coded 0.008/0.011/0.014
   * now compares against this, so a straight-line hodograph is still unable to make a supercell
   * and a strongly curved one can reach the stage without a threshold tuned to one preset.
   */
  private vorticityScale = 0.012;
  /** 0-3 km storm-relative helicity of the environment (m²/s²), set from the sounding each step. */
  private environmentSRH03 = 0;
  /** 0-6 km bulk shear of the environment (m/s). */
  private environmentShear06 = 0;
  /** Environmental streamwise vorticity (s^-1) that tilting and stretching amplify. */
  private environmentAmbientVorticityS = 0.012;
  public coldPools: ColdPool[] = [];
  public organization: StormOrganizationMode = 'Clear Sky';

  private nextCellNum = 1;
  private nextPoolNum = 1;
  private boundaryLayerThermalEnergy = 0;
  /** Fraction (0..0.86) of the initial CIN mixed away by surface heating and gust fronts. */
  private capErosionFrac = 0;
  /** Transient mixing from active cold-pool fronts, fed by stepColdPools. */
  private gustFrontMixing = 0;
  /** Resolved mesoscale boundary-layer field, supplied by the coordinator. */
  private env: MesoscaleEnvironment | null = null;
  private sfcTempK = 302.65;
  private sfcDewK = 297.0;
  private sfcQvGKg = 14.0;
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

  /**
   * Environmental streamwise vorticity, from the sounding and the Bunkers storm motion.
   *
   * This is a property of the *environment*, not of any particular cell, and it is the seed that
   * tilting and stretching then amplify. Two things were wrong with computing it inside the
   * per-cell update:
   *
   *  1. It used the cell's *own* velocity in the storm-relative wind, so the curvature term grew
   *     as the cell accelerated away from the mean wind. A supercell ended up with an ambient
   *     vorticity of 0.055 s⁻¹ — five times anything the hodograph supplies — and stretching
   *     turned that into a 0.22 s⁻¹ "mesocyclone", seven times the strongest ever observed.
   *  2. Being recomputed every step, it also fed straight back into its own amplification.
   *
   * ξ ≈ SRH / (2·h) over the inflow layer (Davies-Jones 1984), reduced by the fraction of the
   * hodograph that is *curved*: straight streamwise vorticity gives a non-rotating updraft no
   * matter how large SRH is, because the updraft has no way to tilt it into the vertical. The
   * curvature is measured against the storm motion the sounding itself implies, which is a
   * fixed vector for a given sounding.
   */
  private updateEnvironmentVorticity(sounding: AtmosphericSounding): void {
    const inst = sounding.instability;
    this.environmentSRH03 = inst.srh03km;
    this.environmentShear06 = inst.bulkShear06km;
    const srh = Math.max(0, inst.srh03km);
    // The inflow layer (0-3 km) carries the helicity; h = 2500 m is the effective depth of a
    // supercell's inflow, slightly less than the integration depth because the lowest 500 m is
    // surface friction.
    const streamwiseVorticity = srh / (2 * 2500);
    // Storm motion from the sounding. Held as a fixed reference so this value does not depend
    // on where any individual cell happens to be or how fast it is moving.
    const stormU = (sounding.windUAt(200) + sounding.windUAt(3000)) * 0.5;
    const stormW = (sounding.windWAt(200) + sounding.windWAt(3000)) * 0.5;
    const sr0x = sounding.windUAt(200) - stormU;
    const sr0z = sounding.windWAt(200) - stormW;
    const sr3x = sounding.windUAt(3000) - stormU;
    const sr3z = sounding.windWAt(3000) - stormW;
    const n0 = Math.hypot(sr0x, sr0z) || 1;
    const n3 = Math.hypot(sr3x, sr3z) || 1;
    // |sin(angle between the two storm-relative winds)| — 0 on a straight hodograph.
    const curvature = Math.abs((sr0x / n0) * (sr3z / n3) - (sr0z / n0) * (sr3x / n3));
    const ambient = streamwiseVorticity * (0.35 + 0.65 * curvature);
    this.environmentAmbientVorticityS = Math.max(0, Math.min(0.04, ambient));
    // The scale a fully stretched column would reach. It gates the supercell and tornado stages,
    // so it is derived from the environment rather than being a universal constant.
    this.vorticityScale = Math.max(0.004, this.environmentAmbientVorticityS * 1.9);
    for (const cell of this.cells) cell.ambientVorticityS = this.environmentAmbientVorticityS;
  }

  public step(
    dt: number,
    simTimeSec: number,
    sounding: AtmosphericSounding,
    cfg: AtmosphereConfig,
    env: MesoscaleEnvironment | null = null
  ): void {
    this.env = env;
    // The domain-scale profile. Each cell below shadows `inst` with its own localised version, so
    // a cell growing 20 km from another sees its own CAPE, CIN and cloud base rather than a value
    // averaged over the whole domain.
    const baseInst = sounding.instability;
    this.updateEnvironmentVorticity(sounding);
    const sfc = sounding.levels[0];
    this.sfcTempK = sfc ? sfc.tempK : cfg.surfaceTempC + 273.15;
    this.sfcDewK = sfc ? sfc.dewpointK : this.sfcTempK - 4.0;
    this.sfcQvGKg = sfc ? sfc.qvEnv * 1000.0 : 14.0;
    const solar = effectiveSolarInsolation(cfg);

    // 1. Progressive boundary-layer solar warming from t=0 clear sky
    const insolationRate = solar * 0.018;
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
      (0.028 + 0.052 * solar) *
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

    for (let i = this.cells.length - 1; i >= 0; i--) {
      const cell = this.cells[i];
      cell.ageSec += dt;

      // Localised environment at this cell's position. Shadows the domain-scale `inst` so every
      // growth law, threshold and stage classification below uses the air this cell is actually
      // sitting in -- including whatever its own outflow and rainfall did to it earlier.
      const inst = this.env
        ? this.env.localizeInstability(cell.x, cell.z, baseInst, this.sfcTempK, this.sfcDewK, this.sfcQvGKg)
        : baseInst;

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

      // ---- Sub-cloud inflow kinetic energy -----------------------------------------------
      // What the plume starts with at cloud base. Solar thermals carry a few m/s; a gust front
      // forces 6-12 m/s up the leading edge, and that forced ascent is what lets a cell initiate
      // through a cap the free-convection parcel cannot break. Cyclic here so the value used for
      // momentum this step is the one the plume solve sees.
      const thermalInflow = 1.6 + 2.6 * solar * Math.min(1.4, this.boundaryLayerThermalEnergy);
      cell.baseInflowMS = clamp(thermalInflow + 4.5 * gustFrontLiftBoost, 0.5, 12.0);

      // Microphysics update (condensation ceiling, ice, riming, hail, rain, latent heat, drag).
      // Also sets cell.entrainmentRate (km^-1) from the updraft radius.
      //
      // The microphysical ceiling is evaluated over the *plume's* depth, not the tower's current
      // height. A cloud cannot bootstrap itself otherwise: the ceiling is the condensate produced
      // by the air rising through the cell, and the depth of rising air is the plume's, not the
      // visible tower's. Using the visible depth made a 2 km cumulus hold 0.3 g/kg, which is far
      // too little to rain, and then the absence of rain kept the updraft weak, which kept the
      // tower short. Handing the microphysics the plume's depth breaks that feedback at the
      // physical place: the condensate supply is what it actually is, and the tower catches up
      // to it in a few minutes.
      const ceilingTopM = cell.plumeProfile
        ? Math.max(cell.cloudTopM, cell.plumeProfile.topM * 0.92)
        : cell.cloudTopM;
      const mpOut = stepCellMicrophysics(cell, dt, sounding, cfg, ceilingTopM);

      const cloudDepth = Math.max(300, cell.cloudTopM - cell.cloudBaseM);
      // Structural archetype: biases every growth law below, so a tower, a multicell cluster, a
      // shallow cumulus and a stratiform deck all evolve from the same physics but end up as
      // visibly different clouds rather than four copies of one shape.
      this.promoteMorphology(cell);
      const morph = ConvectiveCellManager.MORPH_FACTORS[cell.morphology];

      // ---- Vertical momentum balance -------------------------------------------------
      // The updraft is a *plume*, not a single parcel. Its speed at any level comes from the
      // entraining ascent in updraftModel.ts, which already integrates
      //
      //     d(w²)/dz = 2·B·η − 2·ε·w² − 2·a_d·w²/R
      //
      // along the sounding. Here that steady-state speed is relaxed toward on the plume's own
      // overturning timescale, with the extra sources a real storm has on top of it: the
      // perturbation-pressure deficit of a rotating updraft, the dynamic-pressure suction of a
      // turbulent core, the drag of the hydrometeor load, and the loss of buoyancy to the cold
      // pool undercutting the inflow.
      //
      // The previous formulation instead multiplied a depth-mean parcel buoyancy by four
      // hand-tuned coefficients, so the updraft speed never actually reflected the sounding's
      // structure: every cell, shallow or deep, ended up near the same equilibrium.
      // Stratiform decks mix out fast, narrow towers stay intact: the archetype scales the
      // plume's effective core radius (eps ~ 1/R), not the visible tower width.
      this.refreshPlume(cell, sounding, inst, solar, mpOut.condensateEfficiency, morph.entrain);

      const plume = cell.plumeProfile!;
      // The updraft's kinetic energy is set by the plume at the *cloud top* — that is the air
      // doing the growing and it is where the plume's own momentum equation has drained most of
      // its energy. But a cell's top and its plume's top are two different things: the top lags
      // the plume and can sit well above its top after a strong pulse. Sampling only at the top
      // then reads the terminated (zero-velocity) end of the profile and the updraft collapses
      // to zero, recovers, and oscillates. Take the maximum over the upper half of the tower
      // instead, which is stable and physically the part of the column driving the growth.
      const zEval = clamp(cell.cloudTopM, 200, Math.max(400, plume.topM));
      const zUpper = Math.max(600, cell.cloudTopM * 0.62);
      const plumeSpeed = Math.max(
        plumeVelocityAt(plume, zEval, cell.baseInflowMS),
        plumeVelocityAt(plume, zUpper, cell.baseInflowMS) * 0.92
      );

      // Cold-pool undercutting removes buoyancy from the inflow, which shows up as a direct
      // momentum sink rather than a buoyancy term.
      const coldPoolDrag = coldPoolBuoyancyPenalty * 6.0;
      // Hydrometeor loading: precipitation that has not yet fallen out weighs on the column.
      // Shear tilts the shaft downshear out of the updraft, which is why a sheared storm carries
      // its load without collapsing the way a vertical one does.
      const shearSeparation = Math.min(1.0, inst.bulkShear06km / 18.0);
      const loadingDrag = mpOut.precipLoadingDragMS2 * (1.0 - 0.72 * shearSeparation) * 9.0;

      // Rotating updrafts are dynamically supported: the same low-pressure core that makes a
      // mesocyclone also sucks air upward through it.
      const dynamicPressureBoost =
        Math.abs(cell.mesocycloneVorticity) > this.vorticityScale * 0.5
          ? Math.min(6.5, Math.abs(cell.mesocycloneVorticity) * 240.0)
          : 0;

      // A congested tower's own turbulence is a drag: the updraft decelerates into the anvil
      // once it has topped out. This is separate from the plume's internal drag because it acts
      // on the *cell* once the cloud has depth above its equilibrium level.
      const overshootBrake = cell.cloudTopM > inst.el ? 0.00042 * (cell.cloudTopM - inst.el) * 40.0 : 0;

      // ---- Senescence ---------------------------------------------------------------------
      // A dissipating cell has no buoyant inflow left: its cold pool has cut it off, or its
      // moisture supply is exhausted. Physically its updraft decays on the overturning timescale,
      // so the target is scaled down rather than left at whatever the plume still supports.
      // Without this the updraft stayed at 20 m/s inside an 800 m cloud for the whole run, which
      // then fed the "24-minute-old cumulus humilis with a violent updraft" pathology.
      const senescence = cell.stage === 'dissipating' ? 0.18 : 1.0;

      const targetW = clamp(
        (plumeSpeed + dynamicPressureBoost) * senescence - loadingDrag - coldPoolDrag - overshootBrake,
        0,
        62
      );

      // Relaxation time: an updraft's momentum equilibrates over roughly one overturning time,
      // (cloud depth)/w. For a 6 km tower at 15 m/s that is ~400 s, but the response is faster
      // than that on the way up (accelerating) and slower on the way down (inertia), so use a
      // 120 s rise and 400 s decay time constant.
      const wNow = cell.updraftMaxMS;
      const tau = targetW > wNow ? 90 : 420;
      const relaxMs = 1.0 - Math.exp(-dt / tau);

      // Non-hydrostatic perturbation pressure deficit of the rotating core, reported to the HUD.
      cell.buoyancyAccel = (targetW - wNow) / Math.max(1, tau) + samplePlume(plume, zEval).buoyancy;

      // Mature-storm ageing: a non-rotating cell is eventually choked by its own cold pool. The
      // plume already produces that through entrainment and loading; this term adds the
      // mesoscale outflow component that the single-column model cannot see.
      const lifecycleExhaustion =
        cell.ageSec > 1500 && Math.abs(cell.mesocycloneVorticity) < 0.01
          ? 0.000075 * (cell.ageSec - 1500)
          : 0;

      cell.updraftMaxMS = clamp(
        wNow + (targetW - wNow) * relaxMs - lifecycleExhaustion * dt,
        -3.0,
        62.0
      );


      // ---- Vorticity: tilting of environmental streamwise vorticity, then stretching ---------
      // A mesocyclone is not a property a storm can be given; it is produced. The environmental
      // horizontal vorticity of a sheared flow is tilted into the vertical by a buoyant updraft,
      // and the resulting vertical vorticity is then amplified by the updraft's own stretching:
      //
      //     dζ/dt  =  (ω_h · ∇_h w)  −  ζ·(∂w/∂z)      [tilting + stretching]
      //     ω_h    ≈  −∂V/∂z          (baroclinic + shear, dominated by the shear term)
      //
      // The streamwise component of ω_h that matters is the one pointing along the storm-relative
      // inflow, and its layer-mean magnitude is exactly SRH/2 divided by the inflow depth. That
      // is the standard relation ξ ≈ SRH/(2·h) for the inflow layer (Davies-Jones 1984), and it
      // is the only bridge between the sounding's hodograph and the storm's rotation.
      //
      // This was simply missing: `mesocycloneVorticity` was initialised to 0 and never written
      // again, so *no storm could ever rotate*. Since the 'supercell' life-cycle classification
      // and tornado genesis both gate on |ζ| > 0.011, the simulation could not produce a
      // supercell at all — every preset degenerated to a multicell cluster or a single cell.
      this.environmentSRH03 = inst.srh03km;
      this.environmentShear06 = inst.bulkShear06km;
      // `cell.ambientVorticityS` is an *environment* property and is set once, by
      // `computeEnvironmentVorticity` below. It must not be recomputed per cell per step from
      // cell-relative wind: the curvature term is a property of the hodograph, and measuring it
      // against a moving storm's own velocity made it grow as the storm's motion drifted away
      // from the mean wind. A cell then "discovered" an ambient vorticity of 0.055 s⁻¹ — five
      // times what any sounding here supplies — and stretching multiplied that into a
      // 0.22 s⁻¹ "mesocyclone", which is seven times the strongest ever measured and left the
      // vortex injection term with no choice but to destabilise the grid.
      // The vorticity a *supercell* needs is not a universal constant: it is set by what the
      // environment can supply, because stretching amplifies an existing vortex rather than
      // creating one. `this.vorticityScale` is derived once per step in
      // `updateEnvironmentVorticity` — assigning it here as well would let the last cell in the
      // loop overwrite the environment's value with its own.
      // Tilting needs an updraft; stretching is proportional to ∂w/∂z over the inflow layer.
      // Stretching amplification: dζ/dt ≈ ζ·(−∂w/∂z) integrated over the vortex tube. For a
      // tower of depth H rising at w, ∂w/∂z ~ w/H, so over the residence time H/w the vortex is
      // stretched by a factor of order e — i.e. the steady-state amplification is set by how
      // long the tube survives against turbulent dissipation, not by the instantaneous shear.
      // A mature supercell's mesocyclone reaches 1-3×10⁻² s⁻¹ (a *strong* one is 0.03), so the
      // amplification factor has to span roughly an order of magnitude above the ambient
      // streamwise vorticity. A cap of 1.6 left every storm at 0.011, which is a weak
      // mesocyclone that can never satisfy a tornado-genesis threshold.
      const stretchRate =
        cell.cloudTopM > inst.lfc
          ? clamp((cell.updraftMaxMS / 14.0) * ((cell.cloudTopM - cell.cloudBaseM) / 5000.0), 0, 4.2)
          : 0;
      const vortTarget = cell.ambientVorticityS * stretchRate * (cell.rightMoverBias < 0 ? -1 : 1);
      // Spin-up is fast once the updraft is established (a mesocyclone forms in 10-20 minutes),
      // spin-down is slower because the vortex decays by turbulent diffusion.
      const tauVort = Math.abs(vortTarget) > Math.abs(cell.mesocycloneVorticity) ? 380 : 900;
      cell.mesocycloneVorticity += (vortTarget - cell.mesocycloneVorticity) * (1.0 - Math.exp(-dt / tauVort));
      // Hard physical ceiling. A mesocyclone is the strongest rotation the atmosphere produces
      // outside a tornado, and the strongest ever measured is about 0.03 s⁻¹; the amplification
      // above is a single-vortex model that can in principle run away, so the ceiling is stated
      // explicitly rather than relying on the relaxation to settle below it.
      cell.mesocycloneVorticity = clamp(cell.mesocycloneVorticity, -0.032, 0.032);
      // Vorticity advection by the storm-relative flow is what makes the mesocyclone move with
      // the right-mover rather than with the mean wind.
      cell.rotationPhase +=
        dt * 0.00055 * cell.mesocycloneVorticity * 1e3;

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
      // A cell cannot have a base below the lifting condensation level: condensate does not
      // exist in unsaturated air, so the visible cloud starts at the LCL and the sub-cloud
      // tower below it is invisible (it still exists in the plume). The old code let the base
      // relax to `min(lcl, cloudTop)` and simultaneously allowed the top to be driven by a
      // morphology factor, which occasionally put a "cloud" 300 m above ground on a day with a
      // 1 km LCL.
      //
      // The base is a *thermodynamic level*, not a fraction of the cloud: condensation begins
      // where a rising parcel first saturates, so for a given mixed layer the base is fixed.
      // It is allowed to move only because the boundary layer itself changes (rain-cooled
      // outflow lowers it, solar heating raises the LCL), which is exactly what
      // `mesoscaleEnvironment.sampleAt()` provides. Deriving it from the top instead — the
      // base used to follow `min(lcl, top)` and then get dragged down by the top-collapse
      // factor during dissipation — let a mature tower's base fall from 756 m to 633 m over
      // 100 s while its LCL sat at 1000 m, so a deep cloud stood on a base 370 m below the
      // level at which its air could condense.
      const lclFloor = Math.max(180, inst.lcl);
      let localLcl = lclFloor;
      if (this.env) {
        const local = this.env.sampleAt(cell.x, cell.z);
        // The LCL is a thermodynamic level, so its motion under a boundary-layer perturbation
        // has to be derived, not tuned. The mixed-layer dewpoint depression is D = T − T_d, and
        // to first order (Clausius–Clapeyron, d(ln e_s)/dT = L/(R_v T²) ≈ 0.0564 per K at these
        // temperatures) a relative change in q_v of δ moves T_d by δ/0.0564 K. The LCL itself
        // sits where the dry adiabat meets the mixing-ratio line, so dLCL/dD ≈ 125 m per K.
        //
        //   δD = −δθ   (warmer surface, same moisture, larger depression)
        //        − δq/q·(1/0.0564)   (more moisture, smaller depression)
        //
        // The previous version multiplied the perturbations by 120 and 95 with no derivation:
        // a −3.4 K cold pool (a realistic value) shifted the LCL by −400 m, and since the
        // arithmetic was linear and unbounded it could drive the base far below any level at
        // which air can condense.
        const qvBase = Math.max(1.0, sounding.mlQvGKg);
        const dDewpointK = -(local.qvPert / qvBase) / 0.0564;
        const dDepressionK = local.thetaPert + dDewpointK;
        // A *colder* boundary layer with the same moisture has a smaller depression, so the LCL
        // falls; this is the sign that matters for a rain-cooled outflow.
        const lclShift = clamp(-dDepressionK * 125.0, -350, 700);
        localLcl = clamp(lclFloor + lclShift, 300, lclFloor + 1000);
      }
      // Below the local LCL there is no condensate: the base cannot be under it, and a cell
      // whose top has not yet reached it has no visible cloud at all.
      const targetBaseM = Math.min(localLcl, cell.cloudTopM);
      cell.cloudBaseM += (targetBaseM - cell.cloudBaseM) * (1.0 - Math.exp(-dt / 90.0));
      if (cell.cloudTopM < cell.cloudBaseM) cell.cloudBaseM = cell.cloudTopM;

      if (cell.updraftMaxMS > 0.25) {
        // ---- Cloud-top growth ------------------------------------------------------------
        // The plume already resolved where this cell's updraft stops rising, so the top is not
        // an independent thing that has to be nursed along: the tower grows at a rate set by how
        // much buoyant depth the plume has below the top, which for a saturated column is
        //     dz/dt ≈ w(z) · (B(z)/B_max)   — fast through the buoyant core, stalling at the top.
        // Using the cell's own w (which lags) made the cloud take 20 minutes to reach a level
        // the plume solves in one call, and because the microphysical ceiling is diluted with
        // cloud *depth*, that lag starved the cloud of condensate and kept it permanently shallow.
        const plumeW = plumeVelocityAt(plume, Math.min(cell.cloudTopM, plume.topM), cell.baseInflowMS);
        const capRiseFactor = clamp(0.88 - 0.44 * (cloudDepth / 9000.0), 0.4, 0.88);
        const capRise = Math.max(plumeW * 0.55, cell.updraftMaxMS * capRiseFactor * 0.62);
        // Kinetic-energy ceiling for the overshoot: the plume's own top plus however far the
        // updraft's momentum can carry it past the equilibrium level (w²/2g, capped).
        const overshoot = Math.min(2600, (plumeW * plumeW) / (2.0 * 9.81));
        const plumeCeiling = plume.topM + overshoot;
        const morphologyCeiling = inst.cape > 80
          ? inst.el * morph.top + 1800
          : inst.lcl + 900 + cell.updraftMaxMS * 150.0;
        const maxPhysicalTop = Math.min(plumeCeiling, morphologyCeiling);
        if (cell.cloudTopM < maxPhysicalTop) {
          cell.cloudTopM = Math.min(maxPhysicalTop, cell.cloudTopM + capRise * dt);
        } else {
          // Over the ceiling: the top is above where this cell's own buoyancy can sustain it, so
          // anvil material is left behind and the visible top subsides. It must *subside*, not
          // snap — the previous 40 s relaxation let an archetype ceiling 1.6 km below the tower
          // pull a 9.2 km top down by 400 m in a single second, which reads on screen and in the
          // radar as the storm being cut off at the knees. Anvil fallout and evaporation work at
          // a few m/s, so cap the approach there and let the relaxation handle the rest.
          const subsidenceMS = Math.min(6.0, 1.4 + 0.08 * (cell.cloudTopM - maxPhysicalTop));
          const target = Math.max(maxPhysicalTop, cell.cloudTopM - subsidenceMS * dt);
          cell.cloudTopM = target;
        }
      } else {
        // Subsidence & cloud top collapse during dissipation. An orphaned anvil evaporates from
        // below as its ice falls out, so the top sinks at a few m/s, not instantaneously.
        cell.cloudTopM = Math.max(
          cell.cloudBaseM,
          cell.cloudTopM - (2.4 + Math.max(0, -cell.updraftMaxMS) * 0.9) * dt
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
      // Observed updraft cores: ~0.5 km radius for a 2 km shallow cumulus up to 3-4 km for a
      // 12 km supercell — and a supercell's *tower* is 5-8 km across while its vortex-bearing
      // core is 1-3 km. The previous coefficients produced a 6.8 km radius for a 9 km deep,
      // 34 m/s tower, which in turn displaced the rear-flank downdraft by 4.9 km and made the
      // "hook" four times wider than the storm.
      const continuityRadius =
        320 + Math.sqrt(Math.max(0, cell.updraftMaxMS) * Math.max(300, cloudDepth)) * 9.0;
      const depthRadius = cloudDepth * (0.13 + 0.006 * Math.sqrt(Math.max(0, cell.updraftMaxMS)));
      const targetRadius =
        cell.stage === 'dissipating'
          ? cell.radiusM * (1.0 - 0.0045 * dt)
          : clamp(
              Math.max(continuityRadius, depthRadius) *
                morph.radius *
                (1.0 + Math.min(0.35, Math.abs(cell.mesocycloneVorticity) * 9.0)),
              420,
              5400
            );
      cell.radiusM += (targetRadius - cell.radiusM) * (1.0 - Math.exp(-dt / 240.0));

      // Upper tropospheric anvil divergence near the Equilibrium Level (Cb capillatus).
      if (cell.cloudTopM > inst.el * 0.82 && (cell.cloudIceGKg + cell.snowGKg) > 0.1) {
        const anvilOutflowSpeed = Math.max(3.5, cell.updraftMaxMS * 0.5 + dAnvMag * 0.45);
        // morph.anvil ~0 for shallow and stratiform archetypes: they simply never reach the
        // divergence level, so they grow no anvil at all instead of a small one.
        cell.anvilRadiusM = Math.min(
          13500,
          cell.anvilRadiusM + anvilOutflowSpeed * morph.anvil * dt
        );
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

      if (Math.abs(cell.mesocycloneVorticity) > this.vorticityScale * 0.65) {
        // Hook-echo / RFD wraps cyclonically around the rear flank of the mesocyclone.
        const wrapAngle = Math.atan2(ffdShiftZ, ffdShiftX) + 2.35;
        cell.rfdOffsetX = Math.cos(wrapAngle) * cell.radiusM * 0.72;
        cell.rfdOffsetZ = Math.sin(wrapAngle) * cell.radiusM * 0.72;
      } else {
        cell.rfdOffsetX = -cell.precipCoreOffsetX * 0.25;
        cell.rfdOffsetZ = -cell.precipCoreOffsetZ * 0.25;
      }

      // Storm translation: steering flow + Bunkers deviation for rotating cells.
      const supercellFrac = Math.min(1.0, Math.abs(cell.mesocycloneVorticity) / this.vorticityScale);
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
        this.feedOrCreateColdPool(cell, downdraftTempDeficitK, dt, sounding);
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

      // Retire a cell once its *cloud* has left the simulated domain. The margin used to be
      // 5.5 km beyond a +/-24 km grid, so a storm could sit 30 km out — invisible, unrendered,
      // outside the fluid grid — while still counting toward the active-cell total, the
      // organisation classifier and tornado genesis. Its radius is included because a 5 km wide
      // tower centred at 23 km still has half of itself over the grid.
      // Only a small margin: a storm centred much beyond the edge has no grid beneath it, so
      // its updraft, rain, lightning and rotation are pure bookkeeping. Retire it as it leaves.
      // (A wide cell was previously allowed 90% of its own radius of slack, which let a 5 km
      // supercell run 28 km out — four kilometres past the last simulated voxel — and still be
      // classified, counted and rendered.)
      const leaveMargin = 2200;
      const outOfBounds =
        Math.abs(cell.x) > DOMAIN_HALF_SIZE + leaveMargin ||
        Math.abs(cell.z) > DOMAIN_HALF_SIZE + leaveMargin;

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
        // Split the water this cell is still holding by where it physically was, and charge it
        // exactly once. The budget identity the coordinator checks is
        //     condensed == suspended inventory + fallout + evaporated
        // so every gram retired here has to land in one of those buckets and no gram may land in
        // two. The previous split charged the *same* `totalHydrometeors * 0.5` to both fallout
        // and evaporated when a cell left the domain, which inflated the accounted total and made
        // the conservation diagnostic under-report real drift; a cell that retired in bounds was
        // charged 100% to evaporation even though most of that water was already falling out as
        // rain, snow and graupel. Using the suspended (cloud/ice) mass for evaporation and the
        // precipitating mass for fallout keeps both the totals and the physics honest, and the
        // clamp reproduces the old total if the two fields ever disagree.
        const suspendedGKg = cell.cloudWaterGKg + cell.supercooledWaterGKg + cell.cloudIceGKg;
        const precipitatingGKg = Math.max(0, totalHydrometeors - suspendedGKg);
        this.retiredCondensedGKg += cell.cumCondensedGKg;
        this.retiredFalloutGKg += cell.cumFalloutGKg + precipitatingGKg;
        this.retiredEvaporatedGKg += cell.cumEvaporatedGKg + suspendedGKg;
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
    const solar = effectiveSolarInsolation(cfg);

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
      // Tested against the LOCAL environment: the same gust front can trigger new deep convection
      // where it runs into a moist, weakly capped boundary layer and fizzle completely a few km
      // away where outflow has already stabilised the air. That spatial selectivity is the whole
      // point of resolving the mesoscale field.
      const localFront = this.env
        ? this.env.localInstability(candX, candZ, this.baseSnapshot(sounding, cfg))
        : null;
      const frontCin = localFront ? localFront.cin : inst.cin;
      const frontRh = localFront ? localFront.relHumidity : rh0;
      const gustKineticEnergy = 0.5 * Math.pow(p1.expansionSpeedMS * (1.0 + collisionBoost * 0.5), 2);
      if (
        gustKineticEnergy + 28.0 * solar > frontCin * 0.75 &&
        frontRh > 38 &&
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
    if (rh0 < 29 || inst.lcl > 4100 || solar < 0.15) {
      // Too dry or no surface heating -> clear sky persists naturally!
      return;
    }

    const thermalEnergyJPerKg =
      38.0 * solar * this.boundaryLayerThermalEnergy +
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

      // Local environment at this candidate site. Where the mesoscale field has been cooled and
      // soaked by earlier rainfall the local CIN is higher and the local RH different, so the
      // trigger probability genuinely varies across the domain instead of being uniform.
      const local = this.env
        ? this.env.localInstability(candX, candZ, this.baseSnapshot(sounding, cfg))
        : null;
      const localCin = local ? local.cin : inst.cin;
      const localRh = local ? local.relHumidity : rh0;
      const localCape = local ? local.cape : inst.cape;
      // A cold, rain-soaked patch is stabilised: suppress nucleation there explicitly so storms do
      // not regenerate on top of their own outflow indefinitely.
      const localPenalty = local
        ? 1.0 / (1.0 + Math.max(0, -this.env!.sampleAt(candX, candZ).thetaPert) * 0.22)
        : 1.0;

      if (thermalSpot + orographicBonus > 0.03 && !this.isNearExistingUpdraft(candX, candZ, 3900)) {
        const prob =
          0.11 *
          solar *
          Math.min(1.5, this.boundaryLayerThermalEnergy) *
          (localRh / 62.0) *
          localPenalty *
          (1.0 + Math.min(0.6, localCape / 4200.0)) *
          checkDt;
        // The CIN gate also has to be local, otherwise a site inside a stabilised outflow could
        // still pass using the domain-average cap.
        if (this.rand() < prob && thermalEnergyJPerKg > localCin * 0.5) {
          const initialRadius = 700 + this.rand() * 440;
          const initialW = 2.2 + solar * 1.5;
          this.spawnNucleatingThermal(candX, candZ, sounding, initialRadius, initialW);
          break;
        }
      }
    }
  }

  /**
   * Chooses a structural archetype for a newly nucleated cell.
   *
   * The draw is weighted by the environment rather than uniform, because morphology is not
   * arbitrary: a deep moist sheared profile supports narrow towering Cb, a weakly capped
   * shallow-CAPE environment can only make Cu humilis, and low CAPE with weak shear produces
   * stratiform decks. This is what lets the domain show several distinct cloud structures at
   * once instead of a field of identical towers.
   */
  /**
   * Re-examines the archetype once a cell has proven itself.
   *
   * The morphology is drawn at nucleation, when nothing is known about the cell except the
   * environment it was born into. A draw of 'stratiform' caps the cloud top at 0.44·EL — about
   * 5.8 km on a 13.2 km sounding — so a cell that a minute later has a 30 m/s updraft and
   * 9 km of depth is still being held down by a coin flip made at 200 m. That is what made
   * every strong tower in the domain collapse back to 1 km within two minutes.
   *
   * A cell that is deep, fast and long-lived is a convective tower whatever it started as; the
   * archetype is therefore promoted (never demoted mid-life, which would look like the storm
   * forgetting what it was).
   */
  private promoteMorphology(cell: ConvectiveCell): void {
    if (cell.morphology === 'tower') return;
    const deep = cell.cloudTopM - cell.cloudBaseM > 5200;
    const strong = cell.updraftMaxMS > 14;
    if (deep && strong) cell.morphology = 'tower';
    else if (cell.morphology === 'stratiform' && cell.updraftMaxMS > 7 && cell.cloudTopM - cell.cloudBaseM > 2600) {
      cell.morphology = 'multicell';
    }
  }

  private pickMorphology(inst: {
    cape: number;
    bulkShear06km: number;
    lcl: number;
    el: number;
  }): CloudMorphology {
    const r = this.rand();
    const depthKm = Math.max(0.5, (inst.el - inst.lcl) / 1000);
    // Deep profiles favour towers; shear lets a tower stay narrow instead of ventilating apart.
    const towerWeight = Math.min(
      0.44,
      0.1 + (depthKm / 12) * 0.3 + Math.min(0.12, inst.bulkShear06km / 320)
    );
    const shallowWeight = inst.cape < 900 ? 0.3 : 0.14;
    const stratiformWeight = inst.cape < 700 && inst.bulkShear06km < 14 ? 0.26 : 0.1;
    if (r < towerWeight) return 'tower';
    if (r < towerWeight + shallowWeight) return 'shallow';
    if (r < towerWeight + shallowWeight + stratiformWeight) return 'stratiform';
    return 'multicell';
  }

  /**
   * Per-archetype multipliers on the radius, cloud-top, anvil and entrainment growth laws, in
   * one table so the four regimes are directly comparable and tunable in one place.
   */
  public static readonly MORPH_FACTORS: Record<
    CloudMorphology,
    { radius: number; top: number; anvil: number; entrain: number }
  > = {
    // Narrow and tall: a strong single core that punches to the EL and spreads a wide anvil.
    tower: { radius: 0.72, top: 1.16, anvil: 1.45, entrain: 0.82 },
    // Broad cluster: several merged cores, moderate depth, little organised anvil.
    multicell: { radius: 1.38, top: 0.96, anvil: 0.72, entrain: 1.05 },
    // Capped shallow cumulus: tops out low, small core, essentially no anvil.
    shallow: { radius: 0.62, top: 0.58, anvil: 0.05, entrain: 1.28 },
    // Stratiform deck: very wide, low, sheet-like, no anvil.
    stratiform: { radius: 1.95, top: 0.44, anvil: 0.02, entrain: 1.42 },
  };

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

    const lcl = Math.max(200, sounding.instability.lcl);
    // A cell object represents *cloud*, so it is born at the lifting condensation level: the
    // dry-rise stage below it belongs to the boundary-layer thermals (the mesoscale thermal
    // energy field), not to a cloud with sub-LCL condensate. Spawning the tower partway up the
    // sub-cloud layer used to put a visible cloud base 200-800 m above ground on a day whose
    // LCL was at 1 km, which is physically impossible and showed up on every radar cross-section.
    const startTop = lcl + 40;

    this.cells.push({
      id,
      numericId: num,
      x,
      z,
      vx: lowU,
      vz: lowW,
      ageSec: 0,
      stage: 'nucleating',
      // Deterministic: drawn from this.rand() so a fixed seed always produces the same mix of
      // archetypes and the run stays reproducible.
      morphology: this.pickMorphology(sounding.instability),
      radiusM,
      cloudBaseM: lcl,
      cloudTopM: startTop,
      anvilRadiusM: 0,
      anvilAxisX: dx / dMag,
      anvilAxisZ: dz / dMag,
      overshootingTopM: 0,
      plumeProfile: null,
      plumeRadiusM: 0,
      plumeInflowMS: 0,
      plumeAgeSec: 0,
      baseInflowMS: 2.0,
      updraftMaxMS: initUpdraftMS,
      downdraftMaxMS: 0,
      buoyancyAccel: 0.02,
      entrainmentRate: 0.6,
      mesocycloneVorticity: 0,
      ambientVorticityS: this.environmentAmbientVorticityS,
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
      morphology: parent.morphology,
      anvilRadiusM: parent.anvilRadiusM * 0.7,
      updraftMaxMS: parent.updraftMaxMS * 0.84,
      mesocycloneVorticity: -Math.abs(parent.mesocycloneVorticity) * 0.75, // Anticyclonic left-mover!
      ambientVorticityS: parent.ambientVorticityS,
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
    dt: number,
    sounding: AtmosphericSounding
  ): void {
    const poolCenterX = cell.x + cell.precipCoreOffsetX;
    const poolCenterZ = cell.z + cell.precipCoreOffsetZ;

    // ---- Cold-pool strength from the sounding, not from a fixed coefficient ---------------
    // The cold pool is air cooled by evaporation at roughly constant pressure, so its
    // temperature deficit in kelvin is also its potential-temperature deficit, and its
    // buoyancy is  B = −g·Δθ/θ_env.  What a gravity current does with that is
    //        c = 0.78·√(−B·H)   (Benjamin 1968),
    // so the environmental potential temperature is a real physical input: the same 6 K of
    // evaporative cooling makes a far more violent outflow at a warm surface than a cold one.
    //
    // The old form was `1.35·ΔT + 0.012·rain` clamped to a flat 12 K, with no environment in it
    // at all — every pool converged to the same strength regardless of the surface state.
    //
    // The *ceiling* is physical too: evaporation stops when the sub-cloud air saturates, so the
    // deficit cannot exceed the surface wet-bulb depression, Δθ_max ≈ θ_env − θ_w. The sounding
    // does not expose θ_w directly, but the depression is bounded by the surface relative
    // humidity, which is available.
    const surfaceRh = Math.max(0.05, Math.min(1.0, sounding.relativeHumidityAt(60)));
    // A standard psychrometric relation: each 10 % of RH below saturation buys ~0.6 K of
    // evaporative cooling in a well-mixed sub-cloud layer at these temperatures.
    const wetBulbDepressionK = (1.0 - surfaceRh) * 6.0 + 0.6;
    const subCloudDepth = Math.max(300, cell.cloudBaseM);
    const rainCoolingK = clamp(cell.surfaceRainRateMMHr * 0.012 * (subCloudDepth / 1000.0), 0, 6.0);
    const targetDeficitK = clamp(
      downdraftTempDeficitK * 1.35 + rainCoolingK,
      0.6,
      Math.max(1.2, Math.min(12.0, wetBulbDepressionK))
    );
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

  /**
   * The domain-scale surface state the mesoscale field perturbs. Pulled from the sounding's lowest
   * level so the local derivation starts from the actual profile rather than from the config
   * scalars, which the sounding may have adjusted.
   */
  private baseSnapshot(sounding: AtmosphericSounding, cfg: AtmosphereConfig) {
    const sfc = sounding.levels[0];
    const inst = sounding.instability;
    return {
      cape: inst.cape,
      cin: inst.cin,
      lcl: inst.lcl,
      el: inst.el,
      surfaceTempK: sfc ? sfc.tempK : cfg.surfaceTempC + 273.15,
      surfaceDewpointK: sfc ? sfc.dewpointK : cfg.surfaceTempC + 269.15,
      surfaceQvGKg: sfc ? sfc.qvEnv * 1000.0 : 14.0,
      pressureHPa: cfg.surfacePressureHPa,
      windU: sfc ? sfc.windU : sounding.windUAt(10),
      windW: sfc ? sfc.windW : sounding.windWAt(10),
    };
  }

  private isNearExistingUpdraft(x: number, z: number, minDistM: number): boolean {
    for (const c of this.cells) {
      if (Math.hypot(c.x - x, c.z - z) < minDistM) return true;
    }
    return false;
  }

  /**
   * Rebuilds the cell's 1-D entraining-plume profile, reusing the cached one while nothing that
   * sets it has changed. The profile is a function of the environmental sounding, the cell's
   * core radius, the inflow kinetic energy and the source thermodynamics, all of which evolve
   * on minute timescales — rebuilding it every 2.5 s sub-step for a dozen cells is measurable but
   * not free, so the cache keys on the radius and the inflow instead of the wall clock.
   */
  private refreshPlume(
    cell: ConvectiveCell,
    sounding: AtmosphericSounding,
    inst: { lcl: number; lfc: number },
    solar: number,
    condensateEfficiency: number,
    entrainFactor: number
  ): void {
    cell.plumeAgeSec += 1;
    const stale =
      !cell.plumeProfile ||
      Math.abs(cell.plumeRadiusM - cell.radiusM) > Math.max(60, cell.radiusM * 0.08) ||
      Math.abs(cell.plumeInflowMS - cell.baseInflowMS) > 0.8 ||
      cell.plumeAgeSec > 40;
    if (!stale) return;
    cell.plumeAgeSec = 0;
    cell.plumeRadiusM = cell.radiusM;
    cell.plumeInflowMS = cell.baseInflowMS;

    // Localize the source: a cell sitting in rain-cooled outflow has a colder, moister mixed
    // layer than one over sunlit ground, and that shows up directly in its plume.
    let theta0 = sounding.mlThetaK;
    let qv0 = sounding.mlQvGKg;
    if (this.env) {
      const local = this.env.sampleAt(cell.x, cell.z);
      theta0 += local.thetaPert * 0.55;
      qv0 += local.qvPert * 0.75;
    }
    // Solar heating lowers the effective source temperature the plume must beat.
    const excess = 0.35 * Math.max(0.3, solar) * (1.0 + 0.25 * condensateEfficiency);
    cell.plumeProfile = buildPlumeProfile(
      sounding,
      {
        theta0,
        qv0GKg: Math.max(1, qv0),
        radiusM: Math.max(240, cell.radiusM / Math.max(0.5, entrainFactor)),
        thermalExcessK: excess,
      },
      cell.baseInflowMS
    );
    void inst;
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
    // A cell whose top has collapsed back to its base has no cloud left: it is rained out or
    // undercut by its own outflow. Leaving it classified as cumulus_humilis while it still has
    // a 20 m/s "updraft" reported produced 24-minute-old humilis cells, which is not a thing.
    if (cell.ageSec > 240 && depth < 320 && cell.surfaceRainRateMMHr > 0.5) {
      return 'dissipating';
    }
    // Short-lived cumulus: a tower that has not reached at least 2.5 km within 11 minutes is a
    // failed thermal. Real shallow cumulus lives 5-15 minutes; letting it persist indefinitely
    // because its plume still resolves 9 km is not a storm, it is a stuck state.
    if (cell.ageSec > 660 && cell.cloudTopM < lcl + 2500) {
      return 'dissipating';
    }
    // Hard lifetime cap for non-rotating cloud. A single cell that is not a supercell is
    // consumed by its own outflow within roughly half an hour.
    if (cell.ageSec > 2100 && Math.abs(cell.mesocycloneVorticity) < this.vorticityScale * 0.9) {
      return 'dissipating';
    }
    // A supercell is a *persistent* rotating storm, and the environment has to be able to
    // support one. Two independent conditions, because the vorticity alone is not sufficient:
    //
    //  * the mesocyclone must be at 0.55x the environment's own vortex scale, and
    //  * the environment must be genuinely sheared — 0-3 km SRH of at least 100 m²/s² and
    //    at least 15 m/s of 0-6 km shear. A 5.5 m/s shear sounding has SRH ~8 and cannot
    //    produce a rotating updraft no matter what a single cell's vorticity number reads;
    //    without this gate `pulse_summer` classified as a "Supercell Thunderstorm" the moment
    //    one of its pulse storms happened to inherit a vortex.
    const rotationalEnvironment =
      this.environmentSRH03 >= 100 && this.environmentShear06 >= 15.0;
    if (
      rotationalEnvironment &&
      Math.abs(cell.mesocycloneVorticity) > this.vorticityScale * 0.55 &&
      cell.cloudTopM > freezeZ + 2200 &&
      cell.ageSec > 420
    ) {
      return 'supercell';
    }
    // A cell is mature when it has reached its equilibrium level *and* is actually precipitating
    // from a deep column. Height alone is not enough: a vigorously growing tower that has just
    // passed the freezing level is still a calvus, and a shallow cloud with a strong updraft is
    // still humilis. Depth is what separates them.
    const deepEnough = depth > 4200;
    if (deepEnough && (cell.anvilRadiusM > cell.radiusM * 1.35 || cell.cloudTopM > el * 0.78)) {
      return 'mature';
    }
    if (cell.cloudTopM > freezeZ + 900 && depth > 2600 && (cell.cloudIceGKg + cell.graupelGKg) > 0.06) {
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
