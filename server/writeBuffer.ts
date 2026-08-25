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

const BUFFER_PATH = path.join(process.cwd(), "data", "write-buffer.jsonl");
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
  | { kind: "sourceLink.create"; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "crawlTask.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string };

// �─ Cola en RAM ─────────────────────────────────────────────────

let ramQueue: BufferedOp[] = [];
let isWriting = false;
let totalEnqueued = 0;
let totalApplied = 0;
let totalFailed = 0;

// ── Generación de IDs (cuid-like) ──────────────────────────────

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}${random}`;
}

// ── Encolar (los workers llaman esto, NUNCA tocan SQLite) ───────

export function enqueueWrite(op: Omit<BufferedOp, "fp" | "attempts" | "at">): void {
  const full = { ...op, fp: `${op.kind}:${JSON.stringify(op)}`, attempts: 0, at: new Date().toISOString() } as BufferedOp;
  ramQueue.push(full);
  totalEnqueued++;
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

// ── Persistencia JSONL (respaldo) ──────────────────────────────

function ensureDir(): void {
  const dir = path.dirname(BUFFER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync({ recursive: true });
}

function flushRamToJsonl(): void {
  if (ramQueue.length === 0) return;
  ensureDir();
  const tmp = BUFFER_PATH + ".tmp";
  const existing = fs.existsSync(BUFFER_PATH) ? fs.readFileSync(BUFFER_PATH, "utf8") : "";
  fs.writeFileSync(tmp, existing + ramQueue.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, BUFFER_PATH);
  ramQueue = [];
}

function loadJsonlToRam(): void {
  if (!fs.existsSync(BUFFER_PATH)) return;
  try {
    const ops: BufferedOp[] = [];
    for (const line of fs.readFileSync(BUFFER_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { ops.push(JSON.parse(line) as BufferedOp); } catch {}
    }
    if (ops.length > 0) {
      ramQueue.unshift(...ops);
      // Limpiar el archivo
      fs.writeFileSync(BUFFER_PATH, "", "utf8");
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
        const d = op.data as any;
        if (d.media_episode_id && !d._episode_resolved) {
          const ep = await prisma.mediaEpisode.findFirst({
            where: { media_item_id: d.media_episode_id },
            orderBy: { episode_number: "asc" },
          });
          if (ep) {
            d.media_episode_id = ep.id;
          } else {
            const created = await prisma.mediaEpisode.create({
              data: { media_item_id: d.media_episode_id, season_number: 1, episode_number: 1 },
            });
            d.media_episode_id = created.id;
          }
          d._episode_resolved = true;
        }
        await prisma.sourceLink.create({ data: d });
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
        } else {
          op.attempts++;
          if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
          else totalFailed++;
        }
      } catch {
        op.attempts++;
        if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
        else totalFailed++;
      }
      // Pequeña pausa entre ops (PostgreSQL maneja concurrencia nativamente)
      await new Promise((r) => setTimeout(r, 5));
    }

    // Si la cola quedó vacía y hay JSONL residual, limpiarlo
    if (ramQueue.length === 0 && fs.existsSync(BUFFER_PATH)) {
      try { fs.unlinkSync(BUFFER_PATH); } catch {}
    }
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
    if (ramQueue.length > 0 && !isWriting) {
      writerLoop().catch(() => {});
    }
    // Volcar a JSONL si la cola RAM crece demasiado
    if (ramQueue.length > RAM_SOFT_LIMIT) {
      flushRamToJsonl();
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
