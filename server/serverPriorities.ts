// server/serverPriorities.ts
// ══════════════════════════════════════════════════════════════════
// PRIORIDAD DE SERVIDORES POR PLATAFORMA: el usuario prueba los servidores
// de una obra de una plataforma y reordena cuál usar primero. La prioridad
// es POR HOST dentro de la plataforma y aplica a CUALQUIER obra de esa
// plataforma. Persistencia en JSON (data/server-priorities.json), sin
// migraciones. Rank 1 = el mejor.
// ══════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { familyKeyOfStreamUrl } from "./utils/streamSorter";

const PRIORITIES_PATH = path.join(process.cwd(), "data", "server-priorities.json");

type PriorityMap = Record<string, Record<string, number>>;

function ensureDir(): void {
  const dir = path.dirname(PRIORITIES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAll(): PriorityMap {
  try {
    if (!fs.existsSync(PRIORITIES_PATH)) return {};
    return JSON.parse(fs.readFileSync(PRIORITIES_PATH, "utf8")) as PriorityMap;
  } catch {
    return {};
  }
}

function saveAll(map: PriorityMap): void {
  ensureDir();
  const tmp = PRIORITIES_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
  fs.renameSync(tmp, PRIORITIES_PATH);
}

/** Clave de prioridad de un host: FAMILIA de proveedor ("s12.vimeos.net" → "vimeos").
 *  Los CDNs rotan nodos/TLDs; la familia sobrevive a la rotación. */
function familyOf(hostOrUrl: string): string {
  const h = String(hostOrUrl || "").toLowerCase();
  const host = h.includes("://") ? hostOfUrl(h) : h.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : host;
}

/** Host de una URL (sin www), o el string recortado si no parsea. */
export function hostOfUrl(url: string): string {
  try {
    if (url.startsWith("/api/v1/stream/mega")) return "mega.nz";
    const u = url.startsWith("http") ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(url || "").slice(0, 40).toLowerCase();
  }
}

/** Mapa host → rank (1 = mejor) de una plataforma. */
export function getServerPriorities(platform: string): Record<string, number> {
  return loadAll()[cleanPlatform(platform)] || {};
}

/** Guarda el orden completo: hosts en el orden dado reciben rank 1..N. */
export function setServerOrder(platform: string, orderedHosts: string[]): void {
  const all = loadAll();
  const key = cleanPlatform(platform);
  const ranks: Record<string, number> = {};
  orderedHosts.forEach((host, i) => {
    if (host) ranks[familyOf(host)] = i + 1;
  });
  all[key] = ranks;
  saveAll(all);
}

/** Sube (dir=-1) o baja (dir=1) un host en el orden de la plataforma.
 *  Si el host no tenía override aún, se CREA: dir=-1 → primera posición
 *  (los existentes bajan un puesto); dir=1 → última posición. */
export function moveServerPriority(platform: string, host: string, dir: -1 | 1): void {
  const all = loadAll();
  const key = cleanPlatform(platform);
  const current = all[key] || {};
  const ordered = Object.entries(current)
    .sort((a, b) => a[1] - b[1])
    .map(([h]) => h);
  const h = familyOf(host);
  const idx = ordered.indexOf(h);
  if (idx === -1) {
    if (dir === -1) ordered.unshift(h);
    else ordered.push(h);
  } else {
    const swap = idx + dir;
    if (swap < 0 || swap >= ordered.length) return; // ya está en el extremo
    const tmp = ordered[idx];
    ordered[idx] = ordered[swap];
    ordered[swap] = tmp;
  }
  const ranks: Record<string, number> = {};
  ordered.forEach((x, i) => {
    ranks[x] = i + 1;
  });
  all[key] = ranks;
  saveAll(all);
}

/** rank de un host en una plataforma, o undefined si no tiene override. */
export function hostPriorityFor(platform: string, host: string): number | undefined {
  return getServerPriorities(platform)[familyOf(host)];
}

function cleanPlatform(p: string): string {
  return String(p || "").toLowerCase().trim();
}
