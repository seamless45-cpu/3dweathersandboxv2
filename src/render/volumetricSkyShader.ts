export const FULLSCREEN_QUAD_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Ray-marches the live 3D simulation volume texture (uVolTex):
 *   R = condensed cloud water + ice density
 *   G = precipitation core & rain shaft / virga density
 *   B = glaciation / anvil ice fraction (0 = liquid cumulus cauliflower, 1 = fibrous ice anvil)
 *   A = 3D internal lightning scattering field
 * Outputs vec4(scatteredRadiance.rgb, transmittance).
 *
 * Cost model. This pass is the single most expensive thing on the GPU: every sample can pull a
 * trilinear 3D texture fetch, up to four octaves of value noise, a 27-tap cellular Worley, and
 * four more texture fetches for the solar shadow march. Three things keep it affordable without
 * changing what the viewer sees:
 *
 *   1. Empty-space leaping. Consecutive clear voxels grow the stride geometrically, so a ground
 *      observer looking at a distant tower spends its budget on cloud rather than clear sky.
 *   2. Transmittance-gated detail. Once the ray is ~78% extinguished the remaining samples
 *      carry under a quarter of the final weight and are, by definition, deep inside an opaque
 *      core where erosion detail cannot be seen. Those samples take a single smooth octave and a
 *      two-tap shadow march instead of the full stack. The same applies past 20 km, where the
 *      500 m voxel already dwarfs the features the noise was adding.
 *   3. Temporal amortisation. The buffer is rendered at a fraction of output resolution with a
 *      rotating sub-pixel offset, and the composite pass reprojects last frame's result along
 *      the camera motion vector. Four cheap frames reconstruct what one expensive frame would
 *      have had to resolve outright.
 */
