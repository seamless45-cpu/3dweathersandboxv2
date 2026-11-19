// Horizontal extent of the simulated atmosphere. Widened from 32 km to 48 km so convection is
// not visibly confined to a box: at 32 km the domain edge sat inside the camera's view from
// almost anywhere on the ground, and clouds were hard-clipped at a straight vertical wall.
// GRID_NX/GRID_NZ were raised to 96 in the same change so dx stays at exactly 500 m -- the
// cloud field keeps its original resolution and only the covered area grows (2.25x).
export const DOMAIN_HALF_SIZE = 24000; // meters (-24km to +24km -> 48km x 48km horizontal domain)
export const DOMAIN_SIZE = 48000; // meters
export const DOMAIN_MAX_ALT = 18000; // meters for tropospheric/lower-stratospheric 3D fluid grid
export const TLE_MAX_ALT = 92000; // meters for upper-atmospheric phenomena (sprites, jets, ELVES)

export const PHYS = {
  G: 9.80665, // m/s^2
  R_D: 287.058, // J/(kg*K) dry air gas constant
  R_V: 461.5, // J/(kg*K) water vapor gas constant
  CP: 1005.0, // J/(kg*K) specific heat of dry air at constant pressure
  L_V: 2.501e6, // J/kg latent heat of vaporization
  L_F: 3.337e5, // J/kg latent heat of fusion
  L_S: 2.834e6, // J/kg latent heat of sublimation
  EPSILON_0: 8.8541878e-12, // F/m vacuum permittivity
  T_FREEZE: 273.15, // K
  T_HOMOGENEOUS_ICE: 235.15, // K (-38 C)
};

export type StormOrganizationMode =
  | 'Clear Sky'
  | 'Boundary-Layer Thermals'
  | 'Fair-Weather Cumulus'
  | 'Growing Convection'
  | 'Isolated Single-Cell'
  | 'Pulse Thunderstorm'
  | 'Multicell Cluster'
  | 'Squall Line / Multicell Line'
  | 'Supercell Thunderstorm'
  | 'Organized Convective System'
  | 'Storm Weakening / Dissipation';

export type CellLifecycleStage =
  | 'nucleating' // Rising sub-cloud thermal parcel approaching LCL
  | 'cumulus_humilis' // Initial shallow condensation
  | 'developing' // Growing cumulus mediocris
  | 'growing' // Cumulus congestus with mixed-phase development
  | 'calvus' // Cumulonimbus calvus with strong updraft & initial glaciation
  | 'mature' // Cumulonimbus capillatus with anvil, precip core, downdraft & charge layers
  | 'supercell' // Persistent rotating mesocyclone with separated updraft/RFD/FFD
  | 'dissipating'; // Downdraft-dominated weakening & anvil orphan

export type PrecipitationType =
  | 'None'
  | 'Virga'
  | 'Drizzle'
  | 'Light Rain'
  | 'Moderate Rain'
  | 'Heavy Rain'
  | 'Torrential Convective Rain'
  | 'Graupel Shower'
  | 'Hail & Heavy Rain'
  | 'Snow / Ice Pellets'
  | 'Mixed-Phase Precipitation';

/**
 * Cloud structural archetypes. These are *formation* regimes, not the WMO genera -- the genera
 * are resolved in the shader from altitude and phase. What differs here is the shape the
 * condensate is injected in: how wide the tower grows, how high it tops out, and how much
 * anvil it throws downshear.
 */
/** Lightweight per-frame view of one tornadic vortex, for the HUD. */
export interface TornadoSnapshot {
  id: string;
  x: number;
  z: number;
  /** Peak tangential wind at the core radius, m/s. */
  windMS: number;
  efScale: number;
  /** Radius of maximum wind, m. */
  radiusM: number;
  /** Cyclostrophic core pressure deficit, Pa (negative). */
  pressureDeficitPa: number;
  /** 0..1, how far the condensation funnel has descended from cloud base. */
  funnelDrop: number;
  /** Cloud base of the parent storm, m ASL. */
  cloudBaseM: number;
  ageSec: number;
  phase: string;
}

