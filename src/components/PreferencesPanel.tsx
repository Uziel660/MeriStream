import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Eye, EyeOff, Gauge, Palette, Play, Server, X } from 'lucide-react';
import {
  APP_PREFERENCES_EVENT,
  DEFAULT_APP_PREFERENCES,
  getAppPreferences,
  saveAppPreferences,
  type AppPreferences,
  type InterfaceStyle,
  type PerformanceMode,
  type PreferredQuality,
  type SubtitlePosition,
} from '../utils/appPreferences';

interface PreferencesPanelProps {
  userId?: string | null;
  canViewIdentityDetails?: boolean;
  onClose: () => void;
}

const LANGUAGE_OPTIONS = [
  ['es-419', 'Español latino'],
  ['es-ES', 'Castellano'],
  ['es', 'Español (genérico)'],
  ['en', 'Inglés'],
  ['ja', 'Japonés'],
  ['ko', 'Coreano'],
  ['zh', 'Chino'],
  ['pt', 'Portugués'],
] as const;

const INTERFACE_STYLES: Array<{ value: InterfaceStyle; label: string; description: string }> = [
  { value: 'cinematic', label: 'Cinemático', description: 'La identidad actual de MeriStream: oscura, cálida y enfocada en el contenido.' },
  { value: 'glass', label: 'Glass', description: 'Cristal suave, superficies flotantes y una sensación más ligera y moderna.' },
  { value: 'noir', label: 'Noir', description: 'Minimalista y editorial: menos brillo, líneas más rectas y máximo foco.' },
  { value: 'aurora', label: 'Aurora', description: 'Cian y violeta, más profundidad y acentos luminosos sin perder legibilidad.' },
];

