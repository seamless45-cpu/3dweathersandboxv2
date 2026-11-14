import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

interface JoystickVector {
  forward: number;
  strafe: number;
}

interface VirtualJoystickProps {
  onMove: (vector: JoystickVector) => void;
}

const TRAVEL = 42;
const DEAD_ZONE = 0.08;

export function VirtualJoystick({ onMove }: VirtualJoystickProps) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const reset = useCallback(() => {
    pointerIdRef.current = null;
    setOffset({ x: 0, y: 0 });
    onMove({ forward: 0, strafe: 0 });
  }, [onMove]);

  useEffect(() => () => onMove({ forward: 0, strafe: 0 }), [onMove]);

  const move = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId || !baseRef.current) return;
    event.preventDefault();
    const rect = baseRef.current.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    const scale = length > TRAVEL ? TRAVEL / length : 1;
    const x = dx * scale;
    const y = dy * scale;
    let strafe = x / TRAVEL;
    let forward = -y / TRAVEL;
    if (Math.hypot(strafe, forward) < DEAD_ZONE) {
      strafe = 0;
      forward = 0;
    }
    setOffset({ x, y });
    onMove({ forward, strafe });
  }, [onMove]);

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event);
  };

  return (
    <div className="pointer-events-auto fixed left-4 bottom-[76px] z-30 flex flex-col items-center gap-1.5 select-none">
      <div
        ref={baseRef}
        role="application"
        aria-label="Virtual movement joystick. Drag in a direction to walk."
        className="relative h-28 w-28 rounded-full border border-white/35 bg-slate-950/45 shadow-lg backdrop-blur-sm touch-none"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={reset}
        onPointerCancel={reset}
        onLostPointerCapture={reset}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15" />
        <div
          className="absolute left-1/2 top-1/2 h-11 w-11 rounded-full border border-sky-100/70 bg-sky-400/70 shadow-md"
          style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
        />
      </div>
      <div className="rounded bg-slate-950/70 px-2 py-0.5 text-[9px] font-mono text-slate-200 backdrop-blur-sm">
        MOVE · 120 km/h
      </div>
    </div>
  );
}