export type CloudMorphology =
  /** Narrow deep tower, strong anvil: classic single-cell Cb capillatus. */
  | 'tower'
  /** Wide moderately-deep cluster, weak anvil: multicell line / MCS. */
  | 'multicell'
  /** Shallow, capped near or below the freezing level: Cu humilis to mediocris. */
  | 'shallow'
  /** Very wide, low, stratiform deck with no anvil: Sc / Ns sheet. */
  | 'stratiform';

export type LightningClassification =
  | 'Negative CG (-CG)'
  | 'Positive CG (+CG)'
  | 'Bolt-from-the-Blue'
  | 'Negative Intracloud (-IC)'
  | 'Positive Intracloud (+IC)'
  | 'Horizontal Intracloud'
  | 'Anvil Crawler / Spider'
  | 'Cloud-to-Cloud (CC)'
  | 'Cloud-to-Air (CA)'
  | 'Air-to-Cloud (AC)'
  | 'Positive Upward (+Upward)'
  | 'Negative Upward (-Upward)';

export type TLEClassification =
  | 'Red Sprite'
  | 'Sprite Halo'
  | 'Blue Jet'
  | 'Gigantic Jet'
  | 'ELVES';

export type DischargePolarity = 'Negative (-)' | 'Positive (+)' | 'Bipolar / EMP';

export interface AtmosphereConfig {
  surfaceTempC: number; // °C (e.g., 28.5)
  surfacePressureHPa: number; // hPa (e.g., 1011)
  surfaceRelHumidity: number; // % (e.g., 66)
  envLapseRateKPerKm: number; // K/km tropospheric lapse rate (e.g., 7.1)
  cappingInversionStrengthK: number; // K cap near 820 hPa (controls CIN naturally)
  surfaceWindSpeedMS: number; // m/s low-level wind
  surfaceWindDirDeg: number; // degrees meteorological
  bulkWindShear06kmMS: number; // m/s 0-6 km vertical wind shear vector magnitude
  directionalShearDeg: number; // degrees clockwise hodograph curvature (controls SRH & supercells)
  solarHeatingFactor: number; // 0.0 - 1.8 surface insolation driving natural boundary-layer thermals
  sunElevationDeg: number; // degrees above horizon (for daylight / late afternoon lighting)
  ccnConcentration: number; // 0.5 - 2.0 normalized cloud condensation nuclei factor
  rimingEfficiency: number; // 0.5 - 1.5 microphysical riming efficiency
  chargeSeparationGain: number; // 0.5 - 1.5 physical Takahashi charging scaling within observations
  cloudDetailScale: number; // 0.6 - 1.6 procedural turbulent erosion detail
  turbulenceIntensity: number; // 0.5 - 1.6 sub-grid eddy intensity
  /**
   * 0..1 diurnal insolation multiplier applied on top of solarHeatingFactor by the day/night
   * cycle. Deliberately optional and mutated in place rather than routed through
   * updateConfig(): that path recomputes the whole sounding, which is far too expensive to
   * drive from a per-frame sun angle. The sounding's slow thermal response intentionally lags
   * the sky, exactly as the real boundary layer does at sunset.
   */
  solarInsolationScale?: number;
}

export interface SoundingProfileLevel {
  z: number; // m
  p: number; // Pa
  tempK: number; // K environmental temperature
  dewpointK: number; // K environmental dewpoint
  qvEnv: number; // kg/kg environmental water vapor mixing ratio
  rho: number; // kg/m^3 air density
  thetaEnv: number; // K potential temperature
  windU: number; // m/s eastward wind
  windW: number; // m/s southward/northward horizontal wind
}

export interface InstabilityTelemetry {
  cape: number; // J/kg (SIM)
  cin: number; // J/kg (SIM, reported as negative or magnitude)
  lcl: number; // m AGL (SIM)
  lfc: number; // m AGL (SIM)
  el: number; // m AGL (SIM)
  freezingLevel: number; // m AGL (0°C isotherm)
  homogeneousFreezeLevel: number; // m AGL (-38°C isotherm)
  lapseRate03km: number; // K/km
  bulkShear06km: number; // m/s
  srh03km: number; // m^2/s^2 Storm-Relative Helicity
  precipitableWaterMM: number; // mm
  bunkersStormU: number; // m/s right-mover motion X
  bunkersStormW: number; // m/s right-mover motion Z
}

