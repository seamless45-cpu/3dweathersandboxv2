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

  public reset(): void {
    this.maxElectricFieldKVm = 0;
    this.maxBreakdownRatio = 0;
    this.maxPosChargeNCm3 = 0;
    this.maxNegChargeNCm3 = 0;
    this.netAtmosphereChargeC = 0;
    this.cumulativeGroundTransferredC = 0;
    this.hadPotentialLastStep = false;
  }

  public step(
    dt: number,
    grid: AtmosphericFluidGrid,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    cfg: AtmosphereConfig
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
        const temperatureWindow = Math.exp(-Math.pow((mixedPhaseTemperatureK - 258.15) / 17.0, 2));
        const collisionKernel =
          cell.graupelGKg *
          cell.cloudIceGKg *
          Math.min(2.4, 0.28 + cell.supercooledWaterGKg * 1.55) *
          Math.min(2.8, cell.updraftMaxMS / 10.0) *
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
        const dqTotal = 0.115 * collisionKernel * dt;
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
      return [];
    }

    this.hadPotentialLastStep = true;
    grid.rhoQ.fill(0);

    const nx = grid.nx;
    const ny = grid.ny;
    const nz = grid.nz;
    const slice = grid.sliceStride;

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

      const maxR = Math.max(cell.radiusM * 1.6, cell.anvilRadiusM * 1.05) + 900;
      const minIx = Math.max(1, grid.worldToGridX(cell.x - maxR));
      const maxIx = Math.min(nx - 2, grid.worldToGridX(cell.x + maxR));
      const minIz = Math.max(1, grid.worldToGridZ(cell.z - maxR));
      const maxIz = Math.min(nz - 2, grid.worldToGridZ(cell.z + maxR));
      const maxIy = Math.min(ny - 2, Math.ceil((cell.cloudTopM + 900) / grid.dy));

      if (minIx < actMinIx) actMinIx = minIx;
      if (maxIx > actMaxIx) actMaxIx = maxIx;
      if (maxIy > actMaxIy) actMaxIy = maxIy;
      if (minIz < actMinIz) actMinIz = minIz;
      if (maxIz > actMaxIz) actMaxIz = maxIz;

      const zLPCC = Math.max(cell.cloudBaseM + 400, inst.freezingLevel - 500);
      const zMainNeg = inst.freezingLevel + 2100;
      const zUpperPos = Math.min(cell.cloudTopM - 600, inst.freezingLevel + 5200);
      const zScreen = cell.cloudTopM;

      const coreDenom = Math.max(500 * 500, cell.radiusM * cell.radiusM * 1.15);
      const lpccDenom = Math.max(450 * 450, cell.radiusM * cell.radiusM * 0.65);
      const anvilShiftX = cell.x + cell.anvilAxisX * cell.anvilRadiusM * 0.42;
      const anvilShiftZ = cell.z + cell.anvilAxisZ * cell.anvilRadiusM * 0.42;
      const anvilDenom = Math.pow(Math.max(500, cell.anvilRadiusM * 0.85), 2);
      const precipX = cell.x + cell.precipCoreOffsetX * 0.5;
      const precipZ = cell.z + cell.precipCoreOffsetZ * 0.5;

      for (let iz = minIz; iz <= maxIz; iz++) {
        const wz = grid.gridToWorldZ(iz);
        const zOff = slice * iz;
        for (let ix = minIx; ix <= maxIx; ix++) {
          const wx = grid.gridToWorldX(ix);

          const dxCore = wx - cell.x;
          const dzCore = wz - cell.z;
          const rCoreSq = (dxCore * dxCore + dzCore * dzCore) / coreDenom;

          const rAnvilSq =
            cell.anvilRadiusM > 1200
              ? (Math.pow(wx - anvilShiftX, 2) + Math.pow(wz - anvilShiftZ, 2)) / anvilDenom
              : 99.0;

          if (rCoreSq > 2.6 && rAnvilSq > 1.8) continue;

          const coreHoriz = Math.exp(-rCoreSq);
          const anvilHoriz = rAnvilSq < 1.8 ? Math.exp(-rAnvilSq * 1.2) : 0;
          const lpccHoriz = Math.exp(
            -(Math.pow(wx - precipX, 2) + Math.pow(wz - precipZ, 2)) / lpccDenom
          );
          const upperHoriz = Math.max(coreHoriz, anvilHoriz * 0.68);

          for (let iy = 1; iy <= maxIy; iy++) {
            const wy = grid.gridToWorldY(iy);
            let q =
              cell.mainNegChargeNCm3 *
                coreHoriz *
                Math.exp(-Math.pow((wy - zMainNeg) / 1150.0, 2)) +
              cell.lowerPosChargeNCm3 *
                lpccHoriz *
                Math.exp(-Math.pow((wy - zLPCC) / 850.0, 2)) +
              cell.upperPosChargeNCm3 *
                upperHoriz *
                Math.exp(-Math.pow((wy - zUpperPos) / 1450.0, 2));

            if (anvilHoriz > 0.05) {
              q +=
                cell.anvilScreenChargeNCm3 *
                anvilHoriz *
                Math.exp(-Math.pow((wy - zScreen) / 550.0, 2));
            }

            grid.rhoQ[zOff + nx * iy + ix] += q;
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

    this.solvePoisson3DBounded(grid, 10, bMinIx, bMaxIx, bMaxIy, bMinIz, bMaxIz);

    const candidates: BreakdownCandidate[] = [];
    let maxE = 0;
    let maxRatio = 0;
    let maxPosQ = 0;
    let maxNegQ = 0;
    let netQ = 0;
    const voxelVol = grid.dx * grid.dy * grid.dz;

    for (let iy = 0; iy < ny; iy++) {
      const lvl = sounding.sampleAtAltitude(grid.gridToWorldY(iy));
      this.eThreshByY[iy] = breakdownThresholdKVm(lvl.rho);
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

          const eMag = Math.hypot(ex, ey, ez);
          const ratio = eMag / eThresh;

          if (eMag > maxE) maxE = eMag;
          if (ratio > maxRatio) maxRatio = ratio;

          if (eMag > 18.0) {
            const wx = grid.gridToWorldX(ix);
            let bestCell: ConvectiveCell | null = null;
            let bestDist = 18000;
            for (const c of cells) {
              const d = Math.hypot(wx - c.x, wz - c.z);
              if (d < bestDist) {
                bestDist = d;
                bestCell = c;
              }
            }
            if (bestCell && bestDist < Math.max(bestCell.radiusM * 2.0, bestCell.anvilRadiusM * 1.1)) {
              if (eMag > bestCell.peakElectricFieldKVm) bestCell.peakElectricFieldKVm = eMag;
              if (ratio > bestCell.breakdownRatio) bestCell.breakdownRatio = ratio;
            }

            if (ratio >= 1.0) {
              candidates.push({
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
              });
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
