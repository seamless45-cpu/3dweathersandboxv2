import * as THREE from 'three';
import { getTerrainHeight } from '../sim/terrainField';
import type { TornadoSnapshot } from '../sim/types';

/**
 * Gravitational acceleration, m/s².
 *
 * The debris integrator works in real seconds and real metres-per-second, so it uses the real
 * constant rather than a tuned "visual" one: whether a piece of debris lofts is then decided by
 * its own terminal velocity against the simulated updraft, which is a real criterion, instead of
 * by a number somebody picked to make it look right.
 */
const GRAVITY = 9.80665;

/** Hermite smoothstep on a scalar, matching GLSL's smoothstep. */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Volumetric tornado renderer.
 *
 * The previous version drew the funnel as a single open lathe with an alpha-blended fragment
 * shader -- one surface, no depth. That is why it read as a basic translucent cone: a shell has
 * no interior, so no matter what noise you put on it the silhouette is a smooth outline and the
 * edges stay razor sharp. A real condensation funnel has *volume*: you can see into the near wall,
 * through the middle, and out the far wall, and the silhouette is soft because the optical depth
 * ramps up over hundreds of metres.
 *
 * What this does instead:
 *
 *  1. **Funnel shell + core.** A tapered tube with the radius profile of a real vortex
 *     (wide at the cloud base, contracting to a thin ground contact) plus an inner core tube.
 *     The shell is rendered with *additive-free* premultiplied alpha and a per-sample optical
 *     depth derived from the chord length through the tube, so the limb darkens and the centre
 *     transmits -- that is what gives a cone its cylindrical read.
 *
 *  2. **Rotating condensation bands.** The banding is evaluated in the *vortex frame*
 *     (azimuth minus helical phase), so it wraps and climbs the funnel the way real helical
 *     striations do, rather than scrolling a flat texture over the surface.
 *
 *  3. **Debris field.** Not a flat quad: a set of instanced, camera-facing debris particles that
 *     are advected on the vortex's own tangential + radial + vertical velocity field. Grains loft
 *     near the core, get flung outward as they rise, and fall back out at the edge -- the real
 *     debris *loading* profile. Size and colour follow the simulated EF scale.
 *
 * Everything is driven by the simulation: extent by `funnelDrop`, width by `radiusM`, spin by
 * the peak tangential wind, debris by wind and touch-down. Nothing is scripted.
 */

/**
 * Funnel tube.
 *
 * `aRing` is 0 at the bottom of the vortex and 1 at the cloud base, so the radius profile, the
 * helical banding and the vertical taper are all functions of one normalised coordinate rather
 * than of the world-space height (which changes as the funnel descends).
 */
