import { AtmosphericSounding, saturationMixingRatioLiquid } from './thermodynamics';
import { PHYS } from './types';

/**
 * Entraining plume model of a convective updraft.
 *
 * ## Why a 1-D plume
 *
 * The previous updraft was a single velocity relaxed toward sqrt(B * R) with a depth-mean
 * buoyancy and a hand-tuned "thermal excess" term. That cannot reproduce the two behaviours
 * that actually distinguish real storms:
 *
 *  - Top-hat plumes **decay upward** because they mix dry environmental air in at a rate set
 *    by their radius, so a narrow tower stalls while a wide one reaches the tropopause;
 *  - a parcel has **memory**: it carries the condensate and the latent heat it picked up lower
 *    down, so an updraft that has just punched through a cap keeps rising for a while after
 *    the parcel profile above it turns negative. That inertia is what an overshooting top is.
 *
 * This module integrates the standard steady entraining-plume equations (Simpson & Wiggert
 * 1969; Kain & Fritsch 1990) upward in 200 m steps. The conserved variables are the ones that
 * are actually conserved by condensation and evaporation:
 *
 *     θ_l = θ − (L_v/C_p)·q_c        liquid-water potential temperature
 *     q_t = q_v + q_c                total water mixing ratio
 *
 * which avoid the stiff latent-heating source term entirely. At every level the plume state
 * (θ_l, q_t) is mixed toward the environment at the entrainment rate, then saturation-adjusted
 * back to (T, q_v, q_c). Momentum follows
 *
 *     d(w²)/dz = 2·B_eff − 2·ε·w² − 2·a_d·w²/R
 *
 * with ε = 0.2/R (R in km, plus a floor for sub-cell mixing) and a_d the perturbation-pressure
 * drag coefficient. Radius grows with height at the turbulent plume spreading angle, which is
 * what makes a deep tower widen toward its anvil.
 */

export interface PlumeLevel {
  /** Height AGL, m. */
  z: number;
  /** Updraft vertical velocity, m/s. */
  w: number;
  /** Updraft potential temperature, K. */
  theta: number;
  /** Updraft water-vapour mixing ratio, g/kg. */
  qv: number;
  /** Condensate carried by the plume, g/kg (cloud water before autoconversion). */
  qc: number;
  /** Effective buoyancy acceleration at this level, m/s². */
  buoyancy: number;
  /** True once the plume is saturated at this level. */
  saturated: boolean;
}

export interface PlumeProfile {
  levels: PlumeLevel[];
  lclM: number;
  /** Height where the plume's vertical velocity first decays below 1 m/s, m. */
  topM: number;
  /** Height of peak vertical velocity, m. */
  wMaxZM: number;
  peakWMPS: number;
  /** Plume radius at its top, m. */
  radiusAtTopM: number;
  /** Vertically integrated positive buoyancy, J/kg — the kinetic-energy ceiling. */
  integratedBuoyancy: number;
  /** Peak condensate the plume carries, g/kg — bounds the microphysical supply. */
  peakCondensateGKg: number;
}

const MAX_LEVELS = 88;
const DZ = 200;
const G = PHYS.G;
const CP = PHYS.CP;
const RD = PHYS.R_D;
const LV = PHYS.L_V;
const LS = PHYS.L_S;

/** Source (mixed-layer) thermodynamic state of the updraft at the surface. */
export interface PlumeSource {
  /** Surface (mixed-layer) potential temperature, K. */
  theta0: number;
  /** Surface mixing ratio, g/kg. */
  qv0GKg: number;
  /** Updraft core radius at cloud base, m. */
  radiusM: number;
  /** Solar / boundary-layer thermal excess temperature, K. */
  thermalExcessK: number;
}

/**
 * Saturation adjustment at fixed θ_l and q_t: returns the equilibrium temperature and the
 * split of total water into vapour and condensate.
 *
 * This has to be solved, not iterated naively: condensing a guess amount of q_c heats the
 * parcel by (L/C_p)·q_c, which raises the saturation mixing ratio and condenses less. A
 * direct fixed-point substitution oscillates between "all condensate" and "none" in a few
 * iterations — the classic saturation-adjustment instability. The residual
 *
 *     f(q_c) = q_c + q_s(T(q_c)) − q_t
 *
 * is strictly increasing in q_c (the heating term makes q_s fall as q_c rises, but at a rate
 * below one), so a bracketed bisection converges unconditionally in ~18 iterations.
 */
