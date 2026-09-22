import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Image,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Tv,
  Users,
  Flag,
  Terminal,
} from "lucide-react";

export type AdminTab = "overview" | "smart" | "worker_tasks" | "operations" | "sources" | "reports" | "library" | "verification" | "genres" | "users";

interface AdminOverviewProps {
  onNavigate: (tab: AdminTab) => void;
}

interface OverviewData {
  generated_at: string;
  catalog: {
    shows: number;
    media_items: number;
    unique_works?: number;
    duplicate_records?: number;
    episodes: number;
    source_links: number;
    missing_tmdb: number;
    missing_artwork: number;
    duplicate_tmdb_ids: number;
  };
  operations: {
    active_jobs: number;
    pending_jobs: number;
    failed_jobs: number;
    verification_running: boolean;
    verification_phase: string;
    last_verification_at: string | null;
  };
  sources: {
    enabled_sites: number;
    total_sites: number;
    failing_links: number;
    provider_health: Array<{ provider: string; attempts: number; success_rate: number }>;
  };
  users: number;
  recent_works: Array<{ id: string; title: string; category: string; poster_url?: string | null; created_at?: string }>;
  reports?: { open: number; in_review: number; resolved: number; dismissed: number; actionable: number };
}

const EMPTY: OverviewData = {
  generated_at: "",
  catalog: { shows: 0, media_items: 0, episodes: 0, source_links: 0, missing_tmdb: 0, missing_artwork: 0, duplicate_tmdb_ids: 0 },
  operations: { active_jobs: 0, pending_jobs: 0, failed_jobs: 0, verification_running: false, verification_phase: "idle", last_verification_at: null },
  sources: { enabled_sites: 0, total_sites: 0, failing_links: 0, provider_health: [] },
  users: 0,
  recent_works: [],
  reports: { open: 0, in_review: 0, resolved: 0, dismissed: 0, actionable: 0 },
};

function number(value: number): string {
  return value.toLocaleString("es-MX");
}

function relativeDate(value?: string | null): string {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  tone?: "neutral" | "warning" | "good" | "blue";
  onClick?: () => void;
}) {
  const toneClass = {
    neutral: "text-zinc-300 bg-zinc-800/70",
    warning: "text-amber-300 bg-amber-400/10",
    good: "text-emerald-300 bg-emerald-400/10",
    blue: "text-sky-300 bg-sky-400/10",
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`group min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4 text-left transition-colors ${
        onClick ? "hover:border-zinc-600 hover:bg-zinc-900" : "cursor-default"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${toneClass}`}>{icon}</span>
        {onClick && <ArrowRight size={14} className="mt-1 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />}
      </div>
      <div className="mt-5 text-2xl font-semibold tracking-tight text-white">{value}</div>
      <div className="mt-1 text-[11px] font-medium text-zinc-300">{label}</div>
      <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">{detail}</div>
    </button>
  );
}

