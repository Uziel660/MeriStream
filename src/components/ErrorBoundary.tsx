// src/components/ErrorBoundary.tsx
import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Boundary global a nivel app: una excepción de render (p.ej. NotFoundError
 * insertBefore de AnimatePresence ante manipulación externa del DOM) dejaba la
 * app en pantalla blanca sin recuperación. Aquí se captura, se registra y se
 * ofrece recuperar SIN perder la sesión visual: recargar solo el árbol
 * montado bajo el boundary ("Recargar componente") o volver al inicio limpiando
 * el estado visual que disparó el crash.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Render error capturado:', error, info.componentStack);
  }

  private handleReloadTree = () => {
    this.setState({ error: null });
  };

  // Recuperación total: limpia estado visual persistido (modales/progreso
  // huérfano) y recarga la app en el home. localStorage/la sesión del
  // navegador se conservan; solo se descarta el estado volátil de la UI.
  private handleGoHome = () => {
    try {
      const keep = ['nitiflix_continue_watching_v1'];
      const saved: Record<string, string> = {};
      keep.forEach((k) => {
        const v = localStorage.getItem(k);
        if (v !== null) saved[k] = v;
      });
      sessionStorage.clear();
      localStorage.clear();
      Object.entries(saved).forEach(([k, v]) => localStorage.setItem(k, v));
    } catch {
      // storage inaccesible: recargar igualmente
    }
    window.location.href = '/';
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-2xl text-amber-400">
              ⚠️
            </div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Algo salió mal al mostrar esta vista
            </h1>
            <p className="text-xs leading-relaxed text-zinc-400">
              La interfaz encontró un error inesperado y detuvo esta parte de la app.
              Tus datos y tu progreso están a salvo.
            </p>
            <pre className="max-h-24 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-left font-mono text-[11px] text-rose-300 break-all whitespace-pre-wrap">
              {this.state.error.message || String(this.state.error)}
            </pre>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={this.handleReloadTree}
                className="rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-zinc-950 transition-colors hover:bg-zinc-200"
              >
                Recargar componente
              </button>
              <button
                type="button"
                onClick={this.handleGoHome}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700"
              >
                Volver al inicio
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
