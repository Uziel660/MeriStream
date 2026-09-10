import { useEffect, useId, useState } from "react";
import { CheckCircle2, Flag, Loader2, Send, X } from "lucide-react";

export const REPORT_OPTIONS = [
  { value: "inappropriate", label: "Contenido inapropiado", hint: "El contenido no debería estar publicado." },
  { value: "wrong_classification", label: "Mala clasificación", hint: "Película, serie o anime no coincide." },
  { value: "incorrect_title_or_content", label: "Título o película incorrecta", hint: "La ficha dice una obra, pero reproduce otra." },
  { value: "wrong_metadata", label: "Datos o portada incorrectos", hint: "Título, año, sinopsis, género o imagen." },
  { value: "missing_or_wrong_subtitles", label: "Subtítulos ausentes o incorrectos", hint: "No aparecen, están rotos o tienen otro idioma." },
  { value: "wrong_language", label: "Idioma equivocado", hint: "El audio o la pista seleccionada no corresponde." },
  { value: "source_not_working", label: "Fuente no funciona", hint: "El servidor no carga o se cae constantemente." },
  { value: "other", label: "Otro problema", hint: "Cuéntanos algo que no aparece arriba." },
] as const;

export interface ReportControlProps {
  title: string;
  showId?: string | null;
  tmdbId?: number | null;
  kind?: string | null;
  episodeId?: string | null;
  episodeNumber?: number | null;
  sourceProvider?: string | null;
  sourceUrl?: string | null;
  compact?: boolean;
  className?: string;
}

export function ReportControl({
  title,
  showId,
  tmdbId,
  kind,
  episodeId,
  episodeNumber,
  sourceProvider,
  sourceUrl,
  compact = false,
  className = "",
}: ReportControlProps) {
  const [open, setOpen] = useState(false);
  const [reportType, setReportType] = useState<string>(REPORT_OPTIONS[0].value);
  const [details, setDetails] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state !== "sending") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, state]);

  const submit = async () => {
    setState("sending");
    setError(null);
    try {
      const response = await fetch("/api/v1/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          show_id: showId || undefined,
          tmdb_id: tmdbId || undefined,
          kind: kind || undefined,
          title,
          episode_id: episodeId || undefined,
          episode_number: episodeNumber ?? undefined,
          report_type: reportType,
          details: details.trim() || undefined,
          source_provider: sourceProvider || undefined,
          // Never send a signed/ephemeral playback URL from the browser. The
          // provider label plus the title is enough to investigate safely.
          source_url: sourceUrl && !/[?&](token|sig|signature|expires|exp)=/i.test(sourceUrl) ? sourceUrl : undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "No se pudo enviar el reporte.");
      }
      setState("sent");
    } catch (cause: any) {
      setError(cause?.message || "No se pudo enviar el reporte.");
      setState("error");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
          setState("idle");
          setError(null);
        }}
        className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-950/70 px-3 text-xs font-semibold text-zinc-300 transition hover:border-amber-400/50 hover:bg-amber-400/10 hover:text-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400/60 ${className}`}
        aria-label={`Reportar un problema con ${title}`}
        title="Reportar un problema con esta obra"
      >
        <Flag size={compact ? 14 : 15} />
        {!compact && <span>Reportar</span>}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="presentation"
          onClick={() => state !== "sending" && setOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700 bg-[#11161d] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300">Ayuda a mejorar el catálogo</p>
                <h2 id={titleId} className="mt-1 text-base font-semibold text-white">Reportar “{title}”</h2>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">El reporte se envía al equipo sin detener ni reiniciar la reproducción.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} disabled={state === "sending"} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white" aria-label="Cerrar reporte"><X size={17} /></button>
            </div>

            {state === "sent" ? (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <CheckCircle2 size={34} className="text-emerald-300" />
                <h3 className="text-sm font-semibold text-white">Reporte recibido</h3>
                <p className="max-w-sm text-xs leading-relaxed text-zinc-400">Gracias. Revisaremos esta obra y sus fuentes desde el panel de administración.</p>
                <button type="button" onClick={() => setOpen(false)} className="mt-2 rounded-lg bg-zinc-800 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-700">Cerrar</button>
              </div>
            ) : (
              <div className="space-y-4 px-5 py-5">
                <fieldset>
                  <legend className="mb-2 text-xs font-semibold text-zinc-200">¿Qué está mal?</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {REPORT_OPTIONS.map((option) => (
                      <label key={option.value} className={`cursor-pointer rounded-xl border px-3 py-2.5 transition ${reportType === option.value ? "border-amber-400/60 bg-amber-400/10" : "border-zinc-800 bg-zinc-950/50 hover:border-zinc-700"}`}>
                        <input type="radio" name={`report-type-${titleId}`} value={option.value} checked={reportType === option.value} onChange={() => setReportType(option.value)} className="sr-only" />
                        <span className={`block text-xs font-semibold ${reportType === option.value ? "text-amber-200" : "text-zinc-200"}`}>{option.label}</span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">{option.hint}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block text-xs font-semibold text-zinc-200">
                  Detalles <span className="font-normal text-zinc-500">(opcional)</span>
                  <textarea value={details} onChange={(event) => setDetails(event.target.value.slice(0, 2000))} rows={3} placeholder="Por ejemplo: aparece una película coreana distinta…" className="mt-2 w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs font-normal text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-amber-400/60" />
                </label>
                {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert">{error}</p>}
                <div className="flex items-center justify-end gap-2 border-t border-zinc-800 pt-4">
                  <button type="button" onClick={() => setOpen(false)} disabled={state === "sending"} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">Cancelar</button>
                  <button type="button" onClick={() => void submit()} disabled={state === "sending"} className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-xs font-bold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-50">
                    {state === "sending" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    {state === "sending" ? "Enviando…" : "Enviar reporte"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

export default ReportControl;
