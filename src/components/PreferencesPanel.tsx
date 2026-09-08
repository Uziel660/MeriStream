import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  APP_PREFERENCES_EVENT,
  DEFAULT_APP_PREFERENCES,
  getAppPreferences,
  saveAppPreferences,
  type AppPreferences,
  type PreferredQuality,
  type SubtitlePosition,
} from '../utils/appPreferences';

interface PreferencesPanelProps {
  userId?: string | null;
  onClose: () => void;
}

const LANGUAGE_OPTIONS = [
  ['es-419', 'Español latino'],
  ['es', 'Español'],
  ['en', 'Inglés'],
  ['ja', 'Japonés'],
  ['pt', 'Portugués'],
] as const;

export function PreferencesPanel({ userId, onClose }: PreferencesPanelProps) {
  const [preferences, setPreferences] = useState<AppPreferences>(() => getAppPreferences(userId));

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (!detail?.userId || detail.userId === String(userId || 'guest')) setPreferences(getAppPreferences(userId));
    };
    window.addEventListener(APP_PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, sync);
  }, [userId]);

  const toggleLanguage = (field: 'preferredLanguages' | 'preferredSubtitleLanguages', language: string) => {
    setPreferences((current) => {
      const values = current[field].includes(language)
        ? current[field].filter((item) => item !== language)
        : [...current[field], language];
      return { ...current, [field]: values };
    });
  };

  const save = () => {
    saveAppPreferences(userId, preferences);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="preferences-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="w-full max-w-lg max-h-[min(92vh,42rem)] overflow-y-auto rounded-2xl border border-zinc-700/80 bg-zinc-950 p-5 text-zinc-100 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">MeriStream</p>
            <h2 id="preferences-title" className="mt-1 text-xl font-semibold">Preferencias de reproducción</h2>
            <p className="mt-1 text-xs text-zinc-400">Se guardan por usuario en este dispositivo.</p>
          </div>
          <button type="button" className="rounded-full p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={onClose} aria-label="Cerrar preferencias"><X size={18} /></button>
        </div>

        <div className="mt-6 space-y-6">
          <fieldset>
            <legend className="text-sm font-semibold">Idiomas de audio prioritarios</legend>
            <p className="mt-1 text-xs text-zinc-500">El reproductor mostrará primero estas opciones.</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {LANGUAGE_OPTIONS.map(([value, label]) => {
                const checked = preferences.preferredLanguages.includes(value);
                return <button key={`audio-${value}`} type="button" onClick={() => toggleLanguage('preferredLanguages', value)} aria-pressed={checked} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${checked ? 'border-amber-400/60 bg-amber-400/10 text-amber-100' : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600'}`}><span>{label}</span>{checked && <Check size={14} />}</button>;
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">Subtítulos prioritarios</legend>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {LANGUAGE_OPTIONS.map(([value, label]) => {
                const checked = preferences.preferredSubtitleLanguages.includes(value);
                return <button key={`sub-${value}`} type="button" onClick={() => toggleLanguage('preferredSubtitleLanguages', value)} aria-pressed={checked} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${checked ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-100' : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-600'}`}><span>{label}</span>{checked && <Check size={14} />}</button>;
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">Calidad inicial
              <select value={preferences.defaultQuality} onChange={(event) => setPreferences((current) => ({ ...current, defaultQuality: event.target.value as PreferredQuality }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                <option value="auto">Automática</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option>
              </select>
            </label>
            <label className="text-sm font-semibold">Posición de subtítulos
              <select value={preferences.subtitlePosition} onChange={(event) => setPreferences((current) => ({ ...current, subtitlePosition: event.target.value as SubtitlePosition }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                <option value="bottom">Abajo</option><option value="center">Centro</option><option value="top">Arriba</option>
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">Tamaño de subtítulos
              <select value={preferences.subtitleScale} onChange={(event) => setPreferences((current) => ({ ...current, subtitleScale: event.target.value as AppPreferences['subtitleScale'] }))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-normal text-zinc-200 outline-none focus:border-amber-400">
                <option value="small">Pequeño</option><option value="normal">Normal</option><option value="large">Grande</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3 self-end rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
              <span><strong className="block text-sm text-zinc-100">Reducir animaciones</strong><span className="text-[11px] text-zinc-500">Ayuda en equipos modestos.</span></span>
              <input type="checkbox" checked={preferences.reduceMotion} onChange={(event) => setPreferences((current) => ({ ...current, reduceMotion: event.target.checked }))} className="h-4 w-4 accent-amber-400" />
            </label>
          </div>
        </div>

        <div className="mt-7 flex justify-end gap-2 border-t border-zinc-800 pt-4">
          <button type="button" onClick={() => { setPreferences({ ...DEFAULT_APP_PREFERENCES }); }} className="rounded-lg px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-white">Restaurar</button>
          <button type="button" onClick={save} className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-300">Guardar preferencias</button>
        </div>
      </section>
    </div>
  );
}

