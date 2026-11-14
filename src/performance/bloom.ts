import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uInput;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec3 color = texture2D(uInput, vUv).rgb;
    float brightness = max(max(color.r, color.g), color.b);
    float contribution = max(0.0, brightness - uThreshold) / max(brightness, 0.0001);
    gl_FragColor = vec4(color * contribution, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uInput;
  uniform vec2 uDirection;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 result = texture2D(uInput, vUv).rgb * 0.227027;
    result += texture2D(uInput, vUv + uDirection * uTexel * 1.384615).rgb * 0.316216;
    result += texture2D(uInput, vUv - uDirection * uTexel * 1.384615).rgb * 0.316216;
    result += texture2D(uInput, vUv + uDirection * uTexel * 3.230769).rgb * 0.070270;
    result += texture2D(uInput, vUv - uDirection * uTexel * 3.230769).rgb * 0.070270;
    gl_FragColor = vec4(result, 1.0);
  }
`;

const COMBINE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec3 scene = texture2D(uScene, vUv).rgb;
    vec3 bloom = texture2D(uBloom, vUv).rgb;
    gl_FragColor = vec4(scene + bloom * uStrength, 1.0);
  }
`;

/** Half-resolution bright-pass + separable Gaussian blur + additive composite. */
export class BloomPass {
  private brightRT: THREE.WebGLRenderTarget;
  private blurRT: THREE.WebGLRenderTarget;
  private bloomRT: THREE.WebGLRenderTarget;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private quad: THREE.Mesh;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private combineMat: THREE.ShaderMaterial;

  constructor(width: number, height: number) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.brightRT = this.target(width, height);
    this.blurRT = this.target(width, height);
    this.bloomRT = this.target(width, height);
    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT_FRAG,
      uniforms: { uInput: { value: null }, uThreshold: { value: 0.78 } },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG,
      uniforms: {
        uInput: { value: null }, uDirection: { value: new THREE.Vector2(1, 0) },
        uTexel: { value: new THREE.Vector2(1 / Math.max(1, width), 1 / Math.max(1, height)) },
      },
    });
    this.combineMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMBINE_FRAG,
      uniforms: { uScene: { value: null }, uBloom: { value: null }, uStrength: { value: 0.85 } },
    });
    this.quad = new THREE.Mesh(geometry, this.brightMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private target(width: number, height: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: false,
    });
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    for (const target of [this.brightRT, this.blurRT, this.bloomRT]) target.setSize(w, h);
    this.blurMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, input: THREE.Texture): void {
    const previousTarget = renderer.getRenderTarget();
    this.brightMat.uniforms.uInput.value = input;
    this.quad.material = this.brightMat;
    renderer.setRenderTarget(this.brightRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    this.blurMat.uniforms.uInput.value = this.brightRT.texture;
    this.blurMat.uniforms.uDirection.value.set(1, 0);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.blurRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    this.blurMat.uniforms.uInput.value = this.blurRT.texture;
    this.blurMat.uniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(this.bloomRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    this.combineMat.uniforms.uScene.value = input;
    this.combineMat.uniforms.uBloom.value = this.bloomRT.texture;
    this.quad.material = this.combineMat;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previousTarget);
  }

  dispose(): void {
    this.brightRT.dispose(); this.blurRT.dispose(); this.bloomRT.dispose();
    this.quad.geometry.dispose(); this.brightMat.dispose(); this.blurMat.dispose(); this.combineMat.dispose();
  }
}
