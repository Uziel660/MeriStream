import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, ChevronDown, Clock3, Edit3, Flag, Loader2, RefreshCw } from "lucide-react";
import { REPORT_OPTIONS } from "./ReportControl";

type ReportStatus = "open" | "in_review" | "resolved" | "dismissed";

interface ReportRow {
  id: string;
  show_id: string | null;
  tmdb_id: number | null;
  kind: string | null;
  title: string;
  episode_id: string | null;
  episode_number: number | null;
  report_type: string;
  details: string | null;
  source_provider: string | null;
  source_url: string | null;
  status: ReportStatus;
  admin_note: string | null;
  resolution_action: string | null;
  created_at: string;
  resolved_at: string | null;
  matched_show?: { id: string; title: string; category: string; tmdb_id: number | null; poster_url: string | null } | null;
}

const STATUS_LABELS: Record<ReportStatus, string> = {
  open: "Pendiente",
  in_review: "En revisión",
  resolved: "Resuelto",
  dismissed: "Descartado",
};

const STATUS_STYLES: Record<ReportStatus, string> = {
  open: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  in_review: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  resolved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  dismissed: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Fecha desconocida" : date.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

function reportLabel(value: string) {
  return REPORT_OPTIONS.find((option) => option.value === value)?.label || value;
}

export default function AdminReports({ onEditShow }: { onEditShow: (show: any) => void }) {
  const [status, setStatus] = useState<"all" | ReportStatus>("open");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [summary, setSummary] = useState({ open: 0, in_review: 0, resolved: 0, dismissed: 0, actionable: 0 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const query = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
      const [reportsResponse, summaryResponse] = await Promise.all([
        fetch(`/api/v1/admin/reports${query}`, { credentials: "same-origin" }),
        fetch("/api/v1/admin/reports/summary", { credentials: "same-origin" }),
      ]);
      if (!reportsResponse.ok) throw new Error(`No se pudieron cargar los reportes (${reportsResponse.status})`);
      const payload = await reportsResponse.json();
      const nextRows = Array.isArray(payload.reports) ? payload.reports : [];
      setRows(nextRows);
      setSummary(summaryResponse.ok ? await summaryResponse.json() : { open: 0, in_review: 0, resolved: 0, dismissed: 0, actionable: 0 });
      setError(null);
    } catch (cause: any) {
      setError(cause?.message || "No se pudieron cargar los reportes.");
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, [load]);

  const update = async (id: string, patch: { status?: ReportStatus; admin_note?: string; resolution_action?: string }) => {
    setSavingId(id);
    try {
      const response = await fetch(`/api/v1/admin/reports/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "No se pudo actualizar el reporte.");
      await load();
    } catch (cause: any) {
      setError(cause?.message || "No se pudo actualizar el reporte.");
    } finally {
      setSavingId(null);
    }
  };

  const statusCounts = useMemo(() => [
    ["all", "Todos", summary.open + summary.in_review + summary.resolved + summary.dismissed],
    ["open", "Pendientes", summary.open],
    ["in_review", "En revisión", summary.in_review],
    ["resolved", "Resueltos", summary.resolved],
    ["dismissed", "Descartados", summary.dismissed],
  ] as Array<["all" | ReportStatus, string, number]>, [summary]);

  return (
    <section className="space-y-6" aria-labelledby="admin-reports-title">
      <div className="flex flex-col justify-between gap-4 border-b border-zinc-800/80 pb-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">Calidad colaborativa</p>
          <h1 id="admin-reports-title" className="mt-2 text-2xl font-semibold tracking-tight text-white">Reportes del catálogo</h1>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-zinc-400">Cada aviso conserva la obra, el episodio y la plataforma que el usuario estaba viendo. Desde aquí puedes investigarlo y abrir la ficha para corregirla.</p>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={refreshing} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Actualizar</button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {statusCounts.map(([key, label, count]) => <button key={key} type="button" onClick={() => setStatus(key)} className={`rounded-xl border px-3 py-3 text-left transition ${status === key ? "border-amber-400/60 bg-amber-400/10" : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700"}`}><span className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span><span className="mt-1 block text-xl font-semibold text-white">{count}</span></button>)}
      </div>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">{error}</div>}
      {loading ? <div className="flex items-center justify-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/60 py-16 text-xs text-zinc-500"><Loader2 size={16} className="animate-spin" /> Consultando reportes…</div> : rows.length === 0 ? <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-5 py-16 text-center"><CheckCircle2 className="mx-auto text-emerald-300" size={28} /><p className="mt-3 text-sm font-semibold text-zinc-200">No hay reportes en esta vista</p><p className="mt-1 text-xs text-zinc-500">Los nuevos avisos aparecerán aquí automáticamente.</p></div> : (
        <div className="space-y-3">
          {rows.map((row) => {
            const isExpanded = expanded === row.id;
            const matchedShow = row.matched_show;
            return (
              <article key={row.id} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/70">
                <button type="button" onClick={() => setExpanded(isExpanded ? null : row.id)} className="flex w-full items-start gap-3 px-4 py-4 text-left transition hover:bg-zinc-900/60">
                  <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${row.status === "open" ? "bg-amber-400/10 text-amber-300" : "bg-zinc-800 text-zinc-400"}`}><Flag size={15} /></span>
                  <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><strong className="truncate text-sm text-white">{row.title}</strong><span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[row.status]}`}>{STATUS_LABELS[row.status]}</span></span><span className="mt-1 block text-xs text-amber-200">{reportLabel(row.report_type)}</span><span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500"><span className="inline-flex items-center gap-1"><Clock3 size={11} />{formatDate(row.created_at)}</span>{row.source_provider && <span>Fuente: {row.source_provider}</span>}{row.episode_number != null && <span>Episodio {row.episode_number}</span>}{row.tmdb_id && <span>TMDB {row.tmdb_id}</span>}</span></span><ChevronDown size={16} className={`mt-1 shrink-0 text-zinc-500 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                </button>
                {isExpanded && <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                  <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
                    <div className="space-y-3"><div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Descripción del usuario</p><p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">{row.details || "Sin detalles adicionales."}</p></div>{row.source_url && <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Locator registrado</p><p className="mt-1 break-all font-mono text-[10px] text-zinc-400">{row.source_url}</p></div>}</div>
                    <div className="flex flex-col gap-2 lg:min-w-48">{matchedShow ? <button type="button" onClick={() => onEditShow(matchedShow)} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-sky-500/15 px-3 text-xs font-semibold text-sky-200 ring-1 ring-sky-500/30 transition hover:bg-sky-500/25"><Edit3 size={14} /> Abrir editor de obra</button> : <span className="rounded-lg border border-zinc-800 px-3 py-2 text-center text-[10px] leading-relaxed text-zinc-500">No hay una ficha local vinculada. Usa el TMDB {row.tmdb_id || "ID"} para localizarla.</span>}<select value={row.status} disabled={savingId === row.id} onChange={(event) => void update(row.id, { status: event.target.value as ReportStatus })} className="min-h-10 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-200 outline-none focus:border-amber-400/60"><option value="open">Pendiente</option><option value="in_review">Marcar en revisión</option><option value="resolved">Resolver</option><option value="dismissed">Descartar</option></select></div>
                  </div>
                  <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3 sm:flex-row"><input value={notes[row.id] ?? row.admin_note ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))} placeholder="Nota interna para recordar qué se corrigió…" className="min-h-10 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-amber-400/60" /><button type="button" disabled={savingId === row.id} onClick={() => void update(row.id, { admin_note: notes[row.id] ?? "" })} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">{savingId === row.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Guardar nota</button></div>
                </div>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
