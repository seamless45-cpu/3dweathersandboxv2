import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  detail: string | null;
}

/**
 * Last-resort render guard.
 *
 * Without this, any exception thrown while React builds or commits the tree unmounts the entire
 * application and leaves an empty white document — the browser's default background, with no
 * message, no controls and nothing the user can do. A WebGL context that refuses to be created,
 * a driver that loses the context, or one bad value from the simulation all produced exactly that
 * symptom. The boundary converts any of them into a readable, recoverable failure.
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = { error: null, detail: null };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack: it is the difference between "something broke" and a bug report
    // that can actually be acted on.
    this.setState({ detail: info.componentStack ?? null });
    console.error('[MeteoLab] render failed:', error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  public render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="absolute inset-0 z-50 grid place-content-center gap-3 p-6 text-center bg-slate-950 text-slate-200"
      >
        <div className="max-w-lg space-y-2">
          <h1 className="text-base font-semibold text-slate-100">MeteoLab hit an unrecoverable error</h1>
          <p className="text-[12px] leading-relaxed text-slate-400">
            {error.message || 'The renderer stopped unexpectedly.'}
          </p>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Reloading usually clears this. If it keeps happening, check that hardware
            acceleration / WebGL 2 is enabled in your browser.
          </p>
          <button
            onClick={this.reload}
            className="mt-1 px-3 py-1.5 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-[11px] text-sky-100 transition cursor-pointer"
          >
            Reload the simulation
          </button>
          <details className="pt-2 text-left text-[10px] text-slate-500">
            <summary className="cursor-pointer">Technical details</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono leading-tight">
              {error.stack || error.message}
              {this.state.detail ? `\n${this.state.detail}` : ''}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
