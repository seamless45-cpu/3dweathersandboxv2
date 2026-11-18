import { AtmosphericFluidGrid } from './fluidGrid';
import { getTerrainHeight } from './terrainField';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * A grounded lightning rod standing in the observer's meadow.
 *
 * It does three physically distinct things, and only the third is the dramatic one:
 *
 * 1. **Field enhancement.** A grounded conductor concentrates the ambient field at its tip by
 *    roughly h / (2 r_tip) for a slender mast. This is computed from the real geometry, so a
 *    taller or sharper rod genuinely produces a higher tip field.
 *
 * 2. **Corona point-discharge.** Once the enhanced tip field passes the corona onset threshold
 *    the air around it breaks down locally and the rod bleeds charge of the opposite sign to the
 *    overhead cloud into the atmosphere. This is continuous, it is always happening under a
 *    storm, and it measurably *lowers* the local field -- the dissipation that Franklin's rod
 *    was originally (and wrongly) thought to do entirely on its own. It also produces St Elmo's
 *    fire, which is what the renderer shows.
 *
 * 3. **Strike interception.** A descending leader that comes inside the rod's attractive radius
 *    is met by an upward connecting leader and terminates on the rod instead of the ground. The
 *    radius follows the electro-geometric model, with the extra reach a tall mast gets on flat
 *    open ground where it is the only grounded conductor for kilometres.
 */
export class LightningRod {
  public readonly x: number;
  public readonly z: number;
  public readonly groundY: number;
  public readonly heightM: number;
  public readonly tipY: number;
  /** Rod tip radius in metres; a sharper tip enhances the field more. */
  public readonly tipRadiusM: number;

  /** Strikes intercepted from a descending leader. */
  public interceptedStrikes = 0;
  /** Self-initiated upward leaders launched by corona onset, without an incoming strike. */
  public upwardLeaders = 0;
  /** 0..1 corona brightness, for the St Elmo's fire glow at the tip. */
  public coronaIntensity = 0;
  /** Ambient (unenhanced) field at the tip, kV/m. */
  public tipFieldKVm = 0;
  /** Field actually experienced at the tip after geometric enhancement, kV/m. */
  public enhancedTipFieldKVm = 0;
  /** 0..1 fraction of the local breakdown threshold reached at the tip. */
  public tipFieldRatio = 0;
  public lastInterceptSimSec = -1e9;
  public lastUpwardLeaderSimSec = -1e9;
  /** Cumulative charge bled to ground by corona, in coulombs. */
  public coronaChargeC = 0;

  private leaderCooldownSec = 0;

  constructor(x: number, z: number, heightM = 168, tipRadiusM = 0.035) {
    this.x = x;
    this.z = z;
    this.heightM = heightM;
    this.tipRadiusM = tipRadiusM;
    this.groundY = getTerrainHeight(x, z);
    this.tipY = this.groundY + heightM;
  }

  /**
   * Geometric field enhancement factor of a slender grounded mast. For a prolate spheroid the
   * factor tends to h/(2r) for h >> r; clamped because real tips round off and corona onset
   * limits the achievable enhancement long before the ideal value.
   */
  public get enhancementFactor(): number {
    // The ideal prolate-spheroid factor h/(2r) for this mast is ~2400, which is not usable:
    // once corona starts, the space charge it emits shields the tip and holds the local field
    // near onset no matter how hard the ambient field pushes. Capping at 120 stands in for that
    // self-limiting behaviour while still making a tall sharp rod dramatically more effective
    // than flat ground.
    return clamp(this.heightM / (2.0 * Math.max(0.005, this.tipRadiusM)), 1.0, 120.0);
  }

  /**
   * Corona onset field at the tip, kV/m. Peek's law for a coaxial geometry, scaled to the local
   * air density so the rod fires more readily at altitude.
   */
  public coronaOnsetKVm(densityKgM3: number): number {
    const relDensity = clamp(densityKgM3 / 1.225, 0.2, 1.3);
    const irregularity = 0.72;
    return 30.0 * irregularity * relDensity * (1.0 + 0.62 / Math.sqrt(Math.max(0.01, this.tipRadiusM * 100)));
  }

