// server/watchdog.ts
// ══════════════════════════════════════════════════════════════════
// WATCHDOG AUTO-REPARADOR
// Worker periódico que escanea la base de datos en busca de anomalías
// y las repara automáticamente. Registra hallazgos en un archivo JSON
// para que el asistente (opencode) los revise y actúe.
//
// Anomalías detectadas:
//  - Títulos basura / placeholder (vacíos, "Sin título", "test", etc.)
//  - Descripciones faltantes o placeholder
//  - Posters faltantes
//  - Obras sin episodios (catálogo fantasma)
//  - Jobs fallidos o stuck en "running" por >30 min
//  - Fuentes huérfanas (SourceLinks sin MediaItem válido)
//
// Config: data/watchdog.config.json
// Reportes: data/watchdog-reports.json (últimos 50 hallazgos)
// ══════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { prisma } from "./db";
import { normalizeTitleKey } from "./utils/titleNormalizer";

// ── Tipos ────────────────────────────────────────────────────────

export interface WatchdogConfig {
  enabled: boolean;
  interval_minutes: number;
  auto_fix: boolean;
  title_patterns_blacklist: string[];
}

export interface WatchdogFinding {
  id: string;
  timestamp: string;
  severity: "info" | "warn" | "error" | "critical";
  category: "title" | "metadata" | "orphan" | "stuck_job" | "empty_show" | "duplicate";
  entity_type: "show" | "episode" | "job" | "source_link";
  entity_id: string;
  entity_title: string;
  detail: string;
  fixed: boolean;
  fix_action?: string;
}

export interface WatchdogReport {
  run_at: string;
  duration_ms: number;
  scans: {
    titles: number;
    metadata: number;
    orphans: number;
    jobs: number;
    empty_shows: number;
    duplicates: number;
  };
  findings: WatchdogFinding[];
  fixes_applied: number;
  anomalies_remaining: number;
}

export interface WatchdogStatus {
  enabled: boolean;
  interval_minutes: number;
  auto_fix: boolean;
  running: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_report: WatchdogReport | null;
  recent_findings: WatchdogFinding[];
  total_reports: number;
}

// ── Defaults y persistencia ──────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "watchdog.config.json");
const REPORTS_PATH = path.join(DATA_DIR, "watchdog-reports.json");
const ALERT_PATH = path.join(DATA_DIR, "WATCHDOG_ALERT.json");

const TITLE_BLACKLIST = [
  "sin titulo", "sin título", "unknown", "test", "prueba", "ejemplo",
  "placeholder", "temp", "tmp", "n/a", "null", "undefined", " lorem ",
  "asdf", "qwe", "123", "aaa", "bbb",
];

function defaultConfig(): WatchdogConfig {
  return {
    enabled: true,
    interval_minutes: 10,
    auto_fix: true,
    title_patterns_blacklist: TITLE_BLACKLIST,
  };
}

function loadConfig(): WatchdogConfig {
  const base = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_PATH)) return base;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof raw?.enabled === "boolean") base.enabled = raw.enabled;
    if (Number.isFinite(raw?.interval_minutes)) base.interval_minutes = Math.max(5, Math.min(1440, raw.interval_minutes));
    if (typeof raw?.auto_fix === "boolean") base.auto_fix = raw.auto_fix;
    if (Array.isArray(raw?.title_patterns_blacklist)) base.title_patterns_blacklist = raw.title_patterns_blacklist;
  } catch {}
  return base;
}

function persistConfig(config: WatchdogConfig): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function loadReports(): WatchdogReport[] {
  try {
    if (!fs.existsSync(REPORTS_PATH)) return [];
    return JSON.parse(fs.readFileSync(REPORTS_PATH, "utf-8")) || [];
  } catch {
    return [];
  }
}

function saveReports(reports: WatchdogReport[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports.slice(-50), null, 2), "utf-8");
}

// ── Estado en memoria ────────────────────────────────────────────

const state = {
  config: loadConfig(),
  timer: null as ReturnType<typeof setInterval> | null,
  running: false,
  lastRunAt: null as string | null,
  nextRunAt: null as string | null,
  lastReport: null as WatchdogReport | null,
  recentFindings: [] as WatchdogFinding[],
};