function saturationAdjust(
  thetaL: number,
  qt: number,
  pressurePa: number,
  icePhase: boolean
): { tempK: number; qv: number; qc: number } {
  const lhv = (icePhase ? LS : LV) / CP;
  const tOf = (qc: number) => (thetaL + lhv * qc * 1e-3) * Math.pow(pressurePa / 100000.0, RD / CP);
  const qsAt = (qc: number) => saturationMixingRatioLiquid(tOf(qc), pressurePa) * 1000.0;

  // Unsaturated if the dry temperature is already below saturation for the total water.
  if (qt <= qsAt(0)) {
    return { tempK: tOf(0), qv: qt, qc: 0 };
  }
  let lo = 0;
  let hi = qt;
  for (let it = 0; it < 20; it++) {
    const mid = 0.5 * (lo + hi);
    if (mid + qsAt(mid) < qt) lo = mid;
    else hi = mid;
  }
  const qc = 0.5 * (lo + hi);
  return { tempK: tOf(qc), qv: Math.max(0, qt - qc), qc };
}

/**
 * Builds a plume profile. `wBaseMS` is the vertical velocity the cell already has at cloud
 * base (the sub-cloud ascent it earned), so a gust-front-forced updraft starts with energy
 * instead of having to re-earn it from a standing start.
 */
