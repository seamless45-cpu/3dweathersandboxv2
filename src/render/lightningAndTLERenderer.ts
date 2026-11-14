import * as THREE from 'three';
import { ActiveLightningDischarge, ActiveTLEEvent } from '../sim/types';

const MAX_BOLT_SEGMENTS = 1500;
const MAX_TLE_QUADS = 16;

const BOLT_VERT = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec2 aCorner; // x in [-1, 1] across width, y in [0, 1] along segment
  attribute float aRadius;
  attribute float aBrightness;

  varying float vAcross;
  varying float vBrightness;

  void main() {
    vec3 worldPt = mix(aStart, aEnd, aCorner.y);
    vec3 viewDir = normalize(cameraPosition - worldPt);
    vec3 segDir = aEnd - aStart;
    float segLen = length(segDir);
    vec3 tangent = segLen > 0.001 ? segDir / segLen : vec3(0.0, 1.0, 0.0);

    vec3 side = normalize(cross(viewDir, tangent));
    // Maintain minimum sub-pixel angular thickness at long distances so distant CG/IC bolts remain crisp!
    float dist = length(cameraPosition - worldPt);
    float worldHalfWidth = max(aRadius, dist * 0.0018 * clamp(aRadius / 28.0, 0.22, 1.2));

    vec3 finalWorld = worldPt + side * (aCorner.x * worldHalfWidth);
    vAcross = aCorner.x;
    vBrightness = aBrightness;

    gl_Position = projectionMatrix * viewMatrix * vec4(finalWorld, 1.0);
  }
`;

const BOLT_FRAG = /* glsl */ `
  precision highp float;

  varying float vAcross;
  varying float vBrightness;

  void main() {
    if (vBrightness <= 0.002) discard;
    float r = abs(vAcross);
    // Razor-sharp 28,000K white plasma core + soft natural atmospheric violet-white corona
    float core = exp(-r * r * 18.0);
    float corona = exp(-r * 3.2) * 0.52;

    vec3 coreColor = vec3(1.0, 0.99, 1.0) * (core * 5.5);
    vec3 coronaColor = vec3(0.76, 0.84, 1.0) * (corona * 2.2);

    vec3 radiance = (coreColor + coronaColor) * vBrightness;
    float alpha = clamp((core + corona) * min(1.0, vBrightness * 1.4), 0.0, 1.0);
    gl_FragColor = vec4(radiance, alpha);
  }
`;

const TLE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TLE_FRAG = /* glsl */ `
  precision highp float;

  uniform int uTLEKind; // 0=Red Sprite, 1=Sprite Halo, 2=Blue Jet, 3=Gigantic Jet, 4=ELVES
  uniform float uLuminosity;
  uniform float uProgress;
  uniform float uSeed;

  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec2 uv = vUv;
    float xCentered = uv.x * 2.0 - 1.0;
    float horizEnv = exp(-xCentered * xCentered * 3.2);
    vec3 col = vec3(0.0);
    float alpha = 0.0;

    if (uTLEKind == 0) {
      // Red Sprite (N2 1P crimson jellyfish body at top + downward branching bluish-purple sprite streamers!)
      float filaments = noise(vec2(uv.x * 22.0 + uSeed, uv.y * 5.0));
      float fineStreamers = smoothstep(0.42, 0.88, noise(vec2(uv.x * 46.0 - uSeed, uv.y * 9.0)));
      float upperHead = exp(-pow((uv.y - 0.74) / 0.20, 2.0)) * horizEnv * (0.55 + 0.65 * filaments);
      float lowerTendrils = smoothstep(0.02, 0.45, uv.y) * smoothstep(0.76, 0.35, uv.y) * horizEnv * fineStreamers;

      vec3 n2Crimson = vec3(1.0, 0.14, 0.20) * 3.4;
      vec3 streamerBlueViolet = vec3(0.45, 0.32, 1.0) * 2.4;
      col = n2Crimson * upperHead + mix(streamerBlueViolet, n2Crimson, uv.y) * lowerTendrils;
      alpha = clamp((upperHead + lowerTendrils) * uLuminosity, 0.0, 1.0);
    } else if (uTLEKind == 1) {
      // Sprite Halo: diffuse pancake-shaped crimson mesospheric glow
      float vertDisk = exp(-pow((uv.y - 0.65) / 0.22, 2.0));
      float disk = horizEnv * vertDisk;
      col = vec3(1.0, 0.18, 0.24) * 2.4 * disk;
      alpha = clamp(disk * uLuminosity * 0.85, 0.0, 1.0);
    } else if (uTLEKind == 2) {
      // Blue Jet: narrow 15-degree upward-shooting N2 2P blue stratospheric cone from overshooting top
      float reachY = clamp(uProgress * 1.4, 0.15, 1.0);
      float coneWidth = mix(0.08, 0.46, uv.y);
      float coneMask = exp(-pow(xCentered / coneWidth, 2.0)) * smoothstep(reachY + 0.08, reachY - 0.18, uv.y) * smoothstep(0.0, 0.08, uv.y);
      float tex = 0.7 + 0.4 * noise(vec2(uv.x * 16.0, uv.y * 12.0 - uProgress * 4.0));
      col = vec3(0.20, 0.48, 1.0) * 3.2 * coneMask * tex;
      alpha = clamp(coneMask * uLuminosity, 0.0, 1.0);
    } else if (uTLEKind == 3) {
      // Gigantic Jet: lower blue filamentary trunk transitioning to crimson mesospheric crown!
      float coneWidth = mix(0.10, 0.65, pow(uv.y, 1.2));
      float fil = 0.55 + 0.65 * noise(vec2(uv.x * 28.0 + uSeed, uv.y * 8.0));
      float body = exp(-pow(xCentered / coneWidth, 2.0)) * fil * smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.86, uv.y);
      vec3 jetColor = mix(vec3(0.24, 0.56, 1.0), vec3(1.0, 0.16, 0.26), smoothstep(0.38, 0.72, uv.y));
      col = jetColor * 3.5 * body;
      alpha = clamp(body * uLuminosity, 0.0, 1.0);
    } else {
      // ELVES: rapidly expanding lower-ionospheric crimson EMP ring!
      vec2 p = uv * 2.0 - 1.0;
      float r = length(p);
      float ringR = mix(0.18, 0.88, clamp(uProgress * 1.25, 0.0, 1.0));
      float torus = exp(-pow((r - ringR) / 0.14, 2.0)) * (1.0 - smoothstep(0.85, 1.0, r));
      col = vec3(1.0, 0.16, 0.22) * 2.8 * torus;
      alpha = clamp(torus * uLuminosity, 0.0, 1.0);
    }

    if (alpha < 0.005) discard;
    gl_FragColor = vec4(col * uLuminosity, alpha);
  }
