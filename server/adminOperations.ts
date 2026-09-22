import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type AdminOperationState = "queued" | "running" | "completed" | "failed";

export interface AdminOperationStatus {
  id: string;
  operation: string;
  label: string;
  description: string;
  state: AdminOperationState;
  apply: boolean;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  exit_code: number | null;
  output_tail: string;
  log_file: string;
  progress_percent?: number | null;
  current_item?: string | null;
}

interface OperationDefinition {
  label: string;
  description: string;
  script: string;
  mutating: boolean;
  requiresApply?: boolean;
  buildArgs: (options: { apply: boolean; onlyEmpty: boolean; report: string }) => string[];
}

const OPERATION_DEFINITIONS: Record<string, OperationDefinition> = {
  enrich_all_identities: {
    label: "Saneamiento integral (TMDB, IMDb, MAL, AniList)",
    description: "Ejecuta el saneamiento completo: recupera IMDb/TVDb desde TMDB, asigna TMDB a obras huérfanas y completa MAL/AniList en anime.",
    script: "tools/enrich-all-identities.ts",
    mutating: true,
    buildArgs: ({ apply }) => [
      ...(apply ? ["--apply"] : []),
      "--concurrency", "20",
    ],
  },
  backfill_imdb_ids: {
    label: "Completar IMDb y TVDb desde TMDB",
    description: "Consulta TMDB para recuperar los identificadores oficiales IMDb (tt...) y TVDb de todas las obras existentes.",
    script: "tools/backfill-imdb-ids.ts",
    mutating: true,
    buildArgs: ({ apply, report }) => [
      ...(apply ? ["--apply"] : []),
      "--concurrency", "20",
      "--report", report,
    ],
  },
  repair_catalog_ids: {
    label: "Reparar identidades del catálogo",
    description: "Busca TMDB/MAL/AniList para obras sin identidad y conserva los reportes para revisión.",
    script: "tools/repair-catalog-identities.ts",
    mutating: true,
    buildArgs: ({ apply, onlyEmpty, report }) => [
      ...(apply ? ["--apply"] : []),
      ...(onlyEmpty ? ["--only-empty"] : []),
      "--phases", "shows,media",
      "--report-dir", path.dirname(report),
    ],
  },
  repair_tmdb_safe: {
    label: "Completar TMDB faltante",
    description: "Busca y aplica únicamente coincidencias TMDB de confianza alta.",
    script: "tools/repair-tmdb-identities-safe.ts",
    mutating: true,
    buildArgs: ({ apply, onlyEmpty, report }) => [
      ...(apply ? ["--apply"] : []),
      ...(onlyEmpty ? ["--only-none"] : []),
      "--report", report,
    ],
  },
  repair_tmdb_legacy: {
    label: "Reparar identidades TMDB legacy",
    description: "Revisa faltantes y conflictos históricos de TMDB con un informe reanudable.",
    script: "tools/repair-tmdb-identities.ts",
    mutating: true,
    buildArgs: ({ apply, onlyEmpty, report }) => [
      ...(apply ? ["--apply"] : []),
      ...(onlyEmpty ? ["--missing-only"] : []),
      "--report", report,
    ],
  },
  repair_anime_ids: {
    label: "Completar identidades de anime",
    description: "Busca MAL, AniList y Kitsu para anime legacy sin identificadores.",
    script: "tools/repair-anime-identities.ts",
    mutating: true,
    buildArgs: ({ apply, onlyEmpty, report }) => [
      ...(apply ? ["--apply"] : []),
      ...(onlyEmpty ? ["--only-none"] : []),
      "--report", report,
    ],
  },
  ingest_all: {
    label: "Encolar importación completa",
    description: "Crea las tareas de importación de los catálogos configurados para que las procese el worker.",
    script: "tools/ingest-all.ts",
    mutating: true,
    buildArgs: ({ apply }) => (apply ? [] : ["--dry"]),
  },
  bootstrap_catalog: {
    label: "Preparar catálogo inicial",
    description: "Ejecuta la preparación inicial del catálogo usando la configuración actual.",
    script: "tools/bootstrap-catalog.ts",
    mutating: true,
    buildArgs: ({ apply }) => (apply ? [] : ["--dry-run"]),
  },
  verify_catalog_ids: {
    label: "Auditar identidades",
    description: "Genera un informe de obras sin TMDB, MAL o AniList y de conflictos de identidad.",
    script: "tools/verify-catalog-identities.ts",
    mutating: false,
    buildArgs: ({ report }) => ["--report", report],
  },
  repair_source_languages: {
    label: "Normalizar idiomas de fuentes",
    description: "Audita o normaliza idioma de audio y subtítulos ya guardado.",
    script: "tools/repair-source-languages.ts",
    mutating: true,
    buildArgs: ({ apply, report }) => [...(apply ? ["--apply"] : []), "--report", report],
  },
  cleanup_catalog_links: {
    label: "Limpiar enlaces de catálogo",
    description: "Elimina enlaces de navegación o landing pages asignados por error a episodios.",
    script: "tools/cleanup-landing-pages-from-episodes.ts",
    mutating: true,
    requiresApply: true,
    buildArgs: ({ apply }) => [...(apply ? ["--apply"] : [])],
  },
  backfill_canonical: {
    label: "Completar localizadores canónicos",
    description: "Rellena localizadores renovables de páginas y embeds existentes.",
    script: "tools/backfill-canonical-locators.ts",
    mutating: true,
    buildArgs: ({ apply }) => [...(apply ? ["--apply"] : [])],
  },
  backfill_legacy_sources: {
    label: "Sincronizar fuentes legacy",
    description: "Construye el puente entre episodios legacy y el catálogo multi-fuente.",
    script: "tools/backfill-legacy-source-links.ts",
    mutating: true,
    buildArgs: ({ apply }) => [...(apply ? ["--apply"] : [])],
  },
  normalize_source_sites: {
    label: "Normalizar plataformas de fuentes",
    description: "Unifica aliases de plataforma y elimina duplicados exactos.",
    script: "tools/normalize-source-sites.ts",
    mutating: true,
    buildArgs: ({ apply }) => [...(apply ? ["--apply"] : [])],
  },
  normalize_legacy_titles: {
    label: "Limpiar títulos legacy",
    description: "Corrige entidades HTML y títulos persistidos sin tocar fuentes ni IDs.",
    script: "tools/normalize-legacy-titles.ts",
    mutating: true,
    buildArgs: ({ apply }) => [...(apply ? ["--apply"] : [])],
  },
  reconcile_tmdb: {
    label: "Reconciliar temporadas e identidades TMDB",
    description: "Audita o reconcilia obras y temporadas que comparten identidad TMDB.",
    script: "tools/reconcile-tmdb-seasons.ts",
    mutating: true,
    buildArgs: ({ apply, report }) => [...(apply ? ["--apply"] : []), "--report", report],
  },
  hydrate_sources: {
    label: "Hidratar fuentes por TMDB",
    description: "Consulta servidores para episodios con TMDB y persiste los streams encontrados.",
    script: "tools/hydrate-tmdb-sources.ts",
    mutating: true,
    buildArgs: ({ apply }) => (apply ? [] : ["--dry"]),
  },
  source_recovery: {
    label: "Recuperar fuentes legacy",
    description: "Reencola la recuperación de enlaces antiguos que aún tienen un localizador reutilizable.",
    script: "tools/run_source_recovery.ts",
    mutating: true,
    requiresApply: true,
    buildArgs: () => [],
  },
  sync_local_catalog: {
    label: "Actualizar índice local de anime",
    description: "Descarga y actualiza el índice privado de referencias MAL/AniList.",
    script: "tools/sync-local-catalog-index.ts",
    mutating: true,
    requiresApply: true,
    buildArgs: () => [],
  },
  finalize_pipeline: {
    label: "Finalizar pipeline de catálogo",
    description: "Cierra tareas pendientes, reconcilia identidades y solicita una verificación completa.",
    script: "tools/finalize-catalog-pipeline.ts",
    mutating: true,
    requiresApply: true,
    buildArgs: () => [],
  },
};

