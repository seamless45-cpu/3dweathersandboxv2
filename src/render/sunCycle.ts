import * as THREE from 'three';

const DEG = Math.PI / 180;

/**
 * Observer latitude for the diurnal solar geometry. Defaults to the tropical storm belt, where
 * deep convection actually lives: the noon sun passes nearly overhead, so day length stays close
 * to twelve hours and the insolation curve is steep around sunrise and sunset rather than shallow.
 */
const DEFAULT_LATITUDE_DEG = 13.5;

/**
 * Solar declination, i.e. the season. Held fixed at a mid storm-season value instead of being
 * animated alongside the daily cycle: a single day of convection is what the sandbox shows, and
 * folding in a yearly term would only make the sunset time drift without anyone seeing why.
 */
const DEFAULT_DECLINATION_DEG = 11.0;

/**
 * Compass azimuth (degrees clockwise from north) of the fixed manual-lighting sun. This is the
 * west-south-west side-lighting the renderer has always used, expressed as a bearing so that
 * manual and cycled sun positions land in the same place at the same elevation.
 */
export const MANUAL_SUN_AZIMUTH_DEG = 215.5;

/**
 * Lunar placement. The moon is *not* put at the anti-solar point, even though that is where a
 * full moon sits: two exactly opposed unit vectors interpolate through zero at twilight, and
 * normalising that blend gives a meaningless key-light direction. Offsetting the moon by nine
 * hours of hour angle and giving it its own declination keeps it well separated from the sun
 * across the whole cycle, and as a side effect it behaves like a real waxing gibbous - up and
 * high in the middle of the night, below the horizon through the evening.
 */
const MOON_HOUR_OFFSET = 9.0;
const MOON_DECLINATION_DEG = -18.0;

/**
 * sin() of the reference elevation used to normalise insolation to 1.0. Chosen so that turning
 * the day/night cycle on at its default time of day leaves the simulated surface heating exactly
 * where the manual 34 deg sun already put it, rather than silently damping every storm in the
 * domain by a fifth.
 */
const REFERENCE_SIN_ELEVATION = Math.sin(34.0 * DEG);

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export interface SunState {
  /** Unit vector pointing from the observer toward the sun (or below the horizon at night). */
  sunDir: THREE.Vector3;
  /** Unit vector toward the moon, which lights the scene once the sun is down. */
  moonDir: THREE.Vector3;
  /** 0 at full night, 1 in full daylight, transitioning through civil twilight. */
  daylight: number;
  /** 0..1 bell centred on the horizon: drives the orange sunrise/sunset palette. */
  twilight: number;
  /** 0..1 surface insolation for the convection scheme, normalised to 1.0 at 34 deg elevation. */
  insolation: number;
  sunElevationDeg: number;
  sunAzimuthDeg: number;
}

/**
 * Diurnal solar geometry.
 *
 * Solves the standard spherical-astronomy relations for a fixed latitude and declination:
 *   sin(elevation) = sin(lat)sin(dec) + cos(lat)cos(dec)cos(hourAngle)
 *   cos(azimuth)   = (sin(dec) - sin(elev)sin(lat)) / (cos(elev)cos(lat))
 * with the hour angle at 15 deg per hour from local solar noon, and azimuth taken clockwise from
 * north so that the afternoon sun resolves to the west.
 *
 * World axes follow the simulation domain: north is -Z and east is +X, so a compass bearing A at
 * elevation e becomes (cos e · sin A, sin e, -cos e · cos A).
 */
export class SunCycle {
  public latitudeDeg = DEFAULT_LATITUDE_DEG;
  public declinationDeg = DEFAULT_DECLINATION_DEG;
  public timeOfDayHours = 15.8;
  public cycleSeconds = 240;

  public readonly sunDir = new THREE.Vector3();
  public readonly moonDir = new THREE.Vector3();
  public daylight = 1;
  public twilight = 0;
  public insolation = 1;
  public sunElevationDeg = 34;
  public sunAzimuthDeg = MANUAL_SUN_AZIMUTH_DEG;

  constructor() {
    this.applyManualElevation(34.0);
  }

  /** Current state as a plain snapshot, for telemetry and the HUD clock readout. */
  public get state(): SunState {
    return {
      sunDir: this.sunDir,
      moonDir: this.moonDir,
      daylight: this.daylight,
      twilight: this.twilight,
      insolation: this.insolation,
      sunElevationDeg: this.sunElevationDeg,
      sunAzimuthDeg: this.sunAzimuthDeg,
    };
  }

  /**
   * Advances local solar time while the cycle is enabled. When it is disabled the sun holds
   * wherever the manual elevation slider put it, so this is a no-op and costs nothing.
   */
  public update(realDtSec: number, enabled: boolean): void {
    if (!enabled) return;
    const period = Math.max(5, this.cycleSeconds);
    this.timeOfDayHours = (this.timeOfDayHours + (24 * realDtSec) / period) % 24;
    this.recomputeFromTimeOfDay();
  }

  /** Jumps to an explicit local solar time and re-solves the geometry. */
  public setTimeOfDay(hours: number): void {
    this.timeOfDayHours = ((hours % 24) + 24) % 24;
    this.recomputeFromTimeOfDay();
  }

