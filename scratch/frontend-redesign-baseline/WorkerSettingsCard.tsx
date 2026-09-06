// src/components/WorkerSettingsCard.tsx
// Ajustes del worker en vivo: jobs simultáneos, delay, jitter y concurrencias,
// con recomendaciones y alertas anti-bot (Cloudflare etc.).

import React, { useCallback, useEffect, useState } from 'react';
import { Save, ShieldAlert, Activity } from 'lucide-react';

interface WorkerSettings {
  default_delay_ms: number;
  jitter_enabled: boolean;
  max_concurrent_jobs: number;
  user_agent_rotation: boolean;
  page_concurrency: number;
  item_concurrency: number;
  active_jobs: number;
  antibot: Record<string, { hits: number; lastAt: number; kind: string }>;
  recommended: { max_concurrent_jobs: number; delay_ms: number; page_concurrency: number; item_concurrency: number };
}

const WorkerSettingsCard: React.FC = () => {
  const [settings, setSettings] = useState<WorkerSettings | null>(null);
  const [draft, setDraft] = useState<Partial<WorkerSettings>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/worker/settings');
      if (res.ok) {
        const data: WorkerSettings = await res.json();
        setSettings(data);
        setDraft((d) =>
          Object.keys(d).length
            ? d
            : {
                max_concurrent_jobs: data.max_concurrent_jobs,
                default_delay_ms: data.default_delay_ms,
                jitter_enabled: data.jitter_enabled,
                page_concurrency: data.page_concurrency,
                item_concurrency: data.item_concurrency,
              }
        );
      }
    } catch {
      /* silencio: el poll reintenta */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/v1/worker/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        const d = await res.json();
        if (d.settings) setSettings(d.settings);
        setSavedAt(new Date().toLocaleTimeString());
      }
    } finally {
      setSaving(false);
    }
  };

  const num = (k: keyof WorkerSettings): number => Number((draft as any)[k] ?? (settings as any)?.[k] ?? 0);
  const setNum = (k: keyof WorkerSettings, v: number) => setDraft((d) => ({ ...d, [k]: v }));

  const antibotEntries = Object.entries(settings?.antibot || {});

  return (
    <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-4">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div>
          <h4 className="text-xs font-bold text-white flex items-center gap-2">
            <Activity size={14} className="text-emerald-400" />
            Ajustes del Worker (en vivo)
          </h4>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Jobs activos ahora: <span className="text-emerald-400 font-mono font-bold">{settings?.active_jobs ?? 0}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
        >
          <Save size={13} />
          {saving ? 'Guardando...' : savedAt ? `Guardado ${savedAt}` : 'Guardar ajustes'}
        </button>
      </div>

      {antibotEntries.length > 0 && (
        <div className="p-3 rounded-lg bg-red-950/50 border border-red-500/40">
          <div className="flex items-center gap-2 text-red-300 font-bold text-xs mb-2">
            <ShieldAlert size={14} />
            ALERTA: Bloqueos anti-bot detectados
          </div>
          <div className="space-y-1">
            {antibotEntries.map(([host, info]) => (
              <div key={host} className="text-[11px] text-red-200/90 font-mono flex items-center justify-between">
                <span>{host}</span>
                <span>
                  {info.hits} hits · {info.kind} · último {new Date(info.lastAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-red-300/70 mt-2">
            El worker duplicó automáticamente el delay para esos dominios (se relaja solo tras 10 min sin bloqueos).
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1">Jobs simultáneos</label>
          <input
            type="number"
            min={1}
            max={8}
            value={num('max_concurrent_jobs')}
            onChange={(e) => setNum('max_concurrent_jobs', parseInt(e.target.value, 10) || 1)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"
          />
          <p className="text-[10px] text-zinc-500 mt-1">Recomendado: 4 — más de 5 solo si raspas sitios distintos a la vez.</p>
        </div>

        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1 flex items-center justify-between">
            <span>Delay entre peticiones</span>
            <span className="text-zinc-400 font-mono">{num('default_delay_ms')}ms</span>
          </label>
          <input
            type="range"
            min={0}
            max={5000}
            step={100}
            value={num('default_delay_ms')}
            onChange={(e) => setNum('default_delay_ms', parseInt(e.target.value, 10) || 0)}
            className="w-full accent-emerald-500 mt-2"
          />
          <p className="text-[10px] text-zinc-500 mt-1">Recomendado: 300ms · 0 = a fondo (sin espera).</p>
        </div>

        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1">Concurrencia de páginas</label>
          <input
            type="number"
            min={1}
            max={24}
            value={num('page_concurrency')}
            onChange={(e) => setNum('page_concurrency', parseInt(e.target.value, 10) || 1)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"
          />
          <p className="text-[10px] text-zinc-500 mt-1">Recomendado: 8 (páginas del mismo sitio en paralelo).</p>
        </div>

        <div>
          <label className="text-xs font-semibold text-zinc-300 block mb-1">Concurrencia de obras</label>
          <input
            type="number"
            min={1}
            max={24}
            value={num('item_concurrency')}
            onChange={(e) => setNum('item_concurrency', parseInt(e.target.value, 10) || 1)}
            className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"
          />
          <p className="text-[10px] text-zinc-500 mt-1">Recomendado: 16 (obras analizándose + guardándose a la vez; TMDB tolera 40-50 rps).</p>
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(draft.jitter_enabled ?? settings?.jitter_enabled)}
              onChange={(e) => setDraft((d) => ({ ...d, jitter_enabled: e.target.checked }))}
              className="accent-emerald-500"
            />
            Jitter aleatorio (rompe patrones de tráfico; recomendado activo)
          </label>
        </div>
      </div>
    </div>
  );
};

export default WorkerSettingsCard;
