#!/usr/bin/env node
/**
 * Cierra una pasada de catálogo sin duplicar workers:
 *  1) espera a que full_catalog termine;
 *  2) reencola una tarea pausada desde su checkpoint;
 *  3) pide al servidor una recuperación all y una verificación completa.
 *
 * Solo consulta PostgreSQL directamente para observar/reanudar el estado. La
 * creación de trabajos se hace contra la API del servidor ya activo, evitando
 * importar otro singleton de SourceRecoveryWorker y provocar una reanudación
 * concurrente.
 */
import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { prisma } from "../server/db";
import { reconcileMediaItemsByTmdb, reconcileSequelsByTmdb } from "../server/reconcileCatalog";

const BASE_URL = process.env.MERISTREAM_BASE_URL?.trim() || "http://127.0.0.1:3010";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTmdbRepair(): Promise<void> {
  // Si una reparación reanudable está presente, no fusionar mientras todavía
  // puede cambiar IDs: hacerlo antes produciría un informe obsoleto y dejaría
  // duplicados que reaparecen en la misma pasada.
  const files = [
    path.resolve("data/tmdb-repair.cursor.json"),
    path.resolve("data/tmdb-repair-sweep2.cursor.json"),
  ];
  for (;;) {
    let pending = false;
    for (const file of files) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as { phase?: string };
        if (parsed.phase && parsed.phase !== "done") pending = true;
      } catch {
        // Un cursor ausente significa que no hay una reparación pendiente.
      }
    }
    if (!pending) return;
    await sleep(30_000);
  }
}

async function runFinalTmdbRepair(stage: "post-catalog" | "post-verification" = "post-catalog"): Promise<void> {
  // Cada cierre posterior al catálogo necesita un cursor propio. Reutilizar
  // el cursor de la pasada anterior (ya marcado como `done`) dejaría sin
  // revisar las obras incorporadas durante la verificación actual.
  const cursorFile = path.resolve(`data/tmdb-repair-${stage}.cursor.json`);
  const reportFile = path.resolve(`docs/reports/tmdb-repair-${stage}-2026-09-05.json`);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [
      "tsx",
      "tools/repair-tmdb-identities.ts",
      "--apply",
      "--concurrency",
      "12",
      "--cursor-file",
      cursorFile,
      "--report",
      reportFile,
    ], { cwd: process.cwd(), stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`la pasada TMDB final terminó con código ${code ?? "desconocido"}`));
    });
  });
}

async function runLegacySourceBridge(): Promise<void> {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const cursorFile = path.resolve("data/legacy-source-bridge.cursor.json");
  const reportFile = path.resolve("docs/reports/legacy-source-bridge-final-2026-09-03.json");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [
      "tsx",
      "tools/backfill-legacy-source-links.ts",
      "--apply",
      "--batch-size",
      "500",
      "--cursor-file",
      cursorFile,
      "--report",
      reportFile,
    ], { cwd: process.cwd(), stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`el puente legacy terminó con código ${code ?? "desconocido"}`));
    });
  });
}

async function waitForCatalogJobs(): Promise<void> {
  let retriedFailed = false;
  for (;;) {
    // No son fallos ejecutables: son tareas históricas creadas contra rutas
    // que los adaptadores ya no usan (0 descubrimientos). Mantenerlas como
    // `cancelled` evita que el panel las muestre como errores pendientes sin
    // borrar su trazabilidad ni reabrir bucles de 404/429.
    await prisma.crawlTask.updateMany({
      where: { scope: "full_catalog", status: "failed", total_discovered: 0 },
      data: { status: "cancelled", error_message: "Ruta histórica obsoleta; reemplazada por el catálogo vigente" },
    });
    // Esta ejecución está autorizada a completar la pasada: una pausa dejada
    // por un cierre/transitorio no debe impedir que el pipeline continúe.
    await prisma.crawlTask.updateMany({
      where: { scope: "full_catalog", status: "paused" },
      data: { status: "pending", error_message: null },
    });
    const active = await prisma.crawlTask.count({
      where: { scope: "full_catalog", status: { in: ["running", "pending", "paused"] } },
    });
    if (active === 0 && !retriedFailed) {
      // Algunos adaptadores fallan por un bloqueo temporal (521/Cloudflare)
      // aunque la implementación ya haya cambiado durante esta ejecución.
      // Reintentar una vez los jobs fallidos recupera esos casos sin crear un
      // bucle infinito; todos los proveedores configurados participan.
      const retry = await prisma.crawlTask.updateMany({
        where: {
          scope: "full_catalog",
          status: "failed",
          // Las tareas históricas que no descubrieron ni una sola obra son
          // rutas obsoletas (por ejemplo /browse en proveedores que ya usan
          // /directorio o la API WP). No volver a lanzarlas en cada cierre:
          // conservarlas como evidencia evita reabrir ruido y 429 inútiles.
          total_discovered: { gt: 0 },
        },
        data: { status: "pending", error_message: null },
      });
      retriedFailed = true;
      if (retry.count > 0) continue;
    }
    if (active === 0) return;
    await sleep(60_000);
  }
}