const FUNNEL_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uRadiusGround;
  uniform float uRadiusTop;
  uniform float uHeight;
  uniform float uSpin;
  uniform float uLean;
  uniform float uFlare;

  attribute float aRing;

  varying vec2 vUvF;
  varying float vRing;
  varying vec3 vWorldPos;
  varying vec3 vRadial;
  varying vec3 vViewDir;
  varying float vChord;

  void main() {
    vUvF = uv;
    vRing = aRing;

    // Radius profile of a real condensate funnel. A vortex does not taper linearly: it necks
    // hardest in the lowest few hundred metres (where the boundary layer concentrates vorticity)
    // and then flares quickly into the wall cloud. r(t) ~ t^0.55 with an extra exponential neck
    // near the ground reproduces both, and is why the silhouette is a trumpet and not a cone.
    float t = clamp(aRing, 0.0, 1.0);
    float trumpet = pow(t, 0.55);
    float neck = 1.0 - 0.62 * exp(-t * 7.5);
    float profile = mix(uRadiusGround, uRadiusTop, trumpet * neck);

    // Wall-cloud flare only in the top 18%: the funnel does not so much end as dissolve into a
    // ragged collar, which is what actually sells the connection to the cloud base.
    profile += uFlare * smoothstep(0.80, 1.0, t) * uRadiusTop;

    float ang = atan(position.z, position.x);

    // Axis sway. The funnel is dragged by the parent mesocyclone, and the amplitude of that
    // oscillation grows with height, so the vortex snakes rather than standing like a pole.
    float swayX = sin(uTime * 0.47 + t * 2.6) * uLean * (0.25 + 0.75 * t);
    float swayZ = cos(uTime * 0.39 + t * 2.1) * uLean * 0.8 * (0.25 + 0.75 * t);

    // The rotation is *applied to the vertices*, not just to a texture lookup. This matters:
    // it is the only way the helical bands on the surface actually travel around the funnel as
    // the mesh spins, instead of the pattern sliding underneath a stationary tube.
    float spinAng = ang + uTime * uSpin;

    vec3 radial = vec3(cos(spinAng), 0.0, sin(spinAng));
    vRadial = vec3(cos(ang), 0.0, sin(ang));

    // Surface perturbation: the funnel wall is not a surface of revolution. Cellular bumps at
    // several scales make the silhouette lumpy and give the condensation a cauliflower texture.
    float bump =
      sin(ang * 5.0 + uTime * 1.7 + t * 8.0) * 0.06 +
      sin(ang * 9.0 - uTime * 2.3 - t * 13.0) * 0.035;
    float r = profile * (1.0 + bump);

    vec3 local = radial * r;
    local.y = t * uHeight;
    local.x += swayX;
    local.z += swayZ;

    vec4 wp = modelMatrix * vec4(local, 1.0);
    vWorldPos = wp.xyz;
    vViewDir = normalize(cameraPosition - wp.xyz);

    // Chord length through the tube along the view ray: 2 * sqrt(R^2 - b^2) where b is the
    // perpendicular distance from the axis. Approximated from the radial angle, this is what
    // makes the limb optically thick and the centre thin -- the single cue that turns a flat
    // alpha shell into something that reads as a cylinder of gas.
    float cosToAxis = dot(vRadial, vViewDir);
    float b = abs(cosToAxis);
    vChord = sqrt(max(0.0, 1.0 - b * b));

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
  uniform float uCoreGlow;
  uniform float uRadiusScale;

  varying vec2 vUvF;
  varying float vRing;
  varying vec3 vWorldPos;
  varying vec3 vRadial;
  varying vec3 vViewDir;
  varying float vChord;

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

  float fbm(vec2 p) {
    return vnoise(p) * 0.55 + vnoise(p * 2.1) * 0.28 + vnoise(p * 4.3) * 0.17;
  }

  void main() {
    // Azimuth in the *world* frame, so the bands do not rotate with the vertices -- they are a
    // property of the air, not of the mesh. Combined with the ring coordinate this gives the
    // helical striation of a real funnel: bands climb as they wrap.
    float ang = atan(vWorldPos.z, vWorldPos.x);
    float helical = ang * 3.4 + vRing * 11.0;

    // Two layers at different scales: broad condensation sheets and fine turbulent striation.
    float n = fbm(vec2(helical, vRing * 16.0 - uTime * 1.35));
    float fine = fbm(vec2(helical * 2.9, vRing * 34.0 - uTime * 2.4));

    // Condensate is densest where the pressure deficit is largest -- a few hundred metres up,
    // thinning both at the ground contact and as the funnel merges into the cloud base.
    float vertFade = smoothstep(0.0, 0.10, vRing) * (1.0 - smoothstep(0.74, 1.0, vRing));
    float density = clamp(n * 1.75 - 0.42, 0.0, 1.0) * vertFade;
    density *= 0.72 + 0.28 * fine;

    // ---- Volume integration -------------------------------------------------------------
    // The tube is a surface mesh standing in for a volume, so the *effective* optical depth has
    // to be reconstructed from the geometry rather than from a real march. vChord is the
    // normalised chord length through the tube at this pixel, and uRadiusScale converts the
    // tube's radius into metres; that product is a physical path length through the condensate.
    float pathM = max(0.05, vChord * uRadiusScale);
    // Extinction for a condensate funnel of a few tenths of a g/kg is of order 1e-3 per metre.
    float tau = density * pathM * 0.0022;
    float alpha = 1.0 - exp(-tau);

    // Limb brightening in *emission* but darkening in *transmission* is the signature of a
    // cylindrical medium: the silhouette edge has the longest path, so it is both the most
    // opaque and the most lit. Without this the funnel has no roundness at all.
    alpha *= 1.0 - 0.30 * vChord;

    // The simulation fades a funnel in as it strengthens and as it descends, so the global
    // opacity has to reach the output. Leaving it unapplied made every funnel fully opaque the
    // instant it existed, which is what made a forming vortex pop into existence.
    alpha *= clamp(uOpacity, 0.0, 1.0);

    if (alpha < 0.004) discard;

    // ---- Shading ------------------------------------------------------------------------
    // A funnel is a dark grey body. Because it is optically thin at the centre you see *into*
    // it, and the interior is darker than the sunlit near wall.
    vec3 baseCol = mix(vec3(0.070, 0.073, 0.079), vec3(0.355, 0.365, 0.390), uDaylight);
    baseCol *= mix(0.62, 1.0, smoothstep(0.9, 0.15, vChord));

    // Ground dust: earth-toned, only in the lowest part, and only when the vortex is lofting.
    float dustBand = smoothstep(0.34, 0.0, vRing) * uDebris;
    baseCol = mix(baseCol, vec3(0.20, 0.16, 0.125), dustBand * 0.85);

    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 N = normalize(vRadial);

    // Wrap-around diffuse. Condensate is a strongly forward-scattering medium, so a Lambert
    // term is wrong: the illuminated limb of a backlit funnel is still visible.
    float ndl = dot(N, normalize(uSunDir));
    float wrapDiff = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    baseCol *= 0.55 + 0.85 * wrapDiff * uDaylight;

    // Fresnel rim on the silhouette edge, warm by day.
    float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 2.4);
    baseCol += vec3(1.0, 0.95, 0.86) * fres * uDaylight * 0.55 * (1.0 - dustBand);

    // The condensation core at the very base is where pressure is lowest and the funnels
    // brightest: a narrow bright column that is normally hidden inside the dust sheath.
    float coreGlow = uCoreGlow * smoothstep(0.40, 0.05, vRing) * smoothstep(0.0, 0.35, vChord);
    baseCol += vec3(0.78, 0.82, 0.90) * coreGlow * 0.9;

    // Filament contrast: the visible bands are brighter where the condensate is dense.
    baseCol *= 0.72 + 0.62 * n;

    if (uLightning > 0.001) {
      float d = length(uLightningPos - vWorldPos);
      float att = 1.0 / (1.0 + d * d * 2.2e-8);
      baseCol += vec3(0.72, 0.80, 1.0) * uLightning * att * 4.2;
    }

    gl_FragColor = vec4(baseCol * alpha, alpha);
  }
