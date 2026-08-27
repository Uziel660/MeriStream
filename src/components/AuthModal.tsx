// src/components/AuthModal.tsx
import React, { useState } from "react";
import { X, User, Lock, LogIn, UserPlus, Eye, EyeOff, AlertCircle, CheckCircle2 } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

const AVATAR_OPTIONS = [
  { id: "amber", bg: "bg-amber-500", label: "Ámbar Dorado", border: "border-amber-400" },
  { id: "emerald", bg: "bg-emerald-500", label: "Esmeralda", border: "border-emerald-400" },
  { id: "crimson", bg: "bg-red-600", label: "Carmesí", border: "border-red-400" },
  { id: "indigo", bg: "bg-indigo-600", label: "Índigo", border: "border-indigo-400" },
  { id: "rose", bg: "bg-pink-600", label: "Rosa Neón", border: "border-pink-400" },
  { id: "cyan", bg: "bg-cyan-500", label: "Cian", border: "border-cyan-400" },
];

export const AuthModal: React.FC = () => {
  const { isAuthModalOpen, closeAuthModal, login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedAvatar, setSelectedAvatar] = useState("amber");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isAuthModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!username.trim() || !password) {
      setError("Por favor completa todos los campos.");
      return;
    }

    if (username.trim().length < 3) {
      setError("El nombre de usuario debe tener al menos 3 caracteres.");
      return;
    }

    if (password.length < 4) {
      setError("La contraseña debe tener al menos 4 caracteres.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === "login") {
        await login(username.trim(), password);
      } else {
        await register(username.trim(), password, selectedAvatar);
        setSuccessMsg("¡Cuenta creada exitosamente!");
      }
    } catch (err: any) {
      setError(err?.message || "Ocurrió un error. Por favor intenta de nuevo.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAuthModal();
      }}
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-zinc-950/95 border border-zinc-800/80 shadow-2xl shadow-amber-500/10 p-6 sm:p-8">
        {/* Glow de fondo */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-48 w-48 rounded-full bg-amber-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-indigo-500/15 blur-3xl" />

        {/* Botón cerrar */}
        <button
          type="button"
          onClick={closeAuthModal}
          className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-white rounded-full bg-zinc-900/50 hover:bg-zinc-800 transition-colors"
          aria-label="Cerrar modal"
        >
          <X size={18} />
        </button>

        {/* Encabezado */}
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-white tracking-tight font-display">
            {mode === "login" ? "Bienvenido a MeriStream" : "Únete a MeriStream"}
          </h2>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            {mode === "login"
              ? "Accede para sincronizar tu progreso y recomendaciones"
              : "Crea tu cuenta para disfrutar de una experiencia personalizada"}
          </p>
        </div>

        {/* Selector de Pestañas (Login / Registro) */}
        <div className="flex p-1 mb-6 rounded-xl bg-zinc-900/80 border border-zinc-800">
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setError(null);
            }}
            className={`flex-1 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2 ${
              mode === "login"
                ? "bg-amber-500 text-black shadow-md"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <LogIn size={15} />
            Iniciar Sesión
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("register");
              setError(null);
            }}
            className={`flex-1 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2 ${
              mode === "register"
                ? "bg-amber-500 text-black shadow-md"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <UserPlus size={15} />
            Crear Cuenta
          </button>
        </div>

        {/* Mensajes de Alerta / Éxito */}
        {error && (
          <div className="mb-4 flex items-center gap-2.5 p-3 text-xs text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl">
            <AlertCircle size={16} className="shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="mb-4 flex items-center gap-2.5 p-3 text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 rounded-xl">
            <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Formulario */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1.5">
              Usuario
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                <User size={16} />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ej. animefan99"
                required
                autoFocus
                className="w-full pl-10 pr-4 py-2.5 bg-zinc-900/90 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 text-sm focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-1.5">
              Contraseña
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                <Lock size={16} />
              </div>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full pl-10 pr-10 py-2.5 bg-zinc-900/90 border border-zinc-800 rounded-xl text-zinc-100 placeholder-zinc-500 text-sm focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-zinc-500 hover:text-zinc-300"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Selector de Avatar (Solo en Registro) */}
          {mode === "register" && (
            <div>
              <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-2">
                Color de Perfil
              </label>
              <div className="flex items-center gap-3">
                {AVATAR_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSelectedAvatar(opt.id)}
                    className={`h-8 w-8 rounded-full ${opt.bg} transition-all duration-200 ${
                      selectedAvatar === opt.id
                        ? `ring-2 ring-white scale-110 shadow-lg`
                        : "opacity-60 hover:opacity-100 hover:scale-105"
                    }`}
                    title={opt.label}
                  />
                ))}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-2 py-3 px-4 bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-black font-bold text-sm rounded-xl shadow-lg shadow-amber-500/20 transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <span className="inline-block h-4 w-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
            ) : mode === "login" ? (
              <>
                <LogIn size={16} /> Iniciar Sesión
              </>
            ) : (
              <>
                <UserPlus size={16} /> Crear Cuenta Gratis
              </>
            )}
          </button>
        </form>

        {/* Footer simple */}
        <div className="mt-6 pt-4 border-t border-zinc-900 text-center">
          <p className="text-[11px] text-zinc-500">
            Tus datos de visualización se sincronizan de forma segura y privada.
          </p>
        </div>
      </div>
    </div>
  );
};