async function adminCookie(): Promise<string> {
  const user = process.env.ADMIN_USER?.trim() || "";
  const password = process.env.ADMIN_PASS || "";
  if (!user || !password) throw new Error("ADMIN_USER/ADMIN_PASS no configurados");
  const response = await fetch(`${BASE_URL}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  if (!response.ok) throw new Error(`login administrativo HTTP ${response.status}`);
  const cookies = typeof (response.headers as any).getSetCookie === "function"
    ? (response.headers as any).getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = cookies.find((value: string) => value.includes("meristream_admin_session="));
  if (!cookie) throw new Error("la API no devolvió cookie administrativa");
  return cookie.split(";", 1)[0];
}

async function runCatalogCoverageAudit(): Promise<void> {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["tsx", "tools/catalog_coverage_audit.ts"], {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`la auditoría global del catálogo terminó con código ${code ?? "desconocido"}`));
    });
  });
}

/**
 * La reparación/reconciliación escribe identidades y mueve episodios. Nunca
 * debe competir con la pasada de verificación que todavía puede crear obras,
 * episodios o SourceLinks. Se consulta con una cadencia larga (5 min): el
 * endpoint es solo lectura y no tiene sentido golpearlo cada pocos segundos.
 */
async function waitForVerificationIdle(cookie: string): Promise<void> {
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/api/v1/verification`, { headers: { Cookie: cookie } });
    } catch (error) {
      console.warn(`[finalize-catalog-pipeline] API no disponible al esperar verificación: ${String(error)}`);
      await sleep(30_000);
      continue;
    }
    const payload = await response.json().catch(() => ({})) as {
      running?: boolean;
      phase?: string;
    };
    if (!response.ok) throw new Error(`consulta de verificación HTTP ${response.status}`);
    if (!payload.running && payload.phase === "idle") return;
    console.log(`[finalize-catalog-pipeline] verificación activa (${payload.phase || "desconocida"}); próximo chequeo en 5 min.`);
    await sleep(300_000);
  }
}

