import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { StormAudio } from './audio/stormAudio';
import { CameraMode } from './render/cameraController';
import { AtmosphericSceneEngine } from './render/sceneEngine';
import {
  AtmosphereSimulationCoordinator,
  CADENCE_BY_TIER,
  PhysicsCadence,
} from './sim/atmosphereCoordinator';
import { AdaptivePerformanceManager } from './sim/performanceManager';
import {
  AtmosphereConfig,
  PerformanceMetrics,
  QualityTier,
  RenderQualitySettings,
  SimulationTelemetrySnapshot,
} from './sim/types';
import { EventMonitor } from './ui/EventMonitor';
import { RadarPanel } from './ui/RadarPanel';
import { SettingsDrawer, SunReadout } from './ui/SettingsDrawer';
import { TopToolbar } from './ui/TopToolbar';
import { VirtualJoystick } from './ui/VirtualJoystick';

function detectMobileControls(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse) and (max-width: 768px)').matches;
}

export function App() {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const coordinatorRef = useRef<AtmosphereSimulationCoordinator | null>(null);
  const perfMgrRef = useRef<AdaptivePerformanceManager | null>(null);
  const engineRef = useRef<AtmosphericSceneEngine | null>(null);
  const audioRef = useRef<StormAudio | null>(null);
  const joystickRef = useRef({ forward: 0, strafe: 0 });
  const [mobileControls, setMobileControls] = useState(detectMobileControls);
  const [audioEnabled, setAudioEnabled] = useState(false);

  // Simulation playback & UI state
  const [paused, setPaused] = useState(false);
  const [simSpeed, setSimSpeed] = useState(12);
  const [cameraMode, setCameraMode] = useState<CameraMode>('ground');
  const [fov, setFov] = useState(64);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [radarOpen, setRadarOpen] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Lazy-init simulation coordinator & performance manager once
  if (!coordinatorRef.current) {
    coordinatorRef.current = new AtmosphereSimulationCoordinator();
  }
  if (!perfMgrRef.current) {
    perfMgrRef.current = new AdaptivePerformanceManager();
  }

  const [config, setConfig] = useState<AtmosphereConfig>(
    () => ({ ...coordinatorRef.current!.config })
  );
  const [quality, setQuality] = useState<RenderQualitySettings>(
    () => ({ ...perfMgrRef.current!.settings })
  );
  const [telemetry, setTelemetry] = useState<SimulationTelemetrySnapshot>(() =>
    coordinatorRef.current!.getTelemetrySnapshot()
  );
  const [perf, setPerf] = useState<PerformanceMetrics>(
    () => ({ ...perfMgrRef.current!.metrics })
  );
  const [sun, setSun] = useState<SunReadout>(() => ({
    clock: '15:48',
    timeOfDayHours: perfMgrRef.current!.settings.timeOfDayHours,
    sunElevationDeg: coordinatorRef.current!.config.sunElevationDeg,
    daylight: 1,
    insolation: 1,
    isNight: false,
  }));

  // Refs mirrored into RAF loop without re-subscribing WebGL context
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const simSpeedRef = useRef(simSpeed);
  simSpeedRef.current = simSpeed;

  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse) and (max-width: 768px)');
    const update = () => setMobileControls(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    engineRef.current?.cameraCtrl.setKeyboardControlsEnabled(!mobileControls);
    if (!mobileControls) {
      joystickRef.current = { forward: 0, strafe: 0 };
      engineRef.current?.cameraCtrl.setJoystickInput(0, 0);
    }
  }, [mobileControls]);

  useEffect(() => {
    const container = canvasHostRef.current;
    const coordinator = coordinatorRef.current!;
    const perfMgr = perfMgrRef.current!;
    if (!container) return;

    const engine = new AtmosphericSceneEngine(container, coordinator, perfMgr);
    engine.cameraCtrl.setKeyboardControlsEnabled(!mobileControls);
    engine.cameraCtrl.setJoystickInput(joystickRef.current.forward, joystickRef.current.strafe);
    engineRef.current = engine;

    // Seed the HUD resolution readout immediately; otherwise it reports 0x0 until the first
    // throttled sync lands ~160 ms later.
    perfMgr.metrics.renderWidthPx = engine.renderWidthPx;
    perfMgr.metrics.renderHeightPx = engine.renderHeightPx;
    perfMgr.metrics.pixelRatioActive = perfMgr.effectivePixelRatio;
    setPerf({ ...perfMgr.metrics });

    const handleResize = () => {
      if (!container || !engineRef.current) return;
      engineRef.current.resize(
        container.clientWidth,
        container.clientHeight,
        perfMgr.settings.volumetricScale
      );
    };
    window.addEventListener('resize', handleResize);

    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    const handleKeyShortcuts = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        return;
      }
      if (e.code === 'KeyH') {
        setUiHidden((h) => !h);
      } else if (e.code === 'KeyP') {
        setPaused((p) => !p);
      } else if (e.code === 'KeyR') {
        engine.cameraCtrl.resetToGroundObserver();
        setCameraMode('ground');
        setFov(engine.cameraCtrl.fov);
      }
    };
    window.addEventListener('keydown', handleKeyShortcuts);

    let rafId = 0;
    let prevTime = performance.now();
    let uiSyncAccum = 0;
    let lastCadence: PhysicsCadence | null = null;

    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const realDtSec = Math.min(0.1, Math.max(0.001, (now - prevTime) / 1000.0));
      prevTime = now;

      const tPhys0 = performance.now();
      coordinator.step(
        realDtSec,
        simSpeedRef.current,
        pausedRef.current,
        engine.cameraCtrl.posX,
        engine.cameraCtrl.posZ
      );
      const tPhys1 = performance.now();

      engine.cameraCtrl.setJoystickInput(joystickRef.current.forward, joystickRef.current.strafe);
      audioRef.current?.syncLightning(coordinator.lightning.activeDischarges, {
        x: engine.cameraCtrl.posX,
        y: engine.cameraCtrl.posY,
        z: engine.cameraCtrl.posZ,
      });
      engine.renderFrame(realDtSec, coordinator, perfMgr);
      const tRend1 = performance.now();

      const scaleChanged = perfMgr.recordFrame(
        realDtSec,
        tPhys1 - tPhys0,
        tRend1 - tPhys1
      );
      if (scaleChanged) {
        engine.allocateRenderTargets(perfMgr.settings.volumetricScale);
      }
      // The expensive Eulerian passes (fluid solve, Poisson field, texture repack) run on the
      // physics cadence for the active quality tier; Lagrangian cell dynamics still step every
      // frame, so storms stay smooth even when the grid updates a few times a second.
      const cadence = CADENCE_BY_TIER[perfMgr.settings.tier];
      if (cadence && cadence !== lastCadence) {
        lastCadence = cadence;
        coordinator.setCadence(cadence);
      }

      // Throttle React HUD state updates to ~6 Hz so UI causes near-zero CPU overhead!
      uiSyncAccum += realDtSec;
      if (uiSyncAccum >= 0.16) {
        uiSyncAccum = 0;
        setTelemetry(coordinator.getTelemetrySnapshot());
        audioRef.current?.setEnvironment(
          coordinator.config.surfaceWindSpeedMS,
          coordinator.observerRainMMHr,
          coordinator.observerPrecipType,
          coordinator.observerFrozenFraction,
          coordinator.observerGustFactor
        );

        // Publish the real render size so the HUD reports what is actually on screen rather
        // than the CSS size, which diverges as soon as the pixel-ratio slider moves.
        perfMgr.metrics.renderWidthPx = engine.renderWidthPx;
        perfMgr.metrics.renderHeightPx = engine.renderHeightPx;
        setPerf({ ...perfMgr.metrics });

        const sc = engine.sunCycle;
        setSun({
          clock: sc.formatClock(),
          timeOfDayHours: sc.timeOfDayHours,
          sunElevationDeg: sc.sunElevationDeg,
          daylight: sc.daylight,
          insolation: sc.insolation,
          isNight: sc.sunElevationDeg < -0.5,
        });
        setFov(engine.cameraCtrl.fov);
      }
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('keydown', handleKeyShortcuts);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const handleUpdateConfig = useCallback((patch: Partial<AtmosphereConfig>) => {
    const coordinator = coordinatorRef.current!;
    coordinator.updateConfig(patch);
    setConfig({ ...coordinator.config });
    setTelemetry(coordinator.getTelemetrySnapshot());
  }, []);

  const handleApplyPreset = useCallback(
    (presetPatch: Partial<AtmosphereConfig>, resetSky: boolean) => {
      const coordinator = coordinatorRef.current!;
      coordinator.updateConfig(presetPatch);
      if (resetSky) {
        coordinator.resetToClearSky();
      }
      setConfig({ ...coordinator.config });
      setTelemetry(coordinator.getTelemetrySnapshot());
    },
    []
  );

  const handleResetClearSky = useCallback(() => {
    const coordinator = coordinatorRef.current!;
    coordinator.resetToClearSky();
    setTelemetry(coordinator.getTelemetrySnapshot());
  }, []);

  const handleChangeCameraMode = useCallback((mode: CameraMode) => {
    if (!engineRef.current) return;
    engineRef.current.cameraCtrl.setMode(mode);
    setCameraMode(mode);
  }, []);

  const handleResetCamera = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.cameraCtrl.resetToGroundObserver();
    setCameraMode('ground');
    setFov(engineRef.current.cameraCtrl.fov);
  }, []);

  const handleChangeFov = useCallback((nextFov: number) => {
    if (!engineRef.current) return;
    engineRef.current.cameraCtrl.setFov(nextFov);
    setFov(nextFov);
  }, []);

  const handleUpdateQuality = useCallback((patch: Partial<RenderQualitySettings>) => {
    const perfMgr = perfMgrRef.current!;
    const previous = perfMgr.settings;
    perfMgr.settings = { ...previous, ...patch };
    setQuality({ ...perfMgr.settings });

    const engine = engineRef.current;
    if (!engine) return;

    // Render scale has to reach the renderer itself: it resizes the canvas backing store and
    // reallocates every render target, which a plain settings write cannot do.
    if (
      patch.pixelRatioScale !== undefined &&
      patch.pixelRatioScale !== previous.pixelRatioScale
    ) {
      engine.setPixelRatioScale(patch.pixelRatioScale, perfMgr.settings.volumetricScale);
    }

    // Scrubbing local solar time repositions the sun immediately, cycle running or not.
    if (patch.timeOfDayHours !== undefined) {
      engine.sunCycle.setTimeOfDay(patch.timeOfDayHours);
      perfMgr.settings.timeOfDayHours = engine.sunCycle.timeOfDayHours;
      setQuality({ ...perfMgr.settings });
    }

    // Switching the cycle on starts from wherever the manual slider had the sun, so the scene
    // does not jump to a different time of day the moment the checkbox is ticked.
    if (patch.enableDayNightCycle === true && !previous.enableDayNightCycle) {
      engine.sunCycle.setTimeOfDayFromElevation(
        coordinatorRef.current!.config.sunElevationDeg
      );
      perfMgr.settings.timeOfDayHours = engine.sunCycle.timeOfDayHours;
      setQuality({ ...perfMgr.settings });
    }
  }, []);

  const handleSelectManualTier = useCallback((tier: QualityTier) => {
    const perfMgr = perfMgrRef.current!;
    perfMgr.applyManualTier(tier);
    setQuality({ ...perfMgr.settings });
    setPerf({ ...perfMgr.metrics });
    if (engineRef.current) {
      engineRef.current.allocateRenderTargets(perfMgr.settings.volumetricScale);
    }
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const handleJoystickMove = useCallback((vector: { forward: number; strafe: number }) => {
    joystickRef.current = vector;
    engineRef.current?.cameraCtrl.setJoystickInput(vector.forward, vector.strafe);
  }, []);

  const handleToggleAudio = useCallback(async () => {
    if (audioEnabled) {
      audioRef.current?.disable();
      setAudioEnabled(false);
      return;
    }
    const audio = audioRef.current ?? new StormAudio();
    audioRef.current = audio;
    setAudioEnabled(await audio.enable());
  }, [audioEnabled]);

  useEffect(() => () => {
    audioRef.current?.dispose();
    audioRef.current = null;
  }, []);

  const latestEvent = telemetry.events[0] ?? null;

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950">
      {/* Full-Viewport 3D WebGL2 Canvas */}
      <div ref={canvasHostRef} className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Hidden UI Restore Pill */}
      {uiHidden ? (
        <button
          onClick={() => setUiHidden(false)}
          className="fixed top-2.5 right-2.5 z-30 flex items-center gap-1 px-2 py-1 rounded bg-slate-950/65 hover:bg-slate-900 border border-white/15 text-[10px] text-slate-200 backdrop-blur-md transition cursor-pointer"
        >
          <Eye className="w-3 h-3 text-sky-300" />
          <span>Show UI (H)</span>
        </button>
      ) : (
        <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between">
          {/* Top Compact Toolbar */}
          <TopToolbar
            paused={paused}
            onTogglePause={() => setPaused((p) => !p)}
            simSpeed={simSpeed}
            onChangeSimSpeed={setSimSpeed}
            onResetClearSky={handleResetClearSky}
            cameraMode={cameraMode}
            onChangeCameraMode={handleChangeCameraMode}
            onResetCamera={handleResetCamera}
            fov={fov}
            onChangeFov={handleChangeFov}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((o) => !o)}
            monitorOpen={monitorOpen}
            onToggleMonitor={() => setMonitorOpen((o) => !o)}
            radarOpen={radarOpen}
            onToggleRadar={() => setRadarOpen((o) => !o)}
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onHideUI={() => setUiHidden(true)}
            telemetry={telemetry}
            perf={perf}
            audioEnabled={audioEnabled}
            onToggleAudio={handleToggleAudio}
          />

          {/* Middle Floating Collapsible Drawers */}
          <div className="flex-1 flex items-start justify-between px-2.5 pt-2 overflow-hidden">
            <div>
              {settingsOpen && (
                <SettingsDrawer
                  config={config}
                  onUpdateConfig={handleUpdateConfig}
                  onApplyPreset={handleApplyPreset}
                  quality={quality}
                  onUpdateQuality={handleUpdateQuality}
                  onSelectManualTier={handleSelectManualTier}
                  telemetry={telemetry}
                  perf={perf}
                  sun={sun}
                />
              )}
            </div>

            <div className="flex gap-2 items-start">
              {radarOpen && (
                <RadarPanel
                  grid={coordinatorRef.current!.grid}
                  sounding={coordinatorRef.current!.sounding}
                  observerX={engineRef.current?.cameraCtrl.posX ?? 0}
                  observerZ={engineRef.current?.cameraCtrl.posZ ?? 0}
                  onClose={() => setRadarOpen(false)}
                />
              )}
              {monitorOpen && (
                <EventMonitor
                  events={telemetry.events}
                  maxBreakdownRatio={telemetry.maxBreakdownRatio}
                  maxElectricFieldKVm={telemetry.maxElectricFieldKVm}
                />
              )}
            </div>
          </div>

          {/* Bottom Micro-Telemetry & Touch Walk Controls */}
          <footer className="px-2.5 pb-2 flex items-end justify-between gap-2">
            {/* Compact Observer & Instability Strip */}
            <div className="pointer-events-auto flex flex-wrap items-center gap-2 px-2.5 py-1 rounded bg-slate-950/60 backdrop-blur-md border border-white/10 text-[10px] text-slate-300">
              {/* Local surface weather, resolved from the mesoscale field at the observer's
                  position -- not the domain-average sounding value. */}
              <span className="font-mono text-emerald-300" title="Local temperature / dewpoint at your position">
                {telemetry.observerTempC.toFixed(1)}°/{telemetry.observerDewpointC.toFixed(1)}°C
              </span>
              <span className="text-slate-600">·</span>
              <span className="font-mono" title="Local relative humidity">
                RH {telemetry.observerRelHumidity.toFixed(0)}%
              </span>
              <span className="text-slate-600">·</span>
              <span className="font-mono" title="Local surface pressure">
                {telemetry.observerPressureHPa.toFixed(1)} hPa
              </span>
              <span className="text-slate-600">·</span>
              <span
                className="font-mono text-sky-300"
                title={`Local CAPE. Domain-average is ${Math.round(telemetry.instability.cape)} J/kg`}
              >
                CAPE {Math.round(telemetry.observerLocalCape)} J/kg
              </span>
              <span className="text-slate-600">·</span>
              <span
                className="font-mono"
                title={`Local lifted condensation level (cloud base). Domain-average ${Math.round(telemetry.instability.lcl)} m`}
              >
                LCL {Math.round(telemetry.observerLocalLcl)}m
              </span>
              <span className="text-slate-600 hidden sm:inline">·</span>
              <span className="font-mono hidden sm:inline">
                Shear {telemetry.instability.bulkShear06km.toFixed(1)} m/s
              </span>
              <span className="text-slate-600 hidden md:inline">·</span>
              <span className="font-mono hidden md:inline">
                |E| {telemetry.maxElectricFieldKVm.toFixed(0)} kV/m
              </span>
              {/* Lightning rod: shows corona point-discharge and any strike it has taken. */}
              {(telemetry.rodCorona > 0.02 || telemetry.rodInterceptions > 0) && (
                <>
                  <span className="text-slate-600 hidden md:inline">·</span>
                  <span
                    className={`font-mono hidden md:inline ${
                      telemetry.rodInterceptions > 0 ? 'text-amber-300' : 'text-sky-300/80'
                    }`}
                    title="Grounded mast: corona point-discharge and intercepted strikes"
                  >
                    Rod{' '}
                    {telemetry.rodInterceptions > 0
                      ? `⚡${telemetry.rodInterceptions}`
                      : `corona ${(telemetry.rodCorona * 100).toFixed(0)}%`}
                  </span>
                </>
              )}
              <span className="text-slate-600 hidden lg:inline">·</span>
              <span className="text-slate-400 hidden lg:inline">
                {mobileControls
                  ? 'Drag sky to look · joystick to move'
                  : 'WASD / arrows · 120 km/h · drag to look · H hide UI'}
              </span>
            </div>

            {/* Tornado warning pill: strongest active vortex, straight from the sim. */}
            {telemetry.tornadoes.length > 0 && (() => {
              const t = telemetry.tornadoes[0];
              return (
                <div className="pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-950/70 backdrop-blur-md border border-red-400/40 text-[10px] text-red-100">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                  <span className="font-semibold tracking-wide">
                    TORNADO EF{t.efScale}
                  </span>
                  <span className="font-mono text-red-200/85">
                    {(t.windMS * 3.6).toFixed(0)} km/h · core {Math.round(t.radiusM)}m ·{' '}
                    {(t.pressureDeficitPa / 100).toFixed(0)} hPa · {t.phase}
                  </span>
                  {telemetry.tornadoes.length > 1 && (
                    <span className="font-mono text-red-300/70">
                      +{telemetry.tornadoes.length - 1}
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Compact Latest Autonomous Discharge Pill (when Event Monitor drawer is closed) */}
            {!monitorOpen && latestEvent && (
              <button
                onClick={() => setMonitorOpen(true)}
                className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-950/68 hover:bg-slate-900/85 backdrop-blur-md border border-amber-400/25 text-[10px] text-slate-200 transition cursor-pointer"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
                <span className="font-semibold text-amber-200">
                  {latestEvent.classification}
                </span>
                <span className="font-mono text-slate-400">
                  {latestEvent.cellId} · {latestEvent.channelLengthKm.toFixed(1)}km ·{' '}
                  {latestEvent.peakElectricFieldKVm.toFixed(0)} kV/m
                </span>
              </button>
            )}
          </footer>
        </div>
      )}
      {mobileControls && !uiHidden && <VirtualJoystick onMove={handleJoystickMove} />}
    </div>
  );
}

export default App;