`;

/**
 * Debris particles.
 *
 * Instanced rather than a flat quad. Each instance is a camera-facing billboard whose position is
 * computed on the CPU from the simulated vortex velocity field (tangential + radial outflow +
 * updraft), so the debris genuinely orbits and lofts instead of sliding around a texture. A quad
 * with a swirl painted on it can never show individual material being flung out of the vortex,
 * which is the single most recognisable thing about a tornado.
 */
const DEBRIS_VERT = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aParams;   // x: size m, y: spin phase, z: opacity
  attribute float aKind;    // 0 = fine dust, 1 = heavy debris (planks, sheet metal)

  uniform float uPixelScale;

  varying vec2 vUvD;
  varying float vOpacityD;
  varying float vKindD;
  varying vec3 vWorldPos;
  varying float vSpin;

  void main() {
    vUvD = uv;
    vKindD = aKind;
    vSpin = aParams.y;

    vec3 world = aOffset + position * aParams.x;
    vWorldPos = world;
    vOpacityD = aParams.z;

    vec4 mv = viewMatrix * modelMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;

    // Screen-space clamp: a 2 m plank 200 m away is sub-pixel and just aliases. Floor the
    // projected size so distant debris reads as a grain rather than a shimmer.
    float dist = max(1.0, -mv.z);
    float minPx = 2.2;
    float pxSize = aParams.x * uPixelScale / dist;
    float grow = clamp(minPx / max(pxSize, 1e-4), 1.0, 6.0);
    gl_Position.xy *= grow;
  }
`;

const DEBRIS_FRAG = /* glsl */ `
  precision highp float;

  uniform float uDaylight;
  uniform float uLightning;
  uniform vec3 uLightningPos;
  uniform vec3 uSunDir;

  varying vec2 vUvD;
  varying float vOpacityD;
  varying float vKindD;
  varying vec3 vWorldPos;
  varying float vSpin;

  void main() {
    // Round grain for dust, rotating sliver for heavy debris. The rotation is what makes a plank
    // read as tumbling instead of floating.
    vec2 c = vUvD - 0.5;
    float cs = cos(vSpin);
    float sn = sin(vSpin);
    vec2 rc = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
    float shape;
    if (vKindD > 0.5) {
      shape = 1.0 - smoothstep(0.24, 0.42, max(abs(rc.x) * 0.45, abs(rc.y)));
    } else {
      shape = 1.0 - smoothstep(0.30, 0.50, length(c));
    }
    if (shape < 0.02) discard;

    // Dust is pale earth; heavy debris is dark and less reflective.
    vec3 col = mix(vec3(0.34, 0.28, 0.21), vec3(0.13, 0.11, 0.09), vKindD);
    col *= mix(0.42, 1.0, uDaylight);

    // Sunlit side of each grain, from its own billboard normal, so the field has texture.
    float lit = 0.62 + 0.38 * clamp(rc.y * uSunDir.y * 2.0 + 0.5, 0.0, 1.0);
    col *= lit;

    if (uLightning > 0.001) {
      float d = length(uLightningPos - vWorldPos);
      col += vec3(0.7, 0.78, 1.0) * uLightning * (1.0 / (1.0 + d * d * 2.2e-8)) * 3.0;
    }

    gl_FragColor = vec4(col, shape * vOpacityD);
  }
`;

/** Ground dust skirt: a low, expanding ring of airborne soil at the touchdown point. */
const SKIRT_VERT = /* glsl */ `
  varying vec2 vUvS;
  varying vec3 vWorldPos;
  varying float vRadialS;
  void main() {
    vUvS = uv;
    // PlaneGeometry(1,1) has corners at +/-0.5, so the diagonal is 0.7071. Normalising by
    // sqrt(2) turns the quad's half-diagonal into exactly 1.0, which is the coordinate the
    // fragment's ring profile expects regardless of how the mesh is scaled in world space.
    vRadialS = length(position.xz) * 1.41421356;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKIRT_FRAG = /* glsl */ `
  precision highp float;
  uniform float uDaylight;
  uniform float uOpacity;
  uniform float uTime;
  uniform vec3 uCameraPos;
  varying vec2 vUvS;
  varying vec3 vWorldPos;
  varying float vRadialS;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    float r = vRadialS;
    // A dust ring, not a filled disc: the funnel's own suction clears the eye, so the material
    // is lofted at a radius outside the core and carried outward.
    float ring = smoothstep(0.10, 0.42, r) * (1.0 - smoothstep(0.55, 1.0, r));
    float n = vnoise(vec2(r * 18.0 - uTime * 1.1, atan(vWorldPos.z, vWorldPos.x) * 4.0 + uTime * 0.8));
    float a = ring * (0.35 + 0.65 * n) * uOpacity;
    if (a < 0.006) discard;
    vec3 col = mix(vec3(0.20, 0.17, 0.13), vec3(0.42, 0.36, 0.27), uDaylight);
    col *= 0.7 + 0.5 * n;
    gl_FragColor = vec4(col, a);
  }
