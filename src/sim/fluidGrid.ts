import { terminalFallSpeedRainMS } from './microphysics';
import { AtmosphericSounding } from './thermodynamics';
import {
  AtmosphereConfig,
  ColdPool,
  ConvectiveCell,
  DOMAIN_HALF_SIZE,
  DOMAIN_MAX_ALT,
  DOMAIN_SIZE,
} from './types';

/**
 * Simulation grid resolution. 96 x 36 x 96 over a 48 km x 18 km x 48 km domain gives
 * 500 m voxels — fine enough that a 1.5 km convective tower is resolved by several voxels
 * across instead of two, which is what makes the cloud silhouette read as a cloud.
 *
 * The horizontal counts were raised from 64 together with DOMAIN_SIZE going 32 km -> 48 km,
 * specifically so the voxel size stays at 500 m. Widening the domain without raising them
 * would have coarsened the cloud field to 1 km and undone the detail the raymarch relies on.
 */
export const GRID_NX = 96;
export const GRID_NY = 36;
export const GRID_NZ = 96;

/** Subset of the instability telemetry the convective injection needs. */
export interface ConvectiveInjectionInstability {
  el: number;
  freezingLevel: number;
  homogeneousFreezeLevel: number;
  bulkShear06km: number;
}

/**
 * Quantisation used by the RGBA8 packing LUTs (units per g/kg and the LUT length).
 *
 * The *index* is 8-bit, so `PACK_SCALE` also sets the highest mixing ratio the texture can
 * represent at all: index = value * PACK_SCALE, and 255/64 = 3.98 g/kg. The LUT's reference
 * (7 g/kg for precipitation) was unreachable, so every value above 3.98 — a mature rain shaft
 * at the 5.2 g/kg cap, the graupel core of a hail-producing tower — packed to the same byte
 * 255 and rendered identically. The physical fields were fine; only the *display* saturated,
 * which is why the radar and the volumetric core both looked flat-topped.
 *
 * 32 units per g/kg gives an index ceiling of 7.98 g/kg, above the 5.2 g/kg rain cap and above
 * every graupel value the scheme produces, at a quantisation of 0.031 g/kg — still finer than
 * the 0.006 g/kg visibility threshold.
 */
const PACK_SCALE = 32;
/**
 * Hard ceiling on total suspending condensate, g/kg.
 *
 * Real convective cores carry 2-5 g/kg; this only exists so a pathological state cannot push
 * the field into tens of g/kg and saturate the 8-bit texture. The *working* limit is
 * `parcelCapLevel`, which is physically derived per level.
 */
const QV_CEILING_GKG = 4.5;
const PACK_LUT_SIZE = 256;

interface ActiveBox {
  minIx: number;
  maxIx: number;
  minIy: number;
  maxIy: number;
  minIz: number;
  maxIz: number;
}

const emptyBox = (): ActiveBox => ({ minIx: 1, maxIx: 0, minIy: 1, maxIy: 0, minIz: 1, maxIz: 0 });

function boxVolume(b: ActiveBox): number {
  if (boxIsEmpty(b)) return 0;
  return (b.maxIx - b.minIx + 1) * (b.maxIy - b.minIy + 1) * (b.maxIz - b.minIz + 1);
}

function boxesOverlap(a: ActiveBox, b: ActiveBox): boolean {
  return (
    a.minIx <= b.maxIx && a.maxIx >= b.minIx &&
    a.minIy <= b.maxIy && a.maxIy >= b.minIy &&
    a.minIz <= b.maxIz && a.maxIz >= b.minIz
  );
}

/**
 * Greedily merges overlapping boxes in-place, refusing merges whose union would be much larger
 * than the two parts.
 *
 * Two separate problems lived here.
 *
 * First, the merge loop was capped at eight outer passes and then simply *returned*, leaving any
 * still-overlapping boxes in the list. Overlapping regions are then advected and projected
 * independently, so shared voxels are integrated twice and, worse, the pressure field is solved
 * twice against two different right-hand sides in sequence — the second solve silently invalidates
 * the first. Measured on a mature supercell this left up to eight overlapping regions being
 * projected in a single step, which is a 95 ms hitch and a physically wrong projection. The loop
 * now runs to completion; each pass removes one box, so it always terminates in at most n-1 passes.
 *
 * Second, a plain union of two diagonal neighbours is their *bounding* box, and a bounding box of
 * two 6 km towers at opposite corners of the domain is the whole domain. Chained across a line of
 * storms that is how `lastRegionVoxels` came to equal all 331 776 cells, making every solve
 * full-domain regardless of how much of it was actually active. A merge that would cost more than
 * the two parts plus a modest margin is now declined: the regions stay separate (correct, since
 * they do not overlap much) and both stay cheap. Advecting a little shared clear air is far
 * preferable to solving the entire grid on every frame.
 */
function mergeOverlappingBoxes(list: ActiveBox[], maxGrowth = 1.6): void {
  let merged = true;
  let guard = 0;
  // A merge removes exactly one entry, so `list.length - 1` passes is a hard upper bound.
  const maxPasses = Math.max(1, list.length);
  while (merged && guard++ < maxPasses) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!boxesOverlap(list[i], list[j])) continue;
        const union = unionBox(list[i], list[j]);
        const parts = boxVolume(list[i]) + boxVolume(list[j]);
        // Always allow a merge that is (nearly) free, so genuinely adjacent boxes still collapse.
        if (boxVolume(union) > parts * maxGrowth && parts > 0) continue;
        list[i] = union;
        list.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
}

/** In-place union, so a box that is already being accumulated into can absorb another one. */
function extendBox(target: ActiveBox, src: ActiveBox): void {
  if (boxIsEmpty(src)) return;
  if (boxIsEmpty(target)) {
    target.minIx = src.minIx; target.maxIx = src.maxIx;
    target.minIy = src.minIy; target.maxIy = src.maxIy;
    target.minIz = src.minIz; target.maxIz = src.maxIz;
    return;
  }
  if (src.minIx < target.minIx) target.minIx = src.minIx;
  if (src.maxIx > target.maxIx) target.maxIx = src.maxIx;
  if (src.minIy < target.minIy) target.minIy = src.minIy;
  if (src.maxIy > target.maxIy) target.maxIy = src.maxIy;
  if (src.minIz < target.minIz) target.minIz = src.minIz;
  if (src.maxIz > target.maxIz) target.maxIz = src.maxIz;
}

function copyBox(b: ActiveBox): ActiveBox {
  return {
    minIx: b.minIx, maxIx: b.maxIx,
    minIy: b.minIy, maxIy: b.maxIy,
    minIz: b.minIz, maxIz: b.maxIz,
  };
}

function boxIsEmpty(b: ActiveBox): boolean {
  return b.maxIx < b.minIx || b.maxIy < b.minIy || b.maxIz < b.minIz;
}

function unionBox(a: ActiveBox, b: ActiveBox): ActiveBox {
  if (boxIsEmpty(a)) return b;
  if (boxIsEmpty(b)) return a;
  return {
    minIx: Math.min(a.minIx, b.minIx),
    maxIx: Math.max(a.maxIx, b.maxIx),
    minIy: Math.min(a.minIy, b.minIy),
    maxIy: Math.max(a.maxIy, b.maxIy),
    minIz: Math.min(a.minIz, b.minIz),
    maxIz: Math.max(a.maxIz, b.maxIz),
  };
}

function includePoint(b: ActiveBox, ix: number, iy: number, iz: number): void {
  if (boxIsEmpty(b)) {
    b.minIx = b.maxIx = ix;
    b.minIy = b.maxIy = iy;
    b.minIz = b.maxIz = iz;
    return;
  }
  if (ix < b.minIx) b.minIx = ix;
  if (ix > b.maxIx) b.maxIx = ix;
  if (iy < b.minIy) b.minIy = iy;
  if (iy > b.maxIy) b.maxIy = iy;
  if (iz < b.minIz) b.minIz = iz;
  if (iz > b.maxIz) b.maxIz = iz;
}

/** Monotone byte ramp for condensate / precipitation packing (avoids Math.pow per voxel). */
function buildPackLut(referenceGKg: number, gamma: number): Uint8Array {
  const lut = new Uint8Array(PACK_LUT_SIZE);
  for (let i = 0; i < PACK_LUT_SIZE; i++) {
    const value = i / PACK_SCALE;
    lut[i] = Math.round(255 * Math.min(1.0, Math.pow(value / referenceGKg, gamma)));
  }
  return lut;
}

export class AtmosphericFluidGrid {
  public readonly nx: number;
  public readonly ny: number;
  public readonly nz: number;
  public readonly sliceStride: number;
  public readonly totalCells: number;
  public readonly dx: number;
  public readonly dy: number;
  public readonly dz: number;

  // 3D Eulerian physical fields (reused typed arrays — zero GC allocation during runtime!)
  public u: Float32Array;
  public vy: Float32Array;
  public w: Float32Array;
  private uPrev: Float32Array;
  private vyPrev: Float32Array;
  private wPrev: Float32Array;
  private pressure: Float32Array;
  private pressureNext: Float32Array;
  private divergence: Float32Array;
  private velocityInitialized = false;
  public qc: Float32Array; // liquid cloud condensate (g/kg)
  public qi: Float32Array; // cloud ice in the *tower* (g/kg)
  /**
   * Snow / aggregated-ice mass in the anvil and the tower's upper half (g/kg).
   *
   * This was missing entirely: the anvil is where most of a storm's ice lives, and a cell's
   * `snowGKg` was being folded into `qi` only inside the visible tower, whose top almost never
   * reaches the anvil deck. The 3-D texture therefore showed an anvil as a thin 0.1-0.3 g/kg
   * cirrus veil however much ice the cell actually carried, and the radar composite had no
   * snow term over most of the storm. Both are fixed by carrying it explicitly.
   */
  public qs: Float32Array; // snow / aggregated ice (g/kg)
  /**
   * Graupel and hail mass in the precipitation shaft (g/kg). The renderer treats it as
   * precipitating mass (it falls at 2-9 m/s) rather than as cloud, and the radar gives it the
   * graupel scattering law, which is what makes a hail core look like a hail core.
   */
  public qg: Float32Array; // graupel + hail (g/kg)
  public qr: Float32Array; // rain + graupel + hail precipitation density (g/kg)

  /**
   * Water vapour mixing ratio (g/kg).
   *
   * This field did not exist before, and its absence was the root cause of the cloud field's
   * look. Clouds were *painted*: `injectConvectiveCell` rasterised an analytic tower, anvil
   * ellipsoid and rain shaft straight into `qc`/`qi`/`qs`, with the masses taken from the bulk
   * cell model rather than from anything the surrounding air could supply. Nothing could
   * condense where the air was merely saturated but no cell happened to be pointing, nothing
   * evaporated back into vapour, and because every voxel inside a shape received essentially
   * the same value the field had no internal structure at all — 5.7% of lit voxels sat at byte
   * 255, and once packed, a saturated voxel renders at 0.94-1.00 density no matter how good the
   * noise is. That is why cloud read as a solid slab rather than as cloud.
   *
   * With vapour present, condensate becomes a *local* consequence of saturation instead of a
   * global shape: air that is lifted cools, saturates, and condenses exactly as much as the
   * vapour it holds allows, and evaporates back the moment it subsides. Advection then produces
   * the ragged edges and gradients for free.
   */
  public qv: Float32Array;
  private qvPrev: Float32Array;
  /**
   * Saturation mixing ratio (g/kg) at each grid level, cached from the sounding once per step.
   *
   * One value per level is an approximation — saturation depends on temperature, and a cloud
   * that is thermodynamically *active* is warmer than its environment — so the condensation
   * step blends the environment's qSat toward the lifted-parcel value over the depth of the
   * cloud. That is what keeps a buoyant tower condensing at 8 km when the environment alone
   * would already be too dry to support it.
   */
  private qSatLevel: Float32Array;
  private qSatParcelLevel: Float32Array;
  /** Condensate (g/kg) a rising parcel has produced by each level -- the physical ceiling. */
  private parcelCondLevel: Float32Array;
  /**
   * Maximum total condensate (g/kg) this level can hold: the undilute parcel condensate
   * multiplied by the entrainment dilution factor.
   *
   * Both the injection and the saturation adjustment read this. They *must*: when the
   * injection was capped by this value while the adjustment used a flat 4.5, the adjustment
   * simply refilled the voxel to 4.5 every step and the entrainment profile had no effect at
   * all -- measured median 4.50 g/kg from 1 km to 10 km, i.e. the entire tower at one value,
   * which is the flat slab the rework exists to remove.
   */
  private parcelCapLevel: Float32Array;
  /** Environmental freezing level (m ASL), cached per step; sets the liquid/ice phase split. */
  private freezingLevelM = 4000;
  private homogeneousFreezeLevelM = 9500;
  /** True once the vapour reservoir has been filled from the current sounding. */
  private vaporSeeded = false;
  /** Cloud-base altitude (m ASL) from the current sounding; sets the entrainment profile. */
  private cloudBaseLevelM = 1000;
  private qcPrev: Float32Array;
  private qiPrev: Float32Array;
  private qrPrev: Float32Array;
  private qsPrev: Float32Array;
  private qgPrev: Float32Array;
  private ambU: Float32Array;
  private ambW: Float32Array;
  private rho0: Float32Array;

  // Electrical 3D grids
  public rhoQ: Float32Array; // space charge density (nC/m^3)
  public phi: Float32Array; // electric potential (MV)
  public ex: Float32Array; // kV/m
  public ey: Float32Array; // kV/m
  public ez: Float32Array; // kV/m
  public flashIllum: Float32Array; // volumetric lightning flash glow [0..1]

  /**
   * Persistent surface water saturation, one value per ground column (nx x nz), in 0..1.
   *
   * This is the state that makes puddles a *consequence* of rainfall rather than a global
   * decoration. It is fed only by precipitation reaching the lowest model levels, so virga that
   * evaporates aloft never wets the ground, and it decays on a ~20 minute timescale so a shaft
   * that has moved on leaves standing water behind it that slowly soaks away.
   */
  public readonly groundSat: Float32Array;
  /** Saturation packed to R8 for GPU upload; the terrain shader reads it to place puddles. */
  public readonly groundSatTex: Uint8Array;
  /** True when groundSatTex changed since the last upload. */
  public groundSatDirty = true;

  // Packed RGBA8 3D texture data uploaded to WebGL2 sampler3D
  public readonly volTexData: Uint8Array;
  /** True when volTexData changed since the last upload — the renderer skips clean frames. */
  public textureDirty = true;
  /**
   * True when qc/qi/qr changed since the last RGBA8 pack. The pack scans the whole active
   * condensate box (~35 k voxels) and used to run every rendered frame, even though the
   * Eulerian solve only steps a few times a second — so most of that work repacked bytes that
   * had not moved. Gating it on this flag keeps the texture in sync with the physics without
   * paying for redundant scans between solves.
   */
  private condensateChanged = true;

  // Conservation & CFL diagnostics
  public maxDivergenceResidual = 0;
  /** Sweeps used by the most recent projection, exposed for the profiler. */
  public projectionSweeps = 0;
  /** Largest pre-projection divergence seen in the current dynamics step (diagnostic only). */
  private maxRegionDivergence = 0;
  public maxCFL = 0;
  public totalCondensateMassKg = 0;
  public domainCloudCoverFraction = 0;

