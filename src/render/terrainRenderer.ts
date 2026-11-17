import * as THREE from 'three';
import { getTerrainHeight } from '../sim/terrainField';
import { DOMAIN_HALF_SIZE, DOMAIN_MAX_ALT, DOMAIN_SIZE } from '../sim/types';

const TERRAIN_VERT = /* glsl */ `
  out vec3 vWorldPos;
  out vec3 vNormalW;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const TERRAIN_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uVolTex;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uDaylight;
  uniform vec3 uCameraPos;
  uniform float uWetness;
  uniform float uRainHaze;
  uniform float uTime;
  uniform vec3 uLightningPos;
  uniform float uLightningIntensity;
  uniform float uDomainSize;
  uniform float uMaxAlt;
  uniform float uShadowsEnabled;

  in vec3 vWorldPos;
  in vec3 vNormalW;
  out vec4 fragColor;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float sampleCloudShadow(vec3 worldPos) {
    if (uShadowsEnabled < 0.5) return 1.0;
    // March 5 steps from surface toward sun through the 3D atmospheric volume texture
    float shadowExt = 0.0;
    vec3 dir = normalize(vec3(uSunDir.x, max(0.14, uSunDir.y), uSunDir.z));
    for (int i = 1; i <= 5; i++) {
      float t = float(i) * 1450.0;
      vec3 p = worldPos + dir * t;
      vec3 uvw = vec3(
        (p.x + uDomainSize * 0.5) / uDomainSize,
        p.y / uMaxAlt,
        (p.z + uDomainSize * 0.5) / uDomainSize
      );
      if (uvw.x >= 0.0 && uvw.x <= 1.0 && uvw.y >= 0.0 && uvw.y <= 1.0 && uvw.z >= 0.0 && uvw.z <= 1.0) {
        vec4 v = texture(uVolTex, uvw);
        shadowExt += (v.r * 1.35 + v.g * 0.85);
      }
    }
    return exp(-shadowExt * 0.95);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCameraPos - vWorldPos);
    float dist = length(uCameraPos - vWorldPos);

    // Multi-scale procedural soil, meadow grass & distant rock strata
    float nMacro = noise2(vWorldPos.xz * 0.0018);
    float nMid = noise2(vWorldPos.xz * 0.025);
    float nMicro = noise2(vWorldPos.xz * 0.35);

    vec3 drySoil = vec3(0.24, 0.19, 0.14) * (0.85 + 0.3 * nMicro);
    vec3 lushGrass = mix(vec3(0.15, 0.27, 0.10), vec3(0.24, 0.33, 0.13), nMacro);
    vec3 dryPrairie = vec3(0.30, 0.28, 0.16);

    float slope = 1.0 - clamp(N.y, 0.0, 1.0);
    float grassMask = smoothstep(0.32, 0.05, slope) * smoothstep(260.0, 95.0, vWorldPos.y);
    vec3 baseAlbedo = mix(drySoil, mix(lushGrass, dryPrairie, nMid * 0.55), grassMask);

    // Puddle formation in flat micro-depressions when uWetness rises
    float puddleDepression = smoothstep(0.56, 0.34, nMid * 0.7 + nMacro * 0.3) * smoothstep(0.08, 0.01, slope);
    float puddleMask = clamp((uWetness - 0.28) * 1.9, 0.0, 1.0) * puddleDepression;

    // Wet soil & foliage darkening
    baseAlbedo *= mix(1.0, 0.52, uWetness * (1.0 - puddleMask * 0.5));

    // Ripple normal perturbation in active puddles during rain
    if (puddleMask > 0.05) {
      float ripple = sin(length(vWorldPos.xz * 3.5 - floor(vWorldPos.xz * 0.5) * 7.0) * 12.0 - uTime * 16.0);
      vec3 puddleN = normalize(vec3(ripple * 0.03 * uRainHaze, 1.0, ripple * 0.03 * uRainHaze));
      N = normalize(mix(N, puddleN, puddleMask * 0.92));
    }

    // Direct solar + sky hemisphere + real-time 3D cloud shadow, across the diurnal cycle
    float sunHeight = clamp(uSunDir.y, 0.02, 1.0);
    float daylight = clamp(uDaylight, 0.0, 1.0);
    vec3 sunColor = mix(vec3(1.0, 0.62, 0.36), vec3(1.0, 0.96, 0.90), smoothstep(0.05, 0.45, sunHeight));
    float cloudShadow = sampleCloudShadow(vWorldPos);
    float ndotl = max(0.0, dot(N, uSunDir));

    // Night floor: cool moonlight from the anti-solar direction over a deep blue hemisphere.
    // Held low enough that lightning stays the dominant light source after dark, which is what
    // makes a night storm legible from the ground instead of a black frame with sparks in it.
    float moonElev = clamp(uMoonDir.y, 0.0, 1.0);
    float ndotm = max(0.0, dot(N, uMoonDir));
    vec3 nightAmbient =
      mix(vec3(0.016, 0.023, 0.042), vec3(0.030, 0.042, 0.072), sunHeight) +
      vec3(0.020, 0.028, 0.048) * moonElev;
    nightAmbient *= 0.55 + 0.45 * cloudShadow;
    vec3 moonLight = vec3(0.36, 0.48, 0.78) * ndotm * cloudShadow * 0.17 * moonElev;

    vec3 dayAmbient =
      mix(vec3(0.14, 0.18, 0.25), vec3(0.24, 0.33, 0.46), sunHeight) * (0.55 + 0.45 * cloudShadow);
    vec3 skyAmbient = mix(nightAmbient, dayAmbient, daylight);
    vec3 directLight = sunColor * ndotl * cloudShadow * 1.45 * daylight + moonLight;

    // Dynamic Lightning Ground Illumination & Puddle Specular Glint
    vec3 toBolt = uLightningPos - vWorldPos;
    float boltDistKm = max(0.25, length(toBolt) * 0.001);
    vec3 boltDir = normalize(toBolt);
    float boltAtten = uLightningIntensity / (1.0 + boltDistKm * boltDistKm * 0.085);
    vec3 lightningDiffuse = vec3(0.76, 0.84, 1.0) * max(0.15, dot(N, boltDir)) * boltAtten * 1.25;

    vec3 col = baseAlbedo * (skyAmbient + directLight + lightningDiffuse);

    // Wet surface & puddle Fresnel reflection of sky & lightning flash
    float fresnel = pow(1.0 - max(0.0, dot(N, V)), 4.0);
    float reflectivity = mix(0.02, 0.68, puddleMask) + uWetness * 0.16;
    vec3 dayRefl = mix(vec3(0.22, 0.28, 0.36), vec3(0.42, 0.56, 0.76), cloudShadow * sunHeight);
    vec3 reflSky = mix(vec3(0.020, 0.028, 0.048), dayRefl, daylight) +
                   vec3(0.82, 0.88, 1.0) * boltAtten * 0.95;
    col = mix(col, reflSky, clamp(fresnel * reflectivity + puddleMask * 0.32, 0.0, 0.85));

    // Atmospheric Rayleigh/Mie distance haze + rain curtain visibility reduction
    float hazeDensity = 0.000052 + uRainHaze * 0.00022;
    float fogFactor = 1.0 - exp(-dist * hazeDensity);
    vec3 dayHaze = mix(
      vec3(0.62, 0.74, 0.88),
      vec3(0.30, 0.35, 0.42),
      clamp(uRainHaze * 1.1 + (1.0 - cloudShadow) * 0.5, 0.0, 1.0)
    );
    // A flash still lights the fog at night, so the bolt term stays outside the daylight mix.
    vec3 horizonHazeColor = mix(
      mix(vec3(0.028, 0.038, 0.062), dayHaze, daylight),
      vec3(0.75, 0.82, 0.98),
      clamp(boltAtten * 0.35, 0.0, 0.65)
    );
    col = mix(col, horizonHazeColor, clamp(fogFactor, 0.0, 0.96));

    fragColor = vec4(col, 1.0);
  }
`;