const MAX_OUTPUT_LENGTH = 8_000;
const operationRecords = new Map<string, AdminOperationStatus>();
const operationChildren = new Map<string, ChildProcess>();

function operationDir(): string {
  return path.resolve("work", "admin-operations");
}

function statusPath(id: string): string {
  return path.join(operationDir(), `${id}.json`);
}

function logPath(id: string): string {
  return path.join(operationDir(), `${id}.log`);
}

function now(): string {
  return new Date().toISOString();
}

function tail(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH ? value.slice(-MAX_OUTPUT_LENGTH) : value;
}

function readProgress(output: string): { percent: number | null; current: string | null } {
  const recent = output.split(/\r?\n/).filter(Boolean).slice(-12).reverse();
  for (const line of recent) {
    const ratio = line.match(/(?:progreso|progress|procesad[oa]s?|lote)\D{0,24}(\d+)\s*(?:\/|de)\s*(\d+)/i);
    if (ratio) {
      const done = Number(ratio[1]);
      const total = Number(ratio[2]);
      if (total > 0) return { percent: Math.min(100, Math.max(0, Math.round((done / total) * 100))), current: line.trim() };
    }
    const percent = line.match(/(\d{1,3})\s*%/);
    if (percent) return { percent: Math.min(100, Number(percent[1])), current: line.trim() };
    if (/(procesando|processing|obra|show|title|lote|fase)/i.test(line)) return { percent: null, current: line.trim() };
  }
  return { percent: null, current: null };
}