  // Active-region tracking: every heavy pass is restricted to where the atmosphere is
  // actually doing something, so clear sky costs ~0 and a single storm costs a fraction
  // of the domain instead of all of it.
  private condBox: ActiveBox = emptyBox();
  private flowBox: ActiveBox = emptyBox();
  private flashBox: ActiveBox = emptyBox();
  /**
   * Region of `volTexData` actually written by the last pack.
   *
   * This is the fix for a rendering artifact that reads as a rectangular white/grey block of
   * cloud hanging in clear air. The pack only rewrites the *current* dirty box, so any voxel that
   * held condensate in the previous step but sits outside the new box keeps its old bytes forever
   * — the cloud layer stops being erased where the active region shrank or moved, leaving a
   * crisp-edged leftover volume. Unioning the previous written region into every pack guarantees
   * that everything ever marked dirty is revisited and cleared, while still costing a box scan
   * rather than a full-domain one.
   */
  private lastPackBox: ActiveBox = emptyBox();
  private hasActiveFlash = false;
  private ambientSignature = Number.NaN;
  /** Total voxels covered by the (merged) flow regions on the last dynamics step. */
  public lastRegionVoxels = 0;
  /** Voxels of momentum work still queued after the most recent step (diagnostic). */
  public lastBacklogCells = 0;

  private cloudLut: Uint8Array;
  private precipLut: Uint8Array;

  constructor(nx = GRID_NX, ny = GRID_NY, nz = GRID_NZ) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.sliceStride = nx * ny;
    this.totalCells = nx * ny * nz;
    this.dx = DOMAIN_SIZE / nx;
    this.dy = DOMAIN_MAX_ALT / ny;
    this.dz = DOMAIN_SIZE / nz;

    this.u = new Float32Array(this.totalCells);
    this.vy = new Float32Array(this.totalCells);
    this.w = new Float32Array(this.totalCells);
    this.uPrev = new Float32Array(this.totalCells);
    this.vyPrev = new Float32Array(this.totalCells);
    this.wPrev = new Float32Array(this.totalCells);
    this.pressure = new Float32Array(this.totalCells);
    this.pressureNext = new Float32Array(this.totalCells);
    this.divergence = new Float32Array(this.totalCells);
    this.qc = new Float32Array(this.totalCells);
    this.qi = new Float32Array(this.totalCells);
    this.qr = new Float32Array(this.totalCells);
    this.qs = new Float32Array(this.totalCells);
    this.qg = new Float32Array(this.totalCells);
    this.qv = new Float32Array(this.totalCells);
    this.qvPrev = new Float32Array(this.totalCells);

    this.qcPrev = new Float32Array(this.totalCells);
    this.qiPrev = new Float32Array(this.totalCells);
    this.qrPrev = new Float32Array(this.totalCells);
    this.qsPrev = new Float32Array(this.totalCells);
    this.qgPrev = new Float32Array(this.totalCells);
    this.ambU = new Float32Array(ny);
    this.ambW = new Float32Array(ny);
    this.rho0 = new Float32Array(ny);
    this.qSatLevel = new Float32Array(ny);
    this.qSatParcelLevel = new Float32Array(ny);
    this.parcelCondLevel = new Float32Array(ny);
    this.parcelCapLevel = new Float32Array(ny);

    this.rhoQ = new Float32Array(this.totalCells);
    this.phi = new Float32Array(this.totalCells);
    this.ex = new Float32Array(this.totalCells);
    this.ey = new Float32Array(this.totalCells);
    this.ez = new Float32Array(this.totalCells);
    this.flashIllum = new Float32Array(this.totalCells);

    this.volTexData = new Uint8Array(this.totalCells * 4);
    this.groundSat = new Float32Array(nx * nz);
    this.groundSatTex = new Uint8Array(nx * nz);

