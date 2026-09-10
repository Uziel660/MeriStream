import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { InterfaceStyleBridge } from './components/InterfaceStyleBridge';
import { AuthProvider } from './contexts/AuthContext';
import { HiddenGenresProvider } from './hooks/useHiddenGenres';
import './index.css';
import './styles/streaming-2026.css';
import './styles/overlays-2026.css';
import './styles/immersive-stremio.css';
import './styles/polish-round.css';
import './styles/player-2026.css';
import './styles/interface-presets.css';
import './styles/light-mode.css';

// El panel de administración vive EXCLUSIVAMENTE en /admin y se carga bajo
// demanda; la entrada pública conserva el bundle de providers y reproducción.
const AdminGate = lazy(() => import('./components/AdminGate').then((module) => ({ default: module.AdminGate })));

// El panel de administración vive EXCLUSIVAMENTE en /admin (con login).
// La página principal ya no expone ningún acceso al panel.
const isAdminRoute = window.location.pathname.startsWith('/admin');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user"><ErrorBoundary>
      <AuthProvider>
        <InterfaceStyleBridge />
        <HiddenGenresProvider>
          {isAdminRoute ? (
            <Suspense fallback={<div className="ms-route-loader" role="status" aria-label="Cargando administración" />}>
              <AdminGate />
            </Suspense>
          ) : (
            <App />
          )}
        </HiddenGenresProvider>
      </AuthProvider>
    </ErrorBoundary></MotionConfig>
  </React.StrictMode>
);