export interface ConvectiveCell {
  id: string;
  numericId: number;
  x: number; // m center X of main updraft base
  z: number; // m center Z of main updraft base
  vx: number; // m/s actual cell motion X
  vz: number; // m/s actual cell motion Z
  ageSec: number; // s since thermal nucleation
  stage: CellLifecycleStage;

  /**
   * Structural archetype, fixed at nucleation. Every cell used to grow by the same radius,
   * cloud-top and anvil laws, so every storm in the domain converged on one shape -- a single
   * tower with an anvil -- no matter what the environment supported. The archetype biases those
   * growth laws so the domain produces genuinely different cloud structures side by side.
   */
  morphology: CloudMorphology;

  // 3D Geometry & Circulation
  radiusM: number; // m core convective tower radius
  cloudBaseM: number; // m cloud base altitude
  cloudTopM: number; // m active cloud top altitude
  anvilRadiusM: number; // m upper anvil horizontal spread
  anvilAxisX: number; // normalized upper wind shear vector X
  anvilAxisZ: number; // normalized upper wind shear vector Z
  overshootingTopM: number; // m height above EL when strong updraft overshoots

  // Dynamics
  updraftMaxMS: number; // m/s peak vertical velocity
  downdraftMaxMS: number; // m/s peak downward velocity (magnitude)
  buoyancyAccel: number; // m/s^2 parcel buoyancy
  entrainmentRate: number; // km^-1 lateral mixing dilution
  mesocycloneVorticity: number; // s^-1 vertical vorticity (zeta)
  rotationPhase: number; // rad integrated rotation angle of updraft inflows
  splitCandidateDone: boolean; // whether cell has already undergone supercell splitting
  rightMoverBias: number; // +1 right-mover, -1 left-mover, 0 neutral

  // Downdraft & Precipitation Core Offsets (separated in sheared/supercell environments)
  precipCoreOffsetX: number; // m offset from updraft center
  precipCoreOffsetZ: number; // m offset from updraft center
  rfdOffsetX: number; // m rear-flank downdraft offset
  rfdOffsetZ: number; // m rear-flank downdraft offset

  // Bulk Microphysics Inventories (g/kg peak/mean inside cell core)
  vaporExcessGKg: number;
  cloudWaterGKg: number; // warm cloud droplets
  supercooledWaterGKg: number; // T < 0°C liquid droplets
  cloudIceGKg: number; // pristine ice crystals
  snowGKg: number; // snow aggregates
  graupelGKg: number; // rimed graupel
  hailGKg: number; // hailstones
  rainGKg: number; // rain water
  surfaceRainRateMMHr: number; // mm/hr reaching surface under core
  precipType: PrecipitationType;
  virgaFraction: number; // 0..1 fraction evaporating before reaching ground

  // Integrated column water budget (g/kg of column air) — closes the conservation
  // diagnostic: cumCondensed == inventory + cumFallout + cumEvaporated.
  cumCondensedGKg: number;
  cumFalloutGKg: number;
  cumEvaporatedGKg: number;

  // Cell Electrical Charge Structure (tripole / anomalous multipole)
  upperPosChargeNCm3: number; // nC/m^3 at 8.5 - 13.5 km
  mainNegChargeNCm3: number; // nC/m^3 at 5.0 - 8.0 km (negative value)
  lowerPosChargeNCm3: number; // nC/m^3 at 2.2 - 4.5 km (LPCC)
  anvilScreenChargeNCm3: number; // nC/m^3 screening layer at anvil boundaries
  peakElectricFieldKVm: number; // kV/m max local |E| in cell
  breakdownRatio: number; // |E| / E_init(z), breakdown initiates >= 1.0
  flashCount: number;
}

