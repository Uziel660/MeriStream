// src/components/AdminOperationsConsole.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type AdminOperationDefinition,
  type AdminOperationStatus,
} from "../api/client";

interface AdminOperationsConsoleProps {
  initialOperationId?: string;
  onSelectOperation?: (opId: string) => void;
  compact?: boolean;
}

function formatDate(isoString?: string | null): string {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "medium" });
}

function formatDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const sec = Math.floor((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export const AdminOperationsConsole: React.FC<AdminOperationsConsoleProps> = ({
  initialOperationId,
  onSelectOperation,
  compact = false,
}) => {
  const [definitions, setDefinitions] = useState<AdminOperationDefinition[]>([]);
  const [operations, setOperations] = useState<AdminOperationStatus[]>([]);
  const [selectedOpId, setSelectedOpId] = useState<string>(initialOperationId || "");
  const [fullLog, setFullLog] = useState<string>("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingLog, setLoadingLog] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filter & Search
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "completed" | "failed">("all");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [logSearchQuery, setLogSearchQuery] = useState<string>("");

  // Terminal Controls
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [fullscreen, setFullscreen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // New Operation Launcher
  const [isLauncherOpen, setIsLauncherOpen] = useState<boolean>(false);
  const [launchOpKey, setLaunchOpKey] = useState<string>("repair_catalog_ids");
  const [launchApply, setLaunchApply] = useState<boolean>(false);
  const [launchOnlyEmpty, setLaunchOnlyEmpty] = useState<boolean>(true);
  const [isLaunching, setIsLaunching] = useState<boolean>(false);
  const [launchFeedback, setLaunchFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Action states
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);

  // 1. Cargar lista de operaciones y definiciones
  const loadOperations = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingList(true);
    try {
      const data = await api.getAdminOperations();
      setDefinitions(data.definitions || []);
      setOperations(data.operations || []);
      setErrorMsg(null);

      // Si no hay seleccionada, seleccionar la activa o la más reciente
      setSelectedOpId((current) => {
        if (current && data.operations.some((op) => op.id === current)) {
          return current;
        }
        const active = data.operations.find((op) => op.state === "running" || op.state === "queued");
        if (active) return active.id;
        return data.operations[0]?.id || "";
      });
    } catch (err: any) {
      setErrorMsg(err?.message || "No se pudieron cargar las operaciones manuales.");
    } finally {
      if (!quiet) setLoadingList(false);
    }
  }, []);

  // 2. Cargar log completo de la operación seleccionada
  const loadLog = useCallback(async (opId: string, quiet = false) => {
    if (!opId) {
      setFullLog("");
      return;
    }
    if (!quiet) setLoadingLog(true);
    try {
      const res = await api.getAdminOperationLog(opId);
      setFullLog(res.log || "");
    } catch {
      // Fallback a output_tail si el endpoint de log no respondiera
      const op = operations.find((o) => o.id === opId);
      if (op?.output_tail) setFullLog(op.output_tail);
    } finally {
      if (!quiet) setLoadingLog(false);
    }
  }, [operations]);

  // Initial load
  useEffect(() => {
    void loadOperations();
  }, [loadOperations]);

  // Poll operations: si alguna está activa, refrescar cada 1.5s, sino cada 8s
  const hasRunningOps = useMemo(() => {
    return operations.some((op) => op.state === "running" || op.state === "queued");
  }, [operations]);

  useEffect(() => {
    const intervalMs = hasRunningOps ? 1500 : 8000;
    const timer = window.setInterval(() => {
      void loadOperations(true);
      if (selectedOpId) {
        void loadLog(selectedOpId, true);
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasRunningOps, loadOperations, loadLog, selectedOpId]);

  // Fetch log when selectedOpId changes
  useEffect(() => {
    if (selectedOpId) {
      void loadLog(selectedOpId);
      onSelectOperation?.(selectedOpId);
    }
  }, [selectedOpId, loadLog, onSelectOperation]);

  // Auto scroll terminal
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [fullLog, autoScroll]);

  // Selected Operation
  const selectedOperation = useMemo(() => {
    return operations.find((op) => op.id === selectedOpId) || null;
  }, [operations, selectedOpId]);

  // Filtered operations list
  const filteredOperations = useMemo(() => {
    return operations.filter((op) => {
      if (statusFilter === "running" && !(op.state === "running" || op.state === "queued")) return false;
      if (statusFilter === "completed" && op.state !== "completed") return false;
      if (statusFilter === "failed" && op.state !== "failed") return false;
      if (searchFilter.trim()) {
        const q = searchFilter.toLowerCase();
        const matchLabel = (op.label || "").toLowerCase().includes(q);
        const matchId = (op.id || "").toLowerCase().includes(q);
        const matchDesc = (op.description || "").toLowerCase().includes(q);
        if (!matchLabel && !matchId && !matchDesc) return false;
      }
      return true;
    });
  }, [operations, statusFilter, searchFilter]);

  // Selected definition for launcher
  const selectedDefinition = useMemo(() => {
    return definitions.find((d) => d.id === launchOpKey) || definitions[0] || null;
  }, [definitions, launchOpKey]);

  // Handlers
  const handleLaunchOperation = async () => {
    if (!selectedDefinition) return;
    setIsLaunching(true);
    setLaunchFeedback(null);
    try {
      const started = await api.startAdminOperation(selectedDefinition.id, {
        apply: launchApply,
        onlyEmpty: launchOnlyEmpty,
      });
      setLaunchFeedback({ tone: "success", text: `¡Operación iniciada con ID: ${started.id}!` });
      setSelectedOpId(started.id);
      setIsLauncherOpen(false);
      void loadOperations(true);
    } catch (err: any) {
      setLaunchFeedback({ tone: "error", text: err?.message || "Error al iniciar la operación." });
    } finally {
      setIsLaunching(false);
    }
  };

  const handleCancelOperation = async (opId: string) => {
    if (!opId) return;
    if (!confirm("¿Deseas detener y cancelar esta operación en ejecución?")) return;
    setIsCancelling(true);
    try {
      await api.cancelAdminOperation(opId);
      void loadOperations(true);
      void loadLog(opId, true);
    } catch (err: any) {
      alert(`Error al cancelar: ${err?.message || "Desconocido"}`);
    } finally {
      setIsCancelling(false);
    }
  };

  const handleDeleteOperation = async (opId: string) => {
    if (!opId) return;
    if (!confirm("¿Eliminar este registro y su archivo de logs?")) return;
    setIsDeleting(true);
    try {
      await api.deleteAdminOperation(opId);
      if (selectedOpId === opId) {
        setSelectedOpId("");
        setFullLog("");
      }
      void loadOperations(true);
    } catch (err: any) {
      alert(`Error al eliminar: ${err?.message || "Desconocido"}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyLogs = () => {
    if (!fullLog) return;
    navigator.clipboard.writeText(fullLog).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownloadLog = () => {
    if (!fullLog || !selectedOperation) return;
    const blob = new Blob([fullLog], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedOperation.id}.log`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Filtered log lines if search is typed in terminal
  const logLines = useMemo(() => {
    if (!fullLog) return [];
    const lines = fullLog.split(/\r?\n/);
    if (!logSearchQuery.trim()) return lines;
    const q = logSearchQuery.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(q));
  }, [fullLog, logSearchQuery]);

  return (
    <div className={`space-y-4 text-zinc-200 ${fullscreen ? "fixed inset-0 z-[100] bg-[#0b0f14] p-6 overflow-y-auto" : ""}`}>
      {/* ── 1. BARRA SUPERIOR / ESTADÍSTICAS Y LANZADOR ───────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
            <Terminal size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              Consola de Operaciones Manuales
              {hasRunningOps && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse">
                  <Loader2 size={10} className="animate-spin" />
                  En ejecución
                </span>
              )}
            </h3>
            <p className="text-xs text-zinc-400">
              Audita, ejecuta y monitorea en tiempo real scripts de saneamiento, TMDB, índices y mantenimiento.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void loadOperations(true);
              if (selectedOpId) void loadLog(selectedOpId, true);
            }}
            className="p-2 rounded-xl border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold transition"
            title="Refrescar lista y logs"
          >
            <RefreshCw size={14} className={loadingList || loadingLog ? "animate-spin text-violet-400" : ""} />
          </button>

          <button
            type="button"
            onClick={() => {
              setIsLauncherOpen(true);
              setLaunchFeedback(null);
            }}
            className="px-3.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-xs transition flex items-center gap-1.5 shadow-lg shadow-violet-600/20"
          >
            <Play size={14} />
            Nueva Operación
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <AlertCircle size={14} />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* ── MODAL / DRAWER PARA INICIAR OPERACIÓN ─────────────────────── */}
      {isLauncherOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setIsLauncherOpen(false)}
        >
          <div
            className="w-full max-w-xl bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
                  <Play size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Ejecutar Operación Manual</h3>
                  <p className="text-[11px] text-zinc-400">Selecciona el script y los modificadores de ejecución.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsLauncherOpen(false)}
                className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-zinc-300 font-semibold block mb-1">Tipo de Operación *</label>
                <select
                  value={launchOpKey}
                  onChange={(e) => {
                    setLaunchOpKey(e.target.value);
                    setLaunchApply(false);
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-700 text-white text-xs focus:outline-none focus:border-violet-500"
                >
                  {definitions.map((def) => (
                    <option key={def.id} value={def.id}>
                      {def.label} {def.mutating ? "(Modifica BD)" : "(Solo Lectura / Auditoría)"}
                    </option>
                  ))}
                </select>
              </div>

              {selectedDefinition && (
                <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800 text-zinc-400 text-xs space-y-2">
                  <p className="leading-relaxed">{selectedDefinition.description}</p>
                  {selectedDefinition.requiresApply && (
                    <div className="flex items-center gap-1.5 text-amber-300 text-[11px]">
                      <AlertTriangle size={13} className="shrink-0" />
                      <span>Requiere activar «Aplicar cambios» para escribir en la base de datos.</span>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2 pt-1 border-t border-zinc-850">
                {selectedDefinition?.mutating && (
                  <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer p-2 rounded-lg bg-zinc-950/40 hover:bg-zinc-950 border border-zinc-800">
                    <input
                      type="checkbox"
                      checked={launchApply}
                      onChange={(e) => setLaunchApply(e.target.checked)}
                      className="accent-emerald-500 h-4 w-4 rounded cursor-pointer"
                    />
                    <div>
                      <span className="font-semibold block">Aplicar cambios en la base de datos (--apply)</span>
                      <span className="text-[10px] text-zinc-500">
                        Si está desmarcado, se ejecutará en modo seguro de prueba / simulación (Dry Run).
                      </span>
                    </div>
                  </label>
                )}

                {["repair_catalog_ids", "repair_tmdb_safe", "repair_anime_ids", "verify_catalog_ids"].includes(launchOpKey) && (
                  <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer p-2 rounded-lg bg-zinc-950/40 hover:bg-zinc-950 border border-zinc-800">
                    <input
                      type="checkbox"
                      checked={launchOnlyEmpty}
                      onChange={(e) => setLaunchOnlyEmpty(e.target.checked)}
                      className="accent-violet-500 h-4 w-4 rounded cursor-pointer"
                    />
                    <div>
                      <span className="font-semibold block">Procesar solo obras sin identificadores</span>
                      <span className="text-[10px] text-zinc-500">Ignora obras que ya tengan TMDB/IMDb o ID válido asignado.</span>
                    </div>
                  </label>
                )}
              </div>

              {launchFeedback && (
                <div
                  className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${
                    launchFeedback.tone === "error"
                      ? "bg-red-950/30 border-red-500/40 text-red-300"
                      : "bg-emerald-950/30 border-emerald-500/40 text-emerald-300"
                  }`}
                >
                  {launchFeedback.tone === "error" ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
                  <span>{launchFeedback.text}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
              <button
                type="button"
                disabled={isLaunching}
                onClick={() => setIsLauncherOpen(false)}
                className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white text-xs transition"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={isLaunching || Boolean(selectedDefinition?.requiresApply && !launchApply)}
                onClick={handleLaunchOperation}
                className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-bold text-xs transition flex items-center gap-1.5 shadow-lg shadow-violet-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLaunching ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {isLaunching ? "Iniciando proceso..." : "Ejecutar Operación"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 2. LAYOUT PRINCIPAL: HISTORIAL DE OPERACIONES + CONSOLA ────── */}
      <div className={`grid gap-4 ${compact ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-12"}`}>
        {/* ── COLUMNA IZQUIERDA: LISTA DE OPERACIONES (4 cols) ─────────── */}
        <div className={`${compact ? "w-full" : "lg:col-span-4"} space-y-3`}>
          {/* Filtros de la lista */}
          <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-300">
              <span className="flex items-center gap-1.5">
                <Layers size={13} className="text-violet-400" />
                Historial de Operaciones
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">
                {filteredOperations.length} / {operations.length}
              </span>
            </div>

            {/* Buscador y estado */}
            <div className="space-y-1.5">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-zinc-500" />
                <input
                  type="text"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Filtrar por nombre o ID..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                />
              </div>

              <div className="flex gap-1 overflow-x-auto text-[10px] font-medium pt-1">
                {[
                  { key: "all" as const, label: "Todas" },
                  { key: "running" as const, label: "En curso" },
                  { key: "completed" as const, label: "Completadas" },
                  { key: "failed" as const, label: "Con error" },
                ].map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStatusFilter(f.key)}
                    className={`px-2 py-1 rounded-md transition shrink-0 ${
                      statusFilter === f.key
                        ? "bg-violet-600 text-white font-bold"
                        : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Listado scrolleable */}
          <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
            {filteredOperations.length === 0 ? (
              <div className="p-6 rounded-xl border border-dashed border-zinc-800 text-center text-xs text-zinc-500 space-y-1">
                <Terminal size={24} className="mx-auto text-zinc-600" />
                <p>No hay operaciones que coincidan.</p>
              </div>
            ) : (
              filteredOperations.map((op) => {
                const isSelected = op.id === selectedOpId;
                const isRunning = op.state === "running" || op.state === "queued";
                const isSuccess = op.state === "completed";
                const isFailed = op.state === "failed";

                return (
                  <div
                    key={op.id}
                    onClick={() => setSelectedOpId(op.id)}
                    className={`p-3 rounded-xl border transition-all cursor-pointer text-left space-y-2 ${
                      isSelected
                        ? "bg-zinc-900 border-violet-500/80 shadow-lg shadow-violet-500/10 ring-1 ring-violet-500/50"
                        : "bg-zinc-900/40 border-zinc-800/80 hover:bg-zinc-900/80 hover:border-zinc-700"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isRunning
                                ? "bg-emerald-400 animate-pulse"
                                : isSuccess
                                ? "bg-sky-400"
                                : isFailed
                                ? "bg-red-400"
                                : "bg-zinc-600"
                            }`}
                          />
                          <h4 className="text-xs font-bold text-white truncate">{op.label || op.operation}</h4>
                        </div>
                        <p className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate">{op.id}</p>
                      </div>

                      <span
                        className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                          isRunning
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : isSuccess
                            ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                            : isFailed
                            ? "bg-red-500/20 text-red-300 border border-red-500/30"
                            : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {op.state}
                      </span>
                    </div>

                    {/* Barra de progreso si está corriendo o tiene % */}
                    {isRunning && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px] text-zinc-400">
                          <span className="truncate pr-1">{op.current_item || "Ejecutando proceso..."}</span>
                          <span className="font-mono text-violet-300 shrink-0">
                            {typeof op.progress_percent === "number" ? `${op.progress_percent}%` : "—"}
                          </span>
                        </div>
                        <div className="h-1 bg-zinc-950 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-violet-400 transition-all"
                            style={{
                              width: `${typeof op.progress_percent === "number" ? op.progress_percent : 40}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Metadatos: Inicio y Duración */}
                    <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-1 border-t border-zinc-850 font-mono">
                      <span>{formatDate(op.started_at)}</span>
                      <span>Duración: {formatDuration(op.started_at, op.finished_at)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── COLUMNA DERECHA: CONSOLA Y LOGS EN TIEMPO REAL (8 cols) ─── */}
        <div className={`${compact ? "w-full" : "lg:col-span-8"} space-y-3`}>
          {selectedOperation ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 shadow-2xl overflow-hidden flex flex-col h-full min-h-[580px]">
              {/* Header de la Consola */}
              <div className="p-3 sm:p-4 bg-zinc-900 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded bg-violet-500/20 text-violet-300">
                      <Terminal size={14} />
                    </span>
                    <h3 className="text-xs sm:text-sm font-bold text-white truncate">{selectedOperation.label}</h3>
                    <span
                      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0 ${
                        selectedOperation.state === "running"
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse"
                          : selectedOperation.state === "completed"
                          ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                          : selectedOperation.state === "failed"
                          ? "bg-red-500/20 text-red-300 border border-red-500/30"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {selectedOperation.state}
                    </span>
                  </div>

                  <p className="text-[11px] text-zinc-400 font-mono truncate">
                    ID: {selectedOperation.id} · Log: {selectedOperation.log_file}
                  </p>
                </div>

                {/* Botones de acción de la consola */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Cancelar si está corriendo */}
                  {(selectedOperation.state === "running" || selectedOperation.state === "queued") && (
                    <button
                      type="button"
                      disabled={isCancelling}
                      onClick={() => handleCancelOperation(selectedOperation.id)}
                      className="px-2.5 py-1.5 rounded-lg bg-red-950/50 hover:bg-red-900/60 border border-red-500/40 text-red-300 text-xs font-semibold flex items-center gap-1 transition"
                      title="Detener proceso"
                    >
                      {isCancelling ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                      <span>Detener</span>
                    </button>
                  )}

                  {/* Auto-scroll toggle */}
                  <button
                    type="button"
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={`px-2 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition ${
                      autoScroll
                        ? "border-violet-500/50 bg-violet-500/10 text-violet-300"
                        : "border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                    title={autoScroll ? "Auto-scroll activado (sigue los logs)" : "Auto-scroll pausado"}
                  >
                    <ArrowDownCircle size={13} />
                    <span className="hidden sm:inline text-[10px]">Auto-scroll</span>
                  </button>

                  {/* Copiar logs */}
                  <button
                    type="button"
                    onClick={handleCopyLogs}
                    className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs transition"
                    title="Copiar logs completos al portapapeles"
                  >
                    {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  </button>

                  {/* Descargar log */}
                  <button
                    type="button"
                    onClick={handleDownloadLog}
                    className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs transition"
                    title="Descargar archivo de log (.log)"
                  >
                    <Download size={14} />
                  </button>

                  {/* Maximizar / Fullscreen */}
                  <button
                    type="button"
                    onClick={() => setFullscreen(!fullscreen)}
                    className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs transition"
                    title={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
                  >
                    {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>

                  {/* Eliminar registro */}
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => handleDeleteOperation(selectedOperation.id)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition"
                    title="Eliminar este registro"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Barra de búsqueda dentro del log */}
              <div className="px-4 py-2 bg-black/60 border-b border-zinc-900 flex items-center justify-between gap-3 text-xs">
                <div className="relative flex-1 max-w-sm">
                  <Search size={12} className="absolute left-2.5 top-2.5 text-zinc-500" />
                  <input
                    type="text"
                    value={logSearchQuery}
                    onChange={(e) => setLogSearchQuery(e.target.value)}
                    placeholder="Buscar en el log de esta consola..."
                    className="w-full pl-7 pr-3 py-1 rounded-md bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-violet-500 font-mono"
                  />
                </div>

                <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
                  <span>Líneas: {logLines.length}</span>
                  {selectedOperation.exit_code !== null && (
                    <span>Exit Code: {selectedOperation.exit_code}</span>
                  )}
                </div>
              </div>

              {/* Cuerpo del Terminal */}
              <div
                ref={terminalContainerRef}
                className="flex-1 p-4 bg-[#080b0f] font-mono text-[11px] leading-relaxed overflow-y-auto max-h-[500px] min-h-[400px] select-text space-y-0.5"
              >
                {logLines.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 text-zinc-500 space-y-3">
                    {selectedOperation.state === "running" || selectedOperation.state === "queued" ? (
                      <>
                        <Loader2 size={28} className="animate-spin text-violet-400 opacity-80" />
                        <p className="text-xs text-zinc-300 font-sans">
                          Operación en ejecución. Esperando la primera salida del proceso…
                        </p>
                        <p className="text-[10px] text-zinc-500 font-mono">
                          PID activo en segundo plano ({selectedOperation.id})
                        </p>
                      </>
                    ) : (
                      <>
                        <Terminal size={32} className="opacity-40" />
                        <p>No hay registros en el log para esta operación.</p>
                      </>
                    )}
                  </div>
                ) : (
                  logLines.map((line, idx) => {
                    const isErr = /\[error\]|error:|fatal:|exception:|failed/i.test(line);
                    const isWarn = /\[warn\]|warning:|skip/i.test(line);
                    const isSuccess = /\[success\]|\[ok\]|✓|completad[oa]|applied/i.test(line);
                    const isInfo = /\[info\]|\[start\]|\[step\]/i.test(line);
                    const isProgress = /progress|progreso|\b\d{1,3}%\b/i.test(line);

                    return (
                      <div
                        key={idx}
                        className={`flex items-start gap-2 hover:bg-white/[0.03] px-1 rounded transition-colors ${
                          isErr
                            ? "text-red-400 bg-red-950/20"
                            : isWarn
                            ? "text-amber-300"
                            : isSuccess
                            ? "text-emerald-300"
                            : isInfo
                            ? "text-sky-300"
                            : isProgress
                            ? "text-violet-300 font-semibold"
                            : "text-zinc-300"
                        }`}
                      >
                        <span className="text-zinc-700 select-none text-[9px] w-7 shrink-0 text-right">
                          {idx + 1}
                        </span>
                        <span className="break-all whitespace-pre-wrap">{line}</span>
                      </div>
                    );
                  })
                )}
                <div ref={terminalEndRef} />
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-zinc-800 p-12 text-center text-zinc-500 space-y-3">
              <Terminal size={36} className="mx-auto text-zinc-600" />
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-zinc-300">Ninguna operación seleccionada</h4>
                <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                  Selecciona una operación del historial de la izquierda o inicia una nueva operación con el botón superior.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminOperationsConsole;
