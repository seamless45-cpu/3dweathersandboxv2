import * as THREE from 'three';
import { AtmosphereSimulationCoordinator } from '../sim/atmosphereCoordinator';
import { AdaptivePerformanceManager } from '../sim/performanceManager';
import { DOMAIN_MAX_ALT, DOMAIN_SIZE } from '../sim/types';
import { ObserverCameraController } from './cameraController';
import { LightningAndTLERenderer } from './lightningAndTLERenderer';
import { BloomPass } from '../performance/bloom';
import { LightningCameraShake } from '../performance/cameraShake';
import { NearFieldPrecipitationRenderer } from './precipitationRenderer';
import { GroundEnvironmentRenderer } from './terrainRenderer';
import {
  COMPOSITE_POST_FRAG,
  FULLSCREEN_QUAD_VERT,
  SKY_DOME_FRAG,
  SKY_DOME_VERT,
  VOLUMETRIC_CLOUD_FRAG,
} from './volumetricSkyShader';

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

  private volTexture3D: THREE.Data3DTexture;

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
  private currentVolumetricScale = 0.68;
  private frameIndex = 0;
  private realTimeElapsed = 0;
  private windOffset = new THREE.Vector3();
  private sunDir = new THREE.Vector3();
  private autoExposureCurrent = 1.0;

  constructor(
    container: HTMLElement,
    coordinator: AtmosphereSimulationCoordinator,
    perfMgr: AdaptivePerformanceManager
  ) {
    this.width = Math.max(1, container.clientWidth);
    this.height = Math.max(1, container.clientHeight);
    this.dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 1.75);

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

    // Build 3D World Scene
    this.mainScene = new THREE.Scene();

    // 1. Sky Dome
    const skyGeom = new THREE.SphereGeometry(86000, 32, 20);
    this.skyDomeMat = new THREE.ShaderMaterial({
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.4, 0.55, -0.7).normalize() },
        uRainHaze: { value: 0 },
        uLightningFlash: { value: 0 },
      },
    });
    this.skyDomeMesh = new THREE.Mesh(skyGeom, this.skyDomeMat);
    this.skyDomeMesh.renderOrder = -10;
    this.skyDomeMesh.frustumCulled = false;
    this.mainScene.add(this.skyDomeMesh);

    // 2. Ground Terrain & Wind-Driven Grass
    this.groundRenderer = new GroundEnvironmentRenderer(this.volTexture3D);
    this.mainScene.add(this.groundRenderer.terrainMesh);
    this.mainScene.add(this.groundRenderer.grassMesh);

    // 3. 3D Tortuous Lightning Channels & Upper-Atmospheric TLEs
    this.lightningRenderer = new LightningAndTLERenderer();
    this.mainScene.add(this.lightningRenderer.tleGroup);
    this.mainScene.add(this.lightningRenderer.boltMesh);

    // 4. Near-Field Wind-Slanted Precipitation & Ground Splashes
    this.precipRenderer = new NearFieldPrecipitationRenderer();
    this.mainScene.add(this.precipRenderer.splashMesh);
    this.mainScene.add(this.precipRenderer.streakMesh);

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
        uTime: { value: 0 },
        uWindOffset: { value: new THREE.Vector3() },
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
        uTexelSize: { value: new THREE.Vector2(1 / 800, 1 / 600) },
        uExposure: { value: 1.0 },
        uTemporalBlend: { value: 0.42 },
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
    this.currentVolumetricScale = volScale;
    const pixelW = Math.max(2, Math.floor(this.width * this.dpr));
    const pixelH = Math.max(2, Math.floor(this.height * this.dpr));
    const volW = Math.max(2, Math.floor(pixelW * volScale));
    const volH = Math.max(2, Math.floor(pixelH * volScale));

    if (this.sceneRT) this.sceneRT.dispose();
    if (this.outputRT) this.outputRT.dispose();
    if (this.volCurrRT) this.volCurrRT.dispose();
    if (this.volPrevRT) this.volPrevRT.dispose();

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

    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };

    this.outputRT = new THREE.WebGLRenderTarget(pixelW, pixelH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.volCurrRT = new THREE.WebGLRenderTarget(volW, volH, rtOpts);
    this.volPrevRT = new THREE.WebGLRenderTarget(volW, volH, rtOpts);

    this.volCloudMat.uniforms.uDepthTex.value = this.sceneRT.depthTexture;
    this.compositeMat.uniforms.uSceneTex.value = this.sceneRT.texture;
    this.compositeMat.uniforms.uTexelSize.value.set(1.0 / volW, 1.0 / volH);
    if (this.bloomPass) this.bloomPass.setSize(pixelW, pixelH);
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

    // Update camera transform
    this.cameraCtrl.update(realDtSec);
    const cam = this.cameraCtrl.camera;
    if (perfMgr.settings.enableCameraShake) {
      const shake = this.cameraShake.update(realDtSec, coordinator.lightning.activeDischarges, cam.position);
      const shakeAngle = shake.length();
      if (shakeAngle > 0.000001) {
        cam.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(shake.clone().normalize(), shakeAngle));
      }
    } else {
      this.cameraShake.update(realDtSec, [], cam.position);
    }
    cam.updateMatrixWorld();

    // Keep sky dome centered on camera
    this.skyDomeMesh.position.copy(cam.position);

    // Upload updated 3D atmospheric volume buffer to GPU
    this.volTexture3D.needsUpdate = true;

    // Solar direction from configured elevation angle
    const elevRad = (coordinator.config.sunElevationDeg * Math.PI) / 180.0;
    const azimRad = -0.62; // Sun in West-Southwest casting dramatic side-lighting across convective towers!
    this.sunDir
      .set(
        Math.cos(elevRad) * Math.sin(azimRad),
        Math.sin(elevRad),
        Math.cos(elevRad) * Math.cos(azimRad)
      )
      .normalize();

    // Advect sub-voxel procedural cloud turbulence smoothly with ambient mid-level wind
    const midWind = coordinator.sounding.sampleAtAltitude(3500);
    this.windOffset.x -= midWind.windU * realDtSec * 4.5;
    this.windOffset.z -= midWind.windW * realDtSec * 4.5;
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
    this.skyDomeMat.uniforms.uRainHaze.value = rainHaze;
    this.skyDomeMat.uniforms.uLightningFlash.value = Math.min(1.2, flashIntensity * 0.45);

    // Update Terrain & Wind-Driven Grass
    this.groundRenderer.update({
      timeSec: this.realTimeElapsed,
      sunDir: this.sunDir,
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

    // Update Near-Field Precipitation & Splashes
    this.precipRenderer.update({
      realTimeSec: this.realTimeElapsed,
      cameraPos: cam.position,
      rainRateMMHr: coordinator.observerRainMMHr,
      precipType: coordinator.observerPrecipType,
      windU: coordinator.observerWindU,
      windW: coordinator.observerWindW,
      lightningFlash: flashIntensity,
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
    vu.uTime.value = this.realTimeElapsed;
    vu.uWindOffset.value.copy(this.windOffset);
    vu.uMaxSteps.value = perfMgr.settings.raymarchSteps;
    vu.uCloudDetail.value = coordinator.config.cloudDetailScale;
    vu.uTurbulence.value = coordinator.config.turbulenceIntensity;
    vu.uShadowsEnabled.value = perfMgr.settings.enableShadows ? 1.0 : 0.0;
    vu.uFrameJitter.value = (this.frameIndex % 16) * 0.61803398875;
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
    this.compositeMat.uniforms.uVolCloudTex.value = this.volCurrRT.texture;
    this.compositeMat.uniforms.uPrevVolTex.value = this.volPrevRT.texture;
    this.compositeMat.uniforms.uExposure.value = this.autoExposureCurrent;
    this.compositeMat.uniforms.uTemporalBlend.value =
      perfMgr.settings.enableTemporalAccum && flashIntensity < 0.2 ? 0.38 : 0.0;

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

    // Copy volCurrRT -> volPrevRT for next frame's temporal smoothing
    if (perfMgr.settings.enableTemporalAccum) {
      this.copyMat.uniforms.uSrc.value = this.volCurrRT.texture;
      this.quadMesh.material = this.copyMat;
      this.renderer.setRenderTarget(this.volPrevRT);
      this.renderer.render(this.postScene, this.postCamera);
      this.renderer.setRenderTarget(null);
    }
  }

  public dispose(): void {
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
