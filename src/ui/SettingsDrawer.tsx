import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  Droplets,
  Flame,
  Sun,
  Wind,
  Zap,
} from 'lucide-react';
import { SOUNDING_PRESETS } from '../sim/thermodynamics';
import {
  AtmosphereConfig,
  PerformanceMetrics,
  QualityTier,
  RenderQualitySettings,
  SimulationTelemetrySnapshot,
} from '../sim/types';

interface SettingsDrawerProps {
  config: AtmosphereConfig;
  onUpdateConfig: (patch: Partial<AtmosphereConfig>) => void;
  onApplyPreset: (presetConfig: Partial<AtmosphereConfig>, resetSky: boolean) => void;
  quality: RenderQualitySettings;
  onUpdateQuality: (patch: Partial<RenderQualitySettings>) => void;
  onSelectManualTier: (tier: QualityTier) => void;
  telemetry: SimulationTelemetrySnapshot;
  perf: PerformanceMetrics;
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  onChange: (val: number) => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  decimals = 1,
  onChange,
}) => (
  <div className="space-y-0.5">
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-slate-300">{label}</span>
      <span className="font-mono text-sky-300">
        {value.toFixed(decimals)}
        {unit}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="sim-slider"
    />
  </div>
);

const MetricCell: React.FC<{
  label: string;
  value: string;
  tag?: 'SIM' | 'DIAG';
  accent?: string;
}> = ({ label, value, tag = 'SIM', accent = 'text-slate-100' }) => (
  <div className="bg-slate-900/65 border border-white/5 rounded px-1.5 py-1">
    <div className="flex items-center justify-between text-[9px] text-slate-400">
      <span>{label}</span>
      <span className="font-mono text-[8px] opacity-60">{tag}</span>
    </div>
    <div className={`font-mono text-[10.5px] font-medium truncate ${accent}`}>{value}</div>
  </div>
);

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  config,
  onUpdateConfig,
  onApplyPreset,
  quality,
  onUpdateQuality,
  onSelectManualTier,
  telemetry,
  perf,
}) => {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    atmosphere: true,
    convection: true,
    microphysics: false,
    electricity: false,
    clouds: false,
    rendering: false,
    performance: false,
  });
  const [resetOnPreset, setResetOnPreset] = useState(true);

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const inst = telemetry.instability;

  return (
    <aside className="pointer-events-auto w-72 sm:w-80 max-h-[calc(100vh-3.5rem)] overflow-y-auto sim-scroll bg-slate-950/72 backdrop-blur-md border border-white/10 rounded-lg p-2 space-y-1.5 text-[11px] text-slate-200 shadow-2xl">
      {/* 1. ATMOSPHERE */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('atmosphere')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-sky-300">
            <Wind className="w-3.5 h-3.5" /> Atmosphere
          </span>
          {openSections.atmosphere ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.atmosphere && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            {/* Sounding Presets */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[9.5px] text-slate-400">
                <span>Environmental Sounding Regime</span>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={resetOnPreset}
                    onChange={(e) => setResetOnPreset(e.target.checked)}
                    className="accent-sky-400 w-2.5 h-2.5"
                  />
                  <span>Reset sky</span>
                </label>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {SOUNDING_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onApplyPreset(p.config, resetOnPreset)}
                    title={p.description}
                    className="text-left px-2 py-1 rounded bg-slate-900/90 hover:bg-sky-500/20 border border-white/8 hover:border-sky-400/35 text-[10px] text-slate-200 transition cursor-pointer"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <SliderRow
              label="Surface Temperature"
              value={config.surfaceTempC}
              min={10}
              max={40}
              step={0.5}
              unit=" °C"
              onChange={(v) => onUpdateConfig({ surfaceTempC: v })}
            />
            <SliderRow
              label="Surface Pressure"
              value={config.surfacePressureHPa}
              min={980}
              max={1035}
              step={1}
              decimals={0}
              unit=" hPa"
              onChange={(v) => onUpdateConfig({ surfacePressureHPa: v })}
            />
            <SliderRow
              label="Relative Humidity"
              value={config.surfaceRelHumidity}
              min={15}
              max={92}
              step={1}
              decimals={0}
              unit=" %"
              onChange={(v) => onUpdateConfig({ surfaceRelHumidity: v })}
            />
            <SliderRow
              label="Tropospheric Lapse Rate"
              value={config.envLapseRateKPerKm}
              min={5.2}
              max={8.6}
              step={0.05}
              decimals={2}
              unit=" K/km"
              onChange={(v) => onUpdateConfig({ envLapseRateKPerKm: v })}
            />
            <SliderRow
              label="Surface Wind Speed"
              value={config.surfaceWindSpeedMS}
              min={0}
              max={18}
              step={0.5}
              unit=" m/s"
              onChange={(v) => onUpdateConfig({ surfaceWindSpeedMS: v })}
            />
            <SliderRow
              label="0–6 km Bulk Wind Shear"
              value={config.bulkWindShear06kmMS}
              min={0}
              max={38}
              step={0.5}
              unit=" m/s"
              onChange={(v) => onUpdateConfig({ bulkWindShear06kmMS: v })}
            />
            <SliderRow
              label="Hodograph Curvature (0–3 km)"
              value={config.directionalShearDeg}
              min={0}
              max={150}
              step={5}
              decimals={0}
              unit="°"
              onChange={(v) => onUpdateConfig({ directionalShearDeg: v })}
            />
          </div>
        )}
      </section>

      {/* 2. CONVECTION */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('convection')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-emerald-300">
            <Flame className="w-3.5 h-3.5" /> Convection & Cells
          </span>
          {openSections.convection ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.convection && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            <div className="grid grid-cols-2 gap-1">
              <MetricCell
                label="CAPE"
                value={`${Math.round(inst.cape)} J/kg`}
                accent={inst.cape > 2000 ? 'text-amber-300' : 'text-emerald-300'}
              />
              <MetricCell
                label="CIN"
                value={`-${Math.round(inst.cin)} J/kg`}
                accent="text-sky-200"
              />
              <MetricCell label="LCL / LFC" value={`${Math.round(inst.lcl)} / ${Math.round(inst.lfc)} m`} />
              <MetricCell label="Equilibrium (EL)" value={`${(inst.el / 1000).toFixed(1)} km`} />
              <MetricCell
                label="0–3 km SRH"
                value={`${Math.round(inst.srh03km)} m²/s²`}
                accent={inst.srh03km > 180 ? 'text-rose-300' : 'text-slate-100'}
              />
              <MetricCell
                label="Up / Downdraft"
                value={`+${telemetry.maxUpdraftMS.toFixed(1)} / -${telemetry.maxDowndraftMS.toFixed(1)} m/s`}
              />
            </div>

            <SliderRow
              label="Solar Surface Heating"
              value={config.solarHeatingFactor}
              min={0}
              max={1.8}
              step={0.05}
              decimals={2}
              unit="×"
              onChange={(v) => onUpdateConfig({ solarHeatingFactor: v })}
            />
            <SliderRow
              label="Capping Inversion (CIN Lid)"
              value={config.cappingInversionStrengthK}
              min={0}
              max={5.0}
              step={0.1}
              unit=" K"
              onChange={(v) => onUpdateConfig({ cappingInversionStrengthK: v })}
            />

            {/* Compact Live Cell Architecture Table */}
            {telemetry.cells.length > 0 && (
              <div className="space-y-1 pt-0.5">
                <div className="flex justify-between text-[9px] text-slate-400">
                  <span>Active Convective Cells ({telemetry.cells.length})</span>
                  <span>Cold Pools: {telemetry.coldPoolCount}</span>
                </div>
                <div className="max-h-28 overflow-y-auto sim-scroll space-y-0.5">
                  {telemetry.cells.slice(0, 8).map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between px-1.5 py-0.5 rounded bg-slate-950/75 border border-white/5 font-mono text-[9.5px]"
                    >
                      <span className="text-sky-300">{c.id}</span>
                      <span className="text-slate-300 truncate max-w-[78px]">
                        {c.stage.replace('cumulus_', 'cu_')}
                      </span>
                      <span className="text-emerald-300">
                        {(c.cloudTopM / 1000).toFixed(1)}km
                      </span>
                      <span className="text-amber-200">
                        {c.updraftMaxMS.toFixed(0)}m/s
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 3. MICROPHYSICS */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('microphysics')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-cyan-300">
            <Droplets className="w-3.5 h-3.5" /> Microphysics & Rain
          </span>
          {openSections.microphysics ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.microphysics && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            <div className="grid grid-cols-2 gap-1">
              <MetricCell
                label="Cloud + SLW"
                value={`${telemetry.meanCloudWaterGKg.toFixed(2)} g/kg`}
              />
              <MetricCell
                label="Ice + Snow"
                value={`${telemetry.meanIceGKg.toFixed(2)} g/kg`}
              />
              <MetricCell
                label="Graupel + Hail"
                value={`${telemetry.meanGraupelHailGKg.toFixed(2)} g/kg`}
              />
              <MetricCell
                label="Peak Core Rain"
                value={`${telemetry.maxSurfaceRainMMHr.toFixed(1)} mm/h`}
                accent="text-cyan-300"
              />
              <MetricCell
                label="0°C / -38°C Lvl"
                value={`${(inst.freezingLevel / 1000).toFixed(1)} / ${(inst.homogeneousFreezeLevel / 1000).toFixed(1)} km`}
              />
              <MetricCell
                label="Ground Wetness"
                value={`${Math.round(telemetry.surfaceWetness * 100)}%`}
              />
            </div>

            <SliderRow
              label="CCN Droplet Concentration"
              value={config.ccnConcentration}
              min={0.5}
              max={2.0}
              step={0.05}
              decimals={2}
              unit="×"
              onChange={(v) => onUpdateConfig({ ccnConcentration: v })}
            />
            <SliderRow
              label="Mixed-Phase Riming Efficiency"
              value={config.rimingEfficiency}
              min={0.5}
              max={1.6}
              step={0.05}
              decimals={2}
              unit="×"
              onChange={(v) => onUpdateConfig({ rimingEfficiency: v })}
            />
          </div>
        )}
      </section>

      {/* 4. ELECTRICITY */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('electricity')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-amber-300">
            <Zap className="w-3.5 h-3.5" /> Electrification & E-Field
          </span>
          {openSections.electricity ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.electricity && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            <div className="grid grid-cols-2 gap-1">
              <MetricCell
                label="Peak 3D |E|"
                value={`${telemetry.maxElectricFieldKVm.toFixed(1)} kV/m`}
                accent="text-amber-300"
              />
              <MetricCell
                label="Breakdown Ratio"
                value={`${Math.min(100, Math.round(telemetry.maxBreakdownRatio * 100))}%`}
                accent={
                  telemetry.maxBreakdownRatio >= 0.9
                    ? 'text-rose-300'
                    : 'text-slate-100'
                }
              />
              <MetricCell
                label="Max +ρ Charge"
                value={`+${telemetry.maxPosChargeNCm3.toFixed(2)} nC/m³`}
              />
              <MetricCell
                label="Max -ρ Charge"
                value={`${telemetry.maxNegChargeNCm3.toFixed(2)} nC/m³`}
              />
            </div>

            <SliderRow
              label="Takahashi Ice-Graupel Charging"
              value={config.chargeSeparationGain}
              min={0.4}
              max={1.6}
              step={0.05}
              decimals={2}
              unit="×"
              onChange={(v) => onUpdateConfig({ chargeSeparationGain: v })}
            />
            <p className="text-[9.5px] text-slate-400 leading-tight">
              All lightning &amp; TLEs initiate autonomously when local 3D |E| exceeds the RREA runaway breakdown threshold E_init(ρ).
            </p>
          </div>
        )}
      </section>

      {/* 5. CLOUDS */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('clouds')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-slate-200">
            <Cloud className="w-3.5 h-3.5" /> Volumetric Clouds
          </span>
          {openSections.clouds ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.clouds && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            <div className="grid grid-cols-2 gap-1">
              <MetricCell
                label="Domain Cloud Cover"
                value={`${telemetry.domainCloudCoverPct.toFixed(1)}%`}
              />
              <MetricCell label="3D Volume Grid" value="48×28×48" tag="SIM" />
            </div>
            <SliderRow
              label="Worley / fBm Detail Scale"
              value={config.cloudDetailScale}
              min={0.6}
              max={1.6}
              step={0.05}
              decimals={2}
              onChange={(v) => onUpdateConfig({ cloudDetailScale: v })}
            />
            <SliderRow
              label="Turbulent Edge Erosion"
              value={config.turbulenceIntensity}
              min={0.5}
              max={1.5}
              step={0.05}
              decimals={2}
              onChange={(v) => onUpdateConfig({ turbulenceIntensity: v })}
            />
          </div>
        )}
      </section>

      {/* 6. RENDERING */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('rendering')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-orange-300">
            <Sun className="w-3.5 h-3.5" /> Rendering & Lighting
          </span>
          {openSections.rendering ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.rendering && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            <div className="flex items-center justify-between text-[10px]">
              <span>Adaptive GPU Quality</span>
              <input
                type="checkbox"
                checked={quality.autoQuality}
                onChange={(e) => onUpdateQuality({ autoQuality: e.target.checked })}
                className="accent-sky-400 cursor-pointer"
              />
            </div>

            <div className="grid grid-cols-4 gap-1">
              {(['low', 'medium', 'high', 'ultra'] as QualityTier[]).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    onUpdateQuality({ autoQuality: false });
                    onSelectManualTier(t);
                  }}
                  className={`py-0.5 rounded text-[9.5px] uppercase font-mono border transition cursor-pointer ${
                    perf.activeTier === t
                      ? 'bg-sky-500/30 border-sky-400/50 text-sky-100'
                      : 'bg-slate-900 border-white/10 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <SliderRow
              label="Solar Elevation"
              value={config.sunElevationDeg}
              min={4}
              max={75}
              step={1}
              decimals={0}
              unit="°"
              onChange={(v) => onUpdateConfig({ sunElevationDeg: v })}
            />
            <SliderRow
              label="Camera Exposure"
              value={quality.exposure}
              min={0.6}
              max={1.6}
              step={0.05}
              decimals={2}
              onChange={(v) => onUpdateQuality({ exposure: v })}
            />

            <div className="flex items-center justify-between text-[10px] pt-0.5">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={quality.enableShadows}
                  onChange={(e) => onUpdateQuality({ enableShadows: e.target.checked })}
                  className="accent-sky-400"
                />
                <span>Volumetric & Terrain Shadows</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={quality.enableTemporalAccum}
                  onChange={(e) =>
                    onUpdateQuality({ enableTemporalAccum: e.target.checked })
                  }
                  className="accent-sky-400"
                />
                <span>TAA</span>
              </label>
            </div>
          </div>
        )}
      </section>

      {/* 7. PERFORMANCE & SCIENTIFIC VALIDATION */}
      <section className="border border-white/8 rounded bg-slate-900/40 overflow-hidden">
        <button
          onClick={() => toggle('performance')}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-white/5 transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-[10.5px] uppercase tracking-wider text-violet-300">
            <Cpu className="w-3.5 h-3.5" /> Performance & Validation
          </span>
          {openSections.performance ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
        </button>

        {openSections.performance && (
          <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
            <div className="grid grid-cols-2 gap-1">
              <MetricCell label="Frame Time" value={`${perf.frameTimeMs} ms`} tag="DIAG" />
              <MetricCell label="Physics / Render" value={`${perf.physicsTimeMs} / ${perf.renderTimeMs} ms`} tag="DIAG" />
              <MetricCell
                label="Ray-March Steps"
                value={`${perf.raymarchStepsActive} @ ${Math.round(perf.volumetricScaleActive * 100)}%`}
                tag="DIAG"
              />
              <MetricCell
                label="JS Memory"
                value={perf.memoryUsedMB !== null ? `${perf.memoryUsedMB} MB` : 'N/A'}
                tag="DIAG"
              />
            </div>

            <div className="border-t border-white/8 pt-1.5 space-y-1.5">
              <label className="flex items-center justify-between text-[10px] cursor-pointer">
                <span className="text-slate-300">Bloom · Bright-pass + Gaussian blur</span>
                <input type="checkbox" checked={quality.enableBloom} onChange={(e) => onUpdateQuality({ enableBloom: e.target.checked })} className="accent-violet-400" />
              </label>
              <label className="flex items-center justify-between text-[10px] cursor-pointer">
                <span className="text-slate-300">Lightning Camera Shake · 40 Hz</span>
                <input type="checkbox" checked={quality.enableCameraShake} onChange={(e) => onUpdateQuality({ enableCameraShake: e.target.checked })} className="accent-violet-400" />
              </label>
            </div>

            <div className="text-[9px] text-slate-400 truncate" title={perf.gpuRenderer}>
              GPU: <span className="font-mono text-slate-300">{perf.gpuRenderer}</span>
            </div>

            {/* Physical Consistency & Conservation Audit */}
            <div className="border-t border-white/8 pt-1.5 space-y-1">
              <div className="text-[9.5px] font-semibold text-slate-300">
                Conservation & Stability Audit
              </div>
              <div className="grid grid-cols-2 gap-1">
                <MetricCell
                  label="Mass Div |∇·ρv|"
                  value={`${telemetry.validation.massContinuityResidual.toExponential(1)} s⁻¹`}
                  accent="text-emerald-300"
                />
                <MetricCell
                  label="Max Grid CFL"
                  value={telemetry.validation.maxCFL.toFixed(2)}
                  accent={telemetry.validation.maxCFL < 1.0 ? 'text-emerald-300' : 'text-amber-300'}
                />
                <MetricCell
                  label="Water Drift"
                  value={`${telemetry.validation.waterConservationDriftPct.toFixed(2)}%`}
                />
                <MetricCell
                  label="Charge Balance"
                  value={`±${telemetry.validation.chargeBalanceResidualC.toFixed(3)} C`}
                />
              </div>
              <div className="text-[8.5px] text-slate-400 leading-tight">
                <span className="font-mono text-slate-200">SIM</span> = 3D grid/parcel solver value ·{' '}
                <span className="font-mono text-slate-200">DIAG</span> = derived telemetry.
              </div>
            </div>
          </div>
        )}
      </section>
    </aside>
  );
};
