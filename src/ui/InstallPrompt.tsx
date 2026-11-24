import { useState } from 'react';
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import {
  applyUpdate,
  canInstall,
  isIosSafari,
  promptInstall,
  subscribePwa,
  getPwaSnapshot,
} from '../pwa';
import { useSyncExternalStore } from 'react';

/**
 * The app's install / offline / update affordances, in one bottom-centre strip.
 *
 * Three unrelated states share one component because they are mutually exclusive in practice
 * and all transient: a browser can offer to install, or the app can be running from cache with
 * no connection, or a new build can be waiting. Stacking three separate toasts in the same corner
 * would be worse UI than a single line that changes what it says.
 */
export function InstallPrompt() {
  const pwa = useSyncExternalStore(subscribePwa, getPwaSnapshot, getPwaSnapshot);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const installable = canInstall() && pwa.installState === 'available';
  // iOS has no install API, so it gets instructions instead of a button — but only once, and only
  // while the app is not already running from the home screen.
  const manualInstall =
    isIosSafari() && pwa.installState !== 'installed' && pwa.installState !== 'dismissed';
  const showOffline = pwa.offline;
  const showUpdate = pwa.updateReady;

  if (hidden || (!installable && !manualInstall && !showOffline && !showUpdate)) return null;

  // Update takes priority: it is actionable and time-sensitive. Offline is informational.
  if (showUpdate) {
    return (
      <Shell tone="sky">
        <RefreshCw className="w-3.5 h-3.5 shrink-0" />
        <span className="text-[11px]">
          <span className="font-semibold">A new build is ready.</span>{' '}
          <span className="text-slate-300/80">
            {pwa.offline ? 'Reconnect to load it.' : 'Reload to update.'}
          </span>
        </span>
        <button
          onClick={() => applyUpdate()}
          disabled={pwa.offline}
          className="px-2 py-0.5 rounded bg-sky-500/90 hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-semibold text-[10px] transition cursor-pointer"
        >
          Reload
        </button>
        <DismissButton onDismiss={() => setHidden(true)} />
      </Shell>
    );
  }

  if (installable) {
    return (
      <Shell tone="emerald">
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span className="text-[11px]">
          <span className="font-semibold">Install MeteoLab</span>{' '}
          <span className="text-slate-300/80">for offline use and a full-screen window.</span>
        </span>
        <button
          onClick={async () => {
            setBusy(true);
            await promptInstall();
            setBusy(false);
          }}
          disabled={busy}
          className="px-2 py-0.5 rounded bg-emerald-500/90 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold text-[10px] transition cursor-pointer"
        >
          {busy ? '…' : 'Install'}
        </button>
        <DismissButton onDismiss={() => setHidden(true)} />
      </Shell>
    );
  }

  if (manualInstall) {
    return (
      <Shell tone="emerald">
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span className="text-[11px]">
          <span className="font-semibold">Add to Home Screen</span>{' '}
          <span className="text-slate-300/80">
            — tap Share, then “Add to Home Screen”.
          </span>
        </span>
        <DismissButton onDismiss={() => setHidden(true)} />
      </Shell>
    );
  }

  // Offline: informational only, and it clears itself when the connection returns.
  return (
    <Shell tone="amber">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span className="text-[11px]">
        <span className="font-semibold">Offline.</span>{' '}
        <span className="text-slate-300/80">Running the cached build; the simulation is local, so nothing else changes.</span>
      </span>
    </Shell>
  );
}

const TONES = {
  sky: 'border-sky-400/35 bg-sky-950/80 text-sky-100',
  emerald: 'border-emerald-400/35 bg-emerald-950/80 text-emerald-100',
  amber: 'border-amber-400/35 bg-amber-950/80 text-amber-100',
} as const;

function Shell({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <div
      className={`pointer-events-auto flex items-center gap-2 px-2.5 py-1.5 rounded-lg backdrop-blur-md border shadow-lg shadow-black/40 ${TONES[tone]}`}
      role="status"
      aria-live="polite"
    >
      {children}
    </div>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      onClick={onDismiss}
      aria-label="Dismiss"
      title="Dismiss"
      className="ml-0.5 p-0.5 rounded text-slate-400 hover:text-slate-100 hover:bg-white/10 transition cursor-pointer"
    >
      <X className="w-3 h-3" />
    </button>
  );
}