async function persist(record: AdminOperationStatus): Promise<void> {
  operationRecords.set(record.id, record);
  try {
    await mkdir(operationDir(), { recursive: true });
    await writeFile(statusPath(record.id), JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    console.warn(`[adminOperations] no se pudo guardar ${record.id}:`, String(error));
  }
}

async function loadPersisted(id: string): Promise<AdminOperationStatus | null> {
  try {
    return JSON.parse(await readFile(statusPath(id), "utf8")) as AdminOperationStatus;
  } catch {
    return null;
  }
}

function appendOutput(record: AdminOperationStatus, chunk: Buffer | string): void {
  record.output_tail = tail(`${record.output_tail}${String(chunk)}`);
  const progress = readProgress(record.output_tail);
  record.progress_percent = progress.percent;
  record.current_item = progress.current;
  record.updated_at = now();
  void appendFile(logPath(record.id), String(chunk), "utf8").catch(() => undefined);
  void persist(record);
}

export async function listAdminOperations(): Promise<AdminOperationStatus[]> {
  const records = new Map(operationRecords);
  try {
    const files = await readdir(operationDir());
    await Promise.all(files
      .filter((file) => file.startsWith("admin-") && file.endsWith(".json") && !file.endsWith("-report.json"))
      .map(async (file) => {
        const persisted = await loadPersisted(file.slice(0, -5));
        if (persisted) records.set(persisted.id, persisted);
      }));
  } catch {
    // El directorio aún no existe en una instalación nueva.
  }
  return [...records.values()]
    .sort((left, right) => right.started_at.localeCompare(left.started_at))
    .slice(0, 30);
}

export async function getAdminOperation(id: string): Promise<AdminOperationStatus | null> {
  return operationRecords.get(id) || loadPersisted(id);
}

export function getAdminOperationDefinitions(): Array<{ id: string; label: string; description: string; mutating: boolean; requiresApply: boolean }> {
  return Object.entries(OPERATION_DEFINITIONS).map(([id, definition]) => ({
    id,
    label: definition.label,
    description: definition.description,
    mutating: definition.mutating,
    requiresApply: Boolean(definition.requiresApply),
  }));
}

export async function startAdminOperation(
  operation: string,
  options: { apply?: boolean; onlyEmpty?: boolean } = {},
): Promise<AdminOperationStatus> {
  const definition = OPERATION_DEFINITIONS[operation];
  if (!definition) throw new Error("Operación administrativa no reconocida.");
  if (definition.requiresApply && options.apply !== true) {
    throw new Error("Esta operación requiere activar «Aplicar cambios».");
  }
  const active = [...operationRecords.values()].find((record) => record.operation === operation && (record.state === "queued" || record.state === "running"));
  if (active) throw new Error(`La operación ya está en curso (${active.id}).`);

  const id = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const apply = Boolean(options.apply && definition.mutating);
  const report = path.join(operationDir(), `${id}-report.json`);
  const record: AdminOperationStatus = {
    id,
    operation,
    label: definition.label,
    description: definition.description,
    state: "queued",
    apply,
    started_at: now(),
    updated_at: now(),
    finished_at: null,
    exit_code: null,
    output_tail: "",
    log_file: path.relative(process.cwd(), logPath(id)).replaceAll("\\", "/"),
  };
  await mkdir(operationDir(), { recursive: true });
  await writeFile(logPath(id), "", "utf8");
  await persist(record);

  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const scriptArgs = definition.buildArgs({ apply, onlyEmpty: Boolean(options.onlyEmpty), report });
  const child = spawn(process.execPath, [tsxCli, definition.script, ...scriptArgs], {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  appendOutput(record, `[start] ${definition.label} (${definition.script})\n[config] Modo: ${apply ? "APLICAR CAMBIOS (--apply)" : "SIMULACIÓN (dry-run)"} | ID: ${id}\n[exec] node ${tsxCli} ${definition.script} ${scriptArgs.join(" ")}\n\n`);

  operationChildren.set(id, child);
  record.state = "running";
  record.updated_at = now();
  await persist(record);
  child.stdout?.on("data", (chunk) => appendOutput(record, chunk));
  child.stderr?.on("data", (chunk) => appendOutput(record, chunk));
  child.once("error", (error) => {
    record.state = "failed";
    record.exit_code = null;
    record.finished_at = now();
    appendOutput(record, `\n[error] Error en subproceso: ${String(error)}\n`);
    operationChildren.delete(id);
  });
  child.once("close", (code) => {
    record.state = code === 0 ? "completed" : "failed";
    record.exit_code = code;
    record.finished_at = now();
    record.updated_at = now();
    appendOutput(record, `\n[done] Operación finalizada con código de salida ${code ?? 0}\n`);
    operationChildren.delete(id);
    void persist(record);
  });
  return record;
  return record;
}

export async function getAdminOperationLog(id: string): Promise<string | null> {
  try {
    return await readFile(logPath(id), "utf8");
  } catch {
    const rec = await getAdminOperation(id);
    return rec?.output_tail || null;
  }
}

export async function cancelAdminOperation(id: string): Promise<boolean> {
  const child = operationChildren.get(id);
  const rec = await getAdminOperation(id);
  if (child) {
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
    operationChildren.delete(id);
  }
  if (rec && (rec.state === "running" || rec.state === "queued")) {
    rec.state = "failed";
    rec.finished_at = now();
    rec.updated_at = now();
    appendOutput(rec, `\n[cancel] Operación cancelada por el usuario\n`);
    await persist(rec);
    return true;
  }
  return Boolean(child);
}

export async function deleteAdminOperation(id: string): Promise<boolean> {
  const child = operationChildren.get(id);
  if (child) {
    await cancelAdminOperation(id);
  }
  operationRecords.delete(id);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(statusPath(id)).catch(() => undefined);
    await unlink(logPath(id)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

