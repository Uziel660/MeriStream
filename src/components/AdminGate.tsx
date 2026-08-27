// src/components/AdminGate.tsx
// Entrada exclusiva del panel de administración en /admin.
// Login super-simple validado contra el backend; la sesión vive en sessionStorage.

import React, { useState } from 'react';
import { Shield, Loader2 } from 'lucide-react';
import { AdminPanel } from './AdminPanel';

export const AdminGate: React.FC = () => {
  const [authed, setAuthed] = useState<boolean>(
    (() => {
      try {
        return sessionStorage.getItem('voidstream_admin_auth') === '1';
      } catch {
        return false;
      }
    })()
  );
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password: pass }),
      });
      if (res.ok) {
        try {
          sessionStorage.setItem('voidstream_admin_auth', '1');
        } catch {}
        setAuthed(true);
      } else {
        setError('Usuario o contraseña incorrectos');
      }
    } catch {
      setError('No se pudo conectar con el servidor');
    } finally {
      setChecking(false);
    }
  };

  if (authed) {
    return (
      <AdminPanel
        isOpen={true}
        onClose={() => {
          window.location.href = '/';
        }}
        onPlayDirect={(streamResult: any) => {
          const url =
            streamResult?.stream_url ||
            (Array.isArray(streamResult?.all_available_streams) ? streamResult.all_available_streams[0] : null);
          if (url) window.open(url, '_blank');
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <form
        onSubmit={login}
        className="w-full max-w-sm p-6 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl space-y-4"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Shield size={18} />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">MeriStream · Admin</h1>
            <p className="text-[11px] text-zinc-500">Acceso restringido</p>
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1">Usuario</label>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoFocus
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1">Contraseña</label>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
          />
        </div>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={checking || !user || !pass}
          className="w-full px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 text-xs font-bold flex items-center justify-center gap-2 transition-colors"
        >
          {checking && <Loader2 size={13} className="animate-spin" />}
          Entrar
        </button>
      </form>
    </div>
  );
};
