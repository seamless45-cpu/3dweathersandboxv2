import * as THREE from 'three';

const MAST_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vHeightFrac;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vHeightFrac = clamp(position.y / 168.0, 0.0, 1.0);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const MAST_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uDaylight;
  uniform vec3 uCameraPos;
  uniform float uLightningIntensity;
  uniform vec3 uLightningPos;
  uniform float uCorona;

  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vHeightFrac;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCameraPos - vWorldPos);

    // Galvanised steel: dark, slightly blue, with a broad specular sheen so the mast reads as
    // metal against the grass rather than as a flat silhouette.
    vec3 base = vec3(0.16, 0.17, 0.19);
    base = mix(base, vec3(0.30, 0.31, 0.33), vHeightFrac * 0.55);

    float ndlSun = max(dot(N, uSunDir), 0.0);
    float ndlMoon = max(dot(N, uMoonDir), 0.0);
    vec3 sunTint = vec3(1.0, 0.95, 0.86) * ndlSun * uDaylight;
    vec3 moonTint = vec3(0.34, 0.45, 0.72) * ndlMoon * (1.0 - uDaylight) * 0.30;
    vec3 ambient = mix(vec3(0.035, 0.045, 0.062), vec3(0.20, 0.23, 0.27), uDaylight);

    vec3 col = base * (ambient + sunTint * 1.15 + moonTint);

    vec3 H = normalize(uSunDir + V);
    col += vec3(1.0, 0.98, 0.94) * pow(max(dot(N, H), 0.0), 26.0) * 0.34 * uDaylight;

    // Lightning from anywhere in the domain lights the mast hard -- it is the tallest grounded
    // conductor in view and it is usually the reason for the flash.
    if (uLightningIntensity > 0.001) {
      vec3 L = normalize(uLightningPos - vWorldPos);
      float ndlBolt = max(dot(N, L), 0.0);
      col += vec3(0.78, 0.85, 1.0) * (0.35 + 0.65 * ndlBolt) * uLightningIntensity * 2.2;
    }

    // Corona at the tip: St Elmo's fire bleeds up from the top few metres.
    col += vec3(0.42, 0.62, 1.0) * uCorona * smoothstep(0.78, 1.0, vHeightFrac) * 2.6;

    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * Renders the grounded lightning rod: a tapered lattice mast with a corona glow at the tip that
 * tracks the point-discharge the simulation is actually running, plus the brief upward
 * connecting leader it launches.
 */
export class LightningRodRenderer {
  public group = new THREE.Group();
  private mastMat: THREE.ShaderMaterial;
  private coronaSprite: THREE.Sprite;
  private coronaMat: THREE.SpriteMaterial;
  private leaderMesh: THREE.Mesh;
  private leaderMat: THREE.MeshBasicMaterial;
  private leaderFade = 0;
  private lastLeaderCount = 0;
  private lastInterceptCount = 0;

  constructor(x: number, z: number, groundY: number, heightM: number) {
    // Tapered mast: wide at the base, narrow at the tip. Cylinder is built along +Y centred at
    // the origin, so it is lifted by half its height.
    const mastGeom = new THREE.CylinderGeometry(0.16, 1.35, heightM, 10, 1, false);
    this.mastMat = new THREE.ShaderMaterial({
      vertexShader: MAST_VERT,
      fragmentShader: MAST_FRAG,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.7).normalize() },
        uMoonDir: { value: new THREE.Vector3(-0.4, 0.5, 0.7).normalize() },
        uDaylight: { value: 1.0 },
        uCameraPos: { value: new THREE.Vector3() },
        uLightningIntensity: { value: 0.0 },
        uLightningPos: { value: new THREE.Vector3(0, 4000, 0) },
        uCorona: { value: 0.0 },
      },
    });
    const mast = new THREE.Mesh(mastGeom, this.mastMat);
    mast.position.set(x, groundY + heightM * 0.5, z);
    this.group.add(mast);

    // Grounding radial and a small equipment enclosure at the base, so the mast has a footing.
    const padGeom = new THREE.CylinderGeometry(3.4, 3.9, 0.5, 12);
    const pad = new THREE.Mesh(padGeom, this.mastMat);
    pad.position.set(x, groundY + 0.2, z);
    this.group.add(pad);

    // Corona glow: an additive billboard at the tip.
    this.coronaMat = new THREE.SpriteMaterial({
      map: LightningRodRenderer.makeGlowTexture(),
      color: new THREE.Color(0.45, 0.66, 1.0),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    this.coronaSprite = new THREE.Sprite(this.coronaMat);
    this.coronaSprite.position.set(x, groundY + heightM, z);
    this.coronaSprite.scale.setScalar(9);
    this.group.add(this.coronaSprite);

    // Upward connecting leader: a thin glowing column that flashes briefly when the rod
    // launches one, whether or not it happens to meet a descending leader.
    this.leaderMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.72, 0.84, 1.0),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const leaderGeom = new THREE.CylinderGeometry(0.5, 1.1, heightM * 1.5, 6, 1, true);
    this.leaderMesh = new THREE.Mesh(leaderGeom, this.leaderMat);
    this.leaderMesh.position.set(x, groundY + heightM * 1.75, z);
    this.group.add(this.leaderMesh);
  }

  /** Radial gradient used for the corona billboard. */
  private static makeGlowTexture(): THREE.Texture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(190,215,255,0.85)');
    grad.addColorStop(0.45, 'rgba(120,160,255,0.30)');
    grad.addColorStop(1.0, 'rgba(80,120,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  public update(params: {
    sunDir: THREE.Vector3;
    moonDir: THREE.Vector3;
    daylight: number;
    cameraPos: THREE.Vector3;
    coronaIntensity: number;
    lightningIntensity: number;
    lightningPos: THREE.Vector3;
    upwardLeaders: number;
    interceptedStrikes: number;
    realDtSec: number;
  }): void {
    const u = this.mastMat.uniforms;
    u.uSunDir.value.copy(params.sunDir);
    u.uMoonDir.value.copy(params.moonDir);
    u.uDaylight.value = params.daylight;
    u.uCameraPos.value.copy(params.cameraPos);
    u.uLightningIntensity.value = params.lightningIntensity;
    u.uLightningPos.value.copy(params.lightningPos);
    u.uCorona.value = params.coronaIntensity;

    // Corona billboard: grows and brightens with the point-discharge current. A faint flicker
    // keyed off the intensity itself (not wall-clock noise) keeps it alive without breaking
    // frame determinism.
    const c = Math.max(0, Math.min(1.4, params.coronaIntensity));
    this.coronaMat.opacity = Math.min(1, c * 0.92);
    this.coronaSprite.scale.setScalar(5.5 + c * 16.0);
    this.coronaSprite.visible = c > 0.01;

    // Any new upward leader or interception flashes the connecting channel.
    if (
      params.upwardLeaders !== this.lastLeaderCount ||
      params.interceptedStrikes !== this.lastInterceptCount
    ) {
      const intercept = params.interceptedStrikes !== this.lastInterceptCount;
      this.leaderFade = intercept ? 1.0 : 0.55;
      this.lastLeaderCount = params.upwardLeaders;
      this.lastInterceptCount = params.interceptedStrikes;
    }
    this.leaderFade = Math.max(0, this.leaderFade - params.realDtSec * 2.6);
    this.leaderMat.opacity = this.leaderFade * 0.85;
    this.leaderMesh.visible = this.leaderFade > 0.01;
  }

  public dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.coronaMat.map?.dispose();
    this.coronaMat.dispose();
    this.leaderMat.dispose();
    this.mastMat.dispose();
  }
}