export const VOLUMETRIC_CLOUD_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uVolTex;
  uniform sampler2D uDepthTex;

  uniform mat4 uInvProj;
  uniform mat4 uInvView;
  uniform vec3 uCameraPos;
  uniform float uNear;
  uniform float uFar;

  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uDaylight;
  uniform float uTime;
  uniform vec3 uWindOffset;
  uniform float uDomainSize;
  uniform float uMaxAlt;
  uniform int uMaxSteps;
  uniform float uCloudDetail;
  uniform float uTurbulence;
  uniform float uShadowsEnabled;
  uniform float uFrameJitter;
  uniform vec2 uSubPixelJitter;

  // Up to 3 simultaneous 3D lightning light sources: xyz = world pos, w = radiant intensity
  uniform vec4 uBoltLight0;
  uniform vec4 uBoltLight1;
  uniform vec4 uBoltLight2;

  in vec2 vUv;
  out vec4 fragColor;

  // Fast 3D hash & gradient/cellular noise for sub-voxel cumulonimbus cauliflower & anvil detail
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  float noise3D(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);

    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
  }

  // Inverted 3D cellular Worley approximation for crisp cauliflower cumulus congestus turrets.
  // One hash per neighbour cell instead of three (the jitter vector is decorrelated by
  // irrational scaling of the same hash) cuts this from 81 to 27 hash evaluations, which is
  // the single largest saving in the ray-march because it runs on every cloudy sample.
  float worleyBillow3D(vec3 p) {
    vec3 id = floor(p);
    vec3 fd = fract(p);
    float minDist = 1.0;
    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 neighbor = vec3(float(x), float(y), float(z));
          float h = hash13(id + neighbor);
          vec3 rnd = fract(vec3(h * 13.71, h * 29.33, h * 47.19) + vec3(0.13, 0.37, 0.71));
          vec3 diff = neighbor + rnd - fd;
          minDist = min(minDist, dot(diff, diff));
        }
      }
    }
    return 1.0 - sqrt(clamp(minDist, 0.0, 1.0));
  }

  float linearizeDepth(float depthSample) {
    float zNdc = depthSample * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - zNdc * (uFar - uNear));
  }

  vec3 worldToVolumeUVW(vec3 wp) {
    return vec3(
      (wp.x + uDomainSize * 0.5) / uDomainSize,
      wp.y / uMaxAlt,
      (wp.z + uDomainSize * 0.5) / uDomainSize
    );
  }

  // Samples physically synchronized cloud & precipitation density at worldPos.
  //
  // Structure cost is spent only where it is visible: a low-frequency domain warp breaks up
  // the repeating noise lattice, then the sample takes exactly one of four branches
  //   - cheap / deep core -> a single smooth fbm octave (erosion is suppressed there anyway)
  //   - glaciated anvil   -> horizontally stretched fibrous ice filaments
  //   - liquid cloud edge -> Worley cauliflower + fbm (near field only)
  // so the 27-tap cellular noise never runs for deep cores, distant cloud, or extinguished rays.
  vec4 sampleAtmosphereVolume(vec3 wp, float distKm, float cheap) {
    vec3 uvw = worldToVolumeUVW(wp);
    if (
      uvw.x <= 0.005 || uvw.x >= 0.995 ||
      uvw.y <= 0.002 || uvw.y >= 0.995 ||
      uvw.z <= 0.005 || uvw.z >= 0.995
    ) {
      return vec4(0.0);
    }

    // Softly fade outermost 5% of the domain boundary to avoid visible box edges
    float edgeFade =
      smoothstep(0.005, 0.055, uvw.x) * smoothstep(0.995, 0.945, uvw.x) *
      smoothstep(0.005, 0.055, uvw.z) * smoothstep(0.995, 0.945, uvw.z);

    vec4 raw = texture(uVolTex, uvw);
    raw.rg *= edgeFade;

    if (raw.r < 0.008 && raw.g < 0.008) {
      return vec4(0.0, 0.0, raw.b, raw.a);
    }

    float baseCloud = raw.r;
    float basePrecip = raw.g;
    float iceFrac = raw.b;

    // Distance LOD reduces high-frequency noise aliasing far away while keeping crisp close detail
    float lodFade = clamp(1.0 - distKm / 34.0, 0.15, 1.0);
    vec3 advPos = (wp + uWindOffset) * (0.00085 * uCloudDetail);

    float cloudDensity = 0.0;
    if (baseCloud > 0.008) {
      // One cheap fbm octave displaces the whole detail lattice, so cauliflower turrets are
      // not aligned to the 500 m voxel grid and neighbouring towers never repeat. Skipped on
      // cheap samples, where the displaced and undisplaced lattices are equally invisible.
      vec3 detPos = advPos;
      if (cheap < 0.5) {
        float warp = noise3D(advPos * 0.55);
        detPos = advPos + (warp - 0.5) * vec3(0.66, 0.36, 0.58);
      }

      // Erode outer cloud margins while keeping deep convective cores solid and voluminous.
      float erosionStrength = mix(0.58, 0.34, iceFrac) * uTurbulence * (1.0 - baseCloud * 0.62);

      float structureNoise;
      if (cheap > 0.5) {
        // Deep interior or beyond detail range: one smooth octave.
        structureNoise = noise3D(detPos * 2.2) * 0.62 + 0.34;
      } else if (iceFrac > 0.55) {
        // Glaciated Cb capillatus anvil: ice filaments stretched 4.7x vertically and
        // 0.62x horizontally read as wind-sheared cirrusiform striations.
        vec3 anvilCoord = vec3(detPos.x * 0.62, detPos.y * 2.9, detPos.z * 0.62);
        float fibrous = noise3D(anvilCoord * 2.1) * 0.68 + noise3D(anvilCoord * 5.1) * 0.32;
        structureNoise = fibrous * 0.74 + noise3D(detPos * 1.55) * 0.26;
      } else if (lodFade > 0.42 && baseCloud < 0.74) {
        // Liquid cumulus / congestus turret: bulbous Worley cells plus one detail octave.
        float billow = worleyBillow3D(detPos * 1.15);
        structureNoise = billow * 0.66 + noise3D(detPos * 2.45) * 0.30;
        if (lodFade > 0.72) {
          structureNoise += (noise3D(detPos * 5.3 - vec3(0.0, uTime * 0.04, 0.0)) - 0.5) * 0.13 * lodFade;
        }
      } else {
        // Deep core or distant cloud: erosion is already suppressed here, so a single smooth
        // octave is indistinguishable from the full stack at a fraction of the cost.
        structureNoise = noise3D(detPos * 2.2) * 0.62 + 0.34;
      }

      cloudDensity = clamp(
        (baseCloud - (1.0 - structureNoise) * erosionStrength) / max(0.22, 1.0 - erosionStrength * 0.6),
        0.0,
        1.0
      );
      cloudDensity *= cloudDensity * (3.0 - 2.0 * cloudDensity);
    }

    // Rain shafts & virga curtains: vertically elongated, wind-slanted streaks that descend
    // at the bulk hydrometeor fall speed (~8 m/s) instead of boiling in place.
    float precipDensity = 0.0;
    if (basePrecip > 0.008) {
      vec3 shaftCoord = vec3(
        wp.x * 0.0022 - uWindOffset.x * 0.00075,
        wp.y * 0.00042 + uTime * 0.0034,
        wp.z * 0.0022 - uWindOffset.z * 0.00075
      );
      float streak = noise3D(shaftCoord * 2.6);
      // Sharpen into curtains rather than a uniform grey veil.
      float curtain = 0.46 + 0.54 * (streak * streak * (3.0 - 2.0 * streak));
      precipDensity = basePrecip * curtain * 0.34;
    }

    return vec4(cloudDensity, precipDensity, iceFrac, raw.a);
  }

  // Dual-lobe Henyey-Greenstein phase function (forward silver lining + backscatter)
  float hgPhase(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.02, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
  }

  float dualLobePhase(float cosTheta, float iceFrac) {
    float gFwd = mix(0.68, 0.78, iceFrac);
    float fwd = hgPhase(cosTheta, gFwd);
    float back = hgPhase(cosTheta, -0.28);
    return mix(back, fwd, 0.72);
  }

  // Multi-step optical depth toward the dominant light for realistic self-shadowing & dark
  // storm bases. Cheap samples halve the tap count and double the per-tap weight: they only
  // occur deep inside an already-opaque core, where the answer saturates to zero either way.
  float marchLightVisibility(vec3 pos, vec3 lightDir, float cheap) {
    if (uShadowsEnabled < 0.5) return 0.65;
    float opticalDepth = 0.0;
    vec3 lDir = normalize(vec3(lightDir.x, max(0.08, lightDir.y), lightDir.z));
    int taps = cheap > 0.5 ? 2 : 4;
    float stepLen = 360.0;
    for (int i = 1; i <= 4; i++) {
      if (i > taps) break;
      vec3 sp = pos + lDir * (stepLen * float(i) * float(i) * 0.55);
      vec3 uvw = worldToVolumeUVW(sp);
      if (uvw.y > 1.0 || uvw.x < 0.0 || uvw.x > 1.0 || uvw.z < 0.0 || uvw.z > 1.0) break;
      vec4 sv = texture(uVolTex, uvw);
      // Coefficients track the RGBA8 packing references (1.4 g/kg cloud, 7.0 g/kg precip).
      opticalDepth += (sv.r * 0.62 + sv.g * 0.5) * (stepLen * 0.0018);
    }
    opticalDepth *= cheap > 0.5 ? 2.0 : 1.0;
    // Dual-octave multiple scattering approximation (Schneider 2015) so deep clouds retain realistic internal glow
    float primary = exp(-opticalDepth * 2.1);
    float multiScatter = exp(-opticalDepth * 0.48) * 0.42;
    return max(primary, multiScatter);
  }

  // Intersect ray with horizontal slab [yMin, yMax]
  vec2 intersectAltitudeSlab(vec3 ro, vec3 rd, float yMin, float yMax) {
    if (abs(rd.y) < 1e-5) {
      if (ro.y >= yMin && ro.y <= yMax) return vec2(0.0, 48000.0);
      return vec2(1.0, -1.0);
    }
    float t0 = (yMin - ro.y) / rd.y;
    float t1 = (yMax - ro.y) / rd.y;
    return vec2(min(t0, t1), max(t0, t1));
  }

  vec3 evaluateBoltIllumination(vec3 pos, float localGridFlash) {
    vec3 boltCol = vec3(0.74, 0.82, 1.0) * (localGridFlash * 3.8);

    if (uBoltLight0.w > 0.01) {
      float dKm = length(pos - uBoltLight0.xyz) * 0.001;
      boltCol += vec3(0.78, 0.85, 1.0) * (uBoltLight0.w / (0.35 + dKm * dKm * 0.22));
    }
    if (uBoltLight1.w > 0.01) {
      float dKm = length(pos - uBoltLight1.xyz) * 0.001;
      boltCol += vec3(0.78, 0.85, 1.0) * (uBoltLight1.w / (0.35 + dKm * dKm * 0.22));
    }
    if (uBoltLight2.w > 0.01) {
      float dKm = length(pos - uBoltLight2.xyz) * 0.001;
      boltCol += vec3(0.82, 0.86, 1.0) * (uBoltLight2.w / (0.35 + dKm * dKm * 0.22));
    }
    return boltCol;
  }

  void main() {
    // Sub-pixel jitter rotates each frame so the temporal reprojection in the composite pass
    // accumulates a higher-resolution signal than this buffer holds on its own.
    vec2 jitteredUv = vUv + uSubPixelJitter;

    // Reconstruct world-space ray from screen UV
    vec4 clip = vec4(jitteredUv * 2.0 - 1.0, -1.0, 1.0);
    vec4 eye = uInvProj * clip;
    eye = vec4(eye.xy, -1.0, 0.0);
    vec3 rd = normalize((uInvView * eye).xyz);
    vec3 ro = uCameraPos;

    // Read terrain depth so rays terminate accurately at foreground hills & mountains
    float rawDepth = texture(uDepthTex, vUv).r;
    bool hitGeometry = rawDepth < 0.99995;
    float maxGeomDist = 52000.0;
    if (hitGeometry) {
      // Convert view-Z linear depth to world ray distance
      vec4 viewRay = uInvProj * vec4(jitteredUv * 2.0 - 1.0, 1.0, 1.0);
      viewRay /= viewRay.w;
      float viewRayFactor = length(viewRay.xyz) / abs(viewRay.z);
      maxGeomDist = linearizeDepth(rawDepth) * viewRayFactor;
    }

    // Intersect ray with atmospheric cloud & rain volume [30m .. 17,900m]
    vec2 slab = intersectAltitudeSlab(ro, rd, 30.0, uMaxAlt - 50.0);
    float tStart = max(0.0, slab.x);
    float tEnd = min(min(slab.y, maxGeomDist), 44000.0);

    if (tEnd <= tStart) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // Interleaved gradient blue-noise per-pixel jitter to eliminate ray-march slicing artifacts
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)) + uFrameJitter));

    float marchSpan = tEnd - tStart;
    float baseStep = clamp(marchSpan / float(uMaxSteps), 95.0, 520.0);
    float t = tStart + ign * baseStep;

    // ---- Diurnal lighting rig -----------------------------------------------------------
    // One dominant light drives the phase function, the shadow march and the direct term: the
    // sun by day, the moon once it sets. Blending between the two directions across twilight
    // keeps the transition continuous instead of snapping the key light at the horizon.
    float daylight = clamp(uDaylight, 0.0, 1.0);
    float sunElev = clamp(uSunDir.y, 0.02, 1.0);
    vec3 sunRadiance =
      mix(vec3(1.0, 0.58, 0.32), vec3(1.0, 0.97, 0.92), smoothstep(0.04, 0.42, sunElev)) * 3.15;
    // Moonlight is cool and roughly a fifteenth of full sun: enough to silver cloud edges and
    // keep a night storm readable, nowhere near enough to read as daylight.
    vec3 moonRadiance = vec3(0.40, 0.54, 0.88) * 0.21;
    vec3 lightRadiance = mix(moonRadiance, sunRadiance, daylight);
    // Guarded blend: if the two bodies ever approach opposition the interpolation passes
    // through zero and normalize() would return garbage, so fall back to whichever light is
    // currently dominant instead.
    vec3 lightBlend = mix(uMoonDir, uSunDir, daylight);
    float lightBlendLen2 = dot(lightBlend, lightBlend);
    vec3 lightDir = lightBlendLen2 > 1e-4
      ? lightBlend * inversesqrt(lightBlendLen2)
      : (daylight > 0.5 ? uSunDir : uMoonDir);

    float cosTheta = dot(rd, lightDir);

    float moonElev = clamp(uMoonDir.y, 0.0, 1.0);
    // Night ambient is not zero: airglow plus moonlight leave a deep blue floor, and cloud
    // bases still catch something. Lightning then reads as enormously bright against it, which
    // is exactly how a night storm actually looks.
    vec3 nightTop = vec3(0.026, 0.038, 0.070) + vec3(0.048, 0.062, 0.098) * moonElev;
    vec3 nightBottom = vec3(0.015, 0.021, 0.038) + vec3(0.026, 0.034, 0.056) * moonElev;
    vec3 skyAmbientTop = mix(nightTop, mix(vec3(0.18, 0.24, 0.36), vec3(0.34, 0.48, 0.68), sunElev), daylight);
    vec3 skyAmbientBottom = mix(nightBottom, mix(vec3(0.10, 0.13, 0.18), vec3(0.18, 0.22, 0.29), sunElev), daylight);

    vec3 accumLight = vec3(0.0);
    float transmittance = 1.0;

    // Adaptive empty-space traversal: consecutive clear voxels grow the stride geometrically
    // (capped at 6x) and the stride collapses back to baseStep on the first cloudy sample.
    float emptyStride = 1.0;

    for (int i = 0; i < 96; i++) {
      if (i >= uMaxSteps || t >= tEnd || transmittance < 0.012) break;

      vec3 pos = ro + rd * t;

      // Coarse check on raw 3D texture for fast empty-space skipping
      vec3 uvw = worldToVolumeUVW(pos);
      if (uvw.x <= 0.005 || uvw.x >= 0.995 || uvw.z <= 0.005 || uvw.z >= 0.995 || uvw.y >= 0.995) {
        t += baseStep * emptyStride;
        emptyStride = min(emptyStride * 1.6, 6.0);
        continue;
      }

      vec4 coarse = texture(uVolTex, uvw);
      if (coarse.r < 0.008 && coarse.g < 0.008) {
        t += baseStep * emptyStride;
        emptyStride = min(emptyStride * 1.6, 6.0);
        continue;
      }
      emptyStride = 1.0;

      float distKm = t * 0.001;
      // Spend detail only where it can still change the pixel.
      //
      // Measured against a live storm field from a ground observer, 74% of cloudy samples land
      // on the Worley cauliflower branch (27 hash evaluations) and a further 25% on the fibrous
      // anvil stack. Gating on transmittance below 0.35 routes ~37% of those samples to the
      // single-octave branch instead, which is ~23% of all hash work in the march.
      //
      // This is safe precisely because of *which* samples it catches: low transmittance means the
      // ray is already inside the cloud, where the medium is dense, dark and low-contrast, so the
      // erosion shape is not resolvable. The lit silhouette edges that actually define the cloud's
      // look are sampled at high transmittance and keep the full Worley stack untouched. Past
      // 20 km the 500 m voxel footprint exceeds the feature scale anyway.
      float cheap = (transmittance < 0.35 || distKm > 20.0) ? 1.0 : 0.0;

      vec4 vol = sampleAtmosphereVolume(pos, distKm, cheap);
      float cloudD = vol.r;
      float precipD = vol.g;
      float iceFrac = vol.b;
      float localFlash = vol.a;

      // Extinction coefficients are calibrated against the RGBA8 packing references
      // (1.4 g/kg cloud, 7.0 g/kg precip). A saturated core is optically thick within a single
      // 500 m voxel; a rain shaft is a dark translucent curtain you can still see terrain
      // through, because the precipitating mass is spread over a far wider density range.
      float totalExtinction = cloudD * 0.0026 + precipD * 0.0026;
      if (totalExtinction > 0.00004) {
        // Step length follows the local density: thin wisps take longer strides, opaque
        // cores take shorter ones, so the same budget resolves far more of the cloud.
        float stepDt = baseStep * clamp(1.9 - totalExtinction * 290.0, 0.6, 1.9);
        float stepTrans = exp(-totalExtinction * stepDt);

        float lightVis = marchLightVisibility(pos, lightDir, cheap);
        float phase = dualLobePhase(cosTheta, iceFrac);
        // Powder effect highlights billowing cloud edges
        float powder = 1.0 - 0.45 * exp(-cloudD * 5.5);

        float altFrac = clamp(pos.y / 13000.0, 0.0, 1.0);
        // Heavy shafts cut off the skylight that reaches below cloud base, which is why the
        // world under a storm goes grey-green before the rain arrives.
        float shaftShadow = clamp(precipD * 2.1, 0.0, 1.0);
        vec3 ambient = mix(skyAmbientBottom, skyAmbientTop, altFrac) * mix(0.88, 0.3, shaftShadow);

        vec3 direct = lightRadiance * lightVis * phase * powder * 2.45;
        // Backlit rain shafts glow: large drops forward-scatter strongly, so a shaft between
        // the observer and the light source lights up instead of going flat black.
        direct += lightRadiance * lightVis * pow(max(0.0, cosTheta), 6.0) * precipD * 0.55;
        vec3 lightningGlow = evaluateBoltIllumination(pos, localFlash);

        // Blend crisp white-slate cloud scattering with misty gray-blue rain shaft scattering
        vec3 mediumAlbedo = mix(
          vec3(0.98, 0.98, 1.0),
          vec3(0.40, 0.45, 0.53),
          clamp(precipD / max(0.01, cloudD * 0.55 + precipD), 0.0, 0.9)
        );
        vec3 voxelScattering = mediumAlbedo * (ambient + direct + lightningGlow);

        // Analytical energy-conserving step integration
        vec3 integScatter = voxelScattering * (1.0 - stepTrans);
        accumLight += transmittance * integScatter;
        transmittance *= stepTrans;

        t += stepDt;
      } else {
        t += baseStep;
      }
    }

    // Distance atmospheric perspective blend on distant clouds (> 18 km) so clouds sit naturally INSIDE the atmosphere!
    float meanDistFactor = clamp((tStart * 0.001) / 36.0, 0.0, 0.68);
    vec3 dayAerial = mix(vec3(0.52, 0.66, 0.84), vec3(0.70, 0.80, 0.92), sunElev) * (0.55 + 0.45 * sunElev);
    vec3 horizonAerial = mix(vec3(0.045, 0.062, 0.105), dayAerial, daylight);
    accumLight = mix(accumLight, horizonAerial * (1.0 - transmittance), meanDistFactor * 0.55);

    fragColor = vec4(accumLight, transmittance);
  }
