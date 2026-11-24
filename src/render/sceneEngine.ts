import * as THREE from 'three';
import { AtmosphereSimulationCoordinator } from '../sim/atmosphereCoordinator';
import { AdaptivePerformanceManager, MAX_DEVICE_PIXEL_RATIO } from '../sim/performanceManager';
import { DOMAIN_MAX_ALT, DOMAIN_SIZE } from '../sim/types';
import { ObserverCameraController } from './cameraController';
import { LightningAndTLERenderer } from './lightningAndTLERenderer';
import { BloomPass } from '../performance/bloom';
import { LightningCameraShake } from '../performance/cameraShake';
import { LightningRodRenderer } from './lightningRodRenderer';
import { TornadoRenderer } from './tornadoRenderer';
import { NearFieldPrecipitationRenderer } from './precipitationRenderer';
import { GroundEnvironmentRenderer } from './terrainRenderer';
import { SunCycle } from './sunCycle';
import {
  COMPOSITE_POST_FRAG,
  FULLSCREEN_QUAD_VERT,
  SKY_DOME_FRAG,
  SKY_DOME_VERT,
  VOLUMETRIC_CLOUD_FRAG,
} from './volumetricSkyShader';

/**
 * Halton low-discrepancy sequence, used to rotate the volumetric buffer's sub-pixel offset.
 * Base 2 and 3 decorrelate horizontally from vertically, so consecutive frames land on
 * different sub-texel positions and the temporal reprojection in the composite pass
 * reconstructs detail the sub-resolution buffer could not resolve on its own.
 */
function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

const COPY_FRAG_GLSL3 = /* glsl */ `
  precision highp float;
  uniform sampler2D uSrc;
  in vec2 vUv;
  out vec4 fragColor;
  void main() {
    fragColor = texture(uSrc, vUv);
  }
`;

export class AtmosphericSceneEngine {
  public renderer: THREE.WebGLRenderer;
  public cameraCtrl: ObserverCameraController;

  private mainScene: THREE.Scene;
  private skyDomeMesh: THREE.Mesh;
  private skyDomeMat: THREE.ShaderMaterial;
  private groundRenderer: GroundEnvironmentRenderer;
  private lightningRenderer: LightningAndTLERenderer;
  private precipRenderer: NearFieldPrecipitationRenderer;
  private rodRenderer: LightningRodRenderer;
  private tornadoRenderer: TornadoRenderer;
  /** Scratch vectors/colours for the precipitation light, reused every frame. */
  private precipLightDir = new THREE.Vector3(0.4, 0.8, -0.45);
  private precipLightColor = new THREE.Color(1, 0.97, 0.92);
  private precipHazeColor = new THREE.Color(0.42, 0.47, 0.53);

  private volTexture3D: THREE.Data3DTexture;
  /**
   * R8 map of persistent surface water saturation, one texel per 500 m ground column. Backs
   * the same Uint8Array the simulation writes, so uploading is a straight buffer copy.
   */
  private groundSatTexture: THREE.DataTexture;
  /** Mesoscale boundary-layer mirror: R = local relative humidity, G = local cloud base. */
  private localWeatherTexture: THREE.DataTexture;

  private sceneRT!: THREE.WebGLRenderTarget;
  private outputRT!: THREE.WebGLRenderTarget;
  private bloomPass!: BloomPass;
  private cameraShake = new LightningCameraShake();
  private volCurrRT!: THREE.WebGLRenderTarget;
  private volPrevRT!: THREE.WebGLRenderTarget;

  private postScene: THREE.Scene;
  private postCamera: THREE.OrthographicCamera;
  private quadMesh: THREE.Mesh;
  private volCloudMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;

