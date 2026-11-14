import { AtmosphericSounding } from './thermodynamics';
import {
  AtmosphereConfig,
  ColdPool,
  ConvectiveCell,
  DOMAIN_HALF_SIZE,
  DOMAIN_MAX_ALT,
  DOMAIN_SIZE,
} from './types';

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

  // Conservation & CFL diagnostics
  public maxDivergenceResidual = 0;
  public maxCFL = 0;
  public totalCondensateMassKg = 0;
  public domainCloudCoverFraction = 0;
  private hasActiveCondensate = false;
  private hasActiveFlash = false;

  constructor(nx = 48, ny = 28, nz = 48) {
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
    this.hasActiveCondensate = false;
    this.hasActiveFlash = false;
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

  public markFlashActive(): void {
    this.hasActiveFlash = true;
  }

  private structuralTurbulence(x: number, y: number, z: number, phase: number): number {
    const sx = Math.sin(x * 0.00145 + phase * 0.7) * Math.cos(z * 0.00135 - phase * 0.4);
    const sy = Math.sin(y * 0.0019 - phase * 1.1) * Math.cos(x * 0.0023 + z * 0.0021);
    return 0.55 * sx + 0.45 * sy;
  }

  public stepFluidAndCondensate(
    dt: number,
    simTimeSec: number,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    coldPools: ColdPool[],
    _cfg: AtmosphereConfig
  ): void {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const slice = this.sliceStride;
    const inst = sounding.instability;
    const forcingBlend = 1.0 - Math.exp(-Math.min(dt, 2.0) * 0.9);

    for (let iy = 0; iy < ny; iy++) {
      const y = this.gridToWorldY(iy);
      const lvl = sounding.sampleAtAltitude(y);
      this.ambU[iy] = lvl.windU;
      this.ambW[iy] = lvl.windW;
      this.rho0[iy] = lvl.rho;
    }

    // Fused single-pass semi-Lagrangian advection only when condensate exists
    if (this.hasActiveCondensate) {
      this.advectAllCondensatesFused(dt);
    }

    // Advect the previous 3D wind field back through itself, then relax it toward
    // the sounding profile. Convective forcing below modifies this persistent flow.
    this.advectVelocityField(dt);

    // Inject surface Cold Pool outflow winds & gust front convergence
    if (coldPools.length > 0) {
      const maxPoolIy = Math.min(ny - 1, Math.ceil(1600 / this.dy));
      for (const pool of coldPools) {
        const minIx = Math.max(0, this.worldToGridX(pool.x - pool.radiusM - 1400));
        const maxIx = Math.min(nx - 1, this.worldToGridX(pool.x + pool.radiusM + 1400));
        const minIz = Math.max(0, this.worldToGridZ(pool.z - pool.radiusM - 1400));
        const maxIz = Math.min(nz - 1, this.worldToGridZ(pool.z + pool.radiusM + 1400));

        for (let iz = minIz; iz <= maxIz; iz++) {
          const dz = this.gridToWorldZ(iz) - pool.z;
          for (let ix = minIx; ix <= maxIx; ix++) {
            const dx = this.gridToWorldX(ix) - pool.x;
            const r = Math.hypot(dx, dz);
            if (r < 10 || r > pool.radiusM + 1200) continue;

            const radialProfile =
              r <= pool.radiusM
                ? r / pool.radiusM
                : Math.max(0, 1.0 - (r - pool.radiusM) / 1200);
            const outSpeed = pool.expansionSpeedMS * radialProfile;
            const rx = dx / r;
            const rz = dz / r;
            const frontBand = Math.exp(-Math.pow((r - pool.radiusM) / 650.0, 2));

            for (let iy = 0; iy <= maxPoolIy; iy++) {
              const y = this.gridToWorldY(iy);
              if (y > pool.depthM * 1.35) break;
              const vertWeight = Math.max(0, 1.0 - y / (pool.depthM * 1.3));
              const id = ix + nx * iy + slice * iz;
              const targetU = this.ambU[iy] + rx * outSpeed * vertWeight;
              const targetW = this.ambW[iy] + rz * outSpeed * vertWeight;
              const targetV =
                frontBand *
                pool.expansionSpeedMS *
                0.42 *
                Math.sin((y / (pool.depthM * 1.3)) * Math.PI);
              this.u[id] += (targetU - this.u[id]) * forcingBlend;
              this.w[id] += (targetW - this.w[id]) * forcingBlend;
              this.vy[id] += (targetV - this.vy[id]) * forcingBlend;
            }
          }
        }
      }
    }

    // Synthesize 3D Convective Cell Structures into the Eulerian grid
    let anyCellInjected = false;
    for (const cell of cells) {
      if (cell.stage === 'nucleating' && cell.cloudWaterGKg < 0.02) {
        continue;
      }
      anyCellInjected = true;

      const maxReach = Math.max(cell.radiusM * 2.0, cell.anvilRadiusM * 1.2) + 1200;
      const minIx = Math.max(0, this.worldToGridX(cell.x - maxReach));
      const maxIx = Math.min(nx - 1, this.worldToGridX(cell.x + maxReach));
      const minIz = Math.max(0, this.worldToGridZ(cell.z - maxReach));
      const maxIz = Math.min(nz - 1, this.worldToGridZ(cell.z + maxReach));
      const maxIy = Math.min(ny - 1, Math.ceil((cell.cloudTopM + 1000) / this.dy));

      const baseM = cell.cloudBaseM;
      const topM = cell.cloudTopM;
      const cloudDepth = Math.max(250, topM - baseM);
      const anvilStartZ = Math.max(baseM + cloudDepth * 0.62, Math.min(topM - 700, inst.el * 0.78));
      const isSupercell = Math.abs(cell.mesocycloneVorticity) > 0.009;
      const precipTotal = cell.rainGKg + cell.graupelGKg * 0.85 + cell.hailGKg * 1.15;

      for (let iz = minIz; iz <= maxIz; iz++) {
        const wz = this.gridToWorldZ(iz);
        const zStride = slice * iz;
        for (let ix = minIx; ix <= maxIx; ix++) {
          const wx = this.gridToWorldX(ix);

          for (let iy = 0; iy <= maxIy; iy++) {
            const wy = this.gridToWorldY(iy);
            const id = ix + nx * iy + zStride;

            const heightAboveBase = Math.max(0, wy - baseM);
            const shearTilt = Math.min(2600, heightAboveBase * 0.16 * (inst.bulkShear06km / 18.0));
            let coreCenterX = cell.x + cell.anvilAxisX * shearTilt;
            let coreCenterZ = cell.z + cell.anvilAxisZ * shearTilt;

            if (isSupercell && wy > baseM && wy < topM) {
              const twistAngle =
                cell.rotationPhase + heightAboveBase * 0.00055 * Math.sign(cell.mesocycloneVorticity);
              coreCenterX += Math.cos(twistAngle) * cell.radiusM * 0.18;
              coreCenterZ += Math.sin(twistAngle) * cell.radiusM * 0.18;
            }

            const dxCore = wx - coreCenterX;
            const dzCore = wz - coreCenterZ;
            const distCore = Math.hypot(dxCore, dzCore);

            // 1. Convective Updraft Tower
            if (wy >= baseM - 150 && wy <= topM + 200 && distCore < cell.radiusM * 1.55) {
              const zFrac = Math.max(0, Math.min(1, (wy - baseM) / cloudDepth));
              const baseSharpness = Math.min(1.0, Math.max(0, (wy - (baseM - 90)) / 280.0));
              const topTaper =
                wy > inst.el && cell.overshootingTopM > 80
                  ? Math.max(0, 1.0 - (wy - inst.el) / Math.max(400, cell.overshootingTopM + 250)) * 0.62
                  : Math.sin(Math.min(1.0, (1.0 - zFrac) * 2.4) * Math.PI * 0.5);

              const wallCloudLowering =
                isSupercell && distCore < cell.radiusM * 0.58 && wy > baseM - 420 && wy < baseM + 150
                  ? 0.75
                  : 0.0;

              const turbLobe = this.structuralTurbulence(wx, wy, wz, simTimeSec * 0.03 + cell.numericId);
              const localTowerR =
                cell.radiusM *
                (0.72 + 0.34 * Math.sin(zFrac * Math.PI * 0.85) + 0.18 * turbLobe) *
                (wy > inst.el ? Math.max(0.35, topTaper) : 1.0);

              if (distCore < localTowerR * 1.15) {
                const radNorm = distCore / Math.max(200, localTowerR);
                const radialDensity = Math.max(0, 1.0 - radNorm * radNorm);
                const verticalEnvelope = Math.max(wallCloudLowering, baseSharpness * Math.max(0.18, topTaper));

                const liquidProfile =
                  wy < inst.homogeneousFreezeLevel
                    ? Math.max(0, Math.min(1.0, 1.0 - Math.max(0, wy - inst.freezingLevel) / 4500.0))
                    : 0;
                const iceProfile =
                  wy > inst.freezingLevel - 300
                    ? Math.min(1.0, (wy - (inst.freezingLevel - 300)) / 3200.0)
                    : 0;

                const towerLiquid =
                  (cell.cloudWaterGKg + cell.supercooledWaterGKg) *
                  radialDensity *
                  verticalEnvelope *
                  liquidProfile;
                const towerIce =
                  (cell.cloudIceGKg + cell.snowGKg * 0.8) *
                  radialDensity *
                  verticalEnvelope *
                  iceProfile;

                if (towerLiquid > this.qc[id]) this.qc[id] = towerLiquid;
                if (towerIce > this.qi[id]) this.qi[id] = towerIce;

                const updraftCore = cell.updraftMaxMS * radialDensity * Math.sin(zFrac * Math.PI);
                this.vy[id] += (updraftCore - this.vy[id]) * forcingBlend;

                if (isSupercell && distCore > 80) {
                  const vTangential = cell.mesocycloneVorticity * distCore * radialDensity * 0.65;
                  const targetU = this.ambU[iy] + (-dzCore / distCore) * vTangential;
                  const targetW = this.ambW[iy] + (dxCore / distCore) * vTangential;
                  this.u[id] += (targetU - this.u[id]) * forcingBlend;
                  this.w[id] += (targetW - this.w[id]) * forcingBlend;
                }
              }
            }

            // 2. Upper-Tropospheric Anvil Outflow Plume
            if (cell.anvilRadiusM > 600 && wy >= anvilStartZ && wy <= Math.min(topM + 100, inst.el + 450)) {
              const anvilCenterShift = cell.anvilRadiusM * 0.48;
              const dAx = wx - (cell.x + cell.anvilAxisX * anvilCenterShift);
              const dAz = wz - (cell.z + cell.anvilAxisZ * anvilCenterShift);

              const along = dAx * cell.anvilAxisX + dAz * cell.anvilAxisZ;
              const across = -dAx * cell.anvilAxisZ + dAz * cell.anvilAxisX;
              const majorR = cell.anvilRadiusM * 0.92;
              const minorR = Math.max(cell.radiusM * 1.15, cell.anvilRadiusM * 0.56);

              const ellipDistSq = (along * along) / (majorR * majorR) + (across * across) / (minorR * minorR);
              if (ellipDistSq < 1.0) {
                const anvilThickness = Math.max(700, Math.min(2800, topM - anvilStartZ));
                const anvilMidY = anvilStartZ + anvilThickness * 0.58;
                const vertAnvil = Math.exp(-Math.pow((wy - anvilMidY) / (anvilThickness * 0.52), 2));
                const horizAnvil = Math.pow(1.0 - ellipDistSq, 1.35);
                const mammatusMod =
                  wy < anvilMidY && cell.updraftMaxMS > 18
                    ? 0.85 + 0.25 * Math.sin(wx * 0.0035) * Math.sin(wz * 0.0035)
                    : 1.0;

                const anvilIceVal =
                  Math.max(0.45, cell.cloudIceGKg + cell.snowGKg * 0.7) *
                  horizAnvil *
                  vertAnvil *
                  mammatusMod;
                if (anvilIceVal > this.qi[id]) this.qi[id] = anvilIceVal;

                const rAnv = Math.max(200, Math.hypot(dAx, dAz));
                const divSpeed = 6.0 * horizAnvil * vertAnvil;
                const targetU = this.ambU[iy] + (dAx / rAnv) * divSpeed;
                const targetW = this.ambW[iy] + (dAz / rAnv) * divSpeed;
                this.u[id] += (targetU - this.u[id]) * forcingBlend;
                this.w[id] += (targetW - this.w[id]) * forcingBlend;
              }
            }

            // 3. Precipitation Core & Rain Shafts
            if (precipTotal > 0.06 && wy <= baseM + cloudDepth * 0.72) {
              const fallFrac = Math.max(0, Math.min(1, 1.0 - wy / Math.max(600, baseM + 600)));
              const shaftX =
                cell.x + cell.precipCoreOffsetX * (0.4 + 0.6 * fallFrac) - this.ambU[iy] * fallFrac * 18.0;
              const shaftZ =
                cell.z + cell.precipCoreOffsetZ * (0.4 + 0.6 * fallFrac) - this.ambW[iy] * fallFrac * 18.0;
              const dShaft = Math.hypot(wx - shaftX, wz - shaftZ);
              const shaftRadius = Math.max(700, cell.radiusM * 0.72);

              if (dShaft < shaftRadius) {
                const radWeight = Math.pow(1.0 - dShaft / shaftRadius, 1.4);
                const subCloudAtten =
                  wy < baseM
                    ? Math.max(0, 1.0 - cell.virgaFraction * Math.pow(1.0 - wy / Math.max(300, baseM), 1.3))
                    : 1.0;
                const localPrecip = precipTotal * radWeight * subCloudAtten;
                if (localPrecip > this.qr[id]) this.qr[id] = localPrecip;
                const downdraft = -cell.downdraftMaxMS * radWeight * (wy < baseM + 1200 ? 1.0 : 0.55);
                this.vy[id] += (downdraft - this.vy[id]) * forcingBlend;
              }
            }
          }
        }
      }
    }

    // Low-Mach anelastic pressure projection removes non-physical convergence
    // while retaining density-weighted vertical mass continuity.
    this.projectAnelasticVelocity();

    // Decay 3D internal lightning flash illumination when active
    if (this.hasActiveFlash) {
      const flashDecay = Math.exp(-dt * 7.5);
      let maxRem = 0;
      for (let i = 0; i < this.totalCells; i++) {
        const v = this.flashIllum[i] * flashDecay;
        this.flashIllum[i] = v < 0.003 ? 0 : v;
        if (v > maxRem) maxRem = v;
      }
      this.hasActiveFlash = maxRem >= 0.003;
    }

    if (anyCellInjected || this.hasActiveCondensate || this.hasActiveFlash) {
      this.computeDiagnosticsAndPackTexture(dt);
    } else {
      this.maxDivergenceResidual = 0;
      this.maxCFL = Math.min(0.4, (Math.abs(this.ambU[10]) / this.dx) * Math.min(dt, 2.0));
      this.totalCondensateMassKg = 0;
      this.domainCloudCoverFraction = 0;
    }
  }

  private advectVelocityField(dt: number): void {
    const { nx, ny, nz, sliceStride: slice } = this;
    if (!this.velocityInitialized) {
      for (let iz = 0; iz < nz; iz++) {
        const zOff = slice * iz;
        for (let iy = 0; iy < ny; iy++) {
          const row = zOff + nx * iy;
          this.u.fill(this.ambU[iy], row, row + nx);
          this.vy.fill(0, row, row + nx);
          this.w.fill(this.ambW[iy], row, row + nx);
        }
      }
      this.velocityInitialized = true;
      return;
    }

    this.uPrev.set(this.u);
    this.vyPrev.set(this.vy);
    this.wPrev.set(this.w);
    const advDt = Math.min(4, Math.max(0, dt));
    const horizontalDamping = Math.exp(-0.035 * advDt);
    const verticalDamping = Math.exp(-0.13 * advDt);

    for (let iz = 0; iz < nz; iz++) {
      const zOff = slice * iz;
      for (let iy = 0; iy < ny; iy++) {
        const row = zOff + nx * iy;
        for (let ix = 0; ix < nx; ix++) {
          const id = row + ix;
          if (ix === 0 || ix === nx - 1 || iy === 0 || iy === ny - 1 || iz === 0 || iz === nz - 1) {
            this.u[id] = this.ambU[iy];
            this.vy[id] = 0;
            this.w[id] = this.ambW[iy];
            continue;
          }
          const srcX = ix - this.uPrev[id] * advDt / this.dx;
          const srcY = iy - this.vyPrev[id] * advDt / this.dy;
          const srcZ = iz - this.wPrev[id] * advDt / this.dz;
          const advU = this.sampleTrilinear(this.uPrev, srcX, srcY, srcZ);
          const advV = this.sampleTrilinear(this.vyPrev, srcX, srcY, srcZ);
          const advW = this.sampleTrilinear(this.wPrev, srcX, srcY, srcZ);
          const ambientU = this.ambU[iy];
          const ambientW = this.ambW[iy];
          this.u[id] = ambientU + (advU - ambientU) * horizontalDamping;
          this.vy[id] = advV * verticalDamping;
          this.w[id] = ambientW + (advW - ambientW) * horizontalDamping;
        }
      }
    }
  }

  private sampleTrilinear(field: Float32Array, x: number, y: number, z: number): number {
    const x0 = Math.max(0, Math.min(this.nx - 2, Math.floor(x)));
    const y0 = Math.max(0, Math.min(this.ny - 2, Math.floor(y)));
    const z0 = Math.max(0, Math.min(this.nz - 2, Math.floor(z)));
    const fx = Math.max(0, Math.min(1, x - x0));
    const fy = Math.max(0, Math.min(1, y - y0));
    const fz = Math.max(0, Math.min(1, z - z0));
    const i000 = this.idx(x0, y0, z0);
    const i100 = i000 + 1;
    const i010 = i000 + this.nx;
    const i110 = i010 + 1;
    const i001 = i000 + this.sliceStride;
    const i101 = i001 + 1;
    const i011 = i001 + this.nx;
    const i111 = i011 + 1;
    const x00 = field[i000] + (field[i100] - field[i000]) * fx;
    const x10 = field[i010] + (field[i110] - field[i010]) * fx;
    const x01 = field[i001] + (field[i101] - field[i001]) * fx;
    const x11 = field[i011] + (field[i111] - field[i011]) * fx;
    const y0v = x00 + (x10 - x00) * fy;
    const y1v = x01 + (x11 - x01) * fy;
    return y0v + (y1v - y0v) * fz;
  }

  private projectAnelasticVelocity(): void {
    const { nx, ny, nz, sliceStride: slice, dx, dy, dz } = this;
    const invDx2 = 1 / (dx * dx);
    const invDy2 = 1 / (dy * dy);
    const invDz2 = 1 / (dz * dz);
    const denom = 2 * (invDx2 + invDy2 + invDz2);
    this.pressure.fill(0);
    this.pressureNext.fill(0);
    this.divergence.fill(0);

    for (let iz = 1; iz < nz - 1; iz++) {
      const zOff = slice * iz;
      for (let iy = 1; iy < ny - 1; iy++) {
        const row = zOff + nx * iy;
        const rho = Math.max(0.05, this.rho0[iy]);
        for (let ix = 1; ix < nx - 1; ix++) {
          const id = row + ix;
          const horizontalDiv =
            (this.u[id + 1] - this.u[id - 1]) / (2 * dx) +
            (this.w[id + slice] - this.w[id - slice]) / (2 * dz);
          const anelasticVerticalDiv =
            (this.rho0[iy + 1] * this.vy[id + nx] - this.rho0[iy - 1] * this.vy[id - nx]) /
            (2 * dy * rho);
          this.divergence[id] = rho * (horizontalDiv + anelasticVerticalDiv);
        }
      }
    }

    // Red-black style Jacobi pressure solve on the coarse anelastic grid.
    // Six iterations are sufficient to remove the large-scale divergence left by
    // buoyancy and cold-pool forcing without dominating the frame budget.
    for (let iteration = 0; iteration < 6; iteration++) {
      const current = this.pressure;
      const next = this.pressureNext;
      next.fill(0);
      for (let iz = 1; iz < nz - 1; iz++) {
        const zOff = slice * iz;
        for (let iy = 1; iy < ny - 1; iy++) {
          const row = zOff + nx * iy;
          for (let ix = 1; ix < nx - 1; ix++) {
            const id = row + ix;
            const neighbors =
              (current[id - 1] + current[id + 1]) * invDx2 +
              (current[id - nx] + current[id + nx]) * invDy2 +
              (current[id - slice] + current[id + slice]) * invDz2;
            next[id] = (neighbors - this.divergence[id]) / denom;
          }
        }
      }
      this.pressure = next;
      this.pressureNext = current;
    }

    for (let iz = 1; iz < nz - 1; iz++) {
      const zOff = slice * iz;
      for (let iy = 1; iy < ny - 1; iy++) {
        const row = zOff + nx * iy;
        for (let ix = 1; ix < nx - 1; ix++) {
          const id = row + ix;
          const invRho = 1 / Math.max(0.05, this.rho0[iy]);
          this.u[id] -= (this.pressure[id + 1] - this.pressure[id - 1]) * invRho / (2 * dx);
          this.vy[id] -= (this.pressure[id + nx] - this.pressure[id - nx]) * invRho / (2 * dy);
          this.w[id] -= (this.pressure[id + slice] - this.pressure[id - slice]) * invRho / (2 * dz);
        }
      }
    }
  }

  private advectAllCondensatesFused(dt: number): void {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const slice = this.sliceStride;

    this.qcPrev.set(this.qc);
    this.qiPrev.set(this.qi);
    this.qrPrev.set(this.qr);

    const clampDt = Math.min(dt, 8.0);
    const invDx = clampDt / this.dx;
    const invDy = clampDt / this.dy;
    const invDz = clampDt / this.dz;

    for (let iz = 1; iz < nz - 1; iz++) {
      const zOff = slice * iz;
      for (let iy = 1; iy < ny - 1; iy++) {
        const base = zOff + nx * iy;
        for (let ix = 1; ix < nx - 1; ix++) {
          const id = base + ix;
          const srcX = ix - this.u[id] * invDx;
          const srcY = iy - this.vy[id] * invDy;
          const srcZ = iz - this.w[id] * invDz;

          const x0 = srcX < 0 ? 0 : srcX > nx - 2 ? nx - 2 : srcX | 0;
          const y0 = srcY < 0 ? 0 : srcY > ny - 2 ? ny - 2 : srcY | 0;
          const z0 = srcZ < 0 ? 0 : srcZ > nz - 2 ? nz - 2 : srcZ | 0;

          const fx = srcX - x0 < 0 ? 0 : srcX - x0 > 1 ? 1 : srcX - x0;
          const fy = srcY - y0 < 0 ? 0 : srcY - y0 > 1 ? 1 : srcY - y0;
          const fz = srcZ - z0 < 0 ? 0 : srcZ - z0 > 1 ? 1 : srcZ - z0;

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
            (this.qcPrev[i000] * w000 +
              this.qcPrev[i100] * w100 +
              this.qcPrev[i010] * w010 +
              this.qcPrev[i110] * w110 +
              this.qcPrev[i001] * w001 +
              this.qcPrev[i101] * w101 +
              this.qcPrev[i011] * w011 +
              this.qcPrev[i111] * w111) *
            0.965;
          this.qc[id] = nextQc < 0.003 ? 0 : nextQc;

          const nextQi =
            (this.qiPrev[i000] * w000 +
              this.qiPrev[i100] * w100 +
              this.qiPrev[i010] * w010 +
              this.qiPrev[i110] * w110 +
              this.qiPrev[i001] * w001 +
              this.qiPrev[i101] * w101 +
              this.qiPrev[i011] * w011 +
              this.qiPrev[i111] * w111) *
            0.985;
          this.qi[id] = nextQi < 0.003 ? 0 : nextQi;

          const nextQr =
            (this.qrPrev[i000] * w000 +
              this.qrPrev[i100] * w100 +
              this.qrPrev[i010] * w010 +
              this.qrPrev[i110] * w110 +
              this.qrPrev[i001] * w001 +
              this.qrPrev[i101] * w101 +
              this.qrPrev[i011] * w011 +
              this.qrPrev[i111] * w111) *
            0.92;
          this.qr[id] = nextQr < 0.003 ? 0 : nextQr;
        }
      }
    }
  }

  private computeDiagnosticsAndPackTexture(dt: number): void {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const slice = this.sliceStride;
    const cellVol = this.dx * this.dy * this.dz;

    let maxDiv = 0;
    let maxSpeedRatio = 0;
    let totalMass = 0;
    let cloudyColumns = 0;
    let anyCond = false;

    for (let iz = 0; iz < nz; iz++) {
      const zOff = slice * iz;
      for (let ix = 0; ix < nx; ix++) {
        let colHasCloud = false;
        for (let iy = 0; iy < ny; iy++) {
          const id = zOff + nx * iy + ix;
          const qcVal = this.qc[id];
          const qiVal = this.qi[id];
          const qrVal = this.qr[id];
          const totCond = qcVal + qiVal;

          if (totCond > 0.004 || qrVal > 0.004) anyCond = true;
          if (totCond > 0.08) colHasCloud = true;
          totalMass += (totCond + qrVal) * 0.001 * this.rho0[iy] * cellVol;

          if (
            ix > 0 &&
            ix < nx - 1 &&
            iy > 0 &&
            iy < ny - 1 &&
            iz > 0 &&
            iz < nz - 1 &&
            (ix + iy + iz) % 7 === 0
          ) {
            const dudx = (this.u[id + 1] - this.u[id - 1]) / (2.0 * this.dx);
            const dwdz = (this.w[id + slice] - this.w[id - slice]) / (2.0 * this.dz);
            const dvydy =
              (this.rho0[iy + 1] * this.vy[id + nx] - this.rho0[iy - 1] * this.vy[id - nx]) /
              (2.0 * this.dy * this.rho0[iy]);
            const div = Math.abs(dudx + dwdz + dvydy);
            if (div > maxDiv) maxDiv = div;

            const cfl =
              (Math.abs(this.u[id]) / this.dx +
                Math.abs(this.vy[id]) / this.dy +
                Math.abs(this.w[id]) / this.dz) *
              Math.min(dt, 2.0);
            if (cfl > maxSpeedRatio) maxSpeedRatio = cfl;
          }

          const texIdx = id * 4;
          const flash = this.flashIllum[id];
          if (totCond < 0.008 && qrVal < 0.01 && flash < 0.005) {
            this.volTexData[texIdx] = 0;
            this.volTexData[texIdx + 1] = 0;
            this.volTexData[texIdx + 2] = 0;
            this.volTexData[texIdx + 3] = 0;
          } else {
            const normCloud = Math.min(1.0, Math.pow(totCond / 3.2, 0.72));
            const normPrecip = Math.min(1.0, Math.pow(qrVal / 3.8, 0.78));
            const iceFrac = totCond > 0.005 ? Math.min(1.0, qiVal / totCond) : 0.0;
            const normFlash = Math.min(1.0, flash);

            this.volTexData[texIdx] = (normCloud * 255) | 0;
            this.volTexData[texIdx + 1] = (normPrecip * 255) | 0;
            this.volTexData[texIdx + 2] = (iceFrac * 255) | 0;
            this.volTexData[texIdx + 3] = (normFlash * 255) | 0;
          }
        }
        if (colHasCloud) cloudyColumns++;
      }
    }

    this.hasActiveCondensate = anyCond;
    this.maxDivergenceResidual = maxDiv;
    this.maxCFL = Math.min(0.95, maxSpeedRatio);
    this.totalCondensateMassKg = totalMass;
    this.domainCloudCoverFraction = cloudyColumns / (nx * nz);
  }
}
