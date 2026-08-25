// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AdminGate } from './components/AdminGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// El panel de administración vive EXCLUSIVAMENTE en /admin (con login).
// La página principal ya no expone ningún acceso al panel.
const isAdminRoute = window.location.pathname.startsWith('/admin');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{isAdminRoute ? <AdminGate /> : <App />}</ErrorBoundary>
  </React.StrictMode>
);
