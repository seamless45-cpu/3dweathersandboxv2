import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Move } from 'lucide-react';
import { CameraMode } from './render/cameraController';
import { AtmosphericSceneEngine } from './render/sceneEngine';
import { AtmosphereSimulationCoordinator } from './sim/atmosphereCoordinator';
import { AdaptivePerformanceManager } from './sim/performanceManager';
import {
  AtmosphereConfig,
  PerformanceMetrics,
  QualityTier,
  RenderQualitySettings,
  SimulationTelemetrySnapshot,
} from './sim/types';
import { EventMonitor } from './ui/EventMonitor';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { TopToolbar } from './ui/TopToolbar';

export function App() {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const coordinatorRef = useRef<AtmosphereSimulationCoordinator | null>(null);
  const perfMgrRef = useRef<AdaptivePerformanceManager | null>(null);
  const engineRef = useRef<AtmosphericSceneEngine | null>(null);

  // Simulation playback & UI state
  const [paused, setPaused] = useState(false);
  const [simSpeed, setSimSpeed] = useState(12);
  const [cameraMode, setCameraMode] = useState<CameraMode>('ground');
  const [fov, setFov] = useState(64);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [touchPadOpen, setTouchPadOpen] = useState(false);

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

  // Refs mirrored into RAF loop without re-subscribing WebGL context
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const simSpeedRef = useRef(simSpeed);
  simSpeedRef.current = simSpeed;

  useEffect(() => {
    const container = canvasHostRef.current;
    const coordinator = coordinatorRef.current!;
    const perfMgr = perfMgrRef.current!;
    if (!container) return;

    const engine = new AtmosphericSceneEngine(container, coordinator, perfMgr);
    engineRef.current = engine;

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

      // Throttle React HUD state updates to ~6 Hz so UI causes near-zero CPU overhead!
      uiSyncAccum += realDtSec;
      if (uiSyncAccum >= 0.16) {
        uiSyncAccum = 0;
        setTelemetry(coordinator.getTelemetrySnapshot());
        setPerf({ ...perfMgr.metrics });
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
    perfMgr.settings = { ...perfMgr.settings, ...patch };
    setQuality({ ...perfMgr.settings });
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

  const nudgeStep = (fwd: number, str: number) => {
    engineRef.current?.cameraCtrl.nudgeMove(fwd, str, 0.25);
  };

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
            isFullscreen={isFullscreen}
            onToggleFullscreen={handleToggleFullscreen}
            onHideUI={() => setUiHidden(true)}
            telemetry={telemetry}
            perf={perf}
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
                />
              )}
            </div>

            <div>
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
              <span className="font-mono text-sky-300">
                CAPE {Math.round(telemetry.instability.cape)} J/kg
              </span>
              <span className="text-slate-600">·</span>
              <span className="font-mono">
                LCL {Math.round(telemetry.instability.lcl)}m
              </span>
              <span className="text-slate-600 hidden sm:inline">·</span>
              <span className="font-mono hidden sm:inline">
                Shear {telemetry.instability.bulkShear06km.toFixed(1)} m/s
              </span>
              <span className="text-slate-600 hidden md:inline">·</span>
              <span className="font-mono hidden md:inline">
                |E| {telemetry.maxElectricFieldKVm.toFixed(0)} kV/m
              </span>
              <span className="text-slate-600 hidden lg:inline">·</span>
              <span className="text-slate-400 hidden lg:inline">
                Drag sky to look · WASD walk · Scroll FOV · H hide UI
              </span>

              <button
                onClick={() => setTouchPadOpen((t) => !t)}
                title="Toggle On-Screen Walk Pad"
                className="sm:hidden ml-1 p-0.5 rounded bg-white/10 text-slate-200 cursor-pointer"
              >
                <Move className="w-3 h-3" />
              </button>
            </div>

            {/* Compact Touch Walk Pad (when toggled on mobile/tablet) */}
            {touchPadOpen && (
              <div className="pointer-events-auto grid grid-cols-3 gap-1 bg-slate-950/75 border border-white/15 rounded p-1 text-[10px] font-mono">
                <div />
                <button
                  onClick={() => nudgeStep(1, 0)}
                  className="px-2 py-1 rounded bg-white/10 active:bg-sky-500/40 text-slate-100"
                >
                  W
                </button>
                <div />
                <button
                  onClick={() => nudgeStep(0, -1)}
                  className="px-2 py-1 rounded bg-white/10 active:bg-sky-500/40 text-slate-100"
                >
                  A
                </button>
                <button
                  onClick={() => nudgeStep(-1, 0)}
                  className="px-2 py-1 rounded bg-white/10 active:bg-sky-500/40 text-slate-100"
                >
                  S
                </button>
                <button
                  onClick={() => nudgeStep(0, 1)}
                  className="px-2 py-1 rounded bg-white/10 active:bg-sky-500/40 text-slate-100"
                >
                  D
                </button>
              </div>
            )}

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
    </div>
  );
}

export default App;
