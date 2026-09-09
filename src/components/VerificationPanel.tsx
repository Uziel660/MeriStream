// src/components/VerificationPanel.tsx
// Panel del motor unificado de verificación del catálogo (metadatos + novedades multi-página con pausa/reanudación).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Layers,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Square,
  Video,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  api,
  type VerificationConfig,
  type VerificationProgress,
  type VerificationRunMode,
  type VerificationStatus,
  type IdentityRepairStatus,
} from "../api/client";
import type { ApiError } from "../types";

const UNITS = [
  { label: "minutos", factor: 1 },
  { label: "horas", factor: 60 },
  { label: "días", factor: 1440 },
];

const VALID_CATEGORIES = ["anime", "movie", "movies", "series"];

type Feedback = { tone: "success" | "error"; message: string };

const EMPTY_PROGRESS: VerificationProgress = {
  total: 0,
  done: 0,
  new_works: 0,
  new_sources: 0,
  new_episodes: 0,
  updated_metadata: 0,
  errors: 0,
  percent: 0,
};

function errorMessage(error: unknown): string {
  const apiError = error as Partial<ApiError>;
  if (apiError?.message) {
    return apiError.status === 409 ? "Ya hay una verificación en curso." : apiError.message;
  }
  return error instanceof Error ? error.message : "No se pudo completar la operación.";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Nunca";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Fecha no disponible" : date.toLocaleString();
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 1000) return "menos de un segundo";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function splitPlatforms(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function initialTimer(config?: VerificationConfig): { value: number; unit: number } {
  const total = Math.max(5, config?.interval_minutes || 1440);
  const unit = [...UNITS].reverse().find((candidate) => total % candidate.factor === 0) || UNITS[0];
  const factor = unit.factor;
  const rawValue = Math.round(total / factor);
  const minVal = factor === 1 ? 5 : 1;
  return { value: Math.max(minVal, rawValue), unit: factor };
}

function Metric({ label, value, icon, hint }: { label: string; value: number | string; icon: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3" title={hint}>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="font-mono text-lg font-bold text-white">{value}</div>
      {hint && <div className="mt-0.5 text-[9px] text-zinc-500">{hint}</div>}
    </div>
  );
}

const VerificationPanel: React.FC = () => {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [identityRepair, setIdentityRepair] = useState<IdentityRepairStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runningMode, setRunningMode] = useState<VerificationRunMode | null>(null);
  const [controlling, setControlling] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<Feedback | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const configDirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [metadataOnly, setMetadataOnly] = useState(false);
  const [syncKnownEpisodes, setSyncKnownEpisodes] = useState(true);
  const [catalogPagesPerPlatform, setCatalogPagesPerPlatform] = useState(0);
  const [scopeMode, setScopeMode] = useState("all");
  const [platforms, setPlatforms] = useState("");
  const [category, setCategory] = useState("");
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState(1440);

  const applyConfig = useCallback((config: VerificationConfig) => {
    const timer = initialTimer(config);
    setEnabled(Boolean(config.enabled));
    setMetadataOnly(Boolean(config.metadata_only));
    setSyncKnownEpisodes(config.sync_known_episodes !== false);
    setCatalogPagesPerPlatform(config.catalog_pages_per_platform ?? 0);
    setScopeMode(config.scope_mode || "all");
    setPlatforms((config.platforms || []).join(", "));
    setCategory(config.category || "");
    setIntervalValue(timer.value);
    setIntervalUnit(timer.unit);
  }, []);

  const loadStatus = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const next = await api.getVerificationStatus();
      setStatus(next);
      if (!configDirtyRef.current) applyConfig(next.config);
      setPollError(null);
    } catch (error) {
      setPollError(errorMessage(error));
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, [applyConfig]);

  const loadIdentityRepairStatus = useCallback(async () => {
    try {
      setIdentityRepair(await api.getIdentityRepairStatus());
    } catch {
      // Este proceso auxiliar no debe ocultar ni romper el worker interno.
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    void loadIdentityRepairStatus();
    const timer = window.setInterval(() => void loadIdentityRepairStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [loadIdentityRepairStatus]);

  const runVerification = async (mode: VerificationRunMode) => {
    setActionFeedback(null);
    setRunningMode(mode);
    try {
      const result = await api.runVerification(mode);
      setActionFeedback({
        tone: "success",
        message: result.started ? "Verificación iniciada." : result.reason || "No se inició la verificación.",
      });
      if (result.status) setStatus(result.status);
    } catch (error) {
      setActionFeedback({ tone: "error", message: errorMessage(error) });
      await loadStatus(true);
    } finally {
      setRunningMode(null);
    }
  };

  const pauseVerification = async () => {
    setControlling(true);
    setActionFeedback(null);
    try {
      const result = await api.pauseVerification();
      if (result.status) setStatus(result.status);
      setActionFeedback({ tone: "success", message: "Verificación pausada." });
    } catch (error) {
      setActionFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setControlling(false);
    }
  };

  const resumeVerification = async () => {
    setControlling(true);
    setActionFeedback(null);
    try {
      const result = await api.resumeVerification();
      if (result.status) setStatus(result.status);
      setActionFeedback({ tone: "success", message: "Verificación reanudada." });
    } catch (error) {
      setActionFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setControlling(false);
    }
  };

  const stopVerification = async () => {
    setControlling(true);
    setActionFeedback(null);
    try {
      const result = await api.stopVerification();
      if (result.status) setStatus(result.status);
      setActionFeedback({ tone: "success", message: "Verificación detenida." });
    } catch (error) {
      setActionFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setControlling(false);
    }
  };

  const [repairing, setRepairing] = useState(false);

  const repairCatalogLinks = async () => {
    setRepairing(true);
    setActionFeedback(null);
    try {
      const result = await api.repairCatalogLinks();
      setActionFeedback({ tone: "success", message: result.message || "Auditoría completada exitosamente." });
      await loadStatus(true);
    } catch (error) {
      setActionFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setRepairing(false);
    }
  };

  const saveConfig = async () => {
    const minMinutes = 5;
    const computedMinutes = Math.round(intervalValue || 1) * intervalUnit;
    const minutes = Math.max(minMinutes, computedMinutes);
    setSaving(true);
    setActionFeedback(null);
    try {
      const result = await api.updateVerificationConfig({
        enabled,
        interval_minutes: minutes,
        scope_mode: scopeMode,
        platforms: splitPlatforms(platforms),
        category: category.trim() || null,
        metadata_only: metadataOnly,
        sync_known_episodes: syncKnownEpisodes,
        catalog_pages_per_platform: Math.max(0, Number(catalogPagesPerPlatform) || 0),
      });
      if (result.status) setStatus(result.status);
      if (result.config) applyConfig(result.config);
      configDirtyRef.current = false;
      setConfigDirty(false);
      setActionFeedback({ tone: "success", message: "Configuración guardada correctamente." });
    } catch (error) {
      setActionFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const markConfigDirty = () => {
    configDirtyRef.current = true;
    setConfigDirty(true);
  };

  const availablePlatforms = useMemo(() => {
    const catalogUrls = status?.config?.catalog_urls_by_platform || {};
    return Object.keys(catalogUrls);
  }, [status?.config?.catalog_urls_by_platform]);

  const invalidPlatforms = useMemo(() => {
    if (scopeMode !== "platforms") return [];
    const entered = splitPlatforms(platforms);
    return entered.filter((p) => !availablePlatforms.includes(p));
  }, [scopeMode, platforms, availablePlatforms]);

  const missingPlatforms = scopeMode === "platforms" && splitPlatforms(platforms).length === 0;

  const invalidCategory = useMemo(() => {
    if (scopeMode !== "category") return false;
    if (!category.trim()) return true;
    return !VALID_CATEGORIES.includes(category.trim().toLowerCase());
  }, [scopeMode, category]);

  const progress = status?.progress || EMPTY_PROGRESS;
  const report = status?.last_report;
  const isRunning = Boolean(status?.running || runningMode);
  const isPaused = Boolean(status?.paused);
  const completion = progress.percent ?? (progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0);
  const metadataUpdated = progress.metadata_updated ?? progress.updated_metadata ?? 0;
  const createdWorks = progress.works_created ?? progress.new_works ?? 0;
  const mergedWorks = progress.works_merged ?? 0;
  const sourcesAdded = progress.sources_added ?? 0;
  const recent = status?.recent || [];
  const minInterval = intervalUnit === 1 ? 5 : 1;

  const configSummary = useMemo(() => {
    if (!status?.config) return "Configuración no disponible";
    if (!status.config.enabled) return "Automático desactivado";
    return status.next_run_at ? `Próxima pasada: ${formatDate(status.next_run_at)}` : "Automático activado";
  }, [status]);

  const headerStatusText = useMemo(() => {
    if (loading) return "Cargando estado…";
    if (isPaused) return "Verificación en pausa (Reanudable)";
    if (isRunning) {
      if (status?.phase === "metadata") return "Fase 1/3: Reparando y enriqueciendo metadatos existentes…";
      if (status?.phase === "catalog") return "Fase 2/3: Auditando catálogo y novedades multi-página…";
      if (status?.phase === "finalizing") return "Fase 3/3: Normalizando y puliendo metadatos de lo nuevo…";
      return "Ejecutando verificación…";
    }
    return "Listo para verificar";
  }, [loading, isPaused, isRunning, status?.phase]);

  const identityPhaseLabel = identityRepair?.phase === "shows"
    ? "series y películas"
    : identityRepair?.phase === "media"
    ? "películas/medios"
    : identityRepair?.phase === "anime"
    ? "anime"
    : "sin fase informada";
  const identityStateLabel = identityRepair?.state === "running"
    ? "EN CURSO"
    : identityRepair?.state === "completed"
    ? "COMPLETADO"
    : identityRepair?.state === "failed"
    ? "CON ERROR"
    : "SIN SEGUIMIENTO EN VIVO";

  return (
    <div className="space-y-4">
      {/* ── Tarjeta principal de control ────────────────────────── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                isPaused
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                  : isRunning
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-zinc-700 bg-zinc-800 text-zinc-300"
              }`}
            >
              {isRunning && !isPaused ? (
                <Loader2 size={20} className="animate-spin" />
              ) : isPaused ? (
                <Pause size={20} />
              ) : (
                <ShieldCheck size={20} />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">Verificación del catálogo</h3>
                {isPaused && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                    PAUSADO
                  </span>
                )}
                {isRunning && !isPaused && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                    EN CURSO
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400">{headerStatusText}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowSettings((value) => !value)}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-zinc-700"
            >
              <Settings2 size={13} /> Ajustes
            </button>
            <button
              type="button"
              onClick={() => void loadStatus(true)}
              disabled={refreshing || loading}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> Actualizar
            </button>
          </div>
        </div>

        {/* ── Botones de acción dinámicos ────────────────────────── */}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {!isRunning ? (
            <>
              <button
                type="button"
                onClick={() => void runVerification("metadata")}
                disabled={isRunning || loading}
                className="flex items-center justify-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2.5 text-xs font-semibold text-blue-200 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {runningMode === "metadata" ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />} Solo
                metadatos
              </button>
              <button
                type="button"
                onClick={() => void runVerification("full")}
                disabled={isRunning || loading}
                className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 shadow-lg shadow-emerald-950/40"
              >
                {runningMode === "full" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Verificación
                completa
              </button>
              <button
                type="button"
                onClick={() => void repairCatalogLinks()}
                disabled={isRunning || loading || repairing}
                className="col-span-full flex items-center justify-center gap-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-2.5 text-xs font-semibold text-purple-200 transition-colors hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                title="Audita la base de datos y purga enlaces de landing pages (URLs de series completas) erróneamente asignados a episodios individuales"
              >
                {repairing ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />} Sanear Enlaces de Catálogo (Purga de Landing Pages)
              </button>
            </>
          ) : isPaused ? (
            <>
              <button
                type="button"
                onClick={() => void resumeVerification()}
                disabled={controlling}
                className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 shadow-lg shadow-emerald-950/40"
              >
                {controlling ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Reanudar verificación
              </button>
              <button
                type="button"
                onClick={() => void stopVerification()}
                disabled={controlling}
                className="flex items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Square size={14} /> Detener verificación
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void pauseVerification()}
                disabled={controlling}
                className="flex items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {controlling ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />} Pausar verificación
              </button>
              <button
                type="button"
                onClick={() => void stopVerification()}
                disabled={controlling}
                className="flex items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Square size={14} /> Detener verificación
              </button>
            </>
          )}
        </div>

        {/* ── Resumen de programación ────────────────────────────── */}
        <div className="mt-3 flex flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                status?.config.enabled ? "animate-pulse bg-emerald-500" : "bg-zinc-600"
              }`}
            />
            {configSummary}
          </span>
          <span>Última pasada: {formatDate(status?.last_run_at)}</span>
        </div>

        {/* ── Barra de progreso real e interactiva ───────────────── */}
        {(isRunning || (progress.total > 0 && completion < 100)) && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[10px] text-zinc-400">
              <span className="truncate pr-2 text-zinc-300">
                {status?.current_item || "Procesando catálogo..."}
              </span>
              <span className="shrink-0 font-mono font-semibold text-emerald-400">{completion}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isPaused ? "bg-amber-500" : "bg-gradient-to-r from-emerald-500 to-teal-400"
                }`}
                style={{ width: `${Math.max(2, completion)}%` }}
              />
            </div>
          </div>
        )}

        {actionFeedback && (
          <div
            className={`mt-3 flex items-start gap-2 text-[11px] ${
              actionFeedback.tone === "error" ? "text-red-300" : "text-emerald-300"
            }`}
          >
            <span className="mt-0.5">
              {actionFeedback.tone === "error" ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
            </span>
            {actionFeedback.message}
          </div>
        )}
        {pollError && (
          <div className="mt-2 flex items-start gap-2 text-[11px] text-amber-300">
            <span className="mt-0.5">
              <AlertCircle size={14} />
            </span>
            Error de conexión: {pollError}
          </div>
        )}
      </section>

      {/* El saneamiento se ejecuta fuera del worker interno; aquí solo se observa. */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white">Saneamiento de identidades</h3>
              {identityRepair && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    identityRepair.state === "running"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : identityRepair.state === "completed"
                      ? "bg-sky-500/15 text-sky-300"
                      : identityRepair.state === "failed"
                      ? "bg-red-500/15 text-red-300"
                      : "bg-zinc-700/60 text-zinc-300"
                  }`}
                >
                  {identityStateLabel}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-[11px] text-zinc-400">
              Reparación de TMDB/MAL/AniList ejecutada como proceso externo. Este bloque lee sus reportes y no lo pausa ni lo detiene.
            </p>
          </div>
          <div className="text-left text-[10px] text-zinc-500 sm:text-right">
            {identityRepair?.phase ? `Fase: ${identityPhaseLabel}` : "Esperando reportes"}
            {identityRepair?.pass ? ` · pasada ${identityRepair.pass}` : ""}
            {identityRepair?.batch ? ` · lote ${identityRepair.batch}` : ""}
          </div>
        </div>

        {identityRepair ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Metric label="Analizadas" value={identityRepair.considered} icon={<Database size={11} />} hint="Acumulado de reportes" />
              <Metric label="Aplicadas" value={identityRepair.applied} icon={<CheckCircle2 size={11} />} />
              <Metric label="Sin coincidencia" value={identityRepair.unresolved} icon={<AlertTriangle size={11} />} />
              <Metric label="Conflictos" value={identityRepair.conflicts} icon={<Layers size={11} />} />
              <Metric label="Errores" value={identityRepair.errors} icon={<AlertCircle size={11} />} />
            </div>
            <div className="mt-3 flex flex-col gap-1 text-[10px] text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
              <span>{identityRepair.message}</span>
              <span>{identityRepair.updated_at ? `Actualizado: ${formatDate(identityRepair.updated_at)}` : "Sin actualización"}</span>
            </div>
          </>
        ) : (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-500">
            No se pudo consultar todavía el reporte externo.
          </div>
        )}
      </section>

      {/* ── Métricas de la verificación ────────────────────────── */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Metadatos" value={metadataUpdated} icon={<Database size={11} />} hint="Obras enriquecidas" />
        <Metric label="Obras nuevas" value={createdWorks} icon={<CheckCircle2 size={11} />} hint="Nuevas en catálogo" />
        <Metric label="Fusionadas" value={mergedWorks} icon={<RefreshCw size={11} />} hint="Por deduplicación" />
        <Metric label="Episodios" value={progress.new_episodes ?? 0} icon={<Video size={11} />} hint="Nuevos episodios" />
        <Metric label="Fuentes agregadas" value={sourcesAdded} icon={<Layers size={11} />} hint="Nuevos streams/links" />
        <Metric label="Errores" value={progress.errors ?? 0} icon={<AlertCircle size={11} />} />
      </section>

      {/* ── Ajustes y Configuración ─────────────────────────────── */}
      {showSettings && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h4 className="text-xs font-bold text-white">Configuración del motor de verificación</h4>
              <p className="mt-0.5 text-[10px] text-zinc-500">Ajusta el alcance, la paginación y la frecuencia de auditoría.</p>
            </div>
            <Settings2 size={15} className="text-zinc-500" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  markConfigDirty();
                }}
                className="accent-emerald-500"
              />
              Activar verificación automática programada
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={metadataOnly}
                onChange={(event) => {
                  setMetadataOnly(event.target.checked);
                  markConfigDirty();
                }}
                className="accent-emerald-500"
              />
              Solo completar metadatos (ignorar escaneo de catálogo)
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={syncKnownEpisodes}
                onChange={(event) => {
                  setSyncKnownEpisodes(event.target.checked);
                  markConfigDirty();
                }}
                className="accent-emerald-500"
              />
              Buscar episodios nuevos en obras conocidas
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-300 sm:col-span-2">
              Páginas de catálogo por plataforma:
              <input
                type="number"
                min={0}
                max={5000}
                value={catalogPagesPerPlatform}
                onChange={(event) => {
                  setCatalogPagesPerPlatform(Math.max(0, Number(event.target.value) || 0));
                  markConfigDirty();
                }}
                className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-white"
              />
              <span className="text-[11px] text-zinc-500">
                {catalogPagesPerPlatform === 0
                  ? "(0 = Sin límite: recorrerá de forma autónoma todas las páginas hasta agotar el catálogo)"
                  : `(Máximo ${catalogPagesPerPlatform} páginas por plataforma)`}
              </span>
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-300">
              Alcance
              <select
                value={scopeMode}
                onChange={(event) => {
                  setScopeMode(event.target.value);
                  markConfigDirty();
                }}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-white"
              >
                <option value="all">Todo el catálogo</option>
                <option value="platforms">Plataformas específicas</option>
                <option value="category">Por categoría</option>
              </select>
            </label>

            {scopeMode === "platforms" && (
              <div className="sm:col-span-2 space-y-1">
                <label className="text-xs text-zinc-300">
                  Plataformas
                  <input
                    value={platforms}
                    onChange={(event) => {
                      setPlatforms(event.target.value);
                      markConfigDirty();
                    }}
                    placeholder="cinecalidad, lamovie_movies, animeflv"
                    className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-white"
                  />
                </label>
                {availablePlatforms.length > 0 && (
                  <div className="text-[10px] text-zinc-400">
                    <span className="text-zinc-500">Disponibles:</span> {availablePlatforms.join(", ")}
                  </div>
                )}
                {invalidPlatforms.length > 0 && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-400">
                    <AlertTriangle size={12} />
                    Plataforma(s) no configurada(s): {invalidPlatforms.join(", ")}
                  </div>
                )}
                {missingPlatforms && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-400">
                    <AlertTriangle size={12} /> Selecciona al menos una plataforma.
                  </div>
                )}
              </div>
            )}

            {scopeMode === "category" && (
              <div className="space-y-1">
                <label className="text-xs text-zinc-300">
                  Categoría
                  <input
                    value={category}
                    onChange={(event) => {
                      setCategory(event.target.value);
                      markConfigDirty();
                    }}
                    placeholder="anime, movie, series"
                    className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-white"
                  />
                </label>
                <div className="text-[10px] text-zinc-400">
                  <span className="text-zinc-500">Soportadas:</span> anime, movie, series
                </div>
                {invalidCategory && (
                  <div className="flex items-center gap-1 text-[11px] text-amber-400">
                    <AlertTriangle size={12} />
                    {category.trim()
                      ? "Categoría no reconocida. Use: anime, movie, movies, series"
                      : "Selecciona una categoría."}
                  </div>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-zinc-300">
              Frecuencia
              <input
                type="number"
                min={minInterval}
                value={intervalValue}
                onChange={(event) => {
                  setIntervalValue(Math.max(minInterval, Number(event.target.value) || minInterval));
                  markConfigDirty();
                }}
                className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-white"
              />
              <select
                value={intervalUnit}
                onChange={(event) => {
                  const nextUnit = Number(event.target.value);
                  setIntervalUnit(nextUnit);
                  if (nextUnit === 1 && intervalValue < 5) setIntervalValue(5);
                  markConfigDirty();
                }}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-white"
              >
                {UNITS.map((unit) => (
                  <option key={unit.factor} value={unit.factor}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void saveConfig()}
              disabled={saving || !configDirty || missingPlatforms || invalidPlatforms.length > 0 || invalidCategory}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Guardar configuración
            </button>
          </div>
        </section>
      )}

      {/* ── Último informe ───────────────────────────────────────── */}
      {report && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-xs font-bold text-white">Último informe de verificación</h4>
            <span className="text-[10px] text-zinc-500">
              {formatDuration(report.duration_ms)} · {formatDate(report.finished_at)}
            </span>
          </div>
          <div className="grid gap-2 text-[11px] text-zinc-400 sm:grid-cols-2">
            <div>
              Metadatos actualizados:{" "}
              <strong className="text-zinc-200">
                {report.metadata_phase?.updated_metadata ?? metadataUpdated}
              </strong>
            </div>
            <div>
              Elementos de catálogo analizados:{" "}
              <strong className="text-zinc-200">{report.catalog_phase?.items_seen ?? 0}</strong>
            </div>
            <div>
              Obras importadas:{" "}
              <strong className="text-zinc-200">{report.catalog_phase?.imported ?? createdWorks}</strong>
            </div>
            <div>
              Plataformas revisadas:{" "}
              <strong className="text-zinc-200">
                {report.catalog_phase?.platforms_checked?.join(", ") || "Ninguna"}
              </strong>
            </div>
          </div>
          {(report.catalog_phase?.errors?.length || 0) > 0 && (
            <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-300">
              {report.catalog_phase?.errors.slice(0, 3).join(" · ")}
            </div>
          )}
        </section>
      )}

      {/* ── Actividad reciente ──────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-bold text-white">
            <Clock3 size={13} /> Actividad reciente
          </h4>
          <div className="max-h-52 space-y-1 overflow-y-auto font-mono text-[11px]">
            {recent.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="flex gap-2">
                <span className="shrink-0 text-zinc-600">{new Date(entry.at).toLocaleTimeString()}</span>
                <span
                  className={
                    entry.level === "error"
                      ? "text-red-300"
                      : entry.level === "warn"
                      ? "text-amber-300"
                      : "text-zinc-400"
                  }
                >
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

export default VerificationPanel;