export function PreferencesPanel({ userId, canViewIdentityDetails = false, onClose }: PreferencesPanelProps) {
  const [preferences, setPreferences] = useState<AppPreferences>(() => getAppPreferences(userId));
  const [showTmdbKey, setShowTmdbKey] = useState(false);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (!detail?.userId || detail.userId === String(userId || 'guest')) setPreferences(getAppPreferences(userId));
    };
    window.addEventListener(APP_PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, sync);
  }, [userId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      document.documentElement.dataset.msStyle = getAppPreferences(userId).interfaceStyle;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, userId]);

  // The header is sticky and uses backdrop-filter. Rendering the dialog inside
  // it makes `position: fixed` inherit the header's containing block in some
  // browsers, leaving the panel pinned to the top of the page. Keep the modal
  // in the document root and lock the page behind it while it is open.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const toggleLanguage = (field: 'preferredLanguages' | 'preferredSubtitleLanguages', language: string) => {
    setPreferences((current) => {
      const values = current[field].includes(language)
        ? current[field].filter((item) => item !== language)
        : [...current[field], language];
      return { ...current, [field]: values };
    });
  };

  const previewInterfaceStyle = (style: InterfaceStyle) => {
    setPreferences((current) => ({ ...current, interfaceStyle: style }));
    document.documentElement.dataset.msStyle = style;
  };

  const closeWithoutSaving = () => {
    document.documentElement.dataset.msStyle = getAppPreferences(userId).interfaceStyle;
    onClose();
  };

  const save = () => {
    saveAppPreferences(userId, preferences);
    onClose();
  };

  const restoreDefaults = () => {
    setPreferences({ ...DEFAULT_APP_PREFERENCES });
    document.documentElement.dataset.msStyle = DEFAULT_APP_PREFERENCES.interfaceStyle;
  };

  return createPortal((
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preferences-title"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeWithoutSaving(); }}
    >
      <section className="my-auto w-full max-w-xl max-h-[min(94dvh,46rem)] min-h-0 overflow-y-auto overscroll-contain rounded-2xl border border-zinc-700/80 bg-zinc-950 p-5 text-zinc-100 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">MeriStream</p>
            <h2 id="preferences-title" className="mt-1 text-xl font-semibold">Preferencias</h2>
            <p className="mt-1 text-xs text-zinc-400">Apariencia, reproducción, idiomas y rendimiento. Se guardan por perfil en este dispositivo.</p>
          </div>
          <button type="button" className="rounded-full p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={closeWithoutSaving} aria-label="Cerrar preferencias"><X size={18} /></button>
        </div>

        <div className="mt-6 space-y-7">
          <fieldset>
            <legend className="flex items-center gap-2 text-sm font-semibold"><Palette size={16} className="text-amber-400" />Estilo de interfaz</legend>
            <p className="mt-1 text-xs text-zinc-500">Cambia la apariencia completa de MeriStream al instante. Se guarda solo al pulsar “Guardar preferencias”.</p>
            <div className="interface-style-grid">
              {INTERFACE_STYLES.map((style) => {
                const checked = preferences.interfaceStyle === style.value;
                return (
                  <button
                    key={style.value}
                    type="button"
                    className="interface-style-choice"
                    aria-pressed={checked}
                    onClick={() => previewInterfaceStyle(style.value)}
                  >
                    <span className="interface-style-preview" data-preview={style.value} aria-hidden="true"><span /></span>
                    <span className="interface-style-copy">
                      <span><strong>{style.label}</strong><small>{style.description}</small></span>
                      {checked && <Check size={15} className="interface-style-check" aria-hidden="true" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">Idiomas de audio prioritarios</legend>
            <p className="mt-1 text-xs text-zinc-500">MeriStream ordenará primero estas pistas y fuentes cuando estén disponibles.</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {LANGUAGE_OPTIONS.map(([value, label]) => {
                const checked = preferences.preferredLanguages.includes(value);
                return <button key={`audio-${value}`} type="button" onClick={() => toggleLanguage('preferredLanguages', value)} aria-pressed={checked} className={`flex min-h-10 items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${checked ? 'border-amber-400/60 bg-amber-400/10 text-amber-100' : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600'}`}><span>{label}</span>{checked && <Check size={14} />}</button>;
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">Subtítulos prioritarios</legend>
            <p className="mt-1 text-xs text-zinc-500">Las pistas preferidas aparecen primero; las demás siguen disponibles bajo “ver más”.</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {LANGUAGE_OPTIONS.map(([value, label]) => {
                const checked = preferences.preferredSubtitleLanguages.includes(value);
                return <button key={`sub-${value}`} type="button" onClick={() => toggleLanguage('preferredSubtitleLanguages', value)} aria-pressed={checked} className={`flex min-h-10 items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${checked ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-100' : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600'}`}><span>{label}</span>{checked && <Check size={14} />}</button>;
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">Calidad inicial
              <select value={preferences.defaultQuality} onChange={(event) => setPreferences((current) => ({ ...current, defaultQuality: event.target.value as PreferredQuality }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                <option value="auto">Automática</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option>
              </select>
            </label>
            <label className="text-sm font-semibold">Posición de subtítulos
              <select value={preferences.subtitlePosition} onChange={(event) => setPreferences((current) => ({ ...current, subtitlePosition: event.target.value as SubtitlePosition }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                <option value="bottom">Abajo</option><option value="center">Centro</option><option value="top">Arriba</option><option value="custom">Personalizada</option>
              </select>
            </label>
          </div>

          {preferences.subtitlePosition === 'custom' && (
            <fieldset className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <legend className="px-1 text-sm font-semibold text-emerald-100">Ubicación personalizada</legend>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">Mueve el centro de los subtítulos dentro del vídeo. Los límites dejan un margen para que sigan siendo cómodos en móvil.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-xs font-medium text-zinc-300">
                  Horizontal: {preferences.subtitlePositionX}%
                  <input type="range" min="8" max="92" step="1" value={preferences.subtitlePositionX} onChange={(event) => setPreferences((current) => ({ ...current, subtitlePositionX: Number(event.target.value) }))} className="mt-2 w-full accent-emerald-400" aria-label="Posición horizontal de subtítulos" />
                  <span className="mt-1 flex justify-between text-[10px] text-zinc-600"><span>Izquierda</span><span>Derecha</span></span>
                </label>
                <label className="text-xs font-medium text-zinc-300">
                  Vertical: {preferences.subtitlePositionY}%
                  <input type="range" min="8" max="92" step="1" value={preferences.subtitlePositionY} onChange={(event) => setPreferences((current) => ({ ...current, subtitlePositionY: Number(event.target.value) }))} className="mt-2 w-full accent-emerald-400" aria-label="Posición vertical de subtítulos" />
                  <span className="mt-1 flex justify-between text-[10px] text-zinc-600"><span>Arriba</span><span>Abajo</span></span>
                </label>
              </div>
            </fieldset>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">Tamaño de subtítulos
              <select value={preferences.subtitleScale} onChange={(event) => setPreferences((current) => ({ ...current, subtitleScale: event.target.value as AppPreferences['subtitleScale'] }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                <option value="small">Pequeño</option><option value="normal">Normal</option><option value="large">Grande</option>
              </select>
            </label>
            <label className="text-sm font-semibold">Perfil de rendimiento
              <span className="relative mt-2 block">
                <Gauge size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <select value={preferences.performanceMode} onChange={(event) => setPreferences((current) => ({ ...current, performanceMode: event.target.value as PerformanceMode }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2.5 pl-9 pr-3 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                  <option value="auto">Automático</option><option value="quality">Calidad visual</option><option value="balanced">Equilibrado</option><option value="low">Dispositivo de gama baja</option>
                </select>
              </span>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-xs text-zinc-300">
              <span className="flex gap-2"><Play size={16} className="mt-0.5 shrink-0 text-amber-400 fill-amber-400/20" /><span><strong className="block text-sm text-zinc-100">Autoplay de episodios</strong><span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">Reproduce automáticamente el siguiente episodio al finalizar el actual.</span></span></span>
              <input type="checkbox" checked={preferences.autoPlayNextEpisode} onChange={(event) => setPreferences((current) => ({ ...current, autoPlayNextEpisode: event.target.checked }))} className="h-4 w-4 shrink-0 accent-amber-400" />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-xs text-zinc-300">
              <span className="flex gap-2"><Server size={16} className="mt-0.5 shrink-0 text-amber-400" /><span><strong className="block text-sm text-zinc-100">Mostrar selector de servidores</strong><span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">Mantiene visible el cambio manual de fuente incluso con una sola opción.</span></span></span>
              <input type="checkbox" checked={preferences.showServerSelector} onChange={(event) => setPreferences((current) => ({ ...current, showServerSelector: event.target.checked }))} className="h-4 w-4 shrink-0 accent-amber-400" />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-xs text-zinc-300 sm:col-span-2">
              <span><strong className="block text-sm text-zinc-100">Reducir animaciones</strong><span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">Reduce movimiento decorativo sin afectar el video.</span></span>
              <input type="checkbox" checked={preferences.reduceMotion} onChange={(event) => setPreferences((current) => ({ ...current, reduceMotion: event.target.checked }))} className="h-4 w-4 shrink-0 accent-amber-400" />
            </label>
          </div>

          <fieldset>
            <legend className="text-sm font-semibold">Catálogo y accesibilidad</legend>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold">Contraste de interfaz
                <select value={preferences.contrast} onChange={(event) => setPreferences((current) => ({ ...current, contrast: event.target.value as AppPreferences['contrast'] }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                  <option value="standard">Estándar</option><option value="high">Alto contraste</option>
                </select>
              </label>
              <label className="text-sm font-semibold">Clave personal de TMDB
                <span className="mb-2 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs font-normal text-zinc-300">
                  <input
                    type="checkbox"
                    checked={preferences.tmdbApiKeyEnabled}
                    onChange={(event) => setPreferences((current) => ({ ...current, tmdbApiKeyEnabled: event.target.checked }))}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
                    aria-describedby="tmdb-key-help"
                  />
                  <span><strong className="block text-zinc-100">Activar clave personal</strong><span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">La clave solo se aplica cuando marcas esta casilla y guardas las preferencias.</span></span>
                </span>
                <span className="relative mt-2 block">
                  <input type={showTmdbKey ? 'text' : 'password'} value={preferences.tmdbApiKey} onChange={(event) => setPreferences((current) => ({ ...current, tmdbApiKey: event.target.value.slice(0, 128) }))} autoComplete="off" spellCheck={false} disabled={!preferences.tmdbApiKeyEnabled} placeholder={preferences.tmdbApiKeyEnabled ? 'Pega aquí tu clave de TMDB' : 'Activa la casilla para introducirla'} className={`w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 pr-10 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400 ${!preferences.tmdbApiKeyEnabled ? 'cursor-not-allowed opacity-50' : ''}`} aria-describedby="tmdb-key-help" />
                  <button type="button" onClick={() => setShowTmdbKey((value) => !value)} className="absolute inset-y-0 right-1 grid w-8 place-items-center text-zinc-400 hover:text-white" aria-label={showTmdbKey ? 'Ocultar clave de TMDB' : 'Mostrar clave de TMDB'}>{showTmdbKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </span>
                <span id="tmdb-key-help" className="mt-1 block text-[10px] font-normal leading-relaxed text-zinc-500">Desactivada = se usa la clave del servidor. Activada = se utiliza esta clave solo en los endpoints de catálogo de MeriStream.</span>
              </label>
            </div>
            {canViewIdentityDetails && (
              <>
                <label className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-3 text-xs text-zinc-300">
                  <span>
                    <strong className="block text-sm text-zinc-100">Mostrar botón "Editar" en tarjetas</strong>
                    <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">Muestra el botón de edición rápida hacia el panel de administración en las tarjetas del catálogo. Solo visible para administradores.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={preferences.showAdminEditButton !== false}
                    onChange={(event) => setPreferences((current) => ({ ...current, showAdminEditButton: event.target.checked }))}
                    className="h-4 w-4 shrink-0 accent-amber-400"
                  />
                </label>
                <label className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 px-3 py-3 text-xs text-zinc-300">
                  <span><strong className="block text-sm text-zinc-100">Mostrar identificadores en el catálogo</strong><span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">Muestra TMDB, IMDb, TVDB, MAL, AniList, Kitsu y AniDB en tus fichas. Solo visible para administradores.</span></span>
                  <input type="checkbox" checked={preferences.showIdentityDetails} onChange={(event) => setPreferences((current) => ({ ...current, showIdentityDetails: event.target.checked }))} className="h-4 w-4 shrink-0 accent-sky-400" />
                </label>
              </>
            )}
          </fieldset>
        </div>

        <div className="sticky bottom-0 -mx-5 mt-7 flex justify-end gap-2 border-t border-zinc-800 bg-zinc-950/95 px-5 pt-4 pb-[max(0rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:-mx-6 sm:px-6">
          <button type="button" onClick={restoreDefaults} className="rounded-lg px-3 py-2.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-white">Restaurar</button>
          <button type="button" onClick={save} className="rounded-lg bg-amber-400 px-4 py-2.5 text-xs font-semibold text-zinc-950 hover:bg-amber-300">Guardar preferencias</button>
        </div>
      </section>
    </div>
  ), document.body);
}
