import React from 'react';
import { Sparkles, Zap } from 'lucide-react';
import { EventMonitorRecord } from '../sim/types';

interface EventMonitorProps {
  events: EventMonitorRecord[];
  maxBreakdownRatio: number;
  maxElectricFieldKVm: number;
}

function formatEventTime(sec: number): string {
  const mins = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${String(mins).padStart(2, '0')}:${s}`;
}

export const EventMonitor: React.FC<EventMonitorProps> = ({
  events,
  maxBreakdownRatio,
  maxElectricFieldKVm,
}) => {
  const pct = Math.min(100, Math.round(maxBreakdownRatio * 100));

  return (
    <aside className="pointer-events-auto w-72 sm:w-80 max-h-[calc(100vh-3.5rem)] flex flex-col bg-slate-950/72 backdrop-blur-md border border-white/10 rounded-lg p-2 text-[10.5px] text-slate-200 shadow-2xl">
      <div className="flex items-center justify-between pb-1.5 border-b border-white/10">
        <div className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-amber-300 text-[10px]">
          <Zap className="w-3.5 h-3.5" />
          <span>Autonomous Event Monitor</span>
        </div>
        <span className="font-mono text-[9.5px] text-slate-400">
          {events.length} logged
        </span>
      </div>

      {/* Live Dielectric Breakdown Readiness Gauge */}
      <div className="py-1.5 border-b border-white/8 space-y-1">
        <div className="flex items-center justify-between text-[9.5px]">
          <span className="text-slate-400">Peak 3D Field / RREA Breakdown</span>
          <span className="font-mono text-slate-200">
            {maxElectricFieldKVm.toFixed(1)} kV/m ({pct}%)
          </span>
        </div>
        <div className="w-full h-1.5 rounded-full bg-slate-800/90 overflow-hidden">
          <div
            className={`h-full transition-all duration-200 ${
              pct >= 95
                ? 'bg-rose-400'
                : pct >= 65
                ? 'bg-amber-400'
                : 'bg-sky-400'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Autonomous Event Stream */}
      <div className="flex-1 overflow-y-auto sim-scroll pt-1.5 space-y-1.5">
        {events.length === 0 ? (
          <div className="py-5 px-2 text-center text-[10px] text-slate-400 leading-relaxed">
            No electrical discharges yet.
            <br />
            Atmosphere begins completely clear — lightning &amp; TLEs emerge automatically once convective ice-graupel charging builds 3D |E| past breakdown.
          </div>
        ) : (
          events.map((ev) => {
            const isTLE = ev.kind === 'tle';
            const polBadge =
              ev.polarity === 'Positive (+)'
                ? 'text-rose-300 bg-rose-500/15 border-rose-400/30'
                : ev.polarity === 'Negative (-)'
                ? 'text-sky-300 bg-sky-500/15 border-sky-400/30'
                : 'text-violet-300 bg-violet-500/15 border-violet-400/30';

            return (
              <div
                key={ev.id}
                className={`rounded border p-1.5 space-y-1 ${
                  isTLE
                    ? 'bg-violet-950/35 border-violet-400/30'
                    : 'bg-slate-900/65 border-white/8'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="flex items-center gap-1 font-semibold text-slate-100 truncate">
                    {isTLE ? (
                      <Sparkles className="w-3 h-3 text-rose-400 shrink-0" />
                    ) : (
                      <Zap className="w-3 h-3 text-amber-300 shrink-0" />
                    )}
                    <span className="truncate">{ev.classification}</span>
                  </span>
                  <span
                    className={`px-1 py-0.2 rounded border font-mono text-[8.5px] shrink-0 ${polBadge}`}
                  >
                    {ev.polarity === 'Positive (+)'
                      ? '+POL'
                      : ev.polarity === 'Negative (-)'
                      ? '-POL'
                      : 'EMP'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-x-1.5 gap-y-0.5 font-mono text-[9px] text-slate-300">
                  <div>
                    <span className="text-slate-500">T+</span>
                    {formatEventTime(ev.timestampSimSec)}
                  </div>
                  <div>
                    <span className="text-slate-500">Cell:</span> {ev.cellId}
                  </div>
                  <div>
                    <span className="text-slate-500">Len:</span>{' '}
                    {ev.channelLengthKm.toFixed(1)}km
                  </div>
                  <div>
                    <span className="text-slate-500">Br:</span> {ev.branchCount}
                  </div>
                  <div>
                    <span className="text-slate-500">Strk:</span> {ev.strokeCount}
                  </div>
                  <div>
                    <span className="text-slate-500">Dur:</span> {ev.durationMs}ms
                  </div>
                  <div className="col-span-2">
                    <span className="text-slate-500">Peak |E|:</span>{' '}
                    <span className="text-amber-200">
                      {ev.peakElectricFieldKVm.toFixed(0)} kV/m
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">ΔQ:</span>{' '}
                    {ev.chargeTransferredC.toFixed(1)}C
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