  /**
   * Attractive radius for a descending leader with the given peak current, in metres.
   *
   * The textbook electro-geometric model gives Ds = 8 I^0.65 for the striking distance to flat
   * ground, and a rod of height h then intercepts anything landing within sqrt(h(2Ds - h)).
   * Applied to this mast that number is not merely small, it is *imaginary*: Ds for a 30 kA
   * stroke is ~74 m, less than the 168 m mast height, so the sqrt argument goes negative. The
   * EGM as written is a flat-ground model and simply does not cover a structure taller than the
   * striking distance -- which is exactly the regime real masts live in.
   *
   * What governs attachment instead is competition. On this terrain the relief is a few tens of
   * metres, so a 168 m grounded mast is by far the most elevated conductor around, and its
   * corona space charge adds a local field maximum on top. Measured attractive radii for tall
   * towers run about 1.5-3 times the structure height, so the radius below sits in that band
   * rather than at the far larger value a naive reading of the EGM would suggest. It widens with
   * how hard the ambient field is driving the upward leader.
   *
   * The practical consequence, and the honest one: the rod does not vacuum up distant strokes.
   * A ground-directed discharge is only captured when a cell has moved close enough overhead
   * that its attachment point lands in the mast's neighbourhood -- within roughly +-1.1 km,
   * which is the spread the engine uses when choosing a ground target under a cell. That is the
   * real protection zone of a lightning rod.
   */
  public captureRadiusFor(peakCurrentKA: number): number {
    const ds = 8.0 * Math.pow(Math.max(1.0, peakCurrentKA), 0.65);
    // Flat-ground EGM term, kept for completeness; it is zero whenever Ds < h.
    const egm = Math.sqrt(Math.max(0.0, this.heightM * (2.0 * ds - this.heightM)));
    const dominance = this.heightM * (1.9 + 1.3 * clamp(this.tipFieldRatio, 0.0, 1.0));
    return Math.max(egm, dominance);
  }

  /**
   * How far this rod's upward connecting leader can reach, in metres. Used for the 3D
   * interception test during the leader march: a descending channel that passes within this
   * distance of the tip is met by the upward leader regardless of where its ground target was.
   */
  public connectingLeaderReachM(): number {
    return this.heightM * (0.8 + 1.5 * clamp(this.tipFieldRatio, 0.0, 1.0));
  }

  /**
   * Steers a ground-directed attachment point toward the rod.
   *
   * Returns the adjusted target. The pull is partial and falls off with distance, so a stroke
   * that would have landed well outside the neighbourhood is barely deflected while one inside
   * it is captured outright. This models the leader tip being guided by the field gradient the
   * mast and its corona create, rather than the mast reaching out arbitrarily far.
   */
  public steerGroundTarget(targetX: number, targetZ: number, peakCurrentKA: number): {
    x: number;
    z: number;
    captured: boolean;
  } {
    const dx = this.x - targetX;
    const dz = this.z - targetZ;
    const dist = Math.hypot(dx, dz);
    const radius = this.captureRadiusFor(peakCurrentKA);
    if (dist > radius || dist < 1e-6) {
      return { x: targetX, z: targetZ, captured: false };
    }

    // Two tiers, matching the textbook meaning of attractive radius:
    //  - inside ~55% of it, the mast wins the attachment outright and the leader is re-aimed at
    //    the tip. This is the classic EGM result: within the attractive radius the structure is
    //    struck.
    //  - between that and the full radius, the leader is bent toward the mast but still commits
    //    to its own ground point. It can nonetheless be met in three dimensions by the upward
    //    connecting leader, which is the separate test run during the march.
    const t = 1.0 - dist / radius;
    const pull = clamp(Math.pow(t, 0.7) * 0.94, 0.0, 1.0);
    return {
      x: targetX + dx * pull,
      z: targetZ + dz * pull,
      captured: dist <= radius * 0.55,
    };
  }

  /** Records an interception of a ground-directed discharge. */
  public captureStrike(): void {
    this.interceptedStrikes++;
  }

  /** Records the simulation time of the most recent interception, for the HUD. */
  public markIntercept(simTimeSec: number): void {
    this.lastInterceptSimSec = simTimeSec;
  }