export interface ColdPool {
  id: number;
  sourceCellId: string;
  x: number; // m center X
  z: number; // m center Z
  vx: number; // m/s advection
  vz: number; // m/s advection
  radiusM: number; // m expanding gust front radius
  expansionSpeedMS: number; // m/s gravity current speed c = sqrt(2*g*H*|dT|/T0)
  depthM: number; // m cold pool depth (300 - 1400 m)
  tempDeficitK: number; // K evaporative cooling deficit (positive magnitude, e.g. 4.5 K)
  ageSec: number;
  strength: number; // 0..1 normalized gust front convergence lift potential
}

export interface LightningSegment {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  generation: number; // 0 = main trunk, 1..4 = side branches
  radiusWeight: number; // 1.0 for main channel, 0.15..0.55 for branches
  progressOrder: number; // 0..1 normalized leader propagation arrival time
}

export type DischargePhase =
  | 'leader' // Stepped leader propagating
  | 'connecting' // Upward connecting leader meeting downward leader
  | 'return_stroke' // Brilliant high-current return stroke / K-change
  | 'continuing_current' // Sustained glowing plasma channel
  | 'interstroke' // Brief dim pause before dart leader
  | 'dart_stroke' // Subsequent dart-leader return stroke
  | 'afterglow'; // Cooling bead decay

export interface ActiveLightningDischarge {
  id: string;
  classification: LightningClassification;
  polarity: DischargePolarity;
  cellId: string;
  timestampSimSec: number;
  ageRealMs: number; // ms elapsed in visual/electrical discharge evolution
  totalDurationMs: number;
  phase: DischargePhase;

  segments: LightningSegment[];
  initPoint: [number, number, number];
  termPoint: [number, number, number];

  channelLengthKm: number;
  channelRadiusM: number; // effective luminous channel radius used by acoustic/shake estimates
  channelTemperatureK: number; // estimated return-stroke plasma temperature
  branchCount: number;
  totalStrokes: number;
  currentStrokeIndex: number;
  hasContinuingCurrent: boolean;
  continuingCurrentMs: number;

  peakElectricFieldKVm: number;
  chargeTransferredC: number; // Coulombs
  peakCurrentKA: number; // kA
  chargeMomentChangeCKm: number; // C * km (governs TLE coupling!)

  // Dynamic instantaneous luminosity [0..1+]
  coreLuminosity: number;
  branchLuminosity: number;
  cloudIllumIntensity: number;
  leaderProgress: number; // 0..1 during stepped leader phase
}

export interface ActiveTLEEvent {
  id: string;
  classification: TLEClassification;
  parentDischargeId: string;
  cellId: string;
  polarity: DischargePolarity;
  timestampSimSec: number;
  x: number;
  yBase: number; // m (e.g., 15000 for Blue Jet, 52000 for Red Sprite, 88000 for ELVES)
  yTop: number; // m (e.g., 42000 for Blue Jet, 86000 for Red Sprite, 92000 for ELVES)
  z: number;
  horizontalRadiusM: number;
  ageMs: number;
  durationMs: number;
  luminosity: number; // 0..1
  peakElectricFieldKVm: number;
  chargeMomentCKm: number;
}

