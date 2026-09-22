const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const DRY_RUN = !process.argv.includes("--apply");

// Strip season markers from title to get base series name
function stripSeasonMarkers(title) {
  let t = title
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/gi, "")
    .replace(/\bSeason\s*-?\s*\d{1,2}\b/gi, "")
    .replace(/\bTemporada\s*-?\s*\d{1,2}\b/gi, "")
    .replace(/\bs(\d{1,2})\b/gi, "")
    .replace(/\bPart\s*-?\s*(\d{1,2})\b/gi, "")
    .replace(/\bPart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/gi, "")
    .replace(/\bFinal\s+Season\b/gi, "")
    .replace(/\s*\((?:ONA|OVA|TV)\)\s*/gi, " ")
    .replace(/\s+the\s+Movie\s*\d*\s*:?.*$/gi, "")
    .replace(/\s+the\s+Movie\b/gi, "")
    .replace(/\s+Anime\s*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function normalizeKey(title) {
  return stripSeasonMarkers(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

function tokenize(text) {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/[^a-z0-9 ]/g, " ");
  const words = norm.split(/\s+/).filter(t => t.length > 1);
  return new Set(words.map(w => w.replace(/s$/, "")));
}

function jaccard(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function detectSeason(title) {
  let m = title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i);
  if (m) return Number(m[1]);
  m = title.match(/\bSeason\s*-?\s*(\d{1,2})\b/i);
  if (m) return Number(m[1]);
  m = title.match(/\bTemporada\s*-?\s*(\d{1,2})\b/i);
  if (m) return Number(m[1]);
  m = title.match(/\bs(\d{1,2})\b/i);
  if (m) return Number(m[1]);
  m = title.match(/\bPart\s*-?\s*(\d{1,2})\b/i);
  if (m) return Number(m[1]);
  return 0;
}

function isMovie(title) {
  return /\bthe\s+movie\b/i.test(title) || /\bpel[i\u00f3]cula\b/i.test(title);
}

function isSpinoff(title) {
  return /\bVigilante/i.test(title) || /\bIllegals\b/i.test(title);
}

async function main() {
  console.log("=== CONSOLIDACI\u00d3N DE TEMPORADAS ===");
  console.log(`Modo: ${DRY_RUN ? "DRY RUN" : "APPLY"}\n`);

  const shows = await prisma.show.findMany({
    select: {
      id: true,
      title: true,
      tmdb_id: true,
      source: true,
      created_at: true,
      normalized_title: true,
    },
    orderBy: { created_at: "asc" },
  });

  console.log(`Total shows: ${shows.length}`);

  // ── GROUP 1: by tmdb_id ──
  const tmdbGroups = new Map();
  for (const show of shows) {
    if (show.tmdb_id) {
      const key = String(show.tmdb_id);
      if (!tmdbGroups.has(key)) tmdbGroups.set(key, []);
      tmdbGroups.get(key).push(show);
    }
  }

  const tmdbDups = [];
  for (const [tmdbId, group] of tmdbGroups) {
    if (group.length > 1) tmdbDups.push({ tmdbId, shows: group });
  }
  console.log(`Grupos tmdb_id duplicados: ${tmdbDups.length}`);

  // ── GROUP 2: by normalized base title (no tmdb_id) ──
  const noTmdb = shows.filter(s => !s.tmdb_id);
  const titleGroups = new Map();
  for (const show of noTmdb) {
    const key = normalizeKey(show.title);
    if (!key || key.length < 3) continue;
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key).push(show);
  }

  const titleDups = [];
  for (const [key, group] of titleGroups) {
    if (group.length > 1) titleDups.push({ baseKey: key, shows: group });
  }
  console.log(`Grupos t\u00edtulo base duplicados: ${titleDups.length}`);

  // ── MERGE ──
  let totalMerges = 0;
  let totalEpsMoved = 0;
  let totalDeleted = 0;
  const details = [];

  async function mergeGroup(group, reason) {
    const canonical = group[0];
    const toMerge = group.slice(1);

    for (const sequel of toMerge) {
      // Skip spinoffs
      if (isSpinoff(sequel.title) !== isSpinoff(canonical.title)) {
        details.push({ c: canonical.title, m: sequel.title, r: "spin-off diferente" });
        continue;
      }

      // Skip if BOTH are movies — these are separate entries, not seasons
      if (isMovie(canonical.title) && isMovie(sequel.title)) {
        details.push({ c: canonical.title, m: sequel.title, r: "ambas películas" });
        continue;
      }

      // Similarity guard — ALWAYS apply, including for tmdb_id groups
      const sim = jaccard(canonical.title, sequel.title);
      const hasMarker = detectSeason(sequel.title) > 0 || isMovie(sequel.title);
      const minSim = hasMarker ? 0.15 : 0.35;
      if (sim < minSim) {
        details.push({ c: canonical.title, m: sequel.title, r: `sim ${sim.toFixed(2)} < ${minSim}` });
        continue;
      }

      const canonicalEpCount = await prisma.episode.count({ where: { show_id: canonical.id } });
      const sequelEpCount = await prisma.episode.count({ where: { show_id: sequel.id } });

      if (sequelEpCount === 0 && !isMovie(sequel.title)) {
        if (!DRY_RUN) {
          await prisma.show.delete({ where: { id: sequel.id } });
        }
        totalDeleted++;
        details.push({ c: canonical.title, m: sequel.title, r: "vac\u00edo, borrado" });
        continue;
      }

      const lastEp = await prisma.episode.findFirst({
        where: { show_id: canonical.id },
        orderBy: { episode_number: "desc" },
        take: 1,
      });
      let nextNum = (lastEp?.episode_number ?? 0) + 1;

      const sequelEps = await prisma.episode.findMany({
        where: { show_id: sequel.id },
        orderBy: { episode_number: "asc" },
      });

      let moved = 0;
      for (const ep of sequelEps) {
        if (!DRY_RUN) {
          const dupe = ep.source_url
            ? await prisma.episode.findFirst({ where: { show_id: canonical.id, source_url: ep.source_url } })
            : null;
          if (!dupe) {
            await prisma.episode.create({
              data: { show_id: canonical.id, episode_number: nextNum, title: ep.title, source_url: ep.source_url },
            });
          }
        }
        nextNum++;
        moved++;
      }

      if (!canonical.tmdb_id && sequel.tmdb_id && !DRY_RUN) {
        await prisma.show.update({ where: { id: canonical.id }, data: { tmdb_id: sequel.tmdb_id } });
      }

      if (!DRY_RUN) {
        await prisma.show.delete({ where: { id: sequel.id } });
      }

      totalMerges++;
      totalEpsMoved += moved;
      totalDeleted++;
      details.push({
        c: canonical.title,
        m: sequel.title,
        season: detectSeason(sequel.title) || "?",
        eps: moved,
        r: reason,
      });
    }
  }

  for (const { tmdbId, shows: g } of tmdbDups) {
    await mergeGroup(g, `tmdb:${tmdbId}`);
  }
  for (const { baseKey, shows: g } of titleDups) {
    await mergeGroup(g, `title:${baseKey}`);
  }

  console.log(`\n=== RESULTADO ===`);
  console.log(`Fusiones: ${totalMerges}`);
  console.log(`Episodios movidos: ${totalEpsMoved}`);
  console.log(`Shows borrados: ${totalDeleted}`);

  console.log(`\n=== DETALLES ===`);
  for (const d of details) {
    if (d.eps !== undefined) {
      console.log(`  "${d.m}" -> "${d.c}" (T${d.season}, ${d.eps} eps) [${d.r}]`);
    } else {
      console.log(`  "${d.m}" -> "${d.c}" [${d.r}]`);
    }
  }

  const remaining = await prisma.show.count();
  console.log(`\nShows restantes: ${remaining}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
