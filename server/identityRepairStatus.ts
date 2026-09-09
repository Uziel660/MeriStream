import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type IdentityRepairPhase = "anime" | "shows" | "media" | null;
export type IdentityRepairState = "running" | "completed" | "failed" | "unknown";

export interface IdentityRepairStatus {
  state: IdentityRepairState;
  phase: IdentityRepairPhase;
  pass: number | null;
  batch: number | null;
  considered: number;
  applied: number;
  unresolved: number;
  conflicts: number;
  errors: number;
  batches: number;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  latest_report: string | null;
  report_dir: string;
  message: string;
}

interface StatusFile {
  state?: IdentityRepairState;
  phase?: IdentityRepairPhase;
  pass?: number | null;
  batch?: number | null;
  considered?: number;
  applied?: number;
  unresolved?: number;
  conflicts?: number;
  errors?: number;
  batches?: number;
  startedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  latestReport?: string | null;
  message?: string;
}

interface ReportSummary {
  considered?: number;
  updated?: number;
  applied?: number;
  unresolved?: number;
  conflicts?: number;
  errors?: number;
}

const REPORT_DIRS = [
  // Ejecución primaria actualmente reanudable. Debe tener prioridad sobre
  // reportes históricos para que el panel admin muestre el proceso vivo.
  path.resolve("work/catalog-identity-repair-primary-next"),
  path.resolve("work/catalog-identity-repair-entity-followup"),
  path.resolve("work/catalog-identity-repair-primary-followup"),
  path.resolve("work/catalog-identity-repair-primary"),
];
const RECENT_ACTIVITY_MS = 15 * 60 * 1000;

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeStatusFile(value: StatusFile, reportDir: string): IdentityRepairStatus {
  return {
    state: value.state || "unknown",
    phase: value.phase || null,
    pass: typeof value.pass === "number" ? value.pass : null,
    batch: typeof value.batch === "number" ? value.batch : null,
    considered: numberOrZero(value.considered),
    applied: numberOrZero(value.applied),
    unresolved: numberOrZero(value.unresolved),
    conflicts: numberOrZero(value.conflicts),
    errors: numberOrZero(value.errors),
    batches: numberOrZero(value.batches),
    started_at: value.startedAt || null,
    updated_at: value.updatedAt || null,
    completed_at: value.completedAt || null,
    latest_report: value.latestReport || null,
    report_dir: reportDir,
    message: value.message || "Estado no disponible.",
  };
}

function isFresh(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= RECENT_ACTIVITY_MS;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function reportLocation(fileName: string): { phase: IdentityRepairPhase; pass: number | null; batch: number | null } {
  const match = /^(anime|shows|media)-(\d+)-(\d+)\.json$/i.exec(fileName);
  if (!match) return { phase: null, pass: null, batch: null };
  return {
    phase: match[1].toLowerCase() as Exclude<IdentityRepairPhase, null>,
    pass: Number(match[2]),
    batch: Number(match[3]),
  };
}

function emptyFallback(reportDir: string, message: string): IdentityRepairStatus {
  return {
    state: "unknown",
    phase: null,
    pass: null,
    batch: null,
    considered: 0,
    applied: 0,
    unresolved: 0,
    conflicts: 0,
    errors: 0,
    batches: 0,
    started_at: null,
    updated_at: null,
    completed_at: null,
    latest_report: null,
    report_dir: reportDir,
    message,
  };
}

/** Lee el proceso externo sin modificar la base de datos ni sus reportes. */
export async function getIdentityRepairStatus(): Promise<IdentityRepairStatus> {
  const statusCandidates = await Promise.all(
    REPORT_DIRS.map(async (absoluteDir) => ({
      absoluteDir,
      value: await readJson<StatusFile>(path.join(absoluteDir, "status.json")),
    })),
  );
  const latestStatus = statusCandidates
    .filter((candidate): candidate is { absoluteDir: string; value: StatusFile } => Boolean(candidate.value))
    .sort((left, right) => Date.parse(right.value.updatedAt || "") - Date.parse(left.value.updatedAt || ""))[0];

  if (latestStatus) {
    const reportDir = path.relative(process.cwd(), latestStatus.absoluteDir).replaceAll("\\", "/");
    const status = normalizeStatusFile(latestStatus.value, reportDir);
    if (status.state === "running" && !isFresh(status.updated_at)) {
      return {
        ...status,
        state: "unknown",
        message: "El último estado quedó sin actualizar; revisa el proceso antes de reanudarlo.",
      };
    }
    return status;
  }

  const reportDir = path.relative(process.cwd(), REPORT_DIRS[1]).replaceAll("\\", "/");
  const reportRoot = REPORT_DIRS[1];
  let entries: string[];
  try {
    entries = (await readdir(reportRoot)).filter((entry) => /^(anime|shows|media)-\d+-\d+\.json$/i.test(entry));
  } catch {
    return emptyFallback(reportDir, "Todavía no hay reportes del saneamiento de identidades.");
  }

  if (entries.length === 0) return emptyFallback(reportDir, "Todavía no hay reportes del saneamiento de identidades.");

  const reports = await Promise.all(
    entries.map(async (fileName) => {
      const filePath = path.join(reportRoot, fileName);
      const [payload, fileStats] = await Promise.all([
        readJson<{ summary?: ReportSummary } & ReportSummary>(filePath),
        stat(filePath).catch(() => null),
      ]);
      return { fileName, payload, modifiedAt: fileStats?.mtime.toISOString() || null };
    }),
  );
  const validReports = reports.filter((report) => report.payload);
  const latest = [...validReports].sort(
    (left, right) => Date.parse(right.modifiedAt || "") - Date.parse(left.modifiedAt || ""),
  )[0];
  if (!latest) return emptyFallback(reportDir, "Los reportes encontrados no se pudieron leer.");

  const totals = validReports.reduce(
    (result, report) => {
      const summary = report.payload?.summary || report.payload || {};
      result.considered += numberOrZero(summary.considered);
      result.applied += numberOrZero(summary.applied ?? summary.updated);
      result.unresolved += numberOrZero(summary.unresolved);
      result.conflicts += numberOrZero(summary.conflicts);
      result.errors += numberOrZero(summary.errors);
      return result;
    },
    { considered: 0, applied: 0, unresolved: 0, conflicts: 0, errors: 0 },
  );
  const location = reportLocation(latest.fileName);
  const fresh = isFresh(latest.modifiedAt);
  const latestSummary = latest.payload?.summary || latest.payload || {};
  const completedByFinalMediaReport = location.phase === "media" && numberOrZero(latestSummary.considered) === 0;

  return {
    state: completedByFinalMediaReport ? "completed" : fresh ? "running" : "unknown",
    phase: location.phase,
    pass: location.pass,
    batch: location.batch,
    ...totals,
    batches: validReports.length,
    started_at: null,
    updated_at: latest.modifiedAt,
    completed_at: completedByFinalMediaReport ? latest.modifiedAt : null,
    latest_report: `${reportDir}/${latest.fileName}`,
    report_dir: reportDir,
    message: completedByFinalMediaReport
      ? "La ejecución terminó: el último lote agotó la fase de medios."
      : fresh
      ? "Ejecución externa detectada por actividad reciente en sus reportes."
      : "Hay reportes, pero no hay seguimiento en vivo de esta ejecución antigua.",
  };
}
