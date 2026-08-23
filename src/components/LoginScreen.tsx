import React, { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { motion } from 'motion/react';

interface LoginScreenProps {
  onLogin: (username: string) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const endpoint = isLoginMode ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Error en la autenticación');
      }

      localStorage.setItem('nitiflix_token', data.token);
      localStorage.setItem('nitiflix_username', data.username);
      onLogin(data.username);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-amber-900/20 via-zinc-950 to-zinc-950 pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-zinc-900/80 backdrop-blur-xl border border-zinc-800 p-8 rounded-2xl shadow-2xl relative z-10"
      >
        <div className="flex items-center justify-center gap-2 mb-8 select-none">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 text-black shadow-md shadow-amber-500/20">
            <Clapperboard size={20} className="stroke-[2.2]" />
          </div>
          <div className="flex flex-col">
            <span className="text-2xl font-bold tracking-tight text-white leading-none">
              NITI<span className="text-amber-400">FLIX</span>
            </span>
            <span className="text-xs tracking-wider text-zinc-400 font-medium mt-0.5">
              Cinema & Anime
            </span>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-white mb-6 text-center">
          {isLoginMode ? 'Iniciar Sesión' : 'Crear Cuenta'}
        </h2>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              required
              placeholder="Nombre de usuario"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>
          <div>
            <input
              type="password"
              required
              placeholder="Contraseña"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-xl px-4 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
          >
            {isLoading ? 'Cargando...' : (isLoginMode ? 'Entrar' : 'Registrarse')}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-zinc-400">
          {isLoginMode ? '¿Nuevo en Nitiflix?' : '¿Ya tienes cuenta?'}
          <button
            type="button"
            onClick={() => setIsLoginMode(!isLoginMode)}
            className="ml-2 text-amber-400 hover:text-amber-300 font-medium transition-colors"
          >
            {isLoginMode ? 'Suscríbete ahora' : 'Inicia sesión'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
