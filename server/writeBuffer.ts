// server/writeBuffer.ts
// ══════════════════════════════════════════════════════════════════
// COLA DE ESCRITURA EN RAM + Outbox persistente
//
// Arquitectura:
//   1. Workers encolan operaciones en RAM (array en memoria) → cero bloqueo
//   2. Un writer SECUENCIAL processa la cola → SQLite (1 op a la vez)
//   3. Si la cola RAM crece demasiado, se vierte al JSONL (persistencia)
//   4. Al restart, el JSONL se recupera automáticamente
//
// Los workers NUNCA tocan SQLite directamente. Todo pasa por aquí.
// El writer es el ÚNICO que escribe a SQLite, secuencialmente.
// ══════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import readline from "readline";
import { prisma } from "./db";

const DEFAULT_BUFFER_PATH = path.join(process.cwd(), "data", "write-buffer.jsonl");
const DEFAULT_FAILED_BUFFER_SUFFIX = ".failed.jsonl";
let bufferPath = DEFAULT_BUFFER_PATH;
const MAX_ATTEMPTS = 5;
const RAM_SOFT_LIMIT = 500; // Si la cola RAM supera esto, se vierte a JSONL
const JSONL_FLUSH_BATCH_SIZE = 500;
// PostgreSQL soporta escrituras concurrentes; procesar una sola operación por
// vez dejaba el backlog limitado por la latencia de cada RTT. Este pool acotado
// mantiene el orden lógico mediante reintentos para dependencias FK (show →
// episode, mediaItem → sourceLink) sin volver a saturar el proceso.
const WRITER_CONCURRENCY = 16;
let isLoadingJsonl = false;

// ── Tipos de operación ─────────────────────────────────────────

type BufferedOp =
  | { kind: "show.create"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "show.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "show.findOrCreate"; id: string; where: Record<string, unknown>; create: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "mediaItem.create"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "mediaItem.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "episode.createMany"; showId: string; data: Array<Record<string, unknown>>; fp: string; attempts: number; at: string }
  | { kind: "mediaEpisode.upsert"; where: Record<string, unknown>; create: Record<string, unknown>; fp: string; attempts: number; at: string }
  | {
      kind: "sourceLink.create";
      episodeRef: { media_item_id: string; season_number: number; episode_number: number };
      data: Record<string, unknown>;
      fp: string;
      attempts: number;
      at: string;
    }
  | { kind: "sourceLink.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "crawlTask.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string };

// �─ Cola en RAM ─────────────────────────────────────────────────

let ramQueue: BufferedOp[] = [];
let isWriting = false;
let totalEnqueued = 0;
let totalApplied = 0;
let totalFailed = 0;
/** Claves de SourceLink pendientes en RAM; se liberan al aplicar o abandonar la operación. */
const pendingSourceLinkKeys = new Set<string>();

function sourceLinkKey(op: Extract<BufferedOp, { kind: "sourceLink.create" }>): string {
  return [
    op.episodeRef.media_item_id,
    op.episodeRef.season_number,
    op.episodeRef.episode_number,
    String(op.data.source_site || "unknown"),
    String(op.data.url || ""),
  ].join("\u0000");
}

function releasePendingSourceLink(op: BufferedOp): void {
  if (op.kind === "sourceLink.create") pendingSourceLinkKeys.delete(sourceLinkKey(op));
}