export interface EventMonitorRecord {
  id: string;
  kind: 'lightning' | 'tle';
  classification: LightningClassification | TLEClassification;
  polarity: DischargePolarity;
  timestampSimSec: number;
  cellId: string;
  channelLengthKm: number;
  branchCount: number;
  strokeCount: number;
  durationMs: number;
  peakElectricFieldKVm: number;
  chargeTransferredC: number;
}

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export interface RenderQualitySettings {
  autoQuality: boolean;
  tier: QualityTier;
  raymarchSteps: number; // 32 .. 96
  volumetricScale: number; // 0.45 .. 0.85 resolution scale of raymarch pass
  gridResolutionMode: 'standard' | 'high';
  enableShadows: boolean;
  enableTemporalAccum: boolean;
  exposure: number;
  enableBloom: boolean;
  enableCameraShake: boolean;
  /**
   * Render scale multiplier on the device pixel ratio, 0.1 (tenth resolution, for very weak
   * GPUs) up to 1.0 (the engine's native cap). Scales every render target and the canvas
   * backing store, so it is the single highest-leverage frame-time control available.
   */
  pixelRatioScale: number;
  /** Physically-based per-pixel camera motion blur, gathered along depth-derived motion vectors. */
  enableMotionBlur: boolean;
  /**
   * Multiplier on the motion-blur smear length, 0..3.5 (i.e. 0-350%). At 1.0 the gather spans
   * the true frame-to-frame motion vector, which is the physically correct length; above that
   * it exaggerates for a speed-ramp look, below it tightens toward a crisp frame.
   */
  motionBlurIntensity: number;
  /** Animate the sun through a full 24 h cycle instead of holding a fixed solar elevation. */
  enableDayNightCycle: boolean;
  /** Wall-clock seconds for one complete 24 h solar cycle. */
  dayNightCycleSec: number;
  /** 0..24 local solar time; scrubbable, and the live readout while the cycle runs. */
  timeOfDayHours: number;
}

export interface ValidationDiagnostics {
  massContinuityResidual: number; // s^-1 max anelastic divergence error
  totalWaterMassKg: number; // total domain water substance
  waterConservationDriftPct: number; // % drift relative to surface flux integral
  chargeBalanceResidualC: number; // net global charge + ground transfer residual
  maxCFL: number; // Courant-Friedrichs-Lewy stability number (< 1.0)
  thermodynamicConsistent: boolean;
}

export interface PerformanceMetrics {
  fps: number;
  frameTimeMs: number;
  physicsTimeMs: number;
  renderTimeMs: number;
  memoryUsedMB: number | null;
  gpuRenderer: string;
  activeTier: QualityTier;
  raymarchStepsActive: number;
  volumetricScaleActive: number;
  /** Effective device pixel ratio actually being rendered at (base DPR x pixelRatioScale). */
  pixelRatioActive: number;
  /** Internal render width x height in device pixels, for the HUD resolution readout. */
  renderWidthPx: number;
  renderHeightPx: number;
}

export interface SimulationTelemetrySnapshot {
  simTimeSec: number;
  organization: StormOrganizationMode;
  instability: InstabilityTelemetry;
  activeCellCount: number;
  matureCellCount: number;
  supercellCount: number;
  coldPoolCount: number;
  maxUpdraftMS: number;
  maxDowndraftMS: number;
  domainCloudCoverPct: number;
  meanCloudWaterGKg: number;
  meanIceGKg: number;
  meanGraupelHailGKg: number;
  maxSurfaceRainMMHr: number;
  observerRainMMHr: number;
  observerPrecipType: PrecipitationType;
  surfaceWetness: number; // 0..1 at observer
  /**
   * Local surface weather resolved from the mesoscale boundary-layer field at the observer's
   * exact position. These differ from the domain-scale sounding values by design: standing under
   * a rain-cooled outflow reads several degrees colder, near saturation, and a rising pressure
   * tendency, while 10 km away in a sunlit dry slot reads warm, dry and capped.
   */
  observerTempC: number;
  observerDewpointC: number;
  observerRelHumidity: number;
  observerPressureHPa: number;
  observerLocalCape: number;
  observerLocalCin: number;
  observerLocalLcl: number;
  observerSoilSaturation: number;
  maxElectricFieldKVm: number;
  maxBreakdownRatio: number;
  maxPosChargeNCm3: number;
  maxNegChargeNCm3: number;
  totalFlashes: number;
  totalTLEs: number;
  /** Grounded mast: corona point-discharge brightness, 0..1. */
  rodCorona: number;
  /** Flashes that terminated on the rod instead of open ground. */
  rodInterceptions: number;
  /** Self-initiated upward leaders launched by the rod under strong ambient field. */
  rodUpwardLeaders: number;
  /** Active tornadic vortices, strongest first. */
  tornadoes: TornadoSnapshot[];
  cells: ConvectiveCell[];
  events: EventMonitorRecord[];
  validation: ValidationDiagnostics;
}