`;

export class LightningAndTLERenderer {
  public boltMesh: THREE.Mesh;
  public tleGroup: THREE.Group;

  private boltGeom: THREE.InstancedBufferGeometry;
  private boltMat: THREE.ShaderMaterial;
  private aStart: THREE.InstancedBufferAttribute;
  private aEnd: THREE.InstancedBufferAttribute;
  private aRadius: THREE.InstancedBufferAttribute;
  private aBrightness: THREE.InstancedBufferAttribute;

  private tleMeshes: THREE.Mesh[] = [];
  private tleMaterials: THREE.ShaderMaterial[] = [];

  // Dominant light outputs for terrain & volumetric cloud shaders
  public boltLights: [THREE.Vector4, THREE.Vector4, THREE.Vector4] = [
    new THREE.Vector4(0, 0, 0, 0),
    new THREE.Vector4(0, 0, 0, 0),
    new THREE.Vector4(0, 0, 0, 0),
  ];
  public dominantGroundBoltPos = new THREE.Vector3(0, 4000, 0);
  public dominantGroundBoltIntensity = 0;

  constructor() {
    this.boltGeom = new THREE.InstancedBufferGeometry();
    const corners = new Float32Array([
      -1, 0,
       1, 0,
      -1, 1,
       1, 1,
    ]);
    const indices = [0, 1, 2, 2, 1, 3];
    this.boltGeom.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
    // Dummy position attribute required by Three.js WebGL2 VAO binding
    this.boltGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(12), 3)
    );
    this.boltGeom.setIndex(indices);

    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLT_SEGMENTS * 3), 3);
    this.aEnd = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLT_SEGMENTS * 3), 3);
    this.aRadius = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLT_SEGMENTS), 1);
    this.aBrightness = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLT_SEGMENTS), 1);

    this.aStart.setUsage(THREE.DynamicDrawUsage);
    this.aEnd.setUsage(THREE.DynamicDrawUsage);
    this.aRadius.setUsage(THREE.DynamicDrawUsage);
    this.aBrightness.setUsage(THREE.DynamicDrawUsage);

    this.boltGeom.setAttribute('aStart', this.aStart);
    this.boltGeom.setAttribute('aEnd', this.aEnd);
    this.boltGeom.setAttribute('aRadius', this.aRadius);
    this.boltGeom.setAttribute('aBrightness', this.aBrightness);
    this.boltGeom.instanceCount = 0;

    this.boltMat = new THREE.ShaderMaterial({
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.boltMesh = new THREE.Mesh(this.boltGeom, this.boltMat);
    this.boltMesh.frustumCulled = false;

    // Pre-allocate pooled TLE billboard/disk meshes (zero runtime allocation!)
    this.tleGroup = new THREE.Group();
    const quadGeom = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_TLE_QUADS; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: TLE_VERT,
        fragmentShader: TLE_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uTLEKind: { value: 0 },
          uLuminosity: { value: 0 },
          uProgress: { value: 0 },
          uSeed: { value: i * 7.13 },
        },
      });
      const mesh = new THREE.Mesh(quadGeom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.tleMeshes.push(mesh);
      this.tleMaterials.push(mat);
      this.tleGroup.add(mesh);
    }
  }

  /** Maps upper-atmospheric physical altitudes [18km..92km] smoothly into optical render dome [18km..46km] */
  private mapOpticalTLEAltitude(altM: number): number {
    if (altM <= 18000) return altM;
    return 18000 + (altM - 18000) * 0.38;
  }

  public update(
    discharges: ActiveLightningDischarge[],
    tles: ActiveTLEEvent[],
    cameraPos: THREE.Vector3
  ): void {
    // 1. Reset light sources
    for (let i = 0; i < 3; i++) {
      this.boltLights[i].set(0, 0, 0, 0);
    }
    this.dominantGroundBoltIntensity = 0;

    // 2. Populate GPU instanced lightning segment buffer
    let segCursor = 0;
    const startArr = this.aStart.array as Float32Array;
    const endArr = this.aEnd.array as Float32Array;
    const radArr = this.aRadius.array as Float32Array;
    const brightArr = this.aBrightness.array as Float32Array;

    for (let dIdx = 0; dIdx < discharges.length; dIdx++) {
      const d = discharges[dIdx];

      // Assign volumetric light point near mid-channel of brightest 3 active flashes
      const midX = 0.5 * (d.initPoint[0] + d.termPoint[0]);
      const midY = 0.5 * (d.initPoint[1] + d.termPoint[1]);
      const midZ = 0.5 * (d.initPoint[2] + d.termPoint[2]);

      if (dIdx < 3) {
        this.boltLights[dIdx].set(midX, midY, midZ, d.cloudIllumIntensity * 5.2);
      }
      if (d.cloudIllumIntensity > this.dominantGroundBoltIntensity) {
        this.dominantGroundBoltIntensity = d.cloudIllumIntensity;
        this.dominantGroundBoltPos.set(midX, Math.max(800, midY * 0.65), midZ);
      }

      for (const seg of d.segments) {
        if (segCursor >= MAX_BOLT_SEGMENTS) break;
        if (d.phase === 'leader' && seg.progressOrder > d.leaderProgress) {
          continue;
        }

        const isMain = seg.generation === 0;
        const lum = isMain ? d.coreLuminosity : d.branchLuminosity;
        if (lum <= 0.005) continue;

        const i3 = segCursor * 3;
        startArr[i3] = seg.x1;
        startArr[i3 + 1] = seg.y1;
        startArr[i3 + 2] = seg.z1;

        endArr[i3] = seg.x2;
        endArr[i3 + 1] = seg.y2;
        endArr[i3 + 2] = seg.z2;

        radArr[segCursor] = (isMain ? 26.0 : 12.0) * seg.radiusWeight;
        brightArr[segCursor] = lum;
        segCursor++;
      }
    }

    this.boltGeom.instanceCount = segCursor;
    if (segCursor > 0) {
      this.aStart.needsUpdate = true;
      this.aEnd.needsUpdate = true;
      this.aRadius.needsUpdate = true;
      this.aBrightness.needsUpdate = true;
    }

    // 3. Update Pooled Upper-Atmospheric TLE Meshes
    for (let i = 0; i < MAX_TLE_QUADS; i++) {
      const mesh = this.tleMeshes[i];
      if (i >= tles.length) {
        mesh.visible = false;
        continue;
      }

      const tle = tles[i];
      mesh.visible = true;
      const mat = this.tleMaterials[i];

      const y0 = this.mapOpticalTLEAltitude(tle.yBase);
      const y1 = this.mapOpticalTLEAltitude(tle.yTop);
      const centerY = 0.5 * (y0 + y1);
      const heightSpan = Math.max(1500, y1 - y0);

      let kindInt = 0;
      if (tle.classification === 'Red Sprite') kindInt = 0;
      else if (tle.classification === 'Sprite Halo') kindInt = 1;
      else if (tle.classification === 'Blue Jet') kindInt = 2;
      else if (tle.classification === 'Gigantic Jet') kindInt = 3;
      else kindInt = 4; // ELVES

      mat.uniforms.uTLEKind.value = kindInt;
      mat.uniforms.uLuminosity.value = tle.luminosity;
      mat.uniforms.uProgress.value = tle.ageMs / Math.max(1.0, tle.durationMs);

      mesh.position.set(tle.x, centerY, tle.z);

      if (kindInt === 4) {
        // ELVES: horizontal ionospheric ring overhead
        mesh.rotation.set(-Math.PI / 2, 0, 0);
        const diam = tle.horizontalRadiusM * 2.0;
        mesh.scale.set(diam, diam, 1.0);
      } else {
        // Vertical billboard facing observer horizontally
        const yawToCam = Math.atan2(cameraPos.x - tle.x, cameraPos.z - tle.z);
        mesh.rotation.set(0, yawToCam, 0);
        mesh.scale.set(tle.horizontalRadiusM * 2.0, heightSpan, 1.0);
      }
    }
  }

  public dispose(): void {
    this.boltGeom.dispose();
    this.boltMat.dispose();
    for (let i = 0; i < this.tleMeshes.length; i++) {
      if (i === 0) this.tleMeshes[i].geometry.dispose();
      this.tleMaterials[i].dispose();
    }
  }
}