// ── Generación de IDs (cuid-like) ──────────────────────────────

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}${random}`;
}

// ── Encolar (los workers llaman esto, NUNCA tocan SQLite) ───────

export function enqueueWrite(op: Omit<BufferedOp, "fp" | "attempts" | "at">): boolean {
  const full = { ...op, fp: `${op.kind}:${JSON.stringify(op)}`, attempts: 0, at: new Date().toISOString() } as BufferedOp;
  if (full.kind === "sourceLink.create") {
    const key = sourceLinkKey(full);
    if (pendingSourceLinkKeys.has(key)) return false;
    pendingSourceLinkKeys.add(key);
  }
  ramQueue.push(full);
  totalEnqueued++;
  return true;
}

/**
 * Encola un show.create y retorna el ID generado.
 * El worker usa ese ID inmediatamente para operaciones posteriores.
 */
export function enqueueShowCreate(data: Record<string, unknown>): string {
  const id = generateId();
  enqueueWrite({ kind: "show.create", id, data: { ...data, id } });
  return id;
}

/**
 * Encola un mediaItem.create y retorna el ID generado.
 */
export function enqueueMediaItemCreate(data: Record<string, unknown>): string {
  const id = generateId();
  enqueueWrite({ kind: "mediaItem.create", id, data: { ...data, id } });
  return id;
}

/**
 * Encola episode.createMany para un show.
 */
export function enqueueEpisodeCreateMany(showId: string, episodes: Array<Record<string, unknown>>): void {
  enqueueWrite({ kind: "episode.createMany", showId, data: episodes });
}

/**
 * Encola show.update.
 */
export function enqueueShowUpdate(id: string, data: Record<string, unknown>): void {
  enqueueWrite({ kind: "show.update", id, data });
}

/**
 * Encola mediaItem.update.
 */
export function enqueueMediaItemUpdate(id: string, data: Record<string, unknown>): void {
  enqueueWrite({ kind: "mediaItem.update", id, data });
}

/** Encola una actualización incremental de evidencia de una fuente existente. */
export function enqueueSourceLinkUpdate(id: string, data: Record<string, unknown>): void {
  enqueueWrite({ kind: "sourceLink.update", id, data });
}

// ── Persistencia JSONL (respaldo) ──────────────────────────────

function ensureDir(): void {
  const dir = path.dirname(bufferPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Conserva operaciones agotadas para poder diagnosticarlas/reintentarlas. */
function recordFailedOp(op: BufferedOp, error: unknown): void {
  try {
    ensureDir();
    const failure = {
      failed_at: new Date().toISOString(),
      attempts: op.attempts,
      error: String((error as any)?.message || error || "operación rechazada").slice(0, 1000),
      op,
    };
    fs.appendFileSync(`${bufferPath}${DEFAULT_FAILED_BUFFER_SUFFIX}`, `${JSON.stringify(failure)}\n`, "utf8");
  } catch (persistError) {
    // La cola principal ya agotó sus reintentos; no ocultar el fallo de
    // persistencia, pero tampoco detener el resto del drenaje.
    console.error("[WriteBuffer] No se pudo guardar la operación agotada:", String((persistError as any)?.message || persistError));
  }
}

export function flushRamToJsonl(): void {
  if (ramQueue.length === 0) return;
  ensureDir();
  // Nunca concatenar todo el JSONL previo con toda la cola: durante un import
  // grande esa cadena puede superar el límite de V8 (`Invalid string length`).
  // El append por lote conserva cada operación y limita el pico de memoria.
  const batch = ramQueue.splice(0, JSONL_FLUSH_BATCH_SIZE);
  try {
    fs.appendFileSync(bufferPath, `${batch.map((o) => JSON.stringify(o)).join("\n")}\n`, "utf8");
  } catch (error) {
    // La persistencia es el respaldo de recuperación: no se pierde el lote si
    // el disco falla o la escritura es interrumpida.
    ramQueue.unshift(...batch);
    throw error;
  }
}

/**
 * Recupera el outbox sin construir una cadena de 1+ GB con readFileSync().
 * Se renombra primero para que nuevas escrituras puedan continuar en un
 * archivo fresco mientras este lote se procesa.
 */
export async function loadJsonlToRam(): Promise<void> {
  if (isLoadingJsonl) return;
  // Si un proceso murió después de renombrar el outbox, retomar ese archivo
  // ingest en lugar de dejarlo abandonado para siempre.
  let sourcePath = bufferPath;
  if (!fs.existsSync(sourcePath)) {
    try {
      const stale = fs.readdirSync(path.dirname(bufferPath))
        .filter((name) => name.startsWith(`${path.basename(bufferPath)}.ingest-`))
        .sort()[0];
      if (stale) sourcePath = path.join(path.dirname(bufferPath), stale);
    } catch {}
  }
  if (!fs.existsSync(sourcePath)) return;
  isLoadingJsonl = true;
  try {
    let size = 0;
    try { size = fs.statSync(sourcePath).size; } catch { return; }

    // Mantener la ruta síncrona para los outboxes pequeños (y para los tests);
    // solo los archivos grandes necesitan el lector por chunks.
    if (size < 8 * 1024 * 1024) {
      const ops: BufferedOp[] = [];
      for (const line of fs.readFileSync(sourcePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line) as BufferedOp;
          ops.push(op);
          if (op.kind === "sourceLink.create") pendingSourceLinkKeys.add(sourceLinkKey(op));
        } catch {}
      }
      if (ops.length > 0) ramQueue = ops.concat(ramQueue);
      fs.writeFileSync(sourcePath, "", "utf8");
      return;
    }
    const ingestPath = `${bufferPath}.ingest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try { fs.renameSync(sourcePath, ingestPath); } catch { return; }

    const ops: BufferedOp[] = [];
    try {
      const input = fs.createReadStream(ingestPath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const op = JSON.parse(line) as BufferedOp;
            ops.push(op);
            if (op.kind === "sourceLink.create") pendingSourceLinkKeys.add(sourceLinkKey(op));
          } catch {
            // Una línea truncada no debe impedir recuperar las demás.
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
      if (ops.length > 0) ramQueue = ops.concat(ramQueue);
    } catch (error) {
      // Si el archivo quedó ilegible, conservarlo para diagnóstico/reintento.
      console.error("[WriteBuffer] No se pudo leer el outbox JSONL:", error);
      try { if (!fs.existsSync(bufferPath)) fs.renameSync(ingestPath, bufferPath); } catch {}
      return;
    }
    try { fs.unlinkSync(ingestPath); } catch {}
  } finally {
    isLoadingJsonl = false;
  }
}

