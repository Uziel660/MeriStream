// server/writeBuffer.ts
// ══════════════════════════════════════════════════════════════════
// OUTBOX de escrituras: cuando la SQLite está lenta/bloqueada (p.ej. durante
// un barrido pesado), las escrituras se guardan en un archivo JSONL
// (data/write-buffer.jsonl) y un drenador las aplica SOLAS a la BD en
// cuanto responde. Idempotente: cada op lleva un fingerprint; si al aplicar
// falla, se reintenta en el próximo ciclo (máx N intentos).
//
// Tipos soportados:
//   - show.update    → actualización de metadatos (backfill/verificación)
//   - sourceLink.create → alta de fuente (dedup por unique constraint)
//   - mediaItem.create  → alta de MediaItem (dedup por normalized_title+kind)
//   - mediaEpisode.upsert → alta de episodio (dedup por compuesto)
// ══════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { prisma } from "./db";

const BUFFER_PATH = path.join(process.cwd(), "data", "write-buffer.jsonl");
const MAX_ATTEMPTS = 5;

type BufferedOp =
  | { kind: "show.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "sourceLink.create"; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "mediaItem.create"; data: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "mediaEpisode.upsert"; where: Record<string, unknown>; create: Record<string, unknown>; fp: string; attempts: number; at: string }
  | { kind: "crawlTask.update"; id: string; data: Record<string, unknown>; fp: string; attempts: number; at: string };

function ensureDir(): void {
  const dir = path.dirname(BUFFER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fingerprint(op: Omit<BufferedOp, "fp" | "attempts" | "at">): string {
  return `${op.kind}:${JSON.stringify(op)}`;
}

/** Encola una escritura diferida (append atómico por línea). */
export function enqueueWrite(op: Omit<BufferedOp, "fp" | "attempts" | "at">): void {
  try {
    ensureDir();
    const full = { ...op, fp: fingerprint(op), attempts: 0, at: new Date().toISOString() } as BufferedOp;
    fs.appendFileSync(BUFFER_PATH, JSON.stringify(full) + "\n", "utf8");
  } catch (e) {
    console.error("[WriteBuffer] No se pudo encolar:", e);
  }
}

async function applyOp(op: BufferedOp): Promise<boolean> {
  switch (op.kind) {
    case "show.update": {
      const exists = await prisma.show.findUnique({ where: { id: op.id }, select: { id: true } });
      if (!exists) return true;
      await prisma.show.update({ where: { id: op.id }, data: op.data });
      return true;
    }
    case "sourceLink.create": {
      try {
        const d = op.data as any;
        // Si media_episode_id parece un mediaItemId (no un episode ID real),
        // resolver el episode correcto primero.
        if (d.media_episode_id && !d._episode_resolved) {
          const ep = await prisma.mediaEpisode.findFirst({
            where: { media_item_id: d.media_episode_id },
            orderBy: { episode_number: "asc" },
          });
          if (ep) {
            d.media_episode_id = ep.id;
          } else {
            // No hay episodio aún: crear uno base
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
    case "mediaItem.create": {
      try {
        await prisma.mediaItem.create({ data: op.data as any });
      } catch (e: any) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "mediaEpisode.upsert": {
      await prisma.mediaEpisode.upsert({
        where: op.where as any,
        create: op.create as any,
        update: {},
      });
      return true;
    }
    case "crawlTask.update": {
      await prisma.crawlTask.update({
        where: { id: op.id },
        data: op.data as any,
      });
      return true;
    }
    default:
      return true;
  }
}

/** Lee todas las ops pendientes del archivo. */
function readPending(): BufferedOp[] {
  if (!fs.existsSync(BUFFER_PATH)) return [];
  const ops: BufferedOp[] = [];
  const seen = new Set<string>();
  for (const line of fs.readFileSync(BUFFER_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const op = JSON.parse(line) as BufferedOp;
      // Dedup por fingerprint: queda la ÚLTIMA versión de cada escritura.
      if (seen.has(op.fp)) {
        const idx = ops.findIndex((o) => o.fp === op.fp);
        if (idx >= 0) ops[idx] = op;
      } else {
        seen.add(op.fp);
        ops.push(op);
      }
    } catch {
      /* línea corrupta: ignorar */
    }
  }
  return ops;
}

/** Reescribe el archivo solo con lo que quedó pendiente. */
function rewritePending(ops: BufferedOp[]): void {
  ensureDir();
  const tmp = BUFFER_PATH + ".tmp";
  fs.writeFileSync(tmp, ops.map((o) => JSON.stringify(o)).join("\n") + (ops.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, BUFFER_PATH);
}

let draining = false;

/** Drena el outbox: aplica ops a la BD y limpia las resueltas. */
export async function drainWriteBuffer(): Promise<{ applied: number; pending: number; failed: number }> {
  if (draining) return { applied: 0, pending: -1, failed: 0 };
  draining = true;
  try {
    const ops = readPending();
    if (ops.length === 0) return { applied: 0, pending: 0, failed: 0 };
    const remaining: BufferedOp[] = [];
    let applied = 0;
    let failed = 0;
    for (const op of ops) {
      try {
        const ok = await applyOp(op);
        if (ok) {
          applied++;
        } else {
          remaining.push(op);
        }
      } catch {
        op.attempts += 1;
        if (op.attempts < MAX_ATTEMPTS) remaining.push(op);
        else failed++;
      }
    }
    rewritePending(remaining);
    if (applied > 0) console.log(`[WriteBuffer] ${applied} escritura(s) diferida(s) aplicadas a la BD.`);
    return { applied, pending: remaining.length, failed };
  } finally {
    draining = false;
  }
}

/** Arranca el drenador periódico (15s). Llamar una vez al boot. */
export function startWriteBufferDrainer(): void {
  setInterval(() => {
    drainWriteBuffer().catch(() => {});
  }, 15_000).unref?.();
  // Primer intento tras el arranque.
  setTimeout(() => drainWriteBuffer().catch(() => {}), 5_000).unref?.();
}

export function getWriteBufferStatus(): { pending: number } {
  return { pending: readPending().length };
}
