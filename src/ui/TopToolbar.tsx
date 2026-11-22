import React from 'react';
import {
  Activity,
  Compass,
  EyeOff,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Radar,
  RotateCcw,
  Sliders,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { CameraMode } from '../render/cameraController';
import { PerformanceMetrics, SimulationTelemetrySnapshot } from '../sim/types';

interface TopToolbarProps {
  paused: boolean;
  onTogglePause: () => void;
  simSpeed: number;
  onChangeSimSpeed: (speed: number) => void;
  onResetClearSky: () => void;
  cameraMode: CameraMode;
  onChangeCameraMode: (mode: CameraMode) => void;
  onResetCamera: () => void;
  fov: number;
  onChangeFov: (fov: number) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  monitorOpen: boolean;
  onToggleMonitor: () => void;
  radarOpen: boolean;
  onToggleRadar: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onHideUI: () => void;
  telemetry: SimulationTelemetrySnapshot;
  perf: PerformanceMetrics;
  audioEnabled: boolean;
  onToggleAudio: () => void | Promise<void>;
}

const SPEED_OPTIONS = [1, 5, 12, 25, 45];

function formatSimTime(sec: number): string {
  const totalMin = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({
  paused,
  onTogglePause,
  simSpeed,
  onChangeSimSpeed,
  onResetClearSky,
  cameraMode,
  onChangeCameraMode,
  onResetCamera,
  fov,
  onChangeFov,
  settingsOpen,
  onToggleSettings,
  monitorOpen,
  onToggleMonitor,
  radarOpen,
  onToggleRadar,
  isFullscreen,
  onToggleFullscreen,
  onHideUI,
  telemetry,
  perf,
  audioEnabled,
  onToggleAudio,
}) => {
  const statusColor =
    telemetry.organization === 'Supercell Thunderstorm'
      ? 'text-rose-300 bg-rose-500/20 border-rose-400/30'
      : telemetry.organization.includes('Thunderstorm') ||
        telemetry.organization.includes('Multicell') ||
        telemetry.organization.includes('Squall') ||
        telemetry.organization.includes('Organized')
      ? 'text-amber-200 bg-amber-500/20 border-amber-400/30'
      : telemetry.organization === 'Clear Sky'
      ? 'text-sky-200 bg-sky-500/15 border-sky-400/25'
      : 'text-emerald-200 bg-emerald-500/15 border-emerald-400/25';

  return (
    <header className="pointer-events-auto flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 bg-slate-950/72 backdrop-blur-md border-b border-white/10 text-[11px] text-slate-200">
      {/* Left: Play/Pause, Sim Clock, Speed, Reset Clear Sky & Live Meteorological Status */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={onTogglePause}
          title={paused ? 'Resume Simulation (Space)' : 'Pause Simulation (Space)'}
          className="flex items-center gap-1 px-2 py-1 rounded bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400/30 text-sky-100 font-medium transition cursor-pointer"
        >
          {paused ? <Play className="w-3 h-3 fill-current" /> : <Pause className="w-3 h-3" />}
          <span className="hidden sm:inline">{paused ? 'Play' : 'Running'}</span>
        </button>

        <div className="flex items-center gap-0.5 bg-slate-900/80 border border-white/10 rounded px-1 py-0.5">
          <span className="font-mono text-[10px] text-slate-400 px-1">
            T+{formatSimTime(telemetry.simTimeSec)}
          </span>
          {SPEED_OPTIONS.map((spd) => (
            <button
              key={spd}
              onClick={() => onChangeSimSpeed(spd)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition cursor-pointer ${
                simSpeed === spd
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              {spd}×
            </button>
          ))}
        </div>

        <button
          onClick={onResetClearSky}
          title="Reset Atmosphere to Initial Clear Sky (t = 0)"
          className="flex items-center gap-1 px-1.5 py-1 rounded bg-slate-900/80 hover:bg-slate-800 border border-white/10 text-slate-300 transition cursor-pointer"
        >
          <RotateCcw className="w-3 h-3" />
          <span className="hidden md:inline text-[10px]">Clear Sky</span>
        </button>

        {/* Emergent Storm Status Pill */}
        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-medium ${statusColor}`}
        >
          <Activity className="w-3 h-3 shrink-0" />
          <span>{telemetry.organization}</span>
          {telemetry.activeCellCount > 0 && (
            <span className="font-mono opacity-85">
              · {telemetry.activeCellCount} {telemetry.activeCellCount === 1 ? 'cell' : 'cells'}
            </span>
          )}
          {telemetry.observerRainMMHr > 0.15 && (
            <span className="hidden lg:inline font-mono text-sky-200">
              · {telemetry.observerPrecipType} ({telemetry.observerRainMMHr.toFixed(1)} mm/h)
            </span>
          )}
        </div>
      </div>

      {/* Right: Camera Mode, FOV, FPS, Settings, Autonomous Monitor, Hide UI & Fullscreen */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Camera Mode Controls */}
        <div className="flex items-center gap-0.5 bg-slate-900/80 border border-white/10 rounded p-0.5">
          <Compass className="w-3 h-3 text-slate-400 mx-1 hidden sm:block" />
          {(
            [
              ['ground', '1.7m'],
              ['elevated', 'Elevated'],
              ['orbit', 'Orbit'],
            ] as [CameraMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => onChangeCameraMode(m)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition cursor-pointer ${
                cameraMode === m
                  ? 'bg-slate-200 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={onResetCamera}
            title="Reset Observer to Default 1.7m Ground View"
            className="px-1.5 py-0.5 rounded text-[10px] text-sky-300 hover:bg-sky-500/20 transition cursor-pointer"
          >
            Reset
          </button>
        </div>

        {/* Compact FOV Zoom Slider on Desktop */}
        <div
          className="hidden xl:flex items-center gap-1.5 bg-slate-900/80 border border-white/10 rounded px-2 py-0.5"
          title="Camera Field of View / Optical Zoom (Mouse Wheel)"
        >
          <span className="text-[10px] text-slate-400">FOV</span>
          <input
            type="range"
            min={25}
            max={85}
            step={1}
            value={Math.round(fov)}
            onChange={(e) => onChangeFov(Number(e.target.value))}
            className="sim-slider w-14"
          />
          <span className="font-mono text-[10px] text-slate-200 w-6 text-right">
            {Math.round(fov)}°
          </span>
        </div>

        {/* Compact FPS Indicator */}
        <div
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-900/80 border border-white/10 font-mono text-[10px]"
          title={`Frame: ${perf.frameTimeMs}ms | Physics: ${perf.physicsTimeMs}ms | Quality: ${perf.activeTier.toUpperCase()}`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              perf.fps >= 50
                ? 'bg-emerald-400'
                : perf.fps >= 35
                ? 'bg-amber-400'
                : 'bg-rose-400'
            }`}
          />
          <span className="text-slate-100">{perf.fps}</span>
          <span className="text-slate-400">FPS</span>
        </div>

        {/* Collapsible Panels & View Controls */}
        <button
          onClick={onToggleSettings}
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] transition cursor-pointer ${
            settingsOpen
              ? 'bg-sky-500/25 border-sky-400/40 text-sky-100'
              : 'bg-slate-900/80 border-white/10 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Sliders className="w-3 h-3" />
          <span>Settings</span>
        </button>

        <button
          onClick={onToggleRadar}
          title="Toggle composite reflectivity radar"
          aria-pressed={radarOpen}
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] transition cursor-pointer ${
            radarOpen
              ? 'bg-sky-500/25 border-sky-400/40 text-sky-100'
              : 'bg-slate-900/80 border-white/10 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Radar className="w-3 h-3 text-sky-300" />
          <span className="hidden sm:inline">Radar</span>
        </button>

        <button
          onClick={onToggleMonitor}
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] transition cursor-pointer ${
            monitorOpen
              ? 'bg-violet-500/25 border-violet-400/40 text-violet-100'
              : 'bg-slate-900/80 border-white/10 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Zap className="w-3 h-3 text-amber-300" />
          <span className="hidden sm:inline">Events</span>
          <span className="font-mono bg-white/10 px-1 rounded text-[9px]">
            {telemetry.totalFlashes + telemetry.totalTLEs}
          </span>
        </button>

        <button
          onClick={() => { void onToggleAudio(); }}
          aria-pressed={audioEnabled}
          aria-label={audioEnabled ? 'Mute sound' : 'Enable sound'}
          title={audioEnabled ? 'Mute wind, rain and thunder' : 'Enable synthesized storm ambience and thunder'}
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] transition cursor-pointer ${
            audioEnabled
              ? 'bg-emerald-500/20 border-emerald-400/30 text-emerald-100'
              : 'bg-slate-900/80 border-white/10 text-slate-300 hover:bg-slate-800'
          }`}
        >
          {audioEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
          <span className="hidden sm:inline">Sound</span>
        </button>

        <button
          onClick={onHideUI}
          title="Hide Interface (Press H or click button to restore)"
          className="p-1 rounded bg-slate-900/80 hover:bg-slate-800 border border-white/10 text-slate-300 transition cursor-pointer"
        >
          <EyeOff className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onToggleFullscreen}
          title="Toggle Fullscreen"
          className="p-1 rounded bg-slate-900/80 hover:bg-slate-800 border border-white/10 text-slate-300 transition cursor-pointer"
        >
          {isFullscreen ? (
            <Minimize2 className="w-3.5 h-3.5" />
          ) : (
            <Maximize2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </header>
  );
};
