import {
  AtmosphericElectrificationEngine,
  BreakdownCandidate,
  breakdownThresholdKVm,
} from './electrification';
import { AtmosphericFluidGrid } from './fluidGrid';
import { LightningRod } from './lightningRod';
import { getTerrainHeight } from './terrainField';
import { AtmosphericSounding } from './thermodynamics';
import {
  ActiveLightningDischarge,
  ActiveTLEEvent,
  ConvectiveCell,
  DischargePolarity,
  DOMAIN_HALF_SIZE,
  EventMonitorRecord,
  LightningClassification,
  LightningSegment,
  TLEClassification,
} from './types';

export class AutonomousLightningEngine {
  public activeDischarges: ActiveLightningDischarge[] = [];
  public activeTLEs: ActiveTLEEvent[] = [];
  public eventHistory: EventMonitorRecord[] = [];
  public totalFlashes = 0;
  public totalTLEs = 0;

  private nextFlashNum = 1;
  private nextTLENum = 1;
  private rngState = 987654321;
  private jetCooldownByCell = new Map<string, number>();
  /** Grounded rod, when the coordinator supplies one, so discharges can be intercepted. */
  private rod: LightningRod | null = null;
  private rodSimTime = 0;
  /** Flashes whose descending leader terminated on the rod rather than on open ground. */
  public rodInterceptedFlashes = 0;
  /** Discharges whose attachment point the rod bent toward itself, including full captures. */
  public rodAttractions = 0;
  /** Upward flashes the rod initiated itself, without an incoming descending leader. */
  public rodUpwardFlashes = 0;
  private lastRodUpwardLeaders = 0;

  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState >>> 0) / 4294967295.0;
  }

  public reset(): void {
    this.activeDischarges = [];
    this.activeTLEs = [];
    this.eventHistory = [];
    this.totalFlashes = 0;
    this.totalTLEs = 0;
    this.nextFlashNum = 1;
    this.nextTLENum = 1;
    this.rngState = 987654321;
    this.lastRodUpwardLeaders = 0;
    this.rodAttractions = 0;
    this.rodInterceptedFlashes = 0;
    this.rodUpwardFlashes = 0;
    this.jetCooldownByCell.clear();
  }

  /**
   * Evaluates physical breakdown candidates from the 3D E-field solver to initiate
   * autonomous lightning discharges and cloud-top stratospheric jets, and advances
   * real-time millisecond temporal phases of active flashes and TLEs.
   */
  public step(
    simDtSec: number,
    realDtMs: number,
    simTimeSec: number,
    candidates: BreakdownCandidate[],
    grid: AtmosphericFluidGrid,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    elec: AtmosphericElectrificationEngine,
    rod: LightningRod | null = null,
    simTimeForRod = 0
  ): void {
    this.rod = rod;
    this.rodSimTime = simTimeForRod;

    // 1. Advance active lightning discharge temporal phases (in real visual milliseconds so flashes look authentic at any sim speed!)
    this.updateActiveDischarges(realDtMs, simTimeSec, grid);

    // 2. Advance active Upper-Atmospheric TLEs (Sprites, Halos, Jets, ELVES)
    this.updateActiveTLEs(realDtMs);

    // 3. Autonomous Lightning Initiation strictly from 3D Dielectric Breakdown Candidates (|E| >= E_init(z))
    if (candidates.length > 0 && this.activeDischarges.length < 5) {
      // Initiate at most 1-2 independent breakdowns per step from distinct spatial regions
      let initiatedThisStep = 0;
      for (const cand of candidates) {
        if (initiatedThisStep >= 2) break;
        // Avoid initiating right inside an already active plasma channel
        const tooCloseToActive = this.activeDischarges.some(
          (d) =>
            Math.hypot(d.initPoint[0] - cand.x, d.initPoint[2] - cand.z) < 2600 &&
            d.ageRealMs < 140
        );
        if (tooCloseToActive) continue;

        this.initiateAutonomousDischarge(cand, simTimeSec, grid, sounding, cells, elec);
        initiatedThisStep++;
      }
    }

    // 3b. Rod-triggered upward lightning.
    // Tall grounded structures do not merely wait to be struck: once the enhanced tip field
    // passes corona onset the mast launches its own upward leader, and if that leader finds a
    // charge centre overhead it completes a full discharge. This is the dominant flash mechanism
    // for tall towers and is why the rod is an active participant in the storm rather than a
    // passive ornament that only matters on the rare overhead strike.
    if (this.rod && this.rod.upwardLeaders > this.lastRodUpwardLeaders) {
      this.lastRodUpwardLeaders = this.rod.upwardLeaders;
      this.tryInitiateRodUpwardDischarge(grid, sounding, cells, elec, simTimeSec);
    } else if (this.rod) {
      this.lastRodUpwardLeaders = this.rod.upwardLeaders;
    }

    // 4. Evaluate Autonomous Cloud-Top Stratospheric Breakdown (Blue Jets & Gigantic Jets)
    this.evaluateCloudTopJets(simDtSec, simTimeSec, cells, elec);
  }

  /**
   * Attempts to complete an upward discharge from the rod into a charge centre overhead.
   *
   * The upward leader only connects if there is genuinely charge to connect to: a cell close
   * enough horizontally that its charge centre is within the leader's propagation distance, and
   * carrying enough charge to sustain the channel. Without that the leader just corona-discharges
   * and dies, which is what happens most of the time and is counted separately by the rod.
   */
  private tryInitiateRodUpwardDischarge(
    grid: AtmosphericFluidGrid,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    elec: AtmosphericElectrificationEngine,
    simTimeSec: number
  ): void {
    const rod = this.rod;
    if (!rod || this.activeDischarges.length >= 5) return;

    // Nearest cell whose charge centre the leader can actually reach. An upward leader from a
    // ~170 m mast propagates on the order of a kilometre or two before it either connects or
    // stalls, so a cell several kilometres off to the side will not be tapped.
    let best: ConvectiveCell | null = null;
    let bestDist = Infinity;
    for (const cell of cells) {
      if (cell.stage === 'nucleating') continue;
      const horiz = Math.hypot(cell.x - rod.x, cell.z - rod.z);
      // Reach grows with the cell's own footprint: a wide, close cell base is easier to connect to.
      const reach = 2600 + cell.radiusM * 0.55;
      if (horiz > reach) continue;
      const charge = Math.max(
        Math.abs(cell.mainNegChargeNCm3),
        Math.abs(cell.lowerPosChargeNCm3),
        Math.abs(cell.upperPosChargeNCm3) * 0.7
      );
      // Needs real charge overhead, not a dissipating remnant.
      if (charge < 0.55) continue;
      if (horiz < bestDist) {
        bestDist = horiz;
        best = cell;
      }
    }
    if (!best) return;

    const ix = Math.max(1, Math.min(grid.nx - 2, grid.worldToGridX(rod.x)));
    const iy = Math.max(1, Math.min(grid.ny - 2, grid.worldToGridY(rod.tipY)));
    const iz = Math.max(1, Math.min(grid.nz - 2, grid.worldToGridZ(rod.z)));
    const id = grid.idx(ix, iy, iz);
    const eMag = Math.hypot(grid.ex[id], grid.ey[id], grid.ez[id]);
    // Same density-scaled threshold the field sweep uses, recomputed here because the engine's
    // per-level table is private to it.
    const thresh = breakdownThresholdKVm(sounding.densityAt(grid.gridToWorldY(iy)));

    const cand: BreakdownCandidate = {
      ix,
      iy,
      iz,
      x: rod.x,
      y: rod.tipY,
      z: rod.z,
      eMagKVm: eMag,
      eThresholdKVm: thresh,
      ratio: eMag / Math.max(1, thresh),
      ex: grid.ex[id],
      ey: grid.ey[id],
      ez: grid.ez[id],
      localRhoQ: grid.rhoQ[id],
      nearestCell: best,
    };

    this.rodUpwardFlashes++;
    this.initiateAutonomousDischarge(cand, simTimeSec, grid, sounding, cells, elec, true);
  }

  private initiateAutonomousDischarge(
    cand: BreakdownCandidate,
    simTimeSec: number,
    grid: AtmosphericFluidGrid,
    sounding: AtmosphericSounding,
    cells: ConvectiveCell[],
    elec: AtmosphericElectrificationEngine,
    rodUpward = false
  ): void {
    const cell = cand.nearestCell;
    const initX = cand.x;
    const initY = cand.y;
    const initZ = cand.z;

    // Determine physical charge tapping & potential gradient direction at breakdown point
    const ix0 = cand.ix;
    const iy0 = cand.iy;
    const iz0 = cand.iz;
    const localPhi = grid.phi[grid.idx(ix0, iy0, iz0)];
    const terrainYBelow = getTerrainHeight(initX, initZ);

    // Check elevated terrain upward-initiated condition vs cloud-initiated condition
    // A rod-initiated upward flash follows the same physics as one off an elevated terrain
    // ridge: the leader starts at a grounded conductor and propagates up into cloud charge.
    const isElevatedTerrainUpward =
      rodUpward ||
      (terrainYBelow > 135 &&
      initY < terrainYBelow + 1400 &&
      Math.abs(cand.ey) > 95 &&
      cell !== null &&
      cell.anvilRadiusM > 3200);

    const segments: LightningSegment[] = [];
    let branchCount = 0;

    let termX = initX;
    let termY = initY;
    let termZ = initZ;
    let exitedCloudMidPath = false;
    let enteredSecondCell: ConvectiveCell | null = null;
    let hitGround = false;

    if (isElevatedTerrainUpward && cell) {
      // Upward leader initiating from a grounded conductor -- tall terrain ridge, or the rod --
      // propagating up into the charged cloud base or anvil.
      const startGroundY = rodUpward && this.rod ? this.rod.tipY : terrainYBelow;
      const targetY = Math.min(cell.cloudTopM - 800, sounding.instability.freezingLevel + 2400);
      const targetX = cell.x + (this.rand() - 0.5) * cell.radiusM * 1.2;
      const targetZ = cell.z + (this.rand() - 0.5) * cell.radiusM * 1.2;

      const res = this.grow3DLeaderTree(
        [initX, startGroundY, initZ],
        [targetX, targetY, targetZ],
        grid,
        true,
        false
      );
      segments.push(...res.segments);
      branchCount = res.branchCount;
      termX = res.endPoint[0];
      termY = res.endPoint[1];
      termZ = res.endPoint[2];
    } else {
      // Guided by 3D potential field & charge layers around initiation voxel:
      // Decide target sink physically from actual charge geometry rather than random type selection!
      const lpccStrength = cell ? cell.lowerPosChargeNCm3 : 0;
      const upperPosStrength = cell ? cell.upperPosChargeNCm3 : 0;
      const mainNegStrength = cell ? Math.abs(cell.mainNegChargeNCm3) : 0;
      const anvilRadius = cell ? cell.anvilRadiusM : 0;

      // Check neighboring cell proximity for natural Cloud-to-Cloud potential difference
      let neighborCell: ConvectiveCell | null = null;
      if (cell) {
        for (const other of cells) {
          if (other.id === cell.id || other.stage === 'nucleating') continue;
          const dist = Math.hypot(other.x - cell.x, other.z - cell.z);
          if (dist < cell.radiusM + other.radiusM + 4800 && Math.abs(other.upperPosChargeNCm3) > 0.8) {
            neighborCell = other;
            break;
          }
        }
      }

      let targetX = initX;
      let targetY = initY;
      let targetZ = initZ;
      let allowGroundStrike = false;
      let isAnvilHorizontal = false;
      let interceptedByRod = false;

      // Ground-directed potential gradient, evaluated FIRST. The intra-cloud sinks below are
      // only reached when this does not hold, which is what "exceeds intra-cloud sink" means --
      // the previous branch order evaluated them the other way round, so a strongly vertical
      // field was always captured as a cloud-to-cloud or anvil-crawler flash and neither
      // polarity of cloud-to-ground could be reached from the upper part of the cloud.
      //
      // (-CG) route. A leader's propagation direction is set by the enormous field enhancement
      // at its own tip, not by the ambient field at the point where breakdown first occurred, so
      // the right question is *which charge centre the discharge taps*. The previous gate asked
      // for an upward ambient field (cand.ey > 0), which only exists BELOW the main negative
      // centre -- and with the density-scaled breakdown threshold plus the shielding lower
      // positive charge, essentially no candidates form there: 10 of 1214 sampled initiations.
      // That is why Negative CG (-CG) stayed at zero even after the charge tripole was fixed.
      // Tapping the main negative layer from at or below its top, with a negative potential and
      // an LPCC too weak to short the channel out, is the physically meaningful condition.
      const zMainNeg = sounding.instability.freezingLevel + 2100;
      const groundDirectedNegative =
        localPhi < -8.0 && initY < zMainNeg + 1400 && lpccStrength < mainNegStrength * 0.52;
      // (+CG) route: positive space charge with a downward-pointing field, i.e. the upper
      // positive centre or the downshear anvil overhang.
      // Threshold is deliberately above the diffuse anvil fringe: a (+CG) needs a genuine upper
      // positive charge centre. Measured over 22000-frame storms, 0.12 let the spread-out anvil
      // charge qualify too often (34% of CG flashes were +CG, against ~5-10% observed) and 0.25
      // shut the route off entirely (+CG = 0). 0.17 lands between them.
      const groundDirectedPositive =
        cand.localRhoQ > 0.17 && cand.ey < 0.0 && initY > sounding.instability.freezingLevel + 1500;
      const groundDirectedLow = initY < sounding.instability.freezingLevel + 600;
      // A genuinely ground-directed gradient takes precedence over the horizontally-driven
      // intra-cloud modes; weakly-directed cases do not, so anvil crawlers and CC flashes keep
      // their variety.
      const strongGroundDirected =
        groundDirectedNegative || (groundDirectedPositive && cand.ey < -8.0);

      if (
        !strongGroundDirected &&
        cell &&
        anvilRadius > 4600 &&
        initY > sounding.instability.freezingLevel + 2600 &&
        Math.abs(cell.anvilScreenChargeNCm3) > 0.32 &&
        Math.abs(cand.ex) + Math.abs(cand.ez) > Math.abs(cand.ey) * 0.48
      ) {
        // Stratified horizontal anvil electric field drives extensive Anvil Crawler / Spider discharge!
        isAnvilHorizontal = true;
        const crawlDist = Math.min(12500, anvilRadius * (0.75 + 0.35 * this.rand()));
        const spreadAngle = Math.atan2(cell.anvilAxisZ, cell.anvilAxisX) + (this.rand() - 0.5) * 0.65;
        targetX = cell.x + Math.cos(spreadAngle) * crawlDist;
        targetZ = cell.z + Math.sin(spreadAngle) * crawlDist;
        targetY = initY + (this.rand() - 0.5) * 900;
      } else if (
        !strongGroundDirected &&
        neighborCell &&
        initY > sounding.instability.freezingLevel + 1200 &&
        Math.hypot(cand.ex, cand.ez) > Math.abs(cand.ey) * 0.52
      ) {
        // Inter-cell horizontal potential gradient drives Cloud-to-Cloud (CC) discharge!
        enteredSecondCell = neighborCell;
        targetX = neighborCell.x + (this.rand() - 0.5) * neighborCell.radiusM * 0.6;
        targetZ = neighborCell.z + (this.rand() - 0.5) * neighborCell.radiusM * 0.6;
        targetY = Math.max(neighborCell.cloudBaseM + 900, initY + (this.rand() - 0.5) * 1800);
      } else if (groundDirectedNegative || groundDirectedPositive || groundDirectedLow) {
        allowGroundStrike = true;
        // Bolt-from-the-Blue emerges naturally when initiated near upper/mid lateral boundary of sheared tower!
        const lateralDistFromCore = cell ? Math.hypot(initX - cell.x, initZ - cell.z) : 0;
        if (
          cell &&
          initY > sounding.instability.freezingLevel + 1500 &&
          lateralDistFromCore > cell.radiusM * 0.68 &&
          localPhi < 0
        ) {
          const outDir = Math.atan2(initZ - cell.z, initX - cell.x);
          const jumpOut = cell.radiusM + 2400 + this.rand() * 2400;
          targetX = cell.x + Math.cos(outDir) * jumpOut;
          targetZ = cell.z + Math.sin(outDir) * jumpOut;
          exitedCloudMidPath = true;
        } else if (localPhi > 0 && cell && cell.anvilRadiusM > 3000) {
          // Positive CG often originates from downshear overhanging positive anvil or tilted core!
          targetX = initX + cell.anvilAxisX * (1200 + this.rand() * 2500);
          targetZ = initZ + cell.anvilAxisZ * (1200 + this.rand() * 2500);
        } else {
          targetX = initX + (this.rand() - 0.5) * 2200;
          targetZ = initZ + (this.rand() - 0.5) * 2200;
        }
        targetX = Math.max(-DOMAIN_HALF_SIZE + 800, Math.min(DOMAIN_HALF_SIZE - 800, targetX));
        targetZ = Math.max(-DOMAIN_HALF_SIZE + 800, Math.min(DOMAIN_HALF_SIZE - 800, targetZ));

        // ---- Rod attraction ------------------------------------------------------------
        // On this terrain the mast is by far the most elevated grounded conductor for
        // kilometres, so it wins the attachment point whenever the leader is committed anywhere
        // in its neighbourhood. The pull is partial and falls off with distance, so far strokes
        // are barely deflected while near ones terminate on the rod outright. A nominal 30 kA
        // first-stroke current sets the electro-geometric scale.
        if (this.rod) {
          const steered = this.rod.steerGroundTarget(targetX, targetZ, 30.0);
          const moved = Math.hypot(steered.x - targetX, steered.z - targetZ) > 1.0;
          targetX = Math.max(-DOMAIN_HALF_SIZE + 800, Math.min(DOMAIN_HALF_SIZE - 800, steered.x));
          targetZ = Math.max(-DOMAIN_HALF_SIZE + 800, Math.min(DOMAIN_HALF_SIZE - 800, steered.z));
          if (steered.captured) {
            // Aimed exactly at the tip: the march ends on the mast, not on the ground beside it.
            targetX = this.rod.x;
            targetZ = this.rod.z;
            interceptedByRod = true;
          }
          if (moved || interceptedByRod) this.rodAttractions++;
        }
        targetY = interceptedByRod && this.rod
          ? this.rod.tipY
          : getTerrainHeight(targetX, targetZ);
      } else {
        // Intracloud or Cloud-to-Air discharge governed by dipole/tripole charge centers
        if (cell) {
          const goUpToUpperPos =
            upperPosStrength >= lpccStrength * 1.15 && initY < cell.cloudTopM - 1600;
          if (goUpToUpperPos) {
            targetY = Math.min(cell.cloudTopM - 450, initY + 2400 + this.rand() * 2800);
            targetX = cell.x + cell.anvilAxisX * (800 + this.rand() * 2200) + (this.rand() - 0.5) * cell.radiusM;
            targetZ = cell.z + cell.anvilAxisZ * (800 + this.rand() * 2200) + (this.rand() - 0.5) * cell.radiusM;
          } else if (lpccStrength > 0.35 && initY > cell.cloudBaseM + 1000) {
            targetY = Math.max(cell.cloudBaseM + 250, sounding.instability.freezingLevel - 600);
            targetX = cell.x + cell.precipCoreOffsetX * 0.6 + (this.rand() - 0.5) * cell.radiusM * 0.8;
            targetZ = cell.z + cell.precipCoreOffsetZ * 0.6 + (this.rand() - 0.5) * cell.radiusM * 0.8;
          } else {
            // Lateral gradient into surrounding clear air (Cloud-to-Air!)
            const angle = this.rand() * Math.PI * 2;
            const outDist = cell.radiusM * 1.45 + 1400;
            targetX = cell.x + Math.cos(angle) * outDist;
            targetZ = cell.z + Math.sin(angle) * outDist;
            targetY = initY + (this.rand() - 0.4) * 1400;
          }
        }
      }

      const res = this.grow3DLeaderTree(
        [initX, initY, initZ],
        [targetX, targetY, targetZ],
        grid,
        false,
        isAnvilHorizontal,
        allowGroundStrike,
        interceptedByRod
      );
      if (res.rodAttached) {
        interceptedByRod = true;
        this.rod!.markIntercept(this.rodSimTime);
      }
      segments.push(...res.segments);
      branchCount = res.branchCount;
      termX = res.endPoint[0];
      termY = res.endPoint[1];
      termZ = res.endPoint[2];

      const groundAtTerm = getTerrainHeight(termX, termZ);
      // A rod interception terminates at the mast tip, which sits heightM above the terrain, so
      // allow the attachment test to reach up the mast rather than only to the bare ground.
      const attachReach = interceptedByRod && this.rod ? this.rod.heightM + 240 : 240;
      if (allowGroundStrike && termY <= groundAtTerm + attachReach) {
        hitGround = true;
        if (interceptedByRod) this.rodInterceptedFlashes++;
        // Upward connecting leader rising to meet the downward stepped leader. On a rod
        // interception this segment *is* the mast, so it is drawn straight and heavy instead of
        // jittered -- a solid grounded conductor, not a branching plasma channel.
        const connectY = termY;
        const straight = interceptedByRod ? 0.0 : 35.0;
        segments.push({
          x1: termX,
          y1: groundAtTerm,
          z1: termZ,
          x2: termX + (this.rand() - 0.5) * straight,
          y2: connectY,
          z2: termZ + (this.rand() - 0.5) * straight,
          generation: 0,
          radiusWeight: interceptedByRod ? 1.85 : 1.0,
          progressOrder: 0.99,
        });
        // A rod interception ends at the tip; only bare-ground attachment collapses to terrain.
        termY = interceptedByRod && this.rod ? this.rod.tipY : groundAtTerm;
      }
    }

    // Compute exact 3D integrated main + branch channel length in km
    let totalLenM = 0;
    for (const s of segments) {
      totalLenM += Math.hypot(s.x2 - s.x1, s.y2 - s.y1, s.z2 - s.z1);
    }
    const channelLengthKm = Math.max(0.6, totalLenM / 1000.0);
    const horizSpanKm = Math.hypot(termX - initX, termZ - initZ) / 1000.0;

    // Determine physical Polarity from actual charge region & potential sign
    const isPositivePolarity =
      localPhi > 2.5 ||
      (cand.localRhoQ > 0.18 && termY < initY) ||
      (isElevatedTerrainUpward && localPhi < 0);
    const polarity: DischargePolarity = isPositivePolarity ? 'Positive (+)' : 'Negative (-)';

    // Emergent Classification strictly from actual 3D trajectory, cloud condensate occupancy, ground attachment, and polarity!
    const initInCloud = this.sampleCloudCondensate(grid, initX, initY, initZ) > 0.035;
    const termInCloud = this.sampleCloudCondensate(grid, termX, termY, termZ) > 0.035;

    let classification: LightningClassification;
    if (isElevatedTerrainUpward) {
      classification = isPositivePolarity
        ? 'Positive Upward (+Upward)'
        : 'Negative Upward (-Upward)';
    } else if (hitGround) {
      if (exitedCloudMidPath && horizSpanKm > 2.8 && !isPositivePolarity) {
        classification = 'Bolt-from-the-Blue';
      } else {
        classification = isPositivePolarity ? 'Positive CG (+CG)' : 'Negative CG (-CG)';
      }
    } else if (enteredSecondCell !== null) {
      classification = 'Cloud-to-Cloud (CC)';
    } else if (horizSpanKm > 5.2 && initY > sounding.instability.freezingLevel + 2000) {
      classification = 'Anvil Crawler / Spider';
    } else if (initInCloud && !termInCloud) {
      classification = 'Cloud-to-Air (CA)';
    } else if (!initInCloud && termInCloud) {
      classification = 'Air-to-Cloud (AC)';
    } else if (horizSpanKm > Math.abs(termY - initY) * 0.0018 && horizSpanKm > 3.0) {
      classification = 'Horizontal Intracloud';
    } else {
      classification = isPositivePolarity
        ? 'Positive Intracloud (+IC)'
        : 'Negative Intracloud (-IC)';
    }

    // Physical Stroke Count, Continuing Current, Charge Transfer & Peak Current
    let totalStrokes = 1;
    let hasContinuingCurrent = false;
    let continuingCurrentMs = 0;

    if (classification === 'Negative CG (-CG)') {
      // Negative CG typically exhibits 2-6 return strokes via dart leaders!
      totalStrokes = 1 + Math.floor(this.rand() * 5);
      hasContinuingCurrent = this.rand() < 0.28;
      continuingCurrentMs = hasContinuingCurrent ? 45 + this.rand() * 85 : 0;
    } else if (classification === 'Positive CG (+CG)') {
      // Positive CG is predominantly 1-2 massive strokes with long continuing current & large charge transfer!
      totalStrokes = this.rand() < 0.78 ? 1 : 2;
      hasContinuingCurrent = true;
      continuingCurrentMs = 95 + this.rand() * 145;
    } else if (classification === 'Bolt-from-the-Blue') {
      totalStrokes = 1 + Math.floor(this.rand() * 2);
      hasContinuingCurrent = this.rand() < 0.35;
      continuingCurrentMs = hasContinuingCurrent ? 40 + this.rand() * 60 : 0;
    } else if (classification === 'Anvil Crawler / Spider') {
      totalStrokes = 2 + Math.floor(this.rand() * 4); // Sequential recoil K-changes!
      hasContinuingCurrent = true;
      continuingCurrentMs = 110 + this.rand() * 160;
    } else {
      totalStrokes = 1 + Math.floor(this.rand() * 3);
      hasContinuingCurrent = this.rand() < 0.22;
      continuingCurrentMs = hasContinuingCurrent ? 30 + this.rand() * 55 : 0;
    }

    // Estimate return-stroke current from field overdrive, then integrate I·dt
    // (1 kA·ms = 1 C) for a charge transfer consistent with the stroke waveform.
    const peakCurrentKA = Math.max(
      8,
      Math.min(
        250,
        (classification === 'Positive CG (+CG)' ? 68 : 26) *
          Math.sqrt(Math.max(0.25, cand.ratio)) *
          (0.78 + 0.42 * this.rand())
      )
    );
    const returnStrokeMs = 0.75 + Math.min(1.2, channelLengthKm * 0.035);
    const continuingCurrentKA = hasContinuingCurrent
      ? Math.max(0.25, Math.min(1.15, 0.28 + peakCurrentKA * 0.008))
      : 0;
    const chargeTransferredC = Math.min(
      145.0,
      peakCurrentKA * returnStrokeMs + continuingCurrentKA * continuingCurrentMs
    );

    const sourceAltKm = Math.max(2.0, initY / 1000.0);
    const chargeMomentChangeCKm = hitGround
      ? chargeTransferredC * sourceAltKm
      : chargeTransferredC * (Math.abs(initY - termY) / 1000.0);

    const leaderMs = Math.min(48, 9 + channelLengthKm * 1.4);
    const strokeCycleMs = totalStrokes * 42;
    const totalDurationMs = leaderMs + continuingCurrentMs + strokeCycleMs + 65;

    const flashId = `LTG-${String(this.nextFlashNum++).padStart(4, '0')}`;
    const cellId = cell ? cell.id : 'ATM-ENV';

    const discharge: ActiveLightningDischarge = {
      id: flashId,
      classification,
      polarity,
      cellId,
      timestampSimSec: simTimeSec,
      ageRealMs: 0,
      totalDurationMs,
      phase: 'leader',
      segments,
      initPoint: [initX, initY, initZ],
      termPoint: [termX, termY, termZ],
      channelLengthKm,
      channelRadiusM: 0.008 + Math.min(0.022, branchCount * 0.00018),
      channelTemperatureK: Math.max(18000, Math.min(32000, 19000 + peakCurrentKA * 75 + branchCount * 12)),
      branchCount,
      totalStrokes,
      currentStrokeIndex: 0,
      hasContinuingCurrent,
      continuingCurrentMs,
      peakElectricFieldKVm: cand.eMagKVm,
      chargeTransferredC,
      peakCurrentKA,
      chargeMomentChangeCKm,
      coreLuminosity: 0.35,
      branchLuminosity: 0.45,
      cloudIllumIntensity: 0.25,
      leaderProgress: 0.05,
    };

    this.activeDischarges.push(discharge);
    this.totalFlashes++;
    if (cell) cell.flashCount++;

    // Record in Autonomous Event Monitor
    this.pushEventRecord({
      id: flashId,
      kind: 'lightning',
      classification,
      polarity,
      timestampSimSec: simTimeSec,
      cellId,
      channelLengthKm,
      branchCount,
      strokeCount: totalStrokes,
      durationMs: Math.round(totalDurationMs),
      peakElectricFieldKVm: cand.eMagKVm,
      chargeTransferredC,
    });

    // Physically Neutralize & Redistribute Charge in parent cell(s) so |E| relaxes naturally!
    if (cell) {
      const drainFrac = Math.min(0.46, 0.14 + chargeTransferredC / 160.0);
      if (hitGround) {
        if (isPositivePolarity) {
          cell.upperPosChargeNCm3 *= 1.0 - drainFrac;
          cell.lowerPosChargeNCm3 *= 1.0 - drainFrac * 0.6;
          elec.cumulativeGroundTransferredC += chargeTransferredC;
        } else {
          cell.mainNegChargeNCm3 *= 1.0 - drainFrac;
          elec.cumulativeGroundTransferredC -= chargeTransferredC;
        }
      } else if (enteredSecondCell) {
        cell.upperPosChargeNCm3 *= 1.0 - drainFrac * 0.7;
        enteredSecondCell.mainNegChargeNCm3 *= 1.0 - drainFrac * 0.7;
      } else {
        // Intracloud neutralization drains both + and - poles equally, conserving net atmospheric charge!
        cell.mainNegChargeNCm3 *= 1.0 - drainFrac * 0.85;
        cell.upperPosChargeNCm3 *= 1.0 - drainFrac * 0.65;
        cell.lowerPosChargeNCm3 *= 1.0 - drainFrac * 0.55;
        cell.anvilScreenChargeNCm3 *= 1.0 - drainFrac * 0.5;
      }
    }

    // Evaluate Autonomous Upper-Atmospheric Coupling (ELVES, Sprite Halos, Red Sprites) from this discharge!
    this.evaluateDischargeCoupledTLEs(discharge, simTimeSec, cell);
  }

  /**
   * Grows an irregular 3D tortuous branched dielectric breakdown tree guided by the
   * target sink and local 3D electric field perturbations.
   */
  private grow3DLeaderTree(
    start: [number, number, number],
    target: [number, number, number],
    grid: AtmosphericFluidGrid,
    upwardBranching: boolean,
    horizontalSpider: boolean,
    groundDirected = false,
    rodPreAimed = false
  ): {
    segments: LightningSegment[];
    branchCount: number;
    endPoint: [number, number, number];
    /** True when the march was met by the rod's upward connecting leader. */
    rodAttached: boolean;
  } {
    // Rod interception is a 3D test, not a plan-view one: an upward connecting leader meets a
    // descending channel that passes within its reach of the mast tip, wherever that channel's
    // eventual ground target happened to be. Only meaningful for a ground-directed discharge.
    const rodTest = groundDirected && this.rod !== null && !rodPreAimed;
    const rodReach = rodTest ? this.rod!.connectingLeaderReachM() : 0;
    let rodAttached = false;
    const segments: LightningSegment[] = [];
    let branchCount = 0;

    const totalDist = Math.hypot(
      target[0] - start[0],
      target[1] - start[1],
      target[2] - start[2]
    );
    const numMainSteps = Math.max(14, Math.min(48, Math.floor(totalDist / 240)));

    let cx = start[0];
    let cy = start[1];
    let cz = start[2];

    for (let s = 0; s < numMainSteps; s++) {
      const progress = (s + 1) / numMainSteps;
      const remX = target[0] - cx;
      const remY = target[1] - cy;
      const remZ = target[2] - cz;
      const remDist = Math.max(1.0, Math.hypot(remX, remY, remZ));

      // Step length is recomputed from the distance still to cover rather than fixed up front.
      // With a constant stepLen the vertical advance per step is only ~0.8 * stepLen (the rest
      // goes to the field-alignment and tortuosity terms), so a channel summed to roughly 80% of
      // the distance it needed and undershot its target -- a leader aimed at the ground from the
      // main negative layer at 6.7 km arrived short and never attached, which is the other half
      // of why Negative CG (-CG) could not occur. Dividing the remainder by the steps left makes
      // the march converge on the target exactly while keeping the same tortuosity.
      const stepLen = remDist / Math.max(1, numMainSteps - s);

      // Blend target attraction with local 3D E-field alignment and realistic dielectric tortuosity
      const gx = grid.worldToGridX(cx);
      const gy = grid.worldToGridY(cy);
      const gz = grid.worldToGridZ(cz);
      const id = grid.idx(gx, gy, gz);
      const ex = grid.ex[id];
      const ey = grid.ey[id];
      const ez = grid.ez[id];
      const eMag = Math.max(1.0, Math.hypot(ex, ey, ez));
      const eSign = remY * ey + remX * ex + remZ * ez >= 0 ? 1.0 : -1.0;

      const jitterAmp = (1.0 - progress * 0.55) * stepLen * 0.58;
      // nx / nz are `let` because a rod interception redirects the march onto the mast tip.
      let nx =
        cx +
        ((remX / remDist) * 0.76 + (eSign * ex / eMag) * 0.24) * stepLen +
        (this.rand() - 0.5) * jitterAmp * 2.0;
      let ny =
        cy +
        ((remY / remDist) * 0.8 + (eSign * ey / eMag) * 0.2) * stepLen +
        (this.rand() - 0.5) * jitterAmp * (horizontalSpider ? 0.55 : 1.1);
      let nz =
        cz +
        ((remZ / remDist) * 0.76 + (eSign * ez / eMag) * 0.24) * stepLen +
        (this.rand() - 0.5) * jitterAmp * 2.0;

      // Upward connecting leader from the mast meets the descending tip.
      if (rodTest && !rodAttached) {
        const rdx = nx - this.rod!.x;
        const rdy = ny - this.rod!.tipY;
        const rdz = nz - this.rod!.z;
        if (Math.hypot(rdx, rdy, rdz) <= rodReach) {
          rodAttached = true;
          nx = this.rod!.x;
          ny = this.rod!.tipY;
          nz = this.rod!.z;
          // Add the mast itself as a straight heavy segment from ground to tip.
          segments.push({
            x1: this.rod!.x,
            y1: this.rod!.groundY,
            z1: this.rod!.z,
            x2: this.rod!.x,
            y2: this.rod!.tipY,
            z2: this.rod!.z,
            generation: 0,
            radiusWeight: 1.85,
            progressOrder: 0.985,
          });
        }
      }

      const groundH = getTerrainHeight(nx, nz);
      if (!upwardBranching && ny < groundH && !rodAttached) {
        ny = groundH;
      }

      segments.push({
        x1: cx,
        y1: cy,
        z1: cz,
        x2: nx,
        y2: ny,
        z2: nz,
        generation: 0,
        radiusWeight: 1.0,
        progressOrder: progress,
      });

      // Spawn secondary & tertiary tortuous dielectric branches
      const branchProb = horizontalSpider ? 0.48 : 0.34;
      if (s > 1 && s < numMainSteps - 1 && this.rand() < branchProb && segments.length < 210) {
        branchCount++;
        this.growSideBranch(
          nx,
          ny,
          nz,
          (nx - cx) / stepLen,
          (ny - cy) / stepLen,
          (nz - cz) / stepLen,
          stepLen * (0.78 + 0.35 * this.rand()),
          horizontalSpider ? 7 : 5,
          1,
          progress,
          upwardBranching,
          horizontalSpider,
          segments
        );
      }

      cx = nx;
      cy = ny;
      cz = nz;
      if (rodAttached) break;
      if (!upwardBranching && cy <= groundH + 5) break;
    }

    return {
      segments,
      branchCount,
      endPoint: [cx, cy, cz],
      rodAttached,
    };
  }

  private growSideBranch(
    sx: number,
    sy: number,
    sz: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    segLen: number,
    steps: number,
    generation: number,
    baseProgress: number,
    upward: boolean,
    horizontalSpider: boolean,
    out: LightningSegment[]
  ): void {
    let bx = sx;
    let by = sy;
    let bz = sz;
    // Deflect side branch outward at 25-55 degrees from parent leader direction
    let dx = dirX + (this.rand() - 0.5) * 1.35;
    let dy = horizontalSpider
      ? dirY * 0.35 + (this.rand() - 0.5) * 0.35
      : dirY * 0.78 + (upward ? 0.25 : -0.2) + (this.rand() - 0.5) * 0.5;
    let dz = dirZ + (this.rand() - 0.5) * 1.35;
    const norm = Math.max(0.01, Math.hypot(dx, dy, dz));
    dx /= norm;
    dy /= norm;
    dz /= norm;

    const radW = generation === 1 ? 0.42 : 0.22;

    for (let i = 0; i < steps; i++) {
      if (out.length >= 240) return;
      const nx = bx + dx * segLen + (this.rand() - 0.5) * segLen * 0.65;
      const ny = Math.max(
        getTerrainHeight(nx, bz) + 25,
        by + dy * segLen + (this.rand() - 0.5) * segLen * 0.4
      );
      const nz = bz + dz * segLen + (this.rand() - 0.5) * segLen * 0.65;

      const prog = Math.min(1.0, baseProgress + (i + 1) * 0.035);
      out.push({
        x1: bx,
        y1: by,
        z1: bz,
        x2: nx,
        y2: ny,
        z2: nz,
        generation,
        radiusWeight: radW * (1.0 - (i / steps) * 0.45),
        progressOrder: prog,
      });

      if (generation < 2 && i === 1 && this.rand() < 0.45) {
        this.growSideBranch(
          nx,
          ny,
          nz,
          dx,
          dy,
          dz,
          segLen * 0.72,
          3,
          generation + 1,
          prog,
          upward,
          horizontalSpider,
          out
        );
      }

      bx = nx;
      by = ny;
      bz = nz;
    }
  }

  private sampleCloudCondensate(
    grid: AtmosphericFluidGrid,
    x: number,
    y: number,
    z: number
  ): number {
    const ix = grid.worldToGridX(x);
    const iy = grid.worldToGridY(y);
    const iz = grid.worldToGridZ(z);
    const id = grid.idx(ix, iy, iz);
    return grid.qc[id] + grid.qi[id];
  }

  /**
   * Couples CG return-stroke EMP & quasi-electrostatic Charge Moment Change (CMC)
   * to upper-atmospheric Transient Luminous Events (ELVES, Sprite Halos, Red Sprites).
   */
  private evaluateDischargeCoupledTLEs(
    d: ActiveLightningDischarge,
    simTimeSec: number,
    cell: ConvectiveCell | null
  ): void {
    const isCG =
      d.classification === 'Positive CG (+CG)' ||
      d.classification === 'Negative CG (-CG)' ||
      d.classification === 'Bolt-from-the-Blue';

    if (!isCG) return;

    const cx = cell ? cell.x : d.initPoint[0];
    const cz = cell ? cell.z : d.initPoint[2];

    // 1. ELVES (88 - 93 km lower ionosphere EMP ring) when return stroke peak current >= 92 kA
    if (d.peakCurrentKA >= 92.0) {
      this.spawnTLE({
        classification: 'ELVES',
        parentDischargeId: d.id,
        cellId: d.cellId,
        polarity: 'Bipolar / EMP',
        timestampSimSec: simTimeSec,
        x: cx,
        yBase: 87000,
        yTop: 92000,
        z: cz,
        horizontalRadiusM: 14500, // Scaled into observable dome horizon
        durationMs: 45, // Visually perceptible sub-frame expansion
        peakElectricFieldKVm: d.peakElectricFieldKVm,
        chargeMomentCKm: d.chargeMomentChangeCKm,
      });
    }

    // 2. Sprite Halo (72 - 84 km diffuse crimson disk) when CMC >= 330 C*km
    if (d.chargeMomentChangeCKm >= 330.0) {
      this.spawnTLE({
        classification: 'Sprite Halo',
        parentDischargeId: d.id,
        cellId: d.cellId,
        polarity: d.polarity,
        timestampSimSec: simTimeSec,
        x: cx,
        yBase: 72000,
        yTop: 83000,
        z: cz,
        horizontalRadiusM: 7500,
        durationMs: 75,
        peakElectricFieldKVm: d.peakElectricFieldKVm,
        chargeMomentCKm: d.chargeMomentChangeCKm,
      });
    }

    // 3. Red Sprites + downward bluish Sprite Streamers (50 - 86 km) when CMC >= 410 C*km (predominantly +CG!)
    if (d.chargeMomentChangeCKm >= 410.0) {
      this.spawnTLE({
        classification: 'Red Sprite',
        parentDischargeId: d.id,
        cellId: d.cellId,
        polarity: d.polarity,
        timestampSimSec: simTimeSec,
        x: cx + (this.rand() - 0.5) * 3200,
        yBase: 50000,
        yTop: 86000,
        z: cz + (this.rand() - 0.5) * 3200,
        horizontalRadiusM: 4800,
        durationMs: 135,
        peakElectricFieldKVm: d.peakElectricFieldKVm,
        chargeMomentCKm: d.chargeMomentChangeCKm,
      });
    }
  }

  /**
   * Evaluates upward stratospheric discharges (Blue Jets 15-42km & Gigantic Jets 15-86km)
   * from overshooting convective cloud tops when intense upper charge imbalance overcomes
   * stratospheric breakdown above a thinned screening layer.
   */
  private evaluateCloudTopJets(
    simDtSec: number,
    simTimeSec: number,
    cells: ConvectiveCell[],
    elec: AtmosphericElectrificationEngine
  ): void {
    for (const cell of cells) {
      const lastTime = this.jetCooldownByCell.get(cell.id) ?? -999;
      if (simTimeSec - lastTime < 75) continue;

      if (
        cell.cloudTopM > 12400 &&
        cell.overshootingTopM > 220 &&
        cell.updraftMaxMS > 20.0 &&
        cell.upperPosChargeNCm3 > 2.85
      ) {
        // Check extreme Gigantic Jet threshold vs stratospheric Blue Jet threshold
        const isGigantic =
          cell.cloudTopM > 13400 &&
          cell.updraftMaxMS > 28.0 &&
          (cell.upperPosChargeNCm3 > 3.65 || cell.mainNegChargeNCm3 < -3.95) &&
          this.rand() < 0.035 * simDtSec;

        const isBlueJet = !isGigantic && this.rand() < 0.055 * simDtSec;

        if (isGigantic || isBlueJet) {
          this.jetCooldownByCell.set(cell.id, simTimeSec);
          const classification: TLEClassification = isGigantic ? 'Gigantic Jet' : 'Blue Jet';
          const polarity: DischargePolarity = isGigantic ? 'Negative (-)' : 'Positive (+)';
          const qTransfer = isGigantic ? 38.0 : 12.0;

          cell.upperPosChargeNCm3 *= 0.72;
          elec.cumulativeGroundTransferredC += isGigantic ? -qTransfer : qTransfer;

          this.spawnTLE({
            classification,
            parentDischargeId: 'CLOUD-TOP',
            cellId: cell.id,
            polarity,
            timestampSimSec: simTimeSec,
            x: cell.x,
            yBase: cell.cloudTopM - 300,
            yTop: isGigantic ? 85000 : 41000,
            z: cell.z,
            horizontalRadiusM: isGigantic ? 5400 : 2800,
            durationMs: isGigantic ? 290 : 220,
            peakElectricFieldKVm: cell.peakElectricFieldKVm,
            chargeMomentCKm: qTransfer * (isGigantic ? 65 : 25),
          });
        }
      }
    }
  }

  private spawnTLE(params: {
    classification: TLEClassification;
    parentDischargeId: string;
    cellId: string;
    polarity: DischargePolarity;
    timestampSimSec: number;
    x: number;
    yBase: number;
    yTop: number;
    z: number;
    horizontalRadiusM: number;
    durationMs: number;
    peakElectricFieldKVm: number;
    chargeMomentCKm: number;
  }): void {
    const id = `TLE-${String(this.nextTLENum++).padStart(3, '0')}`;
    this.activeTLEs.push({
      id,
      ...params,
      ageMs: 0,
      luminosity: 0.9,
    });
    this.totalTLEs++;

    this.pushEventRecord({
      id,
      kind: 'tle',
      classification: params.classification,
      polarity: params.polarity,
      timestampSimSec: params.timestampSimSec,
      cellId: params.cellId,
      channelLengthKm: (params.yTop - params.yBase) / 1000.0,
      branchCount: params.classification === 'Red Sprite' ? 14 : params.classification === 'Gigantic Jet' ? 9 : 1,
      strokeCount: 1,
      durationMs: params.durationMs,
      peakElectricFieldKVm: params.peakElectricFieldKVm,
      chargeTransferredC: params.chargeMomentCKm / 25.0,
    });
  }

  private updateActiveDischarges(
    realDtMs: number,
    _simTimeSec: number,
    grid: AtmosphericFluidGrid
  ): void {
    for (let i = this.activeDischarges.length - 1; i >= 0; i--) {
      const d = this.activeDischarges[i];
      d.ageRealMs += realDtMs;

      const leaderDuration = Math.min(48, 9 + d.channelLengthKm * 1.4);
      const afterLeader = d.ageRealMs - leaderDuration;

      if (d.ageRealMs < leaderDuration) {
        // Phase 1: Stepped Leader propagating toward ground / sink
        d.phase = d.ageRealMs > leaderDuration * 0.88 ? 'connecting' : 'leader';
        d.leaderProgress = Math.min(1.0, d.ageRealMs / leaderDuration);
        d.coreLuminosity = 0.35 + 0.25 * d.leaderProgress;
        d.branchLuminosity = 0.42;
        d.cloudIllumIntensity = 0.22 * d.leaderProgress;
      } else if (afterLeader < 18) {
        // Phase 2: Initial Blinding Return Stroke!
        d.phase = 'return_stroke';
        d.leaderProgress = 1.0;
        d.currentStrokeIndex = 1;
        const flashEnvelope = Math.exp(-afterLeader / 6.5);
        d.coreLuminosity = 1.45 * flashEnvelope + 0.35;
        d.branchLuminosity = 0.95 * flashEnvelope;
        d.cloudIllumIntensity = 1.35 * flashEnvelope;
        this.injectVolumetricFlashIllumination(grid, d, d.cloudIllumIntensity);
      } else if (d.hasContinuingCurrent && afterLeader < 18 + d.continuingCurrentMs) {
        // Phase 3: Continuing Current steady bright plasma channel
        d.phase = 'continuing_current';
        d.leaderProgress = 1.0;
        const flicker = 0.72 + 0.18 * Math.sin(d.ageRealMs * 0.18);
        d.coreLuminosity = flicker;
        d.branchLuminosity = 0.18 * flicker;
        d.cloudIllumIntensity = 0.55 * flicker;
        this.injectVolumetricFlashIllumination(grid, d, d.cloudIllumIntensity * 0.5);
      } else {
        // Phase 4: Subsequent Dart-Leader Return Strokes & Final Afterglow
        const postCC = afterLeader - 18 - (d.hasContinuingCurrent ? d.continuingCurrentMs : 0);
        const strokePeriod = 42.0;
        const subsequentIdx = Math.floor(postCC / strokePeriod);
        const withinPeriod = postCC - subsequentIdx * strokePeriod;

        if (subsequentIdx < d.totalStrokes - 1) {
          d.currentStrokeIndex = subsequentIdx + 2;
          if (withinPeriod < 9.0) {
            d.phase = 'dart_stroke';
            const pulse = Math.exp(-withinPeriod / 4.2);
            d.coreLuminosity = 1.18 * pulse + 0.2;
            d.branchLuminosity = 0.25 * pulse; // Dart leaders re-illuminate main channel, branches mostly dark!
            d.cloudIllumIntensity = 0.95 * pulse;
            this.injectVolumetricFlashIllumination(grid, d, d.cloudIllumIntensity);
          } else {
            d.phase = 'interstroke';
            d.coreLuminosity = 0.08;
            d.branchLuminosity = 0.02;
            d.cloudIllumIntensity = 0.05;
          }
        } else {
          // Final cooling channel bead afterglow
          d.phase = 'afterglow';
          const rem = d.totalDurationMs - d.ageRealMs;
          const fade = Math.max(0, Math.min(1, rem / 65.0));
          d.coreLuminosity = 0.26 * fade * fade;
          d.branchLuminosity = 0.05 * fade;
          d.cloudIllumIntensity = 0.1 * fade;
        }
      }

      if (d.ageRealMs >= d.totalDurationMs) {
        this.activeDischarges.splice(i, 1);
      }
    }
  }

  private injectVolumetricFlashIllumination(
    grid: AtmosphericFluidGrid,
    d: ActiveLightningDischarge,
    intensity: number
  ): void {
    grid.markFlashActive();
    // Illuminate 3D cloud & precipitation voxels surrounding main trunk segments
    const stepStride = Math.max(1, Math.floor(d.segments.length / 8));
    for (let s = 0; s < d.segments.length; s += stepStride) {
      const seg = d.segments[s];
      if (seg.generation > 0) continue;
      const mx = 0.5 * (seg.x1 + seg.x2);
      const my = 0.5 * (seg.y1 + seg.y2);
      const mz = 0.5 * (seg.z1 + seg.z2);

      const gx = grid.worldToGridX(mx);
      const gy = grid.worldToGridY(my);
      const gz = grid.worldToGridZ(mz);

      const rVox = 4;
      for (let dz = -rVox; dz <= rVox; dz++) {
        const iz = gz + dz;
        if (iz < 0 || iz >= grid.nz) continue;
        for (let dy = -rVox; dy <= rVox; dy++) {
          const iy = gy + dy;
          if (iy < 0 || iy >= grid.ny) continue;
          for (let dx = -rVox; dx <= rVox; dx++) {
            const ix = gx + dx;
            if (ix < 0 || ix >= grid.nx) continue;
            const d2 = dx * dx + dy * dy + dz * dz;
            // The grid tracks the dirty region itself so the volume texture only repacks
            // the voxels this flash actually touched.
            grid.addFlashIllumination(ix, iy, iz, intensity / (1.0 + d2 * 0.42));
          }
        }
      }
    }
  }

  private updateActiveTLEs(realDtMs: number): void {
    for (let i = this.activeTLEs.length - 1; i >= 0; i--) {
      const t = this.activeTLEs[i];
      t.ageMs += realDtMs;
      const frac = t.ageMs / t.durationMs;
      // Fast rise, smooth exponential optical decay
      t.luminosity =
        frac < 0.18
          ? frac / 0.18
          : Math.max(0, Math.pow(1.0 - (frac - 0.18) / 0.82, 1.6));

      if (t.ageMs >= t.durationMs) {
        this.activeTLEs.splice(i, 1);
      }
    }
  }

  private pushEventRecord(rec: EventMonitorRecord): void {
    this.eventHistory.unshift(rec);
    if (this.eventHistory.length > 60) {
      this.eventHistory.length = 60;
    }
  }
}