    // Packing references, calibrated against what the simulation actually produces rather than
    // assumed.
    //
    // The cloud reference used to be 2.0 g/kg, chosen when condensate was painted in by an
    // analytic injection that peaked at 1.88 g/kg. Condensate is now produced by saturation
    // adjustment and entrainment dilution, so the reachable range is both wider and graded: a
    // measured vertical profile runs 0.8 g/kg at cloud base, 2.4-2.8 through the wettest part of
    // the core, and 0.4 at the cirrus top. Keeping the old 2.0 reference packed every voxel
    // above that to an identical byte 255 — measured 30.6 % of lit texels saturated — and a
    // saturated voxel renders at 0.94-1.00 density whatever the noise does. That is precisely
    // the flat slab this rework exists to remove. With 5.0 the ramp is fully used and no lit
    // texel saturates at all.
    //
    // Precipitation rises with it for the same reason: 8.5 g/kg covers the 5.2 g/kg peak the
    // shaft injection reaches without clipping the top of the ramp.
    this.cloudLut = buildPackLut(5.0, 0.72);
    this.precipLut = buildPackLut(8.5, 0.75);
  }

  public reset(): void {
    this.u.fill(0);
    this.vy.fill(0);
    this.w.fill(0);
    this.uPrev.fill(0);
    this.vyPrev.fill(0);
    this.wPrev.fill(0);
    this.pressure.fill(0);
    this.pressureNext.fill(0);
    this.divergence.fill(0);
    this.velocityInitialized = false;
    this.qc.fill(0);
    this.qi.fill(0);
    this.qr.fill(0);
    this.rhoQ.fill(0);
    this.phi.fill(0);
    this.ex.fill(0);
    this.ey.fill(0);
    this.ez.fill(0);
    this.flashIllum.fill(0);
    this.volTexData.fill(0);
    this.groundSat.fill(0);
    this.groundSatTex.fill(0);
    this.groundSatDirty = true;
    this.maxDivergenceResidual = 0;
    this.maxCFL = 0;
    this.totalCondensateMassKg = 0;
    this.domainCloudCoverFraction = 0;
    this.condBox = emptyBox();
    this.flowBox = emptyBox();
    this.flashBox = emptyBox();
    this.lastPackBox = emptyBox();
    this.pendingSlabs.length = 0;
    this.condAdvectTail = emptyBox();
    this.condensateBacklog = 0;
    this.hasActiveFlash = false;
    this.textureDirty = true;
    this.condensateChanged = true;
    // Vapour is reseeded from the sounding on the next step, so a scenario change starts from a
    // full reservoir rather than inheriting the previous storm's depleted one.
    this.vaporSeeded = false;
    this.qv.fill(0);
    this.qvPrev.fill(0);
  }

  public idx(ix: number, iy: number, iz: number): number {
    return ix + this.nx * iy + this.sliceStride * iz;
  }

  public gridToWorldX(ix: number): number {
    return -DOMAIN_HALF_SIZE + (ix + 0.5) * this.dx;
  }

  public gridToWorldY(iy: number): number {
    return (iy + 0.5) * this.dy;
  }

  public gridToWorldZ(iz: number): number {
    return -DOMAIN_HALF_SIZE + (iz + 0.5) * this.dz;
  }

  public worldToGridX(x: number): number {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x + DOMAIN_HALF_SIZE) / this.dx)));
  }

  public worldToGridY(y: number): number {
    return Math.max(0, Math.min(this.ny - 1, Math.floor(y / this.dy)));
  }

  public worldToGridZ(z: number): number {
    return Math.max(0, Math.min(this.nz - 1, Math.floor((z + DOMAIN_HALF_SIZE) / this.dz)));
  }

  /** Called by the lightning engine before writing glow into the volume. */
  public markFlashActive(): void {
    this.hasActiveFlash = true;
  }

  /** Records a volumetric lightning glow sample and grows the flash dirty region. */
  public addFlashIllumination(ix: number, iy: number, iz: number, value: number): void {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return;
    const id = ix + this.nx * iy + this.sliceStride * iz;
    if (value > this.flashIllum[id]) {
      this.flashIllum[id] = Math.min(1.0, value);
      includePoint(this.flashBox, ix, iy, iz);
      this.hasActiveFlash = true;
      this.textureDirty = true;
    }
  }

  public get activeFlowBox(): ActiveBox {
    return this.flowBox;
  }

  /**
   * Bounding box of the region where the velocity field still differs from the ambient
   * sounding by more than a negligible amount. Scanned over the candidate region only, so it
   * costs one pass of three array reads per voxel and pays for itself many times over by
   * keeping advection and the pressure solve confined to the storm.
   */
  /** Working list of active flow regions, reused across steps to avoid allocation. */
  private flowRegions: ActiveBox[] = [];
  /** Per-cell boxes written during injection this step; reused to size the momentum solve. */
  private cellInjectBoxes: ActiveBox[] = [];

  /**
   * Momentum work still owed, as z-slabs of the regions measured for the last step.
   *
   * The Eulerian solve is the only pass whose cost is unbounded per frame: when the storm field
   * grows to span the domain (which it legitimately does — eight cells 30 km apart genuinely
   * perturb 80 % of the grid), a single step has to advect and project all 331 776 voxels at
   * once. Measured on the shipped supercell preset that is a 16 ms projection plus ~10 ms of
   * advection, i.e. a 30-50 ms frame — the periodic hitch. Shrinking the region is not an option
   * (the storms really are there), and simply solving less often makes each solve *further*
   * behind and therefore larger.
   *
   * So the work is sliced by z and drained over consecutive frames under a fixed cell budget.
   * Total voxels visited is unchanged and the physics sees the same sequence of operations per
   * solve; the only difference is that a big domain is delivered in several even frames instead
   * of one long one. A small backlog is harmless because the velocity field is being *corrected*,
   * not advanced: each slab projects against the current pressure field, which is exactly what
   * the block Gauss-Seidel sweep over merged regions already relies on.
   */
  private pendingSlabs: ActiveBox[] = [];
  /** Condensate-advection work carried over from the previous step (see the method below). */
  private condAdvectTail: ActiveBox = emptyBox();
  /** Cells of condensate advection still queued after the last step (diagnostic). */
  public condensateBacklog = 0;
  /** Cells of advect+project work to attempt per dynamics step. */
  private static readonly SLAB_BUDGET_CELLS = 60000;

  /** Bounding box of the flow a cold pool's density current forces. */
  private poolFlowBox(pool: ColdPool, out: ActiveBox): void {
    const reach = pool.radiusM + 900;
    out.minIx = Math.max(1, this.worldToGridX(pool.x - reach));
    out.maxIx = Math.min(this.nx - 2, this.worldToGridX(pool.x + reach));
    out.minIz = Math.max(1, this.worldToGridZ(pool.z - reach));
    out.maxIz = Math.min(this.nz - 2, this.worldToGridZ(pool.z + reach));
    out.minIy = 1;
    out.maxIy = Math.min(this.ny - 2, Math.ceil((pool.depthM + 700) / this.dy));
    if (out.maxIx < out.minIx || out.maxIz < out.minIz || out.maxIy < out.minIy) {
      out.minIx = 1; out.maxIx = 0; out.minIy = 1; out.maxIy = 0; out.minIz = 1; out.maxIz = 0;
    }
  }

  private measurePerturbedFlowBox(candidate: ActiveBox): ActiveBox {
    if (boxIsEmpty(candidate)) return emptyBox();
    const { nx, ny, nz, sliceStride: slice } = this;
    const minIx = Math.max(1, candidate.minIx);
    const maxIx = Math.min(nx - 2, candidate.maxIx);
    const minIy = Math.max(1, candidate.minIy);
    const maxIy = Math.min(ny - 2, candidate.maxIy);
    const minIz = Math.max(1, candidate.minIz);
    const maxIz = Math.min(nz - 2, candidate.maxIz);
    if (maxIx < minIx || maxIy < minIy || maxIz < minIz) return emptyBox();

    // 0.08 m/s is far below anything the renderer can see but far above round-off.
    const TOL = 0.08;
    const out = emptyBox();
    for (let iz = minIz; iz <= maxIz; iz++) {
      const zOff = slice * iz;
      let sliceHit = false;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const row = zOff + nx * iy;
        const ambU = this.ambU[iy];
        const ambW = this.ambW[iy];
        for (let ix = minIx; ix <= maxIx; ix++) {
          const id = row + ix;
          const du = this.u[id] - ambU;
          const dw = this.w[id] - ambW;
          if (du > TOL || du < -TOL || dw > TOL || dw < -TOL || this.vy[id] > TOL || this.vy[id] < -TOL) {
            if (ix < out.minIx) out.minIx = ix;
            if (ix > out.maxIx) out.maxIx = ix;
            if (iy < out.minIy) out.minIy = iy;
            if (iy > out.maxIy) out.maxIy = iy;
            sliceHit = true;
          }
        }
      }
      if (sliceHit) {
        if (iz < out.minIz) out.minIz = iz;
        if (iz > out.maxIz) out.maxIz = iz;
      }
    }
    return boxIsEmpty(out) ? emptyBox() : out;
  }

  private padBox(b: ActiveBox, pad: number): ActiveBox {
    if (boxIsEmpty(b)) return emptyBox();
    return {
      minIx: Math.max(0, b.minIx - pad),
      maxIx: Math.min(this.nx - 1, b.maxIx + pad),
      minIy: Math.max(0, b.minIy - pad),
      maxIy: Math.min(this.ny - 1, b.maxIy + pad),
      minIz: Math.max(0, b.minIz - pad),
      maxIz: Math.min(this.nz - 1, b.maxIz + pad),
    };
  }

  /**
   * Advects the condensate field under a per-step cell budget, carrying the rest to later steps.
   *
   * Returns the number of cells left queued, purely as a diagnostic. `startBox` is the full padded
   * condensate region; the *current* `condBox` is deliberately not touched, because injection and
   * packing both still need the true extent this step.
   */
  private drainCondensateAdvection(startBox: ActiveBox, dt: number): number {
    if (boxIsEmpty(startBox)) {
      this.condAdvectTail = emptyBox();
      return 0;
    }
    // Anything owed from last step is still valid: the velocity field it reads has only been
    // corrected since, and a condensate buffer is idempotent under re-visiting.
    let remaining = unionBox(this.condAdvectTail, startBox);
    const budget = AtmosphericFluidGrid.SLAB_BUDGET_CELLS;
    let spent = 0;
    while (!boxIsEmpty(remaining) && spent < budget) {
      if (boxVolume(remaining) > budget - spent) {
        const tail = this.sliceBoxByZ(remaining, budget - spent);
        if (boxIsEmpty(remaining)) {
          // One z layer alone exceeds the budget; take it whole rather than looping forever.
          this.advectCondensates(remaining, dt);
          remaining = tail;
          break;
        }
        this.advectCondensates(remaining, dt);
        spent += boxVolume(remaining);
        remaining = tail;
      } else {
        this.advectCondensates(remaining, dt);
        spent += boxVolume(remaining);
        remaining = emptyBox();
      }
    }
    this.condAdvectTail = remaining;
    return boxIsEmpty(remaining) ? 0 : boxVolume(remaining);
  }

  /**
   * Cuts the front `budgetCells` worth of z-slices off `box`, returns the *remainder* and mutates
   * `box` to the part that was taken. Used to deliver a region larger than one frame's work
   * budget in several even chunks. A slab keeps the full x/y extent, so the horizontal
   * derivatives the solve reads are never truncated at a cut.
   */
  private sliceBoxByZ(box: ActiveBox, budgetCells: number): ActiveBox {
    const layerCells = (box.maxIx - box.minIx + 1) * (box.maxIy - box.minIy + 1);
    if (layerCells <= 0) return emptyBox();
    const layers = box.maxIz - box.minIz + 1;
    // At least one slice, at most everything: the caller has already established vol > budget,
    // so this lands strictly inside the box unless a single layer exceeds the budget.
    const take = Math.max(1, Math.min(layers - 1, Math.floor(budgetCells / layerCells)));
    const cutAt = box.minIz + take - 1;
    const remainder: ActiveBox = {
      minIx: box.minIx, maxIx: box.maxIx,
      minIy: box.minIy, maxIy: box.maxIy,
      minIz: cutAt + 1, maxIz: box.maxIz,
    };
    box.maxIz = cutAt;
    return boxIsEmpty(remainder) ? emptyBox() : remainder;
  }

  /**
   * Ambient sounding cache for the current step (height dependent only).
   * Returns true when the profile changed so the idle fast path can refill the domain.
   */
  private updateAmbientProfile(sounding: AtmosphericSounding): boolean {
    const ny = this.ny;
    const inst = sounding.instability;
    this.freezingLevelM = inst.freezingLevel;
    this.homogeneousFreezeLevelM = Math.max(inst.freezingLevel + 500, inst.homogeneousFreezeLevel);
    this.cloudBaseLevelM = Math.max(200, inst.lcl);
    let signature = 0;
    for (let iy = 0; iy < ny; iy++) {
      const y = (iy + 0.5) * this.dy;
      const u = sounding.windUAt(y);
      const w = sounding.windWAt(y);
      const rho = sounding.densityAt(y);
      this.ambU[iy] = u;
      this.ambW[iy] = w;
      this.rho0[iy] = rho;
      // Saturation ceiling for this level: the most vapour the air can hold before it must
      // condense. The parcel variant is what a lifted, buoyant column can hold, which is
      // *warmer* than the environment and therefore capable of holding more before saturating.
      this.qSatLevel[iy] = Math.max(0, sounding.qSatGKgAt(y));
      this.parcelCondLevel[iy] = Math.max(0, sounding.parcelCondAt(y));
      // Entrainment dilution: exponential decay with height above cloud base. See the field
      // comment on `parcelCapLevel` for why both stages must share this ceiling.
      const hAboveBase = Math.max(0, y - this.cloudBaseLevelM);
      const entrainDil = Math.exp(-hAboveBase / 5200);
      // Below cloud base the ceiling is *zero*, not a small positive floor. A parcel has not
      // cooled to saturation yet down there, so nothing can condense; leaving a 0.2 g/kg floor
      // put a permanent 0.2 g/kg cloud in the whole sub-cloud layer (measured 3 491 voxels at
      // exactly the floor value, with zero rain among them to justify it).
      const capHere = this.parcelCondLevel[iy] * entrainDil * 0.55;
      this.parcelCapLevel[iy] = y < this.cloudBaseLevelM ? 0 : Math.min(QV_CEILING_GKG, capHere);
      this.qSatParcelLevel[iy] = Math.max(
        this.qSatLevel[iy],
        this.qSatLevel[iy] * (1.0 + 0.62 * sounding.parcelBuoyancyAt(y) * 0.08)
      );
      if ((iy & 3) === 0) signature += u * 13.1 + w * 7.7 + rho * 91.3;
    }
    const changed = !(Math.abs(signature - this.ambientSignature) < 1e-5);
    this.ambientSignature = signature;
    // Refill the vapour reservoir whenever the profile changes, and on the first step. The
    // domain is open, so without this a long run would slowly deplete (or accumulate) the water
    // it started with and drift away from the sounding that is supposed to be driving it.
    if (changed || !this.vaporSeeded) {
      this.seedVaporFromSounding(sounding);
      this.vaporSeeded = true;
    }
    return changed;
  }

  /**
   * Advances the Eulerian atmosphere: semi-Lagrangian advection, convective/cold-pool
   * forcing and the anelastic pressure projection. Called on the physics cadence (not
   * necessarily every rendered frame) with the accumulated simulation dt.
   */
  public stepDynamics(
    dt: number,
    simTimeSec: number,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    coldPools: ColdPool[],
    cfg: AtmosphereConfig
  ): void {
    const stepDt = Math.min(6.0, Math.max(0.001, dt));
    const ambientChanged = this.updateAmbientProfile(sounding);

    if (!this.velocityInitialized) {
      this.fillAmbientVelocityEverywhere();
      this.velocityInitialized = true;
    }

    // Clear sky: the atmosphere is exactly the sounding, so there is nothing to integrate.
    if (cells.length === 0 && coldPools.length === 0 && boxIsEmpty(this.flowBox) && boxIsEmpty(this.condBox)) {
      if (ambientChanged) this.fillAmbientVelocityEverywhere();
      this.maxDivergenceResidual = 0;
      this.maxCFL = 0;
      return;
    }

    // Rate at which the resolved velocity is pulled toward the convective target. The forcing is
    // a *relaxation*, so its equilibrium sits where the blend rate balances the advective
    // damping. At 0.9 s⁻¹ against a 0.65 s⁻¹ vertical damper the grid settled at about half its
    // target; with the damper fixed the blend is raised so a cell's diagnosed updraft appears in
    // the resolved field at 70-85 % of its value rather than at 10 %.
    const forcingBlend = 1.0 - Math.exp(-stepDt * 1.6);
    const injectBox = emptyBox();
    const inst = sounding.instability;

    // 1. Advect existing condensate inside its active region, under the same per-step cell budget
    // as the momentum solve. Condensate advection is the single most expensive unconditional pass
    // in a mature storm (measured 3.8 ms mean, 6.8 ms max, and it grows with the cloud field), yet
    // it is the *safest* thing to defer: the cloud is a passive tracer, so moving it a fraction of
    // a step later changes nothing except which frame pays for it. What is not deferred is where
    // it is *injected* — `injectBox` below still runs in full this step, so a growing tower never
    // waits for the advection backlog.
    const advectCondBox = this.padBox(this.condBox, 2);
    this.condensateBacklog = this.drainCondensateAdvection(advectCondBox, stepDt);

    // 1b. Vapour is advected and then adjusted to saturation locally.
    //
    // Order matters: vapour must be moved to its new position *before* deciding where it
    // condenses, otherwise condensation happens at the old location and the cloud lags the
    // flow by a step. Running the adjustment after advection also means the ragged edges come
    // from the advection operator rather than from a shape function.
    this.advectVapor(advectCondBox, stepDt);
    this.stepCondensation(advectCondBox, stepDt);

    // 2. Surface cold-pool outflow and gust-front convergence.
    if (coldPools.length > 0) {
      this.injectColdPools(coldPools, forcingBlend, injectBox);
    }

    // 3. Convective towers, anvils, flanking lines and precipitation shafts.
    // Each cell also records the box it actually wrote into, which is the honest region for
    // the momentum solve: a heuristic bounding box around the tower over-covers by ~3x because
    // the forcing falls off long before the anvil radius does.
    const cellBoxes = this.cellInjectBoxes;
    cellBoxes.length = 0;
    for (const cell of cells) {
      if (cell.stage === 'nucleating' && cell.cloudWaterGKg < 0.015) continue;
      const b = emptyBox();
      this.injectConvectiveCell(cell, simTimeSec, forcingBlend, cfg, b, inst);
      extendBox(injectBox, b);
      if (!boxIsEmpty(b)) cellBoxes.push(b);
    }

    // 4. Momentum advection, per active region.
    //
    // Storms are compact but spread out: eight cells scattered across a 32 km domain have a
    // bounding union of ~65 k voxels while each individual cell only touches 1-6 k. Advecting
    // and projecting the *union* therefore costs an order of magnitude more than advecting each
    // region separately, and the wasted work is pure clear-air. The previous flow box is reused
    // as a region too, so momentum left over from a dissipating storm still advects out.
    // Collect one region per storm feature, then merge any that overlap. Overlapping regions
    // would each advect the shared voxels again, which costs more than solving their union —
    // the whole point is to skip the clear air *between* compact storms.
    const regions = this.flowRegions;
    regions.length = 0;
    if (!boxIsEmpty(this.flowBox)) regions.push(copyBox(this.flowBox));
    for (const b of cellBoxes) regions.push(this.padBox(b, 1));
    for (const pool of coldPools) {
      const b = emptyBox();
      this.poolFlowBox(pool, b);
      if (!boxIsEmpty(b)) regions.push(b);
    }
    mergeOverlappingBoxes(regions);

    // Everything that was owed from last step is still valid work at this step's dt (the slabs
    // describe *where* velocity has to be corrected, which does not change discontinuously).
    // Append the newly measured regions, then drain under a fixed cell budget.
    //
    // `regions` is snapshotted first: draining below slices entries in place, and step 6 needs the
    // *full* measured extent to decide the new flow box — using the sliced remainder there would
    // shrink the box to whatever happened to fit in this frame's budget.
    const measuredRegions = regions.map(copyBox);

    // Advect and project every measured region this step, in full.
    //
    // An earlier attempt split this into z-slabs and drained them over consecutive frames under a
    // cell budget. It bounded frame time, but it also broke the advect-then-project pairing: a
    // slab left the previous step's velocity *unprojected*, so the flow carried a real divergence
    // into the next step and the measured residual quadrupled (1.5e-2 -> 5.1e-2 s^-1). Displacing
    // work does not remove error, it only moves it to a place where the next solve has to work
    // harder to remove it. The per-frame cost is managed where it belongs instead: this pass only
    // runs on the physics cadence, and the passes that *can* be deferred safely — passive tracer
    // advection, diagnostics — now carry the budget.
    let regionVoxels = 0;
    for (const r of regions) {
      regionVoxels += boxVolume(r);
      this.advectVelocityField(r, stepDt);
      this.projectAnelasticVelocity(r);
    }
    this.lastRegionVoxels = regionVoxels;
    this.lastBacklogCells = 0;
    this.maxRegionDivergence = 0;

    // 6. Rebuild the flow box from where velocity actually differs from the ambient sounding.
    // It is *measured*, never inherited: chaining the previous box (which advection pads every
    // step) makes it ratchet out to the whole domain within minutes. Measuring also lets it
    // shrink again once a storm dissipates or advects away.
    let searchBox = this.padBox(injectBox, 2);
    for (const r of measuredRegions) searchBox = unionBox(searchBox, this.padBox(r, 1));
    const nextFlowBox = this.padBox(this.measurePerturbedFlowBox(searchBox), 2);

    this.relaxFlowOutside(nextFlowBox);
    this.flowBox = nextFlowBox;
    this.condBox = unionBox(advectCondBox, injectBox);
    this.condensateChanged = true;

    // 7. Surface wetting from the rain actually reaching the ground this step.
    this.stepGroundSaturation(this.condBox, stepDt);

    this.computeFlowDiagnostics(nextFlowBox, stepDt);
  }

  /**
   * Accumulates surface water saturation from precipitation reaching the lowest model levels.
   *
   * Only the bottom two levels are sampled, deliberately: that is what separates rain that wets
   * the ground from virga that evaporates on the way down. The balance is a first-order bucket —
   * input proportional to near-surface mixing ratio, loss exponential on an infiltration plus
   * evaporation timescale — which reaches saturation under a heavy core and drains over roughly
   * twenty simulated minutes once the shaft moves away.
   */
  private stepGroundSaturation(box: ActiveBox, dt: number): void {
    const nx = this.nx;
    const nz = this.nz;
    const slice = this.sliceStride;
    if (this.ny < 3) return;
    const stepDt = Math.min(dt, 60.0);
    // Wetting gain per (g/kg) per second, and the drainage/evaporation time constant. Their
    // product sets the equilibrium saturation a given rain rate holds: ~1.0 in a heavy core,
    // ~0.27 in a light shower, so the map stays a gradient rather than a binary flag.
    const gain = 4.5e-4 * stepDt;
    const decay = Math.exp(-stepDt / 1200.0);

    // Every column drains, rain box or not, so ground dries out behind a departing shaft.
    // The packed byte has to be refreshed here too: the terrain shader reads the texture, not
    // the float, so draining one without the other would leave puddles frozen at their peak.
    const sat = this.groundSat;
    const packedTex = this.groundSatTex;
    for (let id = 0; id < sat.length; id++) {
      const v = sat[id];
      if (v <= 0) continue;
      const drained = v * decay < 1e-4 ? 0 : v * decay;
      sat[id] = drained;
      const packed = (drained * 255.0) | 0;
      if (packed !== packedTex[id]) {
        packedTex[id] = packed;
        this.groundSatDirty = true;
      }
    }

    if (boxIsEmpty(box)) return;

    // Lowest two levels: 500 m and 1000 m AGL on the 500 m grid. Note the layout is
    // id = sliceStride*iz + nx*iy + ix, so the *level* offset is nx*iy and the *slice* offset
    // is sliceStride*iz -- mixing those two strides up silently reads a completely different
    // plane, which is exactly what the first version of this did.
    const iyOff1 = nx * 1;
    const iyOff2 = nx * 2;
    const ixLo = Math.max(0, box.minIx);
    const ixHi = Math.min(nx - 1, box.maxIx);
    const izLo = Math.max(0, box.minIz);
    const izHi = Math.min(nz - 1, box.maxIz);

    for (let iz = izLo; iz <= izHi; iz++) {
      const zOff = slice * iz;
      const colBase = iz * nx;
      for (let ix = ixLo; ix <= ixHi; ix++) {
        const nearSurfaceQ =
          this.qr[zOff + iyOff1 + ix] * 0.7 + this.qr[zOff + iyOff2 + ix] * 0.3;
        if (nearSurfaceQ <= 0.004) continue;
        const id = colBase + ix;
        const next = Math.min(1.0, sat[id] + nearSurfaceQ * gain);
        sat[id] = next;
        const packed = (next * 255.0) | 0;
        if (packed !== packedTex[id]) {
          packedTex[id] = packed;
          this.groundSatDirty = true;
        }
      }
    }
  }

  /**
   * Rebuilds the RGBA8 volume texture from the current fields plus the decaying lightning
   * glow. Cheap enough to run every rendered frame because it only touches the dirty
   * region — that keeps in-cloud lightning flashes locked to real-time milliseconds even
   * while the dynamics run on a coarser cadence.
   */
  public refreshVolumeTexture(realDtSec: number): void {
    let packRegion = emptyBox();
    let flashAnimated = false;

    if (this.hasActiveFlash) {
      flashAnimated = true;
      const decay = Math.exp(-Math.max(0.0005, realDtSec) * 7.5);
      const box = this.padBox(this.flashBox, 1);
      let maxRem = 0;
      if (!boxIsEmpty(box)) {
        for (let iz = box.minIz; iz <= box.maxIz; iz++) {
          const zOff = this.sliceStride * iz;
          for (let iy = box.minIy; iy <= box.maxIy; iy++) {
            const row = zOff + this.nx * iy;
            for (let ix = box.minIx; ix <= box.maxIx; ix++) {
              const id = row + ix;
              const v = this.flashIllum[id] * decay;
              this.flashIllum[id] = v < 0.004 ? 0 : v;
              if (v > maxRem) maxRem = v;
            }
          }
        }
      }
      this.hasActiveFlash = maxRem >= 0.004;
      if (!this.hasActiveFlash) this.flashBox = emptyBox();
      packRegion = unionBox(packRegion, box);
    }

    // Between physics solves the RGB channels and the domain diagnostics are already correct;
    // only the lightning alpha can still be animating. Rewriting that alone touches a few
    // hundred voxels instead of rescanning the entire active condensate box.
    if (!this.condensateChanged) {
      if (flashAnimated) this.packFlashAlpha(this.padBox(this.flashBox, 1));
      return;
    }
    this.condensateChanged = false;

    packRegion = unionBox(packRegion, this.padBox(this.condBox, 1));
    // Always revisit everywhere the texture was written last time. Without this, condensate that
    // left the active box would keep its packed bytes and render as a stationary block of cloud.
    packRegion = unionBox(packRegion, this.lastPackBox);
    if (boxIsEmpty(packRegion)) {
      this.maxDivergenceResidual = 0;
      this.totalCondensateMassKg = 0;
      this.domainCloudCoverFraction = 0;
      return;
    }

    this.packRegion(packRegion);
  }

  /**
   * Rewrites just the lightning-illumination alpha channel over a small box. Used when the
   * condensate fields are unchanged but a flash is still decaying, so the glow keeps animating
   * at full frame rate without a full repack.
   */
  private packFlashAlpha(box: ActiveBox): void {
    if (boxIsEmpty(box)) return;
    const nx = this.nx;
    const slice = this.sliceStride;
    for (let iz = box.minIz; iz <= box.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = box.minIy; iy <= box.maxIy; iy++) {
        const row = zOff + nx * iy;
        for (let ix = box.minIx; ix <= box.maxIx; ix++) {
          const id = row + ix;
          const flash = this.flashIllum[id];
          this.volTexData[id * 4 + 3] = flash >= 1 ? 255 : (flash * 255) | 0;
        }
      }
    }
    this.textureDirty = true;
  }

  /** Combined step kept for tooling/back-compat: dynamics plus an immediate texture refresh. */
  public stepFluidAndCondensate(
    dt: number,
    simTimeSec: number,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    coldPools: ColdPool[],
    cfg: AtmosphereConfig
  ): void {
    this.stepDynamics(dt, simTimeSec, sounding, cells, coldPools, cfg);
    this.refreshVolumeTexture(dt);
  }

  private fillAmbientVelocityEverywhere(): void {
    const { nx, ny, nz, sliceStride: slice } = this;
    for (let iz = 0; iz < nz; iz++) {
      const zOff = slice * iz;
      for (let iy = 0; iy < ny; iy++) {
        const row = zOff + nx * iy;
        this.u.fill(this.ambU[iy], row, row + nx);
        this.vy.fill(0, row, row + nx);
        this.w.fill(this.ambW[iy], row, row + nx);
      }
    }
    this.flowBox = emptyBox();
  }

  /** Resets the flow to the ambient sounding everywhere outside the active region. */
  private relaxFlowOutside(box: ActiveBox): void {
    const { nx, ny, nz, sliceStride: slice } = this;
    if (boxIsEmpty(box)) {
      this.fillAmbientVelocityEverywhere();
      return;
    }
    const minIx = Math.max(0, box.minIx);
    const maxIx = Math.min(nx - 1, box.maxIx);
    const minIy = Math.max(0, box.minIy);
    const maxIy = Math.min(ny - 1, box.maxIy);
    const minIz = Math.max(0, box.minIz);
    const maxIz = Math.min(nz - 1, box.maxIz);
    // Walk only the halo, not the full grid volume with a per-voxel "am I inside?" test.
    // The previous version iterated all 331 776 cells every step even once the active region had
    // grown to cover most of the domain, at which point almost every one of those tests was
    // negative and the pass degenerated into a full-domain scan of pure branch overhead. Six
    // rectangular bands cover exactly the complement of the box and touch nothing inside it.
    for (let iz = 0; iz < nz; iz++) {
      const zOff = slice * iz;
      const zInside = iz >= minIz && iz <= maxIz;
      for (let iy = 0; iy < ny; iy++) {
        const row = zOff + nx * iy;
        const yInside = zInside && iy >= minIy && iy <= maxIy;
        if (!yInside) {
          this.u.fill(this.ambU[iy], row, row + nx);
          this.vy.fill(0, row, row + nx);
          this.w.fill(this.ambW[iy], row, row + nx);
          continue;
        }
        // Inside the y band (and therefore the z band): only the x margins are outside the box.
        if (minIx > 0) {
          this.u.fill(this.ambU[iy], row, row + minIx);
          this.vy.fill(0, row, row + minIx);
          this.w.fill(this.ambW[iy], row, row + minIx);
        }
        const tail = row + maxIx + 1;
        if (maxIx + 1 < nx) {
          this.u.fill(this.ambU[iy], tail, row + nx);
          this.vy.fill(0, tail, row + nx);
          this.w.fill(this.ambW[iy], tail, row + nx);
        }
      }
    }
  }

  private injectColdPools(coldPools: ColdPool[], forcingBlend: number, injectBox: ActiveBox): void {
    const { nx, sliceStride: slice } = this;
    const maxPoolIy = Math.min(this.ny - 1, Math.ceil(1700 / this.dy));

    for (const pool of coldPools) {
      const reach = pool.radiusM + 1300;
      const minIx = this.worldToGridX(pool.x - reach);
      const maxIx = this.worldToGridX(pool.x + reach);
      const minIz = this.worldToGridZ(pool.z - reach);
      const maxIz = this.worldToGridZ(pool.z + reach);
      const frontScale = 1.0 / 650.0;

      for (let iy = 0; iy <= maxPoolIy; iy++) {
        const y = this.gridToWorldY(iy);
        if (y > pool.depthM * 1.35) break;
        const vertWeight = Math.max(0, 1.0 - y / (pool.depthM * 1.3));
        const targetVBase =
          pool.expansionSpeedMS * 0.42 * Math.sin((y / (pool.depthM * 1.3)) * Math.PI);
        const rowOff = nx * iy;

        for (let iz = minIz; iz <= maxIz; iz++) {
          const dzWorld = this.gridToWorldZ(iz) - pool.z;
          const zOff = slice * iz + rowOff;
          for (let ix = minIx; ix <= maxIx; ix++) {
            const dxWorld = this.gridToWorldX(ix) - pool.x;
            const r2 = dxWorld * dxWorld + dzWorld * dzWorld;
            if (r2 > reach * reach || r2 < 100) continue;
            const r = Math.sqrt(r2);

            const radialProfile =
              r <= pool.radiusM
                ? r / pool.radiusM
                : Math.max(0, 1.0 - (r - pool.radiusM) / 1200);
            const outSpeed = pool.expansionSpeedMS * radialProfile;
            const rx = dxWorld / r;
            const rz = dzWorld / r;
            const frontBand = Math.exp(-Math.pow((r - pool.radiusM) * frontScale, 2));

            const id = zOff + ix;
            this.u[id] += (this.ambU[iy] + rx * outSpeed * vertWeight - this.u[id]) * forcingBlend;
            this.w[id] += (this.ambW[iy] + rz * outSpeed * vertWeight - this.w[id]) * forcingBlend;
            this.vy[id] += (frontBand * targetVBase * pool.strength - this.vy[id]) * forcingBlend;
            includePoint(injectBox, ix, iy, iz);
          }
        }
      }
    }
  }

  /**
   * Rasterises one convective cell into the Eulerian condensate and momentum fields.
   * Each structure (tower, flanking line, anvil, precipitation shaft) is visited through
   * its own bounding box with per-level constants hoisted out of the horizontal loops.
   */
  private injectConvectiveCell(
    cell: ConvectiveCell,
    simTimeSec: number,
    forcingBlend: number,
    cfg: AtmosphereConfig,
    injectBox: ActiveBox,
    inst: ConvectiveInjectionInstability
  ): void {
    const nx = this.nx;
    const slice = this.sliceStride;
    const baseM = cell.cloudBaseM;
    const topM = cell.cloudTopM;
    const cloudDepth = Math.max(250, topM - baseM);
    // Rotation is judged against the environment's own vortex scale rather than a fixed number:
    // see ConvectiveCellManager.vorticityScale.
    const isRotating = Math.abs(cell.mesocycloneVorticity) > 0.006;
    const shearNorm = Math.min(1.6, inst.bulkShear06km / 18.0);
    const turbulence = Math.max(0.25, Math.min(2.0, cfg.turbulenceIntensity));

    // ---- 1. Main convective tower -----------------------------------------------
    const towerIyMin = Math.max(0, Math.floor((baseM - 560) / this.dy));
    const towerIyMax = Math.min(this.ny - 1, Math.ceil((topM + 280) / this.dy));
    const lobeTime = simTimeSec * 0.02 + cell.numericId * 2.399;
    const suspendLiquid = cell.cloudWaterGKg + cell.supercooledWaterGKg;
    const suspendIce = cell.cloudIceGKg + cell.snowGKg * 0.85;

    for (let iy = towerIyMin; iy <= towerIyMax; iy++) {
      const wy = this.gridToWorldY(iy);
      const heightAboveBase = wy - baseM;
      const zFrac = Math.max(0, Math.min(1, heightAboveBase / cloudDepth));

      const baseSharpness = Math.min(1.0, Math.max(0, (wy - (baseM - 110)) / 300.0));
      const overshootTaper =
        wy > inst.el && cell.overshootingTopM > 60
          ? Math.max(0, 1.0 - (wy - inst.el) / Math.max(400, cell.overshootingTopM + 280)) * 0.72
          : Math.sin(Math.min(1.0, (1.0 - zFrac) * 2.35) * Math.PI * 0.5);
      const verticalEnvelope = Math.max(0.06, baseSharpness * Math.max(0.16, overshootTaper));

      // Shear tilt of the tower axis with height plus mesocyclone twist.
      const shearTilt = Math.min(2800, Math.max(0, heightAboveBase) * 0.16 * shearNorm);
      let cx = cell.x + cell.anvilAxisX * shearTilt;
      let cz = cell.z + cell.anvilAxisZ * shearTilt;
      if (isRotating && wy > baseM && wy < topM) {
        const twist = cell.rotationPhase + heightAboveBase * 0.00055 * Math.sign(cell.mesocycloneVorticity);
        cx += Math.cos(twist) * cell.radiusM * 0.18;
        cz += Math.sin(twist) * cell.radiusM * 0.18;
      }

      // Bulge with height (cumulus congestus waist) and a wall-cloud lowering near the base.
      const bulge = 0.74 + 0.32 * Math.sin(zFrac * Math.PI * 0.86);
      const localTowerR = Math.max(180, cell.radiusM * bulge * (wy > inst.el ? Math.max(0.4, overshootTaper + 0.3) : 1.0));

      // Azimuthal turret lobes: harmonics of the polar angle with slowly drifting phase, so
      // the tower perimeter is irregular and grows new turrets instead of being a smooth cone.
      const phase2 = lobeTime * 0.85 + zFrac * 2.1;
      const phase3 = -lobeTime * 1.15 + zFrac * 3.4;
      const cos2 = Math.cos(phase2);
      const sin2 = Math.sin(phase2);
      const cos3 = Math.cos(phase3);
      const sin3 = Math.sin(phase3);

      const liquidProfile =
        wy < inst.homogeneousFreezeLevel
          ? Math.max(0, Math.min(1.0, 1.0 - Math.max(0, wy - inst.freezingLevel) / 4200.0))
          : 0;
      const iceProfile =
        wy > inst.freezingLevel - 320
          ? Math.min(1.0, (wy - (inst.freezingLevel - 320)) / 2800.0)
          : 0;

      const towerLiquid = suspendLiquid * verticalEnvelope * liquidProfile;
      const towerIce = suspendIce * verticalEnvelope * iceProfile;
      if (towerLiquid < 0.004 && towerIce < 0.004 && !isRotating) continue;

      const reach = localTowerR * 1.22;
      const reach2 = reach * reach;
      const ixLo = this.worldToGridX(cx - reach);
      const ixHi = this.worldToGridX(cx + reach);
      const izLo = this.worldToGridZ(cz - reach);
      const izHi = this.worldToGridZ(cz + reach);
      const updraftProfile = cell.updraftMaxMS * Math.sin(zFrac * Math.PI);
      const rowOff = nx * iy;

      for (let iz = izLo; iz <= izHi; iz++) {
        const dzWorld = this.gridToWorldZ(iz) - cz;
        if (dzWorld * dzWorld > reach2) continue;
        const zOff = slice * iz + rowOff;
        for (let ix = ixLo; ix <= ixHi; ix++) {
          const dxWorld = this.gridToWorldX(ix) - cx;
          const r2 = dxWorld * dxWorld + dzWorld * dzWorld;
          if (r2 > reach2) continue;
          const r = Math.sqrt(r2);
          const id = zOff + ix;

          // Irregular perimeter from the azimuthal lobes.
          let radialNorm: number;
          if (r > 1.0) {
            const c = dxWorld / r;
            const s = dzWorld / r;
            const c2 = c * c - s * s;
            const s2 = 2 * c * s;
            const c3 = 4 * c * c * c - 3 * c;
            const s3 = 3 * s - 4 * s * s * s;
            const lobe =
              (0.3 * turbulence) * (c2 * cos2 - s2 * sin2) +
              (0.46 * turbulence) * (c3 * cos3 - s3 * sin3) * verticalEnvelope;
            const effR = localTowerR * (1.0 + 0.17 * lobe);
            radialNorm = r / Math.max(120, effR);
          } else {
            radialNorm = 0;
          }

          // Flat-ish dense core with a sharpened, eroded margin.
          const edge = radialNorm < 0.42 ? 1.0 : 1.0 - Math.min(1.0, (radialNorm - 0.42) / 0.62);
          const radialDensity = edge * edge * (3.0 - 2.0 * edge);
          if (radialDensity <= 0.004) continue;

          const wallCloud =
            radialNorm < 0.62 && wy > baseM - 460 && wy < baseM + 170
              ? 0.55 + 0.45 * (isRotating ? 1.0 : 0.45)
              : 1.0;

          const liquidHere = towerLiquid * radialDensity * wallCloud;
          const iceHere = towerIce * radialDensity;
          if (liquidHere > this.qc[id] || iceHere > this.qi[id]) {
            // A convective tower is saturated air being lifted, not a dry pipe carrying
            // droplets. Writing condensate into subsaturated environment was immediately
            // evaporated by the new saturation adjustment (measured: mean condensate fell from
            // 0.136 to 0.023 g/kg and the towers dissolved), because the environmental sounding
            // is only 40-70% saturated at mid levels while the air *inside* a tower is at 100%.
            // So the tower carries its own vapour: where it deposits condensate it raises the
            // vapour to the local saturation ceiling first, exactly as ascent does.
            // The tower is saturated air that has been lifted from cloud base, so the most
            // condensate it can physically carry at this altitude is what the parcel produced on
            // the way up -- `parcelCondGKg` from the sounding, a few g/kg at most. Saturating the
            // level and condensing the excess instead would dump the *entire* sea-level vapour
            // content (28.9 g/kg) into the condensate field, which is why the first attempt
            // pinned 23 000 voxels at the 4.5 g/kg cap and 34% of lit texels at byte 255.
            // The sounding's parcel condensate is *undilute*: it assumes a bubble that never
            // mixes with its surroundings, which carries 19 g/kg by 14 km. A real tower
            // entrains environmental air continuously and mixes roughly its own mass by the
            // time it reaches the anvil, so the observed ceiling on a storm core is 4-5 g/kg.
            // `cloudTopFrac` fades the undilute value in from cloud base so the tower is wettest
            // in its lower-middle third, which is where the visible `@` cores belong.
            // Entrainment dilution factor. A plume mixes in environmental air at a roughly
            // constant fractional rate, so the surviving undilute fraction decays exponentially
            // with height above cloud base; the *product* of that and the parcel's accumulated
            // condensate is what a real core actually carries. Measured against the field this
            // replaced: the deepest cores sit near 2.4 g/kg with a tail to 4.5, and the old
            // linear blend let 10 000 voxels pin at the hard cap.
            const parcelCap = this.parcelCapLevel[iy];
            const allowedLiquid = Math.min(liquidHere, parcelCap);
            const allowedIce = Math.min(iceHere, parcelCap);
            const dLiquid = Math.max(0, allowedLiquid - this.qc[id]);
            const dIce = Math.max(0, allowedIce - this.qi[id]);
            // Bring vapour up to saturation so the cloud is in equilibrium with its own air.
            //
            // It must go to exactly the saturation value and *no further*. Setting it higher
            // leaves the column supersaturated, and `stepCondensation` then converts the excess
            // into condensate every single step until it hits the packing cap -- which is what
            // pinned ~6 000 tower voxels at 4.5 g/kg and put 21% of lit texels at byte 255.
            // Saturation plus the tower's own condensate is the equilibrium state, so nothing
            // condenses on the next step and the field stops climbing.
            // Saturated means *exactly* saturated: qv = qSat. Adding the condensate on top
            // leaves the voxel supersaturated by that amount, and the next `stepCondensation`
            // dutifully converts the excess into more condensate -- then the injection sets it
            // again on the following step. That ratchet drove 59% of lit texels to byte 255.
            // Equilibrium is qv == qSat with the condensate held separately, which is a state
            // `stepCondensation` leaves alone.
            const qSatHere = this.qSatParcelLevel[iy];
            if (this.qv[id] < qSatHere) this.qv[id] = qSatHere;
            // ...and take the condensate mass back out of that vapour.
            const drawn = Math.min(this.qv[id], dLiquid + dIce);
            this.qv[id] -= drawn;
            if (allowedLiquid > this.qc[id]) this.qc[id] = allowedLiquid;
            if (allowedIce > this.qi[id]) this.qi[id] = allowedIce;
          }

          // ---- Updraft core -----------------------------------------------------------------
          // Vertical velocity is not what builds a tower in an anelastic model: mass
          // convergence is. Writing vy directly creates a locally divergent field, and the
          // projection then removes almost all of it (measured: a cell diagnosing 15 m/s
          // produced a 5 m/s grid updraft, and the cross-section showed essentially nothing).
          // So the core gets a *modest* direct relaxation and the surrounding annulus supplies
          // the convergence through continuity.
          if (wy >= baseM - 200 && wy <= topM) {
            this.vy[id] += (updraftProfile * radialDensity - this.vy[id]) * forcingBlend * 0.55;
          } else if (radialNorm < 1.6 && wy < baseM) {
            this.vy[id] += (-1.1 * radialDensity - this.vy[id]) * forcingBlend * 0.5;
          }

          if (radialNorm > 0.95 && radialNorm < 2.4 && wy >= baseM - 60 && wy <= topM) {
            // Mass continuity, evaluated level by level from the tower's own vertical
            // structure.
            //
            // Radial inflow is the only part of the forcing the projection *keeps*, because
            // convergence is literally the source term of vertical velocity. The amount needed
            // is not a free parameter: for a core of radius R rising at v(y), continuity
            // demands horizontal convergence of -dv/dy, which for a cylindrical core means a
            // radial inflow of (R/2)·dv/dy at the core edge. Where the profile strengthens with
            // height the annulus converges; through the upper half, where the sine profile
            // weakens, it diverges and the tower spreads into its anvil. Before this the
            // annulus existed only below cloud base + 900 m, so the core relaxation above that
            // height had nothing to balance it and the projection removed it: the grid updraft
            // died at 2.5 km while the cell model diagnosed 18 m/s.
            const invR = 1.0 / Math.max(1.0, r);
            const profileGrad = (cell.updraftMaxMS * Math.PI) / Math.max(600, topM - baseM);
            const dWdy = profileGrad * Math.cos(zFrac * Math.PI);
            const radialTarget = Math.max(-14.0, Math.min(16.0, 0.5 * localTowerR * dWdy * 1.35));
            const shape = 1.0 - (radialNorm - 0.95) / 1.45;
            const inflow = radialTarget * shape;
            if (Math.abs(inflow) > 0.03) {
              const targetU = this.ambU[iy] - dxWorld * invR * inflow;
              const targetW = this.ambW[iy] - dzWorld * invR * inflow;
              this.u[id] += (targetU - this.u[id]) * forcingBlend;
              this.w[id] += (targetW - this.w[id]) * forcingBlend;
            }
          } else if (radialNorm > 1.05 && radialNorm < 3.0 && wy > baseM + 700) {
            const falloff = 1.0 / (radialNorm * radialNorm);
            this.vy[id] += (-0.28 * cell.updraftMaxMS * falloff - this.vy[id]) * forcingBlend * 0.65;
          }

          // ---- Mesocyclone rotation ----------------------------------------------------------
          // A solid-body profile (v = ζ·r) is what this used to be, and it is *unstable*: the
          // tangential speed grows without limit with radius, so once the vorticity term was
          // made physical (before that fix ζ never exceeded 0.011 and the term was harmless)
          // the forcing seed a radial inflow of magnitude ζ·r, which the projection converted
          // into a vertical velocity, which raised the stretching rate, which raised ζ — a
          // positive feedback that took the grid from 27 m/s to over 300 m/s in 12 minutes and
          // pushed the Courant number past 2.5.
          //
          // A real mesocyclone is a Rankine vortex with a *finite* tangential velocity: solid
          // body inside the core radius, then v ∝ r^-0.6 outside, i.e. vorticity itself falls
          // off like r^-1.6 beyond the core. That is what bounds it here, and it is also what
          // keeps the peak tangential speed tied to the diagnosed ζ rather than to how wide
          // the injection annulus happens to be.
          if (isRotating && r > 60 && radialNorm < 2.0) {
            const coreRadius = Math.max(180.0, cell.radiusM * 0.42);
            // Rankine: solid body to the core radius, then v ∝ r^-0.6.
            const profile = r <= coreRadius ? r / coreRadius : Math.pow(coreRadius / r, 0.6);
            // Peak tangential speed across the core, ζ·R_core/2. A 0.03 s⁻¹ mesocyclone with a
            // 900 m core is 13.5 m/s of rotation — the upper end of what a real one carries.
            const peakVtan = Math.min(22.0, 0.5 * Math.abs(cell.mesocycloneVorticity) * coreRadius);
            const vortexSign = Math.sign(cell.mesocycloneVorticity) || 1;
            const tangential = peakVtan * profile * radialDensity;
            const invR = 1.0 / r;
            // RELAX toward the tangential velocity, do not integrate it.
            //
            // This was an accumulating `+=` of a fixed forcing every dynamics step, which is a
            // pure positive feedback: the projection keeps tangential flow (it is
            // divergence-free), nothing removes it, and 12 minutes of forcing at 1.6 s⁻¹
            // multiplied the wind by two orders of magnitude. Relaxing toward a target instead
            // makes the forcing a *rate* with an equilibrium: the vortex settles at the
            // diagnosed tangential speed and the damping in the advection step holds it there.
            const targetU = this.ambU[iy] - vortexSign * dzWorld * invR * tangential;
            const targetW = this.ambW[iy] + vortexSign * dxWorld * invR * tangential;
            this.u[id] += (targetU - this.u[id]) * forcingBlend * 0.5;
            this.w[id] += (targetW - this.w[id]) * forcingBlend * 0.5;
          }

          includePoint(injectBox, ix, iy, iz);
        }
      }
    }

    // ---- 2. Flanking line of smaller towers along the low-level inflow -------------
    if (cell.updraftMaxMS > 5.0 && cloudDepth > 1600 && cell.stage !== 'dissipating') {
      const inflowU = this.ambU[towerIyMin] - cell.vx;
      const inflowW = this.ambW[towerIyMin] - cell.vz;
      const inflowMag = Math.hypot(inflowU, inflowW);
      if (inflowMag > 0.6) {
        const dirX = -inflowU / inflowMag;
        const dirZ = -inflowW / inflowMag;
        for (let k = 1; k <= 3; k++) {
          const spacing = cell.radiusM * (1.35 + 0.55 * k);
          const fx = cell.x + dirX * spacing;
          const fz = cell.z + dirZ * spacing;
          const fRadius = Math.max(280, cell.radiusM * (0.5 - 0.09 * k));
          const fTop = baseM + cloudDepth * Math.max(0.12, 0.52 - 0.13 * k);
          const fDepth = Math.max(220, fTop - baseM);
          const fLiquid = suspendLiquid * (0.62 - 0.13 * k) * Math.min(1, liquidProfileAt(inst.freezingLevel, inst.homogeneousFreezeLevel, baseM + fDepth * 0.5));
          if (fLiquid < 0.006) continue;

          const iyMin = Math.max(0, Math.floor((baseM - 260) / this.dy));
          const iyMax = Math.min(this.ny - 1, Math.ceil((fTop + 160) / this.dy));
          const ixLo = this.worldToGridX(fx - fRadius * 1.35);
          const ixHi = this.worldToGridX(fx + fRadius * 1.35);
          const izLo = this.worldToGridZ(fz - fRadius * 1.35);
          const izHi = this.worldToGridZ(fz + fRadius * 1.35);

          for (let iy = iyMin; iy <= iyMax; iy++) {
            const wy = this.gridToWorldY(iy);
            const zFrac = clamp01((wy - baseM) / fDepth);
            const envelope =
              Math.min(1.0, Math.max(0, (wy - (baseM - 90)) / 240.0)) *
              Math.sin(Math.min(1.0, (1.0 - zFrac) * 2.1) * Math.PI * 0.5);
            if (envelope < 0.02) continue;
            const rowOff = nx * iy;
            for (let iz = izLo; iz <= izHi; iz++) {
              const dzWorld = this.gridToWorldZ(iz) - fz;
              const zOff = slice * iz + rowOff;
              for (let ix = ixLo; ix <= ixHi; ix++) {
                const dxWorld = this.gridToWorldX(ix) - fx;
                const r2 = dxWorld * dxWorld + dzWorld * dzWorld;
                const rr = fRadius * fRadius;
                if (r2 > rr) continue;
                const q = 1.0 - r2 / rr;
                const id = zOff + ix;
                const value = fLiquid * q * q * envelope;
                if (value > this.qc[id]) {
                  const qSatF = this.qSatParcelLevel[iy];
                  if (this.qv[id] < qSatF) this.qv[id] = qSatF;
                  const drawnF = Math.min(this.qv[id], value - this.qc[id]);
                  this.qv[id] -= drawnF;
                  this.qc[id] = value;
                }
                if (cell.updraftMaxMS > 0) {
                  this.vy[id] += (cell.updraftMaxMS * 0.42 * q * envelope - this.vy[id]) * forcingBlend;
                }
                includePoint(injectBox, ix, iy, iz);
              }
            }
          }
        }
      }
    }

    // ---- 3. Upper-tropospheric anvil outflow --------------------------------------
    const anvilStartY = Math.max(baseM + cloudDepth * 0.6, Math.min(topM - 620, inst.el * 0.78));
    if (cell.anvilRadiusM > 600) {
      const anvilTopY = Math.min(topM + 120, inst.el + 520);
      const anvilThickness = Math.max(650, Math.min(2900, anvilTopY - anvilStartY));
      const anvilMidY = anvilStartY + anvilThickness * 0.56;
      const shiftX = cell.x + cell.anvilAxisX * cell.anvilRadiusM * 0.46;
      const shiftZ = cell.z + cell.anvilAxisZ * cell.anvilRadiusM * 0.46;
      const majorR = cell.anvilRadiusM * 0.94;
      const minorR = Math.max(cell.radiusM * 1.2, cell.anvilRadiusM * 0.54);
      const invMajor2 = 1.0 / (majorR * majorR);
      const invMinor2 = 1.0 / (minorR * minorR);
      const anvilIcePeak = Math.max(0.35, (cell.cloudIceGKg + cell.snowGKg * 0.75) * 0.9);
      const mammatusActive = cell.updraftMaxMS > 12 && anvilThickness > 900;

      const iyMin = Math.max(0, Math.floor((anvilStartY - anvilThickness * 0.5) / this.dy));
      const iyMax = Math.min(this.ny - 1, Math.ceil((anvilTopY + anvilThickness * 0.3) / this.dy));

      for (let iy = iyMin; iy <= iyMax; iy++) {
        const wy = this.gridToWorldY(iy);
        const vertAnvil = Math.exp(-Math.pow((wy - anvilMidY) / (anvilThickness * 0.55), 2));
        if (vertAnvil < 0.02) continue;
        // Mammatus lobes hang below the anvil mid-level.
        const mammatus =
          mammatusActive && wy < anvilMidY
            ? 0.82 + 0.26 * Math.sin(wy * 0.0035 + simTimeSec * 0.02)
            : 1.0;
        const rowOff = nx * iy;
        const izLo = this.worldToGridZ(shiftZ - majorR);
        const izHi = this.worldToGridZ(shiftZ + majorR);
        const ixLo = this.worldToGridX(shiftX - majorR);
        const ixHi = this.worldToGridX(shiftX + majorR);

        for (let iz = izLo; iz <= izHi; iz++) {
          const dzWorld = this.gridToWorldZ(iz) - shiftZ;
          const zOff = slice * iz + rowOff;
          for (let ix = ixLo; ix <= ixHi; ix++) {
            const dxWorld = this.gridToWorldX(ix) - shiftX;
            const along = dxWorld * cell.anvilAxisX + dzWorld * cell.anvilAxisZ;
            const across = -dxWorld * cell.anvilAxisZ + dzWorld * cell.anvilAxisX;
            const ellip = along * along * invMajor2 + across * across * invMinor2;
            if (ellip >= 1.0) continue;

            // Fibrous striations stretched along the shear axis (ice crystal habits + wind).
            const striation =
              0.82 +
              0.18 * Math.sin(across * 0.0016 + along * 0.00035 + simTimeSec * 0.012) *
                Math.cos(along * 0.00052 - simTimeSec * 0.008);
            const horizAnvil = Math.pow(1.0 - ellip, 1.3);
            const value = anvilIcePeak * horizAnvil * vertAnvil * striation * mammatus;
            if (value <= 0.004) continue;
            const id = zOff + ix;
            // An anvil is *snow*, not cloud ice: the crystals that make it are millimetre-scale
            // aggregates that have had tens of minutes to grow, and they are what give it a
            // fall speed, a texture and a radar signature. Only the fresh, striated top few
            // hundred metres is still cloud ice. Splitting the mass this way means the anvil
            // gets its own (much longer) damping time and the radar's snow scattering law,
            // instead of being lumped into the tower's ice reservoir.
            const freshIce = value * 0.22;
            const snowMass = value * 0.78;
            if (freshIce > this.qi[id] || snowMass > this.qs[id]) {
              // Anvil ice is condensed from vapour too: it is the same water, deposited at
              // cirrus temperature. Charging it against the vapour budget is what stops the
              // anvil ellipsoid from being an unlimited source and lets it thin naturally once
              // the tower feeding it cuts off.
              const qSatA = this.qSatParcelLevel[iy];
              if (this.qv[id] < qSatA) this.qv[id] = qSatA;
              const dFresh = Math.max(0, freshIce - this.qi[id]);
              const dSnow = Math.max(0, snowMass - this.qs[id]);
              const drawnA = Math.min(this.qv[id], dFresh + dSnow);
              this.qv[id] -= drawnA;
              if (freshIce > this.qi[id]) this.qi[id] = freshIce;
              if (snowMass > this.qs[id]) this.qs[id] = snowMass;
            }

            const rAnv = Math.max(240, Math.sqrt(dxWorld * dxWorld + dzWorld * dzWorld));
            const divSpeed = 5.5 * horizAnvil * vertAnvil;
            const invR = 1.0 / rAnv;
            this.u[id] += (this.ambU[iy] + dxWorld * invR * divSpeed - this.u[id]) * forcingBlend;
            this.w[id] += (this.ambW[iy] + dzWorld * invR * divSpeed - this.w[id]) * forcingBlend;
            includePoint(injectBox, ix, iy, iz);
          }
        }
      }
    }

    // ---- 4. Precipitation shaft, drifting downshear as it falls --------------------
    const precipTotal = cell.rainGKg + cell.graupelGKg * 0.9 + cell.hailGKg * 1.2 + cell.snowGKg * 0.55;
    if (precipTotal > 0.02) {
      const shaftTop = Math.min(topM, baseM + cloudDepth * 0.8);
      const iyMin = 0;
      const iyMax = Math.min(this.ny - 1, Math.ceil(shaftTop / this.dy));
      const shaftRadius = Math.max(650, cell.radiusM * 0.78);
      const vFall = Math.max(1.5, terminalFallSpeedRainMS(Math.max(0.02, cell.rainGKg + cell.graupelGKg * 0.6), 1.0));
      const coreX = cell.x + cell.precipCoreOffsetX;
      const coreZ = cell.z + cell.precipCoreOffsetZ;

      for (let iy = iyMin; iy <= iyMax; iy++) {
        const wy = this.gridToWorldY(iy);
        if (wy > shaftTop) break;
        // Horizontal drift accumulated while falling from the shaft top to this level.
        const fallTime = Math.max(0, (shaftTop - wy)) / vFall;
        const shaftX = coreX - this.ambU[iy] * fallTime * 0.55;
        const shaftZ = coreZ - this.ambW[iy] * fallTime * 0.55;
        const widthScale = 1.0 + Math.max(0, (baseM - wy)) / 5200.0; // shaft spreads as it falls
        const rShaft = shaftRadius * widthScale;
        const rShaft2 = rShaft * rShaft;

        // Sub-cloud attenuation from evaporation (virga) below cloud base.
        const subCloudAtten =
          wy < baseM
            ? Math.max(0, 1.0 - cell.virgaFraction * Math.pow(1.0 - wy / Math.max(300, baseM), 1.25))
            : 1.0;
        if (subCloudAtten <= 0.01) continue;

        const vertProfile = wy < baseM ? subCloudAtten : Math.min(1.0, 0.55 + 0.45 * ((shaftTop - wy) / Math.max(300, shaftTop - baseM)));
        const localPeak = precipTotal * vertProfile;
        if (localPeak <= 0.004) continue;

        const ixLo = this.worldToGridX(shaftX - rShaft);
        const ixHi = this.worldToGridX(shaftX + rShaft);
        const izLo = this.worldToGridZ(shaftZ - rShaft);
        const izHi = this.worldToGridZ(shaftZ + rShaft);
        const rowOff = nx * iy;
        const downdraftHere = -cell.downdraftMaxMS * (wy < baseM + 1100 ? 1.0 : 0.5);

        for (let iz = izLo; iz <= izHi; iz++) {
          const dzWorld = this.gridToWorldZ(iz) - shaftZ;
          const zOff = slice * iz + rowOff;
          for (let ix = ixLo; ix <= ixHi; ix++) {
            const dxWorld = this.gridToWorldX(ix) - shaftX;
            const r2 = dxWorld * dxWorld + dzWorld * dzWorld;
            if (r2 > rShaft2) continue;
            const q = 1.0 - Math.sqrt(r2) / rShaft;
            const radWeight = q * q;
            if (radWeight <= 0.01) continue;
            const id = zOff + ix;
            // The shaft is a rendering proxy for a whole cell's precipitation, so it is capped
            // at a physical rain-water content (a heavy convective core carries ~5 g/kg).
            // Letting several overlapping cells each write their own total is what drove grid
            // qr to 10-16 g/kg and overflowed the 7 g/kg precipitation LUT.
            const value = Math.min(5.2, localPeak * radWeight);
            // Above the melting level the falling mass is graupel and hail, not rain: it falls
            // at 2-9 m/s rather than 6-9, it scatters as ice (so it reads as a hail core on the
            // radar instead of a rain shaft), and it renders with the frozen droplet/streak
            // treatment. Below the 0 °C isotherm it has melted and is rain. Writing all of it
            // to qr made a -30 °C hail shaft indistinguishable from liquid drizzle.
            const frozenShare = Math.max(0, Math.min(1, (inst.freezingLevel + 600 - wy) / 900.0));
            if (frozenShare > 0.02) {
              const graupelMass = value * frozenShare;
              if (graupelMass > this.qg[id]) this.qg[id] = graupelMass;
              const rainMass = value * (1.0 - frozenShare);
              if (rainMass > this.qr[id]) this.qr[id] = rainMass;
            } else if (value > this.qr[id]) {
              this.qr[id] = value;
            }
            if (downdraftHere < -0.05) {
              this.vy[id] += (downdraftHere * radWeight - this.vy[id]) * forcingBlend;
            }
            includePoint(injectBox, ix, iy, iz);
          }
        }
      }
    }
  }

  private advectVelocityField(box: ActiveBox, dt: number): void {
    const { nx, sliceStride: slice, dx, dy, dz } = this;
    const b = this.padBox(box, 1);
    if (boxIsEmpty(b)) return;
    const nxLimX = nx - 2;
    const nyLim = this.ny - 2;
    const nzLim = this.nz - 2;

    // Copy the source region only (the rest of the domain is ambient and stays ambient).
    for (let iz = b.minIz; iz <= b.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = b.minIy; iy <= b.maxIy; iy++) {
        const row = zOff + nx * iy;
        for (let ix = b.minIx; ix <= b.maxIx; ix++) {
          const id = row + ix;
          this.uPrev[id] = this.u[id];
          this.vyPrev[id] = this.vy[id];
          this.wPrev[id] = this.w[id];
        }
      }
    }

    // Numerical damping for the semi-Lagrangian momentum advection.
    //
    // These are *de-aliasing* terms, not physics: semi-Lagrangian advection is unconditionally
    // stable but dissipative, and a small explicit damping suppresses the grid-scale ripple it
    // leaves behind. They must therefore be weak compared with the physical timescales.
    //
    // The vertical coefficient used to be 1.55 s⁻¹ — an e-folding of 0.65 s — applied to vy on
    // *every* dynamics step. The updraft forcing only nudges vy toward its target with a
    // 0.9 s⁻¹ blend, so the damping won by a factor of ~2: a 20 m/s convective updraft settled
    // at 1-2 m/s in the grid no matter what the cell model computed. Clouds still formed (this
    // only affects the velocity field) but the storm's vertical motion, the radar cross-section
    // and everything downstream of it were silently wrong.
    const horizontalDamping = Math.exp(-0.06 * dt);
    const verticalDamping = Math.exp(-0.08 * dt);
    const invDx = dt / dx;
    const invDy = dt / dy;
    const invDz = dt / dz;

    for (let iz = b.minIz; iz <= b.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = b.minIy; iy <= b.maxIy; iy++) {
        const row = zOff + nx * iy;
        const ambU = this.ambU[iy];
        const ambW = this.ambW[iy];
        for (let ix = b.minIx; ix <= b.maxIx; ix++) {
          const id = row + ix;
          if (ix <= 0 || ix >= nx - 1 || iy <= 0 || iy >= this.ny - 1 || iz <= 0 || iz >= this.nz - 1) {
            this.u[id] = ambU;
            this.vy[id] = 0;
            this.w[id] = ambW;
            continue;
          }
          const srcX = ix - this.uPrev[id] * invDx;
          const srcY = iy - this.vyPrev[id] * invDy;
          const srcZ = iz - this.wPrev[id] * invDz;

          // Resolve the source cell once and interpolate all three velocity components from
          // the same eight neighbours. Three separate trilinear samples redo the floor/clamp/
          // index arithmetic three times for identical coordinates, which dominated this pass.
          let x0 = srcX | 0;
          let y0 = srcY | 0;
          let z0 = srcZ | 0;
          if (x0 < 0) x0 = 0; else if (x0 > nxLimX) x0 = nxLimX;
          if (y0 < 0) y0 = 0; else if (y0 > nyLim) y0 = nyLim;
          if (z0 < 0) z0 = 0; else if (z0 > nzLim) z0 = nzLim;
          let fx = srcX - x0;
          let fy = srcY - y0;
          let fz = srcZ - z0;
          if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
          if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
          if (fz < 0) fz = 0; else if (fz > 1) fz = 1;

          const i000 = x0 + nx * y0 + slice * z0;
          const i100 = i000 + 1;
          const i010 = i000 + nx;
          const i110 = i010 + 1;
          const i001 = i000 + slice;
          const i101 = i001 + 1;
          const i011 = i001 + nx;
          const i111 = i011 + 1;

          const mfx = 1 - fx;
          const mfy = 1 - fy;
          const mfz = 1 - fz;
          // Trilinear weights, hoisted out of the per-field loop.
          const w000 = mfx * mfy * mfz;
          const w100 = fx * mfy * mfz;
          const w010 = mfx * fy * mfz;
          const w110 = fx * fy * mfz;
          const w001 = mfx * mfy * fz;
          const w101 = fx * mfy * fz;
          const w011 = mfx * fy * fz;
          const w111 = fx * fy * fz;

          const advU =
            this.uPrev[i000] * w000 + this.uPrev[i100] * w100 +
            this.uPrev[i010] * w010 + this.uPrev[i110] * w110 +
            this.uPrev[i001] * w001 + this.uPrev[i101] * w101 +
            this.uPrev[i011] * w011 + this.uPrev[i111] * w111;
          const advV =
            this.vyPrev[i000] * w000 + this.vyPrev[i100] * w100 +
            this.vyPrev[i010] * w010 + this.vyPrev[i110] * w110 +
            this.vyPrev[i001] * w001 + this.vyPrev[i101] * w101 +
            this.vyPrev[i011] * w011 + this.vyPrev[i111] * w111;
          const advW =
            this.wPrev[i000] * w000 + this.wPrev[i100] * w100 +
            this.wPrev[i010] * w010 + this.wPrev[i110] * w110 +
            this.wPrev[i001] * w001 + this.wPrev[i101] * w101 +
            this.wPrev[i011] * w011 + this.wPrev[i111] * w111;

          this.u[id] = ambU + (advU - ambU) * horizontalDamping;
          this.vy[id] = advV * verticalDamping;
          this.w[id] = ambW + (advW - ambW) * horizontalDamping;
        }
      }
    }
  }



  private projectAnelasticVelocity(box: ActiveBox): void {
    const { nx, sliceStride: slice, dx, dy, dz } = this;
    const invDx2 = 1 / (dx * dx);
    const invDy2 = 1 / (dy * dy);
    const invDz2 = 1 / (dz * dz);
    const invDenom = 1 / (2 * (invDx2 + invDy2 + invDz2));
    let minIx = Math.max(1, box.minIx);
    let maxIx = Math.min(nx - 2, box.maxIx);
    let minIy = Math.max(1, box.minIy);
    let maxIy = Math.min(this.ny - 2, box.maxIy);
    let minIz = Math.max(1, box.minIz);
    let maxIz = Math.min(this.nz - 2, box.maxIz);
    if (maxIx < minIx || maxIy < minIy || maxIz < minIz) return;

    // ---- Divergence, and the tight box around it -------------------------------------------
    // Only a tiny fraction of a storm's bounding box actually carries divergence: measured on a
    // mature supercell, 0.3 % of the solved volume is above 1e-3 s^-1. The projection was
    // nonetheless converging a pressure field over all of it, so ~99.7 % of a 27 ms solve was
    // spent on air that is already divergence-free and contributes nothing to the correction.
    // Recording the tight bounding box of the *actual* divergence and restricting the solve to it
    // (plus a margin wide enough for the pressure field to relax into the surrounding air) removes
    // that waste without changing the answer where it matters.
    let divMinIx = maxIx + 1, divMaxIx = minIx - 1;
    let divMinIy = maxIy + 1, divMaxIy = minIy - 1;
    let divMinIz = maxIz + 1, divMaxIz = minIz - 1;
    // Below this the divergence contributes less than a millimetre per second of velocity
    // correction, i.e. far under the 0.08 m/s threshold the flow box itself is measured with.
    const DIV_NEGLIGIBLE = 2.0e-4;
    for (let iz = minIz; iz <= maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const row = zOff + nx * iy;
        const rho = Math.max(0.05, this.rho0[iy]);
        const rhoUp = this.rho0[iy + 1];
        const rhoDn = this.rho0[iy - 1];
        const inv2DyRho = 1 / (2 * dy * rho);
        for (let ix = minIx; ix <= maxIx; ix++) {
          const id = row + ix;
          const horizontalDiv =
            (this.u[id + 1] - this.u[id - 1]) * (0.5 / dx) +
            (this.w[id + slice] - this.w[id - slice]) * (0.5 / dz);
          const anelasticVerticalDiv =
            (rhoUp * this.vy[id + nx] - rhoDn * this.vy[id - nx]) * inv2DyRho;
          const d = rho * (horizontalDiv + anelasticVerticalDiv);
          this.divergence[id] = d;
          if (d > DIV_NEGLIGIBLE || d < -DIV_NEGLIGIBLE) {
            if (ix < divMinIx) divMinIx = ix;
            if (ix > divMaxIx) divMaxIx = ix;
            if (iy < divMinIy) divMinIy = iy;
            if (iy > divMaxIy) divMaxIy = iy;
            if (iz < divMinIz) divMinIz = iz;
            if (iz > divMaxIz) divMaxIz = iz;
          }
        }
      }
    }
    // Nothing to project at all: the region is already divergence-free.
    if (divMaxIx < divMinIx) return;

    // Margin for the pressure solve. A few cells lets the correction relax smoothly into the
    // surrounding quiescent air instead of ending it on a hard wall, which is what produces a
    // visible velocity discontinuity (and the divergence that follows it) at the cut.
    const PAD = 3;
    minIx = Math.max(minIx, divMinIx - PAD);
    maxIx = Math.min(maxIx, divMaxIx + PAD);
    minIy = Math.max(minIy, divMinIy - PAD);
    maxIy = Math.min(maxIy, divMaxIy + PAD);
    minIz = Math.max(minIz, divMinIz - PAD);
    maxIz = Math.min(maxIz, divMaxIz + PAD);
    if (maxIx < minIx || maxIy < minIy || maxIz < minIz) return;

    // Red-black Gauss-Seidel with over-relaxation, warm-started from the previous solve.
    //
    // The warm start is only valid if the pressure field is the *previous* solution of the same
    // problem. It was being zeroed every step here, which threw the warm start away and left
    // 5 sweeps to solve a Poisson problem from a standing start — nowhere near convergence for a
    // 500 m grid. The velocity then kept a large residual divergence, and because the injected
    // updraft is a locally divergent source, the projection removed it: the cell model reported
    // a 29 m/s updraft while the grid's vertical velocity never exceeded 2.75 m/s, which is why
    // the radar cross-section showed no updraft column at all.
    //
    // Keeping the previous potential as the initial guess (and re-solving the same operator with
    // the updated right-hand side) turns each sweep into a genuine correction step rather than
    // an incomplete solve from zero.
    //
    // The sweep count adapts to the residual of the previous solve. A warm-started correction
    // normally converges in a handful of sweeps, but a cell that has just been injected (or a
    // cold pool that has just gusted out) changes the right-hand side by a large amount and
    // needs more. Spending 24 sweeps on every region every step to cover the occasional
    // transient roughly doubled p95 physics cost for no measurable steady-state gain, so the
    // budget is raised only while the previous residual is above a threshold.
    // Sweep budget from *this region's own* pre-projection divergence, not from the previous
    // step's post-projection residual.
    //
    // The old rule read `this.maxDivergenceResidual`, a domain-wide diagnostic of the *last*
    // completed solve. That is a delayed, global echo of the solve's own output, so it forms a
    // feedback loop: one turbulent frame pushes the residual over 4e-3, the next solve runs 2.5x
    // the sweeps (20 instead of 8) on *every* region, that over-solves and drops the residual
    // back under the threshold, the following solve cheapens out at 8 sweeps, the residual climbs
    // again — and the frame time oscillates with it. Measured on the shipped supercell preset
    // this produced a 17.9 ms mean fluid solve with 95 ms outliers on 17 % of frames, which is
    // precisely the periodic stutter users report. The local divergence captured above is the
    // right quantity: it says how far this region is from solvable *now*, so a quiet region stays
    // cheap regardless of what a distant storm core is doing.
    let regionDiv = 0;
    for (let iz = minIz; iz <= maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const row = zOff + nx * iy;
        for (let ix = minIx; ix <= maxIx; ix++) {
          const d = Math.abs(this.divergence[row + ix]);
          if (d > regionDiv) regionDiv = d;
        }
      }
    }

    const omega = 1.75;
    // Sweeps are chosen from divergence alone, and are *not* capped by frame budget any more.
    //
    // An earlier attempt capped them ("take fewer sweeps when the region is large"). That does
    // bound the frame time, but it bounds convergence too: a large region then never reaches a
    // divergence-free state, and the measured residual quadrupled (1.2e-2 -> 5.1e-2 s^-1) while
    // the storm's mass field drifted. Per-frame cost is bounded by the slab budget in
    // `stepDynamics` instead, which limits how many *voxels* are visited without limiting how
    // thoroughly each visited region is solved. 3.4 ns/voxel-sweep x 60 000 cells x 18 sweeps is
    // ~3.7 ms, which is the honest price of a converged projection.
    const iterations = regionDiv > 4.0e-3 ? 18 : regionDiv > 1.0e-3 ? 12 : 6;
    this.projectionSweeps = iterations;
    if (regionDiv > this.maxRegionDivergence) this.maxRegionDivergence = regionDiv;
    // Hoist every array reference out of the innermost loop. `this.pressure[...]` inside a triple
    // nested loop forces a property load off the instance on each of the seven accesses per cell,
    // which the engine cannot always prove loop-invariant; binding the views once lets it keep
    // them in registers. This pass is 17-18 ms per full-domain solve, so the difference is not
    // academic.
    const pressure = this.pressure;
    const divergence = this.divergence;
    const oneMinusOmega = 1.0 - omega;
    for (let iter = 0; iter < iterations; iter++) {
      const parity = iter & 1;
      for (let iz = minIz; iz <= maxIz; iz++) {
        const zOff = slice * iz;
        for (let iy = minIy; iy <= maxIy; iy++) {
          const row = zOff + nx * iy;
          let ix = minIx;
          if (((ix + iy + iz + parity) & 1) !== 0) ix++;
          for (; ix <= maxIx; ix += 2) {
            const id = row + ix;
            const neighbors =
              (pressure[id - 1] + pressure[id + 1]) * invDx2 +
              (pressure[id - nx] + pressure[id + nx]) * invDy2 +
              (pressure[id - slice] + pressure[id + slice]) * invDz2;
            // SOR update written as a weighted average rather than p += w*(g - p): identical
            // arithmetic, one fewer dependent load-store on the same address.
            pressure[id] = pressure[id] * oneMinusOmega + (neighbors - divergence[id]) * invDenom * omega;
          }
        }
      }
    }

    const inv2Dx = 0.5 / dx;
    const inv2Dy = 0.5 / dy;
    const inv2Dz = 0.5 / dz;
    for (let iz = minIz; iz <= maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const row = zOff + nx * iy;
        const invRho = 1 / Math.max(0.05, this.rho0[iy]);
        for (let ix = minIx; ix <= maxIx; ix++) {
          const id = row + ix;
          this.u[id] -= (this.pressure[id + 1] - this.pressure[id - 1]) * invRho * inv2Dx;
          this.vy[id] -= (this.pressure[id + nx] - this.pressure[id - nx]) * invRho * inv2Dy;
          this.w[id] -= (this.pressure[id + slice] - this.pressure[id - slice]) * invRho * inv2Dz;
        }
      }
    }

    // Pressure is not a physical field: it is a projection variable whose magnitude is
    // arbitrary. Keep it as the warm start for the next solve (see above) but clear the halo
    // outside the solved box, so the Neumann boundary of the next solve is consistent.
    for (let iz = minIz; iz <= maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const row = zOff + nx * iy;
        this.pressure.fill(0, row, row + Math.max(0, minIx));
        this.pressure.fill(0, row + maxIx + 1, row + nx);
      }
    }
  }

  /**
   * Semi-Lagrangian advection of water vapour.
   *
   * Vapour is a tracer like the condensate fields, so it uses the same departure-point gather.
   * The difference is what happens at the edges: an open domain would slowly drain or fill the
   * vapour reservoir, so the boundary ring is relaxed back to the sounding value each step. That
   * makes the sounding the physical reservoir it actually is — a storm cannot manufacture water.
   */
  private advectVapor(box: ActiveBox, dt: number): void {
    if (boxIsEmpty(box)) return;
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const slice = this.sliceStride;
    const clampDt = Math.min(dt, 8.0);
    const invDx = clampDt / this.dx;
    const invDy = clampDt / this.dy;
    const invDz = clampDt / this.dz;

    // Snapshot the departure field.
    for (let iz = box.minIz; iz <= box.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = box.minIy; iy <= box.maxIy; iy++) {
        const row = zOff + nx * iy;
        for (let ix = box.minIx; ix <= box.maxIx; ix++) {
          this.qvPrev[row + ix] = this.qv[row + ix];
        }
      }
    }

    for (let iz = Math.max(1, box.minIz); iz <= Math.min(nz - 2, box.maxIz); iz++) {
      const zOff = slice * iz;
      for (let iy = Math.max(1, box.minIy); iy <= Math.min(ny - 2, box.maxIy); iy++) {
        const row = zOff + nx * iy;
        for (let ix = Math.max(1, box.minIx); ix <= Math.min(nx - 2, box.maxIx); ix++) {
          const id = row + ix;
          const srcX = ix - this.u[id] * invDx;
          const srcY = iy - this.vy[id] * invDy;
          const srcZ = iz - this.w[id] * invDz;

          let x0 = srcX | 0;
          let y0 = srcY | 0;
          let z0 = srcZ | 0;
          if (x0 < 0) x0 = 0; else if (x0 > nx - 2) x0 = nx - 2;
          if (y0 < 0) y0 = 0; else if (y0 > ny - 2) y0 = ny - 2;
          if (z0 < 0) z0 = 0; else if (z0 > nz - 2) z0 = nz - 2;
          let fx = srcX - x0;
          let fy = srcY - y0;
          let fz = srcZ - z0;
          if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
          if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
          if (fz < 0) fz = 0; else if (fz > 1) fz = 1;

          const i000 = x0 + nx * y0 + slice * z0;
          const i100 = i000 + 1;
          const i010 = i000 + nx;
          const i110 = i010 + 1;
          const i001 = i000 + slice;
          const i101 = i001 + 1;
          const i011 = i001 + nx;
          const i111 = i011 + 1;

          this.qv[id] =
            this.qvPrev[i000] * (1 - fx) * (1 - fy) * (1 - fz) +
            this.qvPrev[i100] * fx * (1 - fy) * (1 - fz) +
            this.qvPrev[i010] * (1 - fx) * fy * (1 - fz) +
            this.qvPrev[i110] * fx * fy * (1 - fz) +
            this.qvPrev[i001] * (1 - fx) * (1 - fy) * fz +
            this.qvPrev[i101] * fx * (1 - fy) * fz +
            this.qvPrev[i011] * (1 - fx) * fy * fz +
            this.qvPrev[i111] * fx * fy * fz;
        }
      }
    }
  }

  /**
   * Fills the vapour field with the sounding's own profile.
   *
   * Called on reset and whenever the sounding changes. Without this the domain would start
   * bone dry and every storm would have to invent its own water.
   */
  public seedVaporFromSounding(sounding: AtmosphericSounding): void {
    const { nx, ny, nz, sliceStride: slice } = this;
    for (let iy = 0; iy < ny; iy++) {
      const y = (iy + 0.5) * this.dy;
      const qvEnv = Math.max(0, sounding.qvEnvAt(y));
      for (let iz = 0; iz < nz; iz++) {
        const zOff = slice * iz;
        this.qv.fill(qvEnv, zOff + nx * iy, zOff + nx * iy + nx);
      }
    }
  }

  /**
   * Condensation and evaporation from *local* saturation.
   *
   * This is the step that makes cloud a consequence of the atmosphere rather than a shape
   * painted into it. The rule is the standard saturation adjustment: wherever the vapour mixing
   * ratio exceeds what the air at that level can hold, the excess condenses; wherever condensate
   * exists in subsaturated air, it evaporates back at a rate set by how far below saturation the
   * air is.
   *
   * The buoyancy correction matters and is the reason `qSatParcelLevel` exists. A deep convective
   * tower is warmer than its environment, so it can hold more vapour before saturating. Using
   * only the environmental `qSat` would evaporate the top of every tower the moment it rose into
   * the mid-level dry layer — the grid would show a 3 km stub over a cell the plume model says
   * reaches 12 km. Blending toward the parcel value over the depth of the active updraft keeps
   * the tower condensing to its real top while still letting subsided air evaporate.
   *
   * Condensate is also capped at a physically defensible value: 4.5 g/kg is near the top of what
   * a real convective core carries. Without a cap a single cell can push tens of g/kg into a
   * voxel, which saturates the 8-bit texture and flattens the cloud back into the slab this
   * change exists to remove.
   */
  private stepCondensation(box: ActiveBox, dt: number): void {
    if (boxIsEmpty(box)) return;
    const nx = this.nx;
    const ny = this.ny;
    const slice = this.sliceStride;
    const stepDt = Math.min(dt, 6.0);

    for (let iz = box.minIz; iz <= box.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = Math.max(1, box.minIy); iy <= Math.min(ny - 2, box.maxIy); iy++) {
        const row = zOff + nx * iy;
        // One ceiling per level, and it must be the *same* ceiling the injection used, or the
        // two steps fight each other: injection saturates to the parcel value, this step
        // measures against the drier environmental one, condenses the difference, and the field
        // ratchets to the packing cap a little more every step. Probing a single midpoint cell
        // for the updraft made that worse rather than better -- one clear column in the row
        // dropped the whole level to the environmental ceiling.
        //
        // The parcel ceiling is the right one throughout the active condensate region. It is
        // only 1-3% above the environmental value in this sounding, so using it everywhere costs
        // nothing outside a storm and removes the inconsistency entirely.
        const qSat = this.qSatParcelLevel[iy];

        for (let ix = box.minIx; ix <= box.maxIx; ix++) {
          const id = row + ix;
          const vapour = this.qv[id];
          const condensate = this.qc[id] + this.qi[id];
          if (vapour <= 0.001 && condensate <= 0.001) continue;

          if (vapour > qSat) {
            // Supersaturated: condense the excess immediately. This is fast (a few seconds) in
            // reality; dt here is several seconds per step, so it is resolved outright.
            const excess = vapour - qSat;
            this.qv[id] = qSat;
            // Phase split by temperature: above freezing the condensate is liquid, below it is
            // ice. The grid reads the environmental freezing level rather than a fixed constant
            // so a cold sounding glaciate earlier.
            const iceShare = this.icePhaseShareAt(iy);
            // The cap is on *total* condensate, not per phase. Capping each phase at 4.5
            // separately let a mixed-phase voxel hold 9 g/kg, which is well past anything a
            // real core carries and is enough to pin the packing ramp at its top for the whole
            // 4-7 km depth of the tower.
            const room = Math.max(0, this.parcelCapLevel[iy] - condensate);
            const addLiquid = Math.min(excess * (1 - iceShare), room);
            const addIce = Math.min(excess * iceShare, Math.max(0, room - addLiquid));
            this.qc[id] += addLiquid;
            this.qi[id] += addIce;
            // Anything the cap rejected stays as vapour and is re-partitioned next step. Keeping
            // it here rather than letting it lapse matters for conservation; it also means a
            // saturated layer self-limits instead of manufacturing condensate indefinitely.
            const rejected = excess - addLiquid - addIce;
            if (rejected > 0.0001) this.qv[id] = vapour;
          } else if (condensate > 0.001) {
            // Subsaturated air eats the cloud back. The rate is proportional to the vapour
            // deficit and scaled by droplet surface area, so a thin wisp vanishes quickly while
            // a dense core survives a long dry intrusion -- which is what keeps a storm core
            // intact through entrainment.
            const deficit = Math.max(0, qSat - vapour) / Math.max(0.5, qSat);
            if (deficit <= 0.002) continue;
            // Cloud droplets evaporate in seconds; ice crystals take far longer.
            const evapFrac = Math.min(0.85, (1 - Math.exp(-deficit * 0.55 * stepDt)) * 0.9);
            const liquidLoss = this.qc[id] * evapFrac;
            const iceLoss = this.qi[id] * evapFrac * 0.35;
            this.qc[id] -= liquidLoss;
            this.qi[id] -= iceLoss;
            if (this.qc[id] < 0.004) this.qc[id] = 0;
            if (this.qi[id] < 0.004) this.qi[id] = 0;
            // Evaporated mass returns to vapour, but never above saturation: that is exactly
            // the point at which it stops.
            this.qv[id] = Math.min(qSat, this.qv[id] + liquidLoss + iceLoss);
          }
        }
      }
    }
  }

  /** Ice share of new condensate at a grid level, from the environmental freezing level. */
  private icePhaseShareAt(iy: number): number {
    const alt = this.gridToWorldY(iy);
    const fz = this.freezingLevelM;
    const homo = this.homogeneousFreezeLevelM;
    if (alt <= fz) return 0;
    if (alt >= homo) return 1;
    return (alt - fz) / Math.max(1, homo - fz);
  }

  private advectCondensates(box: ActiveBox, dt: number): void {
    const nx = this.nx;
    const slice = this.sliceStride;
    const clampDt = Math.min(dt, 8.0);
    const invDx = clampDt / this.dx;
    const invDy = clampDt / this.dy;
    const invDz = clampDt / this.dz;

    for (let iz = box.minIz; iz <= box.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = box.minIy; iy <= box.maxIy; iy++) {
        const row = zOff + nx * iy;
        for (let ix = box.minIx; ix <= box.maxIx; ix++) {
          const id = row + ix;
          this.qcPrev[id] = this.qc[id];
          this.qiPrev[id] = this.qi[id];
          this.qrPrev[id] = this.qr[id];
          this.qsPrev[id] = this.qs[id];
          this.qgPrev[id] = this.qg[id];
        }
      }
    }

    // Per-second relaxation toward zero where the cell source stops feeding the column.
    // Cloud water tau ~ 45 s, anvil ice ~ 110 s, rain shaft ~ 22 s of simulated time.
    const dampC = Math.exp(-0.022 * clampDt);
    // Snow persists far longer than cloud ice: an anvil is a mesoscale reservoir that survives
    // tens of minutes after its parent tower has gone, and it is what keeps the cirrus deck
    // visible. Damping it at the cloud-ice rate erased every anvil within ~2 minutes.
    const dampI = Math.exp(-0.009 * clampDt);
    const dampS = Math.exp(-0.0042 * clampDt);
    const dampR = Math.exp(-0.045 * clampDt);
    const dampG = Math.exp(-0.03 * clampDt);

    for (let iz = box.minIz; iz <= box.maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = box.minIy; iy <= box.maxIy; iy++) {
        const row = zOff + nx * iy;
        for (let ix = box.minIx; ix <= box.maxIx; ix++) {
          const id = row + ix;
          if (ix <= 0 || ix >= nx - 1 || iy <= 0 || iy >= this.ny - 1 || iz <= 0 || iz >= this.nz - 1) {
            this.qc[id] = 0;
            this.qi[id] = 0;
            this.qr[id] = 0;
            this.qs[id] = 0;
            this.qg[id] = 0;
            continue;
          }
          const srcX = ix - this.u[id] * invDx;
          const srcY = iy - this.vy[id] * invDy;
          const srcZ = iz - this.w[id] * invDz;

          let x0 = srcX | 0;
          let y0 = srcY | 0;
          let z0 = srcZ | 0;
          if (x0 < 0) x0 = 0; else if (x0 > nx - 2) x0 = nx - 2;
          if (y0 < 0) y0 = 0; else if (y0 > this.ny - 2) y0 = this.ny - 2;
          if (z0 < 0) z0 = 0; else if (z0 > this.nz - 2) z0 = this.nz - 2;
          let fx = srcX - x0;
          let fy = srcY - y0;
          let fz = srcZ - z0;
          if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
          if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
          if (fz < 0) fz = 0; else if (fz > 1) fz = 1;

          const i000 = x0 + nx * y0 + slice * z0;
          const i100 = i000 + 1;
          const i010 = i000 + nx;
          const i110 = i010 + 1;
          const i001 = i000 + slice;
          const i101 = i001 + 1;
          const i011 = i001 + nx;
          const i111 = i011 + 1;

          const w000 = (1 - fx) * (1 - fy) * (1 - fz);
          const w100 = fx * (1 - fy) * (1 - fz);
          const w010 = (1 - fx) * fy * (1 - fz);
          const w110 = fx * fy * (1 - fz);
          const w001 = (1 - fx) * (1 - fy) * fz;
          const w101 = fx * (1 - fy) * fz;
          const w011 = (1 - fx) * fy * fz;
          const w111 = fx * fy * fz;

          const nextQc =
            (this.qcPrev[i000] * w000 + this.qcPrev[i100] * w100 + this.qcPrev[i010] * w010 +
              this.qcPrev[i110] * w110 + this.qcPrev[i001] * w001 + this.qcPrev[i101] * w101 +
              this.qcPrev[i011] * w011 + this.qcPrev[i111] * w111) * dampC;
          this.qc[id] = nextQc < 0.004 ? 0 : nextQc;

          const nextQi =
            (this.qiPrev[i000] * w000 + this.qiPrev[i100] * w100 + this.qiPrev[i010] * w010 +
              this.qiPrev[i110] * w110 + this.qiPrev[i001] * w001 + this.qiPrev[i101] * w101 +
              this.qiPrev[i011] * w011 + this.qiPrev[i111] * w111) * dampI;
          this.qi[id] = nextQi < 0.004 ? 0 : nextQi;

          const nextQr =
            (this.qrPrev[i000] * w000 + this.qrPrev[i100] * w100 + this.qrPrev[i010] * w010 +
              this.qrPrev[i110] * w110 + this.qrPrev[i001] * w001 + this.qrPrev[i101] * w101 +
              this.qrPrev[i011] * w011 + this.qrPrev[i111] * w111) * dampR;
          this.qr[id] = nextQr < 0.004 ? 0 : nextQr;

          const nextQs =
            (this.qsPrev[i000] * w000 + this.qsPrev[i100] * w100 + this.qsPrev[i010] * w010 +
              this.qsPrev[i110] * w110 + this.qsPrev[i001] * w001 + this.qsPrev[i101] * w101 +
              this.qsPrev[i011] * w011 + this.qsPrev[i111] * w111) * dampS;
          this.qs[id] = nextQs < 0.004 ? 0 : nextQs;

          const nextQg =
            (this.qgPrev[i000] * w000 + this.qgPrev[i100] * w100 + this.qgPrev[i010] * w010 +
              this.qgPrev[i110] * w110 + this.qgPrev[i001] * w001 + this.qgPrev[i101] * w101 +
              this.qgPrev[i011] * w011 + this.qgPrev[i111] * w111) * dampG;
          this.qg[id] = nextQg < 0.004 ? 0 : nextQg;
        }
      }
    }
  }

  private computeFlowDiagnostics(box: ActiveBox, dt: number): void {
    if (boxIsEmpty(box)) {
      this.maxDivergenceResidual = 0;
      this.maxCFL = 0;
      return;
    }
    const nx = this.nx;
    const slice = this.sliceStride;
    const inv2Dx = 0.5 / this.dx;
    const inv2Dz = 0.5 / this.dz;
    const inv2Dy = 0.5 / this.dy;
    const dtCfl = Math.min(dt, 2.5);
    let maxDiv = 0;
    let maxCfl = 0;

    // Sampling stride. This pass only feeds HUD/validation telemetry, but it walks the same box as
    // the solve and was costing 3-5 ms a step once the active region covered most of the grid —
    // a diagnostic slower than the physics it reports on. The stride coarsens with the region so
    // the cost stays bounded; a max-over-samples is still a max, just over fewer samples, and the
    // quantities it reports (CFL, divergence residual) are spatial maxima that a 1-in-N sample
    // still finds unless the field is pathological.
    const vol = boxVolume(box);
    const stride = vol > 200_000 ? 29 : vol > 80_000 ? 17 : vol > 30_000 ? 11 : 5;

    for (let iz = Math.max(1, box.minIz); iz <= Math.min(this.nz - 2, box.maxIz); iz++) {
      const zOff = slice * iz;
      for (let iy = Math.max(1, box.minIy); iy <= Math.min(this.ny - 2, box.maxIy); iy++) {
        const row = zOff + nx * iy;
        // The anelastic divergence is (1/rho)·d(rho·v)/dy: density from the same stencil the
        // pressure solve uses.
        const invRho2Dy = 1 / (2 * this.dy * Math.max(0.05, this.rho0[iy]));
        for (let ix = Math.max(1, box.minIx); ix <= Math.min(nx - 2, box.maxIx); ix++) {
          const id = row + ix;
          if ((ix + iy + iz) % stride !== 0) continue;
          const dudx = (this.u[id + 1] - this.u[id - 1]) * inv2Dx;
          const dwdz = (this.w[id + slice] - this.w[id - slice]) * inv2Dz;
          const dvydy =
            (this.rho0[iy + 1] * this.vy[id + nx] - this.rho0[iy - 1] * this.vy[id - nx]) * invRho2Dy;
          const div = Math.abs(dudx + dwdz + dvydy);
          if (div > maxDiv) maxDiv = div;
          const cfl =
            (Math.abs(this.u[id]) / this.dx + Math.abs(this.vy[id]) * inv2Dy * 2 + Math.abs(this.w[id]) / this.dz) * dtCfl;
          if (cfl > maxCfl) maxCfl = cfl;
        }
      }
    }

    this.maxDivergenceResidual = maxDiv;
    // Never clamp a diagnostic: a saturated value hides an instability instead of reporting it.
    this.maxCFL = maxCfl;
  }

  /**
   * Packs the dirty region into RGBA8 and accumulates the domain water/cloud diagnostics.
   * Only the active box is scanned: outside it every condensate field is below threshold by
   * construction, so the integrals stay exact while clear sky costs nothing.
   */
  private packRegion(box: ActiveBox): void {
    const nx = this.nx;
    const slice = this.sliceStride;
    const cellVol = this.dx * this.dy * this.dz;
    const cloudLut = this.cloudLut;
    const precipLut = this.precipLut;

    let totalMass = 0;
    let cloudyColumns = 0;
    let anyCond = false;
    const tight = emptyBox();

    // Mass and cloud cover are domain integrals, so they need the full column scan; the
    // byte packing itself is limited to the dirty region.
    for (let iz = box.minIz; iz <= box.maxIz; iz++) {
      const zOff = slice * iz;
      for (let ix = box.minIx; ix <= box.maxIx; ix++) {
        let colHasCloud = false;
        let colHasCond = false;
        for (let iy = box.minIy; iy <= box.maxIy; iy++) {
          const id = zOff + nx * iy + ix;
          const qcVal = this.qc[id];
          const qiVal = this.qi[id];
          const qsVal = this.qs[id];
          const qrVal = this.qr[id];
          const qgVal = this.qg[id];
          // Cloud = suspended condensate (liquid + cloud ice); snow and graupel are
          // *precipitating* mass and belong in the second channel, where they get their own
          // fall speed and scattering law. Folding snow into cloud made an anvil opaque and
          // gave it the Rayleigh rain signature on the radar.
          const totCond = qcVal + qiVal;
          const totPrecip = qrVal + qsVal + qgVal;
          if (totCond > 0.006 || totPrecip > 0.006) {
            colHasCond = true;
            if (totCond + qsVal * 0.5 > 0.06) colHasCloud = true;
          }
          totalMass += (totCond + qsVal + totPrecip) * 0.001 * this.rho0[iy] * cellVol;

          const texIdx = id * 4;
          const flash = this.flashIllum[id];
          if (totCond < 0.006 && totPrecip < 0.008 && flash < 0.005) {
            this.volTexData[texIdx] = 0;
            this.volTexData[texIdx + 1] = 0;
            this.volTexData[texIdx + 2] = 0;
            this.volTexData[texIdx + 3] = 0;
          } else {
            let ci = (totCond * PACK_SCALE) | 0;
            if (ci > 255) ci = 255;
            // Snow is optically thick per unit mass (mm-scale aggregates have a much larger
            // cross-section per gram than cloud droplets), so it is weighted up in the byte but
            // *not* in the mass integral above.
            let pi = ((qrVal + qsVal * 1.35 + qgVal) * PACK_SCALE) | 0;
            if (pi > 255) pi = 255;
            const normCloud = cloudLut[ci];
            const normPrecip = precipLut[pi];
            // Ice fraction is a property of the *cloud*, and the last thing that should decide
            // it is ambient temperature: this is what the shader uses to switch between a
            // cauliflower liquid surface and a fibrous crystalline one. It is computed from the
            // actual ice and liquid masses, so it now also sees anvils (all ice) and a
            // supercooled base (no ice) correctly.
            const condensedForPhase = totCond + qsVal;
            const iceFrac =
              condensedForPhase > 0.004
                ? Math.min(255, (((qiVal + qsVal * 0.9) / condensedForPhase) * 255) | 0)
                : 0;
            const normFlash = flash >= 1 ? 255 : (flash * 255) | 0;

            this.volTexData[texIdx] = normCloud;
            this.volTexData[texIdx + 1] = normPrecip;
            this.volTexData[texIdx + 2] = iceFrac;
            this.volTexData[texIdx + 3] = normFlash;
            // A voxel counts as "written non-zero" if *any* channel is lit, the lightning alpha
            // included: those are the only texels that later need revisiting to be erased.
            if (normCloud > 0 || normPrecip > 0 || normFlash > 0) includePoint(tight, ix, iy, iz);
          }
        }
        if (colHasCloud) cloudyColumns++;
        if (colHasCond) anyCond = true;
      }
    }

    this.condBox = anyCond ? this.padBox(tight, 2) : emptyBox();
    this.domainCloudCoverFraction = cloudyColumns / (this.nx * this.nz);
    this.totalCondensateMassKg = totalMass;
    this.textureDirty = true;
    // Track the *tight* non-zero region, not the scanned box. Using the scanned box would make
    // the region creep outward as a storm drifts and eventually cover the whole domain, which is
    // the very cost this optimisation exists to avoid; the tight region shrinks back to nothing
    // as the cloud dissipates and still guarantees every lit texel is revisited.
    this.lastPackBox = anyCond ? this.padBox(tight, 1) : emptyBox();
  }

}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function liquidProfileAt(
  freezingLevel: number,
  homogeneousFreezeLevel: number,
  y: number
): number {
  if (y >= homogeneousFreezeLevel) return 0;
  if (y <= freezingLevel) return 1;
  return Math.max(0, 1.0 - (y - freezingLevel) / Math.max(400, homogeneousFreezeLevel - freezingLevel));
}
