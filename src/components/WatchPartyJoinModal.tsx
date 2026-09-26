// src/components/WatchPartyJoinModal.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { X, Users, PlusCircle, LogIn, Film, AlertCircle, Loader2 } from 'lucide-react';
import { getAuthToken } from '../api/client';
import { isNativeShell, nativeHaptic } from '../utils/runtime';

export interface WatchPartyJoinModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoin?: (roomCode: string) => void;
  onJoinRoom?: (roomCode: string) => Promise<void> | void;
  onCreateRoom?: () => Promise<string> | string;
  isAuthenticated?: boolean;
  onRequireAuth?: () => void;
  media?: {
    title?: string;
    posterUrl?: string | null;
    poster_url?: string | null;
    kind?: string | null;
    showId?: string | null;
    episodeId?: string | null;
    episodeNumber?: number | null;
    streamUrl?: string | null;
    tmdbId?: string | number | null;
    serverId?: string | null;
    sourceSite?: string | null;
    provider?: string | null;
    canonicalLocator?: string | null;
  } | null;
}

export function WatchPartyJoinModal({
  isOpen,
  onClose,
  onJoin,
  onJoinRoom,
  onCreateRoom,
  isAuthenticated,
  onRequireAuth,
  media,
}: WatchPartyJoinModalProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const nativeShell = isNativeShell();

  const closeSheet = useCallback(() => {
    if (nativeShell && window.history.state?.meristream_native_overlay === 'watch-party-join' && window.history.length > 1) {
      window.history.back();
      return;
    }
    closeSheet();
  }, [nativeShell, onClose]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setJoinCode('');
      setErrorMessage(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !nativeShell) return;
    if (window.history.state?.meristream_native_overlay !== 'watch-party-join') {
      window.history.pushState({ ...(window.history.state || {}), meristream_native_overlay: 'watch-party-join' }, '');
    }
    const onPopState = () => closeSheet();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isOpen, nativeShell, onClose]);

  // Keyboard escape handler
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSheet();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeSheet]);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setJoinCode(sanitized);
    if (errorMessage) setErrorMessage(null);
  };

  const handleCreateRoom = useCallback(async () => {
    nativeHaptic();
    setErrorMessage(null);
    setIsSubmitting(true);

    if (onCreateRoom) {
      try {
        const code = await onCreateRoom();
        if (code) {
          if (onJoinRoom) await onJoinRoom(code);
          if (onJoin) onJoin(code);
          closeSheet();
        }
      } catch (err: any) {
        setErrorMessage(err?.message || 'Error al crear la sala.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const token = getAuthToken();
    if (isAuthenticated === false || (!token && isAuthenticated === undefined)) {
      if (onRequireAuth) {
        onRequireAuth();
        setIsSubmitting(false);
        return;
      }
      setErrorMessage('Debes iniciar sesión para crear una sala de Watch Party.');
      setIsSubmitting(false);
      return;
    }

    try {
      const mediaPayload = {
        title: media?.title || 'Reproducción en Vivo',
        kind: media?.kind || 'movie',
        posterUrl: media?.posterUrl || media?.poster_url || null,
        showId: media?.showId || null,
        episodeId: media?.episodeId || null,
        episodeNumber: media?.episodeNumber || null,
        streamUrl: media?.streamUrl || null,
        tmdbId: media?.tmdbId || null,
        serverId: media?.serverId || null,
        sourceSite: media?.sourceSite || null,
        provider: media?.provider || null,
        canonicalLocator: media?.canonicalLocator || null,
      };

      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ media: mediaPayload }),
      });

      if (!res.ok) {
        let msg = `Error ${res.status}`;
        try {
          const errData = await res.json();
          msg = errData.message || errData.error || msg;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const data = await res.json();
      const code = data.roomCode || data.room?.roomCode || data.code;
      if (!code) {
        throw new Error('No se recibió el código de la sala creada.');
      }

      if (onJoinRoom) await onJoinRoom(code);
      if (onJoin) onJoin(code);
      closeSheet();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Error al crear la sala. Inténtalo de nuevo.');
    } finally {
      setIsSubmitting(false);
    }
  }, [media, onCreateRoom, onJoin, onJoinRoom, closeSheet, isAuthenticated, onRequireAuth]);

  const handleJoinRoom = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      const code = joinCode.trim().toUpperCase();
      if (code.length !== 6) return;

      setErrorMessage(null);
      setIsSubmitting(true);

      if (onJoinRoom) {
        try {
          await onJoinRoom(code);
          if (onJoin) onJoin(code);
          closeSheet();
        } catch (err: any) {
          setErrorMessage(err?.message || 'Error al unirse a la sala.');
        } finally {
          setIsSubmitting(false);
        }
        return;
      }

      const token = getAuthToken();
      if (isAuthenticated === false || (!token && isAuthenticated === undefined)) {
        if (onRequireAuth) {
          onRequireAuth();
          setIsSubmitting(false);
          return;
        }
        setErrorMessage('Debes iniciar sesión para unirte a una sala de Watch Party.');
        setIsSubmitting(false);
        return;
      }

      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.status === 404) {
          throw new Error('La sala especificada no existe o ha expirado.');
        } else if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || body.error || 'La sala está llena (máximo 20 participantes) o no tienes acceso.');
        } else if (!res.ok) {
          let msg = `Error ${res.status}`;
          try {
            const errData = await res.json();
            msg = errData.message || errData.error || msg;
          } catch {}
          throw new Error(msg);
        }

        if (onJoin) onJoin(code);
        closeSheet();
      } catch (err: any) {
        if (err?.message?.includes('no existe') || err?.message?.includes('llena') || err?.message?.includes('expirado')) {
          setErrorMessage(err.message);
        } else {
          // If network or fallback, allow joining via onJoin
          if (onJoin) onJoin(code);
          closeSheet();
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [joinCode, onJoinRoom, onJoin, closeSheet, isAuthenticated, onRequireAuth]
  );

  if (!isOpen) return null;

  const posterImage = media?.posterUrl || media?.poster_url || null;
  const mediaTitle = media?.title || 'Contenido actual';

  return (
    <div
      data-testid="watch-party-join-modal"
      className="watch-party-join-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSheet();
      }}
    >
      <div
        className="watch-party-join-panel relative w-full max-w-md bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl text-zinc-100 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Title and Close Button */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/80 bg-zinc-900/40">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/25">
              <Users size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">Watch Party</h2>
              <p className="text-xs text-zinc-400">Mira contenido en tiempo real con tus amigos</p>
            </div>
          </div>

          <button
            type="button"
            onClick={closeSheet}
            data-testid="close-modal-button"
            aria-label="Cerrar modal"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="p-4 pb-0">
          <div className="flex rounded-xl bg-zinc-900 p-1 border border-zinc-800/80">
            <button
              type="button"
              onClick={() => {
                nativeHaptic(4);
                setActiveTab('create');
                setErrorMessage(null);
              }}
              data-testid="tab-create-room"
              className={`flex-1 py-2 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${
                activeTab === 'create'
                  ? 'bg-amber-500 text-zinc-950 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <PlusCircle size={14} />
              Crear Sala
            </button>
            <button
              type="button"
              onClick={() => {
                nativeHaptic(4);
                setActiveTab('join');
                setErrorMessage(null);
              }}
              data-testid="tab-join-room"
              className={`flex-1 py-2 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${
                activeTab === 'join'
                  ? 'bg-amber-500 text-zinc-950 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <LogIn size={14} />
              Unirse a Sala
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5">
          {/* Error Message Toast */}
          {errorMessage && (
            <div
              data-testid="modal-error-message"
              className="mb-4 flex items-start gap-2 rounded-xl bg-rose-950/40 border border-rose-800/50 p-3 text-xs text-rose-300"
            >
              <AlertCircle size={15} className="text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {activeTab === 'create' ? (
            /* =============================================================== */
            /* TAB: CREAR SALA                                                 */
            /* =============================================================== */
            <div className="space-y-4">
              {/* Media Preview Card */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
                {posterImage ? (
                  <img
                    src={posterImage}
                    alt={mediaTitle}
                    className="w-12 h-16 object-cover rounded-lg shadow-sm shrink-0"
                  />
                ) : (
                  <div className="w-12 h-16 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0 text-zinc-500">
                    <Film size={20} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                    {media?.kind === 'tv' || media?.kind === 'series'
                      ? 'Serie'
                      : media?.kind === 'anime'
                      ? 'Anime'
                      : 'Película'}
                  </span>
                  <h4 className="text-sm font-semibold text-white truncate">{mediaTitle}</h4>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Serás el anfitrión y controlarás la reproducción de todos.
                  </p>
                </div>
              </div>

              <p className="px-1 text-xs leading-relaxed text-zinc-400">
                El anfitrión controla la reproducción y el resto de la sala recibe los cambios de forma sincronizada.
              </p>

              {/* Create Button */}
              <button
                type="button"
                onClick={handleCreateRoom}
                disabled={isSubmitting}
                data-testid="create-room-submit-button"
                className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 font-semibold text-sm text-zinc-950 transition flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Creando sala...</span>
                  </>
                ) : (
                  <>
                    <PlusCircle size={16} />
                    <span>Crear Sala de Watch Party</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            /* =============================================================== */
            /* TAB: UNIRSE A SALA                                              */
            /* =============================================================== */
            <form onSubmit={handleJoinRoom} className="space-y-4">
              <div>
                <label
                  htmlFor="watch-party-code-input"
                  className="block text-xs font-medium text-zinc-300 mb-1.5"
                >
                  Código de la sala (6 caracteres)
                </label>
                <input
                  id="watch-party-code-input"
                  type="text"
                  value={joinCode}
                  onChange={handleCodeChange}
                  data-testid="room-code-input"
                  placeholder="EJEMPLO"
                  maxLength={6}
                  autoFocus
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  className="w-full text-center font-mono text-xl sm:text-2xl tracking-[0.3em] uppercase py-3 px-4 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-zinc-600 focus:outline-none focus:border-amber-400 transition"
                />
                <p className="text-[11px] text-zinc-500 mt-1.5 text-center">
                  Introduce el código alfanumérico proporcionado por el anfitrión.
                </p>
              </div>

              <button
                type="submit"
                disabled={joinCode.length !== 6 || isSubmitting}
                data-testid="join-room-submit-button"
                className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm text-zinc-950 transition flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Conectando...</span>
                  </>
                ) : (
                  <>
                    <LogIn size={16} />
                    <span>Unirse a la Sala</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
