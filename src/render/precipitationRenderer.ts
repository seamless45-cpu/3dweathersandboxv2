import * as THREE from 'three';
import { getTerrainHeight } from '../sim/terrainField';
import { DOMAIN_HALF_SIZE, PrecipitationType } from '../sim/types';

const RAIN_STREAK_VERT = /* glsl */ `
  attribute vec3 aSeedPos;
  attribute float aCornerY; // 0 = top of streak, 1 = bottom of streak
  attribute float aCornerX; // -1 or +1 width
  attribute float aDropScale;
  // Particle diameter in metres, drawn from a log-normal drop-size distribution, so the
  // population contains the real mixture of drizzle droplets, raindrops and (when frozen) snow
  // flakes rather than one size with random jitter.
  attribute float aDiameterM;
  // 0 = small/fast-decaying population, 1 = large. Drives which shader lobe the drop uses.
  attribute float aPopulation;

  uniform float uTime;
  uniform vec3 uCameraPos;
  uniform vec3 uFallVel;
  uniform float uActiveFraction;
  uniform float uStreakWidth;
  uniform float uStreakLength;
  uniform float uPixelWorldAt1m;
  /** Horizontal wind at the top and bottom of the near-field box, for streak shear. */
  uniform vec3 uShearTop;
  uniform vec3 uShearBottom;
  uniform float uFrozenMix;

  varying float vAlpha;
  varying vec2 vLocalUv;
  // Cross-section basis and view direction, so the fragment shader can reconstruct a surface
  // normal for the water cylinder and shade it as a lens rather than as a flat decal.
  varying vec3 vSide;
  varying vec3 vViewDir;
  varying float vDist;
  varying float vScale;
  varying float vDiameter;
  varying float vPopulation;
  varying float vShear;

  void main() {
    // Cull excess instances smoothly based on rain rate
    float idFrac = fract(aSeedPos.x * 0.137 + aSeedPos.z * 0.293);
    if (idFrac > uActiveFraction) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      return;
    }

    float boxSpan = 56.0;
    float boxHeight = 36.0;
    // Fall speed is per-particle and follows the drag law for that drop's diameter, so small
    // drizzle droplets hang in the air while a 5 mm drop slams down at 9 m/s. Two drops in the
    // same frame therefore move at visibly different rates, which is the single strongest cue
    // that a rain curtain has a *size distribution* rather than one speed.
    float d = max(aDiameterM, 0.0002);
    float vt = 9.65 * (1.0 - exp(-pow(d / 0.00177, 1.147)));
    // Frozen particles fall much slower for their size: snow ~1 m/s, graupel ~3-5 m/s.
    float frozenVt = mix(0.9 + 1.1 * aPopulation, 3.4 + 3.2 * aPopulation, aPopulation);
    float fallSpeed = mix(mix(vt, uFallVel.y * -1.0, 0.55), frozenVt, uFrozenMix);
    vec3 localFall = vec3(uFallVel.x, -fallSpeed, uFallVel.z);
    vec3 animated = aSeedPos + localFall * uTime * (0.85 + 0.3 * aDropScale);
    vec3 rel = mod(animated - uCameraPos + vec3(boxSpan * 0.5, boxHeight * 0.5, boxSpan * 0.5), vec3(boxSpan, boxHeight, boxSpan))
               - vec3(boxSpan * 0.5, boxHeight * 0.5, boxSpan * 0.5);

    vec3 dropCenter = uCameraPos + rel;
    float dist = length(rel);

    vec3 velDir = normalize(uFallVel);
    vec3 viewDir = normalize(uCameraPos - dropCenter);
    vec3 side = cross(viewDir, velDir);
    // Looking straight along the fall direction makes that cross product vanish, and
    // normalize(0) is NaN -- which propagates into gl_Position and silently drops the
    // primitive. Fall back to any axis perpendicular to velDir in that case.
    float sideLen2 = dot(side, side);
    if (sideLen2 < 1e-8) {
      vec3 ref = abs(velDir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      side = cross(ref, velDir);
      sideLen2 = dot(side, side);
    }
    side = side * inversesqrt(max(sideLen2, 1e-8));

    // Distance-compensated width. uStreakWidth is a physical size (~1.5 cm for rain), which at
    // 20 m subtends well under a pixel, so the whole curtain of rain rasterised away to nothing.
    // Clamp to a minimum angular width instead: real rain looks like fine streaks at any range,
    // and keeping them at least ~1.7 px wide is what makes them read as droplets rather than as
    // a faint grey haze.
    float minWorld = uPixelWorldAt1m * dist * 1.7;
    // Physical width of the streak is the drop's own diameter plus the width smeared out by
    // its motion during the exposure; below one pixel it is lifted to the pixel floor.
    float physical = max(aDiameterM, 0.004) * 2.4 + uStreakWidth * aDropScale * 0.35;
    float halfWidth = max(physical, minWorld) * 0.5;

    // The streak is not a rigid stick: the wind changes across the exposure (shear), so the
    // top of the streak is displaced relative to the bottom. This is what makes wind-blown
    // rain read as slanted smears rather than as a field of parallel rods.
    float shearAmount = mix(uShearBottom.x, uShearTop.x, aCornerY);
    float shearAmountZ = mix(uShearBottom.z, uShearTop.z, aCornerY);

    vec3 worldPt = dropCenter
      + velDir * (aCornerY - 0.5) * uStreakLength * aDropScale
      + side * (aCornerX * halfWidth * 2.0)
      + vec3(uShearTop.x - shearAmount, 0.0, uShearTop.z - shearAmountZ) * 0.004;

    vAlpha = 1.0 - smoothstep(boxSpan * 0.32, boxSpan * 0.49, dist);
    vLocalUv = vec2(aCornerX * 0.5 + 0.5, aCornerY);
    vSide = side;
    vViewDir = viewDir;
    vDist = dist;
    vScale = aDropScale;
    vDiameter = d;
    vPopulation = aPopulation;
    vShear = length(vec2(uShearTop.x - shearAmount, uShearTop.z - shearAmountZ));

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPt, 1.0);
  }
`;

