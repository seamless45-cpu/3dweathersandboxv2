import { AtmosphericFluidGrid } from './fluidGrid';
import { AtmosphericSounding } from './thermodynamics';
import { AtmosphereConfig, ConvectiveCell, PHYS } from './types';

export interface BreakdownCandidate {
  ix: number;
  iy: number;
  iz: number;
  x: number;
  y: number;
  z: number;
  eMagKVm: number;
  eThresholdKVm: number;
  ratio: number;
  ex: number;
  ey: number;
  ez: number;
  localRhoQ: number;
  nearestCell: ConvectiveCell | null;
}

/** Shared empty result: avoids allocating a fresh array on every skipped solve. */
const NO_CANDIDATES: BreakdownCandidate[] = [];

/** Saturating normalisation used by the non-inductive charging kernel. */
function clamp01_2(v: number): number {
  return v <= 0 ? 0 : v >= 2.2 ? 2.2 : v;
}

export function breakdownThresholdKVm(rhoKgM3: number): number {
  // Empirical cloud-air runaway/breakdown threshold scaled to local air density.
  return 206.0 * (rhoKgM3 / 1.225);
}

export function mixedPhaseChargeReversalFraction(lwcGKg: number, temperatureK: number): number {
  // Laboratory charging polarity depends on both temperature and liquid-water
  // content. This smooth reversal curve is an empirical bulk parameterization,
  // not a claim to resolve individual ice-graupel collisions.
  const temperatureC = temperatureK - PHYS.T_FREEZE;
  const reversalLwc = Math.max(0.45, Math.min(1.8, 1.15 + (temperatureC + 15) * 0.022));
  return 1 / (1 + Math.exp(-(lwcGKg - reversalLwc) * 2.4));
}

export class AtmosphericElectrificationEngine {
  public maxElectricFieldKVm = 0;
  public maxBreakdownRatio = 0;
  public maxPosChargeNCm3 = 0;
  public maxNegChargeNCm3 = 0;
  public netAtmosphereChargeC = 0;
  public cumulativeGroundTransferredC = 0;

  private eThreshByY = new Float32Array(64);
  private hadPotentialLastStep = false;
  /** Reused per-level charge-layer profiles (avoids 4 exp() calls per grid point). */
  private profMain: Float32Array = new Float32Array(64);
  private profLpcc: Float32Array = new Float32Array(64);
  private profUpper: Float32Array = new Float32Array(64);
  private profScreen: Float32Array = new Float32Array(64);
  /** Candidates from the most recent field solve (empty when the solve was skipped). */
  public lastCandidates: BreakdownCandidate[] = [];

  public reset(): void {
    this.lastCandidates = [];
    this.maxElectricFieldKVm = 0;
    this.maxBreakdownRatio = 0;
    this.maxPosChargeNCm3 = 0;
    this.maxNegChargeNCm3 = 0;
    this.netAtmosphereChargeC = 0;
    this.cumulativeGroundTransferredC = 0;
    this.hadPotentialLastStep = false;
  }