// ── Utilidades ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isGarbageTitle(title: string, blacklist: string[]): boolean {
  if (!title || title.length < 2) return true;
  const lower = title.toLowerCase().trim();
  if (blacklist.some((p) => lower.includes(p))) return true;
  // All same character repeated
  if (/^(.)\1{2,}$/.test(lower)) return true;
  // Random-looking short strings
  if (lower.length <= 3 && !/^[a-záéíóúñ]/i.test(lower)) return true;
  return false;
}

function isPlaceholderDescription(desc: string | null): boolean {
  if (!desc) return true;
  const lower = desc.toLowerCase().trim();
  return lower.length < 10 || /sin descripción|no disponible|placeholder|lorem|prueba/i.test(lower);
}

// ── Escaneos ─────────────────────────────────────────────────────

async function scanTitles(config: WatchdogConfig): Promise<WatchdogFinding[]> {
  const findings: WatchdogFinding[] = [];
  const shows = await prisma.show.findMany({
    select: { id: true, title: true, base_normalized_title: true },
    orderBy: { created_at: "desc" },
  });

  for (const show of shows) {
    if (isGarbageTitle(show.title, config.title_patterns_blacklist)) {
      const finding: WatchdogFinding = {
        id: `title-${show.id}`,
        timestamp: new Date().toISOString(),
        severity: "warn",
        category: "title",
        entity_type: "show",
        entity_id: show.id,
        entity_title: show.title,
        detail: `Título basura o placeholder detectado: "${show.title}"`,
        fixed: false,
      };

      if (config.auto_fix) {
        // Try to recover from base_normalized_title
        if (show.base_normalized_title && show.base_normalized_title.length > 3) {
          await prisma.show.update({
            where: { id: show.id },
            data: { title: show.base_normalized_title },
          });
          finding.fixed = true;
          finding.fix_action = `Restaurado desde base_normalized_title: "${show.base_normalized_title}"`;
        }
      }

      findings.push(finding);
    }
  }

  return findings;
}

async function scanMetadata(): Promise<WatchdogFinding[]> {
  const findings: WatchdogFinding[] = [];

  const shows = await prisma.show.findMany({
    select: { id: true, title: true, description: true, poster_url: true, genres: true },
    take: 500,
  });

  for (const show of shows) {
    const missing: string[] = [];
    if (!show.description || show.description.trim().length < 10) missing.push("descripción");
    if (!show.poster_url) missing.push("poster");
    if (!show.genres || show.genres.trim().length === 0) missing.push("géneros");

    if (missing.length > 0) {
      findings.push({
        id: `meta-${show.id}`,
        timestamp: new Date().toISOString(),
        severity: "info",
        category: "metadata",
        entity_type: "show",
        entity_id: show.id,
        entity_title: show.title,
        detail: `Metadatos incompletos: falta ${missing.join(", ")}`,
        fixed: false,
      });
    }
  }

  return findings;
}

async function scanOrphanEpisodes(): Promise<WatchdogFinding[]> {
  // show_id is required in this schema, so orphan episodes can't exist
  return [];
}

async function scanStuckJobs(): Promise<WatchdogFinding[]> {
  const findings: WatchdogFinding[] = [];

  const stuckJobs = await prisma.crawlTask.findMany({
    where: {
      status: "running",
      updated_at: { lt: new Date(Date.now() - 30 * 60 * 1000) }, // >30 min old update
    },
    select: { id: true, name: true, updated_at: true },
  });

  for (const job of stuckJobs) {
    const minsStuck = Math.round((Date.now() - job.updated_at.getTime()) / 60000);
    findings.push({
      id: `stuck-${job.id}`,
      timestamp: new Date().toISOString(),
      severity: "error",
      category: "stuck_job",
      entity_type: "job",
      entity_id: job.id,
      entity_title: job.name || job.id,
      detail: `Job stuck en "running" por ${minsStuck} minutos`,
      fixed: false,
    });

    if (state.config.auto_fix) {
      await prisma.crawlTask.update({
        where: { id: job.id },
        data: { status: "pending" },
      });
      findings[findings.length - 1].fixed = true;
      findings[findings.length - 1].fix_action = "Re-encolado a pending para reintento";
    }
  }

  return findings;
}

