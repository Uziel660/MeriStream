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
import { prisma } from "./db";

const DEFAULT_BUFFER_PATH = path.join(process.cwd(), "data", "write-buffer.jsonl");
let bufferPath = DEFAULT_BUFFER_PATH;
const MAX_ATTEMPTS = 5;
const RAM_SOFT_LIMIT = 500; // Si la cola RAM supera esto, se vierte a JSONL

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
  if (!fs.existsSync(dir)) fs.mkdirSync({ recursive: true });
}

export function flushRamToJsonl(): void {
  if (ramQueue.length === 0) return;
  ensureDir();
  const tmp = bufferPath + ".tmp";
  const existing = fs.existsSync(bufferPath) ? fs.readFileSync(bufferPath, "utf8") : "";
  fs.writeFileSync(tmp, existing + ramQueue.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, bufferPath);
  ramQueue = [];
}

export function loadJsonlToRam(): void {
  if (!fs.existsSync(bufferPath)) return;
  try {
    const ops: BufferedOp[] = [];
    for (const line of fs.readFileSync(bufferPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const op = JSON.parse(line) as BufferedOp;
        ops.push(op);
        if (op.kind === "sourceLink.create") {
          pendingSourceLinkKeys.add(sourceLinkKey(op));
        }
      } catch {}
    }
    if (ops.length > 0) {
      ramQueue.unshift(...ops);
      // Limpiar el archivo
      fs.writeFileSync(bufferPath, "", "utf8");
    }
  } catch {}
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

// ── Writer continuo (procesa 1 op cada 50-100ms) ───────────────

async function writerLoop(): Promise<void> {
  if (isWriting) return;
  isWriting = true;
  try {
    // Recuperar JSONL pendiente si existe
    loadJsonlToRam();

    while (ramQueue.length > 0) {
      const op = ramQueue.shift()!;
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
          }
        }
      } catch {
        op.attempts++;
        if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
        else {
          totalFailed++;
          releasePendingSourceLink(op);
        }
      }
      // Pequeña pausa entre ops (PostgreSQL maneja concurrencia nativamente)
      await new Promise((r) => setTimeout(r, 5));
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
  loadJsonlToRam();
  // Writer continuo: cada 100ms chequea si hay algo
  setInterval(() => {
    // Volcar a JSONL si la cola RAM crece demasiado
    if (ramQueue.length > RAM_SOFT_LIMIT) {
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
}

/** Cambia el outbox únicamente en pruebas para no tocar datos de desarrollo. */
export function setWriteBufferPathForTesting(nextPath: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setWriteBufferPathForTesting solo puede usarse en pruebas");
  }
  bufferPath = nextPath;
}