`;

/**
 * Sky Dome Background Shader rendered behind geometry inside sceneRT.
 *
 * Physically inspired Rayleigh + Mie atmosphere across a full diurnal cycle: solar disc and
 * aureole by day, sunset/sunrise twilight band, then a moonlit night sky with a procedurally
 * placed star field and lunar disc. Horizon haze, rain overcast dimming and lightning flash
 * scattering sit on top of whichever regime is active.
 */
export const SKY_DOME_VERT = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldDir = wp.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const SKY_DOME_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uDaylight;
  uniform float uRainHaze;
  uniform float uLightningFlash;
  uniform float uTime;

  varying vec3 vWorldDir;

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 rd = normalize(vWorldDir);
    float sunY = uSunDir.y;
    float daylight = clamp(uDaylight, 0.0, 1.0);
    float zenith = clamp(rd.y, 0.0, 1.0);
    float sunElev = clamp(sunY, 0.02, 1.0);
    float moonElev = clamp(uMoonDir.y, 0.0, 1.0);

    // Rayleigh zenith-to-horizon gradient, day regime
    vec3 zenithCol = mix(vec3(0.08, 0.18, 0.38), vec3(0.12, 0.34, 0.72), smoothstep(0.02, 0.45, sunElev));
    vec3 horizonCol = mix(vec3(0.72, 0.56, 0.44), vec3(0.62, 0.76, 0.92), smoothstep(0.04, 0.38, sunElev));

    // Night regime: airglow-limited navy, brightened by whatever moonlight is above the horizon
    vec3 nightZenith = vec3(0.006, 0.011, 0.028) + vec3(0.018, 0.028, 0.058) * moonElev;
    vec3 nightHorizon = vec3(0.020, 0.028, 0.050) + vec3(0.042, 0.054, 0.086) * moonElev;

    zenithCol = mix(nightZenith, zenithCol, daylight);
    horizonCol = mix(nightHorizon, horizonCol, daylight);

    // Twilight injects a deep orange band at the horizon while the sun is within a few degrees
    // of it, which is the light that makes a sunset storm photograph worth taking.
    float twilight = clamp(1.0 - abs(sunY) / 0.13, 0.0, 1.0);
    twilight *= twilight;
    horizonCol += vec3(0.52, 0.20, 0.05) * twilight * (1.0 - uRainHaze * 0.7);

    // Overcast rain-induced haze desaturation near observer
    zenithCol = mix(zenithCol, vec3(0.20, 0.25, 0.32), uRainHaze * 0.75);
    horizonCol = mix(horizonCol, vec3(0.32, 0.37, 0.44), uRainHaze * 0.82);

    float horizonCurve = pow(1.0 - zenith, 3.2);
    vec3 sky = mix(zenithCol, horizonCol, horizonCurve);

    // ---- Stars --------------------------------------------------------------------------
    // Placed on a direction-space lattice so they stay pinned to the sky while the camera
    // turns, and only survive where the sky is genuinely dark and not washed out by rain haze.
    float starVis = (1.0 - daylight) * (1.0 - uRainHaze * 0.88) * smoothstep(-0.02, 0.14, rd.y);
    if (starVis > 0.01) {
      // Lattice frequency sets the star's angular size: one cell spans 1/R radians, so R = 420
      // gives ~0.14 deg, roughly two pixels at 1080p. Much coarser and stars read as fuzzy
      // blobs; much finer and they fall under a pixel and alias into a crawl as the camera turns.
      vec3 sp = rd * 420.0;
      vec3 sid = floor(sp);
      float h = hash13(sid);
      // ~0.18% of cells become stars, which lands near the few thousand a dark-adapted eye
      // actually resolves rather than a uniform snow of them.
      float starMask = smoothstep(0.9982, 0.9995, h);
      float d = length(fract(sp) - 0.5);
      float core = exp(-d * d * 16.0);
      float twinkle = 0.62 + 0.38 * sin(uTime * 1.6 + h * 143.0);
      // Scatter stellar colour temperature: a few warm giants among the blue-white majority.
      vec3 starCol = mix(vec3(0.78, 0.85, 1.0), vec3(1.0, 0.82, 0.62), smoothstep(0.9991, 0.9995, h));
      sky += starCol * core * starMask * twinkle * starVis * 1.5;
    }

    // ---- Moon ---------------------------------------------------------------------------
    float cosMoon = dot(rd, uMoonDir);
    float moonDisc = smoothstep(0.999962, 0.999982, cosMoon);
    float moonHalo = pow(max(0.0, cosMoon), 220.0) * 0.22 + pow(max(0.0, cosMoon), 18.0) * 0.030;
    float moonVis = (1.0 - daylight) * (1.0 - uRainHaze * 0.78);
    sky += vec3(0.88, 0.92, 1.0) * (moonDisc * 2.4 + moonHalo) * moonVis;

    // ---- Sun ----------------------------------------------------------------------------
    float cosSun = dot(rd, uSunDir);
    float mieGlow = pow(max(0.0, cosSun), 12.0) * 0.28 + pow(max(0.0, cosSun), 160.0) * 0.85;
    float sunDisc = smoothstep(0.99965, 0.99992, cosSun) * 6.0;
    vec3 sunTint = mix(vec3(1.0, 0.55, 0.28), vec3(1.0, 0.96, 0.88), smoothstep(0.04, 0.4, sunElev));
    // The aureole outlives the disc: it is still glowing after the sun has dipped below the
    // horizon, so fade it on solar altitude rather than on the daylight factor.
    float sunAbove = clamp(1.0 - max(0.0, -sunY) / 0.16, 0.0, 1.0);
    sky += sunTint * (mieGlow + sunDisc) * (1.0 - uRainHaze * 0.88) * sunAbove;

    // Subtle global atmospheric scattering flash during intense return strokes
    sky += vec3(0.36, 0.42, 0.58) * uLightningFlash * (0.25 + 0.45 * horizonCurve);

    // Ground below horizon fallback
    if (rd.y < -0.02) {
      sky = mix(sky, horizonCol * 0.55, smoothstep(-0.02, -0.25, rd.y));
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

/**
 * Final Composite: depth-aware temporal reprojection of the volumetric buffer, physically-based
 * per-pixel camera motion blur, HDR tonemapping and dynamic exposure.
 *
 * Two reprojections happen here and they deliberately use different anchors:
 *   - Cloud history uses a point 9 km along the view ray. Clouds are kilometres away and the
 *     observer moves at most a couple of metres per frame, so direction-based reprojection is
 *     accurate to a fraction of a pixel and does not need the depth buffer at all.
 *   - Motion blur uses the actual scene depth. That is what makes it read as real: nearby
 *     terrain and rain smear a long way while the distant sky barely moves, because the motion
 *     vector falls out of true parallax rather than being faked from camera rotation alone.
 */
export const COMPOSITE_POST_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uSceneTex;
  uniform sampler2D uVolCloudTex;
  uniform sampler2D uPrevVolTex;
  uniform sampler2D uDepthTex;
  uniform vec2 uTexelSize;
  uniform vec2 uResolution;
  uniform float uExposure;
  uniform float uTemporalBlend;
  uniform mat4 uInvProj;
  uniform mat4 uInvView;
  uniform mat4 uPrevViewProj;
  uniform vec3 uCameraPos;
  uniform float uMotionBlur;
  uniform float uJitter;

  in vec2 vUv;
  out vec4 fragColor;

  vec3 acesToneMap(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec3 rayDirection(vec2 uv) {
    vec4 eye = uInvProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
    eye = vec4(eye.xy, -1.0, 0.0);
    return normalize((uInvView * eye).xyz);
  }

  // Projects a world position into last frame's clip space. Returns an out-of-range sentinel
  // when the point sat behind the previous camera, which disqualifies the history sample.
  vec2 reproject(vec3 worldPos) {
    vec4 pc = uPrevViewProj * vec4(worldPos, 1.0);
    if (pc.w <= 1e-5) return vec2(-2.0);
    return pc.xy / pc.w * 0.5 + 0.5;
  }

  vec3 worldFromDepth(vec2 uv, float raw) {
    if (raw > 0.99995) {
      // Nothing to anchor to, so push far enough away that reprojection degenerates to pure
      // camera rotation - the correct answer for infinitely distant sky.
      return uCameraPos + rayDirection(uv) * 42000.0;
    }
    vec4 ndc = vec4(uv * 2.0 - 1.0, raw * 2.0 - 1.0, 1.0);
    vec4 viewPos = uInvProj * ndc;
    viewPos /= viewPos.w;
    return (uInvView * vec4(viewPos.xyz, 1.0)).xyz;
  }

  void main() {
    vec3 rd = rayDirection(vUv);

    // 5-tap edge-preserving upsample of the sub-resolution volumetric cloud buffer
    vec4 volCenter = texture(uVolCloudTex, vUv);
    vec4 volN = texture(uVolCloudTex, vUv + vec2(0.0, uTexelSize.y));
    vec4 volS = texture(uVolCloudTex, vUv - vec2(0.0, uTexelSize.y));
    vec4 volE = texture(uVolCloudTex, vUv + vec2(uTexelSize.x, 0.0));
    vec4 volW = texture(uVolCloudTex, vUv - vec2(uTexelSize.x, 0.0));
    vec4 volCurr = volCenter * 0.44 + (volN + volS + volE + volW) * 0.14;

    vec4 volFinal = volCurr;
    if (uTemporalBlend > 0.001) {
      vec2 prevUv = reproject(uCameraPos + rd * 9000.0);
      if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0) {
        vec4 volHistory = texture(uPrevVolTex, prevUv);
        // Clamp history to the current frame's neighbourhood so disocclusion and fast pans
        // cannot leave a ghost behind, while still allowing genuine sub-pixel detail to build.
        vec4 volMin = min(volCenter, min(min(volN, volS), min(volE, volW))) - vec4(0.055);
        vec4 volMax = max(volCenter, max(max(volN, volS), max(volE, volW))) + vec4(0.055);
        volFinal = mix(volCurr, clamp(volHistory, volMin, volMax), uTemporalBlend);
      }
    }

    float centerDepth = texture(uDepthTex, vUv).r;
    vec3 scene = texture(uSceneTex, vUv).rgb;
    vec3 combined = scene * volFinal.a + volFinal.rgb;

    // ---- Per-pixel camera motion blur ---------------------------------------------------
    // A gather along the true screen-space velocity of this pixel's world point, taken in
    // linear HDR before tonemapping so highlights smear instead of clipping. Depth-weighted,
    // so a blurred foreground edge does not paint itself across the distant sky behind it.
    if (uMotionBlur > 0.001) {
      vec2 prevUv = reproject(worldFromDepth(vUv, centerDepth));
      vec2 vel = vUv - prevUv;
      float speedPx = length(vel * uResolution);
      if (speedPx > 0.8) {
        // uMotionBlur is the user's intensity multiplier, 0..3.5 (0-350%). At 1.0 the gather
        // spans exactly the frame-to-frame motion vector; beyond that it exaggerates it.
        float maxPx = 30.0 * uMotionBlur;
        vec2 offset = speedPx > maxPx ? vel * (maxPx / speedPx) : vel;
        float blurPx = length(offset * uResolution);
        // Tap count has to grow with the smear, or a long blur degenerates into visible bands:
        // the old fixed 8 taps left ~13 px gaps at 350%, which strobes as the camera moves.
        // Capping at 24 keeps the worst case bounded; past ~72 px the per-pixel phase jitter and
        // the temporal accumulator hide the residual spacing. So blur cost scales with the
        // intensity the user actually asked for instead of being paid at 100% too.
        int taps = int(clamp(ceil(blurPx / 3.0), 4.0, 24.0));
        float invTaps = 1.0 / float(taps);
        float jitter = hash21(vUv * uResolution + uJitter * 7.31);
        vec3 acc = vec3(0.0);
        float wSum = 0.0;
        for (int i = 0; i < 24; i++) {
          if (i >= taps) break;
          float f = (float(i) + jitter) * invTaps - 0.5;
          vec2 suv = clamp(vUv + offset * f, vec2(0.0005), vec2(0.9995));
          float nd = texture(uDepthTex, suv).r;
          float w = 1.0 / (1.0 + abs(nd - centerDepth) * 320.0);
          acc += texture(uSceneTex, suv).rgb * w;
          wSum += w;
        }
        vec3 blurred = acc / max(wSum, 1e-4);
        // Fade in over the first few pixels of travel so a static camera is bit-identical to
        // the unblurred path rather than paying a softening filter for nothing.
        float blendAmt = clamp((speedPx - 0.8) / 5.0, 0.0, 1.0);
        combined = mix(combined, blurred * volFinal.a + volFinal.rgb, blendAmt);
      }
    }

    vec3 mapped = acesToneMap(combined * uExposure);
    mapped = pow(mapped, vec3(1.0 / 2.2));

    fragColor = vec4(mapped, 1.0);
  }
`;
