import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AdminGate } from './components/AdminGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './contexts/AuthContext';
import { HiddenGenresProvider } from './hooks/useHiddenGenres';
import './index.css';

// El panel de administración vive EXCLUSIVAMENTE en /admin (con login).
// La página principal ya no expone ningún acceso al panel.
const isAdminRoute = window.location.pathname.startsWith('/admin');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <HiddenGenresProvider>
          {isAdminRoute ? <AdminGate /> : <App />}
        </HiddenGenresProvider>
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
