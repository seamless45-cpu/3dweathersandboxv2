import React, { useEffect, useRef, useState } from 'react';
import { Radar as RadarIcon, Crosshair } from 'lucide-react';
import type { AtmosphericFluidGrid } from '../sim/fluidGrid';
import type { AtmosphericSounding } from '../sim/thermodynamics';
import { findStormCore, renderColumnMax, renderSection, toDbz, dbzToNorm } from '../sim/radar';
import type { ConvectiveCell } from '../sim/types';

interface RadarPanelProps {
  grid: AtmosphericFluidGrid;
  sounding: AtmosphericSounding;
  observerX: number;
  observerZ: number;
  /** Diagnosed convective cells, used to focus the cross-section product. */
  cells?: ConvectiveCell[];
  onClose: () => void;
}

/**
 * Reflectivity product.
 *
 * The panel is a full NEXRAD-style colour ramp over the model's own composite reflectivity —
 * the column maximum, which is what an operational composite map shows. It exists so the
 * simulation's storm structure can be *read*, not just admired: a supercell's hook, a
 * multicell cluster's cold-pool arc, the anvil streaming downshear and the clear notch behind
 * a hail core all become visible in a way they are not in a 3-D view where the camera is
 * inside the weather.
 *
 * Rendering is deliberately a 2-D canvas: no shaders, no GPU cost, ~1 ms per update at 15 fps,
 * and it works identically in the page build.
 */