const GRASS_VERT = /* glsl */ `
  attribute vec3 aOffset;
  attribute float aScale;
  attribute float aPhase;

  uniform float uTime;
  uniform vec2 uWindXZ;
  uniform vec3 uObserverPos;

  varying float vHeightFrac;
  varying float vShade;
  varying float vDistFade;

  void main() {
    // Recenter grass patch modulo tile around ground observer so walking anywhere on meadow stays lush!
    float patchSpan = 170.0;
    vec2 relXZ = mod(aOffset.xz - uObserverPos.xz + patchSpan * 0.5, patchSpan) - patchSpan * 0.5;
    vec2 worldXZ = uObserverPos.xz + relXZ;

    float dist = length(relXZ);
    vDistFade = 1.0 - smoothstep(patchSpan * 0.36, patchSpan * 0.49, dist);

    vHeightFrac = clamp(position.y / 0.62, 0.0, 1.0);
    float windSpeed = length(uWindXZ);
    vec2 windDir = windSpeed > 0.01 ? uWindXZ / windSpeed : vec2(0.7, 0.7);

    float gust = sin(uTime * (2.2 + windSpeed * 0.22) + dot(worldXZ, windDir) * 0.14 + aPhase);
    float bend = (windSpeed * 0.032 + 0.06 * gust * (0.4 + windSpeed * 0.12)) * vHeightFrac * vHeightFrac;

    vec3 localPos = position * aScale * vDistFade;
    localPos.xz += windDir * bend;

    // Anchor Y to observer ground plane + subtle local offset
    vec3 wp = vec3(worldXZ.x + localPos.x, uObserverPos.y - 1.7 + localPos.y, worldXZ.y + localPos.z);
    vShade = 0.55 + 0.45 * vHeightFrac;

    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const GRASS_FRAG = /* glsl */ `
  precision mediump float;

  uniform float uWetness;
  uniform float uAmbientDim;
  uniform float uLightningFlash;

  varying float vHeightFrac;
  varying float vShade;
  varying float vDistFade;

  void main() {
    if (vDistFade < 0.03) discard;
    vec3 rootCol = vec3(0.10, 0.18, 0.06);
    vec3 tipCol = vec3(0.28, 0.42, 0.15);
    vec3 col = mix(rootCol, tipCol, vHeightFrac) * vShade;
    col *= mix(1.0, 0.62, uWetness);
    col *= uAmbientDim;
    col += vec3(0.45, 0.52, 0.68) * uLightningFlash * vHeightFrac;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class GroundEnvironmentRenderer {
  public terrainMesh: THREE.Mesh;
  public grassMesh: THREE.Mesh;
  private terrainMat: THREE.ShaderMaterial;
  private grassMat: THREE.ShaderMaterial;

  constructor(volTexture: THREE.Data3DTexture) {
    // High-resolution terrain grid (200 x 200 vertices across 32km x 32km)
    const segs = 196;
    const geom = new THREE.PlaneGeometry(DOMAIN_SIZE, DOMAIN_SIZE, segs, segs);
    geom.rotateX(-Math.PI / 2);

    const posAttr = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      posAttr.setY(i, getTerrainHeight(x, z));
    }
    geom.computeVertexNormals();

    this.terrainMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: {
        uVolTex: { value: volTexture },
        uSunDir: { value: new THREE.Vector3(0.4, 0.55, -0.72).normalize() },
        uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, 0.72).normalize() },
        uDaylight: { value: 1.0 },
        uCameraPos: { value: new THREE.Vector3() },
        uWetness: { value: 0 },
        uRainHaze: { value: 0 },
        uTime: { value: 0 },
        uLightningPos: { value: new THREE.Vector3(0, 4000, 0) },
        uLightningIntensity: { value: 0 },
        uDomainSize: { value: DOMAIN_SIZE },
        uMaxAlt: { value: DOMAIN_MAX_ALT },
        uShadowsEnabled: { value: 1.0 },
      },
    });

    this.terrainMesh = new THREE.Mesh(geom, this.terrainMat);
    this.terrainMesh.frustumCulled = false;

    // Instanced Meadow Grass Blades around ground-level observer
    this.grassMat = new THREE.ShaderMaterial({
      vertexShader: GRASS_VERT,
      fragmentShader: GRASS_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uWindXZ: { value: new THREE.Vector2(3, -2) },
        uObserverPos: { value: new THREE.Vector3(0, 10, 5200) },
        uWetness: { value: 0 },
        uAmbientDim: { value: 1.0 },
        uLightningFlash: { value: 0.0 },
      },
    });

    this.grassMesh = this.buildInstancedGrass(15000);
    this.grassMesh.frustumCulled = false;
  }

  private buildInstancedGrass(count: number): THREE.Mesh {
    // 3-segment tapered grass blade
    const bladeGeom = new THREE.InstancedBufferGeometry();
    const vertices = new Float32Array([
      -0.035, 0.0, 0.0,
       0.035, 0.0, 0.0,
      -0.024, 0.28, 0.0,
       0.024, 0.28, 0.0,
       0.0,   0.62, 0.015,
    ]);
    const indices = [0, 1, 2, 1, 3, 2, 2, 3, 4];
    bladeGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    bladeGeom.setIndex(indices);

    const offsets = new Float32Array(count * 3);
    const scales = new Float32Array(count);
    const phases = new Float32Array(count);

    let seed = 48271;
    const nextRand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const span = 170.0;
    for (let i = 0; i < count; i++) {
      offsets[i * 3] = (nextRand() - 0.5) * span;
      offsets[i * 3 + 1] = 0;
      offsets[i * 3 + 2] = (nextRand() - 0.5) * span;
      scales[i] = 0.65 + nextRand() * 0.85;
      phases[i] = nextRand() * Math.PI * 2.0;
    }

    bladeGeom.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    bladeGeom.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    bladeGeom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    bladeGeom.instanceCount = count;

    return new THREE.Mesh(bladeGeom, this.grassMat);
  }

  public update(params: {
    timeSec: number;
    sunDir: THREE.Vector3;
    moonDir: THREE.Vector3;
    daylight: number;
    cameraPos: THREE.Vector3;
    isGroundMode: boolean;
    wetness: number;
    rainHaze: number;
    windU: number;
    windW: number;
    cloudCoverFrac: number;
    lightningPos: THREE.Vector3;
    lightningIntensity: number;
    shadowsEnabled: boolean;
  }): void {
    const u = this.terrainMat.uniforms;
    u.uTime.value = params.timeSec;
    u.uSunDir.value.copy(params.sunDir);
    u.uMoonDir.value.copy(params.moonDir);
    u.uDaylight.value = params.daylight;
    u.uCameraPos.value.copy(params.cameraPos);
    u.uWetness.value = params.wetness;
    u.uRainHaze.value = params.rainHaze;
    u.uLightningPos.value.copy(params.lightningPos);
    u.uLightningIntensity.value = params.lightningIntensity;
    u.uShadowsEnabled.value = params.shadowsEnabled ? 1.0 : 0.0;

    // Grass only needed when observer is near ground (< 90m AGL)
    const groundAtCam =
      Math.abs(params.cameraPos.x) < DOMAIN_HALF_SIZE &&
      Math.abs(params.cameraPos.z) < DOMAIN_HALF_SIZE
        ? getTerrainHeight(params.cameraPos.x, params.cameraPos.z)
        : 0;
    const agl = params.cameraPos.y - groundAtCam;
    this.grassMesh.visible = agl < 95.0;

    if (this.grassMesh.visible) {
      const gu = this.grassMat.uniforms;
      gu.uTime.value = params.timeSec;
      gu.uWindXZ.value.set(params.windU, params.windW);
      gu.uObserverPos.value.set(
        params.cameraPos.x,
        groundAtCam + 1.7,
        params.cameraPos.z
      );
      gu.uWetness.value = params.wetness;
      // Grass catches the same day/night regime as the terrain: a moonlit floor is dim but
      // not black, so blades still read as silhouette against lightning.
      const dayAmbientDim = Math.max(0.28, params.sunDir.y * 1.35);
      const nightAmbientDim = 0.075 + 0.05 * Math.max(0, params.moonDir.y);
      gu.uAmbientDim.value =
        (params.daylight * dayAmbientDim + (1.0 - params.daylight) * nightAmbientDim) *
        (1.0 - params.cloudCoverFrac * 0.45);
      gu.uLightningFlash.value = Math.min(1.2, params.lightningIntensity * 0.35);
    }
  }

  public dispose(): void {
    this.terrainMesh.geometry.dispose();
    this.terrainMat.dispose();
    this.grassMesh.geometry.dispose();
    this.grassMat.dispose();
  }
}
