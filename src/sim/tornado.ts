import { AtmosphericFluidGrid } from './fluidGrid';
import { ConvectiveCell } from './types';

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
        // Threshold sits above the supercell-stage value (0.011): not every supercell tornados,
        // and in reality only a minority do.
        const rfdWrap = Math.hypot(cell.rfdOffsetX, cell.rfdOffsetZ);
        const lowBase = cell.cloudBaseM < 1750;
        const rotating = cell.stage === 'supercell' || cell.stage === 'mature';
        if (zeta > 0.0125 && rfdWrap > cell.radiusM * 0.42 && lowBase && rotating && cell.updraftMaxMS > 16) {
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
      const zeta = parent ? Math.abs(parent.mesocycloneVorticity) : 0;
      const stretch = parent ? parent.updraftMaxMS / Math.max(1400, parent.cloudTopM - parent.cloudBaseM) : 0;
      // Tornadic threshold on the mesocyclone: below it the stretching cannot maintain the core.
      const maintainable = zeta > 0.0095 && parent !== null && parent.updraftMaxMS > 11;

      const seedMS = 8.0;
      const targetV = maintainable
        ? clamp(seedMS + (zeta - 0.0095) * 8200.0 * clamp(stretch * 340.0, 0.25, 1.6), seedMS, 96.0)
        : 0.0;

      // Intensify fast (minutes), decay slower (tens of minutes): matches the observed asymmetry
      // between rapid tornadogenesis and gradual occlusion.
      const tau = targetV > t.maxTangentialMS ? 95.0 : 420.0;
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

      // Funnel descends as the vortex strengthens, and retracts as it weakens.
      const targetDrop = clamp((t.maxTangentialMS - 12.0) / 52.0, 0.0, 1.0);
      t.funnelDrop += (targetDrop - t.funnelDrop) * (1.0 - Math.exp(-dt / 120.0));

      // Track the parent's cloud base so the funnel visually connects to the wall cloud rather
      // than hanging in mid-air when the base lifts or lowers.
      if (parent) t.cloudBaseM = parent.cloudBaseM;

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