async function scanEmptyShows(): Promise<WatchdogFinding[]> {
  const findings: WatchdogFinding[] = [];

  const shows = await prisma.show.findMany({
    select: { id: true, title: true, _count: { select: { episodes: true } } },
    take: 500,
  });

  for (const show of shows) {
    if (show._count.episodes === 0) {
      findings.push({
        id: `empty-${show.id}`,
        timestamp: new Date().toISOString(),
        severity: "info",
        category: "empty_show",
        entity_type: "show",
        entity_id: show.id,
        entity_title: show.title,
        detail: "Obra sin episodios registrados",
        fixed: false,
      });
    }
  }

  return findings;
}

async function scanDuplicates(): Promise<WatchdogFinding[]> {
  const findings: WatchdogFinding[] = [];

  // Find shows with same normalized_title (SQLite-compatible)
  const allNormalized = await prisma.show.findMany({
    where: { base_normalized_title: { not: null, not: "" } },
    select: { id: true, base_normalized_title: true },
  });
  const titleCounts = new Map<string, string[]>();
  for (const s of allNormalized) {
    const key = s.base_normalized_title!;
    if (!titleCounts.has(key)) titleCounts.set(key, []);
    titleCounts.get(key)!.push(s.id);
  }
  for (const [title, ids] of titleCounts) {
    if (ids.length > 1) {
      findings.push({
        id: `dupe-${ids[0]}`,
        timestamp: new Date().toISOString(),
        severity: "warn",
        category: "duplicate",
        entity_type: "show",
        entity_id: ids[0],
        entity_title: title,
        detail: `${ids.length} obras con título normalizado duplicado: "${title}" (IDs: ${ids.join(", ")})`,
        fixed: false,
      });
    }
  }

  return findings;
}

// ── Orquestación ─────────────────────────────────────────────────

async function runScan(): Promise<WatchdogReport> {
  const start = Date.now();
  const config = state.config;
  const allFindings: WatchdogFinding[] = [];

  const [titleFindings, metaFindings, orphanFindings, stuckFindings, emptyFindings, dupeFindings] =
    await Promise.all([
      scanTitles(config),
      scanMetadata(),
      scanOrphanEpisodes(),
      scanStuckJobs(),
      scanEmptyShows(),
      scanDuplicates(),
    ]);

  allFindings.push(
    ...titleFindings,
    ...metaFindings,
    ...orphanFindings,
    ...stuckFindings,
    ...emptyFindings,
    ...dupeFindings
  );

  const fixesApplied = allFindings.filter((f) => f.fixed).length;
  const report: WatchdogReport = {
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
    scans: {
      titles: titleFindings.length,
      metadata: metaFindings.length,
      orphans: orphanFindings.length,
      jobs: stuckFindings.length,
      empty_shows: emptyFindings.length,
      duplicates: dupeFindings.length,
    },
    findings: allFindings,
    fixes_applied: fixesApplied,
    anomalies_remaining: allFindings.length - fixesApplied,
  };

  // Persist
  const reports = loadReports();
  reports.push(report);
  saveReports(reports);

  state.lastReport = report;
  state.recentFindings = allFindings.slice(0, 30);

  // ── TRIGGER: si hay anomalías críticas sin resolver, escribir ALERT ──
  // Este archivo es el "disparador" que el asistente (opencode) revisa
  // al inicio de cada sesión para ver si necesita intervenir.
  const criticalUnfixed = allFindings.filter(
    (f) => !f.fixed && (f.severity === "critical" || f.severity === "error")
  );
  if (criticalUnfixed.length > 0) {
    const alert = {
      triggered_at: new Date().toISOString(),
      critical_count: criticalUnfixed.length,
      total_findings: allFindings.length,
      fixes_applied: fixesApplied,
      summary: criticalUnfixed.map((f) => ({
        category: f.category,
        entity: f.entity_title,
        detail: f.detail,
      })),
      report_file: REPORTS_PATH,
    };
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ALERT_PATH, JSON.stringify(alert, null, 2), "utf-8");
      console.warn(
        `[Watchdog] ⚠️ ALERT escrito en ${ALERT_PATH}: ${criticalUnfixed.length} anomalía(s) crítica(s) sin resolver.`
      );
    } catch (e) {
      console.error("[Watchdog] Error escribiendo ALERT:", e);
    }
  } else {
    // Si todo está limpio, borrar alert previo
    try {
      if (fs.existsSync(ALERT_PATH)) fs.unlinkSync(ALERT_PATH);
    } catch {}
  }

  return report;
}

