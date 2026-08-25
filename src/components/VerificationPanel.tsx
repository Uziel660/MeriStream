// src/components/VerificationPanel.tsx
// Apartado de Verificación: recorre el catálogo obra por obra re-colectando
// metadatos y detectando novedades en las plataformas seleccionadas.
// Timer configurable (minutos/horas/días/meses) con ON/OFF persistente.

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Play, Save, Loader2 } from 'lucide-react';

interface VerificationStatus {
  enabled: boolean;
  interval_minutes: number;
  scope_mode: 'all' | 'platforms' | 'category';
  platforms: string[];
  category: string | null;
  metadata_only: boolean;
  sync_known_episodes?: boolean;
  running: boolean;
  phase: string;
  current_item: string | null;
  progress: {
    total: number;
    done: number;
    new_works: number;
    new_sources: number;
    known: number;
    known_without_episodes: number;
    new_episodes: number;
    updated_metadata: number;
    errors: number;
  };
  next_run_at: string | null;
  recent: Array<{ at: string; level: string; message: string }>;
  config: any;
}

const UNITS = [
  { label: 'Minutos', factor: 1 },
  { label: 'Horas', factor: 60 },
  { label: 'Días', factor: 1440 },
  { label: 'Meses', factor: 43200 },
];

const VerificationPanel: React.FC = () => {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [intervalValue, setIntervalValue] = useState<number>(1);
  const [intervalUnit, setIntervalUnit] = useState<number>(1440); // días por defecto
  const [knownPlatforms, setKnownPlatforms] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/verification');
      if (res.ok) {
        const data: VerificationStatus = await res.json();
        setStatus(data);
        setKnownPlatforms(Object.keys(data.config?.catalog_urls_by_platform || {}));
      }
    } catch {
      /* silencio */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Sincroniza el input del intervalo cuando llega el estado
  useEffect(() => {
    if (status) {
      const total = status.interval_minutes || 1440;
      // Elige la unidad más legible que divida exacto
      const unit = [...UNITS].reverse().find((u) => total % u.factor === 0) || UNITS[0];
      setIntervalUnit(unit.factor);
      setIntervalValue(Math.max(1, total / unit.factor));
    }
  }, [status?.interval_minutes]);

  const saveConfig = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/v1/verification/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setFeedback('Configuración guardada');
        await load();
      } else {
        setFeedback(data.detail || 'Error de validación');
      }
    } catch (e: any) {
      setFeedback(e?.message || 'Error de conexión');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setFeedback(null);
    try {
      const res = await fetch('/api/v1/verification/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      setFeedback(data.started ? 'Verificación iniciada' : data.reason || 'Ya hay una pasada en curso');
      await load();
    } catch (e: any) {
      setFeedback(e?.message || 'Error al iniciar');
    }
  };

  const toggleTimer = (enabled: boolean) => {
    saveConfig({ enabled, interval_minutes: intervalValue * intervalUnit });
  };

  const changeInterval = (value: number, unitFactor: number) => {
    setIntervalValue(value);
    setIntervalUnit(unitFactor);
    // Guarda solo si el timer está activo (si no, se guardará al activarlo)
    if (status?.enabled) saveConfig({ interval_minutes: Math.max(1, value) * unitFactor });
  };

  const setScope = (mode: string) => saveConfig({ scope_mode: mode });
  const togglePlatform = (p: string) => {
    const current = status?.platforms || [];
    const next = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
    saveConfig({ platforms: next });
  };
  const setMetadataOnly = (v: boolean) => saveConfig({ metadata_only: v });

  const p = status?.progress;

  return (
    <div className="space-y-4">
      {/* Estado general + Ejecutar ahora */}
      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Verificación del Catálogo</h3>
              <p className="text-[11px] text-zinc-400">
                {status?.running
                  ? `En curso: fase ${status.phase} — ${status.current_item || ''} (${p?.done || 0}/${p?.total || 0})`
                  : status?.enabled
                  ? `Automática activa · próxima: ${status.next_run_at ? new Date(status.next_run_at).toLocaleString() : '—'}`
                  : 'Automática desactivada'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={runNow}
            disabled={status?.running}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            {status?.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {status?.running ? 'Verificando...' : 'Ejecutar ahora'}
          </button>
        </div>

        {p && (p.total > 0 || p.new_works > 0 || p.updated_metadata > 0) && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              ['Progreso', `${p.done}/${p.total}`],
              ['Metadatos actualizados', p.updated_metadata],
              ['Obras nuevas', p.new_works],
              ['Episodios nuevos', p.new_episodes],
              ['Errores', p.errors],
            ].map(([label, value]) => (
              <div key={String(label)} className="px-2.5 py-2 rounded-lg bg-zinc-950/60 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">{label}</div>
                <div className="text-sm font-bold text-white font-mono">{String(value)}</div>
              </div>
            ))}
          </div>
        )}
        {feedback && <p className="mt-2 text-[11px] text-amber-400">{feedback}</p>}
      </div>

      {/* Configuración */}
      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-4">
        <h4 className="text-xs font-bold text-white">Configuración</h4>

        {/* Timer */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={Boolean(status?.enabled)}
              onChange={(e) => toggleTimer(e.target.checked)}
              disabled={saving}
              className="accent-emerald-500"
            />
            Verificación automática
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">Cada</span>
            <input
              type="number"
              min={1}
              value={intervalValue}
              onChange={(e) => changeInterval(parseInt(e.target.value, 10) || 1, intervalUnit)}
              className="w-20 px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500/60"
            />
            <select
              value={intervalUnit}
              onChange={(e) => changeInterval(intervalValue, parseInt(e.target.value, 10))}
              className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500/60"
            >
              {UNITS.map((u) => (
                <option key={u.label} value={u.factor}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Alcance */}
        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1.5">Alcance</label>
          <div className="flex flex-wrap gap-2">
            {[
              ['all', 'Todo el catálogo'],
              ['platforms', 'Por plataformas'],
              ['category', 'Por categoría'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setScope(mode)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  status?.scope_mode === mode
                    ? 'bg-zinc-800 text-white border border-zinc-600'
                    : 'bg-zinc-950 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {status?.scope_mode === 'platforms' && (
            <div className="mt-2 flex flex-wrap gap-2">
              {(knownPlatforms.length > 0 ? knownPlatforms : status.platforms).map((plat) => {
                const active = (status.platforms || []).includes(plat);
                return (
                  <button
                    key={plat}
                    type="button"
                    onClick={() => togglePlatform(plat)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                      active
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-zinc-950 text-zinc-500 border border-zinc-800 hover:text-zinc-300'
                    }`}
                  >
                    {plat}
                  </button>
                );
              })}
              {knownPlatforms.length === 0 && status.platforms.length === 0 && (
                <p className="text-[11px] text-zinc-500">No hay plataformas configuradas en catalog_urls_by_platform.</p>
              )}
            </div>
          )}

          {status?.scope_mode === 'category' && (
            <input
              type="text"
              key={status.category || 'cat'}
              defaultValue={status.category || ''}
              onBlur={(e) => saveConfig({ category: e.target.value })}
              placeholder="anime, series, movie..."
              className="mt-2 w-full max-w-xs px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500/60"
            />
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={status?.metadata_only}
            onChange={(e) => setMetadataOnly(e.target.checked)}
            disabled={saving}
            className="accent-emerald-500"
          />
          Solo metadatos (sin buscar novedades en plataformas)
        </label>

        <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={status?.sync_known_episodes !== false}
            onChange={(e) => saveConfig({ sync_known_episodes: e.target.checked })}
            disabled={saving}
            className="accent-emerald-500"
          />
          Detectar episodios nuevos en obras conocidas (re-escaneo ligero por índice)
        </label>

        <button
          type="button"
          onClick={() => saveConfig({ interval_minutes: intervalValue * intervalUnit })}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
        >
          <Save size={13} />
          {saving ? 'Guardando...' : 'Guardar configuración'}
        </button>
        <p className="text-[10px] text-zinc-500">
          Nota: los cambios de alcance/plataformas/metadata_only se guardan al instante; el botón es para reconfirmar.
        </p>
      </div>

      {/* Log reciente */}
      {status?.recent && status.recent.length > 0 && (
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
          <h4 className="text-xs font-bold text-white mb-2">Actividad reciente</h4>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {status.recent.map((r, i) => (
              <div key={i} className="text-[11px] font-mono flex gap-2">
                <span className="text-zinc-600">{new Date(r.at).toLocaleTimeString()}</span>
                <span
                  className={
                    r.level === 'error' ? 'text-red-400' : r.level === 'warn' ? 'text-amber-400' : 'text-zinc-400'
                  }
                >
                  {r.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VerificationPanel;
