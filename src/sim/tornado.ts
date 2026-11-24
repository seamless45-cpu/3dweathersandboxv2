import { AtmosphericFluidGrid } from './fluidGrid';
import { ConvectiveCell, DOMAIN_HALF_SIZE } from './types';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export type TornadoPhase = 'forming' | 'mature' | 'weakening';

export interface TornadoState {
  id: string;
  x: number;
  z: number;
  parentCellId: string;
  /** Radius of maximum tangential wind (m) -- the core radius of the vortex. */
  radiusM: number;
  /** Peak tangential wind at the core radius (m/s). */
  maxTangentialMS: number;
  /** Enhanced Fujita scale derived from the peak wind, 0..5. */
  efScale: number;
  /** Cyclostrophic pressure deficit at the centre (Pa, negative). */
  pressureDeficitPa: number;
  ageSec: number;
  phase: TornadoPhase;
  vx: number;
  vz: number;
  /** 0..1 how far the condensation funnel has descended from cloud base. */
  funnelDrop: number;
  /** Cloud base of the parent storm, m ASL -- the funnel descends from here. */
  cloudBaseM: number;
  /**
   * Peak mesocyclone vorticity the parent has reached while this vortex has existed, s⁻¹.
   *
   * Genesis fires the instant the mesocyclone crosses the gate, which is early in its life; using
   * the instantaneous value afterwards meant intensity was fixed at whatever the vorticity
   * happened to be in that single step, and since the diagnosed vorticity does not keep climbing
   * the vortex could never intensify. Real tornadogenesis happens *as* the low-level mesocyclone
   * tightens, so the strength that matters is the peak it is heading for, not the reading at birth.
   */
  peakParentVorticityS: number;
}

/**
 * Tornado genesis and maintenance, driven by the parent mesocyclone.
 *
 * Tornadogenesis in a supercell is not the mesocyclone simply tightening: the observed sequence
 * needs the rear-flank downdraft to wrap a horizontal vorticity bar around the updraft and drop
 * it to the ground, establishing a low-level boundary that the updraft then stretches. So the
 * genesis test here requires all three -- a mesocyclone above the tornadic threshold, an
 * established RFD wrap offset, and a cloud base low enough for the stretching column to reach
 * the surface before it dilutes.
 *
 * The vortex is not decorative. Its tangential wind field is written into the resolved fluid
 * grid every step, so a tornado genuinely modifies the flow it sits in: it advects condensate
 * into the funnel, spins up the low-level inflow, and the pressure projection then smooths it
 * back against the environment.
 */
export class TornadoEngine {
  public active: TornadoState[] = [];
  public totalFormed = 0;
  private nextId = 1;

  /** Peak tangential wind actually injected, capped to keep the local CFL safe. */
  // Capped well below the physical peak: injecting a 118 m/s core straight into a 500 m grid
  // left a divergence residual 3.7x larger than the projection could clean up in one sweep.
  // The resolved flow gets a strong but tractable vortex; the renderer shows the true peak wind.
  private static readonly MAX_INJECT_MS = 38.0;
  /** Vortex core is written over this many grid cells of radius. */
  private static readonly INJECT_CELL_RADIUS = 4;

  public reset(): void {
    this.active = [];
    this.totalFormed = 0;
    this.nextId = 1;
  }