  /**
   * Inverts the elevation relation to find the local solar time at which the sun sits at a given
   * altitude, taking the afternoon branch so the azimuth matches the manual lighting rig.
   *
   * Used when the cycle is switched on: without it the scene would snap from wherever the manual
   * slider had the sun to whatever time of day happened to be stored, which reads as a jump cut.
   * Elevations the observer's latitude never reaches are clamped to the nearest achievable time.
   */
  public setTimeOfDayFromElevation(elevationDeg: number): void {
    const lat = this.latitudeDeg * DEG;
    const dec = this.declinationDeg * DEG;
    const denom = Math.cos(lat) * Math.cos(dec);
    if (Math.abs(denom) < 1e-6) {
      this.setTimeOfDay(elevationDeg >= 0 ? 12 : 0);
      return;
    }
    const cosH = clamp(
      (Math.sin(elevationDeg * DEG) - Math.sin(lat) * Math.sin(dec)) / denom,
      -1,
      1
    );
    // Afternoon branch: positive hour angle puts the sun in the west, matching the manual rig.
    const hourAngleDeg = Math.acos(cosH) / DEG;
    this.setTimeOfDay(12 + hourAngleDeg / 15);
  }

  /**
   * Places the sun at an explicit elevation on the fixed manual azimuth. Used when the cycle is
   * off, and lets the manual slider reach below the horizon so dusk and night are reachable
   * without turning the cycle on at all.
   */
  public applyManualElevation(elevationDeg: number): void {
    this.resolve(elevationDeg, MANUAL_SUN_AZIMUTH_DEG);
  }

  private recomputeFromTimeOfDay(): void {
    const lat = this.latitudeDeg * DEG;
    const dec = this.declinationDeg * DEG;
    const hourAngle = (this.timeOfDayHours - 12) * 15 * DEG;

    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);

    const sinElev = clamp(sinLat * sinDec + cosLat * cosDec * Math.cos(hourAngle), -1, 1);
    const elev = Math.asin(sinElev);
    const cosElev = Math.cos(elev);

    // Near the zenith the azimuth becomes ill-defined (everything is "south" when the sun is
    // overhead), so guard the division and hold the previous bearing rather than emit NaN.
    let azimuth: number;
    if (cosElev < 1e-4 || cosLat < 1e-4) {
      azimuth = this.sunAzimuthDeg * DEG;
    } else {
      const cosAz = clamp((sinDec - sinElev * sinLat) / (cosElev * cosLat), -1, 1);
      // acos resolves to the eastern half; the afternoon sun mirrors into the west.
      azimuth = hourAngle > 0 ? Math.PI * 2 - Math.acos(cosAz) : Math.acos(cosAz);
    }

    this.resolve(elev / DEG, azimuth / DEG);
  }

  /**
   * Solves the sky position of a body at a given local hour angle offset and declination,
   * writing a unit direction into `out`. Shared by the sun and the moon so both obey the same
   * spherical geometry and the same north-is-minus-Z world convention.
   */
  private solveBody(hourOfDay: number, declinationDeg: number, out: THREE.Vector3): number {
    const lat = this.latitudeDeg * DEG;
    const dec = declinationDeg * DEG;
    const ha = (hourOfDay - 12) * 15 * DEG;

    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinElev = clamp(sinLat * Math.sin(dec) + cosLat * Math.cos(dec) * Math.cos(ha), -1, 1);
    const elev = Math.asin(sinElev);
    const cosElev = Math.cos(elev);

    let azim: number;
    if (cosElev < 1e-4 || cosLat < 1e-4) {
      // Body near the zenith: azimuth is undefined, so hold due south rather than emit NaN.
      azim = Math.PI;
    } else {
      const cosAz = clamp((Math.sin(dec) - sinElev * sinLat) / (cosElev * cosLat), -1, 1);
      azim = ha > 0 ? Math.PI * 2 - Math.acos(cosAz) : Math.acos(cosAz);
    }

    out
      .set(cosElev * Math.sin(azim), sinElev, -cosElev * Math.cos(azim))
      .normalize();
    return elev / DEG;
  }

  /** Shared tail: turns an elevation/azimuth pair into directions and lighting scalars. */
  private resolve(elevationDeg: number, azimuthDeg: number): void {
    const elev = clamp(elevationDeg, -90, 90) * DEG;
    const azim = azimuthDeg * DEG;
    const cosElev = Math.cos(elev);

    this.sunDir
      .set(cosElev * Math.sin(azim), Math.sin(elev), -cosElev * Math.cos(azim))
      .normalize();

    // The moon follows its own track, so it is high in the middle of the night and gone by
    // mid-morning rather than mechanically mirroring the sun.
    this.solveBody(this.timeOfDayHours + MOON_HOUR_OFFSET, MOON_DECLINATION_DEG, this.moonDir);

    this.sunElevationDeg = elevationDeg;
    this.sunAzimuthDeg = ((azimuthDeg % 360) + 360) % 360;

    // Civil twilight spans roughly -6 deg to sunrise; the sky is still usefully lit there and
    // that band is where the most dramatic storm lighting happens.
    this.daylight = smoothstep(-7.0, 5.5, elevationDeg);
    this.twilight = clamp01(1 - Math.abs(elevationDeg) / 7.5);
    this.twilight *= this.twilight;

    const sinElev = Math.sin(Math.max(0, elev));
    this.insolation = clamp01(sinElev / REFERENCE_SIN_ELEVATION) * smoothstep(-3.0, 4.0, elevationDeg);
  }

  /**
   * Scales a user-facing solar heating preference by the current insolation. Kept separate from
   * the slider value so the day/night cycle can dim surface heating at dusk without overwriting
   * what the user actually chose.
   */
  public scaledSolarHeating(userFactor: number): number {
    return userFactor * this.insolation;
  }

  /** Local solar time rendered as a 24 h clock string, for the HUD. */
  public formatClock(): string {
    const totalMinutes = Math.floor(this.timeOfDayHours * 60) % 1440;
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}
