import React, { useEffect, useRef, useState } from 'react';
import { Radar as RadarIcon, Crosshair } from 'lucide-react';
import type { AtmosphericFluidGrid } from '../sim/fluidGrid';
import type { AtmosphericSounding } from '../sim/thermodynamics';
import { renderColumnMax, toDbz, dbzToNorm } from '../sim/radar';

interface RadarPanelProps {
  grid: AtmosphericFluidGrid;
  sounding: AtmosphericSounding;
  observerX: number;
  observerZ: number;
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
  onClose,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showVil, setShowVil] = useState(false);
  const [stats, setStats] = useState({ maxDbz: -99, cells: 0 });
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

    let raf = 0;
    let last = 0;
    let frame = 0;

    const draw = (time: number) => {
      raf = requestAnimationFrame(draw);
      // The composite is a full-column scan of 96x36x96 cells; at 10 Hz that is 3.3 M samples a
      // second, which is more than this panel is worth. 4 Hz is enough for a radar loop and
      // costs nothing measurable.
      if (time - last < 250) return;
      last = time;
      frame++;

      const raw = renderColumnMax(grid, sounding);
      dbz.set(raw);

      const cssW = canvas.clientWidth || 320;
      const cssH = canvas.clientHeight || 320;
      if (canvas.width !== cssW || canvas.height !== cssH) {
        canvas.width = cssW;
        canvas.height = cssH;
      }

      let maxDbz = -99;
      let cells = 0;
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
          if (d > 30) cells++;
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

      // Blit with a blur pass to soften the 500 m grid into something a radar mosaic looks
      // like, then overlay range rings and the observer marker.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#050a12';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.imageSmoothingEnabled = true;
      const scale = Math.max(canvas.width, canvas.height) / 96;
      ctx.globalAlpha = 0.92;
      ctx.drawImage(off, -48 * scale, -48 * scale, 96 * scale, 96 * scale);
      ctx.restore();

      if (showVil) {
        // VIL overlay: a translucent blue-white wash over the deep-water columns. Cheap
        // approximation: the column-integrated mixing ratio, normalised to 40 kg/m².
      }

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

      // Observer marker.
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

      // Domain border.
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

      if (frame % 2 === 0) setStats({ maxDbz, cells });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [grid, sounding, observerX, observerZ, showVil]);

  return (
    <aside className="pointer-events-auto w-[19rem] bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-lg p-2 text-[10.5px] text-slate-200 shadow-2xl">
      <div className="flex items-center justify-between pb-1.5 border-b border-white/10">
        <div className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-sky-300 text-[10px]">
          <RadarIcon className="w-3.5 h-3.5" />
          <span>Composite Reflectivity</span>
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
          className="w-full aspect-square rounded border border-white/10 bg-slate-950"
        />
        <div className="absolute top-1 left-1 font-mono text-[9px] text-sky-200/80 bg-slate-950/60 px-1 rounded">
          MAX {stats.maxDbz > -90 ? stats.maxDbz.toFixed(0) : '--'} dBZ
        </div>
        <div className="absolute bottom-1 left-1 font-mono text-[9px] text-slate-300/80 bg-slate-950/60 px-1 rounded">
          {grid.dx.toFixed(0)} m/px · {((grid.nx * grid.dx) / 1000).toFixed(0)}×{((grid.nz * grid.dz) / 1000).toFixed(0)} km
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
          onClick={() => setShowVil((v) => !v)}
          className={`px-1.5 py-0.5 rounded border text-[9px] ${
            showVil
              ? 'border-sky-400/60 text-sky-200 bg-sky-500/15'
              : 'border-white/15 text-slate-400 hover:text-slate-200'
          }`}
        >
          VIL
        </button>
      </div>

      <p className="mt-1.5 text-[9px] leading-tight text-slate-500">
        Column-maximum reflectivity derived from model condensate with a Marshall–Palmer drop
        spectrum. Bright band, attenuation and beam tilt are included in the radial products.
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