  /**
   * Samples the field at the tip, runs the corona point-discharge, and launches self-initiated
   * upward leaders when the enhanced tip field exceeds onset.
   *
   * The corona term bleeds charge out of the voxels around the tip, which lowers the local field
   * -- the rod genuinely modifies the electrification it sits in rather than being a passive
   * ornament that only matters when something happens to hit it.
   */
  public step(
    grid: AtmosphericFluidGrid,
    densityKgM3: number,
    breakdownKVm: number,
    dt: number,
    simTimeSec: number
  ): void {
    const ix = grid.worldToGridX(this.x);
    const iz = grid.worldToGridZ(this.z);
    // The tip of a 168 m mast sits at ~180 m, which is grid level 0 -- and level 0 is never
    // written by the field scan, which starts at iy = 1. Reading it raw returned a permanent
    // zero, so the rod did nothing at all. Sample the lowest populated level instead and
    // extrapolate down to the actual tip height.
    const iy = clamp(grid.worldToGridY(this.tipY), 1, grid.ny - 2);

    if (ix < 1 || ix > grid.nx - 2 || iz < 1 || iz > grid.nz - 2) {
      this.coronaIntensity *= Math.exp(-dt * 2.0);
      return;
    }

    const id = grid.idx(ix, iy, iz);
    const ex = grid.ex[id];
    const ey = grid.ey[id];
    const ez = grid.ez[id];
    // Below the charge centres the field grows roughly with height, so the value at the first
    // grid level overstates what the tip actually sees. Scale by the height ratio.
    const sampleY = Math.max(1.0, grid.gridToWorldY(iy));
    const heightScale = clamp(this.tipY / sampleY, 0.05, 1.0);
    const ambient = Math.sqrt(ex * ex + ey * ey + ez * ez) * heightScale;

    this.tipFieldKVm = ambient;
    this.enhancedTipFieldKVm = ambient * this.enhancementFactor;
    this.tipFieldRatio = clamp(this.enhancedTipFieldKVm / Math.max(1, breakdownKVm), 0, 1.6);

    const onset = this.coronaOnsetKVm(densityKgM3);
    const overOnset = this.enhancedTipFieldKVm / onset;

    // Corona current grows steeply above onset. Bleed charge of the sign that the ambient
    // vertical field implies the overhead cloud is pushing down, i.e. neutralise the local
    // space charge -- which is the dissipation effect.
    if (overOnset > 1.0) {
      // Logarithmic ramp: overOnset spans two orders of magnitude in a real storm, so a linear
      // gain either pinned the corona at maximum or left it at zero with nothing in between.
      const coronaStrength = clamp(Math.log(1.0 + Math.max(0.0, overOnset - 1.0)) / 3.0, 0.0, 1.4);
      this.coronaIntensity += (coronaStrength - this.coronaIntensity) * (1.0 - Math.exp(-dt * 6.0));

      // Spread the bleed over the tip voxel and its immediate neighbours: corona is a sheath a
      // few tens of metres across, not a point.
      const bleed = 1.0 - Math.min(0.55, coronaStrength * dt * 0.85);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = grid.idx(ix + dx, iy + dy, iz + dz);
            const w = dx === 0 && dy === 0 && dz === 0 ? 1.0 : 0.42;
            grid.rhoQ[j] *= 1.0 - (1.0 - bleed) * w;
          }
        }
      }
      this.coronaChargeC += coronaStrength * dt * 1.2e-5;

      // Self-initiated upward leader once corona is well established. Real tall structures
      // launch these under strong ambient fields without any incoming stroke.
      this.leaderCooldownSec -= dt;
      if (coronaStrength > 0.45 && this.leaderCooldownSec <= 0) {
        this.upwardLeaders++;
        this.lastUpwardLeaderSimSec = simTimeSec;
        // Deliberately deterministic: src/sim must not touch Math.random or the fixed-seed
        // regression comparison stops being a valid test. A real mast launches a handful of
        // upward leaders per storm, not one every few seconds.
        this.leaderCooldownSec = 55.0;
        // An upward leader carries charge further out, so it deepens the local bleed.
        for (let dy = 0; dy <= 3; dy++) {
          if (iy + dy > grid.ny - 2) break;
          grid.rhoQ[grid.idx(ix, iy + dy, iz)] *= 0.86;
        }
      }
    } else {
      this.coronaIntensity *= Math.exp(-dt * 3.4);
      this.leaderCooldownSec -= dt;
    }

    if (this.coronaIntensity < 1e-3) this.coronaIntensity = 0;
  }

  public reset(): void {
    this.interceptedStrikes = 0;
    this.upwardLeaders = 0;
    this.coronaIntensity = 0;
    this.tipFieldKVm = 0;
    this.enhancedTipFieldKVm = 0;
    this.tipFieldRatio = 0;
    this.coronaChargeC = 0;
    this.lastInterceptSimSec = -1e9;
    this.lastUpwardLeaderSimSec = -1e9;
    this.leaderCooldownSec = 0;
  }
}
