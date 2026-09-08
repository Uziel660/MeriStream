import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './contexts/AuthContext';
import { HiddenGenresProvider } from './hooks/useHiddenGenres';
import './index.css';
import './styles/streaming-2026.css';

// El panel de administración vive EXCLUSIVAMENTE en /admin (con login).
// Se carga bajo demanda para que el bundle inicial público no incluya la UI administrativa.
const AdminGate = lazy(() => import('./components/AdminGate').then((module) => ({ default: module.AdminGate })));
const isAdminRoute = window.location.pathname.startsWith('/admin');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <AuthProvider>
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
      </ErrorBoundary>
    </MotionConfig>
  </React.StrictMode>
);
