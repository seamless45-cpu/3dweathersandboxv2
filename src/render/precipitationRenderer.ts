import * as THREE from 'three';
import { getTerrainHeight } from '../sim/terrainField';
import { DOMAIN_HALF_SIZE, PrecipitationType } from '../sim/types';

const RAIN_STREAK_VERT = /* glsl */ `
  attribute vec3 aSeedPos;
  attribute float aCornerY; // 0 = top of streak, 1 = bottom of streak
  attribute float aCornerX; // -1 or +1 width
  attribute float aDropScale;

  uniform float uTime;
  uniform vec3 uCameraPos;
  uniform vec3 uFallVel;
  uniform float uActiveFraction;
  uniform float uStreakWidth;
  uniform float uStreakLength;

  varying float vAlpha;
  varying vec2 vLocalUv;

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
    vec3 animated = aSeedPos + uFallVel * uTime * (0.85 + 0.3 * aDropScale);
    vec3 rel = mod(animated - uCameraPos + vec3(boxSpan * 0.5, boxHeight * 0.5, boxSpan * 0.5), vec3(boxSpan, boxHeight, boxSpan))
               - vec3(boxSpan * 0.5, boxHeight * 0.5, boxSpan * 0.5);

    vec3 dropCenter = uCameraPos + rel;
    float dist = length(rel);

    vec3 velDir = normalize(uFallVel);
    vec3 viewDir = normalize(uCameraPos - dropCenter);
    vec3 side = normalize(cross(viewDir, velDir));

    vec3 worldPt = dropCenter
      + velDir * (aCornerY - 0.5) * uStreakLength * aDropScale
      + side * (aCornerX * uStreakWidth * aDropScale);

    vAlpha = (1.0 - smoothstep(boxSpan * 0.32, boxSpan * 0.49, dist)) * 0.55;
    vLocalUv = vec2(aCornerX * 0.5 + 0.5, aCornerY);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPt, 1.0);
  }
`;

const RAIN_STREAK_FRAG = /* glsl */ `
  precision mediump float;

  uniform vec3 uTint;
  uniform float uLightningBoost;

  varying float vAlpha;
  varying vec2 vLocalUv;

  void main() {
    if (vAlpha <= 0.005) discard;
    float edge = 1.0 - abs(vLocalUv.x * 2.0 - 1.0);
    float tipFade = sin(vLocalUv.y * 3.14159);
    float a = vAlpha * edge * tipFade;
    vec3 col = uTint * (1.0 + uLightningBoost * 2.6);
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

  void main() {
    float idFrac = fract(aPhase * 3.71);
    if (idFrac > uSplashActive) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vLife = 0.0;
      return;
    }

    float cycle = fract(uTime * 3.2 + aPhase);
    vLife = 1.0 - cycle;
    vUv = uv;

    float span = 26.0;
    vec2 relXZ = mod(aSplashOffset.xz - uObserverGround.xz + span * 0.5, span) - span * 0.5;
    float radius = mix(0.03, 0.24, cycle);

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
  varying vec2 vUv;
  varying float vLife;

  void main() {
    if (vLife <= 0.01) discard;
    float r = length(vUv * 2.0 - 1.0);
    float ring = exp(-pow((r - 0.78) / 0.16, 2.0));
    float alpha = ring * vLife * 0.48;
    if (alpha < 0.01) discard;
    vec3 col = vec3(0.75, 0.84, 0.94) * (0.85 + uLightningBoost * 1.8);
    gl_FragColor = vec4(col, alpha);
  }
`;

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
      uniforms: {
        uTime: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
        uFallVel: { value: new THREE.Vector3(2, -9.5, -1) },
        uActiveFraction: { value: 0 },
        uStreakWidth: { value: 0.012 },
        uStreakLength: { value: 0.65 },
        uTint: { value: new THREE.Color(0.72, 0.8, 0.9) },
        uLightningBoost: { value: 0 },
      },
    });

    this.streakMesh = this.buildStreaks(5500);
    this.streakMesh.frustumCulled = false;

    this.splashMat = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uObserverGround: { value: new THREE.Vector3() },
        uSplashActive: { value: 0 },
        uLightningBoost: { value: 0 },
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
    }

    geom.setAttribute('aSeedPos', new THREE.InstancedBufferAttribute(seeds, 3));
    geom.setAttribute('aDropScale', new THREE.InstancedBufferAttribute(scales, 1));
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

      // Falling hydrometeors reach ~75-90 % of the horizontal wind (drag-limited), and snow
      // couples more tightly than hail because it stays airborne far longer.
      const windCoupling = 0.62 + 0.28 * frozen + 0.1 * gust;
      u.uFallVel.value.set(
        params.windU * windCoupling * (1.0 + gust * 0.55),
        -fall,
        params.windW * windCoupling * (1.0 + gust * 0.55)
      );

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