export function buildPlumeProfile(
  sounding: AtmosphericSounding,
  source: PlumeSource,
  wBaseMS: number
): PlumeProfile {
  const levels: PlumeLevel[] = [];

  // ---- Conserved source variables -------------------------------------------------------
  const p0 = sounding.pressurePaAt(40);
  const qv0 = Math.max(0.2, source.qv0GKg);
  void p0;
  let thetaL = source.theta0 + source.thermalExcessK * 0.5;
  let qt = qv0;

  // Momentum starts from whatever the sub-cloud ascent already produced. A plume rising out of
  // a boundary layer with a 0.5 K thermal excess has ~2-3 m/s at cloud base; a gust front can
  // force 8-10 m/s.
  let w2 = Math.max(0.25, wBaseMS * wBaseMS);
  let radius = Math.max(250, source.radiusM);

  let lclM = sounding.instability.lcl;
  let foundLcl = false;
  let peakW = 0;
  let wMaxZ = 0;
  let topM = 600;
  let integrated = 0;
  let peakCondensate = 0;

  for (let i = 0; i < MAX_LEVELS; i++) {
    const z = i * DZ;
    const p = sounding.pressurePaAt(z);
    const tEnv = sounding.tempKAt(Math.max(60, z));
    const qvEnvGKg = sounding.qvEnvAt(Math.max(60, z)) * 1000.0;

    const icePhase = tEnv < PHYS.T_FREEZE - 12;
    const adj = saturationAdjust(thetaL, qt, p, icePhase);
    const saturated = adj.qc > 1e-4;
    if (!foundLcl && saturated) {
      foundLcl = true;
      lclM = Math.max(200, z - DZ * 0.5);
    }

    // ---- Condensate removal (pseudoadiabatic ascent) --------------------------------------
    // An undilute parcel lifted from 17.5 g/kg carries ~10 g/kg of condensate up to 9 km, and
    // that water loading alone is 0.1 m/s² — enough to cancel the buoyancy. Real convective
    // cores are *precipitating*: autoconversion and collection strip condensate out as it forms,
    // so a core carries only 1-3 g/kg of cloud water at any level. Removing the excess makes the
    // ascent pseudoadiabatic, which is the standard approximation for a deep convective column.
    const qcRetain = adj.qc;
    let qcCarried = qcRetain;
    if (saturated) {
      // Export efficiency rises as the parcel cools: warm drizzle can hold a lot of liquid, but
      // above the freezing level the Bergeron process scavenges it within a few hundred metres.
      // `coldFrac` drives the retained-condensate ceiling from 2.6 g/kg at cloud base down to a
      // near-zero 0.25 g/kg in the deep mixed-phase zone — which is exactly where an undilute
      // parcel's 9-10 g/kg of water loading was extinguishing the plume.
      const tempKNow = adj.tempK;
      const coldFrac = Math.max(0, Math.min(1, (PHYS.T_FREEZE + 8.0 - tempKNow) / 22.0));
      const carryCeil = 2.6 * (1.0 - coldFrac) + 0.25 * coldFrac;
      const exportFrac = Math.min(0.94, Math.max(0.0, (qcRetain - carryCeil) / Math.max(0.3, qcRetain)));
      const exported = qcRetain * exportFrac;
      qcCarried = qcRetain - exported;
      // Take the exported water out of the total water *and* raise θ_l by the latent heat that
      // water holds.
      //
      // This is the subtle part, and getting it wrong is catastrophic rather than cosmetic.
      // θ_l = θ − (L/cp)·q_c is conserved through condensation. Physically removing q_c from the
      // parcel leaves θ unchanged, so θ_l must RISE by (L/cp)·q_removed — the parcel keeps the
      // heat that condensate released. Dropping q_t without the θ_l correction instead leaves the
      // parcel subsaturated at the next level, the saturation adjustment then returns a dry
      // adiabat, and the plume cools at 11 K/km and dies at 4 km. That is not a small numerical
      // error; it is the difference between a cumulus congestus and a thunderstorm.
      qt = Math.max(0, qt - exported);
      thetaL += (LV / CP) * exported * 1e-3;
    }

    const tUp = adj.tempK;
    // Virtual temperatures include only the vapour: condensate contributes mass but no
    // buoyancy, which is precisely the water-loading term added separately below.
    const tvUp = tUp * (1.0 + 0.608 * adj.qv * 1e-3);
    const tvEnv = tEnv * (1.0 + 0.608 * qvEnvGKg * 1e-3);
    const thermalBuoyancy = G * ((tvUp - tvEnv) / tvEnv);
    const waterLoading = G * qcCarried * 1e-3;
    const buoyancy = thermalBuoyancy - waterLoading;

    if (z > 0) {
      integrated += buoyancy * DZ;
      // ---- Momentum ---------------------------------------------------------------------
      // d(w²)/dz = 2·B·η − 2·ε·w² − 2·a_d·w²/R.
      //
      // η is the buoyancy-redistribution efficiency: only part of the local buoyancy goes into
      // the *core's* vertical kinetic energy, because the rest is spent on the compensating
      // subsidence the updraft drags down around itself. Combined with the entrainment and drag
      // terms this yields the classical plume result — a 1.5 km core tops out around 8 km and
      // reaches 12-15 m/s, a 3.5 km core reaches the tropopause near 20 m/s — instead of a
      // top-hat parcel that runs to sqrt(2·CAPE) (~140 m/s) regardless of its width.
      const radiusKm = Math.max(0.2, radius * 1e-3);
      const entrainCoef = foundLcl ? 0.055 : 0.2;
      const eps = Math.min(0.004, entrainCoef / (radiusKm * 1000.0)) + 4.0e-5;
      // Form drag on the rising core, with the radius as the reference length: a 1 km core has a
      // drag length of ~3 km, so an updraft loses most of its momentum over a deep troposphere.
      // That is what brings a buoyant column down from the sqrt(2·CAPE) ideal (~90 m/s) to the
      // 15-30 m/s that real storms reach.
      const aDrag = 0.55;
      const dragLen = Math.max(700, Math.max(300, radius) / aDrag);
      // Buoyancy efficiency: the share of the local buoyancy that goes into the core's own
      // vertical kinetic energy rather than into the compensating subsidence it drags around
      // itself. Dry thermals give up much more of theirs.
      const eta = foundLcl ? 0.8 : 0.55;
      const dw2 = 2.0 * buoyancy * eta - 2.0 * eps * w2 - (2.0 * w2) / dragLen;
      w2 = Math.max(0, w2 + dw2 * DZ);
    }

    const w = Math.sqrt(w2);
    levels.push({
      z,
      w,
      theta: adj.tempK * Math.pow(100000.0 / p, RD / CP),
      qv: adj.qv,
      qc: qcCarried,
      buoyancy,
      saturated,
    });
    if (qcCarried > peakCondensate) peakCondensate = qcCarried;

    if (w > peakW) {
      peakW = w;
      wMaxZ = z;
    }
    // The plume terminates where it has stopped rising: after the LFC and after the peak, the
    // momentum equation runs out of buoyancy to support it. The 3 m/s floor is the convective
    // "top": below that the column is spreading into anvil rather than building height, and a
    // real cloud top is reported at that level, not at the last level with any motion at all.
    // Threshold is 3 m/s once in cloud, but a dry thermal below its LCL is legitimately slow —
    // it must not be terminated for being under the in-cloud criterion.
    const topThreshold = foundLcl ? 3.0 : 0.8;
    if (z > 600 && w < topThreshold) {
      topM = z;
      break;
    }
    topM = z;

    // ---- Entrainment mixing ----------------------------------------------------------
    // Replace a fraction ε·dz of the plume mass with environmental air. This is done on the
    // *conserved* variables, so no latent heat is created or destroyed by the mixing operation.
    // ---- Lateral entrainment ------------------------------------------------------------
    // ε = a/R. The classical a = 0.2 is the value for *dry* thermals, which entrain vigorously.
    // Once the plume is saturated and carrying its own precipitation it is shielded from its
    // environment, and in shear it tilts so the flow through its flanks drops further. Using the
    // dry value in-cloud capped every simulated tower at 8 km under a 13 km equilibrium level;
    // the in-cloud coefficient is what actually sets how deep convection gets.
    const radiusKmNow = Math.max(0.2, radius * 1e-3);
    const entrainCoefNow = foundLcl ? 0.055 : 0.2;
    const epsNow = Math.min(0.004, entrainCoefNow / (radiusKmNow * 1000.0)) + 4.0e-5;
    const mix = Math.min(0.5, epsNow * DZ);
    const thetaEnv = sounding.thetaEnvAt(Math.max(60, z));
    thetaL += (thetaEnv - thetaL) * mix;
    qt += (qvEnvGKg - qt) * mix;
    // Radius spreads at the turbulent plume angle (~11°, i.e. dR/dz ≈ 0.2).
    radius += 0.2 * DZ;
    void p0;
  }

  return {
    levels,
    lclM,
    topM: Math.max(topM, 600),
    wMaxZM: wMaxZ,
    peakWMPS: peakW,
    radiusAtTopM: radius,
    integratedBuoyancy: integrated,
    peakCondensateGKg: peakCondensate,
  };
}