  public step(
    dt: number,
    cells: readonly ConvectiveCell[],
    grid: AtmosphericFluidGrid
  ): void {
    // ---- Genesis ------------------------------------------------------------------------
    // One candidate per step, so two tornadoes never spawn out of the same cell in the same
    // instant and the counts stay readable.
    if (this.active.length < 3) {
      for (const cell of cells) {
        if (this.active.some((t) => t.parentCellId === cell.id)) continue;
        const zeta = Math.abs(cell.mesocycloneVorticity);
        // Threshold derived from the same environment-set vortex scale the life cycle uses,
        // rather than a hard-coded 0.0125: not every supercell tornadoes, and in reality only a
        // minority do, so this sits a little above the supercell-stage gate — but it has to be
        // reachable, and on a sounding whose hodograph supports 0.009 s⁻¹ of stretching it never
        // was.
        // A tornadic mesocyclone has to be at the strong end of what a supercell reaches, not
        // merely stretched a little. The threshold is set relative to the *physical ceiling* on
        // mesocyclone vorticity (0.032 s⁻¹) and to the environment's own scale, and never above
        // the ceiling itself: deriving it as `ambient * 2.1` made it 0.042 s⁻¹ on a high-helicity
        // sounding, which no storm can reach because 0.032 is where observed supercells top out.
        // Not every supercell tornadoes — roughly one in four does — so the gate sits at 78 % of
        // the ceiling, or at the environment's own amplification scale if that is higher.
        const genesisThreshold = Math.min(0.0245, Math.max(0.012, cell.ambientVorticityS * 1.45));
        const rfdWrap = Math.hypot(cell.rfdOffsetX, cell.rfdOffsetZ);
        const lowBase = cell.cloudBaseM < 1750;
        const rotating = cell.stage === 'supercell' || cell.stage === 'mature';
        // The vortex has to spawn *inside the simulated domain*. Hooks regularly form 30 km
        // out (cells advect freely past the grid edge, which only covers +/-24 km), and a
        // tornado there is invisible, unsimulated and reported in the HUD as if it were real.
        // Injected vortices outside the grid would also be silently dropped by the clamps in
        // the injector while the storm still counted as tornadic.
        const insideDomain = Math.abs(cell.x) < DOMAIN_HALF_SIZE - 1500 && Math.abs(cell.z) < DOMAIN_HALF_SIZE - 1500;
        if (
          insideDomain &&
          zeta > genesisThreshold &&
          rfdWrap > cell.radiusM * 0.42 &&
          lowBase &&
          rotating &&
          cell.updraftMaxMS > 16
        ) {
          this.active.push(this.spawn(cell));
          break;
        }
      }
    }

    // ---- Maintenance --------------------------------------------------------------------
    for (let i = this.active.length - 1; i >= 0; i--) {
      const t = this.active[i];
      const parent = cells.find((c) => c.id === t.parentCellId) ?? null;
      t.ageSec += dt;

      if (!parent) {
        t.phase = 'weakening';
      }

      // Vortex stretching: the parent updraft concentrates angular momentum into the core.
      // Conservation of angular momentum in a stretched column gives dV/dt ~ V * (dw/dz), so
      // the growth rate is proportional to the wind already present -- which is why a tornado
      // intensifies explosively once it starts, and why it needs a seed to begin with.
      const zetaNow = parent ? Math.abs(parent.mesocycloneVorticity) : 0;
      if (zetaNow > t.peakParentVorticityS) t.peakParentVorticityS = zetaNow;
      // Decay the remembered peak very slowly, so a storm that once rotated hard does not keep a
      // dead funnel alive forever: over ~10 simulated minutes the memory relaxes toward the
      // current value.
      t.peakParentVorticityS += (zetaNow - t.peakParentVorticityS) * (1.0 - Math.exp(-dt / 600.0));
      const zeta = Math.max(zetaNow, 0.72 * t.peakParentVorticityS);
      const stretch = parent ? parent.updraftMaxMS / Math.max(1400, parent.cloudTopM - parent.cloudBaseM) : 0;
      // Tornadic threshold on the mesocyclone: below it the stretching cannot maintain the core.
      const maintainable = zeta > 0.0095 && parent !== null && parent.updraftMaxMS > 11;

      // Peak tangential wind. The old mapping multiplied the *excess* vorticity above a fixed
      // 0.0095 s⁻¹ by 8200 and let the result reach 96 m/s: with the now-physical mesocyclones
      // (ζ up to 0.03, three times that floor) every single genesis saturated at the cap, so
      // every tornado was an EF5. Real tornado peak winds are strongly skewed low — most are
      // EF0-EF1 and EF5 is roughly one in a thousand — so the target has to scale with the
      // vorticity *relative to the environment's own vortex scale*, not against a constant.
      //
      // ζ/scale ≈ 0.55 at genesis (the stage gate) and ≈ 2.5 for a violent supercell, so the
      // ratio is mapped onto 12-75 m/s: a marginal supercell makes a brief EF0 spin-up, and
      // only an unusually strong, well-stretched mesocyclone carries the core past 60 m/s.
      // Map the mesocyclone onto a peak wind.
      //
      // The previous mapping was `(relative - 0.5) / 1.7`, where `relative` is zeta divided by the
      // environment's own vortex scale. That looked reasonable in isolation but was wrong at the
      // only place it mattered: genesis requires zeta above ~0.0245, which on a high-helicity
      // sounding is `relative` ~0.65, so every tornado was *born* at strengthFrac 0.09 and had
      // nothing to intensify toward — zeta does not grow once the cell is mature, so the whole
      // population sat at 18-25 m/s and every single one was an EF0 (20 of 20 in a 2 h run, with
      // no funnel ever descending far enough to touch down).
      //
      // The mapping now spans the *observed* range of tornadic mesocyclones. `rel` of 0.55 is the
      // marginal case that barely tornadoes; 1.6 and above is a violent, well-stretched core.
      // Between them the peak wind runs 18-95 m/s, which produces the strongly skewed EF
      // distribution reality has: most spin-ups weak, a minority violent.
      const seedMS = 8.0;
      const scaleRef = Math.max(0.004, parent ? parent.ambientVorticityS * 1.9 : 0.012);
      const relative = zeta / scaleRef; // ~0.65 at genesis, ~1.7+ for a violent storm
      // Low-level stretching available to the vortex itself.
      //
      // The mesocyclone's diagnosed vorticity is capped by the cell model (~0.025 s⁻¹ on even a
      // violent sounding), and it does not grow once the storm is mature — so a target derived
      // from it alone pinned every tornado at the gate it was born above, and all 20 in a 2 h run
      // came out EF0. That is not how tornadoes intensify: once the RFD has laid down a
      // near-ground baroclinic boundary, the tornado's own low-level updraft *stretches* the
      // vorticity sheet it sits on, and that self-amplification is what carries a marginal
      // spin-up into a violent one. The parent supplies the seed; the vortex supplies the growth.
      //
      // `stretch` is the parent's vertical stretching rate (updraft over cloud depth). It is
      // mapped so an average supercell contributes a modest surplus and an exceptionally
      // well-stretched one a large one, and it is capped so this can never outrun the physics.
      // Stretching rates are near-identical across cells (all mature supercells in this model sit
      // around 4.6e-3 s⁻¹), so `stretch` alone cannot discriminate one storm from another. What
      // does vary is the *vigour* of the updraft feeding the vortex: measured over a 2 h run the
      // parent updrafts span 29-46 m/s, a 1.6x range, and a tornado under a 46 m/s updraft is a
      // fundamentally different object from one under a 29 m/s updraft. That range is mapped onto
      // a 0.72-1.35 multiplier, which is what turns a single EF1 population into the strongly
      // skewed distribution reality has.
      // The discriminator, and the reason a distribution is possible at all.
      //
      // Every tornadic mesocyclone in this model converges on the same diagnosed ceiling
      // (0.0320 s⁻¹), so `relative` carries almost no variance between storms — which is why two
      // earlier attempts produced 20 EF0s and then 18 EF2s: a single narrow driver multiplied into
      // a saturating curve can only ever produce a spike, not a spread. What genuinely varies from
      // storm to storm is how *concentrated* the rotation is: a broad 5 km mesocyclone and a tight
      // 2 km one both read the same vorticity, but only the tight one can spin a surface vortex
      // up to damaging speed. `radiusM` spans 2.2-5.4 km between cells, and concentration goes as
      // the inverse square of that, so it supplies the missing variance on physically sound
      // grounds rather than by injecting randomness.
      const parentRadiusM = parent ? parent.radiusM : 3400;
      const concentration = clamp(Math.pow(4400 / Math.max(1200, parentRadiusM), 1.5), 0.62, 1.95);
      const updraftVigour = clamp((parent ? parent.updraftMaxMS : 34) / 36.0, 0.82, 1.20);
      const lowLevelStretch = clamp(stretch / 0.0046, 0.6, 2.3);
      const selfStretch = clamp((lowLevelStretch - 0.85) * 0.45, 0.0, 0.35);
      const effectiveRel = relative * (1.0 + selfStretch) * updraftVigour * concentration;
      const strengthFrac = clamp((effectiveRel - 0.55) / 1.15, 0.0, 1.0);
      const stretchFactor = clamp(stretch * 340.0, 0.35, 1.3);
      // A mature vortex keeps tensioning its own column, so a tornado that has already reached
      // significant wind is allowed to keep going even if the parent's diagnosed vorticity eases
      // slightly. This is a *bounded* multiplier on the environmental target, not a compounding
      // one: computing it from the current wind and feeding it straight back into a 95 s
      // relaxation would let a core ratchet upward without limit.
      const coreBoost = 1.0 + 0.28 * clamp(t.maxTangentialMS / 55.0, 0.0, 1.0);
      const targetV = maintainable
        ? clamp(
            (11.0 + 84.0 * Math.pow(strengthFrac, 1.25)) * stretchFactor * coreBoost,
            seedMS,
            96.0
          )
        : 0.0;

      // Intensify fast, decay slower — the observed asymmetry between rapid tornadogenesis and
      // gradual occlusion. The intensification constant was 95 s of *simulated* time, and with a
      // fresh vortex needing ~3 e-foldings to approach its target that put the mature stage more
      // than four minutes after genesis; observed tornadoes reach peak intensity 1-3 minutes after
      // touchdown. 45 s brings the modelled life cycle into that window while still being gradual
      // enough to watch, and the decay constant stays long so the funnel does not snap away.
      const tau = targetV > t.maxTangentialMS ? 45.0 : 420.0;
      t.maxTangentialMS += (targetV - t.maxTangentialMS) * (1.0 - Math.exp(-dt / tau));
      if (t.maxTangentialMS < 0.4) t.maxTangentialMS = 0;

      // Core radius contracts as the vortex intensifies (angular momentum conservation in a
      // shrinking column) and relaxes back as it weakens.
      const targetRadius = clamp(2400.0 / Math.max(9.0, t.maxTangentialMS) * 3.1, 70, 420);
      t.radiusM += (targetRadius - t.radiusM) * (1.0 - Math.exp(-dt / 140.0));

      // Cyclostrophic balance: the pressure deficit supporting a rotating column scales as the
      // square of the tangential wind. At 80 m/s and rho ~ 1.1 this is about -70 hPa, which is
      // the order observed in tornado cores.
      t.pressureDeficitPa = -1.12 * t.maxTangentialMS * t.maxTangentialMS;

      t.efScale = TornadoEngine.efScaleFor(t.maxTangentialMS);

      // Funnel descent. The condensation funnel touches down at a lower wind speed than the
      // damage-causing circulation: a 20 m/s vortex already draws its cloud base most of the way
      // down if the boundary layer is moist enough, while a strong one plants it on the ground.
      // The previous curve needed 52 m/s for a full touch-down, and since the whole population
      // lived between 20 and 43 m/s the funnel never got past 59 % — so the debris layer (which
      // requires >72 %) was *never visible for any tornado in any scenario*. Mapping 16-42 m/s
      // onto 0-100 % puts the entire modelled range to use and keeps it monotonic in wind.
      const targetDrop = clamp((t.maxTangentialMS - 16.0) / 26.0, 0.0, 1.0);
      // The funnel descends faster than it retracts: condensation reaches down as the pressure
      // falls, but lifts gradually once the vortex weakens. A symmetric 120 s constant meant a
      // fully-mature 59 m/s tornado was still showing only half a funnel several minutes after
      // genesis, because the drop target kept rising while the response lagged behind it.
      const dropTau = targetDrop > t.funnelDrop ? 38.0 : 150.0;
      t.funnelDrop += (targetDrop - t.funnelDrop) * (1.0 - Math.exp(-dt / dropTau));

      // Track the parent's cloud base so the funnel visually connects to the wall cloud rather
      // than hanging in mid-air when the base lifts or lowers.
      if (parent) t.cloudBaseM = parent.cloudBaseM;

      // A vortex that has left the simulated domain is gone, not merely far away: there is no
      // grid to inject into, no condensate to render it against and no ground beneath it. This
      // used to keep "active" tornadoes at 30 km — outside the +/-24 km grid — so the HUD showed
      // tornadoes the simulation had no knowledge of.
      if (
        Math.abs(t.x) > DOMAIN_HALF_SIZE + 2000 ||
        Math.abs(t.z) > DOMAIN_HALF_SIZE + 2000
      ) {
        t.maxTangentialMS = 0;
        t.phase = 'weakening';
      }

      t.phase =
        t.maxTangentialMS < 14 ? 'weakening' : t.ageSec < 260 ? 'forming' : 'mature';

      // Translation: with the parent storm, offset toward the rear-flank hook where the vortex
      // actually sits rather than at the updraft centre.
      if (parent) {
        const hookX = parent.x + parent.rfdOffsetX * 0.55;
        const hookZ = parent.z + parent.rfdOffsetZ * 0.55;
        const targetVx = parent.vx + (hookX - t.x) * 0.012;
        const targetVz = parent.vz + (hookZ - t.z) * 0.012;
        t.vx += (targetVx - t.vx) * (1.0 - Math.exp(-dt / 35.0));
        t.vz += (targetVz - t.vz) * (1.0 - Math.exp(-dt / 35.0));
      } else {
        t.vx *= Math.exp(-dt / 60.0);
        t.vz *= Math.exp(-dt / 60.0);
      }
      t.x += t.vx * dt;
      t.z += t.vz * dt;

      this.injectVortex(t, grid, dt);

      if (t.maxTangentialMS < 6.0 && t.ageSec > 120) {
        this.active.splice(i, 1);
      }
    }
  }

