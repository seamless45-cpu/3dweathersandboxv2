import * as THREE from 'three';
import { getTerrainHeight } from '../sim/terrainField';
import type { TornadoSnapshot } from '../sim/types';

const FUNNEL_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uRadiusTop;
  uniform float uRadiusBottom;
  uniform float uHeight;
  uniform float uSpin;

  varying vec2 vUvF;
  varying float vHFrac;
  varying vec3 vWorldPos;
  varying vec3 vRadialDir;

  // The funnel is a unit lathe along +Y (0..1). Each ring is scaled by a radius profile: narrow
  // at the ground, flaring into the wall cloud at the top. A real condensation funnel is not
  // straight -- it leans and snakes with the parent updraft, so the axis is offset by a
  // height-dependent sway.
  void main() {
    vUvF = uv;
    float h = position.y;
    vHFrac = h;

    // Radius profile: the visible funnel widens upward roughly as a power law, following the way
    // the condensation envelope spreads as the rotating updraft merges into the cloud base.
    float profile = mix(uRadiusBottom, uRadiusTop, pow(h, 0.72));

    // Sway of the axis, larger aloft where the funnel is dragged by the mesocyclone.
    float swayX = sin(uTime * 0.55 + h * 2.4) * 0.16 + sin(uTime * 0.31 + h * 1.1) * 0.10;
    float swayZ = cos(uTime * 0.42 + h * 1.9) * 0.13;
    vec3 axisOffset = vec3(swayX * h * uHeight * 0.10, 0.0, swayZ * h * uHeight * 0.075);

    // Spiral condensation bands: rotating the sampling angle with time and height gives the
    // visible spin, faster near the ground where the angular velocity is highest.
    float ang = atan(position.z, position.x) + uTime * uSpin * (1.0 + 0.6 * (1.0 - h));
    float band = sin(ang * 3.0 + h * 9.0 - uTime * 2.2) * 0.5 + 0.5;
    float ripple = 1.0 + band * 0.16 * (0.35 + 0.65 * h);

    // The group carries no rotation, so the local radial direction is the world radial direction.
    vRadialDir = vec3(cos(ang), 0.0, sin(ang));

    vec3 p = vRadialDir * (length(position.xz) * profile * ripple) + axisOffset;
    p.y = h * uHeight;

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FUNNEL_FRAG = /* glsl */ `
  precision highp float;

  uniform float uDaylight;
  uniform float uOpacity;
  uniform float uLightning;
  uniform vec3 uLightningPos;
  uniform vec3 uCameraPos;
  uniform float uDebris;
  uniform float uTime;
  uniform vec3 uSunDir;

  varying vec2 vUvF;
  varying float vHFrac;
  varying vec3 vWorldPos;
  varying vec3 vRadialDir;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    // Spiral condensation texture, scrolling upward and around so the rotation reads clearly.
    float ang = atan(vWorldPos.z, vWorldPos.x);
    vec2 spiral = vec2(ang * 2.2 + vHFrac * 5.0, vHFrac * 7.0 - uTime * 0.55);
    float n = vnoise(spiral * 3.1) * 0.6 + vnoise(spiral * 7.7) * 0.28 + vnoise(spiral * 15.0) * 0.12;

    // Densest in the lower half where the pressure deficit is greatest, thinning as it merges
    // into the cloud base.
    float vertFade = smoothstep(0.0, 0.06, vHFrac) * (1.0 - smoothstep(0.72, 1.0, vHFrac));
    float density = clamp(n * 1.55 - 0.34, 0.0, 1.0) * vertFade;

    // Ground debris: dark, turbulent, concentrated at the base where the vortex touches down.
    float debrisBand = smoothstep(0.30, 0.0, vHFrac) * uDebris;
    float dn = vnoise(vec2(ang * 3.0 + uTime * 1.4, vHFrac * 22.0));
    density = max(density, debrisBand * (0.45 + 0.55 * dn));

    if (density < 0.004) discard;

    // A funnel is backlit more often than not: dark grey body with a bright rim where sunlight
    // catches the rotating condensate at the silhouette edge.
    vec3 baseCol = mix(vec3(0.055, 0.058, 0.062), vec3(0.30, 0.31, 0.33), uDaylight);
    baseCol = mix(baseCol, vec3(0.16, 0.13, 0.10), uDebris * smoothstep(0.35, 0.0, vHFrac));

    vec3 V = normalize(uCameraPos - vWorldPos);
    float rim = pow(1.0 - abs(dot(normalize(vRadialDir), V)), 1.7);
    float sunSide = max(dot(normalize(vRadialDir), normalize(uSunDir)), 0.0);
    baseCol += vec3(1.0, 0.96, 0.9) * rim * sunSide * 0.42 * uDaylight;

    vec3 col = baseCol * (0.55 + 0.75 * n);

    if (uLightning > 0.001) {
      float d = length(uLightningPos - vWorldPos);
      float att = 1.0 / (1.0 + d * 0.00009);
      col += vec3(0.72, 0.80, 1.0) * uLightning * att * 3.4;
    }

    gl_FragColor = vec4(col, density * uOpacity);
  }
`;

const DEBRIS_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uSpin;

  varying vec2 vUvD;
  varying vec3 vWorldPos;

  void main() {
    vUvD = uv;
    // Ground-level debris disc: expands with the vortex core radius and swirls.
    float ang = atan(position.z, position.x) + uTime * uSpin * 0.55;
    float r = length(position.xz) * uRadius;
    float lift = sin(ang * 4.0 + uTime * 2.6) * 5.0 + 3.0;
    vec3 p = vec3(cos(ang) * r, position.y + lift, sin(ang) * r);
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const DEBRIS_FRAG = /* glsl */ `
  precision highp float;

  uniform float uDaylight;
  uniform float uOpacity;
  uniform float uLightning;
  uniform vec3 uLightningPos;
  uniform float uTime;

  varying vec2 vUvD;
  varying vec3 vWorldPos;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    // Radial falloff from the centre of the debris cloud.
    float d = length(vUvD - 0.5) * 2.0;
    float radial = 1.0 - smoothstep(0.35, 1.0, d);
    float n = hash(floor(vUvD * 46.0) + floor(uTime * 9.0));
    float a = radial * (0.42 + 0.58 * n) * uOpacity;
    if (a < 0.01) discard;

    vec3 col = mix(vec3(0.09, 0.075, 0.055), vec3(0.24, 0.21, 0.17), uDaylight);
    if (uLightning > 0.001) {
      float att = 1.0 / (1.0 + length(uLightningPos - vWorldPos) * 0.00009);
      col += vec3(0.7, 0.78, 1.0) * uLightning * att * 3.0;
    }
    gl_FragColor = vec4(col, a);
  }
`;

interface FunnelInstance {
  group: THREE.Group;
  funnel: THREE.Mesh;
  funnelMat: THREE.ShaderMaterial;
  debris: THREE.Mesh;
  debrisMat: THREE.ShaderMaterial;
  spinPhase: number;
}

/**
 * Renders tornadic vortices as condensation funnels with a ground debris cloud.
 *
 * Everything visible is driven by the simulation: the funnel's vertical extent by how far the
 * vortex has actually descended from cloud base, its width by the radius of maximum wind, its
 * spin rate by the peak tangential wind (omega = V / R), and the debris cloud only appears once
 * the vortex is strong enough and low enough to be lofting material. Nothing here is scripted.
 */
export class TornadoRenderer {
  public group = new THREE.Group();
  private live: FunnelInstance[] = [];
  private pool: FunnelInstance[] = [];
  private funnelGeom: THREE.CylinderGeometry;
  private debrisGeom: THREE.PlaneGeometry;
  private created = 0;

  constructor() {
    // Unit lathe along +Y from 0..1, open-ended, with enough rings for the sway and spiral bands
    // to resolve. 48 radial segments keeps the funnel round at close range.
    this.funnelGeom = new THREE.CylinderGeometry(1, 1, 1, 48, 40, true);
    this.funnelGeom.translate(0, 0.5, 0);
    this.debrisGeom = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.debrisGeom.rotateX(-Math.PI / 2);
    this.group.frustumCulled = false;
  }

  private acquire(): FunnelInstance {
    const reused = this.pool.pop();
    if (reused) return reused;

    const funnelMat = new THREE.ShaderMaterial({
      vertexShader: FUNNEL_VERT,
      fragmentShader: FUNNEL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uRadiusTop: { value: 260 },
        uRadiusBottom: { value: 42 },
        uHeight: { value: 1200 },
        uSpin: { value: 1 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uDaylight: { value: 1 },
        uOpacity: { value: 1 },
        uLightning: { value: 0 },
        uLightningPos: { value: new THREE.Vector3() },
        uCameraPos: { value: new THREE.Vector3() },
        uDebris: { value: 0 },
      },
    });
    const funnel = new THREE.Mesh(this.funnelGeom, funnelMat);
    funnel.frustumCulled = false;

    const debrisMat = new THREE.ShaderMaterial({
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: 200 },
        uSpin: { value: 1 },
        uDaylight: { value: 1 },
        uOpacity: { value: 0.7 },
        uLightning: { value: 0 },
        uLightningPos: { value: new THREE.Vector3() },
      },
    });
    const debris = new THREE.Mesh(this.debrisGeom, debrisMat);
    debris.frustumCulled = false;
    debris.visible = false;

    const group = new THREE.Group();
    group.add(funnel);
    group.add(debris);
    this.group.add(group);

    // Deterministic phase offset: src/render must not introduce frame-to-frame randomness that
    // would make a fixed-seed comparison ambiguous.
    this.created++;
    return {
      group,
      funnel,
      funnelMat,
      debris,
      debrisMat,
      spinPhase: (this.created * 1.7) % (Math.PI * 2),
    };
  }

  public update(params: {
    tornadoes: readonly TornadoSnapshot[];
    realDtSec: number;
    sunDir: THREE.Vector3;
    daylight: number;
    cameraPos: THREE.Vector3;
    lightningIntensity: number;
    lightningPos: THREE.Vector3;
  }): void {
    const { tornadoes } = params;

    while (this.live.length < tornadoes.length) {
      const inst = this.acquire();
      inst.group.visible = true;
      this.live.push(inst);
    }
    while (this.live.length > tornadoes.length) {
      const inst = this.live.pop()!;
      inst.group.visible = false;
      this.pool.push(inst);
    }

    for (let i = 0; i < tornadoes.length; i++) {
      const t = tornadoes[i];
      const inst = this.live[i];
      const groundY = getTerrainHeight(t.x, t.z);
      const cloudBase = Math.max(groundY + 220, t.cloudBaseM);

      // The funnel extends only as far down as the vortex has actually descended.
      const drop = Math.max(0, Math.min(1, t.funnelDrop));
      const funnelHeight = Math.max(60, (cloudBase - groundY) * Math.max(0.12, drop));

      // Radius of maximum wind sets the funnel width; the top flares into the wall cloud.
      const coreR = Math.max(28, Math.min(420, t.radiusM));

      // Angular velocity is V / R -- the actual rotation rate of the vortex. A real tornado's
      // condensate turns several times per second, which is far faster than a 60 Hz frame can
      // show without strobing, so it is scaled for legibility while staying monotonic in wind.
      const omega = Math.max(0.05, t.windMS / Math.max(60, coreR));
      const visualSpin = Math.min(9.0, omega * 3.2 + 0.5);

      inst.spinPhase += params.realDtSec * visualSpin;
      inst.group.position.set(t.x, groundY, t.z);

      const fu = inst.funnelMat.uniforms;
      fu.uTime.value = inst.spinPhase;
      fu.uRadiusTop.value = coreR * 2.35;
      fu.uRadiusBottom.value = coreR * 0.42;
      fu.uHeight.value = funnelHeight;
      fu.uSpin.value = visualSpin;
      fu.uSunDir.value.copy(params.sunDir);
      fu.uDaylight.value = params.daylight;
      fu.uCameraPos.value.copy(params.cameraPos);
      fu.uLightning.value = params.lightningIntensity;
      fu.uLightningPos.value.copy(params.lightningPos);
      // Fades in as the vortex strengthens past condensation, and scales with how far it has
      // descended -- a funnel still aloft is faint.
      fu.uOpacity.value =
        Math.max(0, Math.min(0.94, (t.windMS - 12) / 46)) * (0.45 + 0.55 * drop);

      // Debris only once the vortex is near the ground and strong enough to loft material.
      const touching = drop > 0.72 && t.windMS > 26;
      inst.debris.visible = touching;
      fu.uDebris.value = touching ? Math.min(1, (t.windMS - 26) / 55) : 0;
      if (touching) {
        const du = inst.debrisMat.uniforms;
        du.uTime.value = inst.spinPhase;
        du.uRadius.value = coreR * 3.4;
        du.uSpin.value = visualSpin;
        du.uDaylight.value = params.daylight;
        du.uOpacity.value = Math.min(0.72, (t.windMS - 26) / 60 + 0.18);
        du.uLightning.value = params.lightningIntensity;
        du.uLightningPos.value.copy(params.lightningPos);
      }
    }
  }

  public dispose(): void {
    this.funnelGeom.dispose();
    this.debrisGeom.dispose();
    for (const inst of [...this.live, ...this.pool]) {
      inst.funnelMat.dispose();
      inst.debrisMat.dispose();
    }
    this.live = [];
    this.pool = [];
  }
}