export const RadarPanel: React.FC<RadarPanelProps> = ({
  grid,
  sounding,
  observerX,
  observerZ,
  cells = [],
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState<'plan' | 'section'>('plan');
  const [stats, setStats] = useState({ maxDbz: -99, cells: 0, maxW: 0 });
  const accumRef = useRef<Float32Array | null>(null);
  const dbzRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const nx = grid.nx;
    const nz = grid.nz;
    if (!accumRef.current || accumRef.current.length !== nx * nz) {
      accumRef.current = new Float32Array(nx * nz);
      dbzRef.current = new Float32Array(nx * nz);
    }
    const dbz = dbzRef.current!;
    const off = document.createElement('canvas');
    off.width = nx;
    off.height = nz;
    const offCtx = off.getContext('2d')!;
    const img = offCtx.createImageData(nx, nz);

    const SEC_COLS = 220;
    const SEC_ROWS = 110;
    const secCanvas = document.createElement('canvas');
    secCanvas.width = SEC_COLS;
    secCanvas.height = SEC_ROWS;
    const secCtx = secCanvas.getContext('2d')!;
    let secImg: ImageData | null = null;

    let raf = 0;
    let last = 0;
    let frame = 0;
    // The composite is a full-column scan of the whole grid (11 ms); the cross-section is a
    // 220x110 raster with a 27-tap stencil each (37 ms). At 4 Hz the section made the panel
    // stutter on the frames it landed on, so it runs at 1.2 Hz — a tower does not change shape
    // in 250 ms — while the plan view keeps the full rate.
    const intervalMs = view === 'section' ? 800 : 250;

    const draw = (time: number) => {
      raf = requestAnimationFrame(draw);
      if (time - last < intervalMs) return;
      last = time;
      frame++;

      // Both products share the composite raster: the plan view draws it, and the section uses
      // it to place its focus point and as the fallback when nothing is rising.
      const raw = renderColumnMax(grid, sounding);
      dbz.set(raw);

      let maxDbz = -99;
      let cellsOver30 = 0;
      let maxW = 0;

      const cssW = canvas.clientWidth || 320;
      const cssH = Math.round(cssW * (view === 'plan' ? 1 : 0.52));
      if (canvas.width !== cssW || canvas.height !== cssH) {
        canvas.width = cssW;
        canvas.height = cssH;
      }

      if (view === 'plan') {
        for (let iz = 0; iz < nz; iz++) {
          for (let ix = 0; ix < nx; ix++) {
            const d = raw[ix + nx * iz];
            const idx = (ix + nx * iz) * 4;
            if (!Number.isFinite(d) || d < 0) {
              img.data[idx] = 6;
              img.data[idx + 1] = 12;
              img.data[idx + 2] = 22;
              img.data[idx + 3] = 255;
              continue;
            }
            if (d > maxDbz) maxDbz = d;
            if (d > 30) cellsOver30++;
            const n = dbzToNorm(d);
            // NEXRAD-ish ramp: greys for light echo, green, yellow, red, magenta for hail.
            const [r, g, b] = ramp(n);
            img.data[idx] = r;
            img.data[idx + 1] = g;
            img.data[idx + 2] = b;
            img.data[idx + 3] = d < 2 ? 0 : 255;
          }
        }
        offCtx.putImageData(img, 0, 0);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#050a12';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // The raster is already in (x, z) order: x runs left to right as column index, z runs
        // top to bottom as row index because the canvas is drawn with z increasing downward.
        // There is deliberately *no* rotation here — the range rings below and the observer
        // marker are placed in exactly these coordinates, and rotating the image under them
        // (as this panel used to) put every storm 90 degrees from its own marker.
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = 0.92;
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        // Range rings every 8 km, plus cardinal ticks.
        ctx.strokeStyle = 'rgba(148, 197, 253, 0.18)';
        ctx.lineWidth = 1;
        for (let ring = 1; ring <= 3; ring++) {
          ctx.beginPath();
          ctx.arc(canvas.width / 2, canvas.height / 2, (ring / 3) * (canvas.width / 2) * 0.92, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(148, 197, 253, 0.10)';
        ctx.beginPath();
        ctx.moveTo(canvas.width / 2, 0);
        ctx.lineTo(canvas.width / 2, canvas.height);
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();

        // Observer marker: same mapping as the raster above.
        const ox = canvas.width / 2 + (observerX / 24000) * (canvas.width / 2);
        const oz = canvas.height / 2 + (observerZ / 24000) * (canvas.height / 2);
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(ox, oz, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(251,191,36,0.5)';
        ctx.beginPath();
        ctx.arc(ox, oz, 7 + ((frame % 12) / 12) * 6, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // Cross-section through the convective core, along the world X axis.
        const core = findStormCore(grid, raw, cells.map((c) => ({ x: c.x, z: c.z })));
        const focusX = core.found ? core.x : observerX;
        const focusZ = core.found ? core.z : observerZ;
        const x0 = Math.max(-23500, focusX - 17000);
        const x1 = Math.min(23500, focusX + 17000);
        const sec = renderSection(grid, sounding, x0, focusZ, x1, focusZ, SEC_COLS, SEC_ROWS, 16000);
        const focusFrac = x1 - x0 > 0 ? (focusX - x0) / (x1 - x0) : 0.5;

        if (!secImg) secImg = secCtx.createImageData(SEC_COLS, SEC_ROWS);
        for (let c = 0; c < SEC_COLS; c++) {
          for (let r = 0; r < SEC_ROWS; r++) {
            const i = c * SEC_ROWS + r;
            const d = sec.dbz[i];
            const w = sec.w[i];
            if (Math.abs(w) > maxW) maxW = Math.abs(w);
            const idx = (c * SEC_ROWS + (SEC_ROWS - 1 - r)) * 4;
            if (!Number.isFinite(d) || d < 0) {
              secImg.data[idx] = 6;
              secImg.data[idx + 1] = 10;
              secImg.data[idx + 2] = 18;
              secImg.data[idx + 3] = 255;
              continue;
            }
            if (d > maxDbz) maxDbz = d;
            const [rr, gg, bb] = ramp(dbzToNorm(d));
            // Blend a faint cyan in for rising motion, so the updraft column is readable
            // through the reflectivity ramp rather than only inferable from the echo shape.
            const lift = Math.max(0, Math.min(1, w / 18));
            secImg.data[idx] = Math.round(rr * (1 - 0.35 * lift) + 40 * 0.35 * lift);
            secImg.data[idx + 1] = Math.round(gg * (1 - 0.35 * lift) + 235 * 0.35 * lift);
            secImg.data[idx + 2] = Math.round(bb * (1 - 0.35 * lift) + 255 * 0.35 * lift);
            secImg.data[idx + 3] = d < 2 ? 0 : 255;
          }
        }
        secCtx.putImageData(secImg, 0, 0);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#050a12';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = 0.95;
        ctx.drawImage(secCanvas, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        // Height gridlines: 4, 8 and 12 km, labelled in the gutter.
        ctx.strokeStyle = 'rgba(148,197,253,0.16)';
        ctx.fillStyle = 'rgba(186,230,253,0.75)';
        ctx.font = '9px ui-monospace, monospace';
        ctx.lineWidth = 1;
        for (const h of [4000, 8000, 12000]) {
          const yPix = canvas.height * (1 - h / 16000);
          ctx.beginPath();
          ctx.moveTo(0, yPix);
          ctx.lineTo(canvas.width, yPix);
          ctx.stroke();
          ctx.fillText(`${h / 1000} km`, 3, yPix - 2);
        }
        // Melting level.
        const meltY = canvas.height * (1 - sounding.instability.freezingLevel / 16000);
        if (meltY > 0 && meltY < canvas.height) {
          ctx.strokeStyle = 'rgba(248,113,113,0.35)';
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(0, meltY);
          ctx.lineTo(canvas.width, meltY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(252,165,165,0.8)';
          ctx.fillText('0 °C', canvas.width - 30, meltY - 2);
        }

        // Mark the storm core the slice is centred on, plus the observer if it is in frame.
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(focusFrac * canvas.width - 1, canvas.height - 10, 2, 10);
        const obFrac = observerX >= x0 && observerX <= x1 ? (observerX - x0) / (x1 - x0) : -1;
        if (obFrac >= 0) {
          ctx.fillStyle = 'rgba(190,220,255,0.85)';
          ctx.fillRect(obFrac * canvas.width - 1, canvas.height - 6, 1, 6);
        }
      }

      // Domain border.
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

      if (frame % 2 === 0) setStats({ maxDbz, cells: cellsOver30, maxW });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [grid, sounding, observerX, observerZ, view, cells]);

  return (
    <aside className="pointer-events-auto w-[19rem] bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-lg p-2 text-[10.5px] text-slate-200 shadow-2xl">
      <div className="flex items-center justify-between pb-1.5 border-b border-white/10">
        <div className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-sky-300 text-[10px]">
          <RadarIcon className="w-3.5 h-3.5" />
          <span>{view === 'plan' ? 'Composite Reflectivity' : 'Cross-Section (RHI)'}</span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-100 text-[10px] px-1"
          title="Hide radar"
        >
          ✕
        </button>
      </div>

      <div className="relative mt-1.5">
        <canvas
          ref={canvasRef}
          className={`w-full rounded border border-white/10 bg-slate-950 ${
            view === 'plan' ? 'aspect-square' : 'aspect-[1.92/1]'
          }`}
        />
        <div className="absolute top-1 left-1 font-mono text-[9px] text-sky-200/80 bg-slate-950/60 px-1 rounded">
          MAX {stats.maxDbz > -90 ? stats.maxDbz.toFixed(0) : '--'} dBZ
        </div>
        <div className="absolute bottom-1 left-1 font-mono text-[9px] text-slate-300/80 bg-slate-950/60 px-1 rounded">
          {view === 'plan'
            ? `${grid.dx.toFixed(0)} m/px · ${((grid.nx * grid.dx) / 1000).toFixed(0)}×${((grid.nz * grid.dz) / 1000).toFixed(0)} km`
            : '34 km × 16 km · w max ' + stats.maxW.toFixed(1) + ' m/s'}
        </div>
      </div>

      {/* dBZ legend */}
      <div className="mt-1.5">
        <div className="h-2 w-full rounded-sm" style={{ background: RAMP_CSS }} />
        <div className="flex justify-between font-mono text-[8.5px] text-slate-400 mt-0.5">
          <span>5</span>
          <span>20</span>
          <span>35</span>
          <span>50</span>
          <span>65</span>
          <span>75</span>
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[9.5px] text-slate-400">
        <span className="flex items-center gap-1">
          <Crosshair className="w-3 h-3" /> {stats.cells} px &gt; 30 dBZ
        </span>
        <button
          onClick={() => setView((v) => (v === 'plan' ? 'section' : 'plan'))}
          className={`px-1.5 py-0.5 rounded border text-[9px] ${
            view === 'section'
              ? 'border-sky-400/60 text-sky-200 bg-sky-500/15'
              : 'border-white/15 text-slate-400 hover:text-slate-200'
          }`}
          title="Toggle plan view / vertical cross-section"
        >
          RHI
        </button>
      </div>

      <p className="mt-1.5 text-[9px] leading-tight text-slate-500">
        {view === 'plan'
          ? 'Column-maximum reflectivity from model condensate with a Marshall–Palmer drop spectrum; bright band and attenuation are included in the radial products.'
          : 'Vertical slice along the world X axis through the column of strongest updraft mass flux. Cyan tint marks rising motion; the dashed line is the melting level.'}
      </p>
    </aside>
  );
};

/** NEXRAD-style reflectivity ramp, returns 8-bit RGB. */
function ramp(n: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [110, 130, 150]],
    [0.12, [70, 190, 200]],
    [0.26, [40, 200, 90]],
    [0.44, [230, 220, 60]],
    [0.62, [240, 140, 40]],
    [0.78, [225, 45, 40]],
    [0.9, [190, 30, 120]],
    [1.0, [245, 235, 255]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (n <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      const t = (n - p0) / Math.max(1e-6, p1 - p0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

const RAMP_CSS =
  'linear-gradient(90deg, #6e8296 0%, #46bec8 12%, #28c85a 26%, #e6dc3c 44%, #f08c28 62%, #e12d28 78%, #be1e78 90%, #f5ebff 100%)';

export const radarDbzFromGrid = (grid: AtmosphericFluidGrid, sounding: AtmosphericSounding) => {
  const raw = renderColumnMax(grid, sounding);
  let max = -99;
  for (let i = 0; i < raw.length; i++) if (raw[i] > max) max = raw[i];
  return { raw, maxDbz: max };
};

export const radarLinear = toDbz;