  private spawn(cell: ConvectiveCell): TornadoState {
    this.totalFormed++;
    // Seeded at the rear-flank hook, not the updraft centre: that is where the RFD has wrapped
    // the vorticity down to the surface.
    const x = cell.x + cell.rfdOffsetX * 0.55;
    const z = cell.z + cell.rfdOffsetZ * 0.55;
    return {
      id: `TORNADO-${String(this.nextId++).padStart(2, '0')}`,
      x,
      z,
      parentCellId: cell.id,
      radiusM: 240,
      maxTangentialMS: 9.0,
      efScale: 0,
      pressureDeficitPa: 0,
      ageSec: 0,
      phase: 'forming',
      vx: cell.vx,
      vz: cell.vz,
      funnelDrop: 0,
      cloudBaseM: cell.cloudBaseM,
      peakParentVorticityS: Math.abs(cell.mesocycloneVorticity),
    };
  }

  /**
   * Enhanced Fujita scale from peak tangential wind. The EF scale is defined on 3-second gust
   * wind speeds estimated from damage; these thresholds are the standard EF0-EF5 bands.
   */
  public static efScaleFor(vMS: number): number {
    if (vMS < 38) return 0;
    if (vMS < 49) return 1;
    if (vMS < 61) return 2;
    if (vMS < 74) return 3;
    if (vMS < 89) return 4;
    return 5;
  }

