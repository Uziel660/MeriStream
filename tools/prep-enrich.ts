// Paso previo al backfill del motor real:
// 1. Vacía descripciones en inglés (basura) → el motor las rellena en es-MX.
// 2. Pósters de obras CON tmdb_id: reemplaza directo por el de TMDB (sin búsqueda).
import { prisma } from "../server/db";
import "dotenv/config";

const TMDB_KEY = process.env.TMDB_API_KEY!;
const POOL = 6;
const DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EN_STARTS = ["A ", "The ", "An ", "In ", "When ", "It ", "After ", "Set ", "Follows ", "Based ", "During ", "As ", "Amid ", "Caught ", "Told "];
const ES_WORDS = /\b(la|el|los|las|una|uno|del|que|con|para|por|su|sus)\b/i;

function looksEnglish(desc: string): boolean {
  const t = desc.trim();
  if (!t) return false;
  if (!EN_STARTS.some((p) => t.startsWith(p))) return false;
  return !ES_WORDS.test(t);
}

async function tmdbDetails(id: number, category: string): Promise<any | null> {
  const type = category === "movie" ? "movie" : "tv";
  try {
    const res = await fetch(`https://api.themoviedb.org/3/${type}/${id}?language=es-MX&api_key=${TMDB_KEY}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== PASO PREVIO (seguro, ORM puro) ===\n");

  // ── 1. Descripciones en inglés → vaciar para que el motor real las rellene ──
  const candidates = await prisma.show.findMany({
    where: {
      description: { not: "" },
      OR: EN_STARTS.map((p) => ({ description: { startsWith: p } })),
    },
    select: { id: true, description: true },
  });
  const english = candidates.filter((s) => looksEnglish(s.description));
  console.log(`Descripciones EN detectadas: ${english.length}`);
  let cleared = 0;
  for (let i = 0; i < english.length; i += POOL) {
    const chunk = english.slice(i, i + POOL);
    await Promise.all(
      chunk.map((s) =>
        prisma.show.update({ where: { id: s.id }, data: { description: "" } }).then(() => cleared++).catch(() => {})
      )
    );
    process.stdout.write(`  vaciadas ${cleared}/${english.length}\r`);
    await sleep(50);
  }
  console.log(`\n  Vaciadas: ${cleared} (el motor las rellena en es-MX)\n`);

  // ── 2. Pósters de obras con tmdb_id → directo desde TMDB ──
  const shows = await prisma.show.findMany({
    where: {
      tmdb_id: { not: null },
      OR: [
        { poster_url: null },
        { poster_url: "" },
        { poster_url: { not: { contains: "image.tmdb.org" } } },
      ],
    },
    select: { id: true, tmdb_id: true, category: true },
  });
  console.log(`Pósters a reparar (con tmdb_id): ${shows.length}`);

  let fixed = 0;
  let noImage = 0;
  let failed = 0;
  for (let i = 0; i < shows.length; i += POOL) {
    const chunk = shows.slice(i, i + POOL);
    await Promise.all(
      chunk.map(async (s) => {
        const d = await tmdbDetails(s.tmdb_id!, s.category);
        if (!d) {
          failed++;
          return;
        }
        const data: Record<string, unknown> = {};
        if (d.poster_path) {
          data.poster_url = `https://image.tmdb.org/t/p/w780${d.poster_path}`;
          data.poster_path = d.poster_path;
        }
        if (d.backdrop_path) {
          data.banner_url = `https://image.tmdb.org/t/p/w1280${d.backdrop_path}`;
          data.backdrop_path = d.backdrop_path;
        }
        // Sinopsis es-MX si la actual está vacía (bonus, mismo criterio del motor)
        const cur = await prisma.show.findUnique({ where: { id: s.id }, select: { description: true } });
        if (cur && !cur.description && typeof d.overview === "string" && d.overview.trim().length > 40) {
          data.description = d.overview.trim();
        }
        if (Object.keys(data).length > 0) {
          await prisma.show.update({ where: { id: s.id }, data });
          fixed++;
        } else {
          noImage++;
        }
      })
    );
    process.stdout.write(`  ${i + chunk.length}/${shows.length} (ok:${fixed} sinImg:${noImage} fail:${failed})\r`);
    await sleep(DELAY_MS);
  }
  console.log(`\n  Reparados: ${fixed} | TMDB sin imagen: ${noImage} | fallos API: ${failed}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