/** Samples a plume profile at an arbitrary height (nearest 200 m level). */
const NULL_LEVEL: PlumeLevel = {
  z: 0,
  w: 0,
  theta: 300,
  qv: 0,
  qc: 0,
  buoyancy: 0,
  saturated: false,
};

export function samplePlume(profile: PlumeProfile, zM: number): PlumeLevel {
  const levels = profile?.levels;
  if (!levels || levels.length === 0) return NULL_LEVEL;
  const raw = Number.isFinite(zM) ? Math.round(zM / DZ) : 0;
  const idx = Math.max(0, Math.min(levels.length - 1, raw));
  return levels[idx] ?? NULL_LEVEL;
}

/**
 * Vertical velocity the plume supports at height z, given the kinetic energy the cell carries
 * at cloud base. A forced updraft keeps rising past the level where its own buoyancy vanishes
 * until that stored energy is spent — that overshoot is the physical origin of an
 * overshooting top, so it is modelled rather than hard-coded.
 */
export function plumeVelocityAt(profile: PlumeProfile, zM: number, wBaseMS: number): number {
  const lvl = samplePlume(profile, zM);
  // The extra kinetic energy the cell carries in from its sub-cloud inflow is *not* conserved as
  // it rises. It is spent on the work of displacing environmental air, and it drains fastest
  // where the plume is most turbulent, so it decays with an e-folding height of ~1.5 km. Adding
  // it undiminished at every level (the previous form) let a 24 m/s gust-front inflow report
  // 24 m/s of updraft inside an 800 m deep cloud, with a cloud top that never grew because the
  // plume itself had already stalled there.
  const storedKE = Math.max(0, wBaseMS * wBaseMS - 4.0) * Math.exp(-Math.max(0, zM) / 1500.0);
  return Math.min(72, Math.sqrt(lvl.w * lvl.w + storedKE) + Math.max(0, lvl.buoyancy) * 1.5);
}