async function post(path: string, cookie: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForRecovery(jobPayload: unknown, cookie: string): Promise<void> {
  const job = (jobPayload as { job?: { id?: string; status?: string } } | null)?.job;
  const jobId = job?.id;
  if (!jobId) throw new Error("source-recovery/start no devolvió un job_id");

  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/api/v1/source-recovery/jobs/${encodeURIComponent(jobId)}`, {
        headers: { Cookie: cookie },
      });
    } catch (error) {
      // El servidor puede reiniciarse para cargar una versión nueva del
      // worker. Mantener el finalizador vivo y reintentar evita perder horas
      // de recuperación por un único corte de conexión local.
      console.warn(`[finalize-catalog-pipeline] API no disponible al consultar ${jobId}: ${String(error)}`);
      await sleep(10_000);
      continue;
    }
    const payload = await response.json().catch(() => ({})) as { job?: { status?: string; error_message?: string | null } };
    if (!response.ok) throw new Error(`consulta de recuperación HTTP ${response.status}`);
    const status = payload.job?.status;
    if (status === "completed") return;
    if (status === "failed") {
      throw new Error(`la recuperación final falló: ${payload.job?.error_message || "error desconocido"}`);
    }
    await sleep(30_000);
  }
}

async function waitForActiveRecoveries(cookie: string): Promise<void> {
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/api/v1/source-recovery/jobs?limit=100`, {
        headers: { Cookie: cookie },
      });
    } catch (error) {
      console.warn(`[finalize-catalog-pipeline] API no disponible al listar recuperaciones: ${String(error)}`);
      await sleep(10_000);
      continue;
    }
    const payload = await response.json().catch(() => ({})) as {
      jobs?: Array<{ id?: string; status?: string }>;
    };
    if (!response.ok) throw new Error(`consulta de recuperaciones HTTP ${response.status}`);
    const active = (payload.jobs || []).filter((job) =>
      Boolean(job.id) && (job.status === "recovery_pending" || job.status === "recovery_running"),
    );
    if (active.length === 0) return;
    for (const job of active) {
      try {
        await waitForRecovery({ job }, cookie);
      } catch (error) {
        // Una recuperación histórica fallida no debe impedir la pasada final:
        // se crea una cola nueva con el estado actual de la base de datos.
        console.warn(`[finalize-catalog-pipeline] recuperación ${job.id} no terminó correctamente: ${String(error)}`);
      }
    }
  }
}

async function reconcileTmdbAndSeasons(): Promise<void> {
  const shows = await reconcileSequelsByTmdb({ dryRun: false });
  const mediaItems = await reconcileMediaItemsByTmdb({ dryRun: false });
  const report = {
    generated_at: new Date().toISOString(),
    shows,
    media_items: mediaItems,
  };
  const target = path.resolve("docs/reports/tmdb-reconcile-final.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ tmdb_reconciliation: {
    shows_merged: shows.merges_done,
    show_episodes_moved: shows.episodes_moved,
    media_items_merged: mediaItems.merges_done,
    media_episodes_moved: mediaItems.episodes_moved,
    report: target,
  } }));
}

async function main(): Promise<void> {
  await waitForCatalogJobs();
  await waitForTmdbRepair();
  const cookie = await adminCookie();
  // La verificación completa puede haber sido lanzada de forma independiente
  // después del cierre de catálogos. Esperarla aquí evita carreras de escritura
  // y garantiza que el cursor TMDB nuevo incluya todas las obras descubiertas.
  await waitForVerificationIdle(cookie);
  await runFinalTmdbRepair();
  // No crear otra cola masiva mientras la recuperación all anterior sigue
  // ejecutándose: esperar aquí evita duplicar llamadas a proveedores y RAM.
  await waitForActiveRecoveries(cookie);
  // Ahora no hay workers escribiendo catálogo/fuentes y los IDs TMDB ya son
  // estables. Fusionar aquí evita que una recuperación final use episodios
  // que se eliminarían o cambiasen de identidad inmediatamente después.
  await reconcileTmdbAndSeasons();
  const recovery = await post("/api/v1/source-recovery/start", cookie, {
    mode: "all",
    name: "Recuperación final posterior a reimportación",
    delay_ms: 300,
  });
  console.log(JSON.stringify({ recovery }, null, 2));
  await waitForRecovery(recovery, cookie);
  console.log("[finalize-catalog-pipeline] recuperación final completada; enlazando episodios legacy sin SourceLink.");
  await runLegacySourceBridge();
  console.log("[finalize-catalog-pipeline] puente legacy completado; iniciando verificación.");
  const verification = await post("/api/v1/verification/run", cookie, { mode: "full" });
  console.log(JSON.stringify({ verification }, null, 2));
  // La pasada final puede descubrir obras/episodios nuevos. Una segunda
  // reparación con cursor independiente cierra esa ventana antes de generar
  // los informes de cobertura que se entregan como evidencia.
  await waitForVerificationIdle(cookie);
  await runFinalTmdbRepair("post-verification");
  await reconcileTmdbAndSeasons();
  await runCatalogCoverageAudit();
}

main()
  .catch((error) => {
    console.error("[finalize-catalog-pipeline]", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