// ── Aplicar operación a SQLite (SOLO el writer llama esto) ──────

async function applyOp(op: BufferedOp): Promise<boolean> {
  switch (op.kind) {
    case "show.create": {
      try {
        await prisma.show.create({ data: op.data as any });
      } catch (e: any) {
        if (e?.code === "P2002") return true; // duplicado: OK, ya existe
        throw e;
      }
      return true;
    }
    case "show.update": {
      try {
        const exists = await prisma.show.findUnique({ where: { id: op.id }, select: { id: true } });
        if (!exists) return true;
        await prisma.show.update({ where: { id: op.id }, data: op.data });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "show.findOrCreate": {
      try {
        const existing = await prisma.show.findFirst({ where: op.where as any, select: { id: true } });
        if (existing) return true;
        await prisma.show.create({ data: op.create as any });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "mediaItem.create": {
      try {
        await prisma.mediaItem.create({ data: op.data as any });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "mediaItem.update": {
      try {
        const exists = await prisma.mediaItem.findUnique({ where: { id: op.id }, select: { id: true } });
        if (!exists) return true;
        await prisma.mediaItem.update({ where: { id: op.id }, data: op.data });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "episode.createMany": {
      try {
        await prisma.episode.createMany({ data: op.data as any, skipDuplicates: false });
      } catch (e: any) {
        // Si falla por duplicado, intentar uno por uno
        if (e?.code === "P2002") {
          for (const ep of op.data) {
            try { await prisma.episode.create({ data: ep as any }); } catch {}
          }
        } else {
          throw e;
        }
      }
      return true;
    }
    case "mediaEpisode.upsert": {
      try {
        await prisma.mediaEpisode.upsert({
          where: op.where as any,
          create: op.create as any,
          update: {},
        });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "sourceLink.create": {
      try {
        const ref = op.episodeRef;
        const episode = await prisma.mediaEpisode.upsert({
          where: {
            media_item_id_season_number_episode_number: ref,
          },
          create: ref,
          update: {},
        });
        await prisma.sourceLink.create({
          data: { ...op.data, media_episode_id: episode.id } as any,
        });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "sourceLink.update": {
      try {
        const exists = await prisma.sourceLink.findUnique({ where: { id: op.id }, select: { id: true } });
        if (!exists) return true;
        await prisma.sourceLink.update({ where: { id: op.id }, data: op.data as any });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "crawlTask.update": {
      await prisma.crawlTask.update({ where: { id: op.id }, data: op.data as any });
      return true;
    }
    default:
      return true;
  }
}

// ── Writer continuo ───────────────────────────────────────────

async function writerLoop(): Promise<void> {
  if (isWriting) return;
  isWriting = true;
  try {
    // Recuperar JSONL pendiente si existe
    await loadJsonlToRam();

    while (ramQueue.length > 0) {
      const batch = ramQueue.splice(0, WRITER_CONCURRENCY);
      await Promise.all(batch.map(async (op) => {
        try {
          const ok = await applyOp(op);
          if (ok) {
            totalApplied++;
            releasePendingSourceLink(op);
          } else {
            op.attempts++;
            if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
            else {
              totalFailed++;
              releasePendingSourceLink(op);
              recordFailedOp(op, "applyOp devolvió false");
            }
          }
        } catch (error) {
          op.attempts++;
          if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
          else {
            totalFailed++;
            releasePendingSourceLink(op);
            recordFailedOp(op, error);
          }
        }
      }));
      // Ceder el event-loop por lote para que Express y los resolvers JIT no
      // pierdan respuesta mientras el outbox se vacía.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // No borrar el JSONL aquí: otro tick puede haber persistido operaciones
    // mientras este writer esperaba SQLite. El siguiente tick las recargará.
  } finally {
    isWriting = false;
  }
}

// ── API pública ────────────────────────────────────────────────

/** Arranca el writer continuo (100ms). Llamar una vez al boot. */
export function startWriteBufferDrainer(): void {
  // Cargar JSONL residual al arrancar
  void loadJsonlToRam().catch(() => {});
  // Writer continuo: cada 100ms chequea si hay algo
  setInterval(() => {
    // Volcar a JSONL si la cola RAM crece demasiado
    // Mientras el writer está activo no mover la cola que ya está en RAM al
    // disco: ese ida-y-vuelta convertía un backlog finito en I/O constante.
    // El límite sigue protegiendo el caso en que el productor crece sin writer.
    if (!isWriting && ramQueue.length > RAM_SOFT_LIMIT) {
      flushRamToJsonl();
    }
    // También despierta el writer cuando el trabajo quedó persistido mientras
    // otro writer estaba en vuelo; RAM puede estar vacía en ese caso.
    const hasPersistedWrites = (() => {
      try { return fs.existsSync(bufferPath) && fs.statSync(bufferPath).size > 0; } catch { return false; }
    })();
    if (!isWriting && (ramQueue.length > 0 || hasPersistedWrites)) {
      writerLoop().catch(() => {});
    }
  }, 100).unref?.();
}

/** Estado del buffer (para monitoreo). */
export function getWriteBufferStatus(): { ramPending: number; totalEnqueued: number; totalApplied: number; totalFailed: number } {
  return { ramPending: ramQueue.length, totalEnqueued, totalApplied, totalFailed };
}

/** Drenaje manual (para watchdog o testing). */
export async function drainWriteBuffer(): Promise<{ applied: number; pending: number; failed: number }> {
  const before = totalApplied;
  await writerLoop();
  return { applied: totalApplied - before, pending: ramQueue.length, failed: totalFailed };
}

/** Resetea la cola y las claves pendientes (exclusivo para pruebas). */
export function resetWriteBufferForTesting(): void {
  ramQueue = [];
  pendingSourceLinkKeys.clear();
  totalEnqueued = 0;
  totalApplied = 0;
  totalFailed = 0;
  isWriting = false;
  if (fs.existsSync(bufferPath)) {
    try { fs.unlinkSync(bufferPath); } catch {}
  }
  const failedPath = `${bufferPath}${DEFAULT_FAILED_BUFFER_SUFFIX}`;
  if (fs.existsSync(failedPath)) {
    try { fs.unlinkSync(failedPath); } catch {}
  }
}

/** Cambia el outbox únicamente en pruebas para no tocar datos de desarrollo. */
export function setWriteBufferPathForTesting(nextPath: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setWriteBufferPathForTesting solo puede usarse en pruebas");
  }
  bufferPath = nextPath;
}
