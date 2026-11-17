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
 * Simulation grid resolution. 64 x 36 x 64 over a 32 km x 18 km x 32 km domain gives
 * 500 m voxels — fine enough that a 1.5 km convective tower is resolved by several voxels
 * across instead of two, which is what makes the cloud silhouette read as a cloud.
 */
export const GRID_NX = 64;
export const GRID_NY = 36;
export const GRID_NZ = 64;

/** Subset of the instability telemetry the convective injection needs. */
export interface ConvectiveInjectionInstability {
  el: number;
  freezingLevel: number;
  homogeneousFreezeLevel: number;
  bulkShear06km: number;
}

/** Quantisation used by the RGBA8 packing LUTs (units per g/kg and the LUT length). */
const PACK_SCALE = 64;
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
 * Greedily merges any overlapping boxes in-place. Adjacent storms share clear-air margins, and
 * advecting a shared voxel twice is pure waste, so overlapping regions are unioned first. The
 * result is a disjoint-ish cover whose total volume stays close to the true active volume.
 */
function mergeOverlappingBoxes(list: ActiveBox[]): void {
  let merged = true;
  let guard = 0;
  while (merged && guard++ < 8) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (boxesOverlap(list[i], list[j])) {
          list[i] = unionBox(list[i], list[j]);
          list.splice(j, 1);
          merged = true;
          break;
        }
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
  public qi: Float32Array; // ice & snow condensate (g/kg)
  public qr: Float32Array; // rain + graupel + hail precipitation density (g/kg)

  private qcPrev: Float32Array;
  private qiPrev: Float32Array;
  private qrPrev: Float32Array;
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
  public maxCFL = 0;
  public totalCondensateMassKg = 0;
  public domainCloudCoverFraction = 0;

  // Active-region tracking: every heavy pass is restricted to where the atmosphere is
  // actually doing something, so clear sky costs ~0 and a single storm costs a fraction
  // of the domain instead of all of it.
  private condBox: ActiveBox = emptyBox();
  private flowBox: ActiveBox = emptyBox();
  private flashBox: ActiveBox = emptyBox();
  private hasActiveFlash = false;
  private ambientSignature = Number.NaN;
  /** Total voxels covered by the (merged) flow regions on the last dynamics step. */
  public lastRegionVoxels = 0;

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

    this.qcPrev = new Float32Array(this.totalCells);
    this.qiPrev = new Float32Array(this.totalCells);
    this.qrPrev = new Float32Array(this.totalCells);
    this.ambU = new Float32Array(ny);
    this.ambW = new Float32Array(ny);
    this.rho0 = new Float32Array(ny);

    this.rhoQ = new Float32Array(this.totalCells);
    this.phi = new Float32Array(this.totalCells);
    this.ex = new Float32Array(this.totalCells);
    this.ey = new Float32Array(this.totalCells);
    this.ez = new Float32Array(this.totalCells);
    this.flashIllum = new Float32Array(this.totalCells);

    this.volTexData = new Uint8Array(this.totalCells * 4);

    // Condensate reaches full optical density near ~2.4 g/kg, precipitation near ~1.5 g/kg,
    // which are the observed values inside convective cores.
    // Packing references are chosen against what the microphysics actually produces, not
    // against a theoretical maximum. Convective cores reach ~1.4 g/kg of suspended condensate
    // and ~2.6 g/kg of precipitating mass in this scheme; saturating there spreads the useful
    // signal across the whole 0..255 byte range instead of cramming it into the bottom third,
    // which is what gives the ray-marcher contrast to erode detail out of.
    this.cloudLut = buildPackLut(1.4, 0.68);
    // qr reaches ~6 g/kg in a mature core (and is capped at 9), so the precipitating-mass
    // reference sits just above that: every byte still means something, and a shaft keeps
    // internal gradients instead of clipping to a uniform black blob.
    this.precipLut = buildPackLut(7.0, 0.75);
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
    this.maxDivergenceResidual = 0;
    this.maxCFL = 0;
    this.totalCondensateMassKg = 0;
    this.domainCloudCoverFraction = 0;
    this.condBox = emptyBox();
    this.flowBox = emptyBox();
    this.flashBox = emptyBox();
    this.hasActiveFlash = false;
    this.textureDirty = true;
    this.condensateChanged = true;
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
   * Ambient sounding cache for the current step (height dependent only).
   * Returns true when the profile changed so the idle fast path can refill the domain.
   */
  private updateAmbientProfile(sounding: AtmosphericSounding): boolean {
    const ny = this.ny;
    let signature = 0;
    for (let iy = 0; iy < ny; iy++) {
      const y = (iy + 0.5) * this.dy;
      const u = sounding.windUAt(y);
      const w = sounding.windWAt(y);
      const rho = sounding.densityAt(y);
      this.ambU[iy] = u;
      this.ambW[iy] = w;
      this.rho0[iy] = rho;
      if ((iy & 3) === 0) signature += u * 13.1 + w * 7.7 + rho * 91.3;
    }
    const changed = !(Math.abs(signature - this.ambientSignature) < 1e-5);
    this.ambientSignature = signature;
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

    const forcingBlend = 1.0 - Math.exp(-stepDt * 0.9);
    const injectBox = emptyBox();
    const inst = sounding.instability;

    // 1. Advect existing condensate inside its active region.
    const advectCondBox = this.padBox(this.condBox, 2);
    if (!boxIsEmpty(advectCondBox)) {
      this.advectCondensates(advectCondBox, stepDt);
    }

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

    let regionVoxels = 0;
    for (const r of regions) {
      regionVoxels += boxVolume(r);
      this.advectVelocityField(r, stepDt);
    }
    this.lastRegionVoxels = regionVoxels;

    // 5. Low-Mach anelastic pressure projection. The pressure field is shared, so solving each
    // region in turn against the same array is a block Gauss-Seidel sweep of one global solve —
    // it converges to the same divergence-free field, just far more cheaply when the active
    // regions are disjoint.
    for (const r of regions) {
      this.projectAnelasticVelocity(r);
    }

    // 6. Rebuild the flow box from where velocity actually differs from the ambient sounding.
    // It is *measured*, never inherited: chaining the previous box (which advection pads every
    // step) makes it ratchet out to the whole domain within minutes. Measuring also lets it
    // shrink again once a storm dissipates or advects away.
    let searchBox = this.padBox(injectBox, 2);
    for (const r of regions) searchBox = unionBox(searchBox, this.padBox(r, 1));
    const nextFlowBox = this.padBox(this.measurePerturbedFlowBox(searchBox), 2);

    this.relaxFlowOutside(nextFlowBox);
    this.flowBox = nextFlowBox;
    this.condBox = unionBox(advectCondBox, injectBox);
    this.condensateChanged = true;

    this.computeFlowDiagnostics(nextFlowBox, stepDt);
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
    const skip = !boxIsEmpty(box);
    for (let iz = 0; iz < nz; iz++) {
      const zOff = slice * iz;
      const izInside = skip && iz >= box.minIz && iz <= box.maxIz;
      for (let iy = 0; iy < ny; iy++) {
        const row = zOff + nx * iy;
        const iyInside = izInside && iy >= box.minIy && iy <= box.maxIy;
        if (iyInside) {
          for (let ix = 0; ix < nx; ix++) {
            if (ix < box.minIx || ix > box.maxIx) {
              const id = row + ix;
              this.u[id] = this.ambU[iy];
              this.vy[id] = 0;
              this.w[id] = this.ambW[iy];
            }
          }
        } else {
          this.u.fill(this.ambU[iy], row, row + nx);
          this.vy.fill(0, row, row + nx);
          this.w.fill(this.ambW[iy], row, row + nx);
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
    const isRotating = Math.abs(cell.mesocycloneVorticity) > 0.008;
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
          if (liquidHere > this.qc[id]) this.qc[id] = liquidHere;
          if (iceHere > this.qi[id]) this.qi[id] = iceHere;

          // Updraft core plus compensating subsidence and low-level inflow around it.
          if (wy >= baseM - 200 && wy <= topM) {
            this.vy[id] += (updraftProfile * radialDensity - this.vy[id]) * forcingBlend;
          } else if (radialNorm < 1.6 && wy < baseM) {
            this.vy[id] += (-1.1 * radialDensity - this.vy[id]) * forcingBlend * 0.5;
          }

          if (radialNorm > 0.95 && radialNorm < 2.4 && wy < baseM + 900) {
            // Mass continuity: inflow convergence below cloud base, subsidence aloft.
            const invR = 1.0 / Math.max(1.0, r);
            const inflow = Math.min(16.0, 0.34 * cell.updraftMaxMS * (1.0 - (radialNorm - 0.95) / 1.45));
            if (inflow > 0.05) {
              const targetU = this.ambU[iy] - dxWorld * invR * inflow;
              const targetW = this.ambW[iy] - dzWorld * invR * inflow;
              this.u[id] += (targetU - this.u[id]) * forcingBlend;
              this.w[id] += (targetW - this.w[id]) * forcingBlend;
            }
          } else if (radialNorm > 1.05 && radialNorm < 3.0 && wy > baseM + 700) {
            const falloff = 1.0 / (radialNorm * radialNorm);
            this.vy[id] += (-0.28 * cell.updraftMaxMS * falloff - this.vy[id]) * forcingBlend * 0.65;
          }

          if (isRotating && r > 60 && radialNorm < 2.0) {
            const vTan = cell.mesocycloneVorticity * r * radialDensity * 0.7;
            const invR = 1.0 / r;
            this.u[id] += (this.ambU[iy] - dzWorld * invR * vTan - this.u[id]) * forcingBlend;
            this.w[id] += (this.ambW[iy] + dxWorld * invR * vTan - this.w[id]) * forcingBlend;
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
                if (value > this.qc[id]) this.qc[id] = value;
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
            if (value > this.qi[id]) this.qi[id] = value;

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
            const value = localPeak * radWeight;
            if (value > this.qr[id]) this.qr[id] = value;
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

    const horizontalDamping = Math.exp(-0.42 * dt);
    const verticalDamping = Math.exp(-1.55 * dt);
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
    const minIx = Math.max(1, box.minIx);
    const maxIx = Math.min(nx - 2, box.maxIx);
    const minIy = Math.max(1, box.minIy);
    const maxIy = Math.min(this.ny - 2, box.maxIy);
    const minIz = Math.max(1, box.minIz);
    const maxIz = Math.min(this.nz - 2, box.maxIz);
    if (maxIx < minIx || maxIy < minIy || maxIz < minIz) return;

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
          this.divergence[id] = rho * (horizontalDiv + anelasticVerticalDiv);
          this.pressure[id] = 0;
        }
      }
    }

    // Red-black Gauss-Seidel with over-relaxation. Warm-started from the previous solve
    // (the charge/velocity fields evolve slowly), so 5 sweeps remove the divergence that
    // buoyancy and gust-front forcing injected without costing a full multigrid cycle.
    const omega = 1.7;
    const iterations = 5;
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
              (this.pressure[id - 1] + this.pressure[id + 1]) * invDx2 +
              (this.pressure[id - nx] + this.pressure[id + nx]) * invDy2 +
              (this.pressure[id - slice] + this.pressure[id + slice]) * invDz2;
            const gs = (neighbors - this.divergence[id]) * invDenom;
            this.pressure[id] += omega * (gs - this.pressure[id]);
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

    // Pressure is a projection variable: clear the halo so the next solve starts clean.
    for (let iz = minIz; iz <= maxIz; iz++) {
      const zOff = slice * iz;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const row = zOff + nx * iy;
        this.pressure.fill(0, row + minIx, row + maxIx + 1);
      }
    }
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
        }
      }
    }

    // Per-second relaxation toward zero where the cell source stops feeding the column.
    // Cloud water tau ~ 45 s, anvil ice ~ 110 s, rain shaft ~ 22 s of simulated time.
    const dampC = Math.exp(-0.022 * clampDt);
    const dampI = Math.exp(-0.009 * clampDt);
    const dampR = Math.exp(-0.045 * clampDt);

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

    for (let iz = Math.max(1, box.minIz); iz <= Math.min(this.nz - 2, box.maxIz); iz++) {
      const zOff = slice * iz;
      for (let iy = Math.max(1, box.minIy); iy <= Math.min(this.ny - 2, box.maxIy); iy++) {
        const row = zOff + nx * iy;
        const rho = Math.max(0.05, this.rho0[iy]);
        const invRho2Dy = 1 / (2 * this.dy * rho);
        for (let ix = Math.max(1, box.minIx); ix <= Math.min(nx - 2, box.maxIx); ix++) {
          const id = row + ix;
          if ((ix + iy + iz) % 5 !== 0) continue;
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
    this.maxCFL = Math.min(0.95, maxCfl);
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
          const qrVal = this.qr[id];
          const totCond = qcVal + qiVal;
          if (totCond > 0.006 || qrVal > 0.006) {
            colHasCond = true;
            if (totCond > 0.06) colHasCloud = true;
          }
          totalMass += (totCond + qrVal) * 0.001 * this.rho0[iy] * cellVol;

          const texIdx = id * 4;
          const flash = this.flashIllum[id];
          if (totCond < 0.006 && qrVal < 0.008 && flash < 0.005) {
            this.volTexData[texIdx] = 0;
            this.volTexData[texIdx + 1] = 0;
            this.volTexData[texIdx + 2] = 0;
            this.volTexData[texIdx + 3] = 0;
          } else {
            let ci = (totCond * PACK_SCALE) | 0;
            if (ci > 255) ci = 255;
            let pi = (qrVal * PACK_SCALE) | 0;
            if (pi > 255) pi = 255;
            const normCloud = cloudLut[ci];
            const normPrecip = precipLut[pi];
            const iceFrac = totCond > 0.004 ? Math.min(255, ((qiVal / totCond) * 255) | 0) : 0;
            const normFlash = flash >= 1 ? 255 : (flash * 255) | 0;

            this.volTexData[texIdx] = normCloud;
            this.volTexData[texIdx + 1] = normPrecip;
            this.volTexData[texIdx + 2] = iceFrac;
            this.volTexData[texIdx + 3] = normFlash;
            if (normCloud > 0 || normPrecip > 0) includePoint(tight, ix, iy, iz);
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