  /**
   * @param solveFieldWhen false, the (slow) Poisson field solve and breakdown scan are
   * skipped and the previous candidates are returned. Charge evolves on a minutes-scale,
   * so re-solving it every rendered frame is wasted work; the coordinator drives cadence.
   */
  public step(
    dt: number,
    grid: AtmosphericFluidGrid,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    cfg: AtmosphereConfig,
    solveField = true
  ): BreakdownCandidate[] {
    const inst = sounding.instability;
    const mixedPhaseTemperatureK = sounding.sampleAtAltitude(
      inst.freezingLevel + Math.min(1800, Math.max(500, (inst.homogeneousFreezeLevel - inst.freezingLevel) * 0.35))
    ).tempK;
    let anyElectrifiedCell = false;

    // 1. Update charge separation from mixed-phase ice/graupel collisions and
    // field-enhanced inductive charging. The polarity reversal depends on T and LWC.
    for (const cell of cells) {
      const hasMixedPhase =
        cell.cloudTopM > inst.freezingLevel + 400 &&
        cell.graupelGKg > 0.04 &&
        cell.cloudIceGKg > 0.04;

      if (hasMixedPhase && cell.updraftMaxMS > 2.2) {
        // Non-inductive (Takahashi-style) charging: the graupel/ice collision rate is
        // normalised by the hydrometeor contents typical of the -15 degreesC charging zone,
        // so the kernel is O(1) for a realistic mixed-phase core instead of O(1000).
        const temperatureWindow = Math.exp(-Math.pow((mixedPhaseTemperatureK - 258.15) / 17.0, 2));
        const collisionKernel =
          clamp01_2(cell.graupelGKg / 0.8) *
          clamp01_2(cell.cloudIceGKg / 0.3) *
          clamp01_2(0.25 + cell.supercooledWaterGKg * 1.35) *
          clamp01_2(cell.updraftMaxMS / 14.0) *
          temperatureWindow *
          cfg.chargeSeparationGain;

        const reversalFraction = mixedPhaseChargeReversalFraction(
          cell.supercooledWaterGKg,
          mixedPhaseTemperatureK
        );
        const mainLayerSign = 1.0 - 2.0 * reversalFraction;
        const upperShare = 1.0 - 0.36 * Math.min(0.9, reversalFraction);
        const lowerShare = 0.14 + 0.36 * Math.min(0.9, reversalFraction);
        const totalPositiveShare = upperShare + lowerShare;
        const dqTotal = 0.011 * collisionKernel * dt;
        const upperDelta = -mainLayerSign * dqTotal * (upperShare / totalPositiveShare);
        const lowerDelta = -mainLayerSign * dqTotal * (lowerShare / totalPositiveShare);
        const mainDelta = mainLayerSign * dqTotal;

        // The transferred charge is pairwise balanced: upper + lower + main = 0
        // before the independent corona/precipitation leakage terms are applied.
        cell.upperPosChargeNCm3 = Math.max(-5.4, Math.min(5.4, cell.upperPosChargeNCm3 + upperDelta));
        cell.lowerPosChargeNCm3 = Math.max(-3.4, Math.min(3.4, cell.lowerPosChargeNCm3 + lowerDelta));
        cell.mainNegChargeNCm3 = Math.max(-5.8, Math.min(5.8, cell.mainNegChargeNCm3 + mainDelta));

        if (cell.peakElectricFieldKVm > 35.0) {
          const indRate = 0.004 * (cell.peakElectricFieldKVm / 100.0) * cell.graupelGKg * dt;
          cell.upperPosChargeNCm3 = Math.max(-5.6, Math.min(5.6, cell.upperPosChargeNCm3 - mainLayerSign * indRate * 0.7));
          cell.lowerPosChargeNCm3 = Math.max(-3.5, Math.min(3.5, cell.lowerPosChargeNCm3 - mainLayerSign * indRate * 0.3));
          cell.mainNegChargeNCm3 = Math.max(-6.0, Math.min(6.0, cell.mainNegChargeNCm3 + mainLayerSign * indRate));
        }

        if (cell.anvilRadiusM > 2200) {
          const screenTarget = -0.28 * cell.upperPosChargeNCm3;
          cell.anvilScreenChargeNCm3 +=
            (screenTarget - cell.anvilScreenChargeNCm3) * Math.min(1.0, 0.025 * dt);
        }
      }

      const relax = Math.exp(-dt * (0.0016 + cell.surfaceRainRateMMHr * 0.00004));
      cell.upperPosChargeNCm3 *= relax;
      cell.mainNegChargeNCm3 *= relax;
      cell.lowerPosChargeNCm3 *= relax;
      cell.anvilScreenChargeNCm3 *= relax;

      cell.peakElectricFieldKVm = 0;
      cell.breakdownRatio = 0;

      if (
        Math.abs(cell.mainNegChargeNCm3) >= 0.02 ||
        Math.abs(cell.upperPosChargeNCm3) >= 0.02
      ) {
        anyElectrifiedCell = true;
      }
    }

    // Fast path when atmosphere is uncharged (clear sky / shallow warm cumulus)
    if (!anyElectrifiedCell) {
      if (this.hadPotentialLastStep) {
        grid.rhoQ.fill(0);
        grid.phi.fill(0);
        grid.ex.fill(0);
        grid.ey.fill(0);
        grid.ez.fill(0);
        this.hadPotentialLastStep = false;
      }
      this.maxElectricFieldKVm = 0;
      this.maxBreakdownRatio = 0;
      this.maxPosChargeNCm3 = 0;
      this.maxNegChargeNCm3 = 0;
      this.netAtmosphereChargeC = 0;
      this.lastCandidates = NO_CANDIDATES;
      return NO_CANDIDATES;
    }

    this.hadPotentialLastStep = true;
    if (!solveField) {
      // Breakdown may only initiate on a freshly solved field, otherwise one supercritical
      // voxel could fire repeatedly between solves.
      return NO_CANDIDATES;
    }
    grid.rhoQ.fill(0);

    const nx = grid.nx;
    const ny = grid.ny;
    const nz = grid.nz;
    const slice = grid.sliceStride;

    if (this.profMain.length < ny) {
      this.profMain = new Float32Array(ny);
      this.profLpcc = new Float32Array(ny);
      this.profUpper = new Float32Array(ny);
      this.profScreen = new Float32Array(ny);
    }

    let actMinIx = nx - 2;
    let actMaxIx = 1;
    let actMaxIy = 1;
    let actMinIz = nz - 2;
    let actMaxIz = 1;

    for (const cell of cells) {
      if (
        Math.abs(cell.mainNegChargeNCm3) < 0.02 &&
        Math.abs(cell.upperPosChargeNCm3) < 0.02
      ) {
        continue;
      }

      const zLPCC = Math.max(cell.cloudBaseM + 400, inst.freezingLevel - 500);
      const zMainNeg = inst.freezingLevel + 2100;
      const zUpperPos = Math.min(cell.cloudTopM - 600, inst.freezingLevel + 5200);
      const zScreen = cell.cloudTopM;

      // Vertical Gaussian layer profiles are functions of iy only: hoisting them out of the
      // horizontal loops removes four exp() evaluations per grid point per cell.
      const maxIy = Math.min(ny - 2, Math.ceil((cell.cloudTopM + 900) / grid.dy));
      let anyLayer = false;
      for (let iy = 1; iy <= maxIy; iy++) {
        const wy = grid.gridToWorldY(iy);
        const pMain = Math.exp(-Math.pow((wy - zMainNeg) / 1150.0, 2));
        const pLpcc = Math.exp(-Math.pow((wy - zLPCC) / 850.0, 2));
        const pUpper = Math.exp(-Math.pow((wy - zUpperPos) / 1450.0, 2));
        const pScreen = wy > zScreen - 1700 ? Math.exp(-Math.pow((wy - zScreen) / 550.0, 2)) : 0;
        this.profMain[iy] = cell.mainNegChargeNCm3 * pMain;
        this.profLpcc[iy] = cell.lowerPosChargeNCm3 * pLpcc;
        this.profUpper[iy] = cell.upperPosChargeNCm3 * pUpper;
        this.profScreen[iy] = cell.anvilScreenChargeNCm3 * pScreen;
        if (pMain > 0.02 || pLpcc > 0.02 || pUpper > 0.02 || pScreen > 0.02) anyLayer = true;
      }
      if (!anyLayer) continue;
      for (let iy = maxIy + 1; iy < ny; iy++) {
        this.profMain[iy] = 0;
        this.profLpcc[iy] = 0;
        this.profUpper[iy] = 0;
        this.profScreen[iy] = 0;
      }

      // Core region (main negative + LPCC + upper positive over the tower).
      const coreReach = cell.radiusM * 1.75 + 700;
      const coreMinIx = Math.max(1, grid.worldToGridX(cell.x - coreReach));
      const coreMaxIx = Math.min(nx - 2, grid.worldToGridX(cell.x + coreReach));
      const coreMinIz = Math.max(1, grid.worldToGridZ(cell.z - coreReach));
      const coreMaxIz = Math.min(nz - 2, grid.worldToGridZ(cell.z + coreReach));
      const coreDenom = 1.0 / Math.max(500 * 500, cell.radiusM * cell.radiusM * 1.15);
      const lpccDenom = 1.0 / Math.max(450 * 450, cell.radiusM * cell.radiusM * 0.65);
      const precipX = cell.x + cell.precipCoreOffsetX * 0.5;
      const precipZ = cell.z + cell.precipCoreOffsetZ * 0.5;

      if (coreMinIx < actMinIx) actMinIx = coreMinIx;
      if (coreMaxIx > actMaxIx) actMaxIx = coreMaxIx;
      if (maxIy > actMaxIy) actMaxIy = maxIy;
      if (coreMinIz < actMinIz) actMinIz = coreMinIz;
      if (coreMaxIz > actMaxIz) actMaxIz = coreMaxIz;

      for (let iz = coreMinIz; iz <= coreMaxIz; iz++) {
        const wz = grid.gridToWorldZ(iz);
        const zOff = slice * iz;
        const dzCore = wz - cell.z;
        const dzLpcc = wz - precipZ;
        for (let ix = coreMinIx; ix <= coreMaxIx; ix++) {
          const wx = grid.gridToWorldX(ix);
          const dxCore = wx - cell.x;
          const dxLpcc = wx - precipX;
          const rCoreSq = (dxCore * dxCore + dzCore * dzCore) * coreDenom;
          if (rCoreSq > 3.2) continue;
          const coreHoriz = Math.exp(-rCoreSq);
          const lpccHoriz = Math.exp(-(dxLpcc * dxLpcc + dzLpcc * dzLpcc) * lpccDenom);
          const rowBase = zOff + ix;
          for (let iy = 1; iy <= maxIy; iy++) {
            const q =
              this.profMain[iy] * coreHoriz +
              this.profLpcc[iy] * lpccHoriz +
              this.profUpper[iy] * coreHoriz;
            if (q !== 0) grid.rhoQ[rowBase + nx * iy] += q;
          }
        }
      }

      // Anvil region: upper positive charge and the negative screening layer spread over
      // the glaciated outflow. Vertically thin, so only a few levels are touched.
      if (
        cell.anvilRadiusM > 1200 &&
        (Math.abs(cell.upperPosChargeNCm3) > 0.02 || Math.abs(cell.anvilScreenChargeNCm3) > 0.02)
      ) {
        const anvilShiftX = cell.x + cell.anvilAxisX * cell.anvilRadiusM * 0.42;
        const anvilShiftZ = cell.z + cell.anvilAxisZ * cell.anvilRadiusM * 0.42;
        const anvilDenom = 1.0 / Math.pow(Math.max(500, cell.anvilRadiusM * 0.85), 2);
        const reach = cell.anvilRadiusM * 1.05 + 600;
        const aMinIx = Math.max(1, grid.worldToGridX(anvilShiftX - reach));
        const aMaxIx = Math.min(nx - 2, grid.worldToGridX(anvilShiftX + reach));
        const aMinIz = Math.max(1, grid.worldToGridZ(anvilShiftZ - reach));
        const aMaxIz = Math.min(nz - 2, grid.worldToGridZ(anvilShiftZ + reach));
        const aMinIy = Math.max(1, Math.floor((zScreen - 2200) / grid.dy));
        if (aMinIx < actMinIx) actMinIx = aMinIx;
        if (aMaxIx > actMaxIx) actMaxIx = aMaxIx;
        if (aMinIz < actMinIz) actMinIz = aMinIz;
        if (aMaxIz > actMaxIz) actMaxIz = aMaxIz;

        for (let iy = aMinIy; iy <= maxIy; iy++) {
          const wy = grid.gridToWorldY(iy);
          const upperShape = Math.exp(-Math.pow((wy - zUpperPos) / 1450.0, 2));
          const screenShape = Math.exp(-Math.pow((wy - zScreen) / 550.0, 2));
          const upperQ = cell.upperPosChargeNCm3 * 0.68 * upperShape;
          const screenQ = cell.anvilScreenChargeNCm3 * screenShape;
          if (Math.abs(upperQ) < 1e-4 && Math.abs(screenQ) < 1e-4) continue;
          const rowOff = nx * iy;
          for (let iz = aMinIz; iz <= aMaxIz; iz++) {
            const wz = grid.gridToWorldZ(iz);
            const dAz = wz - anvilShiftZ;
            const base = slice * iz + rowOff;
            for (let ix = aMinIx; ix <= aMaxIx; ix++) {
              const wx = grid.gridToWorldX(ix);
              const dAx = wx - anvilShiftX;
              const rAnvilSq = (dAx * dAx + dAz * dAz) * anvilDenom;
              if (rAnvilSq > 2.4) continue;
              const anvilHoriz = Math.exp(-rAnvilSq * 1.2);
              grid.rhoQ[base + ix] += (upperQ + screenQ) * anvilHoriz;
            }
          }
        }
      }
    }

    // Pad active bounding box by 6 grid cells for smooth electrostatic potential decay
    const bMinIx = Math.max(1, actMinIx - 6);
    const bMaxIx = Math.min(nx - 2, actMaxIx + 6);
    const bMaxIy = Math.min(ny - 2, actMaxIy + 4);
    const bMinIz = Math.max(1, actMinIz - 6);
    const bMaxIz = Math.min(nz - 2, actMaxIz + 6);

    // Warm-started red-black SOR: the potential from the previous solve is an excellent
    // initial guess because charge evolves on a minutes scale, so 8 sweeps converge as well
    // as a cold-started 20 and run at the physics cadence rather than every frame.
    this.solvePoisson3DBounded(grid, 8, bMinIx, bMaxIx, bMaxIy, bMinIz, bMaxIz);

    const candidates: BreakdownCandidate[] = [];
    const MAX_CANDIDATES = 96;
    let bestCandidate: BreakdownCandidate | null = null;
    let maxE = 0;
    let maxRatio = 0;
    let maxPosQ = 0;
    let maxNegQ = 0;
    let netQ = 0;
    const voxelVol = grid.dx * grid.dy * grid.dz;

    for (let iy = 0; iy < ny; iy++) {
      this.eThreshByY[iy] = breakdownThresholdKVm(sounding.densityAt(grid.gridToWorldY(iy)));
    }

    // Grid-index bounding boxes per cell make the "which cell owns this voxel" lookup a
    // handful of integer compares instead of a distance scan over every cell.
    const cellBoxMinIx: number[] = [];
    const cellBoxMaxIx: number[] = [];
    const cellBoxMinIz: number[] = [];
    const cellBoxMaxIz: number[] = [];
    const cellReach: number[] = [];
    for (const c of cells) {
      const reach = Math.max(c.radiusM * 2.0, c.anvilRadiusM * 1.1);
      cellBoxMinIx.push(grid.worldToGridX(c.x - reach));
      cellBoxMaxIx.push(grid.worldToGridX(c.x + reach));
      cellBoxMinIz.push(grid.worldToGridZ(c.z - reach));
      cellBoxMaxIz.push(grid.worldToGridZ(c.z + reach));
      cellReach.push(reach * reach);
    }

    const inv2Dx = 1000.0 / (2.0 * grid.dx);
    const inv2Dy = 1000.0 / (2.0 * grid.dy);
    const inv2Dz = 1000.0 / (2.0 * grid.dz);

    for (let iz = bMinIz; iz <= bMaxIz; iz++) {
      const wz = grid.gridToWorldZ(iz);
      const zOff = slice * iz;
      for (let iy = 1; iy <= bMaxIy; iy++) {
        const wy = grid.gridToWorldY(iy);
        const eThresh = this.eThreshByY[iy];
        const rowOff = zOff + nx * iy;
        for (let ix = bMinIx; ix <= bMaxIx; ix++) {
          const id = rowOff + ix;
          const q = grid.rhoQ[id];
          if (q > maxPosQ) maxPosQ = q;
          if (q < maxNegQ) maxNegQ = q;
          netQ += q * 1e-9 * voxelVol;

          const ex = -(grid.phi[id + 1] - grid.phi[id - 1]) * inv2Dx;
          const ey = -(grid.phi[id + nx] - grid.phi[id - nx]) * inv2Dy;
          const ez = -(grid.phi[id + slice] - grid.phi[id - slice]) * inv2Dz;

          grid.ex[id] = ex;
          grid.ey[id] = ey;
          grid.ez[id] = ez;

          const eMag = Math.sqrt(ex * ex + ey * ey + ez * ez);
          const ratio = eMag / eThresh;

          if (eMag > maxE) maxE = eMag;
          if (ratio > maxRatio) maxRatio = ratio;

          if (eMag > 18.0) {
            const wx = grid.gridToWorldX(ix);
            let bestCell: ConvectiveCell | null = null;
            let bestDist2 = Infinity;
            for (let ci = 0; ci < cells.length; ci++) {
              if (ix < cellBoxMinIx[ci] || ix > cellBoxMaxIx[ci]) continue;
              if (iz < cellBoxMinIz[ci] || iz > cellBoxMaxIz[ci]) continue;
              const c = cells[ci];
              const ddx = wx - c.x;
              const ddz = wz - c.z;
              const d2 = ddx * ddx + ddz * ddz;
              if (d2 < bestDist2 && d2 < cellReach[ci]) {
                bestDist2 = d2;
                bestCell = c;
              }
            }
            if (bestCell) {
              if (eMag > bestCell.peakElectricFieldKVm) bestCell.peakElectricFieldKVm = eMag;
              if (ratio > bestCell.breakdownRatio) bestCell.breakdownRatio = ratio;
            }

            if (ratio >= 1.0) {
              const candidate: BreakdownCandidate = {
                ix,
                iy,
                iz,
                x: wx,
                y: wy,
                z: wz,
                eMagKVm: eMag,
                eThresholdKVm: eThresh,
                ratio,
                ex,
                ey,
                ez,
                localRhoQ: q,
                nearestCell: bestCell,
              };
              if (!bestCandidate || ratio > bestCandidate.ratio) bestCandidate = candidate;
              if (candidates.length < MAX_CANDIDATES) candidates.push(candidate);
            }
          }
        }
      }
    }

    this.maxElectricFieldKVm = maxE;
    this.maxBreakdownRatio = maxRatio;
    this.maxPosChargeNCm3 = maxPosQ;
    this.maxNegChargeNCm3 = maxNegQ;
    this.netAtmosphereChargeC = netQ;

    if (candidates.length > 1) {
      candidates.sort((a, b) => b.ratio - a.ratio);
    }
    // Guarantee the strongest breakdown point survives the collection cap.
    if (bestCandidate && (candidates.length === 0 || candidates[0] !== bestCandidate)) {
      if (candidates.length >= MAX_CANDIDATES) candidates.pop();
      candidates.unshift(bestCandidate);
    }
    this.lastCandidates = candidates;
    return candidates;
  }

