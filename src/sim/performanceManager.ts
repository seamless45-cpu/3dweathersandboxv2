import { PerformanceMetrics, QualityTier, RenderQualitySettings } from './types';

interface TierPreset {
  raymarchSteps: number;
  volumetricScale: number;
}

/**
 * Tier presets.
 *
 * The volumetric scales here are meaningfully lower than they were before the ray-march gained
 * true temporal reprojection. Reprojecting the previous frame's volume along the camera motion
 * vector (instead of resampling it at the same UV) makes history safe to lean on much harder,
 * and the rotating sub-pixel jitter means four consecutive low-res frames reconstruct detail
 * that a single high-res frame would have to resolve outright. That trades one full-resolution
 * ray-march for roughly a quarter of one at near-identical quality — the dominant lever on
 * frame time, since the volume pass is the most expensive thing on the GPU.
 */
const TIER_PRESETS: Record<QualityTier, TierPreset> = {
  ultra: { raymarchSteps: 76, volumetricScale: 0.72 },
  high: { raymarchSteps: 58, volumetricScale: 0.6 },
  medium: { raymarchSteps: 44, volumetricScale: 0.5 },
  low: { raymarchSteps: 32, volumetricScale: 0.42 },
};

/** Upper bound on the device pixel ratio, matching the engine's native cap. */
export const MAX_DEVICE_PIXEL_RATIO = 1.75;

const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export class AdaptivePerformanceManager {
  public settings: RenderQualitySettings;
  public metrics: PerformanceMetrics;

  private fpsAccum = 60;
  private frameTimeAccum = 16.6;
  private physicsTimeAccum = 1.0;
  private renderTimeAccum = 4.0;
  private lowFpsDurationSec = 0;
  private highFpsDurationSec = 0;
  private isMobileDevice: boolean;

  constructor() {
    this.isMobileDevice =
      typeof navigator !== 'undefined' &&
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

    const defaultTier: QualityTier = this.isMobileDevice ? 'medium' : 'high';
    const preset = TIER_PRESETS[defaultTier];

    this.settings = {
      autoQuality: true,
      tier: defaultTier,
      raymarchSteps: preset.raymarchSteps,
      volumetricScale: preset.volumetricScale,
      gridResolutionMode: 'standard',
      enableShadows: true,
      enableTemporalAccum: true,
      exposure: 1.0,
      enableBloom: true,
      enableCameraShake: true,
      pixelRatioScale: 1.0,
      enableMotionBlur: true,
      enableDayNightCycle: false,
      dayNightCycleSec: 240,
      // ~15.8 h reproduces the 34 deg solar elevation the manual lighting mode defaults to,
      // so switching the cycle on does not jump the scene to a different time of day.
      timeOfDayHours: 15.8,
    };

    this.metrics = {
      fps: 60,
      frameTimeMs: 16.6,
      physicsTimeMs: 1.0,
      renderTimeMs: 4.0,
      memoryUsedMB: null,
      gpuRenderer: 'WebGL2 Hardware',
      activeTier: defaultTier,
      raymarchStepsActive: preset.raymarchSteps,
      volumetricScaleActive: preset.volumetricScale,
      pixelRatioActive: 1,
      renderWidthPx: 0,
      renderHeightPx: 0,
    };
  }

  /** Device pixel ratio this browser reports, clamped to the engine's native cap. */
  public get basePixelRatio(): number {
    const raw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(raw, MAX_DEVICE_PIXEL_RATIO);
  }

  /** Effective pixel ratio after the user's render-scale slider. */
  public get effectivePixelRatio(): number {
    return this.basePixelRatio * this.clampedPixelRatioScale;
  }

  /** Render-scale slider value clamped to its supported 0.1x..1.0x range. */
  public get clampedPixelRatioScale(): number {
    return Math.min(1, Math.max(0.1, this.settings.pixelRatioScale));
  }

  public setGpuRendererInfo(rendererName: string): void {
    this.metrics.gpuRenderer = rendererName;
  }

  public applyManualTier(tier: QualityTier): void {
    const preset = TIER_PRESETS[tier];
    this.settings.tier = tier;
    this.settings.raymarchSteps = preset.raymarchSteps;
    this.settings.volumetricScale = preset.volumetricScale;
    this.metrics.activeTier = tier;
    this.metrics.raymarchStepsActive = preset.raymarchSteps;
    this.metrics.volumetricScaleActive = preset.volumetricScale;
  }

  public recordFrame(
    realDtSec: number,
    physicsMs: number,
    renderMs: number
  ): boolean {
    const clampedDt = Math.max(0.001, Math.min(0.25, realDtSec));
    const instantFps = 1.0 / clampedDt;
    const frameMs = clampedDt * 1000.0;

    const alpha = 0.08;
    this.fpsAccum = this.fpsAccum * (1 - alpha) + instantFps * alpha;
    this.frameTimeAccum = this.frameTimeAccum * (1 - alpha) + frameMs * alpha;
    this.physicsTimeAccum = this.physicsTimeAccum * (1 - alpha) + physicsMs * alpha;
    this.renderTimeAccum = this.renderTimeAccum * (1 - alpha) + renderMs * alpha;

    // Optional Chromium JS Heap Memory telemetry
    const perfAny = performance as unknown as {
      memory?: { usedJSHeapSize: number };
    };
    const memMB = perfAny.memory
      ? Math.round((perfAny.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10
      : null;

    let resolutionChanged = false;

    if (this.settings.autoQuality) {
      if (this.fpsAccum < 39) {
        this.lowFpsDurationSec += clampedDt;
        this.highFpsDurationSec = 0;
        if (this.lowFpsDurationSec > 1.4) {
          this.lowFpsDurationSec = 0;
          const idx = TIER_ORDER.indexOf(this.settings.tier);
          if (idx > 0) {
            this.applyManualTier(TIER_ORDER[idx - 1]);
            resolutionChanged = true;
          }
        }
      } else if (this.fpsAccum > 56.5) {
        this.highFpsDurationSec += clampedDt;
        this.lowFpsDurationSec = 0;
        const maxAutoIdx = this.isMobileDevice ? 2 : 3;
        if (this.highFpsDurationSec > 5.0) {
          this.highFpsDurationSec = 0;
          const idx = TIER_ORDER.indexOf(this.settings.tier);
          if (idx < maxAutoIdx) {
            this.applyManualTier(TIER_ORDER[idx + 1]);
            resolutionChanged = true;
          }
        }
      } else {
        this.lowFpsDurationSec = Math.max(0, this.lowFpsDurationSec - clampedDt * 0.5);
        this.highFpsDurationSec = Math.max(0, this.highFpsDurationSec - clampedDt * 0.5);
      }
    }

    this.metrics = {
      fps: Math.round(this.fpsAccum),
      frameTimeMs: Math.round(this.frameTimeAccum * 10) / 10,
      physicsTimeMs: Math.round(this.physicsTimeAccum * 100) / 100,
      renderTimeMs: Math.round(this.renderTimeAccum * 100) / 100,
      memoryUsedMB: memMB,
      gpuRenderer: this.metrics.gpuRenderer,
      activeTier: this.settings.tier,
      raymarchStepsActive: this.settings.raymarchSteps,
      volumetricScaleActive: this.settings.volumetricScale,
      pixelRatioActive: this.effectivePixelRatio,
      renderWidthPx: this.metrics.renderWidthPx,
      renderHeightPx: this.metrics.renderHeightPx,
    };

    return resolutionChanged;
  }
}
