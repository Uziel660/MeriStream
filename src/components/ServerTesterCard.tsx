// src/components/ServerTesterCard.tsx
// Probador de servidores por plataforma: eliges una obra que venga de la
// plataforma, se resuelve y se prueban TODOS sus servidores (status + latencia
// vía el proxy, sin blacklist), y reordenas la prioridad de cada host con
// flechas. La prioridad aplica a cualquier obra de esa plataforma.

import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2, RefreshCw, Play } from 'lucide-react';
import { TestPlayerModal } from './TestPlayerModal';

/** Extrae la "familia" de un hostname: "s12.vimeos.net" → "vimeos" */
function hostFamily(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const labels = h.split('.').filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : h;
}

interface TestResult {
  url: string;
  host: string;
  hostFamily: string;
  status: number;
  ok: boolean;
  latency_ms: number;
  priority?: number;
}

const ServerTesterCard: React.FC = () => {
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const [works, setWorks] = useState<Array<{ id: string; title: string }>>([]);
  const [loadingWorks, setLoadingWorks] = useState(false);
  const [showId, setShowId] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [showTestPlayer, setShowTestPlayer] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/v1/sites/ratings', { credentials: 'same-origin' });
        if (res.ok) {
          const data = await res.json();
          const sites: string[] = (data.ratings || []).map((r: any) => r.site);
          setPlatforms(sites);
          if (sites.length > 0) setPlatform(sites[0]);
        }
      } catch {
        /* silencio */
      }
    })();
  }, []);

  const loadWorks = useCallback(async () => {
    if (!platform) return;
    setLoadingWorks(true);
    setWorks([]);
    setShowId('');
    setResults([]);
    try {
      const res = await fetch(`/api/v1/platforms/${encodeURIComponent(platform)}/works`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        setWorks(data.works || []);
      }
    } finally {
      setLoadingWorks(false);
    }
  }, [platform]);

  const testServers = async () => {
    if (!platform || !showId) return;
    setTesting(true);
    setTestMsg(null);
    setResults([]);
    try {
      const res = await fetch(`/api/v1/platforms/${encodeURIComponent(platform)}/test-servers`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_id: showId }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setResults(data.results || []);
        if ((data.results || []).length === 0) setTestMsg('No se resolvió ningún servidor para esa obra.');
      } else {
        setTestMsg(data.detail || 'Error al probar servidores');
      }
    } catch (e: any) {
      setTestMsg(e?.message || 'Error de conexión');
    } finally {
      setTesting(false);
    }
  };

  const move = async (host: string, dir: -1 | 1) => {
    try {
      const res = await fetch(`/api/v1/platforms/${encodeURIComponent(platform)}/server-priorities/move`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, dir }),
      });
      if (res.ok) {
        const data = await res.json();
        setResults((prev) =>
          prev
            .map((r) => ({ ...r, priority: data.priorities[hostFamily(r.host)] ?? data.priorities[r.hostFamily] ?? undefined }))
            .sort((a, b) => {
              const na = a.priority ?? Number.MAX_SAFE_INTEGER;
              const nb = b.priority ?? Number.MAX_SAFE_INTEGER;
              if (na !== nb) return na - nb;
              return a.latency_ms - b.latency_ms;
            })
        );
      }
    } catch {
      /* silencio */
    }
  };

  return (
    <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={14} className="text-sky-400" />
          <h4 className="text-xs font-bold text-white">Probador de Servidores por Plataforma</h4>
        </div>
        <button
          type="button"
          onClick={() => setShowTestPlayer(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600/90 hover:bg-sky-500 text-white text-xs font-semibold shadow-md transition-colors"
        >
          <Play size={12} className="fill-current" />
          Reproductor Aislado de Pruebas (ZokoAnime / AniPulse / GitHub)
        </button>
      </div>
      <p className="text-[11px] text-zinc-400">
        Elige una obra que venga de la plataforma, prueba TODOS sus servidores (status + latencia) y reordena cuál va
        primero. La prioridad es por host y aplica a cualquier obra de esa plataforma.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value);
            setWorks([]);
            setResults([]);
          }}
          className="px-2.5 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-sky-500/60"
        >
          {platforms.length === 0 && <option value="">(carga sitios primero)</option>}
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={loadWorks}
          disabled={!platform || loadingWorks}
          className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
        >
          <RefreshCw size={12} className={loadingWorks ? 'animate-spin' : ''} />
          Cargar obras
        </button>

        <select
          value={showId}
          onChange={(e) => setShowId(e.target.value)}
          disabled={works.length === 0}
          className="px-2.5 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-sky-500/60 disabled:opacity-50"
        >
          <option value="">{works.length === 0 ? 'Sin obras cargadas' : 'Elige una obra...'}</option>
          {works.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={testServers}
        disabled={!showId || testing}
        className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
      >
        {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
        {testing ? 'Resolviendo y probando...' : 'Probar todos los servidores'}
      </button>

      {testMsg && <p className="text-[11px] text-amber-400">{testMsg}</p>}

      {results.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="px-3 py-2 font-semibold">Orden</th>
                <th className="px-3 py-2 font-semibold">Servidor (host)</th>
                <th className="px-3 py-2 font-semibold">Estado</th>
                <th className="px-3 py-2 font-semibold">Latencia</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, idx) => (
                <tr key={r.url} className="border-b border-zinc-900 last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <span className="w-5 text-center text-[10px] font-mono text-zinc-500">#{idx + 1}</span>
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => move(r.host, -1)}
                        className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 disabled:opacity-30 transition-colors"
                        title="Subir prioridad de este servidor"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={idx === results.length - 1}
                        onClick={() => move(r.host, 1)}
                        className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-amber-400 hover:border-amber-500/40 disabled:opacity-30 transition-colors"
                        title="Bajar prioridad de este servidor"
                      >
                        ↓
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-200 truncate max-w-[220px]" title={r.url}>
                    {r.host}
                    {r.priority !== undefined && (
                      <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-sky-500/10 text-sky-300">
                        P{r.priority}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={r.ok ? 'text-emerald-400' : 'text-red-400'}>
                      {r.ok ? 'OK' : 'FALLO'} {r.status ? `(${r.status})` : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-400">{r.latency_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[10px] text-zinc-500 border-t border-zinc-800">
            Los cambios de prioridad se guardan al instante y aplican a cualquier obra de esta plataforma.
          </p>
        </div>
      )}

      {/* MODAL DE REPRODUCTOR AISLADO DE PRUEBAS */}
      <TestPlayerModal isOpen={showTestPlayer} onClose={() => setShowTestPlayer(false)} />
    </div>
  );
};

export default ServerTesterCard;
