import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { useAuth } from '../../contexts/AuthContext';

type HLSPlayerModalProps = ComponentProps<typeof import('../HLSPlayerModal').HLSPlayerModal>;
type MediaDetailsModalProps = ComponentProps<typeof import('../MediaDetailsModal').MediaDetailsModal>;
type AdminPanelProps = ComponentProps<typeof import('../AdminPanel').AdminPanel>;
type ContinueWatchingProps = ComponentProps<typeof import('../ContinueWatching').ContinueWatching>;

const LazyHLSPlayerModal = lazy(() =>
  import('../HLSPlayerModal').then((module) => ({ default: module.HLSPlayerModal })),
);

const LazyMediaDetailsModal = lazy(() =>
  import('../MediaDetailsModal').then((module) => ({ default: module.MediaDetailsModal })),
);

const LazyAdminPanel = lazy(() =>
  import('../AdminPanel').then((module) => ({ default: module.AdminPanel })),
);

const LazyAuthModal = lazy(() =>
  import('../AuthModal').then((module) => ({ default: module.AuthModal })),
);

const LazyContinueWatching = lazy(() =>
  import('../ContinueWatching').then((module) => ({ default: module.ContinueWatching })),
);

function useActivated(active: boolean): boolean {
  const [activated, setActivated] = useState(active);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  return activated;
}

function DeferredOverlayFallback({ label }: { label: string }) {
  return (
    <div
      className="fixed inset-0 z-[140] grid place-items-center bg-black/70 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="rounded-full border border-white/10 bg-zinc-950/90 px-4 py-2 text-xs font-medium text-zinc-300 shadow-2xl">
        {label}
      </div>
    </div>
  );
}

/**
 * Thin lazy facades used only by the public App entrypoint.
 *
 * The original components remain untouched. After the first open we keep
 * stateful overlays mounted (while forwarding isOpen=false) so close/reopen
 * behavior remains identical to the former eager imports.
 */
export function MediaDetailsModal(props: MediaDetailsModalProps) {
  const activated = useActivated(Boolean(props.isOpen));
  if (!activated) return null;

  return (
    <Suspense fallback={props.isOpen ? <DeferredOverlayFallback label="Cargando detalles…" /> : null}>
      <LazyMediaDetailsModal {...props} />
    </Suspense>
  );
}

export function AdminPanel(props: AdminPanelProps) {
  const activated = useActivated(Boolean(props.isOpen));
  if (!activated) return null;

  return (
    <Suspense fallback={props.isOpen ? <DeferredOverlayFallback label="Cargando panel de administración…" /> : null}>
      <LazyAdminPanel {...props} />
    </Suspense>
  );
}

export function HLSPlayerModal(props: HLSPlayerModalProps) {
  const activated = useActivated(Boolean(props.isOpen));
  if (!activated) return null;

  return (
    <Suspense fallback={props.isOpen ? <DeferredOverlayFallback label="Preparando reproductor…" /> : null}>
      <LazyHLSPlayerModal {...props} />
    </Suspense>
  );
}

export function AuthModal() {
  const { isAuthModalOpen } = useAuth();
  const activated = useActivated(isAuthModalOpen);
  if (!activated) return null;

  return (
    <Suspense fallback={isAuthModalOpen ? <DeferredOverlayFallback label="Preparando acceso…" /> : null}>
      <LazyAuthModal />
    </Suspense>
  );
}

export function ContinueWatching(props: ContinueWatchingProps) {
  return (
    <Suspense fallback={null}>
      <LazyContinueWatching {...props} />
    </Suspense>
  );
}