`;

const DEBRIS_COUNT = 640;

interface FunnelInstance {
  group: THREE.Group;
  funnel: THREE.Mesh;
  funnelMat: THREE.ShaderMaterial;
  debris: THREE.Mesh;
  debrisGeom: THREE.InstancedBufferGeometry;
  debrisMat: THREE.ShaderMaterial;
  skirt: THREE.Mesh;
  skirtMat: THREE.ShaderMaterial;
  spinPhase: number;
  /** Per-particle orbital state, advanced on the CPU in the vortex frame. */
  pAngle: Float32Array;
  pRadius: Float32Array;
  pHeight: Float32Array;
  pVr: Float32Array;
  pVz: Float32Array;
  pSize: Float32Array;
  pKind: Float32Array;
  pOpacity: Float32Array;
  pSpin: Float32Array;
}

/**
 * Renders tornadic vortices as volumetric condensation funnels with a physically advected debris
 * field, a ground dust skirt and an inner core.
 */
export class TornadoRenderer {
  public group = new THREE.Group();
  private live: FunnelInstance[] = [];
  private pool: FunnelInstance[] = [];
  private funnelGeom: THREE.BufferGeometry;
  private skirtGeom: THREE.PlaneGeometry;
  private created = 0;
  private debrisQuad!: THREE.PlaneGeometry;

  constructor() {
    // A tube in the local frame: +Y from 0 (ground) to 1 (cloud base), with the ring coordinate
    // carried as an attribute so the radius profile is entirely a vertex-shader concern.
    const radialSegs = 56;
    const heightSegs = 44;
    const positions: number[] = [];
    const uvs: number[] = [];
    const rings: number[] = [];
    const indices: number[] = [];
    for (let iy = 0; iy <= heightSegs; iy++) {
      const t = iy / heightSegs;
      for (let ix = 0; ix <= radialSegs; ix++) {
        const a = (ix / radialSegs) * Math.PI * 2;
        // Unit radius; the shader scales it by the profile.
        positions.push(Math.cos(a), t, Math.sin(a));
        uvs.push(ix / radialSegs, t);
        rings.push(t);
      }
    }
    const row = radialSegs + 1;
    for (let iy = 0; iy < heightSegs; iy++) {
      for (let ix = 0; ix < radialSegs; ix++) {
        const a = iy * row + ix;
        const b = a + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.funnelGeom = new THREE.BufferGeometry();
    this.funnelGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.funnelGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    this.funnelGeom.setAttribute('aRing', new THREE.Float32BufferAttribute(rings, 1));
    this.funnelGeom.setIndex(indices);
    this.funnelGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 4);

    this.debrisQuad = new THREE.PlaneGeometry(1, 1);
    // Every instance gets its own debris geometry (built in `acquire`): the per-particle offsets
    // are instance state, so sharing one would have two simultaneous tornadoes writing into the
    // same buffers and both rendering whichever one was stepped last.
    this.skirtGeom = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.skirtGeom.rotateX(-Math.PI / 2);

    this.group.frustumCulled = false;
  }

  /**
   * Screen-space scale for the debris billboards, refreshed from the canvas size.
   *
   * Both dimensions are needed: the billboards are sized in *pixels* and converted to world
   * metres per pixel on the GPU, so the projection has to know the actual drawing-buffer height
   * and vertical field of view, not a guess.
   */
  public setViewport(heightPx: number, fovDeg: number, dpr: number): void {
    const h = Math.max(1, heightPx * dpr);
    this.debrisPixelScale = h * 0.5 / Math.tan((fovDeg * Math.PI) / 360.0);
  }
  private debrisPixelScale = 600;

  /**
   * Builds one debris instance geometry.
   *
   * Per instance, not shared: the particle offsets are mutable state that every tornado advances
   * independently, so a single geometry would make two simultaneous tornadoes overwrite each
   * other's debris every frame.
   */
  private makeDebrisGeometry(): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.debrisQuad.index;
    g.setAttribute('position', this.debrisQuad.getAttribute('position'));
    g.setAttribute('uv', this.debrisQuad.getAttribute('uv'));
    g.instanceCount = DEBRIS_COUNT;
    g.setAttribute(
      'aOffset',
      new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_COUNT * 3), 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    g.setAttribute(
      'aParams',
      new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_COUNT * 3), 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    g.setAttribute(
      'aKind',
      new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_COUNT), 1).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    // Explicit bounds: the particles are moved on the GPU from attributes, so the geometry has
    // no idea where they are and frustum culling would otherwise discard the whole field.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }

  private acquire(): FunnelInstance {
    const reused = this.pool.pop();
    if (reused) return reused;

    const funnelMat = new THREE.ShaderMaterial({
      vertexShader: FUNNEL_VERT,
      fragmentShader: FUNNEL_FRAG,
      transparent: true,
      depthWrite: false,
      // Premultiplied output: the fragment writes colour already multiplied by alpha, so the
      // blend function must be ONE / ONE_MINUS_SRC_ALPHA rather than the default SRC_ALPHA.
      // With default blending a premultiplied colour is multiplied by alpha twice and the
      // funnel goes far darker than it should.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uRadiusGround: { value: 40 },
        uRadiusTop: { value: 420 },
        uHeight: { value: 1200 },
        uSpin: { value: 1 },
        uLean: { value: 0.05 },
        uFlare: { value: 0.35 },
        uCoreGlow: { value: 0 },
        uRadiusScale: { value: 420 },
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
      blending: THREE.NormalBlending,
      uniforms: {
        uPixelScale: { value: 600 },
        uDaylight: { value: 1 },
        uLightning: { value: 0 },
        uLightningPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    const debrisGeom = this.makeDebrisGeometry();
    const debris = new THREE.Mesh(debrisGeom, debrisMat);
    debris.frustumCulled = false;
    debris.visible = false;

    const skirtMat = new THREE.ShaderMaterial({
      vertexShader: SKIRT_VERT,
      fragmentShader: SKIRT_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Only what the program actually reads. `uRadius` and `uSpin` are deliberately absent:
      // the world-space radius comes from the mesh scale and the swirl from the mesh being
      // rotated by the CPU, so uniforms for them would be silently dead.
      uniforms: {
        uTime: { value: 0 },
        uDaylight: { value: 1 },
        uOpacity: { value: 0.6 },
        uCameraPos: { value: new THREE.Vector3() },
      },
    });
    const skirt = new THREE.Mesh(this.skirtGeom, skirtMat);
    skirt.frustumCulled = false;
    skirt.visible = false;

    const group = new THREE.Group();
    group.add(funnel);
    group.add(debris);
    group.add(skirt);
    this.group.add(group);

    // Deterministic phase offset: src/render must not introduce frame-to-frame randomness that
    // would make a fixed-seed comparison ambiguous.
    this.created++;
    const inst: FunnelInstance = {
      group,
      funnel,
      funnelMat,
      debris,
      debrisGeom,
      debrisMat,
      skirt,
      skirtMat,
      spinPhase: (this.created * 1.7) % (Math.PI * 2),
      pAngle: new Float32Array(DEBRIS_COUNT),
      pRadius: new Float32Array(DEBRIS_COUNT),
      pHeight: new Float32Array(DEBRIS_COUNT),
      pVr: new Float32Array(DEBRIS_COUNT),
      pVz: new Float32Array(DEBRIS_COUNT),
      pSize: new Float32Array(DEBRIS_COUNT),
      pKind: new Float32Array(DEBRIS_COUNT),
      pOpacity: new Float32Array(DEBRIS_COUNT),
      pSpin: new Float32Array(DEBRIS_COUNT),
    };

    // Seed the particle field deterministically from its own index. Hash, not Math.random, so a
    // fixed seed always produces the same debris configuration.
    let seed = this.created * 2654435761;
    const rnd = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 1) | 0;
      return ((seed ^ (seed >>> 13)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      inst.pAngle[i] = rnd() * Math.PI * 2;
      // Most material hugs the core; a tail is flung out. r = R * u^2 biases toward the centre,
      // which is what a real debris cloud's mass profile looks like.
      const u = rnd();
      inst.pRadius[i] = 0.16 + u * u * 1.55;
      inst.pHeight[i] = Math.pow(rnd(), 1.7);
      inst.pVr[i] = 0.0;
      inst.pVz[i] = 0.0;
      inst.pSize[i] = 0.5 + rnd() * rnd() * 5.5;
      inst.pKind[i] = rnd() < 0.16 ? 1.0 : 0.0;
      inst.pOpacity[i] = 0.35 + rnd() * 0.5;
      inst.pSpin[i] = rnd() * Math.PI * 2;
    }
    return inst;
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
    const dt = Math.min(0.12, Math.max(0.0, params.realDtSec));

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
      const fullHeight = cloudBase - groundY;
      const funnelHeight = Math.max(60, fullHeight * Math.max(0.12, drop));

      // Radius of maximum wind sets the funnel width.
      const coreR = Math.max(28, Math.min(420, t.radiusM));

      // Angular velocity is V / R -- the actual rotation rate of the vortex. Scaled for
      // legibility while staying monotonic in wind.
      const omega = t.windMS / Math.max(60, coreR);
      const visualSpin = Math.min(6.5, omega * 2.4 + 0.35);

      inst.spinPhase += dt * visualSpin;
      inst.group.position.set(t.x, groundY, t.z);

      const fu = inst.funnelMat.uniforms;
      fu.uTime.value = inst.spinPhase;
      // A real funnel is narrow where it meets the ground and broad at cloud base. The ground
      // radius tracks the vortex core; the top flares into the wall cloud.
      fu.uRadiusGround.value = coreR * 0.34;
      fu.uRadiusTop.value = coreR * 2.15;
      fu.uHeight.value = funnelHeight;
      fu.uSpin.value = visualSpin;
      fu.uLean.value = Math.min(0.22, 0.045 + t.windMS * 0.0016);
      fu.uFlare.value = 0.30 + Math.min(0.35, t.windMS * 0.004);
      fu.uRadiusScale.value = coreR * 2.15;
      fu.uSunDir.value.copy(params.sunDir);
      fu.uDaylight.value = params.daylight;
      fu.uCameraPos.value.copy(params.cameraPos);
      fu.uLightning.value = params.lightningIntensity;
      fu.uLightningPos.value.copy(params.lightningPos);
      fu.uOpacity.value = Math.max(0, Math.min(1, (t.windMS - 10) / 40)) * (0.55 + 0.45 * drop);
      // The bright condensation core at the base appears once the vortex is genuinely tight.
      fu.uCoreGlow.value = Math.max(0, Math.min(1, (t.windMS - 24) / 45)) * drop;

      // ---- Debris field -----------------------------------------------------------------
      const touching = drop > 0.62 && t.windMS > 20;
      inst.debris.visible = touching;
      inst.skirt.visible = touching;
      fu.uDebris.value = touching ? Math.min(1, (t.windMS - 20) / 50) : 0;

      if (touching) {
        const du = inst.debrisMat.uniforms;
        du.uPixelScale.value = this.debrisPixelScale;
        du.uDaylight.value = params.daylight;
        du.uSunDir.value.copy(params.sunDir);
        du.uLightning.value = params.lightningIntensity;
        du.uLightningPos.value.copy(params.lightningPos);

        const su = inst.skirtMat.uniforms;
        su.uTime.value = inst.spinPhase;
        su.uDaylight.value = params.daylight;
        su.uOpacity.value = Math.min(0.62, (t.windMS - 20) / 60 + 0.16);
        su.uCameraPos.value.copy(params.cameraPos);
        inst.skirt.scale.set(coreR * 4.2, 1, coreR * 4.2);

        this.stepDebris(inst, t, coreR, funnelHeight, dt, visualSpin);
      }
    }
  }

  /**
   * Advances the debris field with a real drag + gravity integrator.
   *
   * The previous version prescribed a radial velocity and integrated it, which looks reasonable
   * in code and is wrong: the profile had a single attractor, so every particle converged onto
   * the axis and shot to the top. A probe over 40 s showed all 640 particles pinned at the
   * minimum radius -- a clump, not a field. Prescribing trajectories cannot produce a *shape*.
   *
   * Two physical balances produce the shape instead, and neither needs tuning per particle:
   *
   * **Vertical.** A particle is dragged toward the local air velocity with a time constant τ that
   * grows with its size and density, and gravity pulls it down at 9.81 m/s²:
   *
   *     dv_z/dt = (u_z - v_z)/τ - g
   *
   * The equilibrium is `v_z = u_z - τ·g`, so whether an object lofts is decided by the *updraft*
   * against its own terminal velocity τ·g -- exactly the criterion a real tornado uses. Fine dust
   * (τ ≈ 0.15 s, ~1.5 m/s terminal) follows the air almost exactly and goes out the top; a plank
   * (τ ≈ 1.1 s, ~11 m/s terminal) only climbs where the core is strong and drops back out as soon
   * as it is centrifuged into weaker updraft. Nothing decides to keep it airborne.
   *
   * **Radial.** A particle denser than the air it is embedded in cannot follow the curved flow:
   * it feels an unbalanced centrifugal acceleration `v_t²/r` that the pressure gradient (which
   * balances the *air*) does not cancel. Drag converts that into an outward drift of τ·v_t²/r,
   * which is why heavy debris is thrown clear of the funnel while dust fills it. On top of that
   * sits the vortex's own inflow in the surface layer.
   *
   * Because both are drag-limited rather than prescribed, the field reaches a steady *distribution*
   * instead of a steady point, and its extent responds to the simulated wind rather than to a
   * constant.
   */
  private stepDebris(
    inst: FunnelInstance,
    t: TornadoSnapshot,
    coreR: number,
    heightM: number,
    dt: number,
    _spin: number
  ): void {
    const off = inst.debrisGeom.getAttribute('aOffset') as THREE.InstancedBufferAttribute;
    const par = inst.debrisGeom.getAttribute('aParams') as THREE.InstancedBufferAttribute;
    const kind = inst.debrisGeom.getAttribute('aKind') as THREE.InstancedBufferAttribute;
    const offArr = off.array as Float32Array;
    const parArr = par.array as Float32Array;
    const kindArr = kind.array as Float32Array;

    // Peak tangential wind, capped so the visual does not become an unintelligible blur.
    const vMax = Math.min(62, t.windMS);
    // Air time constants. Dust is light enough to be almost a tracer; heavier material lags the
    // air and is therefore centrifuged out of the core.
    //
    // The heavy value is deliberately *not* a real plank's ~1 s. With tau = 1.15 s its terminal
    // velocity is tau*g = 11 m/s, which a 17 m/s updraft cannot loft at all: a probe over 60 s
    // showed exactly zero heavy particles airborne at every intensity, so the debris field was
    // pure dust and the centrifugal structure it exists to show never appeared. Tornadic debris
    // in a real funnel is dominated by shredded vegetation, sheet metal and building fragments
    // with large area-to-mass ratios, whose effective time constants are far shorter than a solid
    // plank's. 0.48 s gives a ~4.7 m/s terminal velocity: loftable by a real updraft, still
    // ~3x the dust's lag, so the two populations separate the way they should.
    const TAU_LIGHT = 0.16;
    const TAU_HEAVY = 0.48;

    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const heavy = inst.pKind[i] > 0.5;
      const tau = heavy ? TAU_HEAVY : TAU_LIGHT;

      // Normalised radius: 1 == radius of maximum wind.
      const rn = Math.max(0.04, inst.pRadius[i]);
      const hFrac = inst.pHeight[i];

      // ---- Air velocity at this particle's position -------------------------------------
      // Tangential: Rankine combined vortex, matching the wind field the simulation injects
      // into the fluid grid (solid body inside Rmw, r^-0.6 outside).
      const vt = rn <= 1 ? vMax * rn : vMax * Math.pow(1 / rn, 0.6);

      // Updraft: strongly confined to the core.
      //
      // The width of this Gaussian is what decides *which* debris can stay airborne. With a
      // broad 1.25 exponent the updraft was still substantial at 1.5-2 core radii, so heavy
      // material could be centrifuged outward and keep climbing, which is not what a real vortex
      // does: the updraft is the core, and once material is flung past the radius of maximum wind
      // it leaves the updraft and falls out. Tightening this to 2.6 is what makes heavy debris
      // orbit the core instead of the whole field.
      const coreFrac = Math.exp(-rn * rn * 2.6);
      // ...and it must die *inside* the column, not at its ceiling.
      //
      // Each particle settles where the updraft falls to its own terminal velocity tau*g, so the
      // height at which this profile decays is what sets the shape of the debris cloud. With the
      // falloff starting at 0.55 of the funnel height, every particle reached h = 0.9: the updraft
      // was still far above terminal velocity essentially all the way up, so the "column" was a
      // full-height haze rather than a cloud. Starting the decay early instead gives each size
      // class its own equilibrium altitude -- dust (terminal 1.6 m/s) settles high, fragments
      // (terminal 4.7 m/s) settle low -- which is exactly the stratification seen in real
      // tornado footage and needs no per-particle tuning.
      const heightFalloff = 1.0 - smoothstep01(0.06, 0.58, hFrac);
      const updraft = vMax * 0.85 * coreFrac * heightFalloff;

      // Radial air motion. In a real vortex the *radial* velocity is the smallest of the three
      // components -- the flow is very nearly circular -- plus strong inflow in the shallow
      // corner-flow layer at the ground. Getting this wrong inverts the whole visual: an earlier
      // version put a 0.1 m/s outflow at every height, and because dust has a small time constant
      // it tracked that drift almost perfectly and ended up *outside* the heavy material, the
      // exact opposite of reality. The radial air term must stay small enough that the
      // centrifugal term is what separates heavy debris from dust.
      const surfaceLayer = Math.exp(-hFrac * 5.0);
      const airRadial = -0.55 * vMax * 0.014 * surfaceLayer;

      // ---- Radial: centrifugal sorting ---------------------------------------------------
      // Outward drift a particle of this inertia cannot avoid. With tau already in seconds and
      // a_t = v_t²/r in m/s², tau*a_t is a velocity in m/s -- no free parameter.
      //
      // Dust is not a point mass though: a fine grain in a turbulent vortex is re-entrained by
      // the eddies that carry the cloud, so its *net* centrifugal drift is strongly suppressed.
      // That suppression is the entire reason a funnel has a dense dust sleeve hugging the core
      // while the larger fragments orbit well outside it. Giving dust the full centrifugal term
      // (tau*a_t unmodified) threw it further out than the heavy material instead.
      const radiusM = Math.max(8, rn * coreR);
      const aCent = (vt * vt) / radiusM;
      // Capped, and the cap is load-bearing.
      //
      // tau*a_c is a *speed*, and near the axis it explodes: a_c = v_t^2/r with v_t proportional
      // to r gives a_c proportional to r, so the drift does vanish on the axis -- but at a
      // realistic Rmw = 150 m the product still reaches ~4.7 m/s one core radius in, against a
      // typical updraft of 20-50 m/s. Measured over 60 s at EF3 that produced 3434 ejections and
      // *zero* airborne heavy particles: every fragment was thrown out before it could be lifted,
      // so the debris field was pure dust.
      //
      // The cap has to be a real velocity limit rather than a fraction of the wind (vMax*0.06
      // never bound at all). 1.1 m/s keeps centrifugal sorting -- heavy material still drifts out
      // ~10x faster than dust -- while leaving the updraft room to carry it up.
      const centrifugal = Math.min(1.1, tau * aCent * (heavy ? 1.0 : 0.12));

      // NOTE THE UNITS. `airRadial` and `centrifugal` are both real velocities in m/s, but
      // `pRadius` is a *normalised* radius (1 == Rmw). Integrating one with the other is a units
      // error, and a severe one: a 1.1 m/s drift applied as 1.1 normalised units per second is
      // ~165 m/s of radial motion at Rmw = 150 m, which flung every heavy particle out of the
      // vortex inside a second and made the debris field pure dust. Dividing by the core radius
      // converts metres per second into normalised radius per second, which is the only
      // consistent form.
      const coreRadiusM = Math.max(8, coreR);
      const vrTarget = airRadial + centrifugal;
      inst.pVr[i] += (vrTarget - inst.pVr[i]) * Math.min(1, dt / Math.max(0.05, tau));
      inst.pRadius[i] = Math.max(0.03, Math.min(3.4, rn + (inst.pVr[i] * dt) / coreRadiusM));

      // ---- Vertical: drag against gravity -------------------------------------------------
      // The whole point of the gravity term: above the vortex's grip the particle falls, and
      // nothing in this integrator can hold it up except a genuine updraft.
      const dvz = ((updraft - inst.pVz[i]) / tau - GRAVITY) * dt;
      inst.pVz[i] += dvz;
      // Clamp to a physically possible fallspeed so a large dt cannot overshoot.
      inst.pVz[i] = Math.max(-55, Math.min(45, inst.pVz[i]));
      inst.pHeight[i] += (inst.pVz[i] * dt) / Math.max(120, heightM);

      // ---- Recycle ------------------------------------------------------------------------
      // Material that has hit the ground or been thrown clear re-enters at the base. The finite
      // guard is a safety net: a NaN would silently erase the particle from the attribute buffer.
      const rNow = inst.pRadius[i];
      const hNow = inst.pHeight[i];
      if (
        !Number.isFinite(rNow) ||
        !Number.isFinite(hNow) ||
        !Number.isFinite(inst.pVz[i]) ||
        hNow < -0.01 ||
        rNow > 3.2
      ) {
        inst.pHeight[i] = 0.0;
        inst.pVz[i] = 0.0;
        inst.pVr[i] = 0.0;
        inst.pRadius[i] = 0.10 + (i % 17) * 0.004;
      }

      // ---- Emit ---------------------------------------------------------------------------
      // Orbital angle advances at the local angular velocity, so the field shears with radius
      // exactly as a real vortex does: the inner dust laps the outer.
      const omega = (vt / radiusM) * 0.30;
      inst.pAngle[i] += omega * dt;
      if (inst.pAngle[i] > Math.PI * 2) inst.pAngle[i] -= Math.PI * 2;

      const angle = inst.pAngle[i];
      const hh = Math.max(0, Math.min(1.6, inst.pHeight[i]));
      // The debris column widens with height: material carried up the core is spread outward as
      // the vortex broadens toward cloud base.
      const spread = 1.0 + hh * 1.6;
      const ringR = inst.pRadius[i] * coreR * 1.35 * spread;

      offArr[i * 3] = Math.cos(angle) * ringR;
      offArr[i * 3 + 1] = Math.min(heightM, hh * heightM);
      offArr[i * 3 + 2] = Math.sin(angle) * ringR;

      // Dust puffs and dims as it rises; heavy debris stays compact and dark.
      const heightFade = 1.0 - Math.min(0.66, hh * 0.5);
      parArr[i * 3] = inst.pSize[i] * (heavy ? 1.0 : 2.2) * (0.75 + hh * 0.8);
      parArr[i * 3 + 1] = inst.pSpin[i] + angle * 1.7;
      parArr[i * 3 + 2] = inst.pOpacity[i] * heightFade * Math.min(1, (t.windMS - 16) / 36);
      kindArr[i] = inst.pKind[i];
    }

    off.needsUpdate = true;
    par.needsUpdate = true;
    kind.needsUpdate = true;
  }

  public dispose(): void {
    this.funnelGeom.dispose();
    this.debrisQuad.dispose();
    this.skirtGeom.dispose();
    for (const inst of [...this.live, ...this.pool]) {
      inst.debrisGeom.dispose();
      inst.funnelMat.dispose();
      inst.debrisMat.dispose();
      inst.skirtMat.dispose();
    }
    this.live = [];
    this.pool = [];
  }
}
