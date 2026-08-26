// src/components/VerificationPanel.tsx
// Pipeline de verificación automática: paso a paso configurable y extensible.

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Play, Loader2, CheckCircle2, XCircle, AlertTriangle, SkipForward, Settings2 } from 'lucide-react';

interface PipelineStep {
  id: string;
  name: string;
  description: string;
  status?: 'pending'|'running'|'done'|'error'|'skipped';
  found?: number;
  fixed?: number;
  error?: string;
}

interface PipelineStatus {
  running: boolean;
  steps: PipelineStep[];
  recent: Array<{ at: string; step: string; level: string; message: string }>;
}

// Timer config (sección existente)
const UNITS = [
  { label: 'Min', factor: 1 },
  { label: 'Horas', factor: 60 },
  { label: 'Días', factor: 1440 },
];

interface VerificationStatus {
  enabled: boolean;
  interval_minutes: number;
  running: boolean;
  phase: string;
  progress: any;
  next_run_at: string | null;
  recent: Array<{ at: string; level: string; message: string }>;
  config: any;
}

const VerificationPanel: React.FC = () => {
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<VerificationStatus | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<string[]>([]);
  const [showConfig, setShowConfig] = useState(false);
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState(1440);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadPipeline = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/verify/pipeline');
      if (r.ok) setPipeline(await r.json());
    } catch {}
  }, []);

  const loadVerify = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/verification');
      if (r.ok) {
        const d: VerificationStatus = await r.json();
        setVerifyStatus(d);
        const total = d.interval_minutes || 1440;
        const unit = [...UNITS].reverse().find(u => total % u.factor === 0) || UNITS[0];
        setIntervalUnit(unit.factor);
        setIntervalValue(Math.max(1, total / unit.factor));
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadPipeline();
    loadVerify();
    const t = setInterval(() => { loadPipeline(); loadVerify(); }, 4000);
    return () => clearInterval(t);
  }, [loadPipeline, loadVerify]);

  const runPipeline = async () => {
    setFeedback(null);
    try {
      const steps = selectedSteps.length > 0 ? selectedSteps : pipeline?.steps.map(s => s.id) || [];
      const r = await fetch('/api/v1/verify/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps }),
      });
      const d = await r.json();
      setFeedback(d.started ? 'Pipeline iniciado' : d.reason || 'Error');
      await loadPipeline();
    } catch (e: any) {
      setFeedback(e?.message || 'Error');
    }
  };

  const toggleStep = (id: string) => {
    setSelectedSteps(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]);
  };

  const selectAll = () => setSelectedSteps(pipeline?.steps.map(s => s.id) || []);
  const selectNone = () => setSelectedSteps([]);

  const saveTimerConfig = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await fetch('/api/v1/verification/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await loadVerify();
    } catch {} finally { setSaving(false); }
  };

  const statusIcon = (s?: string) => {
    switch (s) {
      case 'running': return <Loader2 size={14} className="animate-spin text-blue-400" />;
      case 'done': return <CheckCircle2 size={14} className="text-emerald-400" />;
      case 'error': return <XCircle size={14} className="text-red-400" />;
      case 'skipped': return <SkipForward size={14} className="text-zinc-500" />;
      default: return <div className="w-3.5 h-3.5 rounded-full border border-zinc-600" />;
    }
  };

  const p = verifyStatus?.progress;
  const anyRunning = pipeline?.running || verifyStatus?.running;

  return (
    <div className="space-y-4">
      {/* Header principal */}
      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Verificación del Catálogo</h3>
              <p className="text-[11px] text-zinc-400">
                {anyRunning
                  ? pipeline?.running ? 'Pipeline en ejecución...' : `Fase: ${verifyStatus?.phase || '...'}`
                  : 'Listo para ejecutar — selecciona pasos y ejecuta'}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowConfig(!showConfig)}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Settings2 size={13} />
              Timer
            </button>
            <button
              type="button"
              onClick={runPipeline}
              disabled={anyRunning}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              {anyRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {anyRunning ? 'Ejecutando...' : 'Ejecutar'}
            </button>
          </div>
        </div>

        {/* Progress resumen */}
        {p && (p.total > 0 || p.new_works > 0 || p.updated_metadata > 0) && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[['Progreso', `${p.done}/${p.total}`], ['Metadatos', p.updated_metadata], ['Nuevos', p.new_works], ['Episodios', p.new_episodes], ['Errores', p.errors]].map(([l, v]) => (
              <div key={String(l)} className="px-2.5 py-2 rounded-lg bg-zinc-950/60 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">{l}</div>
                <div className="text-sm font-bold text-white font-mono">{String(v)}</div>
              </div>
            ))}
          </div>
        )}
        {feedback && <p className="mt-2 text-[11px] text-amber-400">{feedback}</p>}
      </div>

      {/* Timer config (colapsable) */}
      {showConfig && (
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
          <h4 className="text-xs font-bold text-white">Configuración del Timer</h4>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer shrink-0">
              <input type="checkbox" checked={Boolean(verifyStatus?.enabled)} onChange={e => saveTimerConfig({ enabled: e.target.checked })} disabled={saving} className="accent-emerald-500" />
              Verificación automática
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Cada</span>
              <input type="number" min={1} value={intervalValue} onChange={e => { const v = parseInt(e.target.value) || 1; setIntervalValue(v); if (verifyStatus?.enabled) saveTimerConfig({ interval_minutes: v * intervalUnit }); }} className="w-20 px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500/60" />
              <select value={intervalUnit} onChange={e => { const f = parseInt(e.target.value); setIntervalUnit(f); if (verifyStatus?.enabled) saveTimerConfig({ interval_minutes: intervalValue * f }); }} className="px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-emerald-500/60">
                {UNITS.map(u => <option key={u.label} value={u.factor}>{u.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Pipeline steps */}
      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-bold text-white">Pasos de Verificación</h4>
          <div className="flex gap-2">
            <button type="button" onClick={selectAll} className="text-[10px] text-zinc-400 hover:text-zinc-200 underline">Todos</button>
            <button type="button" onClick={selectNone} className="text-[10px] text-zinc-400 hover:text-zinc-200 underline">Ninguno</button>
          </div>
        </div>
        <div className="space-y-1.5">
          {pipeline?.steps.map(step => {
            const isSelected = selectedSteps.includes(step.id);
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => toggleStep(step.id)}
                disabled={pipeline.running}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  isSelected
                    ? 'bg-emerald-500/10 border border-emerald-500/30'
                    : 'bg-zinc-950/40 border border-zinc-800 hover:border-zinc-700'
                } ${pipeline.running ? 'opacity-60' : ''}`}
              >
                {statusIcon(step.status)}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-white truncate">{step.name}</div>
                  <div className="text-[10px] text-zinc-500 truncate">{step.description}</div>
                </div>
                {step.status === 'done' && (
                  <div className="text-[10px] text-zinc-400 shrink-0">
                    <span className="text-emerald-400 font-mono">{step.fixed}</span> / <span className="font-mono">{step.found}</span>
                  </div>
                )}
                {step.status === 'error' && (
                  <span className="text-[10px] text-red-400 shrink-0 truncate max-w-[120px]">{step.error}</span>
                )}
                {isSelected && !pipeline.running && (
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                )}
              </button>
            );
          })}
        </div>
        {selectedSteps.length > 0 && !pipeline.running && (
          <p className="mt-2 text-[10px] text-zinc-500">{selectedSteps.length} paso(s) seleccionado(s)</p>
        )}
      </div>

      {/* Log reciente */}
      {pipeline?.recent && pipeline.recent.length > 0 && (
        <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
          <h4 className="text-xs font-bold text-white mb-2">Actividad del Pipeline</h4>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {pipeline.recent.map((r, i) => (
              <div key={i} className="text-[11px] font-mono flex gap-2">
                <span className="text-zinc-600 shrink-0">{new Date(r.at).toLocaleTimeString()}</span>
                <span className={`shrink-0 w-20 truncate ${r.level === 'error' ? 'text-red-400' : r.level === 'warn' ? 'text-amber-400' : 'text-zinc-500'}`}>
                  {r.step}
                </span>
                <span className={r.level === 'error' ? 'text-red-400' : 'text-zinc-400'}>{r.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VerificationPanel;