export const AdminOverview: React.FC<AdminOverviewProps> = ({ onNavigate }) => {
  const [data, setData] = useState<OverviewData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/v1/admin/overview", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`No se pudo cargar el resumen (${response.status})`);
      const next = (await response.json()) as OverviewData;
      setData(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el resumen");
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const totalWorks = data.catalog.unique_works ?? (data.catalog.shows + data.catalog.media_items);
  const duplicateRecords = data.catalog.duplicate_records ?? Math.max(0, data.catalog.shows + data.catalog.media_items - totalWorks);

  return (
    <section className="space-y-6" aria-labelledby="admin-overview-title">
      <div className="flex flex-col justify-between gap-4 border-b border-zinc-800/80 pb-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">Centro de control</p>
          <h1 id="admin-overview-title" className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Estado de MeriStream</h1>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-zinc-400">Lo importante primero: catálogo, salud de fuentes y tareas que necesitan atención.</p>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={refreshing} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50">
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          Actualizar estado
        </button>
      </div>

      {error && <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3 text-xs text-red-300"><AlertTriangle size={15} />{error}</div>}

      {loading ? (
        <div className="admin-overview-skeleton" role="status" aria-live="polite" aria-label="Consultando el estado del catálogo">
          <div className="admin-overview-skeleton-row">
            {Array.from({ length: 4 }, (_, index) => <div key={index} className="admin-overview-skeleton-block" />)}
          </div>
          <div className="admin-overview-skeleton-row" style={{ gridTemplateColumns: '1.25fr .75fr' }}>
            <div className="admin-overview-skeleton-block is-large" />
            <div className="admin-overview-skeleton-block is-large" />
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-zinc-500">
            <Loader2 size={15} className="animate-spin" />
            Consultando el estado del catálogo…
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard label="Obras únicas en catálogo" value={number(totalWorks)} detail={`${number(data.catalog.shows)} fichas · ${number(data.catalog.media_items)} multimedia · ${number(duplicateRecords)} registros duplicados`} icon={<Database size={15} />} tone="blue" onClick={() => onNavigate("library")} />
            <MetricCard label="Identidades pendientes" value={number(data.catalog.missing_tmdb)} detail="Sin ID TMDB confirmado; revisar antes de enriquecer" icon={<Sparkles size={15} />} tone={data.catalog.missing_tmdb ? "warning" : "good"} onClick={() => onNavigate("library")} />
            <MetricCard label="Artwork por completar" value={number(data.catalog.missing_artwork)} detail="Poster o backdrop ausente" icon={<Image size={15} />} tone={data.catalog.missing_artwork ? "warning" : "good"} onClick={() => onNavigate("library")} />
            <MetricCard label="Fuentes habilitadas" value={`${number(data.sources.enabled_sites)}/${number(data.sources.total_sites)}`} detail={`${number(data.sources.failing_links)} enlaces con fallos recientes`} icon={<Server size={15} />} tone={data.sources.failing_links ? "warning" : "good"} onClick={() => onNavigate("sources")} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.25fr_.75fr]">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Operación</p>
                  <h2 className="mt-1 text-base font-semibold text-white">Qué está pasando ahora</h2>
                </div>
                <Activity size={17} className={data.operations.active_jobs || data.operations.verification_running ? "text-emerald-300" : "text-zinc-600"} />
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button type="button" onClick={() => onNavigate("worker_tasks")} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-left transition-colors hover:border-zinc-600">
                  <span><span className="block text-xs font-semibold text-zinc-200">Cola del worker</span><span className="mt-1 block text-[10px] text-zinc-500">{data.operations.active_jobs} activas · {data.operations.pending_jobs} pendientes</span></span>
                  <span className="text-lg font-semibold text-white">{number(data.operations.active_jobs + data.operations.pending_jobs)}</span>
                </button>
                <button type="button" onClick={() => onNavigate("operations")} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-left transition-colors hover:border-zinc-600">
                  <span><span className="block text-xs font-semibold text-zinc-200">Operaciones manuales</span><span className="mt-1 block text-[10px] text-zinc-500">Terminal y logs en tiempo real</span></span>
                  <Terminal size={18} className="text-violet-400" />
                </button>
                <button type="button" onClick={() => onNavigate("verification")} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-left transition-colors hover:border-zinc-600">
                  <span><span className="block text-xs font-semibold text-zinc-200">Verificación</span><span className="mt-1 block text-[10px] text-zinc-500">{data.operations.verification_running ? `Ejecutando · ${data.operations.verification_phase}` : "Sin ejecución activa"}</span></span>
                  {data.operations.verification_running ? <Loader2 size={18} className="animate-spin text-emerald-300" /> : <CheckCircle2 size={18} className="text-zinc-600" />}
                </button>
                <button type="button" onClick={() => onNavigate("reports")} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-left transition-colors hover:border-zinc-600">
                  <span className="flex items-center gap-2"><span className={`grid h-7 w-7 place-items-center rounded-lg ${data.reports?.actionable ? "bg-amber-400/10 text-amber-300" : "bg-zinc-800 text-zinc-500"}`}><Flag size={14} /></span><span><span className="block text-xs font-semibold text-zinc-200">Reportes del catálogo</span><span className="mt-1 block text-[10px] text-zinc-500">{data.reports?.open || 0} pendientes · {data.reports?.in_review || 0} en revisión</span></span></span>
                  <span className={`text-lg font-semibold ${data.reports?.actionable ? "text-amber-200" : "text-zinc-500"}`}>{data.reports?.actionable || 0}</span>
                </button>
              </div>
              {data.operations.failed_jobs > 0 && <button type="button" onClick={() => onNavigate("worker_tasks")} className="mt-3 flex w-full items-center gap-2 rounded-lg border border-red-500/25 bg-red-950/20 px-3 py-2 text-left text-[11px] text-red-300"><AlertTriangle size={14} />{data.operations.failed_jobs} tareas fallidas requieren revisión</button>}
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
              <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Cobertura</p><h2 className="mt-1 text-base font-semibold text-white">Salud del sistema</h2></div><ShieldCheck size={17} className="text-sky-300" /></div>
              <div className="mt-5 space-y-4">
                <div><div className="flex items-center justify-between text-[11px]"><span className="text-zinc-400">Fuentes habilitadas</span><span className="font-mono text-zinc-200">{data.sources.enabled_sites}/{data.sources.total_sites}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-sky-300" style={{ width: `${data.sources.total_sites ? Math.min(100, (data.sources.enabled_sites / data.sources.total_sites) * 100) : 0}%` }} /></div></div>
                <div><div className="flex items-center justify-between text-[11px]"><span className="text-zinc-400">Enlaces con estado</span><span className="font-mono text-zinc-200">{number(Math.max(0, data.catalog.source_links - data.sources.failing_links))}/{number(data.catalog.source_links)}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-emerald-300" style={{ width: `${data.catalog.source_links ? Math.min(100, (Math.max(0, data.catalog.source_links - data.sources.failing_links) / data.catalog.source_links) * 100) : 0}%` }} /></div></div>
                <div className="flex items-center justify-between border-t border-zinc-800 pt-3 text-[11px]"><span className="text-zinc-400">Usuarios registrados</span><span className="flex items-center gap-1.5 font-mono text-zinc-200"><Users size={13} />{number(data.users)}</span></div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
              <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Catálogo reciente</p><h2 className="mt-1 text-base font-semibold text-white">Últimas obras incorporadas</h2></div><Tv size={17} className="text-zinc-500" /></div>
              <div className="mt-4 divide-y divide-zinc-800/70">
                {data.recent_works.length === 0 ? <p className="py-5 text-xs text-zinc-500">No hay incorporaciones recientes.</p> : data.recent_works.map((work) => <div key={work.id} className="flex items-center gap-3 py-3"><div className="h-10 w-7 shrink-0 overflow-hidden rounded bg-zinc-800">{work.poster_url ? <img src={work.poster_url} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="h-full w-full bg-zinc-800" />}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-zinc-200">{work.title}</p><p className="mt-1 text-[10px] text-zinc-500">{work.category || "Sin categoría"} · {relativeDate(work.created_at)}</p></div></div>)}
              </div>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
              <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Proveedores</p><h2 className="mt-1 text-base font-semibold text-white">Rendimiento reciente</h2></div><Server size={17} className="text-zinc-500" /></div>
              <div className="mt-4 space-y-3">{data.sources.provider_health.length === 0 ? <p className="py-5 text-xs text-zinc-500">Aún no hay suficientes eventos de reproducción.</p> : data.sources.provider_health.slice(0, 5).map((provider) => <div key={provider.provider} className="flex items-center gap-3"><span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{provider.provider}</span><span className="text-[10px] font-mono text-zinc-500">{number(provider.attempts)} pruebas</span><span className={`w-12 text-right text-xs font-semibold ${provider.success_rate >= 80 ? "text-emerald-300" : provider.success_rate >= 50 ? "text-amber-300" : "text-red-300"}`}>{provider.success_rate}%</span></div>)}</div>
              <button type="button" onClick={() => onNavigate("sources")} className="mt-5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-sky-300 hover:text-white">Gestionar fuentes <ArrowRight size={13} /></button>
            </div>
          </div>
        </>
      )}
    </section>
  );
};

export default AdminOverview;