  private solvePoisson3DBounded(
    grid: AtmosphericFluidGrid,
    iterations: number,
    minIx: number,
    maxIx: number,
    maxIy: number,
    minIz: number,
    maxIz: number
  ): void {
    const nx = grid.nx;
    const slice = grid.sliceStride;
    const phi = grid.phi;
    const rhoQ = grid.rhoQ;

    const invDx2 = 1.0 / (grid.dx * grid.dx);
    const invDy2 = 1.0 / (grid.dy * grid.dy);
    const invDz2 = 1.0 / (grid.dz * grid.dz);
    const invDenom = 1.0 / (2.0 * (invDx2 + invDy2 + invDz2));
    const sourceFactor = 1e-15 / PHYS.EPSILON_0;
    const omega = 1.64;

    for (let iter = 0; iter < iterations; iter++) {
      const parityPass = iter & 1;
      for (let iz = minIz; iz <= maxIz; iz++) {
        const zOff = slice * iz;
        for (let iy = 1; iy <= maxIy; iy++) {
          const base = zOff + nx * iy;
          let ix = minIx;
          if (((ix + iy + iz + parityPass) & 1) !== 0) ix++;
          for (; ix <= maxIx; ix += 2) {
            const id = base + ix;
            const neighborSum =
              (phi[id - 1] + phi[id + 1]) * invDx2 +
              (phi[id - nx] + phi[id + nx]) * invDy2 +
              (phi[id - slice] + phi[id + slice]) * invDz2;

            const gsVal = (neighborSum + rhoQ[id] * sourceFactor) * invDenom;
            phi[id] = phi[id] + omega * (gsVal - phi[id]);
          }
        }
      }
    }
  }
}