const RAIN_STREAK_FRAG = /* glsl */ `
  precision mediump float;

  uniform vec3 uTint;
  uniform float uLightningBoost;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uHazeColor;
  uniform float uFrozenShare;

  varying float vAlpha;
  varying vec2 vLocalUv;
  varying vec3 vSide;
  varying vec3 vViewDir;
  varying float vDist;
  varying float vScale;
  varying float vDiameter;
  varying float vPopulation;
  varying float vShear;

  void main() {
    if (vAlpha <= 0.004) discard;

    // ---- Cross-section: a falling drop is a water cylinder, not a flat quad ----------------
    // The old profile was a linear falloff to the edges, which reads as a painted stripe.
    // Modelling the actual chord through a cylinder gives a bright axis, softly refracting
    // flanks, and a surface normal that can carry a specular highlight.
    float x = vLocalUv.x * 2.0 - 1.0;
    float cyl = 1.0 - x * x;
    if (cyl <= 0.0015) discard;
    float chord = sqrt(cyl);            // optical path length through the drop
    vec3 V = normalize(vViewDir);
    vec3 N = normalize(vSide * x + V * chord);

    float ndl = max(dot(N, uLightDir), 0.0);
    vec3 H = normalize(uLightDir + V);
    // A tight lobe for the sun/moon glint on the drop surface, plus a broad one for the
    // refracted light thrown through the drop, which is what makes rain look wet rather
    // than dusty.
    //
    // The tight lobe is broadened for small drops. Water has a refractive index around 1.33 at
    // every size, but a 0.3 mm droplet is only a few pixels across, so the highlight covers
    // most of it and reads as a soft sheen; a 4 mm drop resolves the glint as a distinct point.
    // A single exponent made every drop glint identically and the rain looked granular.
    float glintWidth = mix(18.0, 110.0, smoothstep(0.0007, 0.0045, vDiameter));
    float spec = pow(max(dot(N, H), 0.0), glintWidth) * mix(0.55, 1.25, smoothstep(0.0007, 0.0045, vDiameter))
               + 0.20 * pow(max(dot(N, H), 0.0), 8.0);

    // ---- Chromatic dispersion ---------------------------------------------------------------
    // Water disperses: blue is refracted more than red, by about 1.5% of the deviation angle.
    // At the scale of a raindrop that is invisible as a rainbow, but it does tint the *edge*
    // of the refracted image blue-cyan and its centre slightly warm, which is a large part of
    // why real rain reads as water rather than as grey mist. Driven off the same Fresnel term
    // that drives the rim so the tint lands on the silhouette, not across the whole drop.
    float dispersion = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);

    // ---- Along the streak ------------------------------------------------------------------
    // sin(pi*y) made every streak a lozenge: bright in the middle, pinched at both ends. A
    // motion-blurred drop is instead near-uniform along its length with soft ends, so use a
    // flat-topped profile. Frozen pellets are compact, so they blend toward a centred blob.
    float y = vLocalUv.y;
    float streakProfile = smoothstep(0.0, 0.16, y) * smoothstep(1.0, 0.84, y);
    float pelletProfile = exp(-pow((y - 0.5) / 0.20, 2.0));
    float along = mix(streakProfile, pelletProfile, uFrozenShare);

    // Larger drops are slightly brighter and carry a harder glint; small ones are diffuse.
    float sizeBoost = 0.72 + 0.42 * clamp(vScale, 0.0, 1.4);

    float a = vAlpha * along * chord * sizeBoost * 0.62;

    // ---- Aerial perspective ----------------------------------------------------------------
    // Distant streaks lose contrast and take on the haze colour, which is the main cue that
    // separates a curtain of rain from a wall of identical quads.
    float haze = smoothstep(9.0, 46.0, vDist);
    vec3 body = uTint * (0.42 + 0.58 * ndl);
    // Refracted background: the drop samples the (haze-coloured) scene behind it, tinted by the
    // body colour. Large drops show a big, sharp inverted image of the world; small droplets
    // are effectively clear.
    float lens = smoothstep(0.0008, 0.0055, vDiameter) * (1.0 - uFrozenShare * 0.7);
    vec3 refracted = mix(body, uHazeColor * 0.72 + uTint * 0.28, lens * 0.55);
    vec3 col = refracted + uLightColor * spec * (0.85 + uFrozenShare * 1.5);
    // Warm the core, cool the rim. Kept small: this is a subtle physical cue, and pushing it
    // turns the rain into rainbow confetti.
    col *= mix(vec3(1.02, 1.0, 0.985), vec3(0.94, 1.0, 1.06), dispersion * 0.55);
    // Fresnel rim: grazing-angle reflections of the sky brighten the drop's silhouette, which
    // is the cue that makes a curtain of rain visible against a bright sky.
    //
    // fres and caustic used to be referenced here without ever being declared or uploaded,
    // which is not a subtle shading error: an undeclared identifier is a *compile* error, so
    // this entire fragment shader failed to build and the near-field rain curtain silently
    // rendered nothing at all. GLSL parsers accept the name (it is valid syntax) and only the
    // driver's linker rejects it, which is why a syntax-only validator never caught it.
    //
    // Both terms are now computed for real. The Fresnel weight is the standard Schlick
    // approximation on the view/surface angle, and the caustic term brightens the drop where
    // refracted light concentrates along its axis -- the bright thread that runs down a real
    // raindrop.
    float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    float caustic = 0.35 + 0.65 * chord * chord;
    col += uHazeColor * fresnel * (0.35 + 0.55 * uFrozenShare) * caustic * 0.5;
    col = mix(col, uHazeColor, haze * 0.74);
    a *= 1.0 - haze * 0.52;
    // Small drizzle drops are optically thin: they neither darken nor brighten much, they just
    // soften the scene behind them. Keeping their alpha low is what makes drizzle read as mist
    // rather than as a light rain shower.
    a *= mix(0.55, 1.0, smoothstep(0.0006, 0.0032, vDiameter));

    // Ice pellets are brighter and whiter than rain: they scatter rather than refract.
    col = mix(col, vec3(0.93, 0.96, 1.0) * (0.5 + 0.5 * ndl), uFrozenShare * 0.45);

    // Lightning lights drops from inside the shaft, and the specular term reacts hardest.
    col *= 1.0 + uLightningBoost * 2.6;
    col += uLightColor * spec * uLightningBoost * 3.4;
    a = clamp(a * (1.0 + uLightningBoost * 0.7), 0.0, 1.0);

    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

const SPLASH_VERT = /* glsl */ `
  attribute vec3 aSplashOffset;
  attribute float aPhase;

  uniform float uTime;
  uniform vec3 uObserverGround;
  uniform float uSplashActive;

  varying vec2 vUv;
  varying float vLife;
  varying float vEnergy;
  varying float vSpin;

  void main() {
    float idFrac = fract(aPhase * 3.71);
    if (idFrac > uSplashActive) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vLife = 0.0;
      return;
    }

    // Slightly slower cycle than before: real crown-and-ring splashes read as too frantic at
    // 3.2 Hz when the ring profile is resolved properly.
    float cycle = fract(uTime * 2.45 + aPhase);
    vLife = 1.0 - cycle;
    vUv = uv;
    // Impact energy varies drop to drop, so the splash population is not a uniform lattice of
    // identical rings -- the single most artificial thing about the old version.
    vEnergy = 0.55 + 0.9 * fract(aPhase * 7.13 + 0.31);
    vSpin = fract(aPhase * 11.7) * 6.28318;

    float span = 26.0;
    vec2 relXZ = mod(aSplashOffset.xz - uObserverGround.xz + span * 0.5, span) - span * 0.5;
    // Final crater size scales with impact energy, and expansion decelerates: capillary rings
    // open fast then slow as surface tension and viscosity take over, so radius ~ t^0.6 rather
    // than the previous linear ramp.
    float radius = mix(0.03, 0.16 + 0.16 * vEnergy, pow(cycle, 0.6));

    vec3 worldPos = vec3(
      uObserverGround.x + relXZ.x + position.x * radius,
      uObserverGround.y + 0.03,
      uObserverGround.z + relXZ.y + position.z * radius
    );

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const SPLASH_FRAG = /* glsl */ `
  precision mediump float;

  uniform float uLightningBoost;
  uniform vec3 uLightColor;
  varying vec2 vUv;
  varying float vLife;
  varying float vEnergy;
  varying float vSpin;

  void main() {
    if (vLife <= 0.01) discard;
    float cycle = 1.0 - vLife;

    // Rotate the sample so the crown is not a perfect circle on every instance; real impact
    // craters are lopsided because the drop is rarely vertical and the surface rarely flat.
    vec2 p = vUv * 2.0 - 1.0;
    float cs = cos(vSpin), sn = sin(vSpin);
    p = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
    float lopsided = 1.0 + 0.20 * sin(atan(p.y, p.x) * 3.0 + vSpin * 2.0);
    float r = length(p) * lopsided;

    // ---- Primary capillary ring: opens fast, thins as it expands --------------------------
    float ringR = 0.80 * pow(cycle, 0.6);
    float ringW = mix(0.30, 0.075, cycle);
    float ring = exp(-pow((r - ringR) / ringW, 2.0));

    // ---- Secondary rebound ring, slower and inside the first ------------------------------
    float ring2R = 0.44 * pow(cycle, 0.78);
    float ring2 = exp(-pow((r - ring2R) / (ringW * 1.7), 2.0)) * 0.45 * (1.0 - cycle * 0.6);

    // ---- Crown sheet: the flared lip thrown up at impact, brightest in the first moments ---
    float crown = exp(-pow((r - ringR * 1.16) / 0.20, 2.0)) * exp(-cycle * 5.5) * 0.7;

    // ---- Central impact flash, decays almost immediately ----------------------------------
    float core = exp(-r * r * 22.0) * exp(-cycle * 11.0);

    // ---- Wet spot that outlives the rings -------------------------------------------------
    // Drawn as a dark translucent disc: this is what makes a splash leave something behind on
    // the ground instead of flashing and vanishing.
    float wet = exp(-r * r * 6.0) * (1.0 - smoothstep(0.15, 0.95, cycle)) * 0.30;

    float bright = (ring + ring2 + crown) * vLife * vEnergy * 0.52 + core * vEnergy * 0.60;
    float alpha = clamp(bright, 0.0, 1.0);

    // A glint on the ring crest where it catches the light.
    float glint = pow(max(0.0, ring + crown), 2.0) * 0.55;

    vec3 water = vec3(0.72, 0.82, 0.93) + uLightColor * glint;
    water *= 0.85 + uLightningBoost * 2.1;

    // Composite: the bright crown and rings over a darkening wet disc.
    vec3 col = mix(vec3(0.055, 0.06, 0.07), water, clamp(bright * 1.6, 0.0, 1.0));
    alpha = clamp(alpha + wet * (1.0 - alpha * 0.6), 0.0, 1.0);

    if (alpha < 0.008) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

const NIGHT_HAZE = new THREE.Color(0.075, 0.095, 0.145);
const MOON_GLINT = new THREE.Color(0.55, 0.66, 0.92);

export class NearFieldPrecipitationRenderer {
  public streakMesh: THREE.Mesh;
  public splashMesh: THREE.Mesh;

  private streakMat: THREE.ShaderMaterial;
  private splashMat: THREE.ShaderMaterial;

  constructor() {
    this.streakMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_STREAK_VERT,
      fragmentShader: RAIN_STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      // Camera-facing quads built from side = cross(viewDir, velDir). The geometric normal of
      // that quad works out to velDir*(viewDir.velDir) - viewDir, whose -viewDir term dominates,
      // so the winding is BACK-facing for most drops and the default FrontSide culling threw
      // essentially all of them away. Billboards of this construction must be double-sided.
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uFallVel: { value: new THREE.Vector3(2, -9.5, -1) },
        uActiveFraction: { value: 0 },
        uStreakWidth: { value: 0.012 },
        uStreakLength: { value: 0.65 },
        uTint: { value: new THREE.Color(0.72, 0.8, 0.9) },
        uLightningBoost: { value: 0 },
        uLightDir: { value: new THREE.Vector3(0.4, 0.8, -0.45).normalize() },
        uLightColor: { value: new THREE.Color(1.0, 0.97, 0.92) },
        uHazeColor: { value: new THREE.Color(0.42, 0.47, 0.53) },
        uFrozenShare: { value: 0 },
        uShearTop: { value: new THREE.Vector3() },
        uShearBottom: { value: new THREE.Vector3() },
        uFrozenMix: { value: 0 },
        // World size of one pixel at 1 m distance, used to keep far drops above a pixel wide.
        uPixelWorldAt1m: { value: 0.001 },
      },
    });

    this.streakMesh = this.buildStreaks(5500);
    this.streakMesh.frustumCulled = false;

    this.splashMat = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      // Horizontal ground planes: from below the observer they are back-facing too.
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uObserverGround: { value: new THREE.Vector3() },
        uSplashActive: { value: 0 },
        uLightningBoost: { value: 0 },
        uLightColor: { value: new THREE.Color(1.0, 0.97, 0.92) },
      },
    });

    this.splashMesh = this.buildSplashes(900);
    this.splashMesh.frustumCulled = false;
  }

  private buildStreaks(count: number): THREE.Mesh {
    const geom = new THREE.InstancedBufferGeometry();
    const cornerX = new Float32Array([-1, 1, -1, 1]);
    const cornerY = new Float32Array([0, 0, 1, 1]);
    geom.setAttribute('aCornerX', new THREE.BufferAttribute(cornerX, 1));
    geom.setAttribute('aCornerY', new THREE.BufferAttribute(cornerY, 1));
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geom.setIndex([0, 1, 2, 2, 1, 3]);

    const seeds = new Float32Array(count * 3);
    const scales = new Float32Array(count);
    const diameters = new Float32Array(count);
    const populations = new Float32Array(count);
    let s = 918273;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };

    for (let i = 0; i < count; i++) {
      seeds[i * 3] = (rnd() - 0.5) * 56.0;
      seeds[i * 3 + 1] = (rnd() - 0.5) * 36.0;
      seeds[i * 3 + 2] = (rnd() - 0.5) * 56.0;
      scales[i] = 0.65 + rnd() * 0.75;
      // Log-normal drop-size draw. Real rain spectra are dominated in *number* by 0.3-0.8 mm
      // droplets but in *water* by 1-3 mm drops, and a hail shaft contains a tail out to 2 cm.
      // Drawing the diameter rather than the "scale" is what lets one instance field contain
      // both the fine mist and the fat splashing drops.
      const u1 = Math.max(1e-6, rnd());
      const u2 = rnd();
      const gauss = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(Math.PI * 2.0 * u2);
      const medianMm = 0.45 + 0.55 * rnd();
      const sigma = 0.6 + 0.5 * rnd();
      const diameterMm = Math.max(0.15, Math.min(26.0, medianMm * Math.exp(sigma * gauss)));
      diameters[i] = diameterMm * 1e-3;
      // Population weight: 0 = droplet, 1 = large drop / hailstone.
      populations[i] = Math.min(1, Math.max(0, (diameterMm - 0.35) / 2.4));
    }

    geom.setAttribute('aSeedPos', new THREE.InstancedBufferAttribute(seeds, 3));
    geom.setAttribute('aDropScale', new THREE.InstancedBufferAttribute(scales, 1));
    geom.setAttribute('aDiameterM', new THREE.InstancedBufferAttribute(diameters, 1));
    geom.setAttribute('aPopulation', new THREE.InstancedBufferAttribute(populations, 1));
    geom.instanceCount = count;

    return new THREE.Mesh(geom, this.streakMat);
  }

  private buildSplashes(count: number): THREE.Mesh {
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);

    const geom = new THREE.InstancedBufferGeometry();
    geom.index = plane.index;
    geom.attributes.position = plane.attributes.position;
    geom.attributes.uv = plane.attributes.uv;

    const offsets = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    let s = 123987;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };

    for (let i = 0; i < count; i++) {
      offsets[i * 3] = (rnd() - 0.5) * 26.0;
      offsets[i * 3 + 1] = 0;
      offsets[i * 3 + 2] = (rnd() - 0.5) * 26.0;
      phases[i] = rnd();
    }

    geom.setAttribute('aSplashOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    geom.instanceCount = count;

    return new THREE.Mesh(geom, this.splashMat);
  }

  public update(params: {
    realTimeSec: number;
    cameraPos: THREE.Vector3;
    rainRateMMHr: number;
    precipType: PrecipitationType;
    windU: number;
    windW: number;
    lightningFlash: number;
    /** Mass-weighted terminal fall speed of what is actually reaching the observer (m/s). */
    fallSpeedMS?: number;
    /** 0..1 share of the surface flux that is frozen (snow, graupel or hail). */
    frozenFraction?: number;
    /** 0..1 gustiness from nearby downdrafts and gust fronts; slants the streaks further. */
    gustFactor?: number;
    /** Dominant light direction (sun by day, moon by night), used for the drop glint. */
    lightDir?: THREE.Vector3;
    /** Colour of that light, so the glint goes warm at sunset and cold under the moon. */
    lightColor?: THREE.Color;
    /** Distance haze colour for aerial perspective on far streaks. */
    hazeColor?: THREE.Color;
    /** 0..1 daylight, used to pull the haze colour toward night. */
    daylight?: number;
    /** Vertical field of view in degrees, for the distance-compensated streak width. */
    fovDeg?: number;
    /** Render target height in device pixels, for the same. */
    renderHeightPx?: number;
  }): void {
    // Perceived density saturates well below a torrential core rate, so use a compressive
    // curve: a 10 mm/h shower already fills the view, and 150 mm/h reads as a solid curtain.
    const active = Math.min(1.0, Math.pow(params.rainRateMMHr / 95.0, 0.62));
    this.streakMesh.visible = active > 0.004;

    if (this.streakMesh.visible) {
      const u = this.streakMat.uniforms;
      const frozen = clamp01(params.frozenFraction ?? frozenShareOfType(params.precipType));
      // Fall speed comes from the microphysics (mass-weighted across rain/snow/graupel/hail)
      // rather than a hard-coded per-type constant, so a shaft that has just melted out of
      // hail accelerates visibly as it switches to rain.
      const fall = clamp(params.fallSpeedMS ?? defaultFallSpeed(params.precipType), 0.6, 26.0);
      const gust = clamp01(params.gustFactor ?? 0);

      u.uTime.value = params.realTimeSec;
      u.uCameraPos.value.copy(params.cameraPos);
      u.uActiveFraction.value = Math.pow(active, 0.6);
      u.uLightningBoost.value = params.lightningFlash;
      u.uFrozenShare.value = frozen;

      // World size of one pixel at 1 m from the camera: 2*tan(fov/2) / heightPx. The streak
      // width clamp in the vertex shader multiplies it by the drop distance.
      const fov = params.fovDeg ?? 60;
      const hPx = Math.max(1, params.renderHeightPx ?? 1080);
      u.uPixelWorldAt1m.value = (2.0 * Math.tan((fov * Math.PI) / 360.0)) / hPx;

      // Water optics need a light. Fall back to a high sun if the scene does not supply one so
      // the material is never left shading against a zero vector.
      if (params.lightDir && params.lightDir.lengthSq() > 1e-6) {
        u.uLightDir.value.copy(params.lightDir).normalize();
      }
      if (params.lightColor) u.uLightColor.value.copy(params.lightColor);
      if (params.hazeColor) u.uHazeColor.value.copy(params.hazeColor);
      const day = clamp01(params.daylight ?? 1.0);
      // At night the haze goes to the moonlit blue-grey and the drops lose their warm glint.
      u.uHazeColor.value.lerp(NIGHT_HAZE, 1.0 - day);
      u.uLightColor.value.lerp(MOON_GLINT, (1.0 - day) * 0.85);

      // Falling hydrometeors reach ~75-90 % of the horizontal wind (drag-limited), and snow
      // couples more tightly than hail because it stays airborne far longer.
      const windCoupling = 0.62 + 0.28 * frozen + 0.1 * gust;
      u.uFallVel.value.set(
        params.windU * windCoupling * (1.0 + gust * 0.55),
        -fall,
        params.windW * windCoupling * (1.0 + gust * 0.55)
      );
      // Shear across the near-field box: the difference between the wind at the top of a
      // streak and at its bottom, which is what slants rain in a strong low-level jet.
      const shearGain = (1.0 + gust * 1.6) * 0.32;
      u.uShearTop.value.set(
        params.windU * windCoupling * shearGain,
        0,
        params.windW * windCoupling * shearGain
      );
      u.uShearBottom.value.set(0, 0, 0);
      u.uFrozenMix.value = frozen;

      // Streak length is a motion-blur exposure: length = fallSpeed * exposureTime. That makes
      // hail (fast) streak long and snow (slow) read as short dabs, which is the opposite of
      // the previous hard-coded mapping.
      const exposureSec = 0.052;
      u.uStreakLength.value = clamp(fall * exposureSec * (1.0 - 0.45 * frozen), 0.03, 1.15);
      // Frozen particles are larger and scatter more, so they need a wider quad to be visible.
      u.uStreakWidth.value = 0.011 + 0.026 * frozen + 0.004 * active;

      // Liquid rain is a dim blue-grey; ice is bright and near-white.
      u.uTint.value.setRGB(
        0.68 + 0.29 * frozen,
        0.77 + 0.2 * frozen,
        0.88 + 0.12 * frozen
      );
    }

    const groundY =
      Math.abs(params.cameraPos.x) < DOMAIN_HALF_SIZE &&
      Math.abs(params.cameraPos.z) < DOMAIN_HALF_SIZE
        ? getTerrainHeight(params.cameraPos.x, params.cameraPos.z)
        : 0;
    const nearGround = params.cameraPos.y - groundY < 45.0;
    // Splashes are a liquid-impact effect: scale them by the liquid share of the flux so a
    // mixed-phase shaft still rings on wet ground, while pure snow stays silent.
    const frozenShare = clamp01(params.frozenFraction ?? frozenShareOfType(params.precipType));
    const liquidActive = active * (1.0 - frozenShare * 0.92);
    this.splashMesh.visible =
      nearGround && liquidActive > 0.02 && params.precipType !== 'Virga';

    if (this.splashMesh.visible) {
      const su = this.splashMat.uniforms;
      su.uTime.value = params.realTimeSec;
      su.uObserverGround.value.set(params.cameraPos.x, groundY, params.cameraPos.z);
      su.uSplashActive.value = Math.min(1.0, liquidActive * 1.25);
      su.uLightningBoost.value = params.lightningFlash;
      // Share the streak material's resolved light colour so the crown glint matches the drops.
      su.uLightColor.value.copy(this.streakMat.uniforms.uLightColor.value);
    }
  }

  public dispose(): void {
    this.streakMesh.geometry.dispose();
    this.streakMat.dispose();
    this.splashMesh.geometry.dispose();
    this.splashMat.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fallback fall speed when the simulation has not supplied a mass-weighted value. */
function defaultFallSpeed(type: PrecipitationType): number {
  switch (type) {
    case 'Snow / Ice Pellets':
      return 1.2;
    case 'Graupel Shower':
      return 4.6;
    case 'Hail & Heavy Rain':
      return 11.5;
    case 'Mixed-Phase Precipitation':
      return 6.0;
    case 'Drizzle':
      return 2.1;
    case 'Virga':
      return 3.4;
    case 'None':
      return 6.4;
    default:
      return 6.4 + Math.min(3.0, 0.0);
  }
}

/** Frozen share of the surface flux implied by the WMO precipitation type. */
function frozenShareOfType(type: PrecipitationType): number {
  switch (type) {
    case 'Snow / Ice Pellets':
      return 1.0;
    case 'Graupel Shower':
      return 0.85;
    case 'Hail & Heavy Rain':
      return 0.45;
    case 'Mixed-Phase Precipitation':
      return 0.5;
    default:
      return 0.0;
  }
}