  private width = 1;
  private height = 1;
  private dpr = 1;
  /** Device pixel ratio before the user's render-scale slider, clamped to the engine cap. */
  private basePixelRatio = 1;
  /** User render-scale multiplier in [0.1, 1.0]; 1.0 reproduces the native resolution. */
  private pixelRatioScale = 1;
  private volW = 2;
  private volH = 2;
  /**
   * Volumetric buffer scale last requested by the quality manager. Cached so a context restore
   * can rebuild every render target at the same resolution the user was actually running.
   */
  private volumetricScaleCache = 0.6;
  private frameIndex = 0;
  private realTimeElapsed = 0;
  private windOffset = new THREE.Vector3();
  private precipDrift = new THREE.Vector3();
  private sunDir = new THREE.Vector3();
  /** Reused camera-shake temporaries: the render hot path must not allocate per frame. */
  private shakeAxis = new THREE.Vector3();
  private shakeQuat = new THREE.Quaternion();
  private autoExposureCurrent = 1.0;
  /** Diurnal solar geometry: drives sun/moon direction, daylight and surface insolation. */
  public readonly sunCycle = new SunCycle();
  private viewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private hasPrevViewProj = false;
  /**
   * True once `volPrevRT` actually contains a previous frame of volumetrics.
   *
   * Distinct from `hasPrevViewProj`: that one only says a view-projection matrix exists to
   * reproject with, and it is set earlier in the same frame. This one says the texture being
   * sampled as history has been rendered at least once, which is what makes it safe to blend.
   */
  private hasVolHistory = false;
  /**
   * True once the GL context has been lost. Chrome drops a context under GPU memory pressure,
   * after a driver reset, or when the tab is backgrounded on a memory-tight mobile device; every
   * draw call after that silently no-ops or throws, so the frame loop has to stop issuing work
   * instead of spamming a dead context.
   */
  private contextLost = false;
  /** Detaches the context-loss listeners in `dispose()`. */
  private detachContextListeners: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    coordinator: AtmosphereSimulationCoordinator,
    perfMgr: AdaptivePerformanceManager
  ) {
    this.width = Math.max(1, container.clientWidth);
    this.height = Math.max(1, container.clientHeight);
    this.basePixelRatio = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      MAX_DEVICE_PIXEL_RATIO
    );
    this.pixelRatioScale = Math.min(1, Math.max(0.1, perfMgr.clampedPixelRatioScale));
    this.dpr = this.basePixelRatio * this.pixelRatioScale;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: false,
    });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height);
    this.renderer.autoClear = true;
    container.appendChild(this.renderer.domElement);

    // Query GPU hardware renderer string where supported
    const gl = this.renderer.getContext();
    const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbgInfo) {
      const gpuName = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL);
      if (typeof gpuName === 'string' && gpuName.length > 0) {
        perfMgr.setGpuRendererInfo(gpuName);
      }
    }

    this.cameraCtrl = new ObserverCameraController(this.width / this.height);
    this.cameraCtrl.attach(this.renderer.domElement);

    // A lost context is not fatal: the browser restores it automatically once the GPU is
    // available again, but every render target, texture and shader object is gone with it.
    // three.js re-uploads on demand, so all this side has to do is stop drawing until then.
    const canvas = this.renderer.domElement;
    const onContextLost = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
      console.warn('[MeteoLab] WebGL context lost; pausing the render loop until it is restored.');
    };
    const onContextRestored = () => {
      this.contextLost = false;
      // The restored context has none of the old history: reprojecting last frame's volume onto
      // a fresh target would smear the sky, so the temporal chain restarts from scratch.
      this.hasPrevViewProj = false;
      this.hasVolHistory = false;
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setSize(this.width, this.height);
      this.allocateRenderTargets(this.volumetricScaleCache);
      console.info('[MeteoLab] WebGL context restored.');
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    this.detachContextListeners = () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
    };

    // Create WebGL2 3D Volume Texture directly backed by simulation grid's Uint8Array
    this.volTexture3D = new THREE.Data3DTexture(
      coordinator.grid.volTexData,
      coordinator.grid.nx,
      coordinator.grid.ny,
      coordinator.grid.nz
    );
    this.volTexture3D.format = THREE.RGBAFormat;
    this.volTexture3D.type = THREE.UnsignedByteType;
    this.volTexture3D.minFilter = THREE.LinearFilter;
    this.volTexture3D.magFilter = THREE.LinearFilter;
    this.volTexture3D.wrapS = THREE.ClampToEdgeWrapping;
    this.volTexture3D.wrapT = THREE.ClampToEdgeWrapping;
    this.volTexture3D.wrapR = THREE.ClampToEdgeWrapping;
    this.volTexture3D.unpackAlignment = 1;
    this.volTexture3D.needsUpdate = true;

    // Persistent ground saturation, consumed by the terrain shader to place puddles where rain
    // actually landed rather than everywhere the global wetness scalar happens to be high.
    this.groundSatTexture = new THREE.DataTexture(
      coordinator.grid.groundSatTex,
      coordinator.grid.nx,
      coordinator.grid.nz,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    this.groundSatTexture.minFilter = THREE.LinearFilter;
    this.groundSatTexture.magFilter = THREE.LinearFilter;
    this.groundSatTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.groundSatTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.groundSatTexture.unpackAlignment = 1;
    this.groundSatTexture.needsUpdate = true;

    // Resolved mesoscale boundary-layer field, so haze and visibility vary across the landscape
    // with the air that is actually there instead of one domain-wide scalar. Two channels per
    // texel, hence RGFormat and an unpack alignment of 2.
    this.localWeatherTexture = new THREE.DataTexture(
      coordinator.mesoscale.localWeatherTex,
      coordinator.mesoscale.nx,
      coordinator.mesoscale.nz,
      THREE.RGFormat,
      THREE.UnsignedByteType
    );
    this.localWeatherTexture.minFilter = THREE.LinearFilter;
    this.localWeatherTexture.magFilter = THREE.LinearFilter;
    this.localWeatherTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.localWeatherTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.localWeatherTexture.unpackAlignment = 2;
    this.localWeatherTexture.needsUpdate = true;

    // Build 3D World Scene
    this.mainScene = new THREE.Scene();

    // 1. Sky Dome
    // Enlarged with the terrain: the ground now runs to the horizon (200 km half-extent), so
    // the dome has to enclose it or the far terrain would be drawn outside the sky. Radius is
    // cheap here -- depth precision is set almost entirely by the near plane (1/near dominates
    // 1/near - 1/far), so pushing the far plane from 95 km to 420 km costs about 0.001% of it.
    const skyGeom = new THREE.SphereGeometry(300000, 32, 20);
    this.skyDomeMat = new THREE.ShaderMaterial({
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.4, 0.55, -0.7).normalize() },
        uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, 0.7).normalize() },
        uDaylight: { value: 1 },
        uTime: { value: 0 },
        uRainHaze: { value: 0 },
        uLightningFlash: { value: 0 },
      },
    });
    this.skyDomeMesh = new THREE.Mesh(skyGeom, this.skyDomeMat);
    this.skyDomeMesh.renderOrder = -10;
    this.skyDomeMesh.frustumCulled = false;
    this.mainScene.add(this.skyDomeMesh);

    // 2. Ground Terrain & Wind-Driven Grass
    this.groundRenderer = new GroundEnvironmentRenderer(
      this.volTexture3D,
      this.groundSatTexture,
      this.localWeatherTexture
    );
    this.mainScene.add(this.groundRenderer.terrainMesh);
    this.mainScene.add(this.groundRenderer.grassMesh);

    // 3. 3D Tortuous Lightning Channels & Upper-Atmospheric TLEs
    this.lightningRenderer = new LightningAndTLERenderer();
    this.mainScene.add(this.lightningRenderer.tleGroup);
    this.mainScene.add(this.lightningRenderer.boltMesh);

    // 4. Near-Field Wind-Slanted Precipitation & Ground Splashes
    this.precipRenderer = new NearFieldPrecipitationRenderer();

    // Grounded lightning rod in the observer's meadow. Reads its position from the simulation so
    // the rendered mast and the physical rod are always the same object in the same place.
    const rod = coordinator.lightningRod;
    this.rodRenderer = new LightningRodRenderer(rod.x, rod.z, rod.groundY, rod.heightM);
    this.tornadoRenderer = new TornadoRenderer();
    this.mainScene.add(this.precipRenderer.splashMesh);
    this.mainScene.add(this.precipRenderer.streakMesh);
    this.mainScene.add(this.rodRenderer.group);
    this.mainScene.add(this.tornadoRenderer.group);

    // Post-Processing & Ray-Marching Fullscreen Quad Infrastructure
    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeom = new THREE.PlaneGeometry(2, 2);

    this.volCloudMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_QUAD_VERT,
      fragmentShader: VOLUMETRIC_CLOUD_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uVolTex: { value: this.volTexture3D },
        uDepthTex: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uNear: { value: this.cameraCtrl.camera.near },
        uFar: { value: this.cameraCtrl.camera.far },
        uSunDir: { value: new THREE.Vector3() },
        uMoonDir: { value: new THREE.Vector3() },
        uDaylight: { value: 1 },
        uTime: { value: 0 },
        uSubPixelJitter: { value: new THREE.Vector2() },
        uWindOffset: { value: new THREE.Vector3() },
        uPrecipDrift: { value: new THREE.Vector3() },
        uPrecipFallSpeed: { value: 7.0 },
        uFrozenShare: { value: 0 },
        uDomainSize: { value: DOMAIN_SIZE },
        uMaxAlt: { value: DOMAIN_MAX_ALT },
        uMaxSteps: { value: perfMgr.settings.raymarchSteps },
        uCloudDetail: { value: 1.05 },
        uTurbulence: { value: 1.0 },
        uShadowsEnabled: { value: 1.0 },
        uFrameJitter: { value: 0 },
        uBoltLight0: { value: new THREE.Vector4() },
        uBoltLight1: { value: new THREE.Vector4() },
        uBoltLight2: { value: new THREE.Vector4() },
      },
    });

    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_QUAD_VERT,
      fragmentShader: COMPOSITE_POST_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSceneTex: { value: null },
        uVolCloudTex: { value: null },
        uPrevVolTex: { value: null },
        uDepthTex: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 800, 1 / 600) },
        uResolution: { value: new THREE.Vector2(800, 600) },
        uExposure: { value: 1.0 },
        uTemporalBlend: { value: 0.42 },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uMotionBlur: { value: 0.0 },
        uJitter: { value: 0.0 },
      },
    });

    this.copyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_QUAD_VERT,
      fragmentShader: COPY_FRAG_GLSL3,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSrc: { value: null },
      },
    });

    this.quadMesh = new THREE.Mesh(quadGeom, this.volCloudMat);
    this.quadMesh.frustumCulled = false;
    this.postScene.add(this.quadMesh);

    this.allocateRenderTargets(perfMgr.settings.volumetricScale);
    this.bloomPass = new BloomPass(Math.max(2, Math.floor(this.width * this.dpr)), Math.max(2, Math.floor(this.height * this.dpr)));
  }

  public allocateRenderTargets(volScale: number): void {
    this.volumetricScaleCache = volScale;
    const pixelW = Math.max(2, Math.floor(this.width * this.dpr));
    const pixelH = Math.max(2, Math.floor(this.height * this.dpr));
    const volW = Math.max(2, Math.floor(pixelW * volScale));
    const volH = Math.max(2, Math.floor(pixelH * volScale));

    // A quality change between two tiers whose volumetric scales round to the same resolution
    // would otherwise throw away and rebuild every target for an identical result. That teardown
    // is a hard GPU stall, so it must only happen when it buys something.
    const sceneUnchanged =
      this.sceneRT &&
      this.sceneRT.width === pixelW &&
      this.sceneRT.height === pixelH;
    const volUnchanged =
      this.volCurrRT &&
      this.volCurrRT.width === volW &&
      this.volCurrRT.height === volH;
    if (sceneUnchanged && volUnchanged) {
      this.volW = volW;
      this.volH = volH;
      this.compositeMat.uniforms.uTexelSize.value.set(1.0 / volW, 1.0 / volH);
      this.compositeMat.uniforms.uResolution.value.set(pixelW, pixelH);
      return;
    }

    this.volW = volW;
    this.volH = volH;

    // The scene and output targets only depend on the canvas resolution and pixel ratio. A
    // volumetric-scale change (which is all a quality tier changes) leaves them valid, so they
    // are rebuilt only when their own size actually moved.
    if (!sceneUnchanged) {
      if (this.sceneRT) this.sceneRT.dispose();
      if (this.outputRT) this.outputRT.dispose();
    }
    if (!volUnchanged) {
      if (this.volCurrRT) this.volCurrRT.dispose();
      if (this.volPrevRT) this.volPrevRT.dispose();
    }

    if (!sceneUnchanged) {
      const depthTexture = new THREE.DepthTexture(pixelW, pixelH);
      depthTexture.type = THREE.UnsignedIntType;

      this.sceneRT = new THREE.WebGLRenderTarget(pixelW, pixelH, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        depthTexture,
      });
    }

    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };

    if (!sceneUnchanged) {
      this.outputRT = new THREE.WebGLRenderTarget(pixelW, pixelH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    }
    if (!volUnchanged) {
      this.volCurrRT = new THREE.WebGLRenderTarget(volW, volH, rtOpts);
      this.volPrevRT = new THREE.WebGLRenderTarget(volW, volH, rtOpts);
    }

    this.volCloudMat.uniforms.uDepthTex.value = this.sceneRT.depthTexture;
    this.compositeMat.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.compositeMat.uniforms.uDepthTex.value = this.sceneRT.depthTexture;
    this.compositeMat.uniforms.uTexelSize.value.set(1.0 / volW, 1.0 / volH);
    this.compositeMat.uniforms.uResolution.value.set(pixelW, pixelH);
    if (this.bloomPass) this.bloomPass.setSize(pixelW, pixelH);

    // A resolution change invalidates the previous frame's volume: its texels no longer line
    // up with the new grid, so reprojecting it would smear the whole sky for a few frames.
    this.hasPrevViewProj = false;
    this.hasVolHistory = false;
  }

  /** Internal render size in device pixels, for the HUD resolution readout. */
  public get renderWidthPx(): number {
    return Math.max(2, Math.floor(this.width * this.dpr));
  }

  public get renderHeightPx(): number {
    return Math.max(2, Math.floor(this.height * this.dpr));
  }

  /** The pixel-ratio multiplier currently in effect, after clamping. */
  public get activePixelRatioScale(): number {
    return this.pixelRatioScale;
  }

  /**
   * Applies the user's render-scale slider. This is the highest-leverage frame-time control in
   * the whole pipeline: it scales the canvas backing store and every render target, so a 0.5x
   * setting quarters the fragment work in the scene pass, the ray-march, the composite and the
   * bloom chain at once. The scale is clamped to [0.1, 1.0], i.e. from a tenth of native
   * resolution up to the engine's own device-pixel-ratio cap.
   */
  public setPixelRatioScale(scale: number, volScale: number): void {
    const clamped = Math.min(1, Math.max(0.1, scale));
    if (Math.abs(clamped - this.pixelRatioScale) < 1e-4) return;
    this.pixelRatioScale = clamped;
    this.dpr = this.basePixelRatio * clamped;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height);
    this.allocateRenderTargets(volScale);
  }

  public resize(width: number, height: number, volScale: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.cameraCtrl.camera.aspect = this.width / this.height;
    this.cameraCtrl.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
    this.allocateRenderTargets(volScale);
  }

  public renderFrame(
    realDtSec: number,
    coordinator: AtmosphereSimulationCoordinator,
    perfMgr: AdaptivePerformanceManager
  ): void {
    this.frameIndex++;
    this.realTimeElapsed += realDtSec;

    // A dead context accepts no draw calls; skip the entire pipeline rather than paying for
    // matrix uploads, uniform writes and sim-to-GPU packing that can never reach the screen.
    if (this.contextLost) return;

    // Update camera transform
    this.cameraCtrl.update(realDtSec);
    const cam = this.cameraCtrl.camera;
    if (perfMgr.settings.enableCameraShake) {
      const shake = this.cameraShake.update(realDtSec, coordinator.lightning.activeDischarges, cam.position);
      const shakeAngle = shake.length();
      if (shakeAngle > 0.000001) {
        cam.quaternion.multiply(this.shakeQuat.setFromAxisAngle(this.shakeAxis.copy(shake).normalize(), shakeAngle));
      }
    } else {
      this.cameraShake.update(realDtSec, [], cam.position);
    }
    cam.updateMatrixWorld();

    // Keep sky dome centered on camera
    this.skyDomeMesh.position.copy(cam.position);

    // Upload updated 3D atmospheric volume buffer to GPU. The grid flags this only when a
    // packed voxel actually changed (dynamics step or lightning glow), which keeps clear-sky
    // frames from pushing ~250 KB to the GPU for nothing.
    if (coordinator.grid.textureDirty) {
      this.volTexture3D.needsUpdate = true;
      coordinator.grid.textureDirty = false;
    }
    // 64 x 64 bytes, and only on the frames the bucket actually changed.
    if (coordinator.grid.groundSatDirty) {
      this.groundSatTexture.needsUpdate = true;
      coordinator.grid.groundSatDirty = false;
    }
    if (coordinator.mesoscale.localWeatherDirty) {
      this.localWeatherTexture.needsUpdate = true;
      coordinator.mesoscale.localWeatherDirty = false;
    }

    // ---- Diurnal solar geometry ---------------------------------------------------------
    // Either advance local solar time through the 24 h cycle, or hold the sun at whatever
    // elevation the manual slider specifies. Both paths run through the same solver, so the
    // scene looks identical at a given sun altitude regardless of which mode produced it.
    const settings = perfMgr.settings;
    this.sunCycle.cycleSeconds = settings.dayNightCycleSec;
    if (settings.enableDayNightCycle) {
      this.sunCycle.update(realDtSec, true);
    } else {
      this.sunCycle.applyManualElevation(coordinator.config.sunElevationDeg);
    }
    this.sunDir.copy(this.sunCycle.sunDir);
    const daylight = this.sunCycle.daylight;

    // Feed insolation back into the convection scheme so thermals build through the morning
    // and the boundary layer stops being driven after sunset. This mutates the config field
    // directly instead of going through updateConfig(), which would rebuild the entire
    // sounding every frame; the sounding's thermal response is meant to lag the sky anyway.
    coordinator.config.solarInsolationScale = this.sunCycle.insolation;

    // Advect sub-voxel procedural cloud turbulence smoothly with ambient mid-level wind
    // (scalar accessors: no per-frame level-object allocation).
    this.windOffset.x -= coordinator.sounding.windUAt(3500) * realDtSec * 4.5;
    this.windOffset.z -= coordinator.sounding.windWAt(3500) * realDtSec * 4.5;
    this.windOffset.y -= 1.8 * realDtSec;

    // Update 3D Lightning & Upper-Atmospheric TLE meshes
    this.lightningRenderer.update(
      coordinator.lightning.activeDischarges,
      coordinator.lightning.activeTLEs,
      cam.position
    );

    const flashIntensity = this.lightningRenderer.dominantGroundBoltIntensity;
    const rainHaze = Math.min(
      1.0,
      coordinator.observerRainMMHr / 42.0 + coordinator.grid.domainCloudCoverFraction * 0.22
    );

    // Update Sky Dome
    this.skyDomeMat.uniforms.uSunDir.value.copy(this.sunDir);
    this.skyDomeMat.uniforms.uMoonDir.value.copy(this.sunCycle.moonDir);
    this.skyDomeMat.uniforms.uDaylight.value = daylight;
    this.skyDomeMat.uniforms.uTime.value = this.realTimeElapsed;
    this.skyDomeMat.uniforms.uRainHaze.value = rainHaze;
    this.skyDomeMat.uniforms.uLightningFlash.value = Math.min(1.2, flashIntensity * 0.45);

    // Update Terrain & Wind-Driven Grass
    this.groundRenderer.update({
      timeSec: this.realTimeElapsed,
      sunDir: this.sunDir,
      moonDir: this.sunCycle.moonDir,
      daylight,
      cameraPos: cam.position,
      isGroundMode: this.cameraCtrl.mode === 'ground',
      wetness: coordinator.surfaceWetness,
      rainHaze,
      windU: coordinator.observerWindU,
      windW: coordinator.observerWindW,
      cloudCoverFrac: coordinator.grid.domainCloudCoverFraction,
      lightningPos: this.lightningRenderer.dominantGroundBoltPos,
      lightningIntensity: flashIntensity * 2.5,
      shadowsEnabled: perfMgr.settings.enableShadows,
    });

    // Debris billboards are sized in pixels, so the renderer needs the real drawing-buffer
    // height and vertical FOV -- without them every grain is mis-scaled by the DPR.
    this.tornadoRenderer.setViewport(this.renderHeightPx, cam.fov, this.dpr);

    this.tornadoRenderer.update({
      tornadoes: coordinator.tornadoes.active.map((t) => ({
        id: t.id,
        x: t.x,
        z: t.z,
        windMS: t.maxTangentialMS,
        efScale: t.efScale,
        radiusM: t.radiusM,
        pressureDeficitPa: t.pressureDeficitPa,
        funnelDrop: t.funnelDrop,
        cloudBaseM: t.cloudBaseM,
        ageSec: t.ageSec,
        phase: t.phase,
      })),
      realDtSec,
      sunDir: this.sunDir,
      daylight,
      cameraPos: cam.position,
      lightningIntensity: flashIntensity * 2.5,
      lightningPos: this.lightningRenderer.dominantGroundBoltPos,
    });

    this.rodRenderer.update({
      sunDir: this.sunDir,
      moonDir: this.sunCycle.moonDir,
      daylight,
      cameraPos: cam.position,
      coronaIntensity: coordinator.lightningRod.coronaIntensity,
      lightningIntensity: flashIntensity * 2.5,
      lightningPos: this.lightningRenderer.dominantGroundBoltPos,
      upwardLeaders: coordinator.lightningRod.upwardLeaders,
      interceptedStrikes: coordinator.lightningRod.interceptedStrikes,
      realDtSec,
    });

    // Resolve the dominant light for the precipitation shader: sun by day, moon by night,
    // blended through twilight exactly as the composite pass does, plus a warm->cold colour
    // shift with solar elevation so drop glints match the rest of the scene.
    {
      const moon = this.sunCycle.moonDir;
      const d = daylight;
      this.precipLightDir
        .copy(this.sunDir)
        .multiplyScalar(d)
        .addScaledVector(moon, 1.0 - d);
      if (this.precipLightDir.lengthSq() < 1e-6) this.precipLightDir.set(0.4, 0.8, -0.45);
      this.precipLightDir.normalize();

      const sunElev = Math.max(0, this.sunDir.y);
      // Warm at the horizon, neutral overhead -- the same ramp the volumetric pass uses.
      const warm = 1.0 - Math.min(1, sunElev / 0.42);
      this.precipLightColor.setRGB(1.0, 0.97 - 0.36 * warm, 0.92 - 0.58 * warm);

      // Haze the far streaks fade into: rain-lit sky by day, deep blue-grey at night.
      const hazeLift = 0.30 + 0.30 * d + Math.min(0.22, rainHaze * 0.30);
      this.precipHazeColor.setRGB(hazeLift * 0.96, hazeLift * 1.0, hazeLift * 1.10);
    }

    // Update Near-Field Precipitation & Splashes
    this.precipRenderer.update({
      realTimeSec: this.realTimeElapsed,
      cameraPos: cam.position,
      rainRateMMHr: coordinator.observerRainMMHr,
      precipType: coordinator.observerPrecipType,
      windU: coordinator.observerWindU,
      windW: coordinator.observerWindW,
      lightningFlash: flashIntensity,
      fallSpeedMS: coordinator.observerPrecipFallSpeedMS,
      frozenFraction: coordinator.observerFrozenFraction,
      gustFactor: coordinator.observerGustFactor,
      // Drops are shaded as water: they need the same dominant light the rest of the scene
      // uses, so the glint goes warm at sunset and cold under the moon.
      lightDir: this.precipLightDir,
      lightColor: this.precipLightColor,
      hazeColor: this.precipHazeColor,
      daylight: this.sunCycle.daylight,
      fovDeg: cam.fov,
      renderHeightPx: this.renderHeightPx,
    });

    // PASS 1: Render 3D Scene (Sky + Terrain + Grass + Bolts + TLEs + Rain Streaks) into sceneRT + depthTexture
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.mainScene, cam);

    // PASS 2: Ray-March 3D Volumetric Clouds & Rain Shafts into volCurrRT
    const vu = this.volCloudMat.uniforms;
    vu.uInvProj.value.copy(cam.projectionMatrixInverse);
    vu.uInvView.value.copy(cam.matrixWorld);
    vu.uCameraPos.value.copy(cam.position);
    vu.uSunDir.value.copy(this.sunDir);
    vu.uMoonDir.value.copy(this.sunCycle.moonDir);
    vu.uDaylight.value = daylight;
    vu.uTime.value = this.realTimeElapsed;
    vu.uWindOffset.value.copy(this.windOffset);
    // The precipitation curtains drift with the actual low/mid-level flow and fall at the
    // mass-weighted speed the microphysics reports, so the height field's shafts lean and
    // streak consistently with the near-field particles.
    const driftU = coordinator.sounding.windUAt(1800);
    const driftW = coordinator.sounding.windWAt(1800);
    this.precipDrift.x -= driftU * realDtSec * 4.5;
    this.precipDrift.z -= driftW * realDtSec * 4.5;
    vu.uPrecipDrift.value.copy(this.precipDrift);
    vu.uPrecipFallSpeed.value = Math.max(0.5, coordinator.observerPrecipFallSpeedMS ?? 7.0);
    vu.uFrozenShare.value = coordinator.observerFrozenFraction ?? 0;
    vu.uMaxSteps.value = perfMgr.settings.raymarchSteps;
    vu.uCloudDetail.value = coordinator.config.cloudDetailScale;
    vu.uTurbulence.value = coordinator.config.turbulenceIntensity;
    vu.uShadowsEnabled.value = perfMgr.settings.enableShadows ? 1.0 : 0.0;
    vu.uFrameJitter.value = (this.frameIndex % 16) * 0.61803398875;
    // Rotating sub-pixel offset: with reprojection enabled the low-res volume buffer is
    // supersampled over time, so four frames reconstruct detail none of them holds alone.
    // Disabled alongside TAA, where a jittered buffer with no history would just look soft.
    const temporalOn = settings.enableTemporalAccum;
    if (temporalOn) {
      const seq = (this.frameIndex % 16) + 1;
      vu.uSubPixelJitter.value.set(
        (halton(seq, 2) - 0.5) / this.volW,
        (halton(seq, 3) - 0.5) / this.volH
      );
    } else {
      vu.uSubPixelJitter.value.set(0, 0);
    }
    vu.uBoltLight0.value.copy(this.lightningRenderer.boltLights[0]);
    vu.uBoltLight1.value.copy(this.lightningRenderer.boltLights[1]);
    vu.uBoltLight2.value.copy(this.lightningRenderer.boltLights[2]);

    this.quadMesh.material = this.volCloudMat;
    this.renderer.setRenderTarget(this.volCurrRT);
    this.renderer.render(this.postScene, this.postCamera);

    // Dynamic auto-exposure: subtly compress gain during blinding return strokes, then recover smoothly
    const targetExp =
      perfMgr.settings.exposure / (1.0 + Math.min(0.42, flashIntensity * 0.22));
    this.autoExposureCurrent +=
      (targetExp - this.autoExposureCurrent) * Math.min(1.0, realDtSec * 14.0);

    // PASS 3: Composite Scene + Upsampled Temporal Volumetric Clouds + HDR Bloom to Screen
    // Reprojection needs this frame's and last frame's view-projection. The first frame after
    // any resize has no valid history, so it is seeded with the current matrix to keep the
    // motion vector at zero rather than smearing the sky across the screen for one frame.
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this.hasPrevViewProj) {
      this.prevViewProj.copy(this.viewProj);
      this.hasPrevViewProj = true;
    }

    const cu = this.compositeMat.uniforms;
    cu.uVolCloudTex.value = this.volCurrRT.texture;
    cu.uPrevVolTex.value = this.volPrevRT.texture;
    cu.uExposure.value = this.autoExposureCurrent;
    cu.uInvProj.value.copy(cam.projectionMatrixInverse);
    cu.uInvView.value.copy(cam.matrixWorld);
    cu.uPrevViewProj.value.copy(this.prevViewProj);
    cu.uCameraPos.value.copy(cam.position);
    cu.uJitter.value = this.frameIndex * 0.61803398875;
    // Intensity is a user-facing multiplier on the smear length, 0..3.5 (0-350%). At 1.0 the
    // gather spans the true frame-to-frame motion vector; beyond that it exaggerates it, which
    // is what a speed-ramp look needs.
    cu.uMotionBlur.value = settings.enableMotionBlur
      ? Math.max(0, Math.min(3.5, settings.motionBlurIntensity))
      : 0.0;
    // Reprojection is now genuinely motion-compensated, so history can carry much more weight
    // than the old same-UV resample could without ghosting. That is what lets the volume pass
    // run at a fraction of output resolution and still converge to the same image.
    // Only blend history that is actually this engine's previous volume. On the very first frame
    // (and the first frame after a resize or context restore) `volPrevRT` has never been written,
    // so sampling it returns the cleared/default texel value and mixing 58% of that into the
    // image produces a full-screen wash instead of cloud. The history chain is also reset by
    // `hasPrevViewProj`, which is exactly the same "no valid history" condition.
    cu.uTemporalBlend.value =
      temporalOn && flashIntensity < 0.2 && this.hasVolHistory ? 0.58 : 0.0;

    this.quadMesh.material = this.compositeMat;
    this.renderer.setRenderTarget(this.outputRT);
    this.renderer.render(this.postScene, this.postCamera);
    if (perfMgr.settings.enableBloom) {
      this.bloomPass.render(this.renderer, this.outputRT.texture);
      this.renderer.setRenderTarget(null);
    } else {
      this.copyMat.uniforms.uSrc.value = this.outputRT.texture;
      this.quadMesh.material = this.copyMat;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.postScene, this.postCamera);
    }

    this.prevViewProj.copy(this.viewProj);

    // Copy volCurrRT -> volPrevRT for next frame's temporal smoothing. The copy also marks the
    // history valid, which is what re-enables the temporal blend on the following frame.
    if (temporalOn) {
      this.copyMat.uniforms.uSrc.value = this.volCurrRT.texture;
      this.quadMesh.material = this.copyMat;
      this.renderer.setRenderTarget(this.volPrevRT);
      this.renderer.render(this.postScene, this.postCamera);
      this.renderer.setRenderTarget(null);
      this.hasVolHistory = true;
    }
  }

  public dispose(): void {
    this.detachContextListeners?.();
    this.detachContextListeners = null;
    this.cameraCtrl.detach();
    this.groundRenderer.dispose();
    this.lightningRenderer.dispose();
    this.precipRenderer.dispose();
    this.skyDomeMesh.geometry.dispose();
    this.skyDomeMat.dispose();
    this.quadMesh.geometry.dispose();
    this.volCloudMat.dispose();
    this.compositeMat.dispose();
    this.copyMat.dispose();
    this.volTexture3D.dispose();
    this.groundSatTexture.dispose();
    this.localWeatherTexture.dispose();
    this.rodRenderer.dispose();
    this.tornadoRenderer.dispose();
    this.sceneRT.dispose();
    this.outputRT.dispose();
    this.bloomPass.dispose();
    this.volCurrRT.dispose();
    this.volPrevRT.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