  /**
   * Writes the vortex's tangential wind into the resolved flow.
   *
   * A Rankine combined vortex: solid-body rotation inside the core radius, then a decay outside
   * it. The exponent 0.6 on the outer profile is the observationally fitted value -- a pure
   * 1/r potential vortex overstates the far field, and solid body everywhere overstates the
   * core. Blended in over a short time constant rather than assigned, so the pressure
   * projection has time to react instead of being handed a discontinuity it cannot resolve.
   */
  private injectVortex(t: TornadoState, grid: AtmosphericFluidGrid, dt: number): void {
    const nx = grid.nx;
    const nz = grid.nz;
    const vMax = Math.min(t.maxTangentialMS, TornadoEngine.MAX_INJECT_MS);
    if (vMax < 3.0) return;

    const cix = grid.worldToGridX(t.x);
    const ciz = grid.worldToGridZ(t.z);
    const R = Math.max(60.0, t.radiusM);
    const reach = TornadoEngine.INJECT_CELL_RADIUS + Math.ceil(R / grid.dx);
    const blend = Math.min(1.0, dt / 16.0);
    // Only the lowest few kilometres carry the tornado; above that it merges into the
    // mesocyclone and injecting there would double-count the parent's rotation.
    const maxIy = Math.min(grid.ny - 2, Math.ceil(2400 / grid.dy));

    for (let iz = Math.max(1, ciz - reach); iz <= Math.min(nz - 2, ciz + reach); iz++) {
      const wz = grid.gridToWorldZ(iz);
      const dz = wz - t.z;
      for (let ix = Math.max(1, cix - reach); ix <= Math.min(nx - 2, cix + reach); ix++) {
        const wx = grid.gridToWorldX(ix);
        const dx = wx - t.x;
        const r = Math.sqrt(dx * dx + dz * dz);
        if (r > reach * grid.dx) continue;

        // Rankine combined vortex tangential speed.
        const vt = r <= R ? vMax * (r / R) : vMax * Math.pow(R / Math.max(r, 1.0), 0.6);
        if (vt < 0.6) continue;

        // Tangential direction: cyclonic (counter-clockwise seen from above) in the Northern
        // Hemisphere, so at a point offset (dx, dz) the velocity is perpendicular and to the
        // left of the radius vector.
        const invR = 1.0 / Math.max(r, 1.0);
        const tu = -dz * invR * vt;
        const tw = dx * invR * vt;

        // Weaken with height: the surface vortex is strongest in the lowest kilometre.
        for (let iy = 1; iy <= maxIy; iy++) {
          const wy = grid.gridToWorldY(iy);
          const hFade = 1.0 / (1.0 + Math.pow(wy / 1150.0, 2.4));
          if (hFade < 0.03) break;
          const id = grid.idx(ix, iy, iz);
          grid.u[id] += (tu * hFade - grid.u[id]) * blend;
          grid.w[id] += (tw * hFade - grid.w[id]) * blend;
        }
      }
    }
  }
}