// ── Timer ────────────────────────────────────────────────────────

function clearTimer(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function scheduleTimer(): void {
  clearTimer();
  if (!state.config.enabled) {
    state.nextRunAt = null;
    return;
  }
  const ms = state.config.interval_minutes * 60_000;
  state.nextRunAt = new Date(Date.now() + ms).toISOString();
  state.timer = setInterval(() => {
    if (state.running) return;
    void runWatchdogCycle().catch((e) =>
      console.error("[Watchdog] Ciclo falló:", e?.message || e)
    );
  }, ms);
  (state.timer as unknown as { unref?: () => void })?.unref?.();
}

async function runWatchdogCycle(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const report = await runScan();
    state.lastRunAt = new Date().toISOString();
    const criticalCount = report.findings.filter((f) => f.severity === "critical" || f.severity === "error").length;
    const fixedCount = report.fixes_applied;
    console.log(
      `[Watchdog] Ciclo completado en ${report.duration_ms}ms: ${report.findings.length} hallazgos, ${fixedCount} auto-reparados, ${criticalCount} errores/críticos.`
    );
    if (criticalCount > 0) {
      console.warn(
        `[Watchdog] ⚠️ ${criticalCount} anomalías críticas requieren atención manual. Revisa data/watchdog-reports.json`
      );
    }
  } finally {
    state.running = false;
  }
}

// ── API pública ──────────────────────────────────────────────────

export function getWatchdogStatus(): WatchdogStatus {
  return {
    enabled: state.config.enabled,
    interval_minutes: state.config.interval_minutes,
    auto_fix: state.config.auto_fix,
    running: state.running,
    last_run_at: state.lastRunAt,
    next_run_at: state.nextRunAt,
    last_report: state.lastReport,
    recent_findings: [...state.recentFindings],
    total_reports: loadReports().length,
  };
}

export function getWatchdogConfig(): WatchdogConfig {
  return JSON.parse(JSON.stringify(state.config));
}

export async function updateWatchdogConfig(patch: Partial<WatchdogConfig>): Promise<WatchdogConfig> {
  const next = { ...state.config };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.interval_minutes !== undefined) {
    next.interval_minutes = Math.max(5, Math.min(1440, patch.interval_minutes));
  }
  if (patch.auto_fix !== undefined) next.auto_fix = patch.auto_fix;
  if (patch.title_patterns_blacklist !== undefined) next.title_patterns_blacklist = patch.title_patterns_blacklist;

  state.config = next;
  persistConfig(next);
  scheduleTimer();
  return getWatchdogConfig();
}

export async function runWatchdogNow(): Promise<{ started: boolean; report?: WatchdogReport }> {
  if (state.running) return { started: false };
  state.running = true;
  try {
    const report = await runScan();
    state.lastRunAt = new Date().toISOString();
    return { started: true, report };
  } finally {
    state.running = false;
  }
}

export function getWatchdogReports(limit = 10): WatchdogReport[] {
  return loadReports().slice(-limit);
}

/**
 * Lee el archivo de alerta crítica. Si existe, hay anomalías que requieren
 * intervención manual del asistente. Devuelve null si no hay alerta activa.
 */
export function checkWatchdogAlert(): {
  triggered_at: string;
  critical_count: number;
  summary: Array<{ category: string; entity: string; detail: string }>;
} | null {
  try {
    if (!fs.existsSync(ALERT_PATH)) return null;
    return JSON.parse(fs.readFileSync(ALERT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/** Borra la alerta (después de que el asistente la procese). */
export function clearWatchdogAlert(): void {
  try {
    if (fs.existsSync(ALERT_PATH)) fs.unlinkSync(ALERT_PATH);
  } catch {}
}

// ── Boot ─────────────────────────────────────────────────────────
scheduleTimer();
